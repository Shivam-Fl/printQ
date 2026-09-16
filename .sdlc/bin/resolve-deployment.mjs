#!/usr/bin/env node
// Works out what QA should test, from whichever event triggered it.
//
// Three shapes reach this:
//   deployment_status  — preview mode. A real deployment finished and carries its own URL.
//   workflow_run       — compose mode. CI went green; there is no deployment, so QA boots
//                        the app itself and drives the URL from config.
//   workflow_dispatch  — manual, url optional.
//
// Emits: pr, issue, url, sha, mode

import { readFileSync } from 'node:fs';
import { ghJson, setOutput, loadConfig, die } from './lib/actions.js';

const ev = process.env.GITHUB_EVENT_PATH
  ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
  : {};
const eventName = process.env.GITHUB_EVENT_NAME ?? '';
const cfg = await loadConfig();
const mode = cfg.env?.mode ?? 'preview';

// A library has nothing to drive. Skipping is the correct outcome, not a failure.
if (mode === 'none') {
  process.stdout.write('env.mode is "none" — this repo has no runnable surface, so browser QA does not apply.\n');
  setOutput('skip', 'true');
  setOutput('pr', '');
  process.exit(0);
}

// workflow_dispatch inputs arrive in the EVENT PAYLOAD, not as INPUT_* env vars — those are
// only set for composite actions. Reading the env alone silently ignored `-f pr=2`, and the
// resolver then failed with "could not resolve a PR" while the answer was sitting in the
// payload. Env is still honoured so a step can override explicitly.
let pr = process.env.INPUT_PR || ev.inputs?.pr || null;
let url = process.env.INPUT_URL || ev.inputs?.url || null;
let sha = null;

if (eventName === 'deployment_status') {
  url = ev.deployment_status?.environment_url || ev.deployment_status?.target_url;
  sha = ev.deployment?.sha;
  if (!url) die('deployment carried no environment_url — QA cannot reach what it has no address for');
} else if (eventName === 'workflow_run') {
  sha = ev.workflow_run?.head_sha;
  pr = pr ?? ev.workflow_run?.pull_requests?.[0]?.number;
  // In compose mode the app has not booted yet; the URL is whatever config says we will serve on.
  if (mode !== 'compose') {
    process.stdout.write('env.mode is "' + mode + '" but this was a workflow_run — ' +
      'QA waits for a deployment in preview mode. Nothing to do.\n');
    setOutput('skip', 'true');
    process.exit(0);
  }
}

if (mode === 'compose' && !url) {
  url = cfg.env?.base_url ?? 'http://localhost:3000';
}

// `workflow_run` does not always populate pull_requests (notably for forks), so fall back
// to resolving the PR from the commit.
if (!pr && sha) {
  const prs = await ghJson(['api', `repos/${process.env.GITHUB_REPOSITORY}/commits/${sha}/pulls`]);
  pr = prs[0]?.number;
}
if (!pr) die('could not resolve a PR for this event — QA has nothing to attribute results to');

const detail = await ghJson(['pr', 'view', String(pr), '--json', 'body,number,headRefOid,headRefName']);

// A workflow_dispatch carries no head sha — there is no workflow_run or deployment to read
// one from — so resolve it from the PR itself. Without this the checkout ref is empty, which
// silently means "default branch": exactly the bug that made QA judge the wrong commit.
if (!sha) sha = detail.headRefOid;
if (!sha) die(`could not determine the head commit of PR #${pr}`);
const issue = (detail.body ?? '').match(/(?:closes|fixes|resolves)\s+#(\d+)/i)?.[1];
if (!issue) {
  die(`PR #${pr} does not close an issue, so there is no work order to test against. ` +
      'Add "Closes #<n>" to the PR body.');
}

setOutput('pr', String(pr));
setOutput('issue', issue);
setOutput('url', url);
setOutput('sha', sha);
setOutput('branch', detail.headRefName ?? '');
setOutput('mode', mode);
setOutput('skip', 'false');
