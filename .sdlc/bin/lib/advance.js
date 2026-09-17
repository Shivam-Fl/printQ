// Move an issue to a state — on the ledger AND on its labels, in one call.
//
// These were two separate lines at every call site, and one of them forgot the ledger half.
// The auto-approve plan path set the `sdlc:implementing` label and dispatched the implementer
// without transitioning, so the ledger sat at `planning` from the first auto-approved issue
// onward. Everything downstream then tried an illegal transition out of `planning`, and every
// one of those was written as `.catch(() => {})` — so the PR went green, QA-passed and the
// ledger still said the plan was being written. Budgets and locks are keyed off that object.
//
// Two facts, one function, no call site that can remember half of it.

import { gh } from './actions.js';
import { STATES } from './ledger.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

const LABEL = (s) => `sdlc:${s}`;

/**
 * @param {string|number} issue
 * @param {string} state   one of ledger STATES
 * @param {{agent?: string, alsoRemove?: string[]}} opts
 * @returns {Promise<boolean>} whether the ledger actually moved
 */
export async function advance(issue, state, { agent = 'system', alsoRemove = [] } = {}) {
  if (!STATES.includes(state)) throw new Error(`advance: "${state}" is not a state`);

  let moved = true;
  await exec('node', ['.sdlc/bin/sdlc-ctl.mjs', 'transition',
    '--issue', String(issue), '--to', state, '--agent', agent])
    .catch((e) => {
      moved = false;
      // Loud, because this is the failure that used to be invisible. Not fatal: the label is
      // what a human reads, and refusing to update it as well would hide the drift further.
      process.stdout.write(
        `::warning::issue #${issue}: ledger did not move to ${state} — ` +
        `${String(e.stderr || e.message).trim().split('\n').pop()}\n`);
    });

  // Labels are the human-readable copy of that state, so exactly one of them should be on the
  // issue. Leaving a stale one is worse than having none: people act on labels.
  const current = await gh(['issue', 'view', String(issue), '--json', 'labels', '--jq', '.labels[].name'])
    .then((out) => out.split('\n').map((s) => s.trim()).filter(Boolean))
    .catch(() => []);

  const stale = [...new Set([...STATES.map(LABEL), ...alsoRemove])]
    .filter((l) => l !== LABEL(state) && current.includes(l));

  const args = ['issue', 'edit', String(issue)];
  for (const l of stale) args.push('--remove-label', l);
  if (!current.includes(LABEL(state))) args.push('--add-label', LABEL(state));
  if (args.length > 3) await gh(args).catch(() => {});

  process.stdout.write(`issue #${issue} -> ${state}${moved ? '' : ' (label only)'}\n`);
  return moved;
}
