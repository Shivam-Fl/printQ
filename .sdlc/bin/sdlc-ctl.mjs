#!/usr/bin/env node
// The single entry point every workflow calls. One CLI beats ten composite actions:
// it is testable locally, it fails with a readable message, and the workflows stay thin.
//
//   node .sdlc/bin/sdlc-ctl.mjs <command> [--flag value]
//
// Every command that changes state goes through the ledger, so the kill switch, the budget
// caps and the lock are enforced in exactly one place rather than in each workflow.

import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

import { validate, formatErrors } from './lib/validate.js';
import { checkQaConsistency } from './lib/qa-consistency.js';
import { digest } from './lib/digest.js';
import { parseCommand } from './lib/commands.js';
import {
  newLedger, transition, acquireLock, releaseLock, isLockStale,
  bumpAttempt, checkBudget, pathsCollide, STAGES,
} from './lib/ledger.js';
import {
  ensureStateBranch, readLedger, updateLedger, listLedgers,
} from './lib/state-io.js';

const ROOT = process.env.SDLC_ROOT ?? process.cwd();

// --- argument parsing -------------------------------------------------------
function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith('--')) continue;
    const key = rest[i].slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) flags[key] = true;
    else { flags[key] = next; i++; }
  }
  return { command, flags };
}

function need(flags, name) {
  if (flags[name] === undefined) fail(`missing required flag --${name}`);
  return flags[name];
}

function fail(message) {
  process.stderr.write(`sdlc: ${message}\n`);
  process.exit(1);
}

// GitHub Actions step output, so a workflow can branch on the result.
function setOutput(key, value) {
  const v = typeof value === 'string' ? value : JSON.stringify(value);
  if (process.env.GITHUB_OUTPUT) {
    const delim = `EOF_${Math.random().toString(36).slice(2)}`;
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}<<${delim}\n${v}\n${delim}\n`);
  }
  process.stdout.write(`${key}=${v}\n`);
}

/**
 * js-yaml is imported LAZILY, on purpose.
 *
 * `guard` — the kill switch — is the first step of every workflow and runs BEFORE `npm ci`,
 * so that a disabled system skips the install entirely. A top-level import of any dependency
 * therefore breaks the one command that has to work when nothing else does. Keep this lazy.
 */
export async function loadConfig(root = ROOT) {
  const path = join(root, '.sdlc', 'config.yml');
  if (!existsSync(path)) fail(`no config at ${path} — run \`sdlc init\` first`);
  const { load: parseYaml } = await import('js-yaml');
  const cfg = parseYaml(readFileSync(path, 'utf8'));
  if (!cfg || typeof cfg !== 'object') fail('config.yml did not parse to an object');
  return cfg;
}

