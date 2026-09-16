#!/usr/bin/env node
// PR merged: advance the ledger and kick the release agent.
import { ghJson, gh, setOutput } from './lib/actions.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

const pr = process.env.PR;
const detail = await ghJson(['pr', 'view', pr, '--json', 'body']);
const issue = (detail.body ?? '').match(/(?:closes|fixes|resolves)\s+#(\d+)/i)?.[1];
if (!issue) { process.stdout.write('PR #' + pr + ' closes no issue — nothing to advance\n'); process.exit(0); }

const ctl = (...a) => exec('node', ['.sdlc/bin/sdlc-ctl.mjs', ...a]);
await ctl('transition', '--issue', issue, '--to', 'merged', '--agent', 'release');
await ctl('unlock', '--issue', issue);
await gh(['issue', 'edit', issue, '--add-label', 'sdlc:merged']);
await gh(['workflow', 'run', 'sdlc-release.yml', '-f', 'pr=' + pr]).catch(() => {});
setOutput('issue', issue);
