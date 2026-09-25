import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { conflict } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { debitGateReason, deriveStatementAmounts, hasUnappliedCredit, PRE_DEBIT_NOTICE_MS } from './statements.js';

export interface StatementPeriod {
  start: Date;
  end: Date;
}

function assertPeriod(period: StatementPeriod): void {
  if (!Number.isFinite(period.start.getTime()) || !Number.isFinite(period.end.getTime()) || period.end <= period.start) {
    throw new RangeError('Statement period must have a valid increasing start and end');
  }
}

/**
 * Freeze unstatemented immutable commission entries for a weekly period.
 * A shop row lock plus unique period key prevents two workers from freezing
 * overlapping amounts when they race.
 */
export async function freezeWeeklyCommissionStatement(shopId: string, period: StatementPeriod, now = new Date()) {
  assertPeriod(period);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Shop" WHERE "id" = ${shopId} FOR UPDATE`;
    const existing = await tx.shopCommissionStatement.findUnique({
      where: { shopId_periodStart_periodEnd: { shopId, periodStart: period.start, periodEnd: period.end } },
      include: { lines: true },
    });
    if (existing) return existing;

    const entries = await tx.shopCommissionEntry.findMany({
      where: {
        shopId,
        // Include older, unstatemented credits so they reduce a later debit.
        createdAt: { lt: period.end },
        type: { in: ['print_commission', 'refund_credit', 'manual_credit'] },
        statementLines: { none: {} },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, amountPaise: true },
    });
    if (entries.length === 0) return null;
    const amounts = deriveStatementAmounts(entries);
    // A surplus credit must remain available for a future statement.
    if (hasUnappliedCredit(amounts)) return null;
    return tx.shopCommissionStatement.create({
      data: {
        shopId,
        periodStart: period.start,
        periodEnd: period.end,
        ...amounts,
        status: amounts.amountDuePaise === 0 ? 'settled' : 'frozen',
        frozenAt: now,
        lines: {
          create: entries.map((entry) => ({ entryId: entry.id, amountPaise: entry.amountPaise })),
        },
      },
      include: { lines: true },
    });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

/** Last fully completed Monday–Sunday window in India Standard Time. */
export function lastCompletedWeeklyPeriodInIndia(now = new Date()): StatementPeriod {
  const IST_OFFSET_MS = 330 * 60_000;
  const local = new Date(now.getTime() + IST_OFFSET_MS);
  const daysSinceMonday = (local.getUTCDay() + 6) % 7;
  const currentMondayUtc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - daysSinceMonday) - IST_OFFSET_MS;
  const end = new Date(currentMondayUtc);
  return { start: new Date(currentMondayUtc - 7 * 86_400_000), end };
}

/**
 * Idempotent maintenance action. It freezes no empty statements and never
 * sends notices or calls a collection provider.
 */
export async function freezeCompletedWeeklyStatements(now = new Date()): Promise<number> {
  const period = lastCompletedWeeklyPeriodInIndia(now);
  const shops = await prisma.shop.findMany({ select: { id: true }, take: 500 });
  let frozen = 0;
  for (const shop of shops) {
    const statement = await freezeWeeklyCommissionStatement(shop.id, period, now);
    if (statement) frozen += 1;
  }
  return frozen;
}

/**
 * Only call after the required notice has actually been delivered through the
 * configured owner channel. This records the immutable timing gate, not a
 * pretend notification.
 */
export async function recordPreDebitNoticeDelivered(statementId: string, deliveredAt = new Date()) {
  const updated = await prisma.shopCommissionStatement.updateMany({
    where: { id: statementId, status: 'frozen', preDebitNoticeSentAt: null },
    data: {
      status: 'notice_sent',
      preDebitNoticeSentAt: deliveredAt,
      debitNotBefore: new Date(deliveredAt.getTime() + PRE_DEBIT_NOTICE_MS),
    },
  });
  if (updated.count !== 1) throw conflict('Statement is not awaiting its first pre-debit notice');
}

/**
 * Reserve a TEST collection attempt after all mandate and notice gates. This
 * creates no provider call; the Razorpay adapter uses this idempotency key in
 * a later, explicitly configured TEST-only dispatch step.
 */
export async function reserveTestCollectionAttempt(statementId: string, pilotCapPaise: number, now = new Date()) {
  const { env } = await import('../../config/env.js');
  if (env.SHOP_COLLECTION_MODE !== 'test' || env.PRINTQ_ENVIRONMENT === 'production') {
    throw conflict('TEST collection is disabled in this environment');
  }
  return prisma.$transaction(async (tx) => {
    const statement = await tx.shopCommissionStatement.findUnique({
      where: { id: statementId },
      include: { mandate: true },
    });
    if (!statement) throw conflict('Statement not found');
    if (!statement.mandate || statement.mandate.environment !== 'test') {
      throw conflict('A TEST mandate is required before a collection attempt can be reserved');
    }
    const reason = debitGateReason({
      statementStatus: statement.status,
      amountDuePaise: statement.amountDuePaise,
      noticeSentAt: statement.preDebitNoticeSentAt,
      debitNotBefore: statement.debitNotBefore,
      mandateStatus: statement.mandate.status,
      mandateMaxAmountPaise: statement.mandate.maxAmountPaise,
      mandateValidFrom: statement.mandate.validFrom,
      mandateValidUntil: statement.mandate.validUntil,
      mandateTermsAcceptedAt: statement.mandate.cancellationTermsAcceptedAt,
      pilotCapPaise: Math.min(pilotCapPaise, env.SHOP_COLLECTION_PILOT_CAP_PAISE),
      now,
    });
    if (reason) throw conflict(reason);
    const existing = await tx.shopCommissionCollectionAttempt.findFirst({
      where: { statementId, status: { in: ['pending', 'submitted'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) return existing;

    const attempt = await tx.shopCommissionCollectionAttempt.create({
      data: {
        statementId,
        amountPaise: statement.amountDuePaise,
        provider: 'razorpay_test',
        idempotencyKey: randomUUID(),
      },
    });
    await tx.shopCommissionStatement.update({ where: { id: statementId }, data: { status: 'debit_pending' } });
    return attempt;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
