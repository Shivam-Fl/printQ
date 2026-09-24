#!/usr/bin/env node
// Decides who must look at a finished work order before code is written.
import { readFileSync } from 'node:fs';
import { setOutput, loadConfig, gh } from './lib/actions.js';
import { planGate } from './lib/routing.js';

const cfg = await loadConfig();
const wo = JSON.parse(readFileSync('work-order.json', 'utf8'));
const { gate, reason } = planGate(wo, cfg);

setOutput('gate', gate);
setOutput('reason', reason);
setOutput('confidence', String(wo.confidence ?? ''));

if (gate === 'human' && reason !== 'gates.plan_approval is on') {
  // Say WHY a human is being pulled in when the gates were configured off — otherwise it
  // looks like the config was ignored.
  await gh(['issue', 'comment', String(wo.issue), '--body',
    `Routing this to a human despite the gate settings: **${reason}**.\n\n` +
    'Comment `/sdlc approve` to proceed anyway, or `/sdlc reject` with what to change.']);
}
process.stdout.write(`gate=${gate} (${reason})\n`);
