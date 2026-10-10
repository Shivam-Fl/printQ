import { describe, expect, it } from 'vitest';
import { HandshakeLimiter } from './handshakeLimit.js';

describe('HandshakeLimiter', () => {
  it('allows up to the limit per key per window, then blocks, then resets', () => {
    const l = new HandshakeLimiter(3, 1000);
    expect([1, 2, 3, 4].map(() => l.allow('a', 0))).toEqual([true, true, true, false]);
    expect(l.allow('b', 0)).toBe(true);
    expect(l.allow('a', 1001)).toBe(true);
  });

  it('stays bounded under many distinct keys', () => {
    const l = new HandshakeLimiter(1, 60_000, 10);
    for (let i = 0; i < 100; i++) l.allow(`ip${i}`, 0);
    expect((l as unknown as { hits: Map<string, unknown> }).hits.size).toBeLessThanOrEqual(10);
  });
});
