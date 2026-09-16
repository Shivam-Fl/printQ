#!/usr/bin/env node
// Installs the framework into another repository.
//
//   node .sdlc/bin/install.mjs --target ../some-repo [--force]
//
// Copies the pipeline, scans the target to work out how it builds and tests, and writes a
// config plus seed memory. Everything it infers is labelled as inferred: an install that
// guesses silently produces CI that passes because it runs nothing, which is worse than an
// install that refuses to finish.

import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { detect, forbiddenFor } from './lib/detect.js';

const exec = promisify(execFile);
const SRC = join(dirname(new URL(import.meta.url).pathname), '..', '..');

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf('--' + n); return i === -1 ? null : (args[i + 1]?.startsWith('--') ? true : args[i + 1]); };
const FORCE = args.includes('--force');
const target = flag('target');

if (!target) { console.error('usage: install.mjs --target <path-to-repo> [--force]'); process.exit(1); }
if (!existsSync(join(target, '.git'))) { console.error(`${target} is not a git repository`); process.exit(1); }

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const ok = (s) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const skip = (s) => console.log(`  \x1b[33m·\x1b[0m ${s}`);
const note = (s) => console.log(`    ${s}`);

// --- 1. scan the target ------------------------------------------------------
console.log(`\n${bold('Scanning')} ${target}`);

const { stdout: tracked } = await exec('git', ['-C', target, 'ls-files'], { maxBuffer: 50 * 1024 * 1024 });
const files = tracked.split('\n').filter(Boolean);

let pkg = null;
if (existsSync(join(target, 'package.json'))) {
  try { pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')); } catch {}
}
const wfDir = join(target, '.github/workflows');
const workflows = existsSync(wfDir) ? readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f)) : [];

const found = detect({ files, pkg, workflows });
ok(`${files.length} tracked files · stack: ${found.stack}${found.framework ? ` (${found.framework})` : ''}`);

// --- 2. copy the framework ---------------------------------------------------
console.log(`\n${bold('Installing')}`);

const COPY = [
  ['.github/workflows', /^(sdlc-.*|ci-verify)\.yml$/],
  ['.sdlc/agents', /\.md$/],
  ['.sdlc/schemas', /\.json$/],
  ['.sdlc/templates', /\.ya?ml$/],
  ['.sdlc/bin', null],
];

let copied = 0, skipped = 0;
for (const [dir, filter] of COPY) {
  const from = join(SRC, dir);
  if (!existsSync(from)) continue;
  for (const entry of walk(from)) {
    const rel = relative(from, entry);
    if (filter && !filter.test(rel.split('/').pop())) continue;
    const dest = join(target, dir, rel);
    if (existsSync(dest) && !FORCE) { skipped++; continue; }
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(entry, dest);
    copied++;
  }
}
cpSync(join(SRC, 'bin/sdlc'), join(target, 'bin/sdlc'), { force: true });
ok(`${copied} files copied${skipped ? `, ${skipped} left alone (use --force to overwrite)` : ''}`);

// --- 3. config ---------------------------------------------------------------
const cfgPath = join(target, '.sdlc/config.yml');
if (existsSync(cfgPath) && !FORCE) {
  skip('.sdlc/config.yml exists — not overwritten');
} else {
  mkdirSync(dirname(cfgPath), { recursive: true });
  writeFileSync(cfgPath, renderConfig(found, forbiddenFor({ files })));
  ok('.sdlc/config.yml written from the scan');
}

// --- 4. seed memory ----------------------------------------------------------
const memDir = join(target, '.sdlc/memory');
if (existsSync(join(memDir, 'project.md')) && !FORCE) {
  skip('.sdlc/memory/project.md exists — not overwritten');
} else {
  mkdirSync(join(memDir, 'qa'), { recursive: true });
  mkdirSync(join(memDir, 'patterns'), { recursive: true });
  mkdirSync(join(memDir, 'decisions'), { recursive: true });
  writeFileSync(join(memDir, 'project.md'), renderProjectMemory(found, files, target));
  writeFileSync(join(memDir, 'index.md'), renderIndex());
  for (const f of ['conventions.md', 'qa/environment.md', 'qa/selectors.md']) {
    const src = join(SRC, '.sdlc/memory', f);
    const dst = join(memDir, f);
    if (existsSync(src) && (!existsSync(dst) || FORCE)) cpSync(src, dst);
  }
  ok('.sdlc/memory seeded from the scan');
}

