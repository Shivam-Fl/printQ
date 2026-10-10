/**
 * Database-backed tests for shop platform-fee payments: due calculation,
 * order creation, webhook/verify/reconcile settlement, enforcement, notices
 * and admin override. Needs the migrated PostgreSQL + Redis that CI provides;
 * skipped without it. Razorpay itself is faked (no network, no credentials).
 */
import { createHmac, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import argon2 from 'argon2';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  process.env.FEE_PAYMENT_PROVIDER = 'razorpay';
  process.env.RAZORPAY_KEY_ID = 'rzp_test_unitplaceholder';
  process.env.RAZORPAY_KEY_SECRET = 'unit-key-secret-placeholder';
  process.env.RAZORPAY_WEBHOOK_SECRET = 'unit-webhook-secret-placeholder';
  process.env.FEE_PAYMENT_TERMS_DAYS = '7';
  process.env.FEE_OVERDUE_BLOCK_AFTER_DAYS = '0';
  return {
    seq: 0,
    createOrderCalls: 0,
    /** provider-side payments keyed by order id (what fetchOrderPayments returns) */
    payments: new Map<string, { id: string; orderId: string; amountPaise: number; currency: string; status: string }[]>(),
    captured: [] as string[],
    emails: [] as { to: string; subject: string }[],
    pushes: [] as { ids: string[]; title: string }[],
    emailFails: false,
  };
});

vi.mock('../../realtime/events.js', () => ({ publishEvent: vi.fn(), subscribeEvents: vi.fn() }));
vi.mock('../../providers/email/index.js', () => ({
  emailProvider: {
    name: 'resend',
    send: vi.fn(async (to: string, subject: string) => {
      if (h.emailFails) throw new Error('resend down');
      h.emails.push({ to, subject });
      return {};
    }),
  },
}));
vi.mock('../../providers/push/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../providers/push/index.js')>();
  return {
    ...actual,
    sendPushToShopUsers: vi.fn(async (ids: string[], message: { title: string }) => {
      h.pushes.push({ ids, title: message.title });
      return 1;
    }),
  };
});
vi.mock('../../providers/feePayment/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../providers/feePayment/index.js')>();
  const { createHmac: hmac } = await import('node:crypto');
  const provider = {
    name: 'razorpay' as const,
    async createOrder() {
      h.createOrderCalls += 1;
      h.seq += 1;
      return { providerOrderId: `order_unit${h.seq}x${Date.now()}` };
    },
    checkout: (o: { providerOrderId: string; amountPaise: number }) => ({
      mode: 'razorpay', keyId: 'rzp_test_unitplaceholder', orderId: o.providerOrderId, amountPaise: o.amountPaise, currency: 'INR',
    }),
    async fetchOrderPayments(orderId: string) {
      return h.payments.get(orderId) ?? [];
    },
    async capturePayment(paymentId: string) {
      h.captured.push(paymentId);
    },
    verifyCheckoutSignature(orderId: string, paymentId: string, signature: string) {
      return hmac('sha256', 'unit-key-secret-placeholder').update(`${orderId}|${paymentId}`).digest('hex') === signature;
    },
  };
  return { ...actual, getFeePaymentProvider: () => provider };
});

import { prisma } from '../../lib/prisma.js';
import { signAdminToken, signShopToken, signStudentToken } from '../../lib/tokens.js';
import { errorHandler } from '../../middleware/error.js';
import { adminRouter } from '../admin/routes.js';
import { publicRouter } from '../public/routes.js';
import { jobsRouter } from '../jobs/routes.js';
import { paymentsRouter, webhookRouter } from '../payments/routes.js';
import { shopRouter } from '../shops/routes.js';
import { isShopOperational } from '../shops/availability.js';
import { freezeWeeklyCommissionStatement } from '../commission/statementService.js';
import { computeFeeAccount } from './account.js';
import { evaluateShopFeeBlock, milestoneFor, runFeeMaintenance } from './enforcement.js';
import { createFeeOrder, markFeeAttemptFailed, reconcileStuckFeeOrders, settleFeePayment } from './payments.js';
import { feesRouter } from './routes.js';

const dbReady = await (async () => {
  try {
    await prisma.shopFeePayment.findFirst({ select: { id: true } });
    await prisma.shop.findFirst({ select: { feeBlockedAt: true } });
    return true;
  } catch (error) {
    console.warn('fees.db.test skipped: database not ready —', String(error).slice(0, 300));
    return false;
  }
})();

vi.setConfig({ testTimeout: 60_000 });

const DAY = 86_400_000;
const T0 = new Date('2026-10-12T00:00:00.000Z');
const WEBHOOK_SECRET = 'unit-webhook-secret-placeholder';

