#!/usr/bin/env node
// PR merged: advance the ledger and kick the release agent.
import { ghJson, gh, setOutput } from './lib/actions.js';
import { advance } from './lib/advance.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

const pr = process.env.PR;
const detail = await ghJson(['pr', 'view', pr, '--json', 'body']);
const issue = (detail.body ?? '').match(/(?:closes|fixes|resolves)\s+#(\d+)/i)?.[1];
if (!issue) { process.stdout.write('PR #' + pr + ' closes no issue — nothing to advance\n'); process.exit(0); }

const ctl = (...a) => exec('node', ['.sdlc/bin/sdlc-ctl.mjs', ...a]);
await advance(issue, 'merged', { agent: 'release' });
await ctl('unlock', '--issue', issue);
// A 404 here on a fresh install means the workflow is not on the default branch yet.
await exec('node', ['.sdlc/bin/dispatch.mjs', 'sdlc-release.yml', '-f', `pr=${pr}`]).catch(() => {});
// Whatever was waiting on this issue can start now. Done here rather than on an
// `issues.closed` trigger, because a PR closing an issue does so with GITHUB_TOKEN and
// fires no event anyone can listen for.
await exec('node', ['.sdlc/bin/wake-dependents.mjs'], {
  env: { ...process.env, CLOSED_ISSUE: String(issue) },
}).then((r) => process.stdout.write(r.stdout)).catch((e) => process.stdout.write(`wake failed: ${e.message}\n`));

setOutput('issue', issue);
