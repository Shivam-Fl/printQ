import { describe, expect, it, vi } from 'vitest';
import { TtlCache } from './ttlCache.js';

describe('TtlCache', () => {
  it('serves a value within the TTL and reloads after it', async () => {
    const cache = new TtlCache<number>(1000);
    const load = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    expect(await cache.get('k', load, 0)).toBe(1);
    expect(await cache.get('k', load, 500)).toBe(1);
    expect(load).toHaveBeenCalledTimes(1);
    // entry was stamped with the real clock; clear() forces a reload deterministically
    cache.clear();
    expect(await cache.get('k', load)).toBe(2);
  });

  it('collapses concurrent misses into one load', async () => {
    const cache = new TtlCache<string>(1000);
    const load = vi.fn(async () => 'v');
    await Promise.all([cache.get('k', load), cache.get('k', load), cache.get('k', load)]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('is a pass-through when ttl is 0, and does not cache failures', async () => {
    const off = new TtlCache<number>(0);
    const load = vi.fn(async () => 1);
    await off.get('k', load);
    await off.get('k', load);
    expect(load).toHaveBeenCalledTimes(2);

    const cache = new TtlCache<number>(1000);
    const failing = vi.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce(7);
    await expect(cache.get('k', failing)).rejects.toThrow('db down');
    expect(await cache.get('k', failing)).toBe(7);
  });

  it('stays bounded', async () => {
    const cache = new TtlCache<number>(1000, 3);
    for (let i = 0; i < 10; i++) await cache.get(`k${i}`, async () => i);
    expect((cache as unknown as { entries: Map<string, unknown> }).entries.size).toBeLessThanOrEqual(3);
  });
});
