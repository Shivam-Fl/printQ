// Issue dependencies.
//
// The maintainer splits an epic into pieces that depend on each other — you cannot record an
// expense before groups exist. It already writes those links; nothing acted on them, so every
// piece started at once and the later ones planned against code that did not exist yet.
//
// Deliberately NOT a queue. A queue needs an owner, and an owner that dies leaves everything
// parked with no way to tell whether it is waiting or broken. Instead each issue answers one
// question about itself — "are my dependencies closed?" — and a merge wakes whatever was
// waiting on it. There is no central state, so there is nothing to get stuck.

const PATTERNS = [
  // "Depends on #2", "Depends on: #2, #3", "Blocked by #4"
  /(?:depends?\s+on|blocked\s+by|requires?)\s*:?\s*((?:#\d+[,\s]*)+)/gi,
];

/** Issue numbers this issue waits for. */
export function dependenciesOf(body = '') {
  // Strip fenced blocks and quotes: an example or a quoted comment is not a dependency.
  const text = String(body)
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^\s*>.*$/gm, '');

  const found = new Set();
  for (const re of PATTERNS) {
    for (const m of text.matchAll(re)) {
      for (const n of m[1].match(/\d+/g) ?? []) found.add(Number(n));
    }
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * Can this issue start?
 *
 * @param {number[]} deps
 * @param {Map<number, string>} states  issue number -> 'open' | 'closed'
 * @returns {{ready: true} | {ready: false, waitingOn: number[], missing: number[]}}
 */
export function readyToStart(deps, states) {
  const waitingOn = deps.filter((n) => states.get(n) === 'open');
  // A dependency nobody can find is not a reason to wait forever — it is a reason to say so.
  const missing = deps.filter((n) => !states.has(n));
  return waitingOn.length || missing.length ? { ready: false, waitingOn, missing } : { ready: true };
}

/**
 * Which issues become startable now that `closed` has closed?
 *
 * Only issues whose EVERY dependency is now satisfied. Waking one whose other dependencies
 * are still open just moves the stall one step later and costs an attempt to discover it.
 */
export function unblockedBy(closed, issues) {
  const states = new Map(issues.map((i) => [i.number, i.state]));
  states.set(closed, 'closed');

  return issues
    .filter((i) => i.state === 'open' && i.number !== closed)
    .filter((i) => {
      const deps = dependenciesOf(i.body);
      return deps.includes(closed) && readyToStart(deps, states).ready;
    })
    .map((i) => i.number);
}

/** A cycle means nothing can ever start, and it is the maintainer's mistake, not a deadlock. */
export function findCycle(issues) {
  const graph = new Map(issues.map((i) => [i.number, dependenciesOf(i.body)]));
  const state = new Map();      // 0 = visiting, 1 = done

  const walk = (n, path) => {
    if (state.get(n) === 1) return null;
    if (state.get(n) === 0) return [...path.slice(path.indexOf(n)), n];
    state.set(n, 0);
    for (const dep of graph.get(n) ?? []) {
      if (!graph.has(dep)) continue;
      const cycle = walk(dep, [...path, n]);
      if (cycle) return cycle;
    }
    state.set(n, 1);
    return null;
  };

  for (const n of graph.keys()) {
    const cycle = walk(n, []);
    if (cycle) return cycle;
  }
  return null;
}
