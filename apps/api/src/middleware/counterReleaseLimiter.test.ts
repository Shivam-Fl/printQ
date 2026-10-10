import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { counterReleaseLimiter } from './rateLimit.js';

/** A tiny app: the "shop" comes from a header, standing in for requireShopUser. */
async function withApp(run: (call: (shop: string, invalid: boolean, ip?: string) => Promise<number>) => Promise<void>) {
  const app = express();
  app.set('trust proxy', true);
  app.post(
    '/release',
    (req, _res, next) => {
      req.shopUser = { shopId: String(req.headers['x-shop']) } as never;
      next();
    },
    counterReleaseLimiter,
    (req, res) => {
      res.status(req.query.invalid ? 400 : 200).json({ ok: !req.query.invalid });
    },
  );
  const server = app.listen(0);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test listener unavailable');
    const url = `http://127.0.0.1:${address.port}/release`;
    await run(async (shop, invalid, ip = '10.1.1.1') =>
      (await fetch(invalid ? `${url}?invalid=1` : url, { method: 'POST', headers: { 'x-shop': shop, 'x-forwarded-for': ip } })).status);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe('staff counter-code rate limit', () => {
  let n = 0;
  const shop = () => `shop-${Date.now()}-${n++}`;
  afterEach(() => undefined);

  it('does not lock out valid multi-step releases, but limits invalid code guesses (10/min)', async () => {
    await withApp(async (call) => {
      const s = shop();
      for (let i = 0; i < 25; i += 1) expect(await call(s, false)).toBe(200);
      for (let i = 0; i < 10; i += 1) expect(await call(s, true)).toBe(400);
      expect(await call(s, true)).toBe(429);
    });
  });

  it('D6: 13 wrong codes are throttled from the 11th', async () => {
    await withApp(async (call) => {
      const s = shop();
      const statuses: number[] = [];
      for (let i = 0; i < 13; i += 1) statuses.push(await call(s, true));
      expect(statuses.slice(0, 10).every((x) => x === 400)).toBe(true);
      expect(statuses.slice(10)).toEqual([429, 429, 429]);
    });
  });

  it('D6: successful releases by another staff member never refund slots used by wrong codes', async () => {
    await withApp(async (call) => {
      const s = shop();
      for (let i = 0; i < 8; i += 1) expect(await call(s, true)).toBe(400);
      // lots of valid releases from a different computer in the same shop
      for (let i = 0; i < 30; i += 1) expect(await call(s, false, '10.2.2.2')).toBe(200);
      expect(await call(s, true)).toBe(400); // 9th
      expect(await call(s, true)).toBe(400); // 10th
      expect(await call(s, true)).toBe(429); // 11th stays blocked
    });
  });

  it('D6: a shop-wide ceiling stops rotating-IP guessing, and shops do not affect each other', async () => {
    await withApp(async (call) => {
      const s = shop();
      let blockedAt = -1;
      for (let i = 0; i < 60; i += 1) {
        if ((await call(s, true, `10.9.${i}.1`)) === 429) { blockedAt = i; break; }
      }
      expect(blockedAt).toBe(40); // 40 failures from distinct IPs, then 429
      expect(await call(shop(), true, '10.9.1.1')).toBe(400);
    });
  });

  it('concurrent wrong codes cannot slip past the limit', async () => {
    await withApp(async (call) => {
      const s = shop();
      const statuses = await Promise.all(Array.from({ length: 20 }, () => call(s, true)));
      expect(statuses.filter((x) => x === 400)).toHaveLength(10);
      expect(statuses.filter((x) => x === 429)).toHaveLength(10);
    });
  });
});
