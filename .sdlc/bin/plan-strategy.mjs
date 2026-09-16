#!/usr/bin/env node
// Resolves, for one issue: which agent plans it, and how much deliberation it gets.
// Emitted as step outputs so the workflow's conditions stay readable.
import { ghJson, setOutput, loadConfig } from './lib/actions.js';
import { agentForIssue, councilFor } from './lib/routing.js';

const issue = process.env.ISSUE;
const cfg = await loadConfig();
const data = await ghJson(['issue', 'view', issue, '--json', 'labels,title']);

const agent = agentForIssue({ labels: data.labels }, cfg);
const stages = councilFor('plan', cfg);
const mode = stages.length > 1 ? 'council' : 'single';

// A bug is diagnosed by reproducing it, not by debating a plan for it — the debugger owns
// the investigation, and a council of three static readers adds cost without adding evidence.
const effectiveMode = agent === 'debugger' ? 'single' : mode;

setOutput('agent', agent);
setOutput('mode', effectiveMode);
setOutput('pack', agent === 'debugger' ? 'debugger.md' : 'planner.md');
process.stdout.write(`#${issue} "${data.title}" -> ${agent} (${effectiveMode})\n`);
