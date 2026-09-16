#!/usr/bin/env node
// Renders the QA report as a PR comment and routes the state machine on next_action.
import { readFileSync } from 'node:fs';
import { gh, setOutput, die } from './lib/actions.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

const pr = process.env.PR;
const issue = process.env.ISSUE;
const runUrl = process.env.RUN_URL ?? '';
const r = JSON.parse(readFileSync('qa-report.json', 'utf8'));

const icon = { pass: '🟢', fail: '🔴', blocked: '🟡', skipped: '⚪' };
const sev = { critical: '🔥', major: '🔴', minor: '🟠', trivial: '⚪' };

const counts = (r.tests ?? []).reduce((a, t) => ({ ...a, [t.status]: (a[t.status] ?? 0) + 1 }), {});
const blocking = (r.bugs ?? []).filter((b) => b.introduced_by_pr !== false);

const lines = [
  '## QA — ' + (r.verdict === 'pass' ? '🟢 pass' : r.verdict === 'fail' ? '🔴 fail' : '🟡 blocked') +
    '  _(attempt ' + r.attempt + ')_',
  '',
  '`' + (r.env?.url ?? 'unknown env') + '`',
  '',
  '**' + (r.tests ?? []).length + ' cases** — ' +
    Object.entries(counts).map(([k, v]) => v + ' ' + k).join(', ') +
    ' · **' + (r.bugs ?? []).length + ' bug' + ((r.bugs ?? []).length === 1 ? '' : 's') + '**',
  '',
  '### Acceptance criteria',
  ...(r.acceptance_rollup ?? []).map((a) =>
    '- ' + (icon[a.status] ?? '⚪') + ' **' + a.id + '** — ' + a.status +
    (a.test_ids?.length ? ' _(' + a.test_ids.join(', ') + ')_' : '')),
];

if (r.bugs?.length) {
  lines.push('', '### Bugs');
  for (const b of r.bugs) {
    lines.push(
      '',
      '#### ' + (sev[b.severity] ?? '') + ' ' + b.id + ' — ' + b.title +
        (b.introduced_by_pr === false ? '  _(pre-existing, does not block)_' : ''),
      '',
      '- **Expected:** ' + b.expected,
      '- **Actual:** ' + b.actual,
      ...(b.suspected_cause ? ['- **Suspected cause:** ' + b.suspected_cause] : []),
      ...(b.reproducible ? ['- **Reproducible:** ' + b.reproducible] : []),
      '',
      '<details><summary>Steps to reproduce</summary>',
      '',
      ...b.repro.map((s, i) => (i + 1) + '. ' + s),
      '',
      '</details>',
    );
  }
}

// Failures first — nobody scrolls past twenty passing rows to find the one that broke.
const failed = (r.tests ?? []).filter((t) => t.status !== 'pass');
if (failed.length) {
  lines.push('', '### Cases that did not pass', '', '| | Case | Type | Result |', '|---|---|---|---|');
  for (const t of failed) {
    lines.push('| ' + (icon[t.status] ?? '') + ' | ' + t.title + ' | ' + t.type + ' | ' +
      (t.actual ?? t.blocked_reason ?? t.status) + ' |');
  }
}

lines.push('', '<details><summary>Full test matrix (' + (r.tests ?? []).length + ')</summary>', '',
  '| | ID | Case | Type | Pri | Source |', '|---|---|---|---|---|---|');
for (const t of r.tests ?? []) {
  lines.push('| ' + (icon[t.status] ?? '') + ' | ' + t.id + ' | ' + t.title + ' | ' + t.type +
    ' | ' + t.priority + ' | ' + t.source + ' |');
}
lines.push('', '</details>');

if (r.coverage_gaps?.length) {
  lines.push('', '### Not covered', ...r.coverage_gaps.map((g) => '- **' + g.area + '** — ' + g.reason));
}
if (r.console_errors?.length) {
  lines.push('', '<details><summary>Console errors (' + r.console_errors.length + ')</summary>', '',
    '```', ...r.console_errors.slice(0, 20), '```', '</details>');
}
if (r.fixtures?.length) {
  const leaked = r.fixtures.filter((f) => f.cleaned_up === false);
  if (leaked.length) lines.push('', '⚠️ **Fixtures not cleaned up:** ' + leaked.map((f) => f.ref).join(', '));
}
lines.push('', '---', '[Evidence, traces and video](' + runUrl + ')',
  '', '```json', JSON.stringify({ next_action: r.next_action, verdict: r.verdict, hint: r.hint }, null, 2), '```');

await gh(['pr', 'comment', pr, '--body', lines.join('\n')]);

// Route on next_action alone — no natural-language parsing in the control flow.
const ctl = (args) => exec('node', ['.sdlc/bin/sdlc-ctl.mjs', ...args]);
const route = {
  merge:    ['transition', '--issue', issue, '--to', 'qa-pass',     '--agent', 'qa'],
  revise:   ['transition', '--issue', issue, '--to', 'qa-fail',     '--agent', 'qa'],
  escalate: ['transition', '--issue', issue, '--to', 'needs-human', '--agent', 'qa'],
}[r.next_action];
if (!route) die('unknown next_action "' + r.next_action + '"');
await ctl(route);

const label = { merge: 'sdlc:qa-pass', revise: 'sdlc:qa-fail', escalate: 'sdlc:needs-human' }[r.next_action];
await gh(['issue', 'edit', issue, '--add-label', label]);

// A QA failure re-enters implementation with a revised work order. Dispatched explicitly,
// because the label change alone will not start it.
if (r.next_action === 'revise') {
  await gh(['workflow', 'run', 'sdlc-implement.yml', '-f', `issue=${issue}`]);
}
setOutput('next_action', r.next_action);
setOutput('bugs', String((r.bugs ?? []).length));
