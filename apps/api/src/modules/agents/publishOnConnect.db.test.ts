/**
 * Database-backed: an auto-live shop is published by its agent's heartbeat with
 * no /setup-status call (issue #74). Needs the migrated PostgreSQL CI provides;
 * skipped without it. Rows are throw-away and deleted afterwards.
 */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../realtime/events.js', () => ({ publishEvent: vi.fn(), subscribeEvents: vi.fn() }));

import { prisma } from '../../lib/prisma.js';
import { generateAgentToken } from '../../lib/otp.js';
import { errorHandler } from '../../middleware/error.js';
import { agentRouter } from './routes.js';

const dbReady = await (async () => {
  try {
    await prisma.shop.findFirst({ select: { autoLive: true } });
    return true;
  } catch (error) {
    console.warn('publishOnConnect.db.test skipped: database not ready —', String(error).slice(0, 300));
    return false;
  }
})();

vi.setConfig({ testTimeout: 60_000 });

const MENU = { papers: [{ id: 'A4', label: 'A4', bwPaise: 200, colorPaise: 1000 }], bindings: [], duplexEnabled: false };

describe.runIf(dbReady)('agent heartbeat publishes a ready auto-live shop (database)', () => {
  let server: Server;
  let base = '';
  const shopIds: string[] = [];

  async function makeShop(verificationStatus: 'draft' | 'rejected', autoLive = true) {
    const shop = await prisma.shop.create({
      data: {
        slug: `pub-${randomUUID().slice(0, 8)}`,
        name: 'Publish test',
        address: '1 Test Lane',
        latitude: 28.613939,
        longitude: 77.209021,
        rateCard: {},
        printOptions: MENU,
        verificationStatus,
        autoLive,
      },
    });
    shopIds.push(shop.id);
    const printer = await prisma.printer.create({
      data: { shopId: shop.id, label: 'HP', paperSizesLoaded: ['A4'], osPrinterName: 'HP LaserJet', status: 'online' },
    });
    const { token, tokenHash } = generateAgentToken();
    await prisma.agent.create({
      data: { shopId: shop.id, machineLabel: 'PC', tokenHash, connectedPrinterIds: [printer.id] },
    });
    return { shop, token };
  }
  const heartbeat = (token: string) =>
    fetch(`${base}/api/agent/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agent-token': token },
      body: '{}',
    });

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/agent', agentRouter);
    app.use(errorHandler);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.agent.deleteMany({ where: { shopId: { in: shopIds } } });
    await prisma.printer.deleteMany({ where: { shopId: { in: shopIds } } });
    await prisma.shop.deleteMany({ where: { id: { in: shopIds } } });
    await prisma.$disconnect();
  });

  it('publishes a draft auto-live shop when its agent comes online', async () => {
    const { shop, token } = await makeShop('draft');
    expect((await heartbeat(token)).status).toBe(200);
    const after = await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } });
    expect(after.publishedAt).not.toBeNull();
    expect(after.verificationStatus).toBe('verified');
  });

  it('leaves a rejected shop unpublished', async () => {
    const { shop, token } = await makeShop('rejected');
    expect((await heartbeat(token)).status).toBe(200);
    const after = await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } });
    expect(after.publishedAt).toBeNull();
    expect(after.verificationStatus).toBe('rejected');
  });

  it('leaves a non-auto-live shop unpublished', async () => {
    const { shop, token } = await makeShop('draft', false);
    expect((await heartbeat(token)).status).toBe(200);
    expect((await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } })).publishedAt).toBeNull();
  });
});
