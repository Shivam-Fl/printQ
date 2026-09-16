#!/usr/bin/env node
// Acts on the plan reviewer's verdict.
import { readFileSync, existsSync } from 'node:fs';
import { gh, setOutput, die } from './lib/actions.js';

const issue = process.env.ISSUE;
if (!existsSync('plan-review.json')) die('the plan reviewer produced no verdict');
const r = JSON.parse(readFileSync('plan-review.json', 'utf8'));

const blocking = (r.blocking ?? []).map((b, i) =>
  `${i + 1}. **${b.claim}**\n   - evidence: ${b.evidence ?? '_none given_'}\n   - required: ${b.required_change}`).join('\n');

if (r.verdict === 'approve') {
  await gh(['issue', 'comment', issue, '--body',
    '## Plan review: approved\n\nThe plan reviewer verified the diagnosis and the caller analysis. ' +
    'Proceeding to implementation.' +
    (r.notes?.length ? `\n\nNon-blocking notes:\n${r.notes.map((n) => `- ${n}`).join('\n')}` : '')]);
  setOutput('verdict', 'approve');
} else if (r.verdict === 'reject') {
  await gh(['issue', 'comment', issue, '--body',
    `## Plan review: rejected\n\n${blocking}\n\nReplanning with these as the brief.`]);
  await gh(['issue', 'edit', issue, '--add-label', 'sdlc:planning']);
  setOutput('verdict', 'reject');
  process.exit(1);   // stops the workflow before the plan is posted as final
} else {
  await gh(['issue', 'comment', issue, '--body',
    `## Plan review: escalated to a human\n\n${blocking || '_the reviewer could not judge this_'}\n\n` +
    'Escalation is this agent working, not failing — it is cheaper than an implementation ' +
    'built on a plan nobody could verify.']);
  await gh(['issue', 'edit', issue, '--add-label', 'sdlc:needs-human']);
  setOutput('verdict', 'escalate');
  process.exit(1);
}
