import type { Prisma, PrismaClient } from '@prisma/client';
import { FEE_DUE_SOON_MS, UNPAID_STATEMENT_STATUSES } from './feeConfig.js';

export type FeeDb = Prisma.TransactionClient | PrismaClient;

export type FeeState = 'paid_up' | 'due' | 'overdue' | 'blocked';

export interface FeeStatementView {
  id: string;
  periodStart: Date;
  periodEnd: Date;
  ordersCount: number;
  amountPaise: number;
  paidPaise: number;
  outstandingPaise: number;
  dueAt: Date | null;
  frozenAt: Date | null;
  settledAt: Date | null;
  status: 'paid' | 'unpaid' | 'overdue';
}

export interface FeeAccount {
  /** Exactly what the owner would be asked to pay now. */
  totalDuePaise: number;
  statementsDuePaise: number;
  /** Current-week commission not yet frozen into a statement (net of prepayments). */
  accruedPaise: number;
  /** Earliest due date among unpaid statements. */
  nextDueAt: Date | null;
  state: FeeState;
  /** Banner level for every shop page; null = no banner. */
  banner: 'due_soon' | 'overdue' | 'blocked' | null;
  blockedAt: Date | null;
  statements: FeeStatementView[];
}

/**
 * The single server-side source of truth for "what does this shop owe PrintQs".
 * Every query is scoped by shopId in the WHERE clause.
 */
export async function computeFeeAccount(db: FeeDb, shopId: string, now = new Date()): Promise<FeeAccount> {
  const [shop, unpaid, settled, accrued, prepaid] = await Promise.all([
    db.shop.findUnique({ where: { id: shopId }, select: { feeBlockedAt: true } }),
    db.shopCommissionStatement.findMany({
      where: { shopId, status: { in: UNPAID_STATEMENT_STATUSES }, amountDuePaise: { gt: 0 } },
      orderBy: [{ periodEnd: 'asc' }, { id: 'asc' }],
    }),
    db.shopCommissionStatement.findMany({
      where: { shopId, status: 'settled', amountDuePaise: { gt: 0 } },
      orderBy: { periodEnd: 'desc' },
      take: 12,
    }),
    db.shopCommissionEntry.aggregate({
      where: {
        shopId,
        type: { in: ['print_commission', 'refund_credit', 'manual_credit'] },
        statementLines: { none: {} },
      },
      _sum: { amountPaise: true },
    }),
    db.shopFeePayment.aggregate({ where: { shopId, status: 'paid' }, _sum: { unallocatedPaise: true } }),
  ]);

  const statements = [...unpaid, ...settled];
  const counts = statements.length === 0
    ? []
    : await db.shopCommissionStatementLine.groupBy({
      by: ['statementId'],
      where: { statementId: { in: statements.map((s) => s.id) }, entry: { type: 'print_commission' } },
      _count: { _all: true },
    });
  const orders = new Map(counts.map((c) => [c.statementId, c._count._all]));

  const view = (s: (typeof statements)[number]): FeeStatementView => {
    const outstandingPaise = Math.max(0, s.amountDuePaise - s.paidPaise);
    const isPaid = outstandingPaise === 0;
    const overdue = !isPaid && s.dueAt !== null && s.dueAt <= now;
    return {
      id: s.id,
      periodStart: s.periodStart,
      periodEnd: s.periodEnd,
      ordersCount: orders.get(s.id) ?? 0,
      amountPaise: s.amountDuePaise,
      paidPaise: s.paidPaise,
      outstandingPaise,
      dueAt: s.dueAt,
      frozenAt: s.frozenAt,
      settledAt: s.settledAt,
      status: isPaid ? 'paid' : overdue ? 'overdue' : 'unpaid',
    };
  };
  const views = statements.map(view).sort((a, b) => b.periodEnd.getTime() - a.periodEnd.getTime());

  const statementsDuePaise = views.reduce((sum, s) => sum + s.outstandingPaise, 0);
  const accruedPaise = Math.max(
    0,
    (accrued._sum.amountPaise ?? 0) - (prepaid._sum.unallocatedPaise ?? 0),
  );
  const totalDuePaise = statementsDuePaise + accruedPaise;
  const dueDates = views.filter((s) => s.outstandingPaise > 0 && s.dueAt).map((s) => s.dueAt!.getTime());
  const nextDueAt = dueDates.length ? new Date(Math.min(...dueDates)) : null;
  const overdue = views.some((s) => s.status === 'overdue');
  const blockedAt = shop?.feeBlockedAt ?? null;

  const state: FeeState = blockedAt ? 'blocked' : overdue ? 'overdue' : totalDuePaise > 0 ? 'due' : 'paid_up';
  const dueSoon = statementsDuePaise > 0 && nextDueAt !== null && nextDueAt.getTime() - now.getTime() <= FEE_DUE_SOON_MS;
  const banner = state === 'blocked' ? 'blocked' : state === 'overdue' ? 'overdue' : dueSoon ? 'due_soon' : null;

  return { totalDuePaise, statementsDuePaise, accruedPaise, nextDueAt, state, banner, blockedAt, statements: views };
}

/**
 * Apply earlier overpayment (a payment that also covered accrued commission)
 * to a freshly frozen statement, oldest payment first. Runs inside the freeze
 * transaction, which already holds the shop row lock.
 */
export async function applyPrepaidToStatement(
  tx: Prisma.TransactionClient,
  shopId: string,
  statementId: string,
  amountDuePaise: number,
): Promise<number> {
  let remaining = amountDuePaise;
  if (remaining <= 0) return 0;
  const payments = await tx.shopFeePayment.findMany({
    where: { shopId, status: 'paid', unallocatedPaise: { gt: 0 } },
    orderBy: [{ paidAt: 'asc' }, { id: 'asc' }],
  });
  let applied = 0;
  for (const payment of payments) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, payment.unallocatedPaise);
    await tx.shopFeePayment.update({ where: { id: payment.id }, data: { unallocatedPaise: { decrement: take } } });
    await tx.shopFeeAllocation.create({ data: { paymentId: payment.id, statementId, amountPaise: take } });
    remaining -= take;
    applied += take;
  }
  return applied;
}