describe.runIf(dbReady)('shop platform-fee payments (database)', () => {
  let server: Server;
  let base = '';
  let campusId = '';
  const shopIds: string[] = [];
  const studentIds: string[] = [];
  const adminIds: string[] = [];

  async function makeShop(tag = 'fee') {
    const shop = await prisma.shop.create({
      data: {
        slug: `fee-${tag}-${randomUUID().slice(0, 8)}`,
        name: `Fee ${tag}`,
        address: '1 Test Lane',
        campusId,
        latitude: 28.6,
        longitude: 77.2,
        rateCard: {},
        printOptions: { papers: [{ id: 'A4', label: 'A4', bwPaise: 200, colorPaise: 1000 }], bindings: [], duplexEnabled: true },
        verificationStatus: 'verified',
        verifiedAt: new Date(),
        verificationSubmittedAt: new Date(),
        publishedAt: new Date(),
      },
    });
    shopIds.push(shop.id);
    const owner = await prisma.shopUser.create({
      data: {
        shopId: shop.id, email: `fee-${randomUUID().slice(0, 8)}@example.test`, name: 'Owner', role: 'owner',
        passwordHash: await argon2.hash('correct-horse-1', { type: argon2.argon2id }),
      },
    });
    const staff = await prisma.shopUser.create({
      data: {
        shopId: shop.id, email: `fee-st-${randomUUID().slice(0, 8)}@example.test`, name: 'Staff', role: 'staff',
        passwordHash: await argon2.hash('1234', { type: argon2.argon2id }),
      },
    });
    return {
      shop, owner,
      token: signShopToken(owner.id, shop.id, 'owner'),
      staffToken: signShopToken(staff.id, shop.id, 'staff'),
    };
  }

  /** Commission entry + (optionally) a frozen weekly statement, with explicit IST-like week windows. */
  let weekCounter = 0;
  async function addCommission(shopId: string, paise: number, at: Date) {
    return prisma.shopCommissionEntry.create({
      data: { shopId, type: paise >= 0 ? 'print_commission' : 'refund_credit', amountPaise: paise, description: 'test', createdAt: at },
    });
  }
  async function freeze(shopId: string, now: Date) {
    weekCounter += 1;
    const end = new Date(now.getTime() - 1_000);
    const start = new Date(end.getTime() - 7 * DAY - weekCounter);
    return freezeWeeklyCommissionStatement(shopId, { start, end: new Date(end.getTime() + weekCounter) }, now);
  }
  /** one statement of `paise` frozen at `frozenAt` */
  async function statementOf(shopId: string, paise: number, frozenAt: Date) {
    await addCommission(shopId, paise, new Date(frozenAt.getTime() - 3 * DAY));
    const statement = await freeze(shopId, frozenAt);
    expect(statement).not.toBeNull();
    return statement!;
  }

  const call = (path: string, token: string | null, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });

  const sign = (body: string) => createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
  let eventSeq = 0;
  async function webhook(event: string, payment: Record<string, unknown>, order?: Record<string, unknown>, opts: { signature?: string; eventId?: string } = {}) {
    const body = JSON.stringify({
      event,
      payload: { payment: { entity: payment }, ...(order ? { order: { entity: order } } : {}) },
    });
    eventSeq += 1;
    return fetch(`${base}/api/payments/webhook/razorpay`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': opts.signature ?? sign(body),
        'x-razorpay-event-id': opts.eventId ?? `evt_${randomUUID()}_${eventSeq}`,
      },
      body,
    });
  }
  const capturedPayment = (orderId: string, amountPaise: number, over: Record<string, unknown> = {}) => ({
    id: `pay_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
    order_id: orderId, amount: amountPaise, currency: 'INR', status: 'captured', notes: [], ...over,
  });

  const noticeCount = (shopId: string, kind?: string) =>
    prisma.shopFeeNotice.count({ where: { shopId, ...(kind ? { kind } : {}) } });

  beforeAll(async () => {
    const campus = await prisma.campus.create({ data: { slug: `fee-c-${randomUUID().slice(0, 8)}`, name: 'Fee Campus', address: 'A' } });
    campusId = campus.id;
    const app = express();
    app.use('/api/payments/webhook', webhookRouter);
    app.use(express.json());
    app.use('/api/public', publicRouter);
    app.use('/api/jobs', jobsRouter);
    app.use('/api/payments', paymentsRouter);
    app.use('/api/shop/fees', feesRouter);
    app.use('/api/shop', shopRouter);
    app.use('/api/admin', adminRouter);
    app.use(errorHandler);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  beforeEach(() => {
    h.emails.length = 0;
    h.pushes.length = 0;
    h.captured.length = 0;
    h.emailFails = false;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const where = { shopId: { in: shopIds } };
    await prisma.shopFeeAllocation.deleteMany({ where: { payment: where } });
    await prisma.shopFeeNotice.deleteMany({ where });
    await prisma.shopFeeEvent.deleteMany({ where });
    await prisma.shopCommissionStatementLine.deleteMany({ where: { statement: where } });
    await prisma.shopCommissionEntry.deleteMany({ where });
    await prisma.shopFeePayment.deleteMany({ where });
    await prisma.shopCommissionStatement.deleteMany({ where });
    await prisma.job.deleteMany({ where });
    await prisma.uploadedFile.deleteMany({ where });
    await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
    await prisma.printer.deleteMany({ where });
    await prisma.agent.deleteMany({ where });
    await prisma.shopPushSubscription.deleteMany({ where: { shopUser: where } });
    await prisma.shopUser.deleteMany({ where });
    await prisma.shop.deleteMany({ where: { id: { in: shopIds } } });
    await prisma.adminAuditEvent.deleteMany({ where: { adminId: { in: adminIds } } });
    await prisma.adminUser.deleteMany({ where: { id: { in: adminIds } } });
    await prisma.campus.deleteMany({ where: { id: campusId } });
  });

  describe('amount due', () => {
    it('sums unpaid statements and current-week accrual, net of credits', async () => {
      const { shop } = await makeShop('due');
      await statementOf(shop.id, 1000, new Date(T0.getTime() - 14 * DAY));
      await statementOf(shop.id, 500, new Date(T0.getTime() - 7 * DAY));
      await addCommission(shop.id, 300, T0);
      await addCommission(shop.id, -100, T0);
      const account = await computeFeeAccount(prisma, shop.id, T0);
      expect(account.statementsDuePaise).toBe(1500);
      expect(account.accruedPaise).toBe(200);
      expect(account.totalDuePaise).toBe(1700);
      expect(account.statements).toHaveLength(2);
      expect(account.statements.every((s) => s.status !== 'paid')).toBe(true);
    });

    it('is zero and "paid up" with nothing owed', async () => {
      const { shop } = await makeShop('zero');
      const account = await computeFeeAccount(prisma, shop.id, T0);
      expect(account.totalDuePaise).toBe(0);
      expect(account.state).toBe('paid_up');
      expect(account.banner).toBeNull();
    });
  });

  describe('order creation', () => {
    it('computes the amount server-side and rejects a client-supplied amount', async () => {
      const { shop, token } = await makeShop('tamper');
      const now = new Date();
      await statementOf(shop.id, 2500, new Date(now.getTime() - DAY));
      const tampered = await call('/api/shop/fees/order', token, { method: 'POST', body: { amountPaise: 1 } });
      expect(tampered.status).toBe(400);
      expect(await prisma.shopFeePayment.count({ where: { shopId: shop.id } })).toBe(0);

      const ok = await call('/api/shop/fees/order', token, { method: 'POST', body: {} });
      expect(ok.status).toBe(201);
      const body = await ok.json() as { payment: { amountPaise: number }; checkout: { amountPaise: number; keyId: string } };
      expect(body.payment.amountPaise).toBe(2500);
      expect(body.checkout.amountPaise).toBe(2500);
      expect(JSON.stringify(body)).not.toContain('unit-key-secret');
    });

    it('requires the owner: staff and anonymous callers are refused', async () => {
      const { staffToken } = await makeShop('authz');
      expect((await call('/api/shop/fees/order', staffToken, { method: 'POST', body: {} })).status).toBe(401);
      expect((await call('/api/shop/fees/order', null, { method: 'POST', body: {} })).status).toBe(401);
      expect((await call('/api/shop/fees', staffToken)).status).toBe(401);
      const status = await call('/api/shop/fees/status', staffToken);
      expect(status.status).toBe(200);
      expect(JSON.stringify(await status.json())).not.toContain('totalDuePaise');
    });

    it('refuses to create an order when nothing is due', async () => {
      const { token } = await makeShop('nothing');
      expect((await call('/api/shop/fees/order', token, { method: 'POST', body: {} })).status).toBe(409);
    });

    it('reuses an open order while the amount is unchanged, then replaces it', async () => {
      const { shop, owner } = await makeShop('reuse');
      const now = new Date();
      await statementOf(shop.id, 1000, new Date(now.getTime() - DAY));
      const first = await createFeeOrder(shop.id, owner.id, now);
      const second = await createFeeOrder(shop.id, owner.id, now);
      expect(second.reused).toBe(true);
      expect(second.payment.id).toBe(first.payment.id);

      await addCommission(shop.id, 400, now);
      const third = await createFeeOrder(shop.id, owner.id, now);
      expect(third.reused).toBe(false);
      expect(third.payment.amountPaise).toBe(1400);
      const rows = await prisma.shopFeePayment.findMany({ where: { shopId: shop.id }, orderBy: { createdAt: 'asc' } });
      expect(rows.map((r) => r.status)).toEqual(['expired', 'created']);
    });

    it('expires an order past its reuse window', async () => {
      const { shop, owner } = await makeShop('ttl');
      const now = new Date();
      await statementOf(shop.id, 1000, new Date(now.getTime() - DAY));
      const first = await createFeeOrder(shop.id, owner.id, now);
      const later = await createFeeOrder(shop.id, owner.id, new Date(now.getTime() + 2 * 3_600_000));
      expect(later.payment.id).not.toBe(first.payment.id);
    });

    it('is race-safe: concurrent requests yield exactly one open order', async () => {
      const { shop, owner } = await makeShop('race');
      const now = new Date();
      await statementOf(shop.id, 1000, new Date(now.getTime() - DAY));
      const before = h.createOrderCalls;
      const results = await Promise.all(Array.from({ length: 6 }, () => createFeeOrder(shop.id, owner.id, now)));
      expect(new Set(results.map((r) => r.payment.id)).size).toBe(1);
      expect(h.createOrderCalls - before).toBe(1);
      expect(await prisma.shopFeePayment.count({ where: { shopId: shop.id, status: { in: ['created', 'attempted', 'failed'] } } })).toBe(1);
    });
  });

  describe('webhook settlement', () => {
    async function openOrder(tag: string, statements: number[]) {
      const ctx = await makeShop(tag);
      const now = new Date();
      let i = statements.length;
      for (const paise of statements) {
        await statementOf(ctx.shop.id, paise, new Date(now.getTime() - (i * 7 * DAY) - DAY));
        i -= 1;
      }
      const order = await createFeeOrder(ctx.shop.id, ctx.owner.id, now);
      const row = await prisma.shopFeePayment.findUniqueOrThrow({ where: { id: order.payment.id } });
      return { ...ctx, order, row };
    }

    it('rejects a bad signature and records nothing', async () => {
      const { row } = await openOrder('badsig', [1000]);
      const res = await webhook('payment.captured', capturedPayment(row.providerOrderId, 1000), undefined, { signature: 'a'.repeat(64) });
      expect(res.status).toBe(400);
      expect((await prisma.shopFeePayment.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('created');
    });

    it('settles on payment.captured: one ledger entry, statements settled, receipt notice', async () => {
      const { shop, owner, row } = await openOrder('capture', [1000]);
      const payment = capturedPayment(row.providerOrderId, 1000, { notes: { kind: 'shop_fee', feePaymentId: row.id } });
      const res = await webhook('payment.captured', payment);
      expect(res.status).toBe(200);

      const paid = await prisma.shopFeePayment.findUniqueOrThrow({ where: { id: row.id } });
      expect(paid.status).toBe('paid');
      expect(paid.providerPaymentId).toBe(payment.id);
      const entries = await prisma.shopCommissionEntry.findMany({ where: { feePaymentId: row.id } });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ type: 'statement_settlement', amountPaise: -1000 });
      const statements = await prisma.shopCommissionStatement.findMany({ where: { shopId: shop.id } });
      expect(statements.every((s) => s.status === 'settled' && s.paidPaise === s.amountDuePaise)).toBe(true);
      expect((await computeFeeAccount(prisma, shop.id)).totalDuePaise).toBe(0);
      expect(await noticeCount(shop.id, 'payment_received')).toBe(1);
      expect(h.emails.some((e) => e.to === owner.email && e.subject.includes('payment received'))).toBe(true);
    });

    it('also settles on order.paid and is idempotent across replay, new event ids and duplicate events', async () => {
      const { shop, row } = await openOrder('orderpaid', [700]);
      const payment = capturedPayment(row.providerOrderId, 700);
      const order = { id: row.providerOrderId, amount: 700, currency: 'INR', notes: { kind: 'shop_fee', feePaymentId: row.id } };
      expect((await webhook('order.paid', payment, order, { eventId: 'evt_same' })).status).toBe(200);
      expect((await webhook('order.paid', payment, order, { eventId: 'evt_same' })).status).toBe(200);
      expect((await webhook('payment.captured', payment, undefined, { eventId: 'evt_other' })).status).toBe(200);
      expect(await prisma.shopCommissionEntry.count({ where: { feePaymentId: row.id } })).toBe(1);
      expect(await prisma.paymentEvent.count({ where: { providerEventId: 'evt_same' } })).toBe(1);
      expect(await noticeCount(shop.id, 'payment_received')).toBe(1);
      // a different payment id for the same, already-paid order changes nothing
      await webhook('payment.captured', capturedPayment(row.providerOrderId, 700));
      expect(await prisma.shopCommissionEntry.count({ where: { feePaymentId: row.id } })).toBe(1);
      expect((await prisma.shopFeePayment.findUniqueOrThrow({ where: { id: row.id } })).providerPaymentId).toBe(payment.id);
    });

    it('ignores amount, currency, notes and order-entity mismatches', async () => {
      const { shop, row } = await openOrder('mismatch', [1000]);
      await webhook('payment.captured', capturedPayment(row.providerOrderId, 999));
      await webhook('payment.captured', capturedPayment(row.providerOrderId, 1000, { currency: 'USD' }));
      await webhook('payment.captured', capturedPayment(row.providerOrderId, 1000, { notes: { kind: 'shop_fee', feePaymentId: randomUUID() } }));
      await webhook('payment.captured', capturedPayment(row.providerOrderId, 1000, { notes: { kind: 'student_job' } }));
      await webhook('order.paid', capturedPayment(row.providerOrderId, 1000), { id: 'order_other', amount: 1000, currency: 'INR', notes: {} });
      expect((await prisma.shopFeePayment.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('created');
      expect(await prisma.shopCommissionEntry.count({ where: { feePaymentId: row.id } })).toBe(0);
      expect(await prisma.shopFeeEvent.count({ where: { shopId: shop.id, kind: 'payment_mismatch' } })).toBe(2);
    });

    it('acknowledges events for orders that are not ours without effect', async () => {
      const res = await webhook('payment.captured', capturedPayment('order_notours123', 500));
      expect(res.status).toBe(200);
      const unrelated = await webhook('refund.created', capturedPayment('order_notours123', 500));
      expect(unrelated.status).toBe(200);
    });

    it('handles payment.failed then a retried capture, and captured then a late failure', async () => {
      const a = await openOrder('failedretry', [1000]);
      await webhook('payment.failed', capturedPayment(a.row.providerOrderId, 1000, { status: 'failed' }));
      expect((await prisma.shopFeePayment.findUniqueOrThrow({ where: { id: a.row.id } })).status).toBe('failed');
      // the owner can retry: the failed order is reused, not duplicated
      const retry = await createFeeOrder(a.shop.id, a.owner.id);
      expect(retry.payment.id).toBe(a.row.id);
      await webhook('payment.captured', capturedPayment(a.row.providerOrderId, 1000));
      expect((await prisma.shopFeePayment.findUniqueOrThrow({ where: { id: a.row.id } })).status).toBe('paid');

      const b = await openOrder('latefail', [1000]);
      await webhook('payment.captured', capturedPayment(b.row.providerOrderId, 1000));
      await webhook('payment.failed', capturedPayment(b.row.providerOrderId, 1000, { status: 'failed' }));
      expect((await prisma.shopFeePayment.findUniqueOrThrow({ where: { id: b.row.id } })).status).toBe('paid');
    });

    it('allocates oldest statements first and carries partial payment', async () => {
      const { shop, row } = await openOrder('alloc', [1000, 800]);
      expect(row.amountPaise).toBe(1800);
      // shrink the order so the payment covers the older statement and part of the newer one
      await prisma.shopFeePayment.update({ where: { id: row.id }, data: { amountPaise: 1500 } });
      await webhook('payment.captured', capturedPayment(row.providerOrderId, 1500));
      const statements = await prisma.shopCommissionStatement.findMany({ where: { shopId: shop.id }, orderBy: { periodEnd: 'asc' } });
      expect(statements.map((s) => [s.amountDuePaise, s.paidPaise, s.status])).toEqual([
        [1000, 1000, 'settled'],
        [800, 500, 'frozen'],
      ]);
      const allocations = await prisma.shopFeeAllocation.findMany({ where: { paymentId: row.id } });
      expect(allocations.reduce((s, a) => s + a.amountPaise, 0)).toBe(1500);
      expect((await computeFeeAccount(prisma, shop.id)).totalDuePaise).toBe(300);
    });

    it('keeps commission that posts between order and payment due', async () => {
      const { shop, row } = await openOrder('between', [1000]);
      await addCommission(shop.id, 250, new Date());
      await webhook('payment.captured', capturedPayment(row.providerOrderId, 1000));
      const account = await computeFeeAccount(prisma, shop.id);
      expect(account.statementsDuePaise).toBe(0);
      expect(account.totalDuePaise).toBe(250);
    });

    it('applies payment of accrued commission to the next statement (no double charge)', async () => {
      const { shop, owner } = await makeShop('prepaid');
      const now = new Date();
      await statementOf(shop.id, 1000, new Date(now.getTime() - 7 * DAY));
      await addCommission(shop.id, 300, new Date(now.getTime() - 2 * DAY));
      const order = await createFeeOrder(shop.id, owner.id, now);
      expect(order.payment.amountPaise).toBe(1300);
      const row = await prisma.shopFeePayment.findUniqueOrThrow({ where: { id: order.payment.id } });
      await webhook('payment.captured', capturedPayment(row.providerOrderId, 1300));
      expect((await prisma.shopFeePayment.findUniqueOrThrow({ where: { id: row.id } })).unallocatedPaise).toBe(300);
      expect((await computeFeeAccount(prisma, shop.id)).totalDuePaise).toBe(0);
      // next weekly freeze covers the prepaid 300: statement is born settled
      const later = new Date(now.getTime() + 6 * DAY);
      const next = await freeze(shop.id, later);
      expect(next).toMatchObject({ amountDuePaise: 300, paidPaise: 300, status: 'settled' });
      expect((await prisma.shopFeePayment.findUniqueOrThrow({ where: { id: row.id } })).unallocatedPaise).toBe(0);
      expect((await computeFeeAccount(prisma, shop.id)).totalDuePaise).toBe(0);
    });
  });

  describe('checkout verify (the browser callback is never trusted alone)', () => {
    it('rejects bad signatures, 404s other shops, and settles only a provider-confirmed capture', async () => {
      const a = await makeShop('verifya');
      const b = await makeShop('verifyb');
      const now = new Date();
      await statementOf(a.shop.id, 900, new Date(now.getTime() - DAY));
      const order = await createFeeOrder(a.shop.id, a.owner.id, now);
      const row = await prisma.shopFeePayment.findUniqueOrThrow({ where: { id: order.payment.id } });
      const paymentId = 'pay_verify123456';
      const goodSig = createHmac('sha256', 'unit-key-secret-placeholder').update(`${row.providerOrderId}|${paymentId}`).digest('hex');
      const body = { orderId: row.providerOrderId, paymentId, signature: goodSig };

      expect((await call('/api/shop/fees/verify', a.token, { method: 'POST', body: { ...body, signature: 'b'.repeat(64) } })).status).toBe(400);
      expect((await call('/api/shop/fees/verify', b.token, { method: 'POST', body })).status).toBe(404);

      // valid signature but the provider reports nothing captured: stays pending, no settlement
      const pending = await call('/api/shop/fees/verify', a.token, { method: 'POST', body });
      expect(await pending.json()).toEqual({ status: 'pending' });
      expect(await prisma.shopCommissionEntry.count({ where: { feePaymentId: row.id } })).toBe(0);
      expect((await prisma.shopFeePayment.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('attempted');

      // provider now reports the captured payment: the server settles it
      h.payments.set(row.providerOrderId, [{ id: paymentId, orderId: row.providerOrderId, amountPaise: 900, currency: 'INR', status: 'captured' }]);
      const paid = await call('/api/shop/fees/verify', a.token, { method: 'POST', body });
      expect(await paid.json()).toEqual({ status: 'paid' });
      expect(await prisma.shopCommissionEntry.count({ where: { feePaymentId: row.id } })).toBe(1);
    });

    it('does not expose mock-pay when the real provider is configured', async () => {
      const { token } = await makeShop('nomock');
      const res = await call('/api/shop/fees/mock-pay', token, { method: 'POST', body: { paymentId: randomUUID() } });
      expect(res.status).toBe(404);
    });
  });

  describe('reconcile job', () => {
    it('settles captured and authorized payments for orders stuck 15+ minutes, ignores the rest', async () => {
      const mk = async (tag: string, amount: number) => {
        const ctx = await makeShop(tag);
        const created = new Date(Date.now() - 20 * 60_000);
        await statementOf(ctx.shop.id, amount, new Date(Date.now() - DAY));
        const order = await createFeeOrder(ctx.shop.id, ctx.owner.id);
        await prisma.shopFeePayment.update({ where: { id: order.payment.id }, data: { createdAt: created } });
        return { ...ctx, id: order.payment.id, orderId: (await prisma.shopFeePayment.findUniqueOrThrow({ where: { id: order.payment.id } })).providerOrderId };
      };
      const captured = await mk('rc-captured', 1100);
      const authorized = await mk('rc-auth', 1200);
      const failed = await mk('rc-failed', 1300);
      const wrongAmount = await mk('rc-wrong', 1400);
      const fresh = await makeShop('rc-fresh');
      await statementOf(fresh.shop.id, 1500, new Date(Date.now() - DAY));
      const freshOrder = await createFeeOrder(fresh.shop.id, fresh.owner.id);

      h.payments.set(captured.orderId, [{ id: 'pay_rccaptured01', orderId: captured.orderId, amountPaise: 1100, currency: 'INR', status: 'captured' }]);
      h.payments.set(authorized.orderId, [{ id: 'pay_rcauthorized1', orderId: authorized.orderId, amountPaise: 1200, currency: 'INR', status: 'authorized' }]);
      h.payments.set(failed.orderId, [{ id: 'pay_rcfailed0001', orderId: failed.orderId, amountPaise: 1300, currency: 'INR', status: 'failed' }]);
      h.payments.set(wrongAmount.orderId, [{ id: 'pay_rcwrong00001', orderId: wrongAmount.orderId, amountPaise: 1, currency: 'INR', status: 'captured' }]);

      await reconcileStuckFeeOrders();
      const status = async (id: string) => (await prisma.shopFeePayment.findUniqueOrThrow({ where: { id } })).status;
      expect(await status(captured.id)).toBe('paid');
      expect(await status(authorized.id)).toBe('paid');
      expect(h.captured).toContain('pay_rcauthorized1');
      expect(await status(failed.id)).toBe('failed');
      expect(await status(wrongAmount.id)).not.toBe('paid');
      expect(await status(freshOrder.payment.id)).toBe('created');
    });

    it('settles a replaced (expired) order that the owner actually paid', async () => {
      const { shop, owner } = await makeShop('rc-expired');
      const now = new Date();
      await statementOf(shop.id, 1000, new Date(now.getTime() - DAY));
      const first = await createFeeOrder(shop.id, owner.id, now);
      await addCommission(shop.id, 100, now);
      await createFeeOrder(shop.id, owner.id, now); // replaces the first
      const firstRow = await prisma.shopFeePayment.findUniqueOrThrow({ where: { id: first.payment.id } });
      expect(firstRow.status).toBe('expired');
      await prisma.shopFeePayment.update({ where: { id: firstRow.id }, data: { createdAt: new Date(Date.now() - 30 * 60_000) } });
      h.payments.set(firstRow.providerOrderId, [{ id: 'pay_expiredpaid01', orderId: firstRow.providerOrderId, amountPaise: 1000, currency: 'INR', status: 'captured' }]);
      await reconcileStuckFeeOrders();
      expect((await prisma.shopFeePayment.findUniqueOrThrow({ where: { id: firstRow.id } })).status).toBe('paid');
      expect((await computeFeeAccount(prisma, shop.id)).totalDuePaise).toBe(100);
    });
  });

  describe('enforcement and notices', () => {
    it('blocks exactly at the due date: not on day 6, blocked on day 7', async () => {
      const { shop } = await makeShop('boundary');
      await statementOf(shop.id, 1000, T0);
      const dueAt = new Date(T0.getTime() + 7 * DAY);
      expect((await evaluateShopFeeBlock(shop.id, new Date(dueAt.getTime() - 1))).change).toBe('none');
      expect((await evaluateShopFeeBlock(shop.id, new Date(T0.getTime() + 6 * DAY))).change).toBe('none');
      expect((await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } })).feeBlockedAt).toBeNull();
      expect((await evaluateShopFeeBlock(shop.id, dueAt)).change).toBe('blocked');
      const blocked = await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } });
      expect(blocked.feeBlockedAt).not.toBeNull();
      expect(blocked.feeBlockReason).toBeTruthy();
      // idempotent
      expect((await evaluateShopFeeBlock(shop.id, new Date(dueAt.getTime() + DAY))).change).toBe('none');
      expect(await prisma.shopFeeEvent.count({ where: { shopId: shop.id, kind: 'blocked' } })).toBe(1);
      expect((await computeFeeAccount(prisma, shop.id, dueAt)).state).toBe('blocked');
    });

    it('walks the full cycle: ready, day 3 reminder, day 6 warning, day 7 block, pay unblocks', async () => {
      const { shop, owner } = await makeShop('cycle');
      await statementOf(shop.id, 12_500, T0);
      const at = (days: number, extraMs = 0) => new Date(T0.getTime() + days * DAY + extraMs);

      await runFeeMaintenance(at(0, 1_000));
      expect(await noticeCount(shop.id, 'statement_ready')).toBe(1);
      await runFeeMaintenance(at(0, 2 * 3_600_000)); // later the same day: deduped
      expect(await noticeCount(shop.id)).toBe(1);
      // the sweep is global: look only at this shop's owner
      const mine = () => h.emails.filter((e) => e.to === owner.email);
      expect(mine()).toHaveLength(1);
      expect(mine()[0]!.subject).toContain('₹125');
      expect(h.pushes.filter((p) => p.ids.includes(owner.id))).toHaveLength(1);

      await runFeeMaintenance(at(2, 23 * 3_600_000)); // day 2: nothing new
      expect(await noticeCount(shop.id)).toBe(1);
      await runFeeMaintenance(at(3));
      await runFeeMaintenance(at(3, 3_600_000));
      expect(await noticeCount(shop.id, 'reminder')).toBe(1);
      await runFeeMaintenance(at(6));
      await runFeeMaintenance(at(6, 3_600_000));
      expect(await noticeCount(shop.id, 'final_warning')).toBe(1);
      expect(mine().some((e) => e.subject.includes('paused tomorrow'))).toBe(true);
      expect((await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } })).feeBlockedAt).toBeNull();

      const result = await runFeeMaintenance(at(7));
      expect(result.blocked).toBeGreaterThanOrEqual(1);
      expect(await noticeCount(shop.id, 'blocked')).toBe(1);
      await runFeeMaintenance(at(8));
      expect(await noticeCount(shop.id, 'blocked')).toBe(1);
      expect(await noticeCount(shop.id)).toBe(4);

      // pay: webhook-driven unblock
      const order = await createFeeOrder(shop.id, owner.id, at(8));
      const row = await prisma.shopFeePayment.findUniqueOrThrow({ where: { id: order.payment.id } });
      expect(await settleFeePayment({
        providerOrderId: row.providerOrderId, providerPaymentId: 'pay_cyclepaid0001', amountPaise: 12_500, currency: 'INR', source: 'webhook',
      }, at(8))).toBe('settled');
      expect((await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } })).feeBlockedAt).toBeNull();
      expect(await prisma.shopFeeEvent.count({ where: { shopId: shop.id, kind: 'unblocked' } })).toBe(1);
      expect(await noticeCount(shop.id, 'payment_received')).toBe(1);
    });

    it('skips milestone notices once overdue and picks only the latest milestone', () => {
      const due = new Date(T0.getTime() + 7 * DAY);
      expect(milestoneFor(due, T0)?.kind).toBe('statement_ready');
      expect(milestoneFor(due, new Date(T0.getTime() + 3 * DAY))?.kind).toBe('reminder');
      expect(milestoneFor(due, new Date(T0.getTime() + 6 * DAY))?.kind).toBe('final_warning');
      expect(milestoneFor(due, due)).toBeNull();
      expect(milestoneFor(due, new Date(T0.getTime() - 1))).toBeNull();
    });

    it('keeps a failed email retryable without duplicating the notice', async () => {
      const { shop } = await makeShop('retry');
      await statementOf(shop.id, 1000, T0);
      h.emailFails = true;
      await runFeeMaintenance(new Date(T0.getTime() + 1_000));
      expect(await noticeCount(shop.id)).toBe(1);
      expect((await prisma.shopFeeNotice.findFirstOrThrow({ where: { shopId: shop.id } })).emailStatus).toBe('failed');
      h.emailFails = false;
      await runFeeMaintenance(new Date(T0.getTime() + 2_000));
      expect(await noticeCount(shop.id)).toBe(1);
      expect((await prisma.shopFeeNotice.findFirstOrThrow({ where: { shopId: shop.id } })).emailStatus).toBe('sent');
    });

    it('does not enforce statements that are not yet billable (dueAt null) and adopts them with a fresh term', async () => {
      const { shop } = await makeShop('adopt');
      const statement = await statementOf(shop.id, 1000, new Date(T0.getTime() - 30 * DAY));
      await prisma.shopCommissionStatement.update({ where: { id: statement.id }, data: { dueAt: null } });
      expect((await evaluateShopFeeBlock(shop.id, T0)).change).toBe('none');
      const result = await runFeeMaintenance(T0);
      expect(result.adopted).toBeGreaterThanOrEqual(1);
      const adopted = await prisma.shopCommissionStatement.findUniqueOrThrow({ where: { id: statement.id } });
      expect(adopted.dueAt?.getTime()).toBe(T0.getTime() + 7 * DAY);
      expect((await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } })).feeBlockedAt).toBeNull();
    });
  });

  describe('block effects on students and the owner toggle', () => {
    async function onlineShop(tag: string) {
      const ctx = await makeShop(tag);
      const printer = await prisma.printer.create({
        data: { shopId: ctx.shop.id, label: 'P1', paperSizesLoaded: ['A4'], status: 'online' },
      });
      await prisma.agent.create({
        data: {
          shopId: ctx.shop.id, machineLabel: 'PC', tokenHash: randomUUID(), status: 'online',
          connectedPrinterIds: [printer.id], lastHeartbeatAt: new Date(),
        },
      });
      return ctx;
    }

    it('blocks new orders and storefront listing, and the owner toggle cannot bypass it', async () => {
      const { shop, token } = await onlineShop('effects');
      const student = await prisma.student.create({ data: { phone: `+9199${Math.floor(Math.random() * 1e8).toString().padStart(8, '0')}` } });
      studentIds.push(student.id);
      const file = await prisma.uploadedFile.create({
        data: {
          studentId: student.id, shopId: shop.id, originalName: 'a.pdf', originalKey: 'k', mimeType: 'application/pdf',
          sizeBytes: 10, pages: 2, status: 'ready',
        },
      });
      const studentToken = signStudentToken(student.id);
      const specs = { paperSize: 'A4', color: false, duplex: false, copies: 1, binding: null, pageRange: null };
      const quote = () => call('/api/jobs/quote', studentToken, { method: 'POST', body: { fileId: file.id, specs } });
      const detail = async () => (await (await call(`/api/public/shops/${shop.slug}`, null)).json()) as { shop: { open: boolean; temporarilyUnavailable: boolean } };

      expect(await isShopOperational(shop.id)).toBe(true);
      expect((await detail()).shop.open).toBe(true);
      expect((await quote()).status).toBe(200);

      await statementOf(shop.id, 1000, T0);
      await evaluateShopFeeBlock(shop.id, new Date(T0.getTime() + 7 * DAY));

      expect(await isShopOperational(shop.id)).toBe(false);
      const blocked = await detail();
      expect(blocked.shop.open).toBe(false);
      expect(blocked.shop.temporarilyUnavailable).toBe(true);
      const refused = await quote();
      expect(refused.status).toBe(409);
      const created = await call('/api/jobs', studentToken, { method: 'POST', body: { fileId: file.id, specs, mode: 'instant' } });
      expect(created.status).toBe(409);
      expect(JSON.stringify(await refused.json()).toLowerCase()).not.toMatch(/fee|payment|overdue|due/);
      expect(await prisma.job.count({ where: { shopId: shop.id } })).toBe(0);

      // the owner's own toggle cannot re-open a blocked shop
      const toggle = await call('/api/shop/availability', token, { method: 'PATCH', body: { acceptingOrders: true } });
      expect(toggle.status).toBe(200);
      expect(await isShopOperational(shop.id)).toBe(false);
      expect((await detail()).shop.open).toBe(false);
      const listed = await call(`/api/public/shops?q=${encodeURIComponent(shop.name)}`, null);
      const listedShop = ((await listed.json()) as { shops: { slug: string; open: boolean }[] }).shops.find((s) => s.slug === shop.slug);
      expect(listedShop?.open).toBe(false);

      // the owner can still sign in to the fee page
      expect((await call('/api/shop/fees', token)).status).toBe(200);

      // settling re-opens it immediately
      const order = await createFeeOrder(shop.id, (await prisma.shopUser.findFirstOrThrow({ where: { shopId: shop.id, role: 'owner' } })).id, new Date(T0.getTime() + 8 * DAY));
      const row = await prisma.shopFeePayment.findUniqueOrThrow({ where: { id: order.payment.id } });
      await webhook('payment.captured', capturedPayment(row.providerOrderId, 1000));
      expect(await isShopOperational(shop.id)).toBe(true);
      expect((await detail()).shop.open).toBe(true);
      expect((await quote()).status).toBe(200);
    });
  });

  describe('admin visibility and lift-block', () => {
    async function makeAdmin() {
      const admin = await prisma.adminUser.create({
        data: {
          email: `fee-admin-${randomUUID().slice(0, 8)}@example.test`, name: 'Admin', passwordHash: await argon2.hash('x-admin-password-1', { type: argon2.argon2id }),
        },
      });
      adminIds.push(admin.id);
      return signAdminToken(admin.id, admin.sessionVersion);
    }

    it('lists due/overdue/blocked per shop and lifts a block only with a reason, as audited admin', async () => {
      const adminToken = await makeAdmin();
      const { shop, token } = await makeShop('admin');
      await statementOf(shop.id, 4000, new Date(Date.now() - 8 * DAY));
      await evaluateShopFeeBlock(shop.id, new Date());
      expect((await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } })).feeBlockedAt).not.toBeNull();

      const list = await call('/api/admin/shops', adminToken);
      const row = ((await list.json()) as { shops: { id: string; fees: { state: string; overduePaise: number }; feeBlockedAt: string | null }[] }).shops.find((s) => s.id === shop.id);
      expect(row?.fees).toMatchObject({ state: 'blocked', overduePaise: 4000 });
      const detail = await call(`/api/admin/shops/${shop.id}/fees`, adminToken);
      expect(detail.status).toBe(200);

      // a shop owner (or anonymous caller) cannot use the admin action
      expect((await call(`/api/admin/shops/${shop.id}/fees/lift-block`, token, { method: 'POST', body: { reason: 'Owner trying it themselves' } })).status).toBe(401);
      expect((await call(`/api/admin/shops/${shop.id}/fees/lift-block`, null, { method: 'POST', body: { reason: 'anonymous attempt here' } })).status).toBe(401);
      expect((await call('/api/admin/shops', token)).status).toBe(401);
      // reason is mandatory
      expect((await call(`/api/admin/shops/${shop.id}/fees/lift-block`, adminToken, { method: 'POST', body: {} })).status).toBe(400);
      expect((await call(`/api/admin/shops/${shop.id}/fees/lift-block`, adminToken, { method: 'POST', body: { reason: 'short' } })).status).toBe(400);

      const lifted = await call(`/api/admin/shops/${shop.id}/fees/lift-block`, adminToken, {
        method: 'POST', body: { reason: 'Owner paid by bank transfer, verified by support', days: 2 },
      });
      expect(lifted.status).toBe(200);
      expect((await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } })).feeBlockedAt).toBeNull();
      const audit = await prisma.adminAuditEvent.findFirstOrThrow({ where: { subjectId: shop.id, action: 'shop.fee_block_lifted' } });
      expect(audit.metadata).toMatchObject({ reason: 'Owner paid by bank transfer, verified by support', days: 2 });

      // the override stops the evaluator from instantly re-blocking...
      expect((await evaluateShopFeeBlock(shop.id, new Date())).change).toBe('none');
      // ...but it lapses
      expect((await evaluateShopFeeBlock(shop.id, new Date(Date.now() + 3 * DAY))).change).toBe('blocked');
      // lifting an unblocked shop is a conflict
      await prisma.shop.update({ where: { id: shop.id }, data: { feeBlockedAt: null } });
      expect((await call(`/api/admin/shops/${shop.id}/fees/lift-block`, adminToken, { method: 'POST', body: { reason: 'Not blocked anymore at all' } })).status).toBe(409);
    });
  });

  describe('receipts and history', () => {
    it('returns a receipt without student data, only for the owning shop', async () => {
      const a = await makeShop('rcpt-a');
      const b = await makeShop('rcpt-b');
      await statementOf(a.shop.id, 1000, new Date(Date.now() - DAY));
      const order = await createFeeOrder(a.shop.id, a.owner.id);
      const row = await prisma.shopFeePayment.findUniqueOrThrow({ where: { id: order.payment.id } });
      expect((await call(`/api/shop/fees/payments/${row.id}/receipt`, a.token)).status).toBe(404); // not paid yet
      await webhook('payment.captured', capturedPayment(row.providerOrderId, 1000));
      const res = await call(`/api/shop/fees/payments/${row.id}/receipt`, a.token);
      expect(res.status).toBe(200);
      const { receipt } = await res.json() as { receipt: { issuer: string; amountPaise: number; providerPaymentId: string; periods: unknown[] } };
      expect(receipt.issuer).toBe('Shivam Ramkumar Mishra (individual proprietor), trading as PrintQs');
      expect(receipt.amountPaise).toBe(1000);
      expect(receipt.providerPaymentId).toMatch(/^pay_/);
      expect(receipt.periods).toHaveLength(1);
      expect((await call(`/api/shop/fees/payments/${row.id}/receipt`, b.token)).status).toBe(404);

      const overview = await (await call('/api/shop/fees', a.token)).json() as { fees: { payments: { id: string; status: string }[]; state: string } };
      expect(overview.fees.payments[0]).toMatchObject({ id: row.id, status: 'paid' });
      expect(overview.fees.state).toBe('paid_up');
    });

    it('marks a failed attempt without touching paid orders', async () => {
      expect(await markFeeAttemptFailed('order_doesnotexist', 'payment_failed')).toBe(false);
    });
  });
});
