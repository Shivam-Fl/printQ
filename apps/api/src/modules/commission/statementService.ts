import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { applyPrepaidToStatement } from '../fees/account.js';
import { dueAtFor, feePaymentsEnabled } from '../fees/feeConfig.js';
import { deriveStatementAmounts, hasUnappliedCredit } from './statements.js';

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
 * overlapping amounts when they race. The statement becomes payable: dueAt is
 * frozenAt + FEE_PAYMENT_TERMS_DAYS (left null while fee payments are off, and
 * set when enforcement adopts it), and earlier overpayment is applied to it.
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
        // Include older, unstatemented credits so they reduce a later amount due.
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

    const statement = await tx.shopCommissionStatement.create({
      data: {
        shopId,
        periodStart: period.start,
        periodEnd: period.end,
        ...amounts,
        status: amounts.amountDuePaise === 0 ? 'settled' : 'frozen',
        frozenAt: now,
        dueAt: amounts.amountDuePaise > 0 && feePaymentsEnabled() ? dueAtFor(now) : null,
        settledAt: amounts.amountDuePaise === 0 ? now : null,
        lines: {
          create: entries.map((entry) => ({ entryId: entry.id, amountPaise: entry.amountPaise })),
        },
      },
      include: { lines: true },
    });
    const prepaid = await applyPrepaidToStatement(tx, shopId, statement.id, amounts.amountDuePaise);
    if (prepaid === 0) return statement;
    const fullyPaid = prepaid >= amounts.amountDuePaise;
    return tx.shopCommissionStatement.update({
      where: { id: statement.id },
      data: { paidPaise: prepaid, ...(fullyPaid ? { status: 'settled', settledAt: now } : {}) },
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
 * Idempotent maintenance action. It freezes no empty statements; notices and
 * blocking are handled by the fee maintenance job (modules/fees/enforcement).
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
