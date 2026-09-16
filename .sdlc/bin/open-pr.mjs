#!/usr/bin/env node
// Opens the PR for an implemented work order.
//
// Deliberately NOT the agent's job. On the first live run the implementer made exactly the
// right change and pushed the branch, then simply did not open a PR — no error, nothing to
// debug, the pipeline just stopped with a correct fix sitting on a branch nobody looked at.
//
// Asking a model to perform a mechanical step means sometimes it won't, and you find out by
// noticing the absence of something. So the workflow does it: deterministic, and it fails
// loudly when it cannot.

import { gh, ghJson, setOutput, die } from './lib/actions.js';

const issue = process.env.ISSUE;
const branch = process.env.BRANCH ?? `sdlc/issue-${issue}`;
// Resolved, never guessed. Defaulting to "main" silently targets a branch that may not
// exist — printQ uses "master" — and the PR creation then fails for a reason that reads as
// a permissions problem rather than a wrong base.
const base = process.env.BASE_BRANCH
  || (await ghJson(['repo', 'view', '--json', 'defaultBranchRef'])).defaultBranchRef?.name
  || die('could not determine the default branch');

// Already open? This runs on every implement attempt, including retries after QA failures,
// and a second PR for the same branch is worse than none.
const existing = await ghJson(['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number']);
if (existing.length) {
  setOutput('pr', String(existing[0].number));
  setOutput('created', 'false');
  process.stdout.write(`PR #${existing[0].number} already open for ${branch}\n`);
  process.exit(0);
}

// Did the agent actually change anything? An empty branch means the implementer stopped —
// usually because the work order was wrong — and that deserves a clear message rather than
// an empty PR.
const cmp = await ghJson(['api', `repos/${process.env.GITHUB_REPOSITORY}/compare/${base}...${branch}`]);
if (!cmp.files?.length) {
  die(`branch ${branch} has no changes against ${base} — the implementer did not apply the work order`);
}

const issueData = await ghJson(['issue', 'view', issue, '--json', 'title,comments']);

// Pull the acceptance criteria out of the posted work order so review and QA can see what
// they are checking against without opening the issue.
let acceptance = [];
for (const c of (issueData.comments ?? []).slice().reverse()) {
  const m = c.body?.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!m) continue;
  try {
    const wo = JSON.parse(m[1]);
    if (wo.acceptance) { acceptance = wo.acceptance; break; }
  } catch { /* not a work order block */ }
}

const changed = cmp.files.map((f) => `- \`${f.filename}\` (+${f.additions} −${f.deletions})`).join('\n');
const criteria = acceptance.length
  ? acceptance.map((a) => `- [ ] **${a.id}** ${a.check}`).join('\n')
  : '_none recorded on the issue_';

const body = [
  `Closes #${issue}`,
  '',
  '## Changed',
  changed,
  '',
  '## Acceptance criteria',
  criteria,
  '',
  '---',
  '_Opened by the SDLC pipeline from the approved work order on the issue. ' +
  'CI runs next, then QA against a live browser._',
].join('\n');

const url = await gh([
  'pr', 'create',
  '--base', base,
  '--head', branch,
  '--title', `fix: ${issueData.title}`,
  '--body', body,
]);

const num = url.trim().split('/').pop();
setOutput('pr', num);
setOutput('created', 'true');
process.stdout.write(`opened PR #${num}: ${url.trim()}\n`);