// --- 5. what the human has to do --------------------------------------------
console.log(`\n${bold('What was inferred, and what you must check')}`);
for (const [k, v] of Object.entries(found.verify)) {
  const conf = found.confidence[k];
  if (!v) skip(`verify.${k}: empty (${conf ?? 'none found'}) — that check will be skipped`);
  else if (conf === 'guessed') skip(`verify.${k}: ${v}  ← GUESSED, verify it runs`);
  else ok(`verify.${k}: ${v}`);
}
console.log();
for (const n of found.notes) note(`- ${n}`);

console.log(`\n${bold('Next')}`);
console.log('  1. read .sdlc/config.yml — especially env.* and allowlist (it lists only a placeholder)');
console.log('  2. cd ' + target + ' && node bin/sdlc init');
console.log('  3. claude setup-token  →  gh secret set CLAUDE_CODE_OAUTH_TOKEN');
console.log('  4. node bin/sdlc doctor');
console.log('  5. open an issue and watch it, with gates.plan_approval left ON\n');

// --- helpers -----------------------------------------------------------------
function* walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

function renderConfig(d, forbidden) {
  const q = (s) => (s ? `"${s.replace(/"/g, '\\"')}"` : '""');
  const envLines = d.env.mode === 'none'
    ? `  # No runnable surface detected, so browser QA is off. CI, review and the unit suite\n  # still gate every PR. Set this to preview or compose if the repo does ship an app.\n  mode: none`
    : d.env.mode === 'preview'
    ? `  mode: preview\n  url_allowlist:\n${d.env.url_allowlist.map((h) => `    - "${h}"`).join('\n')}\n  ready: ${q(d.env.ready)}`
    : `  mode: compose\n  base_url: ${q(d.env.base_url)}\n  url_allowlist:\n${d.env.url_allowlist.map((h) => `    - "${h}"`).join('\n')}\n  boot: ${q(d.env.boot)}\n  ready: ${q(d.env.ready)}`;

  return `# Written by \`sdlc install\` from a scan of this repo. Every value below is a starting
# point, not a fact — read it before you trust the pipeline with anything.
#
# Detected stack: ${d.stack}${d.framework ? ` (${d.framework})` : ''}
${d.notes.map((n) => `#   - ${n}`).join('\n')}

runtime:
  # Model per STEP. Empty = the action's default. Council members inherit their stage.
  # Spend where a mistake is hardest to recover from: the diagnosis every later stage
  # inherits, and the last read before code is trusted.
  model:
    plan:               claude-opus-5
    plan_proposer:      ""
    plan_critic:        ""
    plan_arbiter:       claude-opus-5
    plan_reviewer:      claude-opus-5
    debug:              claude-opus-5
    implement:          ""
    review:             claude-opus-5
    review_correctness: ""
    review_design:      ""
    qa:                 ""
    root_cause:         ""
    librarian:          ""
    release:            ""

  max_turns:
    plan: 40
    plan_proposer: 40
    plan_critic: 40
    plan_arbiter: 40
    plan_reviewer: 30
    debug: 60
    implement: 60
    review: 40
    review_correctness: 40
    review_design: 40
    qa: 120
    root_cause: 40
    librarian: 50
    release: 25

# single = one agent. council = several in sequence, each reading the last one's output.
# A council costs roughly 3x the turns. Start single; switch the stage that actually
# produces bad output.
councils:
  plan:   single           # single | council
  review: single           # single | council

# Bugs go to the debugger, which reproduces in a live browser before diagnosing.
route_bugs_to_debugger: true

# The environment QA drives. url_allowlist is the guard that stops an agent clicking
# through production — QA refuses to open a browser against anything not matching it.
env:
${envLines}

# How QA logs in.
# none    = the app has no login, or QA only tests unauthenticated flows
# secrets = accounts provisioned by hand (SSO, admin). Values come from GitHub Secrets;
#           only their NAMES appear here.
# derived = QA signs itself up, every password an HMAC of one QA_FIXTURE_SEED secret.
#
# Derived rather than "sign up and save the credentials" because there is nowhere safe to
# save them: memory/ and the ledger are both git. Deriving stores nothing, yields the same
# password for the same identity so accounts are reusable, and rotating the seed rotates all.
qa_auth:
  mode: none               # none | secrets | derived
  secrets: [QA_USER_EMAIL, QA_USER_PASSWORD]
  scope: pr                # run | pr | global
  roles: [primary]         # add a second for permission tests
  email_domain: qa.invalid # RFC 2606 reserved — can never reach a real person
  signup_url: "/signup"    # CHECK THIS against the app before the first QA run

# own      = run the checks below (a repo with no CI of its own)
# existing = skip them; this repo's CI already gates the PR, and the pipeline waits for those
#            checks instead of running a weaker duplicate beside them
# both     = run ours alongside theirs
verify:
  mode: ${d.verifyMode ?? 'own'}

  # Which checks must pass before an agent may look at the PR. Empty = every check on the PR
  # except the pipeline's own. Name them explicitly on a repo with optional or slow jobs.
  required_checks: []
  wait_minutes: 30

  # Runs before every other check. Monorepos usually need codegen or a shared package built
  # first, or typecheck fails for reasons unrelated to the PR.
  prepare:   ${q(d.verify.prepare ?? '')}
  typecheck: ${q(d.verify.typecheck)}
  lint:      ${q(d.verify.lint)}
  unit:      ${q(d.verify.unit)}
  build:     ${q(d.verify.build)}
  e2e:       ${q(d.verify.e2e)}

gates:
  plan_approval:     true   # a HUMAN approves the work order before any code is written
  plan_review_agent: true   # when plan_approval is off, an agent reviews instead of nobody
  min_confidence:    70     # a plan below this reaches a human regardless of the gates above
  merge_approval:    true
  qa_files_issues:   true   # QA opens issues for bugs outside this PR's scope

limits:
  attempts: 3
  minutes:  120
  lock_ttl_minutes: 45

# No agent may touch these without a human. Derived from what this repo actually contains.
forbidden_paths:
${forbidden.map((p) => `  - "${p}"`).join('\n')}

# Only these users may issue /sdlc commands. Everyone else's comments are data, never
# instructions. REPLACE THIS — an install cannot know who owns the repo.
allowlist:
  - "REPLACE_ME"

release:
  auto_merge: false
  auto_tag:   false
  changelog:  "CHANGELOG.md"
`;
}

function renderProjectMemory(d, files, target) {
  const top = [...new Set(files.map((f) => f.split('/')[0]).filter((s) => !s.includes('.')))]
    .slice(0, 15);
  return `# Project

Seeded by \`sdlc install\` from a scan. **Correct it** — an agent reads this before planning,
and a wrong entry here steers every ticket wrong.

## Stack
${d.stack}${d.framework ? ` (${d.framework})` : ''} · ${files.length} tracked files

## Top-level layout
${top.map((t) => `- \`${t}/\``).join('\n') || '_flat repository_'}

## Commands
${Object.entries(d.verify).filter(([, v]) => v).map(([k, v]) => `- ${k}: \`${v}\``).join('\n') || '_none detected — fill these in_'}

## Non-obvious
_Empty. This is the most valuable section and a scan cannot write it._

Add what a newcomer gets wrong: which module owns what, the abstraction that looks
redundant but is not, the test that is slow for a reason, the service that must be running
locally. The Librarian appends here as the system learns, but it starts from what you write.
`;
}

function renderIndex() {
  return `# Memory index

One line per entry, describing **when it applies** — an agent reads this before deciding
whether to open the entry itself.

## Always
- [project.md](project.md) — stack, layout, commands. Read before any planning.
- [conventions.md](conventions.md) — naming, errors, tests, PR style. Read before writing code.

## Situational
- [qa/environment.md](qa/environment.md) — env quirks and login recipes. Read before browser QA.
- [qa/selectors.md](qa/selectors.md) — selectors known to be stable.
- [patterns/](patterns/) — bug shapes this repo has produced before. Grep by symptom.
- [decisions/](decisions/) — why things are as they are. Read before proposing a rewrite.
`;
}
