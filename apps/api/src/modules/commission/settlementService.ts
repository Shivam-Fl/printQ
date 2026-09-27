import { Prisma } from '@prisma/client';
import { env } from '../../config/env.js';
import { conflict } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';

export interface CapturedRecurringPayment {
  id: string;
  orderId: string;
  amountPaise: number;
  currency: 'INR';
  status: 'captured';
  customerId: string;
}

/** Parse only a signed, actually captured Razorpay payment event. */
export function parseCapturedRecurringPayment(payload: unknown): CapturedRecurringPayment | null {
  if (!payload || typeof payload !== 'object') return null;
  const event = payload as { event?: unknown; payload?: { payment?: { entity?: unknown } } };
  if (event.event !== 'payment.captured') return null;
  const payment = event.payload?.payment?.entity;
  if (!payment || typeof payment !== 'object') throw conflict('Captured payment entity is missing');
  const p = payment as Record<string, unknown>;
  if (
    typeof p.id !== 'string' || !/^pay_[A-Za-z0-9]+$/.test(p.id)
    || typeof p.order_id !== 'string' || !/^order_[A-Za-z0-9]+$/.test(p.order_id)
    || typeof p.amount !== 'number' || !Number.isSafeInteger(p.amount) || p.amount <= 0
    || p.currency !== 'INR' || p.status !== 'captured'
    || typeof p.customer_id !== 'string' || p.customer_id.length === 0
  ) throw conflict('Captured payment fields are invalid');
  return {
    id: p.id,
    orderId: p.order_id,
    amountPaise: p.amount,
    currency: 'INR',
    status: 'captured',
    customerId: p.customer_id,
  };
}

/**
 * Settle a TEST statement exactly once from a signed captured-payment event.
 * Unknown orders and all production events have no money effect. A real-money
 * handler must be separately reviewed and enabled only at the final cutover.
 */
export async function settleTestCapturedRecurringPayment(payment: CapturedRecurringPayment): Promise<boolean> {
  if (env.SHOP_COLLECTION_MODE !== 'test' || env.PRINTQ_ENVIRONMENT === 'production') return false;

  return prisma.$transaction(async (tx) => {
    const candidate = await tx.shopCommissionCollectionAttempt.findUnique({
      where: { providerOrderId: payment.orderId },
      select: { id: true, statementId: true },
    });
    if (!candidate) return false;

    // Serialise concurrent webhook deliveries and settlement reconciliation.
    await tx.$queryRaw`SELECT "id" FROM "ShopCommissionStatement" WHERE "id" = ${candidate.statementId} FOR UPDATE`;
    const attempt = await tx.shopCommissionCollectionAttempt.findUnique({
      where: { id: candidate.id },
      include: { statement: { include: { mandate: true, settlementEntry: true } } },
    });
    if (!attempt || attempt.provider !== 'razorpay_test' || attempt.providerOrderId !== payment.orderId) return false;
    const statement = attempt.statement;
    if (
      !statement.mandate || statement.mandate.environment !== 'test'
      || !statement.mandate.providerCustomerId
      || payment.customerId !== statement.mandate.providerCustomerId
      || payment.amountPaise !== attempt.amountPaise
      || payment.amountPaise !== statement.amountDuePaise
    ) throw conflict('Captured payment does not match the TEST statement and mandate');

    if (attempt.status === 'settled') {
      if (
        attempt.providerCollectionId !== payment.id
        || statement.status !== 'settled'
        || statement.settlementEntry?.amountPaise !== -payment.amountPaise
      ) throw conflict('Statement already settled by a different payment');
      return true;
    }
    if (attempt.status !== 'submitted' || statement.status !== 'debit_pending' || statement.settlementEntry) {
      throw conflict('TEST statement is not awaiting this captured payment');
    }

    await tx.shopCommissionEntry.create({
      data: {
        shopId: statement.shopId,
        type: 'statement_settlement',
        amountPaise: -payment.amountPaise,
        settlementStatementId: statement.id,
        description: 'Razorpay TEST weekly commission statement settlement',
      },
    });
    await tx.shopCommissionCollectionAttempt.update({
      where: { id: attempt.id },
      data: { status: 'settled', providerCollectionId: payment.id, settledAt: new Date() },
    });
    await tx.shopCommissionStatement.update({
      where: { id: statement.id },
      data: { status: 'settled' },
    });
    return true;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
