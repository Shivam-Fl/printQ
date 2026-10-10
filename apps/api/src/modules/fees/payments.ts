import { randomUUID } from 'node:crypto';
import type { ShopFeePayment } from '@prisma/client';
import { logger } from '../../lib/logger.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { getFeePaymentProvider, type FeePaymentProvider } from '../../providers/feePayment/index.js';
import { publishEvent } from '../../realtime/events.js';
import { computeFeeAccount } from './account.js';
import { afterBlockChange, evaluateShopFeeBlockTx } from './enforcement.js';
import {
  FEE_ORDER_TTL_MS,
  FEE_RECONCILE_AFTER_MS,
  FEE_RECONCILE_MAX_AGE_MS,
  UNPAID_STATEMENT_STATUSES,
} from './feeConfig.js';
import { emitFeeNotice, formatRupees } from './notices.js';

const OPEN_STATUSES = ['created', 'attempted', 'failed'] as const;

function requireProvider(): FeePaymentProvider {
  const provider = getFeePaymentProvider();
  if (!provider) throw conflict('Fee payments are not enabled yet');
  return provider;
}

export interface FeeOrderResult {
  reused: boolean;
  payment: { id: string; amountPaise: number; status: ShopFeePayment['status']; expiresAt: Date };
  checkout: Record<string, unknown>;
}

/**
 * Create (or reuse) the shop's single open Checkout order for exactly the
 * amount due. The amount is computed here under the shop row lock; the client
 * never supplies one. An unexpired open order with an unchanged amount is
 * reused, otherwise it is expired and replaced.
 */
export async function createFeeOrder(shopId: string, requestedById: string, now = new Date()): Promise<FeeOrderResult> {
  const provider = requireProvider();

  // A missed webhook must not make the owner pay twice: settle any order the
  // provider already captured before computing a fresh amount.
  const stale = await prisma.shopFeePayment.findMany({
    where: { shopId, status: { in: [...OPEN_STATUSES] }, createdAt: { lt: new Date(now.getTime() - 60_000) } },
  });
  for (const order of stale) await reconcileFeeOrder(order, now).catch(() => undefined);

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Shop" WHERE "id" = ${shopId} FOR UPDATE`;
    const account = await computeFeeAccount(tx, shopId, now);
    const amountPaise = account.totalDuePaise;
    if (amountPaise <= 0) throw conflict('There is nothing to pay right now');

    const open = await tx.shopFeePayment.findMany({
      where: { shopId, status: { in: [...OPEN_STATUSES] } },
      orderBy: { createdAt: 'desc' },
    });
    const reusable = open.find((o) => o.amountPaise === amountPaise && o.expiresAt > now);
    if (reusable) {
      return {
        reused: true,
        payment: { id: reusable.id, amountPaise, status: reusable.status, expiresAt: reusable.expiresAt },
        checkout: provider.checkout({ providerOrderId: reusable.providerOrderId, amountPaise }),
      };
    }
    if (open.length > 0) {
      // Replaced orders stay reconcilable (status expired) in case the owner
      // completed one in another tab: settlement still accepts them.
      await tx.shopFeePayment.updateMany({
        where: { shopId, status: { in: [...OPEN_STATUSES] } },
        data: { status: 'expired' },
      });
    }

    const id = randomUUID();
    const order = await provider.createOrder({
      receipt: id,
      amountPaise,
      notes: { kind: 'shop_fee', feePaymentId: id, shopId },
    });
    const created = await tx.shopFeePayment.create({
      data: {
        id,
        shopId,
        provider: provider.name,
        providerOrderId: order.providerOrderId,
        amountPaise,
        requestedById,
        expiresAt: new Date(now.getTime() + FEE_ORDER_TTL_MS),
      },
    });
    await tx.shopFeeEvent.create({ data: { shopId, kind: 'order_created', metadata: { paymentId: id, amountPaise } } });
    return {
      reused: false,
      payment: { id, amountPaise, status: created.status, expiresAt: created.expiresAt },
      checkout: provider.checkout({ providerOrderId: order.providerOrderId, amountPaise }),
    };
  }, { timeout: 30_000, maxWait: 15_000 });
}

export type SettleOutcome = 'settled' | 'already_paid' | 'unknown_order' | 'mismatch' | 'conflict';

export interface SettleInput {
  providerOrderId: string;
  providerPaymentId: string;
  amountPaise: number;
  currency: string;
  source: 'webhook' | 'reconcile' | 'mock';
}

/**
 * Post ONE settlement ledger entry for a verified, captured payment and
 * allocate it to the oldest unpaid statements first. Idempotent per order:
 * duplicates, replays and out-of-order deliveries are no-ops. Callers are
 * responsible for authenticity (webhook signature / provider fetch / mock).
 */
