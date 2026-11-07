/**
 * Database-backed tests for the owner's setup/visibility status (QA M3, M9) and
 * owner-only printer routing fields (S22). Needs the migrated PostgreSQL that CI /
 * docker compose provides; skipped without it. Every row is throw-away.
 */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../realtime/events.js', () => ({
  publishEvent: vi.fn(),
  subscribeEvents: vi.fn(),
}));

import { prisma } from '../../lib/prisma.js';
import { signShopToken } from '../../lib/tokens.js';
import { errorHandler } from '../../middleware/error.js';
import { env } from '../../config/env.js';
import { generateAgentToken } from '../../lib/otp.js';
import { agentRouter } from '../agents/routes.js';
import { publicRouter } from '../public/routes.js';
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
  async function makeShop(opts: { agentOnline?: boolean; campusActive?: boolean; published?: boolean; osPrinterName?: string } = {}) {
    const osPrinterName = opts.osPrinterName ?? 'HP LaserJet';
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
      data: { shopId: shop.id, label: 'Front', paperSizesLoaded: ['A4'], finishingOptions: ['spiral'], osPrinterName },
    });
    await prisma.agent.create({
      data: {
        shopId: shop.id,
        machineLabel: 'Counter PC',
        tokenHash: randomUUID(),
        status: opts.agentOnline === false ? 'offline' : 'online',
        connectedPrinterIds: [printer.id],
        detectedPrinters: [{ name: osPrinterName, paperSizes: ['A4'] }, { name: 'Canon G3000', paperSizes: ['A4'] }],
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
      agentReady: boolean;
      platformMarkupBps: number;
      visibility: { state: string; reason: string | null };
      counts: {
        detectedPrinters: number;
        linkedPrinters: number;
        onlinePrinters: number;
        agents: number;
        onlineAgents: number;
        simulatorPrinters: number;
      };
    };
  };

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/shop', shopRouter);
    app.use('/api/agent', agentRouter);
    app.use('/api/public', publicRouter);
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

  describe('the PrintQ Simulator is practice only in production (PSO-1)', () => {
    const saved = { NODE_ENV: env.NODE_ENV, ALLOW: env.ALLOW_SIMULATED_PRINT_COMPLETION };
    afterEach(() => {
      env.NODE_ENV = saved.NODE_ENV;
      env.ALLOW_SIMULATED_PRINT_COMPLETION = saved.ALLOW;
    });

    it('production: a simulator-only shop is not published, not ready, and the simulator is counted apart', async () => {
      env.NODE_ENV = 'production';
      env.ALLOW_SIMULATED_PRINT_COMPLETION = false;
      const { shop, owner } = await makeShop({ published: false, osPrinterName: 'PrintQ Simulator' });
      const status = await setup(owner);
      expect(status.ready).toBe(false);
      expect(status.agentReady).toBe(false);
      expect(status.visibility.state).toBe('not_ready');
      // the real Canon the PC can see is still offered; the simulator is not a "printer found"
      expect(status.counts).toMatchObject({ simulatorPrinters: 1, linkedPrinters: 0, onlinePrinters: 0, onlineAgents: 1, detectedPrinters: 1 });
      expect((await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } })).publishedAt).toBeNull();
    });

    it('production: an already-published simulator-only shop is closed to students', async () => {
      env.NODE_ENV = 'production';
      env.ALLOW_SIMULATED_PRINT_COMPLETION = false;
      const { shop, owner } = await makeShop({ osPrinterName: 'PrintQ Simulator' });
      expect((await setup(owner)).visibility.state).toBe('live_pc_offline');
      const isOpen = async () =>
        ((await (await fetch(`${base}/api/public/shops/${shop.slug}`)).json()) as { shop: { open: boolean } }).shop.open;
      expect(await isOpen()).toBe(false);

      env.NODE_ENV = saved.NODE_ENV;
      env.ALLOW_SIMULATED_PRINT_COMPLETION = saved.ALLOW;
      // development keeps today's behaviour: the simulator opens the shop
      expect(await isOpen()).toBe(true);
    });

    it('development: the simulator still takes the shop live, as before', async () => {
      const { shop, owner } = await makeShop({ published: false, osPrinterName: 'PrintQ Simulator' });
      const status = await setup(owner);
      expect(status.counts.simulatorPrinters).toBe(0);
      expect(status.agentReady).toBe(true);
      expect((await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } })).publishedAt).not.toBeNull();
    });
  });

  describe('removing a counter PC (cleanup audit: printer stayed online with 0 PCs)', () => {
    it('switches its printer offline, setup stops counting it, and a re-installed PC brings it back', async () => {
      const { shop, printer, owner } = await makeShop();
      const pc = await prisma.agent.findFirstOrThrow({ where: { shopId: shop.id } });
      expect((await call(`/api/shop/agents/${pc.id}`, owner, { method: 'DELETE' })).status).toBe(200);

      expect((await prisma.printer.findUniqueOrThrow({ where: { id: printer.id } })).status).toBe('offline');
      const gone = await setup(owner);
      expect(gone.counts).toMatchObject({ agents: 0, onlinePrinters: 0 });
      expect(gone.visibility.state).toBe('live_pc_offline');

      // the owner installs PrintQs Shop again: the new PC reports the same Windows printer
      const { token, tokenHash } = generateAgentToken();
      await prisma.agent.create({ data: { shopId: shop.id, machineLabel: 'New PC', tokenHash, status: 'online' } });
      const report = await fetch(`${base}/api/agent/printers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-token': token },
        body: JSON.stringify({ printers: [{ name: 'HP LaserJet', paperSizes: ['A4'] }] }),
      });
      expect(report.status).toBe(200);
      expect((await prisma.printer.findUniqueOrThrow({ where: { id: printer.id } })).status).toBe('online');
      const back = await setup(owner);
      expect(back.counts).toMatchObject({ agents: 1, onlinePrinters: 1 });
      expect(back.visibility.state).toBe('live');
    });

    it('leaves a printer online when another PC (even one off for the night) still reaches it', async () => {
      const { shop, printer, owner } = await makeShop();
      const pc = await prisma.agent.findFirstOrThrow({ where: { shopId: shop.id } });
      await prisma.agent.create({
        data: { shopId: shop.id, machineLabel: 'Back PC', tokenHash: randomUUID(), status: 'offline', connectedPrinterIds: [printer.id] },
      });
      expect((await call(`/api/shop/agents/${pc.id}`, owner, { method: 'DELETE' })).status).toBe(200);
      expect((await prisma.printer.findUniqueOrThrow({ where: { id: printer.id } })).status).toBe('online');
    });

    it('another shop cannot delete this PC (404) and nothing changes', async () => {
      const mine = await makeShop();
      const other = await makeShop();
      const pc = await prisma.agent.findFirstOrThrow({ where: { shopId: mine.shop.id } });
      expect((await call(`/api/shop/agents/${pc.id}`, other.owner, { method: 'DELETE' })).status).toBe(404);
      expect((await prisma.printer.findUniqueOrThrow({ where: { id: mine.printer.id } })).status).toBe('online');
    });
  });
});
