// Per-issue state. Pure functions over a plain object — IO lives in lib/state-io.js
// so the state machine can be tested without a network or a git branch.
//
// This is the file that decides whether a runaway agent stops. Attempt counters increment on
// DISPATCH, never on success: an agent that crash-loops still burns its budget and halts.

export const STATES = [
  'triage', 'planning', 'implementing', 'ci-red', 'ci-green', 'review',
  'qa', 'qa-fail', 'qa-pass', 'merged', 'done',
  'blocked', 'needs-human', 'budget-exceeded',
];

// Terminal states nothing leaves automatically — only a human reopens them.
export const TERMINAL = new Set(['done', 'needs-human', 'budget-exceeded']);

const LEGAL = {
  'triage':          ['planning', 'needs-human', 'blocked'],
  'planning':        ['implementing', 'needs-human', 'blocked'],
  'implementing':    ['ci-red', 'ci-green', 'needs-human', 'blocked'],
  'ci-red':          ['implementing', 'needs-human', 'budget-exceeded'],
  'ci-green':        ['review', 'qa', 'needs-human'],
  'review':          ['qa', 'implementing', 'needs-human'],
  'qa':              ['qa-pass', 'qa-fail', 'needs-human', 'blocked'],
  'qa-fail':         ['implementing', 'needs-human', 'budget-exceeded'],
  // qa-pass is not an end state, it is "waiting to merge". A PR sitting there can still take
  // a new commit, be re-reviewed, or be re-QA'd — which is exactly what happened when a QA
  // rule was corrected and the old verdict had to be re-taken. Modelled as one-way, the
  // re-run's transition was illegal and the ledger silently stopped tracking the PR.
  'qa-pass':         ['merged', 'needs-human', 'qa', 'review', 'ci-green', 'implementing'],
  'merged':          ['done'],
  'done':            [],
  'blocked':         ['triage', 'planning', 'needs-human'],
  'needs-human':     STATES.filter((s) => s !== 'needs-human'), // a human may route it anywhere
  'budget-exceeded': ['needs-human'],
};

export const STAGES = ['plan', 'ci', 'review', 'qa'];

export function newLedger(issue, now = new Date()) {
  return {
    issue,
    pr: null,
    state: 'triage',
    owner: null,
    lock_expires: null,
    attempts: Object.fromEntries(STAGES.map((s) => [s, 0])),
    budget: { minutes: 0, cap_minutes: 120 },
    touch_paths: [],
    acceptance: [],
    artifacts: {},
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    history: [],
  };
}

const stamp = (l, now, agent, action) => ({
  ...l,
  updated_at: now.toISOString(),
  history: [...l.history, { at: now.toISOString(), agent, action }].slice(-200),
});

/** Legal-transition check. An illegal transition is a bug in a workflow, not a valid state. */
export function transition(ledger, to, { agent = 'system', now = new Date() } = {}) {
  if (!STATES.includes(to)) return { ok: false, reason: `unknown state "${to}"` };

  // Landing on the state you are already in is a no-op, not an error. Re-running a stage is
  // ordinary — a retry, a reopened issue, a replayed workflow — and failing there turns a
  // harmless repeat into a red run that looks like a broken state machine.
  if (ledger.state === to) {
    return { ok: true, ledger, unchanged: true };
  }

  const allowed = LEGAL[ledger.state] ?? [];
  if (!allowed.includes(to)) {
    return { ok: false, reason: `illegal transition ${ledger.state} -> ${to}` };
  }
  return { ok: true, ledger: stamp({ ...ledger, state: to }, now, agent, `-> ${to}`) };
}

/**
 * One agent per issue at a time. The lock is advisory but enforced at dispatch: without it,
 * two workflows racing on the same issue produce two branches that fight over the same files.
 */
export function acquireLock(ledger, agent, { ttlMinutes = 45, now = new Date() } = {}) {
  const held = ledger.owner && ledger.lock_expires && new Date(ledger.lock_expires) > now;
  if (held && ledger.owner !== agent) {
    return { ok: false, reason: `locked by ${ledger.owner} until ${ledger.lock_expires}` };
  }
  const expires = new Date(now.getTime() + ttlMinutes * 60000).toISOString();
  return {
    ok: true,
    ledger: stamp({ ...ledger, owner: agent, lock_expires: expires }, now, agent, 'lock acquired'),
  };
}

export function releaseLock(ledger, { agent = 'system', now = new Date() } = {}) {
  return stamp({ ...ledger, owner: null, lock_expires: null }, now, agent, 'lock released');
}

/** A lock past its TTL is stale — the Watchdog reclaims it rather than letting the issue hang. */
export function isLockStale(ledger, now = new Date()) {
  return Boolean(ledger.owner && ledger.lock_expires && new Date(ledger.lock_expires) <= now);
}

/**
 * Increments on DISPATCH, not on success. An agent that fails to even start still consumed
 * an attempt — otherwise a crash loop is free and runs forever.
 */
export function bumpAttempt(ledger, stage, { agent = 'system', now = new Date() } = {}) {
  if (!STAGES.includes(stage)) return { ok: false, reason: `unknown stage "${stage}"` };
  const next = { ...ledger.attempts, [stage]: (ledger.attempts[stage] ?? 0) + 1 };
  return {
    ok: true,
    ledger: stamp({ ...ledger, attempts: next }, now, agent, `${stage} attempt ${next[stage]}`),
  };
}

/** @returns {{ok: true} | {ok: false, reason: string, terminal: string}} */
export function checkBudget(ledger, limits = {}) {
  const maxAttempts = limits.attempts ?? 3;
  const capMinutes = limits.minutes ?? ledger.budget?.cap_minutes ?? 120;

  for (const [stage, n] of Object.entries(ledger.attempts ?? {})) {
    if (n > maxAttempts) {
      return {
        ok: false,
        reason: `${stage} exceeded ${maxAttempts} attempts (at ${n})`,
        terminal: 'budget-exceeded',
      };
    }
  }
  if ((ledger.budget?.minutes ?? 0) > capMinutes) {
    return { ok: false, reason: `exceeded ${capMinutes} minute budget`, terminal: 'budget-exceeded' };
  }
  return { ok: true };
}

/** Escape every regex metacharacter, then re-enable the two glob wildcards. */
function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { out += '.*'; i++; } else { out += '[^/]*'; }
    } else if ('.+^${}()|[]\\?'.includes(c)) {
      out += '\\' + c;
    } else {
      out += c;
    }
  }
  return new RegExp('^' + out + '$');
}

/**
 * Do two issues expect to touch the same files?
 *
 * ADVISORY ONLY. An earlier version blocked the second issue, which was wrong twice over:
 * overlapping edits are ordinary and git handles them, and the overlap is predicted from a
 * plan whose file list is a forecast the implementer routinely departs from. Blocking on a
 * forecast costs throughput permanently to avoid a two-minute merge conflict.
 *
 * What it is good for: telling a reviewer that another PR is moving the same ground.
 */
export function pathsCollide(a = [], b = []) {
  return a.some((x) => b.some((y) => x === y || globToRegExp(x).test(y) || globToRegExp(y).test(x)));
}
