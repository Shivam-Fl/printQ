/**
 * Database-backed tests for the auth routes (QA M1 / AUTH-1, S8 / AUTH-3).
 * Needs the migrated PostgreSQL that CI / docker compose provides; skipped
 * without it. Every row is a throw-away shop/user/code deleted afterwards.
 *
 * Each request uses its own client IP (trust proxy + X-Forwarded-For) so the
 * per-IP limiters stay out of the way: these tests are about the 5-attempt cap
 * on the code itself, which must hold even for an attacker with many IPs.
 */
import { randomInt, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import argon2 from 'argon2';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../lib/prisma.js';
import { hashOtp } from '../../lib/otp.js';
import { errorHandler } from '../../middleware/error.js';
import { authRouter } from './routes.js';

const dbReady = await (async () => {
  try {
    await prisma.loginOtp.findFirst({ select: { attempts: true } });
    await prisma.passwordResetOtp.findFirst({ select: { attempts: true } });
    return true;
  } catch (error) {
    console.warn('auth routes.db.test skipped: database not ready —', String(error).slice(0, 300));
    return false;
  }
})();

vi.setConfig({ testTimeout: 60_000 });

describe.runIf(dbReady)('auth routes (database)', () => {
  let server: Server;
  let base = '';
  let ipSeq = 0;
  const phones: string[] = [];
  const emails: string[] = [];
  /** shop names created here, so even an orphan shop (no owner) is cleaned up */
  const shopNames: string[] = [];

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.77.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}` },
      body: JSON.stringify(body),
    });

  /** A code that is never the real one: every wrong guess differs from `correct`. */
  const wrongCodes = (correct: string, n: number) =>
    Array.from({ length: n }, (_, i) => String((Number(correct) + i + 1) % 1_000_000).padStart(6, '0'));

  beforeAll(async () => {
    const app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    app.use('/api/auth', authRouter);
    app.use(errorHandler);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.loginOtp.deleteMany({ where: { phone: { in: phones } } });
    await prisma.student.deleteMany({ where: { phone: { in: phones } } });
    await prisma.passwordResetOtp.deleteMany({ where: { email: { in: emails } } });
    const users = await prisma.shopUser.findMany({ where: { email: { in: emails } }, select: { shopId: true } });
    const shopIds = [...new Set(users.map((u) => u.shopId))];
    await prisma.shopUser.deleteMany({ where: { email: { in: emails } } });
    await prisma.shop.deleteMany({ where: { OR: [{ id: { in: shopIds } }, { name: { in: shopNames } }] } });
  });

  describe('M1: the 5-attempt cap holds under parallel guesses', () => {
    it('student verify-otp: a parallel burst evaluates at most 5 guesses, and the right code after that is refused', async () => {
      const phone = `+9198${String(randomInt(0, 100_000_000)).padStart(8, '0')}`;
      phones.push(phone);
      const otp = String(randomInt(0, 1_000_000)).padStart(6, '0');
      const record = await prisma.loginOtp.create({
        data: { phone, otpHash: await hashOtp(otp), expiresAt: new Date(Date.now() + 5 * 60_000) },
      });

      const statuses = await Promise.all(
        wrongCodes(otp, 12).map(async (code) => (await post('/api/auth/student/verify-otp', { phone, otp: code })).status),
      );
      // at most five guesses reach the hash check; the rest are refused up front
      expect(statuses.filter((s) => s === 401).length).toBeLessThanOrEqual(5);
      expect(statuses.every((s) => s === 401 || s === 400)).toBe(true);
      expect((await prisma.loginOtp.findUniqueOrThrow({ where: { id: record.id } })).attempts).toBe(5);

      const right = await post('/api/auth/student/verify-otp', { phone, otp });
      expect(right.status).toBe(400);
      expect(((await right.json()) as { error: string }).error).toMatch(/too many wrong attempts/i);
      const after = await prisma.loginOtp.findUniqueOrThrow({ where: { id: record.id } });
      expect(after.attempts).toBe(5);
      expect(after.consumedAt).toBeNull();
    });

    it('student verify-otp: the right code mixed into a burst cannot ride past the cap, and is single-use', async () => {
      const phone = `+9197${String(randomInt(0, 100_000_000)).padStart(8, '0')}`;
      phones.push(phone);
      const otp = String(randomInt(0, 1_000_000)).padStart(6, '0');
      const record = await prisma.loginOtp.create({
        data: { phone, otpHash: await hashOtp(otp), expiresAt: new Date(Date.now() + 5 * 60_000) },
      });
      const codes = [...wrongCodes(otp, 9), otp, otp];
      const statuses = await Promise.all(
        codes.map(async (code) => (await post('/api/auth/student/verify-otp', { phone, otp: code })).status),
      );
      // never more than 5 claims on one code, and never two logins from it
      expect(statuses.filter((s) => s === 200).length).toBeLessThanOrEqual(1);
      expect(statuses.filter((s) => s === 200 || s === 401).length).toBeLessThanOrEqual(5);
      expect((await prisma.loginOtp.findUniqueOrThrow({ where: { id: record.id } })).attempts).toBeLessThanOrEqual(5);
    });

    it('shop reset-password: parallel wrong codes never push attempts past 5, and the right code is then refused', async () => {
      const shop = await prisma.shop.create({
        data: { slug: `qa-m1-${randomUUID().slice(0, 8)}`, name: 'M1 Reset', address: '1 Test Lane', rateCard: {}, printOptions: {} },
      });
      const email = `qa-m1-${randomUUID().slice(0, 8)}@example.test`;
      emails.push(email);
      await prisma.shopUser.create({
        data: { shopId: shop.id, email, name: 'Owner', role: 'owner', passwordHash: await argon2.hash('correct-horse-1', { type: argon2.argon2id }) },
      });
      const otp = String(randomInt(0, 1_000_000)).padStart(6, '0');
      const record = await prisma.passwordResetOtp.create({
        data: { email, otpHash: await hashOtp(otp), expiresAt: new Date(Date.now() + 15 * 60_000) },
      });

      const statuses = await Promise.all(
        wrongCodes(otp, 12).map(async (code) =>
          (await post('/api/auth/shop/reset-password', { email, otp: code, newPassword: 'Brand-new-pass-9' })).status),
      );
      expect(statuses.filter((s) => s === 401).length).toBeLessThanOrEqual(5);
      expect((await prisma.passwordResetOtp.findUniqueOrThrow({ where: { id: record.id } })).attempts).toBe(5);

      const right = await post('/api/auth/shop/reset-password', { email, otp, newPassword: 'Brand-new-pass-9' });
      expect(right.status).toBe(400);
      const after = await prisma.passwordResetOtp.findUniqueOrThrow({ where: { id: record.id } });
      expect(after.attempts).toBe(5);
      expect(after.consumedAt).toBeNull();
      // the old password still works: nothing was changed
      expect((await post('/api/auth/shop/login', { email, password: 'correct-horse-1' })).status).toBe(200);
    });

    it('shop reset-password: a correct code works once, even when sent twice at the same time', async () => {
      const shop = await prisma.shop.create({
        data: { slug: `qa-m1b-${randomUUID().slice(0, 8)}`, name: 'M1 Reset Once', address: '1 Test Lane', rateCard: {}, printOptions: {} },
      });
      const email = `qa-m1b-${randomUUID().slice(0, 8)}@example.test`;
      emails.push(email);
      await prisma.shopUser.create({
        data: { shopId: shop.id, email, name: 'Owner', role: 'owner', passwordHash: await argon2.hash('correct-horse-1', { type: argon2.argon2id }) },
      });
      const otp = String(randomInt(0, 1_000_000)).padStart(6, '0');
      await prisma.passwordResetOtp.create({
        data: { email, otpHash: await hashOtp(otp), expiresAt: new Date(Date.now() + 15 * 60_000) },
      });
      const [a, b] = await Promise.all([
        post('/api/auth/shop/reset-password', { email, otp, newPassword: 'First-new-pass-1' }),
        post('/api/auth/shop/reset-password', { email, otp, newPassword: 'Second-new-pass-2' }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 400]);
      const user = await prisma.shopUser.findUniqueOrThrow({ where: { email } });
      expect(user.sessionVersion).toBe(1);
    });
  });

  describe('S8: shop register is atomic', () => {
    const body = (email: string, shopName: string) => {
      shopNames.push(shopName);
      return { shopName, address: '12 Station Road', ownerName: 'Ravi', email, password: 'Corner-print-42' };
    };

    it('parallel submits with one email give one account, clean 409s and no orphan shops', async () => {
      const email = `qa-s8-${randomUUID().slice(0, 8)}@example.test`;
      emails.push(email);
      const name = `QA S8 Race ${randomUUID().slice(0, 6)}`;
      const responses = await Promise.all(Array.from({ length: 5 }, () => post('/api/auth/shop/register', body(email, name))));
      const statuses = responses.map((r) => r.status).sort();
      expect(statuses).toEqual([201, 409, 409, 409, 409]);
      for (const r of responses) {
        if (r.status === 409) expect(((await r.json()) as { error: string }).error).toBe('An account with this email already exists');
      }
      expect(await prisma.shopUser.count({ where: { email } })).toBe(1);
      expect(await prisma.shop.count({ where: { name } })).toBe(1);
    });

    it('parallel sign-ups with the same shop name all succeed with distinct slugs', async () => {
      const name = `QA S8 Same ${randomUUID().slice(0, 6)}`;
      const batch = Array.from({ length: 4 }, () => `qa-s8-${randomUUID().slice(0, 8)}@example.test`);
      emails.push(...batch);
      const responses = await Promise.all(batch.map((email) => post('/api/auth/shop/register', body(email, name))));
      expect(responses.map((r) => r.status)).toEqual([201, 201, 201, 201]);
      const slugs = await Promise.all(responses.map(async (r) => ((await r.json()) as { shop: { slug: string } }).shop.slug));
      expect(new Set(slugs).size).toBe(4);
      expect(await prisma.shop.count({ where: { name } })).toBe(4);
    });

    it('a repeat sign-up with an existing email is a 409, not a 500', async () => {
      const email = `qa-s8-${randomUUID().slice(0, 8)}@example.test`;
      emails.push(email);
      expect((await post('/api/auth/shop/register', body(email, 'QA S8 Repeat'))).status).toBe(201);
      const again = await post('/api/auth/shop/register', body(email, 'QA S8 Repeat'));
      expect(again.status).toBe(409);
      expect(((await again.json()) as { error: string }).error).toBe('An account with this email already exists');
    });

    it('rejects a weak password on the server', async () => {
      const email = `qa-s8-${randomUUID().slice(0, 8)}@example.test`;
      emails.push(email);
      const res = await post('/api/auth/shop/register', { ...body(email, 'QA S8 Weak'), password: '12345678' });
      expect(res.status).toBe(400);
      expect(await prisma.shopUser.count({ where: { email } })).toBe(0);
    });
  });

  describe('student sign-out', () => {
    const login = async (phone: string) => {
      const otp = String(randomInt(0, 1_000_000)).padStart(6, '0');
      await prisma.loginOtp.create({ data: { phone, otpHash: await hashOtp(otp), expiresAt: new Date(Date.now() + 5 * 60_000) } });
      const res = await post('/api/auth/student/verify-otp', { phone, otp });
      expect(res.status).toBe(200);
      return ((await res.json()) as { token: string }).token;
    };
    const me = (token: string) => fetch(`${base}/api/auth/student/me`, { headers: { authorization: `Bearer ${token}` } });
    const logout = (token: string) =>
      fetch(`${base}/api/auth/student/logout`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });

    it('ends this session and every older one (another phone, a lab PC); signing in again works', async () => {
      const phone = `+9197${String(randomInt(0, 100_000_000)).padStart(8, '0')}`;
      phones.push(phone);
      const ownPhone = await login(phone);
      const labPc = await login(phone);
      expect((await me(ownPhone)).status).toBe(200);
      expect((await me(labPc)).status).toBe(200);

      expect((await logout(labPc)).status).toBe(200);
      expect((await me(labPc)).status).toBe(401);
      expect((await me(ownPhone)).status).toBe(401);

      const fresh = await login(phone);
      expect((await me(fresh)).status).toBe(200);
      // an old token can't be used to sign the new session out
      expect((await logout(ownPhone)).status).toBe(401);
      expect((await me(fresh)).status).toBe(200);
    });
  });
});
