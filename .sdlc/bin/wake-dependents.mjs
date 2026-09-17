#!/usr/bin/env node
// Starts whatever was waiting on an issue that just closed.
//
// The other half of dependency handling. Intake parks an issue whose dependencies are open;
// this wakes it when they close. Deliberately not a queue — there is no central state, so
// there is nothing to own and nothing to get stuck. Each issue only ever answers a question
// about itself.
import { gh, ghJson, setOutput } from './lib/actions.js';
import { unblockedBy, findCycle, dependenciesOf } from './lib/deps.js';

const closed = Number(process.env.CLOSED_ISSUE);
if (!closed) { process.stdout.write('no issue closed\n'); process.exit(0); }

const issues = (await ghJson(['issue', 'list', '--state', 'all', '--limit', '100', '--json', 'number,state,body']))
  .map((i) => ({ ...i, state: i.state.toLowerCase() }));

// A cycle means nothing in it can ever start. That is a mistake in the split, and it should
// read as one rather than as work nobody got round to.
const cycle = findCycle(issues.filter((i) => i.state === 'open'));
if (cycle) {
  process.stdout.write(`dependency cycle: ${cycle.map((n) => `#${n}`).join(' -> ')}\n`);
  await gh(['issue', 'comment', String(cycle[0]), '--body',
    `These issues depend on each other in a loop: ${cycle.map((n) => `#${n}`).join(' → ')}\n\n` +
    'Nothing in the loop can ever start, so this is a mistake in the split rather than work ' +
    'that is merely waiting. Break the cycle by removing one dependency.']).catch(() => {});
}

const ready = unblockedBy(closed, issues);
if (!ready.length) {
  process.stdout.write(`nothing was waiting on #${closed}\n`);
  setOutput('woken', '0');
  process.exit(0);
}

let woken = 0;
for (const n of ready) {
  try {
    await gh(['issue', 'edit', String(n), '--remove-label', 'sdlc:blocked']).catch(() => {});
    await gh(['issue', 'comment', String(n), '--body',
      `#${closed} is done, and that was the last thing this was waiting on. Starting now.`]);
    await gh(['workflow', 'run', 'sdlc-intake.yml', '-f', `issue=${n}`]);
    process.stdout.write(`woke #${n} (was waiting on ${dependenciesOf(issues.find((i) => i.number === n)?.body ?? '').map((d) => `#${d}`).join(', ')})\n`);
    woken++;
  } catch (e) {
    process.stdout.write(`could not wake #${n}: ${String(e.message).split('\n')[0]}\n`);
  }
}
setOutput('woken', String(woken));
