import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const search = vi.hoisted(() => vi.fn());
const reverse = vi.hoisted(() => vi.fn());
vi.mock('../../providers/geocoding/index.js', () => ({ searchLocations: search, reverseLocation: reverse }));

import { createApp } from '../../app.js';

describe('geocode routes (public, no auth)', () => {
  let server: Server;
  let base = '';
  beforeAll(async () => {
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  beforeEach(() => {
    search.mockReset().mockResolvedValue([{ id: '1', label: 'Shop', latitude: 1, longitude: 2 }]);
    reverse.mockReset().mockResolvedValue('Somewhere');
  });

  it('searches without auth and passes the bias through', async () => {
    const res = await fetch(`${base}/api/shop/geocode?q=corner+print&lat=18.5&lng=73.8`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: [{ id: '1', label: 'Shop', latitude: 1, longitude: 2 }] });
    expect(search).toHaveBeenCalledWith('corner print', { latitude: 18.5, longitude: 73.8 });
  });

  it('ignores out-of-range or partial bias coordinates', async () => {
    await fetch(`${base}/api/shop/geocode?q=corner+print&lat=999&lng=73.8`);
    await fetch(`${base}/api/shop/geocode?q=corner+print&lat=18.5`);
    expect(search).toHaveBeenNthCalledWith(1, 'corner print', undefined);
    expect(search).toHaveBeenNthCalledWith(2, 'corner print', undefined);
  });

  it('returns 400 for a query under 3 characters', async () => {
    expect((await fetch(`${base}/api/shop/geocode?q=ab`)).status).toBe(400);
    expect(search).not.toHaveBeenCalled();
  });

  it('keeps the deprecated /location-search alias working', async () => {
    const res = await fetch(`${base}/api/shop/location-search?q=corner+print`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { results: unknown[] }).results).toHaveLength(1);
  });

  it('reverse returns a label, null, and 400 without valid coordinates', async () => {
    const ok = await fetch(`${base}/api/shop/geocode/reverse?lat=18.5&lng=73.8`);
    expect(await ok.json()).toEqual({ label: 'Somewhere' });
    reverse.mockResolvedValue(null);
    expect(await (await fetch(`${base}/api/shop/geocode/reverse?lat=18.5&lng=73.8`)).json()).toEqual({ label: null });
    expect((await fetch(`${base}/api/shop/geocode/reverse?lat=18.5`)).status).toBe(400);
    expect((await fetch(`${base}/api/shop/geocode/reverse?lat=200&lng=73.8`)).status).toBe(400);
  });

  it('rate limits with 429 after the per-IP budget is spent', async () => {
    let last = 200;
    for (let i = 0; i < 40 && last !== 429; i += 1) {
      last = (await fetch(`${base}/api/shop/geocode?q=flood+test`)).status;
    }
    expect(last).toBe(429);
  });
});
