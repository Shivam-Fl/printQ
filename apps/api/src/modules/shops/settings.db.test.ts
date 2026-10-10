/**
 * Database-backed tests for shop Settings saves and shop session revocation
 * (QA defects OWN-1, OWN-4, OWN-5, OWN-10, OWN-11). Needs the migrated
 * PostgreSQL that CI / docker compose provides; skipped without it. Every row
 * is a throw-away shop/user deleted afterwards.
 */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import argon2 from 'argon2';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../realtime/events.js', () => ({
  publishEvent: vi.fn(),
  subscribeEvents: vi.fn(),
}));

import { prisma } from '../../lib/prisma.js';
import { hashOtp } from '../../lib/otp.js';
import { signShopToken } from '../../lib/tokens.js';
import { errorHandler } from '../../middleware/error.js';
import { authRouter } from '../auth/routes.js';
import { shopRouter } from './routes.js';

const dbReady = await (async () => {
  try {
    await prisma.shopUser.findFirst({ select: { sessionVersion: true } });
    await prisma.shop.findFirst({ select: { printOptionsVersion: true } });
    return true;
  } catch (error) {
    console.warn('settings.db.test skipped: database not ready —', String(error).slice(0, 300));
    return false;
  }
})();

vi.setConfig({ testTimeout: 60_000 });

const MENU = {
  papers: [
    { id: 'A4', label: 'A4', bwPaise: 200, colorPaise: 1000 },
    { id: 'A3', label: 'A3', bwPaise: 500, colorPaise: 2000 },
  ],
  bindings: [{ id: 'spiral', label: 'Spiral', paise: 3000 }],
  duplexEnabled: true,
};

