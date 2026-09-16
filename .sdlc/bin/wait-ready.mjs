#!/usr/bin/env node
// Polls the preview until it answers, so QA never reports a deploy race as a product bug.
import { loadConfig, flags, die } from './lib/actions.js';

const { url, timeout = '180' } = flags();
const cfg = await loadConfig();
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
die('preview never became ready at ' + target + ' (last: ' + lastStatus + ').' +
    '\nThis is an environment failure, not a product defect — QA is being skipped, not failed.');
