#!/usr/bin/env node
// Posts the validated work order to the issue and routes according to the approval gate.
import { readFileSync } from 'node:fs';
import { gh, setOutput, loadConfig } from './lib/actions.js';

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

if (cfg.gates?.plan_approval) {
  await gh(['issue', 'edit', issue, '--remove-label', 'sdlc:planning', '--add-label', 'sdlc:plan-review']);
  await gh(['issue', 'comment', issue, '--body',
    'Waiting for approval before any code is written. Comment `/sdlc approve` to proceed, or `/sdlc reject` with what to change.']);
  setOutput('gated', 'true');
} else {
  await gh(['issue', 'edit', issue, '--remove-label', 'sdlc:planning', '--add-label', 'sdlc:implementing']);
  // Explicit dispatch: the label will not start anything on its own (GITHUB_TOKEN events
  // do not trigger workflows).
  await gh(['workflow', 'run', 'sdlc-implement.yml', '-f', `issue=${issue}`]);
  setOutput('gated', 'false');
}
