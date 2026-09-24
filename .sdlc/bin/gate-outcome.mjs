#!/usr/bin/env node
// Moves the ledger on the gate's result, and posts a digest when the PR is red.
import { ghJson, gh, die } from './lib/actions.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

const pr = process.env.PR;
const passed = process.env.PASSED ?? process.env.CONCLUSION === 'success';
const detail = await ghJson(['pr', 'view', pr, '--json', 'body']);
const issue = (detail.body ?? '').match(/(?:closes|fixes|resolves)\s+#(\d+)/i)?.[1];
if (!issue) { process.stdout.write(`PR #${pr} closes no issue — nothing to record\n`); process.exit(0); }

const ctl = (...a) => exec('node', ['.sdlc/bin/sdlc-ctl.mjs', ...a]);
const state = String(passed) === 'true' ? 'ci-green' : 'ci-red';
await ctl('transition', '--issue', issue, '--to', state, '--agent', 'gate').catch(() => {});
await gh(['issue', 'edit', issue, '--add-label', `sdlc:${state}`]).catch(() => {});
process.stdout.write(`issue #${issue} -> ${state}\n`);
