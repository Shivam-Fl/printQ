#!/usr/bin/env node
// Posts the validated work order to the issue and routes according to the approval gate.
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gh, setOutput, loadConfig } from './lib/actions.js';
import { advance } from './lib/advance.js';

const exec = promisify(execFile);

const issue = process.env.ISSUE;
const cfg = await loadConfig();
const wo = JSON.parse(readFileSync('work-order.json', 'utf8'));

const list = (items, f) => (items ?? []).map(f).join('\n') || '_none_';

const body = [
  '## Work order v' + wo.version,
  '',
  '**Understanding.** ' + wo.understanding,
  wo.root_cause ? '\n**Root cause.** ' + wo.root_cause : '',
  '\n**Approach.** ' + wo.approach,
  '\n### Files',
  list(wo.files, (f) => '- `' + f.path + '` (' + f.action + ') — ' + f.change),
  '\n### Tests',
  list(wo.tests, (t) => '- `' + t.path + '` — ' + (t.cases ?? []).join('; ')),
  '\n### Acceptance criteria',
  list(wo.acceptance, (a) => '- **' + a.id + '** ' + a.check),
  wo.risks?.length ? '\n### Risks\n' + list(wo.risks, (r) => '- ' + r) : '',
  wo.out_of_scope?.length ? '\n### Deliberately out of scope\n' + list(wo.out_of_scope, (r) => '- ' + r) : '',
  '',
  '```json',
  JSON.stringify(wo, null, 2),
  '```',
].filter(Boolean).join('\n');

await gh(['issue', 'comment', issue, '--body', body]);

// Record which files this plan expects to touch. Used only to flag overlap with other work
// in flight — never to block it. A plan's file list is a forecast, and forecasts should
// inform a reviewer rather than gate a pipeline.
const paths = [...(wo.files ?? []), ...(wo.tests ?? [])].map((f) => f.path).filter(Boolean);
if (paths.length) {
  await exec('node', ['.sdlc/bin/sdlc-ctl.mjs', 'link', '--issue', String(issue), '--paths', paths.join(',')])
    .catch(() => {});   // advisory data; never fail a plan over it
}

if (cfg.gates?.plan_approval) {
  await gh(['issue', 'edit', issue, '--remove-label', 'sdlc:planning', '--add-label', 'sdlc:plan-review']);
  await gh(['issue', 'comment', issue, '--body',
    'Waiting for approval before any code is written. Comment `/sdlc approve` to proceed, or `/sdlc reject` with what to change.']);
  setOutput('gated', 'true');
} else {
  // Ledger AND labels. This line used to move only the labels, so the ledger stayed at
  // `planning` for the entire life of the issue and every transition after it was illegal.
  // sdlc:plan-review goes too: left over from a run when the human gate was still on, it
  // says "waiting for you" on an issue that is waiting for nobody.
  await advance(issue, 'implementing', { agent: 'planner', alsoRemove: ['sdlc:plan-review'] });
  // Explicit dispatch: the label will not start anything on its own (GITHUB_TOKEN events
  // do not trigger workflows).
  // A 404 here on a fresh install means the workflow is not on the default branch yet.
await exec('node', ['.sdlc/bin/dispatch.mjs', 'sdlc-implement.yml', '-f', `issue=${issue}`]).catch(() => {});
  setOutput('gated', 'false');
}
