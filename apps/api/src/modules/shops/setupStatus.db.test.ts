/**
 * Database-backed tests for the owner's setup/visibility status (QA M3, M9) and
 * owner-only printer routing fields (S22). Needs the migrated PostgreSQL that CI /
 * docker compose provides; skipped without it. Every row is throw-away.
 */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../realtime/events.js', () => ({
  publishEvent: vi.fn(),
  subscribeEvents: vi.fn(),
}));

import { prisma } from '../../lib/prisma.js';
import { signShopToken } from '../../lib/tokens.js';
import { errorHandler } from '../../middleware/error.js';
import { env } from '../../config/env.js';
import { shopRouter } from './routes.js';

const dbReady = await (async () => {
  try {
    await prisma.shop.findFirst({ select: { autoLive: true } });
    return true;
  } catch (error) {
    console.warn('setupStatus.db.test skipped: database not ready —', String(error).slice(0, 300));
    return false;
  }
})();

vi.setConfig({ testTimeout: 60_000 });

const MENU = {
  papers: [{ id: 'A4', label: 'A4', bwPaise: 200, colorPaise: 1000 }],
  bindings: [{ id: 'spiral', label: 'Spiral', paise: 3000 }],
  duplexEnabled: true,
};

describe.runIf(dbReady)('setup-status visibility + printer field ownership (database)', () => {
  let server: Server;
  let base = '';
  const shopIds: string[] = [];
  const campusIds: string[] = [];
  const adminIds: string[] = [];

  const call = (path: string, token: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });

  /** A published auto-live shop with one linked printer and a PC that sees it plus one unlinked printer. */
  async function makeShop(opts: { agentOnline?: boolean; campusActive?: boolean; published?: boolean } = {}) {
    const campus = opts.campusActive === undefined
      ? null
      : await prisma.campus.create({ data: { slug: `vis-${randomUUID().slice(0, 8)}`, name: 'Vis Campus', address: 'X', isActive: opts.campusActive } });
    if (campus) campusIds.push(campus.id);
    const published = opts.published ?? true;
    const shop = await prisma.shop.create({
      data: {
        slug: `vis-${randomUUID().slice(0, 8)}`,
        name: 'Visibility Copy Centre',
        address: '1 Test Lane',
        campusId: campus?.id ?? null,
        latitude: 18.52,
        longitude: 73.85,
        rateCard: {},
        printOptions: MENU,
        autoLive: true,
        verificationStatus: published ? 'verified' : 'draft',
        verifiedAt: published ? new Date() : null,
        publishedAt: published ? new Date() : null,
      },
    });
    shopIds.push(shop.id);
    const printer = await prisma.printer.create({
      data: { shopId: shop.id, label: 'Front', paperSizesLoaded: ['A4'], finishingOptions: ['spiral'], osPrinterName: 'HP LaserJet' },
    });
    await prisma.agent.create({
      data: {
        shopId: shop.id,
        machineLabel: 'Counter PC',
        tokenHash: randomUUID(),
        status: opts.agentOnline === false ? 'offline' : 'online',
        connectedPrinterIds: [printer.id],
        detectedPrinters: [{ name: 'HP LaserJet', paperSizes: ['A4'] }, { name: 'Canon G3000', paperSizes: ['A4'] }],
      },
    });
    const ownerId = randomUUID();
    const staffId = randomUUID();
    await prisma.shopUser.createMany({
      data: [
        { id: ownerId, shopId: shop.id, email: `vis-o-${ownerId.slice(0, 8)}@example.test`, name: 'Owner', role: 'owner', passwordHash: 'x' },
        { id: staffId, shopId: shop.id, email: `vis-s-${staffId.slice(0, 8)}@example.test`, name: 'Staff', role: 'staff', passwordHash: 'x' },
      ],
    });
    return {
      shop,
      printer,
      owner: signShopToken(ownerId, shop.id, 'owner'),
      staff: signShopToken(staffId, shop.id, 'staff'),
    };
  }

  const setup = async (token: string) => {
    const res = await call('/api/shop/setup-status', token);
    expect(res.status).toBe(200);
    return (await res.json()).setup as {
      ready: boolean;
      platformMarkupBps: number;
      visibility: { state: string; reason: string | null };
      counts: { detectedPrinters: number };
    };
  };

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/shop', shopRouter);
    app.use(errorHandler);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.adminAuditEvent.deleteMany({ where: { subjectId: { in: shopIds } } });
    await prisma.adminUser.deleteMany({ where: { id: { in: adminIds } } });
    await prisma.agent.deleteMany({ where: { shopId: { in: shopIds } } });
    await prisma.printer.deleteMany({ where: { shopId: { in: shopIds } } });
    await prisma.shopUser.deleteMany({ where: { shopId: { in: shopIds } } });
    await prisma.shop.deleteMany({ where: { id: { in: shopIds } } });
    await prisma.campus.deleteMany({ where: { id: { in: campusIds } } });
  });

  it('live shop: visibility live, markup, and 1 found-but-not-added printer', async () => {
    const { owner } = await makeShop();
    const status = await setup(owner);
    expect(status.visibility).toEqual({ state: 'live', reason: null });
    expect(status.platformMarkupBps).toBe(env.PLATFORM_MARKUP_BPS);
    expect(status.counts.detectedPrinters).toBe(1);
    const me = await (await call('/api/shop/me', owner)).json();
    expect(me.platformMarkupBps).toBe(env.PLATFORM_MARKUP_BPS);
  });

  it('PC off at night: live_pc_offline, not "finish setup"; offline PCs report no printers', async () => {
    const { owner } = await makeShop({ agentOnline: false });
    const status = await setup(owner);
    expect(status.visibility.state).toBe('live_pc_offline');
    expect(status.counts.detectedPrinters).toBe(0);
  });

  it('admin unpublish: hidden_by_admin with the recorded reason', async () => {
    const { shop, owner } = await makeShop();
    const admin = await prisma.adminUser.create({
      data: { email: `vis-admin-${randomUUID().slice(0, 8)}@example.test`, passwordHash: 'x', name: 'QA admin' },
    });
    adminIds.push(admin.id);
    await prisma.shop.update({ where: { id: shop.id }, data: { publishedAt: null } });
    await prisma.adminAuditEvent.create({
      data: { adminId: admin.id, action: 'shop.unpublished', subjectType: 'shop', subjectId: shop.id, metadata: { reason: 'Address does not match' } },
    });
    expect((await setup(owner)).visibility).toEqual({ state: 'hidden_by_admin', reason: 'Address does not match' });
  });

  it('inactive campus: campus_inactive even though the shop is published', async () => {
    const { owner } = await makeShop({ campusActive: false });
    expect((await setup(owner)).visibility.state).toBe('campus_inactive');
  });

  it('draft shop with no online PC: not_ready', async () => {
    const { owner } = await makeShop({ published: false, agentOnline: false });
    expect((await setup(owner)).visibility.state).toBe('not_ready');
  });

  it('staff can switch a printer offline without wiping its other settings', async () => {
    const { printer, staff } = await makeShop();
    const res = await call(`/api/shop/printers/${printer.id}`, staff, { method: 'PATCH', body: { status: 'offline' } });
    expect(res.status).toBe(200);
    const after = await prisma.printer.findUniqueOrThrow({ where: { id: printer.id } });
    expect(after.status).toBe('offline');
    expect(after.finishingOptions).toEqual(['spiral']);
    expect(after.osPrinterName).toBe('HP LaserJet');
  });

  it.each([
    ['osPrinterName', { osPrinterName: 'Canon G3000' }],
    ['colorSupport', { colorSupport: true }],
    ['paperSizesLoaded', { paperSizesLoaded: ['A3'] }],
    ['mediaConfig', { mediaConfig: { A4: { paperSize: 'A4', bin: null } } }],
  ])('staff cannot change routing field %s (owner can)', async (_field, body) => {
    const { printer, owner, staff } = await makeShop();
    expect((await call(`/api/shop/printers/${printer.id}`, staff, { method: 'PATCH', body })).status).toBe(403);
    expect((await call(`/api/shop/printers/${printer.id}`, owner, { method: 'PATCH', body })).status).toBe(200);
  });
});
