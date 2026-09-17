#!/usr/bin/env node
// Acts on what the review decided.
//
// The reviewer read the first real PR, found a test that passed with the code it tested
// deleted, and requested changes — correctly, with evidence. Nothing happened. The verdict
// existed only as an output no step consumed, so the PR sat waiting for QA that never ran
// while the implementer was never told anything was wrong.
//
// Reviewing without routing is just commenting. This is the step that makes a review mean
// something: approve hands the PR to QA, request-changes hands it back to the implementer.

import { gh, ghJson, setOutput, die } from './lib/actions.js';
import { advance } from './lib/advance.js';
import { reviewVerdict } from './lib/routing.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

const pr = process.env.PR || die('PR is required');
const dispatch = (wf, ...args) => exec('node', ['.sdlc/bin/dispatch.mjs', wf, ...args]);

const data = await ghJson(['pr', 'view', pr, '--json', 'reviews,body']);
const issue = (data.body ?? '').match(/(?:closes|fixes|resolves)\s+#(\d+)/i)?.[1];
if (!issue) {
  // Not ours: no work order, no ledger, nothing to route. Silence beats a confusing failure.
  process.stdout.write(`PR #${pr} closes no issue — reviewed, but there is nothing to route\n`);
  process.exit(0);
}

// `declared` is the council's merged verdict when the council ran. In single-reviewer mode it
// is empty and GitHub holds the answer instead.
const verdict = reviewVerdict({ declared: process.env.VERDICT || null, reviews: data.reviews ?? [] });
setOutput('verdict', verdict ?? '');
setOutput('issue', issue);

// Nothing was posted at all. Not an approval — an agent that finished without producing a
// review is a failure that happens to look quiet.
if (!verdict) {
  await gh(['pr', 'comment', pr, '--body',
    'The review stage finished without posting a review, so there is no verdict to act on. ' +
    'This says nothing about the code. Routing to a human rather than treating silence as approval.']);
  await advance(issue, 'needs-human', { agent: 'reviewer' });
  process.exit(0);
}

if (verdict === 'approve') {
  await advance(issue, 'qa', { agent: 'reviewer' });
  // Explicit, because QA used to trigger on this workflow completing — which cannot see the
  // verdict, and so QA'd PRs the reviewer had just rejected.
  await dispatch('sdlc-qa.yml', '-f', `pr=${pr}`);
  process.stdout.write(`issue #${issue}: approved -> qa\n`);
  process.exit(0);
}

// request-changes: back to the implementer, on the same branch, with the review to answer.
await advance(issue, 'implementing', { agent: 'reviewer' });
await gh(['pr', 'comment', pr, '--body',
  'Review requested changes, so this goes back to the implementer rather than on to QA. ' +
  'The existing branch is what was rejected — the next run reads the review above and ' +
  'addresses the blocking findings on the same branch, it does not start over.']);
// The label alone starts nothing: GitHub will not trigger a workflow from a GITHUB_TOKEN
// event. `rework` is what stops the next run deciding the branch is already finished work.
await dispatch('sdlc-implement.yml', '-f', `issue=${issue}`, '-f', 'rework=review');
process.stdout.write(`issue #${issue}: changes requested -> implementing\n`);
