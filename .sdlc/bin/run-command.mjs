#!/usr/bin/env node
// Executes an authorized /sdlc command. parseCommand already proved the author may do this.
import { gh, die } from './lib/actions.js';
import { advance } from './lib/advance.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

const cmd = process.env.COMMAND;
const issue = process.env.ISSUE;
const ctl = (...args) => exec('node', ['.sdlc/bin/sdlc-ctl.mjs', ...args]);

switch (cmd) {
  case 'approve':
    await advance(issue, 'implementing', { agent: 'human', alsoRemove: ['sdlc:plan-review'] });
    await gh(['workflow', 'run', 'sdlc-implement.yml', '-f', `issue=${issue}`]);
    await gh(['issue', 'comment', issue, '--body', 'Approved. Implementing.']);
    break;

  case 'reject':
    await advance(issue, 'planning', { agent: 'human', alsoRemove: ['sdlc:plan-review'] });
    await gh(['workflow', 'run', 'sdlc-plan.yml', '-f', `issue=${issue}`]);
    await gh(['issue', 'comment', issue, '--body', 'Work order rejected — replanning with the feedback above.']);
    break;

  case 'retry': {
    // `retry` after a budget stop must clear the counters, or it dispatches straight back
    // into the cap it just hit. Target state comes from the argument so the same command
    // works whether the issue died at planning or at implementation.
    const to = process.env.ARGS?.trim() || 'implementing';
    await ctl('reset', '--issue', issue, '--to', to);
    const workflow = to === 'planning' ? 'sdlc-plan.yml' : 'sdlc-implement.yml';
    await advance(issue, to, { agent: 'human' });
    await gh(['workflow', 'run', workflow, '-f', `issue=${issue}`]);
    await gh(['issue', 'comment', issue, '--body',
      `Attempt counters cleared and restarted at **${to}**. The budget is full again — ` +
      'if it stops here a second time, the cause is worth reading before retrying.']);
    break;
  }

  case 'stop':
    await advance(issue, 'needs-human', { agent: 'human' });
    await ctl('unlock', '--issue', issue);
    await gh(['issue', 'comment', issue, '--body', 'Halted. No agent will pick this up until a label moves it.']);
    break;

  case 'override':
    // Recorded, never silent: an override that leaves no trace is indistinguishable from a bug.
    await gh(['issue', 'comment', issue, '--body',
      '⚠️ Gate overridden by @' + (process.env.GITHUB_ACTOR ?? 'unknown') + '. Recorded in the ledger.']);
    break;

  case 'status': {
    const { stdout } = await ctl('status', '--issue', issue);
    await gh(['issue', 'comment', issue, '--body', '```json\n' + stdout + '\n```']);
    break;
  }

  default:
    die('unhandled command "' + cmd + '"');
}
