import { describe, expect, it } from 'vitest';
import { createLatestRequest, isAbortError } from './latestRequest.js';

/** A fake fetch whose responses resolve in the order the test chooses. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('latest-request guard', () => {
  it('aborts the previous request and marks it stale', () => {
    const guard = createLatestRequest();
    const first = guard.begin();
    const second = guard.begin();
    expect(first.signal.aborted).toBe(true);
    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(true);
  });

  it('a slow older response cannot overwrite a newer one', async () => {
    const guard = createLatestRequest();
    let shown = '';
    const slow = deferred<string>();
    const fast = deferred<string>();

    const run = async (data: Promise<string>) => {
      const ticket = guard.begin();
      const value = await data; // fetch ignoring abort: worst case
      if (ticket.isCurrent()) shown = value;
    };
    const a = run(slow.promise); // user typed "a"
    const b = run(fast.promise); // then "ab"
    fast.resolve('results for ab');
    await b;
    slow.resolve('STALE results for a');
    await a;
    expect(shown).toBe('results for ab');
  });

  it('cancel() invalidates the in-flight request', () => {
    const guard = createLatestRequest();
    const t = guard.begin();
    guard.cancel();
    expect(t.isCurrent()).toBe(false);
    expect(t.signal.aborted).toBe(true);
  });

  it('recognises abort errors', () => {
    expect(isAbortError(new DOMException('x', 'AbortError'))).toBe(true);
    expect(isAbortError(new Error('boom'))).toBe(false);
  });
});
