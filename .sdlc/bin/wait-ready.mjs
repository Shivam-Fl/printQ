#!/usr/bin/env node
// Polls the preview until it answers, so QA never reports a deploy race as a product bug.
import { loadConfig, flags, die } from './lib/actions.js';

const { url } = flags();
const cfg = await loadConfig();
// compose mode can be slow: docker pull, migrate, seed, then two dev servers compiling.
// A default that fits a static site fails a real app for the wrong reason.
const timeout = flags().timeout ?? cfg.env?.ready_timeout_seconds ?? (cfg.env?.mode === 'compose' ? 420 : 180);
const readyPath = cfg.env?.ready ?? '/';
const target = new URL(readyPath, url).toString();
const deadline = Date.now() + Number(timeout) * 1000;

let lastStatus = 'no response';
while (Date.now() < deadline) {
  try {
    const res = await fetch(target, { redirect: 'follow' });
    if (res.ok) {
      process.stdout.write('ready: ' + target + ' -> ' + res.status + '\n');
      process.exit(0);
    }
    lastStatus = String(res.status);
  } catch (e) {
    lastStatus = e.message;
  }
  await new Promise((r) => setTimeout(r, 3000));
}
die('app never became ready at ' + target + ' after ' + timeout + 's (last: ' + lastStatus + ').' +
    '\nThis is an environment failure, not a product defect — QA is blocked, not failed.' +
    '\nIn compose mode check the boot logs, and raise env.ready_timeout_seconds if the stack is simply slow.');
