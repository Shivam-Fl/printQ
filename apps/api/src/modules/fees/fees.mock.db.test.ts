/**
 * The local/dev `mock` fee provider: instant settle button used by browser QA.
 * Uses the real provider module (no network). Needs the migrated database.
 */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.FEE_PAYMENT_PROVIDER = 'mock';
});
vi.mock('../../realtime/events.js', () => ({ publishEvent: vi.fn(), subscribeEvents: vi.fn() }));

import { prisma } from '../../lib/prisma.js';
import { signShopToken } from '../../lib/tokens.js';
import { errorHandler } from '../../middleware/error.js';
import { freezeWeeklyCommissionStatement } from '../commission/statementService.js';
import { evaluateShopFeeBlock } from './enforcement.js';
import { feesRouter } from './routes.js';

const dbReady = await (async () => {
  try {
    await prisma.shopFeePayment.findFirst({ select: { id: true } });
    return true;
  } catch (error) {
    console.warn('fees.mock.db.test skipped: database not ready —', String(error).slice(0, 300));
    return false;
  }
})();

vi.setConfig({ testTimeout: 60_000 });

describe.runIf(dbReady)('mock fee provider (database)', () => {
  let server: Server;
  let base = '';
  let campusId = '';
  let shopId = '';
  let token = '';

  const call = (path: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });

  beforeAll(async () => {
    const campus = await prisma.campus.create({ data: { slug: `m-${randomUUID().slice(0, 8)}`, name: 'Mock Campus', address: 'A' } });
    campusId = campus.id;
    const shop = await prisma.shop.create({
      data: { slug: `m-${randomUUID().slice(0, 8)}`, name: 'Mock Fee', address: 'x', campusId, rateCard: {} },
    });
    shopId = shop.id;
    const owner = await prisma.shopUser.create({
      data: { shopId, email: `m-${randomUUID().slice(0, 8)}@example.test`, name: 'O', role: 'owner', passwordHash: 'x' },
    });
    token = signShopToken(owner.id, shopId, 'owner');
    const app = express();
    app.use(express.json());
    app.use('/api/shop/fees', feesRouter);
    app.use(errorHandler);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const where = { shopId };
    await prisma.shopFeeAllocation.deleteMany({ where: { payment: where } });
    await prisma.shopFeeNotice.deleteMany({ where });
    await prisma.shopFeeEvent.deleteMany({ where });
    await prisma.shopCommissionStatementLine.deleteMany({ where: { statement: where } });
    await prisma.shopCommissionEntry.deleteMany({ where });
    await prisma.shopFeePayment.deleteMany({ where });
    await prisma.shopCommissionStatement.deleteMany({ where });
    await prisma.shopUser.deleteMany({ where });
    await prisma.shop.deleteMany({ where: { id: shopId } });
    await prisma.campus.deleteMany({ where: { id: campusId } });
  });

  it('creates an order, settles it with the mock button, unblocks, and issues a receipt', async () => {
    const now = new Date();
    await prisma.shopCommissionEntry.create({
      data: { shopId, type: 'print_commission', amountPaise: 4200, description: 't', createdAt: new Date(now.getTime() - 9 * 86_400_000) },
    });
    await freezeWeeklyCommissionStatement(shopId, { start: new Date(now.getTime() - 16 * 86_400_000), end: new Date(now.getTime() - 8 * 86_400_000) }, new Date(now.getTime() - 8 * 86_400_000));
    await evaluateShopFeeBlock(shopId, now);
    expect((await prisma.shop.findUniqueOrThrow({ where: { id: shopId } })).feeBlockedAt).not.toBeNull();

    const overview = await (await call('/api/shop/fees')).json() as { fees: { provider: string; state: string; totalDuePaise: number } };
    expect(overview.fees).toMatchObject({ provider: 'mock', state: 'blocked', totalDuePaise: 4200 });

    const order = await call('/api/shop/fees/order', { method: 'POST', body: {} });
    const { payment, checkout } = await order.json() as { payment: { id: string; amountPaise: number }; checkout: { mode: string } };
    expect(payment.amountPaise).toBe(4200);
    expect(checkout.mode).toBe('mock');

    const paid = await call('/api/shop/fees/mock-pay', { method: 'POST', body: { paymentId: payment.id } });
    expect(await paid.json()).toEqual({ outcome: 'settled' });
    expect((await prisma.shop.findUniqueOrThrow({ where: { id: shopId } })).feeBlockedAt).toBeNull();
    // a second click is a no-op
    expect(await (await call('/api/shop/fees/mock-pay', { method: 'POST', body: { paymentId: payment.id } })).json()).toEqual({ outcome: 'already_paid' });
    expect(await prisma.shopCommissionEntry.count({ where: { feePaymentId: payment.id } })).toBe(1);

    const receipt = await call(`/api/shop/fees/payments/${payment.id}/receipt`);
    expect(receipt.status).toBe(200);
  });
});
