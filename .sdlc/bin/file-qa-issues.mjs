#!/usr/bin/env node
// Opens issues for bugs QA found outside this PR's scope.
//
// On the first live run QA found a stored XSS and a double-submit race, correctly scoped both
// out of the PR that did not cause them, and wrote them into a report comment. Which is where
// they would have stayed. A critical finding recorded in prose nobody actions is a finding
// that was not made.
//
// Scoped out of a PR is not the same as unimportant: it means "not this PR's job", and the
// correct destination is its own ticket.

import { readFileSync } from 'node:fs';
import { gh, ghJson, loadConfig, setOutput, die } from './lib/actions.js';

const cfg = await loadConfig();
if (cfg.gates?.qa_files_issues === false) {
  process.stdout.write('gates.qa_files_issues is off — not filing\n');
  setOutput('filed', '0');
  process.exit(0);
}

const report = JSON.parse(readFileSync(process.env.REPORT ?? 'qa-report.json', 'utf8'));
const pr = process.env.PR;
const sourceIssue = process.env.ISSUE;

// Only pre-existing bugs. A bug this PR introduced belongs in the fix loop, not a new ticket —
// filing it separately lets the broken PR merge.
const outOfScope = (report.bugs ?? []).filter((b) => b.introduced_by_pr === false);
if (!outOfScope.length) {
  process.stdout.write('no out-of-scope bugs to file\n');
  setOutput('filed', '0');
  process.exit(0);
}

const existing = await ghJson(['issue', 'list', '--state', 'all', '--limit', '100', '--json', 'number,title']);
const SEV_LABEL = { critical: 'p0', major: 'p1', minor: 'p2', trivial: 'p3' };

let filed = 0;
const links = [];

for (const bug of outOfScope) {
  // Dedupe on title overlap. QA runs on every PR, and the same pre-existing bug will be
  // found again and again — a fresh duplicate each time trains people to ignore these.
  const words = new Set(bug.title.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  const dupe = existing.find((o) => {
    const other = new Set(o.title.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
    const shared = [...words].filter((w) => other.has(w)).length;
    return words.size > 2 && shared / words.size > 0.6;
  });
  if (dupe) {
    process.stdout.write(`skipping "${bug.title}" — looks like #${dupe.number}\n`);
    links.push(`#${dupe.number} (already open)`);
    continue;
  }

  const body = [
    `Found by the QA agent while testing PR #${pr} (for #${sourceIssue}).`,
    '',
    `**This is pre-existing** — PR #${pr} did not introduce it, which is why it was scoped out`,
    'of that review rather than blocking it.',
    '',
    '## Expected',
    bug.expected,
    '',
    '## Actual',
    bug.actual,
    '',
    '## Steps to reproduce',
    ...bug.repro.map((s, i) => `${i + 1}. ${s}`),
    '',
    ...(bug.suspected_cause ? ['## Suspected cause', bug.suspected_cause, ''] : []),
    ...(bug.reproducible ? [`**Reproducible:** ${bug.reproducible}`, ''] : []),
    ...(report.env?.url ? [`**Environment:** \`${report.env.url}\` @ \`${(report.env.commit ?? '').slice(0, 8)}\``, ''] : []),
    '---',
    `_Filed automatically. Severity **${bug.severity}** as judged by QA — reassess before planning._`,
  ].join('\n');

  const labels = ['bug', 'sdlc:triage'];
  if (SEV_LABEL[bug.severity]) labels.push(SEV_LABEL[bug.severity]);

  try {
    const url = await gh([
      'issue', 'create',
      '--title', bug.title,
      '--body', body,
      '--label', labels.join(','),
    ]);
    const num = url.trim().split('/').pop();
    links.push(`#${num}`);
    filed++;
    process.stdout.write(`filed #${num}: ${bug.title}\n`);
  } catch (e) {
    // A label that does not exist should not lose the bug report.
    const url = await gh(['issue', 'create', '--title', bug.title, '--body', body]);
    const num = url.trim().split('/').pop();
    links.push(`#${num}`);
    filed++;
    process.stdout.write(`filed #${num} without labels (${String(e.message).split('\n')[0]})\n`);
  }
}

if (links.length) {
  await gh(['pr', 'comment', pr, '--body',
    `QA found ${links.length} pre-existing issue(s) outside this PR's scope: ${links.join(', ')}\n\n` +
    'These do not block this PR — it did not cause them — but they are now tracked rather than ' +
    'noted in a report.']);
}
setOutput('filed', String(filed));