export async function settleFeePayment(input: SettleInput, now = new Date()): Promise<SettleOutcome> {
  const candidate = await prisma.shopFeePayment.findUnique({
    where: { providerOrderId: input.providerOrderId },
    select: { id: true, shopId: true },
  });
  if (!candidate) return 'unknown_order';

  const settled = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Shop" WHERE "id" = ${candidate.shopId} FOR UPDATE`;
    const payment = await tx.shopFeePayment.findUnique({ where: { id: candidate.id } });
    if (!payment) return { outcome: 'unknown_order' as const };

    if (payment.status === 'paid') {
      return { outcome: payment.providerPaymentId === input.providerPaymentId ? 'already_paid' as const : 'conflict' as const };
    }
    if (input.amountPaise !== payment.amountPaise || input.currency !== payment.currency) {
      await tx.shopFeeEvent.create({
        data: {
          shopId: payment.shopId,
          kind: 'payment_mismatch',
          metadata: {
            paymentId: payment.id,
            expectedPaise: payment.amountPaise,
            receivedPaise: input.amountPaise,
            currency: input.currency,
            source: input.source,
          },
        },
      });
      return { outcome: 'mismatch' as const };
    }

    // Oldest statements first; whatever is left paid current-week accrual and
    // is consumed by the next statement freeze.
    let remaining = payment.amountPaise;
    const statements = await tx.shopCommissionStatement.findMany({
      where: { shopId: payment.shopId, status: { in: UNPAID_STATEMENT_STATUSES }, amountDuePaise: { gt: 0 } },
      orderBy: [{ periodEnd: 'asc' }, { id: 'asc' }],
    });
    for (const statement of statements) {
      if (remaining <= 0) break;
      const outstanding = statement.amountDuePaise - statement.paidPaise;
      if (outstanding <= 0) continue;
      const take = Math.min(outstanding, remaining);
      const fullyPaid = take === outstanding;
      await tx.shopCommissionStatement.update({
        where: { id: statement.id },
        data: {
          paidPaise: { increment: take },
          ...(fullyPaid ? { status: 'settled', settledAt: now } : {}),
        },
      });
      await tx.shopFeeAllocation.create({
        data: { paymentId: payment.id, statementId: statement.id, amountPaise: take },
      });
      remaining -= take;
    }

    await tx.shopCommissionEntry.create({
      data: {
        shopId: payment.shopId,
        type: 'statement_settlement',
        amountPaise: -payment.amountPaise,
        feePaymentId: payment.id,
        description: `Platform fee payment received (${input.providerPaymentId})`,
      },
    });
    await tx.shopFeePayment.update({
      where: { id: payment.id },
      data: {
        status: 'paid',
        providerPaymentId: input.providerPaymentId,
        paidAt: now,
        unallocatedPaise: remaining,
        failureReason: null,
      },
    });
    await tx.shopFeeEvent.create({
      data: {
        shopId: payment.shopId,
        kind: 'payment_settled',
        metadata: { paymentId: payment.id, amountPaise: payment.amountPaise, source: input.source },
      },
    });
    const block = await evaluateShopFeeBlockTx(tx, payment.shopId, now);
    return { outcome: 'settled' as const, payment, block };
  }, { timeout: 30_000, maxWait: 15_000 });

  if (settled.outcome === 'conflict') {
    logger.error({ providerOrderId: input.providerOrderId }, 'fee_order_paid_by_different_payment');
  }
  if (settled.outcome !== 'settled') return settled.outcome;

  const { payment, block } = settled;
  publishEvent(`shop:${payment.shopId}`, 'fee:update', { kind: 'payment_received' });
  await afterBlockChange(payment.shopId, block);
  await emitFeeNotice({
    shopId: payment.shopId,
    kind: 'payment_received',
    dedupeKey: `payment-${payment.id}`,
    title: 'PrintQs fee payment received',
    body: `We received your PrintQs fee payment of ${formatRupees(payment.amountPaise)} (payment ${input.providerPaymentId}). Thank you — your receipt is in Earnings.`,
  }).catch((error) => logger.error({ error }, 'fee_receipt_notice_failed'));
  return 'settled';
}

/** Mark an attempt failed; the owner can retry on the same order. Paid orders are untouched. */
export async function markFeeAttemptFailed(providerOrderId: string, reason: string): Promise<boolean> {
  const updated = await prisma.shopFeePayment.updateMany({
    where: { providerOrderId, status: { in: ['created', 'attempted'] } },
    data: { status: 'failed', failedAt: new Date(), failureReason: reason.slice(0, 120) },
  });
  return updated.count > 0;
}

/** Mark that the owner opened/submitted Checkout. Never downgrades a paid/failed state. */
async function markAttempted(paymentId: string): Promise<void> {
  await prisma.shopFeePayment.updateMany({ where: { id: paymentId, status: 'created' }, data: { status: 'attempted' } });
}

