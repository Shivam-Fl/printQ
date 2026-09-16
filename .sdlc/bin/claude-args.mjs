#!/usr/bin/env node
// Builds the claude_args string for one pipeline step.
//
//   node .sdlc/bin/claude-args.mjs plan_arbiter
//
// Every step is named and independently configurable — model, turn limit, tools — because
// the steps are not equally hard and a single global model is either wasteful on the easy
// ones or underpowered on the hard ones. Council members are steps like any other, so the
// proposer and the arbiter can run at different weights.

import { loadConfig, setOutput, die } from './lib/actions.js';

// Tools are a safety boundary, not a preference: a reviewer with Edit could rewrite the code
// it is judging, and a planner with Edit could implement instead of planning. These are not
// configurable for that reason.
const TOOLS = {
  plan:              'Bash,Read,Grep,Glob,Write',
  plan_proposer:     'Bash,Read,Grep,Glob,Write',
  plan_critic:       'Bash,Read,Grep,Glob,Write',
  plan_arbiter:      'Bash,Read,Grep,Glob,Write',
  plan_reviewer:     'Bash,Read,Grep,Glob,Write',
  debug:             'Bash,Read,Grep,Glob,Write',
  implement:         'Bash,Read,Edit,Write,Grep,Glob',
  review:            'Bash,Read,Grep,Glob',
  review_correctness:'Bash,Read,Grep,Glob,Write',
  review_design:     'Bash,Read,Grep,Glob,Write',
  qa:                'Bash,Read,Write,Grep,Glob',
  root_cause:        'Bash,Read,Write,Grep,Glob',
  librarian:         'Bash,Read,Edit,Write,Grep,Glob',
  release:           'Bash,Read,Edit,Write',
};

const DEFAULT_TURNS = {
  plan: 40, plan_proposer: 40, plan_critic: 40, plan_arbiter: 40, plan_reviewer: 30,
  debug: 60, implement: 60,
  review: 40, review_correctness: 40, review_design: 40,
  qa: 120, root_cause: 40, librarian: 50, release: 25,
};

// A council member with no explicit setting inherits the stage's, so configuring just
// `plan: claude-opus-5` still does something sensible without listing every role.
const PARENT = {
  plan_proposer: 'plan', plan_critic: 'plan', plan_arbiter: 'plan', plan_reviewer: 'plan',
  review_correctness: 'review', review_design: 'review',
};

const role = process.argv[2];
if (!TOOLS[role]) die(`unknown step "${role}" — expected one of: ${Object.keys(TOOLS).join(', ')}`);

const cfg = await loadConfig();

/** Exact setting wins; otherwise inherit the parent stage; otherwise the built-in default. */
function setting(map, fallbacks) {
  if (!map || typeof map !== 'object') return typeof map === 'string' ? map : undefined;
  if (Object.prototype.hasOwnProperty.call(map, role)) return map[role];
  const parent = PARENT[role];
  if (parent && Object.prototype.hasOwnProperty.call(map, parent)) return map[parent];
  return fallbacks;
}

const turns = setting(cfg.runtime?.max_turns, DEFAULT_TURNS[role]) ?? DEFAULT_TURNS[role];
const model = setting(cfg.runtime?.model, '') ?? '';

const args = [
  `--max-turns ${turns}`,
  `--allowedTools ${TOOLS[role]}`,
  model ? `--model ${model}` : '',
].filter(Boolean).join(' ');

setOutput('args', args);
setOutput('model', model || '(action default)');
setOutput('turns', String(turns));