describe.runIf(dbReady)('shop settings + session revocation (database)', () => {
  let server: Server;
  let base = '';
  let campusA = '';
  let campusB = '';
  const shopIds: string[] = [];
  const userIds: string[] = [];
  const campusIds: string[] = [];
  const emails: string[] = [];

  const call = (path: string, token: string | null, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  const patch = (token: string, body: unknown) => call('/api/shop/me', token, { method: 'PATCH', body });

  async function makeShop(tag: string) {
    const shop = await prisma.shop.create({
      data: {
        slug: `st-${tag}-${randomUUID().slice(0, 8)}`,
        name: `Settings ${tag}`,
        address: '1 Test Lane',
        campusId: campusA,
        latitude: 28.613939,
        longitude: 77.209021,
        rateCard: {},
        printOptions: MENU,
        verificationStatus: 'verified',
        verifiedAt: new Date(),
        verificationSubmittedAt: new Date(),
        publishedAt: new Date(),
      },
    });
    shopIds.push(shop.id);
    const email = `qa-${tag}-${randomUUID().slice(0, 8)}@example.test`;
    emails.push(email);
    const owner = await prisma.shopUser.create({
      data: { shopId: shop.id, email, name: 'Owner', role: 'owner', passwordHash: await argon2.hash('correct-horse-1', { type: argon2.argon2id }) },
    });
    userIds.push(owner.id);
    return { shop, owner, ownerEmail: email, token: signShopToken(owner.id, shop.id, 'owner') };
  }

  async function makeStaff(shopId: string) {
    const email = `qa-staff-${randomUUID().slice(0, 8)}@example.test`;
    emails.push(email);
    const staff = await prisma.shopUser.create({
      data: { shopId, email, name: 'Staff', role: 'staff', passwordHash: await argon2.hash('1234', { type: argon2.argon2id }) },
    });
    userIds.push(staff.id);
    return { staff, token: signShopToken(staff.id, shopId, 'staff') };
  }

  const reload = (id: string) => prisma.shop.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    const a = await prisma.campus.create({ data: { slug: `c-a-${randomUUID().slice(0, 8)}`, name: 'Campus A', address: 'A' } });
    const b = await prisma.campus.create({ data: { slug: `c-b-${randomUUID().slice(0, 8)}`, name: 'Campus B', address: 'B' } });
    campusA = a.id;
    campusB = b.id;
    campusIds.push(a.id, b.id);
    const app = express();
    app.use(express.json());
    app.use('/api/auth', authRouter);
    app.use('/api/shop', shopRouter);
    app.use(errorHandler);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.passwordResetOtp.deleteMany({ where: { email: { in: emails } } });
    await prisma.shopUser.deleteMany({ where: { id: { in: userIds } } });
    await prisma.shopUser.deleteMany({ where: { shopId: { in: shopIds } } });
    await prisma.shop.deleteMany({ where: { id: { in: shopIds } } });
    await prisma.campus.deleteMany({ where: { id: { in: campusIds } } });
  });

  describe('OWN-1: only a real change to a material field resets verification', () => {
    it('keeps verified/published when the full form is re-saved with unchanged values', async () => {
      const { shop, token } = await makeShop('unchanged');
      const res = await patch(token, {
        name: shop.name,
        address: shop.address,
        campusId: shop.campusId,
        latitude: shop.latitude,
        longitude: shop.longitude,
        checkInRadiusM: 200,
        counterCapacity: 5,
        revealGraceSeconds: 60,
        printOptions: MENU,
        autoAssignEnabled: true,
        counterUpiVpa: null,
        counterUpiPayeeName: null,
      });
      expect(res.status).toBe(200);
      const after = await reload(shop.id);
      expect(after.verificationStatus).toBe('verified');
      expect(after.publishedAt).not.toBeNull();
      expect(after.verifiedAt).not.toBeNull();
      // an unchanged pin is not a "new" location capture
      expect(after.locationUpdatedAt).toBeNull();
    });

    it('treats a sub-metre coordinate wobble as unchanged', async () => {
      const { shop, token } = await makeShop('epsilon');
      const res = await patch(token, { latitude: 28.613939 + 4e-7, longitude: 77.209021 - 4e-7 });
      expect(res.status).toBe(200);
      expect((await reload(shop.id)).verificationStatus).toBe('verified');
    });

    it.each([
      ['counterCapacity', { counterCapacity: 8 }],
      ['revealGraceSeconds', { revealGraceSeconds: 120 }],
      ['acceptingOrders', { acceptingOrders: false }],
      ['checkInRadiusM', { checkInRadiusM: 50 }],
      ['cashPaymentsEnabled', { cashPaymentsEnabled: true }],
      ['autoAssignEnabled', { autoAssignEnabled: false }],
      ['prices (printOptions)', { printOptions: { ...MENU, papers: [{ ...MENU.papers[0]!, bwPaise: 300 }, MENU.papers[1]!] } }],
    ])('operational field %s never resets verification', async (_name, body) => {
      const { shop, token } = await makeShop('ops');
      const res = await patch(token, body);
      expect(res.status).toBe(200);
      const after = await reload(shop.id);
      expect(after.verificationStatus).toBe('verified');
      expect(after.publishedAt).not.toBeNull();
    });

    it.each([
      ['name', () => ({ name: 'Renamed Copy Centre' })],
      ['address', () => ({ address: '99 Another Road' })],
      ['campusId', () => ({ campusId: campusB })],
      ['latitude', () => ({ latitude: 28.62, longitude: 77.209021 })],
      ['longitude', () => ({ latitude: 28.613939, longitude: 77.22 })],
    ])('a real change to %s sends the shop back to draft', async (_name, body) => {
      const { shop, token } = await makeShop('material');
      const res = await patch(token, body());
      expect(res.status).toBe(200);
      const after = await reload(shop.id);
      expect(after.verificationStatus).toBe('draft');
      expect(after.publishedAt).toBeNull();
      expect(after.verifiedAt).toBeNull();
      expect(after.verificationSubmittedAt).toBeNull();
    });

    it('does not reset the merchant UPI verification when the same VPA is re-saved', async () => {
      const { shop, token } = await makeShop('upi');
      await prisma.shop.update({
        where: { id: shop.id },
        data: { counterUpiVpa: 'shop@okbank', counterUpiPayeeName: 'Shop Name', counterUpiVerifiedAt: new Date() },
      });
      expect((await patch(token, { counterUpiVpa: 'shop@okbank', counterUpiPayeeName: 'Shop Name' })).status).toBe(200);
      expect((await reload(shop.id)).counterUpiVerifiedAt).not.toBeNull();
      expect((await patch(token, { counterUpiVpa: 'other@okbank', counterUpiPayeeName: 'Shop Name' })).status).toBe(200);
      expect((await reload(shop.id)).counterUpiVerifiedAt).toBeNull();
    });
  });

  describe('OWN-5: a stale Settings tab cannot clobber a newer menu', () => {
    it('rejects a menu save made against an out-of-date version with 409', async () => {
      const { shop, token } = await makeShop('stale');
      const first = await (await call('/api/shop/me', token)).json() as { shop: { printOptionsVersion: number } };
      const version = first.shop.printOptionsVersion;
      // tab B saves a new A4 price
      const b = await patch(token, {
        expectedPrintOptionsVersion: version,
        printOptions: { ...MENU, papers: [{ ...MENU.papers[0]!, bwPaise: 250 }, MENU.papers[1]!] },
      });
      expect(b.status).toBe(200);
      expect(((await b.json()) as { shop: { printOptionsVersion: number } }).shop.printOptionsVersion).toBe(version + 1);
      // tab A (still on the old version) saves a different price
      const a = await patch(token, {
        expectedPrintOptionsVersion: version,
        printOptions: { ...MENU, papers: [MENU.papers[0]!, { ...MENU.papers[1]!, bwPaise: 600 }] },
      });
      expect(a.status).toBe(409);
      expect(((await a.json()) as { code?: string }).code).toBe('SETTINGS_CHANGED_ELSEWHERE');
      const stored = (await reload(shop.id)).printOptions as typeof MENU;
      expect(stored.papers[0]!.bwPaise).toBe(250);
      expect(stored.papers[1]!.bwPaise).toBe(500);
    });

    it('does not block unrelated field saves from a stale tab', async () => {
      const { shop, token } = await makeShop('stale-ok');
      const res = await patch(token, { expectedPrintOptionsVersion: 99, counterCapacity: 7 });
      expect(res.status).toBe(200);
      expect((await reload(shop.id)).counterCapacity).toBe(7);
    });

    it('does not bump the version when the menu is unchanged', async () => {
      const { shop, token } = await makeShop('stale-same');
      await patch(token, { printOptions: MENU });
      expect((await reload(shop.id)).printOptionsVersion).toBe(0);
    });
  });

  describe('OWN-10: coordinate validation', () => {
    it.each([
      ['exactly (0,0)', { latitude: 0, longitude: 0 }],
      ['latitude beyond 90', { latitude: 91, longitude: 77 }],
      ['longitude beyond 180', { latitude: 28, longitude: 181 }],
    ])('rejects %s', async (_n, body) => {
      const { shop, token } = await makeShop('coords');
      expect((await patch(token, body)).status).toBe(400);
      expect((await reload(shop.id)).latitude).toBeCloseTo(28.613939, 5);
    });
    it('rejects non-finite values (null stays the explicit "clear" form)', async () => {
      const { token } = await makeShop('coords-nan');
      const res = await fetch(`${base}/api/shop/me`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: '{"latitude":1e999,"longitude":77}',
      });
      expect(res.status).toBe(400);
    });
    it('rejects swapped lat/lng (77.5, 28.6) and other non-India pins without touching the shop', async () => {
      const { shop, token } = await makeShop('coords-swapped');
      for (const body of [{ latitude: 77.5, longitude: 28.6 }, { latitude: 51.5, longitude: -0.12 }]) {
        const res = await patch(token, body);
        expect(res.status).toBe(400);
        expect(JSON.stringify(await res.json())).toContain('outside India');
      }
      const after = await reload(shop.id);
      expect(after.verificationStatus).toBe('verified');
      expect(after.latitude).toBeCloseTo(28.613939, 5);
    });
    it('accepts island extremes of India', async () => {
      const { token } = await makeShop('coords-islands');
      expect((await patch(token, { latitude: 6.75, longitude: 93.85 })).status).toBe(200);
    });
    it('a re-capture under 150 m is saved but keeps the shop published', async () => {
      const { shop, token } = await makeShop('coords-jitter');
      const res = await patch(token, { latitude: 28.613939 + 0.0009, longitude: 77.209021 }); // ~100 m
      expect(res.status).toBe(200);
      const after = await reload(shop.id);
      expect(after.verificationStatus).toBe('verified');
      expect(after.publishedAt).not.toBeNull();
      expect(after.latitude).toBeCloseTo(28.614839, 5);
    });
    it('a move over 150 m (~200 m) sends the shop back to draft', async () => {
      const { shop, token } = await makeShop('coords-move');
      const res = await patch(token, { latitude: 28.613939 + 0.0018, longitude: 77.209021 });
      expect(res.status).toBe(200);
      expect((await reload(shop.id)).verificationStatus).toBe('draft');
    });
  });

  describe('OWN-11: menu validation through the API', () => {
    it.each([
      ['duplicate paper ids', { ...MENU, papers: [MENU.papers[0]!, { ...MENU.papers[0]! }] }],
      ['colour below B/W', { ...MENU, papers: [{ id: 'A4', label: 'A4', bwPaise: 500, colorPaise: 100 }] }],
      ['over Rs 100 a page', { ...MENU, papers: [{ id: 'A4', label: 'A4', bwPaise: 20_000, colorPaise: null }] }],
      ['binding id none', { ...MENU, bindings: [{ id: 'none', label: 'None', paise: 0 }] }],
    ])('rejects %s with 400', async (_n, printOptions) => {
      const { shop, token } = await makeShop('menu');
      expect((await patch(token, { printOptions })).status).toBe(400);
      expect((await reload(shop.id)).printOptions).toEqual(MENU);
    });
  });

  describe('OWN-4: shop session revocation', () => {
    it('lets a valid token through, and refuses it once the staff row is deleted', async () => {
      const { shop, token: ownerToken } = await makeShop('del');
      const { staff, token: staffToken } = await makeStaff(shop.id);
      expect((await call('/api/shop/me', staffToken)).status).toBe(200);
      const del = await call(`/api/shop/staff/${staff.id}`, ownerToken, { method: 'DELETE' });
      expect(del.status).toBe(200);
      expect((await call('/api/shop/me', staffToken)).status).toBe(401);
    });

    it('refuses a token whose user belongs to a different shop than the claim', async () => {
      const a = await makeShop('mismatch-a');
      const b = await makeShop('mismatch-b');
      const forged = signShopToken(a.owner.id, b.shop.id, 'owner');
      expect((await call('/api/shop/me', forged)).status).toBe(401);
    });

    it('uses the role stored in the database, not the one in the token', async () => {
      const { shop } = await makeShop('role');
      const { staff } = await makeStaff(shop.id);
      const claimedOwner = signShopToken(staff.id, shop.id, 'owner');
      expect((await patch(claimedOwner, { counterCapacity: 3 })).status).toBe(401);
    });

    it('sign-out revokes every token issued before it', async () => {
      const { owner, shop, token } = await makeShop('logout');
      expect((await call('/api/shop/me', token)).status).toBe(200);
      const out = await call('/api/auth/shop/logout', token, { method: 'POST' });
      expect(out.status).toBe(200);
      expect((await call('/api/shop/me', token)).status).toBe(401);
      // a fresh login is a new session and works
      const login = await call('/api/auth/shop/login', null, { method: 'POST', body: { email: owner.email, password: 'correct-horse-1' } });
      expect(login.status).toBe(200);
      const { token: fresh } = (await login.json()) as { token: string };
      expect((await call('/api/shop/me', fresh)).status).toBe(200);
      expect((await reload(shop.id)).id).toBe(shop.id);
    });

    it('logout requires authentication', async () => {
      expect((await call('/api/auth/shop/logout', null, { method: 'POST' })).status).toBe(401);
    });

    it('a password reset revokes tokens issued before it', async () => {
      const { owner, token } = await makeShop('reset');
      await prisma.passwordResetOtp.create({
        data: { email: owner.email, otpHash: await hashOtp('123456'), expiresAt: new Date(Date.now() + 60_000) },
      });
      const reset = await call('/api/auth/shop/reset-password', null, {
        method: 'POST',
        body: { email: owner.email, otp: '123456', newPassword: 'brand-new-pass-9' },
      });
      expect(reset.status).toBe(200);
      expect((await call('/api/shop/me', token)).status).toBe(401);
      const login = await call('/api/auth/shop/login', null, { method: 'POST', body: { email: owner.email, password: 'brand-new-pass-9' } });
      expect(login.status).toBe(200);
      const { token: fresh } = (await login.json()) as { token: string };
      expect((await call('/api/shop/me', fresh)).status).toBe(200);
    });
  });
});