export type FeeOrderStatus = 'paid' | 'pending' | 'failed';

/**
 * Ask the provider what really happened to one order and settle it if a
 * captured payment of exactly our amount exists. Authorized payments are
 * captured first (accounts without auto-capture).
 */
export async function reconcileFeeOrder(order: ShopFeePayment, now = new Date()): Promise<FeeOrderStatus> {
  if (order.status === 'paid') return 'paid';
  const provider = getFeePaymentProvider();
  if (!provider || provider.name !== order.provider) return 'pending';

  const payments = await provider.fetchOrderPayments(order.providerOrderId);
  await prisma.shopFeePayment.update({ where: { id: order.id }, data: { lastCheckedAt: now } });

  for (const payment of payments) {
    if (payment.orderId !== order.providerOrderId) continue;
    let captured = payment.status === 'captured';
    if (payment.status === 'authorized' && payment.amountPaise === order.amountPaise && payment.currency === order.currency) {
      await provider.capturePayment(payment.id, order.amountPaise);
      captured = true;
    }
    if (!captured) continue;
    const outcome = await settleFeePayment({
      providerOrderId: order.providerOrderId,
      providerPaymentId: payment.id,
      amountPaise: payment.amountPaise,
      currency: payment.currency,
      source: 'reconcile',
    }, now);
    if (outcome === 'settled' || outcome === 'already_paid') return 'paid';
  }
  if (payments.some((p) => p.status === 'failed') && !payments.some((p) => p.status === 'captured' || p.status === 'authorized')) {
    await markFeeAttemptFailed(order.providerOrderId, 'payment_failed');
    return 'failed';
  }
  return 'pending';
}

/**
 * Checkout success callback. The browser callback alone is never trusted: the
 * Razorpay signature of (order_id|payment_id) is verified, then the SERVER
 * re-checks the order with the provider (settling only a captured payment).
 */
export async function verifyFeeCheckout(
  shopId: string,
  input: { orderId: string; paymentId: string; signature: string },
): Promise<{ status: FeeOrderStatus }> {
  const provider = requireProvider();
  // Ownership in the WHERE clause; missing and not-owned are both 404.
  const order = await prisma.shopFeePayment.findFirst({ where: { providerOrderId: input.orderId, shopId } });
  if (!order) throw notFound();
  if (!provider.verifyCheckoutSignature(input.orderId, input.paymentId, input.signature)) {
    throw badRequest('Payment signature could not be verified');
  }
  await markAttempted(order.id);
  const fresh = (await prisma.shopFeePayment.findUnique({ where: { id: order.id } })) ?? order;
  return { status: await reconcileFeeOrder(fresh) };
}

/** Local/dev only: instantly settle the owner's open order. Refused unless the mock provider is active. */
export async function mockPayFeeOrder(shopId: string, paymentId: string): Promise<SettleOutcome> {
  const provider = getFeePaymentProvider();
  if (provider?.name !== 'mock') throw notFound();
  const order = await prisma.shopFeePayment.findFirst({ where: { id: paymentId, shopId } });
  if (!order) throw notFound();
  if (order.status === 'paid') return 'already_paid';
  return settleFeePayment({
    providerOrderId: order.providerOrderId,
    providerPaymentId: `pay_mock${randomUUID().replace(/-/g, '').slice(0, 14)}`,
    amountPaise: order.amountPaise,
    currency: order.currency,
    source: 'mock',
  });
}

/** Periodic job: covers missed webhooks for orders stuck open for 15+ minutes. */
export async function reconcileStuckFeeOrders(now = new Date()): Promise<number> {
  if (!getFeePaymentProvider()) return 0;
  const orders = await prisma.shopFeePayment.findMany({
    where: {
      status: { in: ['created', 'attempted', 'failed', 'expired'] },
      createdAt: {
        lt: new Date(now.getTime() - FEE_RECONCILE_AFTER_MS),
        gt: new Date(now.getTime() - FEE_RECONCILE_MAX_AGE_MS),
      },
      OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: new Date(now.getTime() - FEE_RECONCILE_AFTER_MS) } }],
    },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });
  let settled = 0;
  for (const order of orders) {
    try {
      if ((await reconcileFeeOrder(order, now)) === 'paid') settled += 1;
    } catch (error) {
      logger.warn({ error, paymentId: order.id }, 'fee_reconcile_failed');
    }
  }
  // Open orders past their reuse window are closed for new Checkout attempts.
  await prisma.shopFeePayment.updateMany({
    where: { status: { in: ['created', 'attempted', 'failed'] }, expiresAt: { lt: now } },
    data: { status: 'expired' },
  });
  return settled;
}
