#!/usr/bin/env node
// Waits for the checks that gate a PR, whoever runs them.
//
// A repo that already has CI does not need ours. Duplicating it burns runner minutes and,
// worse, drifts from it — the pipeline ends up gating on a weaker set of checks than the
// team actually trusts. So the framework waits for whatever already gates the PR.
//
// This exists as a script rather than a `workflow_run` trigger because that trigger's
// `workflows:` list is static YAML and cannot be driven from config.

import { ghJson, setOutput, loadConfig, die } from './lib/actions.js';

const pr = process.env.PR ?? die('PR not set');
const cfg = await loadConfig();
const required = cfg.verify?.required_checks ?? [];
const timeoutMin = Number(cfg.verify?.wait_minutes ?? 30);
const deadline = Date.now() + timeoutMin * 60_000;

// Our own gate must not wait for itself.
const SELF = /^(sdlc-|gate\b)/;

const wanted = (c) => (required.length ? required.includes(c.name) : !SELF.test(c.name));

let last = '';
while (Date.now() < deadline) {
  const { statusCheckRollup = [] } = await ghJson([
    'pr', 'view', pr, '--json', 'statusCheckRollup',
  ]);

  const checks = statusCheckRollup.filter(wanted);

  if (!checks.length) {
    // No CI at all is a legitimate configuration, not a failure — but say so, because
    // silently proceeding looks identical to "everything passed".
    process.stdout.write('no gating checks found on this PR — proceeding with nothing verified\n');
    setOutput('conclusion', 'none');
    setOutput('passed', 'true');
    process.exit(0);
  }

  const done = (c) => c.status === 'COMPLETED' || c.state !== undefined;
  const failed = checks.filter((c) => ['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ERROR', 'FAILURE'].includes(c.conclusion ?? c.state));
  const pending = checks.filter((c) => !done(c) || c.conclusion === null);

  const summary = checks.map((c) => `${c.name}:${c.conclusion ?? c.status ?? c.state}`).join(' ');
  if (summary !== last) { process.stdout.write(summary + '\n'); last = summary; }

  if (failed.length) {
    process.stdout.write(`failing: ${failed.map((c) => c.name).join(', ')}\n`);
    setOutput('conclusion', 'failure');
    setOutput('passed', 'false');
    setOutput('failed_checks', failed.map((c) => c.name).join(','));
    process.exit(0);          // not an error: a red PR is a normal outcome the loop handles
  }
  if (!pending.length) {
    process.stdout.write(`all ${checks.length} check(s) passed\n`);
    setOutput('conclusion', 'success');
    setOutput('passed', 'true');
    process.exit(0);
  }

  await new Promise((r) => setTimeout(r, 15_000));
}

die(`checks did not finish within ${timeoutMin} minutes — raise verify.wait_minutes if this repo's CI is slower`);
