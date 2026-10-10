import express from 'express';
import { describe, expect, it } from 'vitest';
import { signShopToken, signStudentToken } from '../lib/tokens.js';
import { errorHandler } from './error.js';
import { counterReleaseLimiter, makeGeneralLimiter, principalOf } from './rateLimit.js';

/** Tiny app with the real limiter factory at small numbers: 3 per user, 12 per IP per window. */
async function withApp(run: (call: (opts: { token?: string; ip: string }) => Promise<Response>) => Promise<void>) {
  const app = express();
  app.set('trust proxy', true);
  app.use(makeGeneralLimiter('t', 3, 12));
  app.get('/x', (_req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  const server = app.listen(0);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('listener unavailable');
    const url = `http://127.0.0.1:${address.port}/x`;
    await run(({ token, ip }) =>
      fetch(url, { headers: { 'x-forwarded-for': ip, ...(token ? { authorization: `Bearer ${token}` } : {}) } }));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
}

describe('general rate limit keys authenticated traffic by principal', () => {
  const alice = () => signStudentToken('00000000-0000-4000-8000-00000000000a');
  const bob = () => signStudentToken('00000000-0000-4000-8000-00000000000b');

  it('two students behind ONE address do not throttle each other', async () => {
    await withApp(async (call) => {
      for (let i = 0; i < 3; i += 1) expect((await call({ token: alice(), ip: '10.9.0.1' })).status).toBe(200);
      const blocked = await call({ token: alice(), ip: '10.9.0.1' });
      expect(blocked.status).toBe(429);
      // same NAT address, different student: still fine
      for (let i = 0; i < 3; i += 1) expect((await call({ token: bob(), ip: '10.9.0.1' })).status).toBe(200);
    });
  });

  it('one student hopping across addresses is still limited, and every 429 carries Retry-After', async () => {
    await withApp(async (call) => {
      for (let i = 0; i < 3; i += 1) expect((await call({ token: alice(), ip: `10.9.1.${i}` })).status).toBe(200);
      const blocked = await call({ token: alice(), ip: '10.9.1.99' });
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(((await blocked.json()) as { error: string }).error).toMatch(/slow down/i);
    });
  });

  it('unauthenticated and forged-token traffic is limited per IP (strict), not by the claimed identity', async () => {
    await withApp(async (call) => {
      for (let i = 0; i < 3; i += 1) expect((await call({ ip: '10.9.2.1' })).status).toBe(200);
      const anon = await call({ ip: '10.9.2.1' });
      expect(anon.status).toBe(429);
      expect(anon.headers.get('retry-after')).toBeTruthy();
      // a different address is independent
      expect((await call({ ip: '10.9.2.2' })).status).toBe(200);
      // a garbage token is not a principal: it shares the IP bucket
      expect((await call({ token: 'not.a.jwt', ip: '10.9.2.1' })).status).toBe(429);
    });
  });

  it('the per-IP ceiling still stops a flood made of many distinct users', async () => {
    await withApp(async (call) => {
      let blockedAt = -1;
      for (let i = 0; i < 20; i += 1) {
        const token = signStudentToken(`00000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`);
        const res = await call({ token, ip: '10.9.3.1' });
        if (res.status === 429 && blockedAt < 0) {
          blockedAt = i;
          expect(res.headers.get('retry-after')).toBeTruthy();
        }
      }
      expect(blockedAt).toBe(12);
    });
  });

  it('the counter-code failure limiter also answers 429 with Retry-After', async () => {
    const app = express();
    app.post('/r', (req, _res, next) => { req.shopUser = { shopId: 'retry-after-shop' } as never; next(); },
      counterReleaseLimiter, (_req, res) => res.status(400).json({ ok: false }));
    app.use(errorHandler);
    const server = app.listen(0);
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('listener unavailable');
      let last: Response | null = null;
      for (let i = 0; i < 12; i += 1) last = await fetch(`http://127.0.0.1:${address.port}/r`, { method: 'POST' });
      expect(last!.status).toBe(429);
      expect(Number(last!.headers.get('retry-after'))).toBe(60);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  });

  it('principalOf only trusts signed tokens', () => {
    const req = (headers: Record<string, string>) => ({ headers }) as never;
    expect(principalOf(req({ authorization: `Bearer ${alice()}` }))).toBe('student:00000000-0000-4000-8000-00000000000a');
    expect(principalOf(req({ authorization: `Bearer ${signShopToken('u1', 's1', 'owner', 0)}` }))).toBe('shop:u1');
    expect(principalOf(req({ authorization: 'Bearer forged' }))).toBeNull();
    expect(principalOf(req({}))).toBeNull();
    expect(principalOf(req({ 'x-agent-token': 'a'.repeat(40) }))).toMatch(/^agent:/);
  });
});
