import express from 'express';
import { describe, expect, it } from 'vitest';
import { signShopToken, signStudentToken } from '../lib/tokens.js';
import { errorHandler } from './error.js';
import { counterReleaseLimiter, loginLimiter, makeGeneralLimiter, pinLoginFailureLimiter, principalOf } from './rateLimit.js';

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

/** A login-shaped app: per-IP loginLimiter, then the per-account PIN brake; the "right" secret is 2468 / good-pass-1. */
async function withLoginApp(run: (call: (body: Record<string, string>, ip: string) => Promise<Response>) => Promise<void>) {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.post('/login', loginLimiter, pinLoginFailureLimiter, (req, res) => {
    const secret = req.body.pin ?? req.body.password;
    res.status(secret === '2468' || secret === 'good-pass-1' ? 200 : 401).json({});
  });
  app.use(errorHandler);
  const server = app.listen(0);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('listener unavailable');
    const url = `http://127.0.0.1:${address.port}/login`;
    await run((body, ip) => fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify(body),
    }));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
}

describe('shop login limits (S1, S3)', () => {
  let n = 0;
  const email = () => `staff-${Date.now()}-${n++}@shop.test`;

  it('successful sign-ins do not use up the per-IP login budget', async () => {
    await withLoginApp(async (call) => {
      for (let i = 0; i < 8; i += 1) expect((await call({ email: email(), password: 'good-pass-1' }, '10.8.0.1')).status).toBe(200);
      // failures still count: 5 per minute per IP
      for (let i = 0; i < 5; i += 1) expect((await call({ email: email(), password: 'wrong-pass' }, '10.8.0.1')).status).toBe(401);
      expect((await call({ email: email(), password: 'good-pass-1' }, '10.8.0.1')).status).toBe(429);
    });
  });

  it('10 wrong PINs for one account lock that account for 15 minutes, whatever the IP', async () => {
    await withLoginApp(async (call) => {
      const target = email();
      for (let i = 0; i < 10; i += 1) expect((await call({ email: target, pin: String(1000 + i) }, `10.8.1.${i}`)).status).toBe(401);
      // a fresh IP and even the right PIN are refused now
      const blocked = await call({ email: target, pin: '2468' }, '10.8.1.200');
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers.get('retry-after'))).toBe(900);
      expect(((await blocked.json()) as { error: string }).error).toMatch(/wrong PINs for this account/);
      // a PIN typed in the password box spends the same budget
      expect((await call({ email: target, password: '2468' }, '10.8.1.201')).status).toBe(429);
      // other accounts are unaffected
      expect((await call({ email: email(), pin: '2468' }, '10.8.1.202')).status).toBe(200);
    });
  });

  it('a full password is never blocked by the PIN brake, so an owner cannot be locked out by PIN spam', async () => {
    await withLoginApp(async (call) => {
      const owner = email();
      for (let i = 0; i < 10; i += 1) await call({ email: owner, password: String(100000 + i) }, `10.8.2.${i}`);
      expect((await call({ email: owner, password: 'good-pass-1' }, '10.8.2.100')).status).toBe(200);
    });
  });

  it('correct PINs hand their slot back', async () => {
    await withLoginApp(async (call) => {
      const staff = email();
      for (let i = 0; i < 9; i += 1) expect((await call({ email: staff, pin: String(1000 + i) }, `10.8.3.${i}`)).status).toBe(401);
      for (let i = 0; i < 5; i += 1) expect((await call({ email: staff, pin: '2468' }, `10.8.3.${50 + i}`)).status).toBe(200);
      expect((await call({ email: staff, pin: '1111' }, '10.8.3.99')).status).toBe(401);
      expect((await call({ email: staff, pin: '1112' }, '10.8.3.98')).status).toBe(429);
    });
  });
});