function loadSchema(name, root = ROOT) {
  const path = join(root, '.sdlc', 'schemas', `${name}.json`);
  if (!existsSync(path)) fail(`unknown schema "${name}"`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

const repoOf = (flags) => flags.repo ?? process.env.GITHUB_REPOSITORY ?? fail('no --repo and no GITHUB_REPOSITORY');

// --- commands ---------------------------------------------------------------
const commands = {
  /** Kill switch. First step of every workflow. Exits non-zero when the system is off. */
  async guard() {
    if (String(process.env.SDLC_ENABLED ?? 'true').toLowerCase() === 'false') {
      process.stdout.write('SDLC_ENABLED is false — halting.\n');
      process.exit(78); // neutral: halt without marking the run failed
    }
    process.stdout.write('enabled\n');
  },

  /** Validate an agent artifact against its schema before anything downstream trusts it. */
  async validate(flags) {
    const schema = loadSchema(need(flags, 'schema'));
    const file = need(flags, 'file');

    // A missing artifact is the most common agent failure, and a raw ENOENT stack says
    // nothing about what went wrong: the agent ran, reported success, and wrote the file
    // somewhere else. Say that, and show what it did write.
    if (!existsSync(file)) {
      const { readdirSync } = await import('node:fs');
      const near = [];
      for (const dir of ['.', 'plan', 'review', '.sdlc']) {
        try {
          for (const f of readdirSync(dir)) if (f.endsWith('.json')) near.push(dir === '.' ? f : `${dir}/${f}`);
        } catch { /* directory does not exist */ }
      }
      fail(
        `the agent did not write ${file}.\n` +
        'It reported success, so it ran — it just put the file somewhere else, or never wrote one.\n' +
        (near.length ? `JSON files that do exist: ${near.join(', ')}` : 'No JSON files were written at all.'),
      );
    }
    const data = JSON.parse(readFileSync(file, 'utf8'));

    const shape = validate(schema, data);
    if (!shape.ok) {
      process.stdout.write(`Schema validation failed:\n${formatErrors(shape.errors)}\n`);
      process.exit(1);
    }
    if (flags.schema === 'qa-report') {
      const honest = checkQaConsistency(data);
      if (!honest.ok) {
        process.stdout.write(`Report is internally inconsistent:\n${honest.errors.map((e) => `- ${e}`).join('\n')}\n`);
        process.exit(1);
      }
    }
    process.stdout.write('valid\n');
  },

  /** Compact a CI log down to the lines that explain the failure. */
  async digest(flags) {
    const log = flags.file ? readFileSync(flags.file, 'utf8') : readFileSync(0, 'utf8');
    const d = digest(log);
    setOutput('findings', String(d.findings.length));
    setOutput('summary', d.summary);
  },

  /** Parse a privileged /sdlc command out of a comment. Authority comes from the author. */
  async command(flags) {
    const cfg = await loadConfig();
    const parsed = parseCommand(
      { body: need(flags, 'body'), author: flags.author, association: flags.association },
      cfg,
    );
    if (!parsed) { setOutput('command', ''); return; }
    setOutput('command', parsed.authorized ? parsed.command : '');
    setOutput('args', parsed.args.join(' '));
    setOutput('authorized', String(parsed.authorized));
    setOutput('reason', parsed.reason ?? '');
    if (!parsed.authorized) process.stdout.write(`refused: ${parsed.reason}\n`);
  },

  /** Open the ledger for a new issue. Idempotent — a reopened issue keeps its history. */
  async init(flags) {
    const repo = repoOf(flags);
    const issue = Number(need(flags, 'issue'));
    await ensureStateBranch(repo);
    const { ledger } = await updateLedger(repo, issue, (existing) => existing ?? newLedger(issue));
    setOutput('state', ledger.state);
  },

  /** Move to a new state. Refuses illegal transitions rather than corrupting the machine. */
  async transition(flags) {
    const repo = repoOf(flags);
    const issue = Number(need(flags, 'issue'));
    const to = need(flags, 'to');
    const { ledger } = await updateLedger(repo, issue, (l) => {
      const base = l ?? newLedger(issue);
      const r = transition(base, to, { agent: flags.agent ?? 'system' });
      if (!r.ok) fail(r.reason);
      return r.ledger;
    });
    setOutput('state', ledger.state);
  },

  /** Take the per-issue lock. Exits non-zero when another agent holds it. */
  async lock(flags) {
    const repo = repoOf(flags);
    const issue = Number(need(flags, 'issue'));
    const agent = need(flags, 'agent');
    const cfg = await loadConfig();
    let refused = null;
    await updateLedger(repo, issue, (l) => {
      const base = l ?? newLedger(issue);
      const r = acquireLock(base, agent, { ttlMinutes: cfg.limits?.lock_ttl_minutes ?? 45 });
      if (!r.ok) { refused = r.reason; return null; }
      return r.ledger;
    });
    if (refused) { process.stdout.write(`lock refused: ${refused}\n`); process.exit(1); }
    setOutput('locked', 'true');
  },

  async unlock(flags) {
    const repo = repoOf(flags);
    const issue = Number(need(flags, 'issue'));
    await updateLedger(repo, issue, (l) => (l ? releaseLock(l, { agent: flags.agent ?? 'system' }) : null));
    setOutput('locked', 'false');
  },

  /**
   * Consume an attempt and check the budget. Called on DISPATCH, before the agent runs, so a
   * crash-looping agent still terminates. Exits non-zero when the cap is hit.
   */
  async attempt(flags) {
    const repo = repoOf(flags);
    const issue = Number(need(flags, 'issue'));
    const stage = need(flags, 'stage');
    const cfg = await loadConfig();
    let exceeded = null;

    const { ledger } = await updateLedger(repo, issue, (l) => {
      const base = l ?? newLedger(issue);
      const bumped = bumpAttempt(base, stage, { agent: flags.agent ?? stage });
      if (!bumped.ok) fail(bumped.reason);
      const budget = checkBudget(bumped.ledger, cfg.limits);
      if (!budget.ok) {
        exceeded = budget.reason;
        const stopped = transition(bumped.ledger, budget.terminal, { agent: 'watchdog' });
        return stopped.ok ? stopped.ledger : bumped.ledger;
      }
      return bumped.ledger;
    });

    setOutput('attempt', String(ledger.attempts?.[stage] ?? 0));
    if (exceeded) {
      setOutput('exceeded', 'true');
      process.stdout.write(`budget exceeded: ${exceeded}\n`);
      process.exit(1);
    }
    setOutput('exceeded', 'false');
  },

  /**
   * Clear the attempt counters so a budget-exceeded issue can proceed again.
   *
   * The budget deliberately counts DISPATCHES, not agent failures, so that a run failing
   * before the agent starts — a bad token, a missing secret — still terminates the loop
   * instead of retrying forever. The cost of that choice is that setup mistakes consume
   * budget too, so there has to be a way back. This is it: explicit, human-triggered, and
   * recorded in the history rather than silently zeroing state.
   */
  async reset(flags) {
    const repo = repoOf(flags);
    const issue = Number(need(flags, 'issue'));
    const to = flags.to ?? 'planning';

    const { ledger } = await updateLedger(repo, issue, (l) => {
      if (!l) fail(`issue #${issue} has no ledger`);
      let next = releaseLock(l, { agent: 'human' });
      next = {
        ...next,
        attempts: Object.fromEntries(STAGES.map((st) => [st, 0])),
        budget: { ...next.budget, minutes: 0 },
        history: [...next.history, {
          at: new Date().toISOString(), agent: 'human',
          action: `budget reset (was ${JSON.stringify(l.attempts)})`,
        }],
      };
      // budget-exceeded only routes to needs-human, which routes anywhere.
      if (next.state === 'budget-exceeded') {
        next = transition(next, 'needs-human', { agent: 'human' }).ledger;
      }
      const moved = transition(next, to, { agent: 'human' });
      if (!moved.ok) fail(moved.reason);
      return moved.ledger;
    });

    setOutput('state', ledger.state);
    process.stdout.write(`attempts cleared; issue #${issue} is now ${ledger.state}\n`);
  },

  /** Record the PR number and the paths this issue is touching, for collision detection. */
  async link(flags) {
    const repo = repoOf(flags);
    const issue = Number(need(flags, 'issue'));
    await updateLedger(repo, issue, (l) => {
      const base = l ?? newLedger(issue);
      return {
        ...base,
        pr: flags.pr ? Number(flags.pr) : base.pr,
        // Which work order version the branch answers, so a re-run can tell finished work
        // from work that a revised plan has made stale.
        implemented_version: flags['implemented-version']
          ? Number(flags['implemented-version'])
          : base.implemented_version,
        touch_paths: flags.paths ? String(flags.paths).split(',').map((s) => s.trim()).filter(Boolean) : base.touch_paths,
      };
    });
    setOutput('linked', 'true');
  },

  /** Would dispatching this issue collide with another issue already in flight? */
  async collisions(flags) {
    const repo = repoOf(flags);
    const issue = Number(need(flags, 'issue'));
    const { ledger } = await readLedger(repo, issue);
    if (!ledger?.touch_paths?.length) { setOutput('collides_with', ''); return; }

    const others = (await listLedgers(repo)).filter((n) => n !== issue);
    const hits = [];
    for (const other of others) {
      const { ledger: o } = await readLedger(repo, other);
      const active = o && !['done', 'needs-human', 'budget-exceeded', 'triage'].includes(o.state);
      if (active && pathsCollide(ledger.touch_paths, o.touch_paths ?? [])) hits.push(other);
    }
    setOutput('collides_with', hits.join(','));
  },

  /** Sweep every open ledger: reclaim stale locks, trip budgets, surface stalls. */
  async watchdog(flags) {
    const repo = repoOf(flags);
    const cfg = await loadConfig();
    const now = new Date();
    const report = { reclaimed: [], exceeded: [], stalled: [] };

    for (const issue of await listLedgers(repo)) {
      await updateLedger(repo, issue, (l) => {
        if (!l || ['done', 'needs-human', 'budget-exceeded'].includes(l.state)) return null;
        let next = l;
        let changed = false;

        if (isLockStale(next, now)) {
          report.reclaimed.push(issue);
          next = releaseLock(next, { agent: 'watchdog' });
          changed = true;
        }
        const budget = checkBudget(next, cfg.limits);
        if (!budget.ok) {
          report.exceeded.push({ issue, reason: budget.reason });
          const stopped = transition(next, budget.terminal, { agent: 'watchdog' });
          if (stopped.ok) { next = stopped.ledger; changed = true; }
        }
        const idleHours = (now - new Date(next.updated_at)) / 3_600_000;
        if (idleHours > (cfg.limits?.stall_hours ?? 6)) {
          report.stalled.push({ issue, hours: Math.round(idleHours) });
        }
        return changed ? next : null;
      });
    }
    setOutput('report', report);
  },

  async status(flags) {
    const repo = repoOf(flags);
    if (flags.issue) {
      const { ledger } = await readLedger(repo, Number(flags.issue));
      process.stdout.write(JSON.stringify(ledger, null, 2) + '\n');
      return;
    }
    for (const issue of await listLedgers(repo)) {
      const { ledger } = await readLedger(repo, issue);
      process.stdout.write(
        `#${issue}\t${ledger.state}\t${ledger.owner ?? '-'}\tqa:${ledger.attempts?.qa ?? 0}\n`,
      );
    }
  },
};

// --- entry ------------------------------------------------------------------
const { command, flags } = parseArgs(process.argv.slice(2));
if (!command || !commands[command]) {
  process.stderr.write(`usage: sdlc-ctl <${Object.keys(commands).join('|')}> [--flags]\n`);
  process.exit(1);
}
commands[command](flags).catch((e) => fail(e.stack ?? e.message));
