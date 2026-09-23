import { type JobStatus, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';

const POST_PRINT_STATUSES: readonly JobStatus[] = ['finishing', 'ready_for_pickup', 'completed'];

export interface CommissionSnapshot {
  /** What the shop owes PrintQs for this completed print. */
  commissionPaise: number;
  /** Shop-funded discount when the final counter amount is below the shop base. */
  shopFundedDiscountPaise: number;
}

/**
 * The private price snapshots must always reconcile in integer paise:
 * final student total = shop base + PrintQs commission - shop-funded discount.
 *
 * Coupons can be larger than a markup. Since the shop receives the student's
 * direct counter payment, any amount below its base is a documented shop
 * discount; it cannot create a negative PrintQs receivable.
 */
export function deriveCommissionSnapshot(totalPaise: number, shopBasePaise: number): CommissionSnapshot {
  if (!Number.isInteger(totalPaise) || !Number.isInteger(shopBasePaise) || totalPaise < 0 || shopBasePaise < 0) {
    throw new RangeError('Commission inputs must be non-negative integer paise');
  }
  const net = totalPaise - shopBasePaise;
  return net >= 0
    ? { commissionPaise: net, shopFundedDiscountPaise: 0 }
    : { commissionPaise: 0, shopFundedDiscountPaise: -net };
}

/**
 * Post exactly one immutable commission entry after verified physical output.
 * Spool acknowledgement, pickup and browser interaction cannot call this.
 */
export async function postVerifiedPrintCommission(jobId: string): Promise<void> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      shopId: true,
      totalPaise: true,
      shopBasePaise: true,
      status: true,
      paymentStatus: true,
      paymentProvider: true,
      counterPaymentConfirmedAt: true,
      printConfirmedAt: true,
    },
  });
  if (
    !job
    || job.paymentProvider !== 'pay_at_shop'
    || job.paymentStatus !== 'paid'
    || !job.counterPaymentConfirmedAt
    || !job.printConfirmedAt
    || !POST_PRINT_STATUSES.includes(job.status)
  ) return;

  const snapshot = deriveCommissionSnapshot(job.totalPaise, job.shopBasePaise);
  await prisma.shopCommissionEntry.upsert({
    where: { jobId_type: { jobId, type: 'print_commission' } },
    create: {
      shopId: job.shopId,
      jobId,
      type: 'print_commission',
      amountPaise: snapshot.commissionPaise,
      shopFundedDiscountPaise: snapshot.shopFundedDiscountPaise,
      description: snapshot.shopFundedDiscountPaise > 0
        ? 'Completed print; shop-funded discount recorded below base price'
        : 'Completed print commission receivable',
    },
    update: {},
  });
}

/** Repair a crash between print confirmation and the idempotent ledger post. */
export async function reconcileVerifiedPrintCommissions(): Promise<void> {
  const jobs = await prisma.job.findMany({
    where: {
      paymentProvider: 'pay_at_shop',
      paymentStatus: 'paid',
      counterPaymentConfirmedAt: { not: null },
      printConfirmedAt: { not: null },
      status: { in: [...POST_PRINT_STATUSES] },
      commissionEntries: { none: { type: 'print_commission' } },
    },
    select: { id: true },
    take: 200,
  });
  await Promise.all(jobs.map((job) => postVerifiedPrintCommission(job.id)));
}

/**
 * Read-only balance used by weekly statement creation. Entries are always
 * summed in PostgreSQL under a statement-creation transaction.
 */
export async function getOpenCommissionBalance(shopId: string): Promise<number> {
  const result = await prisma.shopCommissionEntry.aggregate({
    where: { shopId, type: { in: ['print_commission', 'refund_credit', 'manual_credit', 'statement_settlement'] } },
    _sum: { amountPaise: true },
  });
  return result._sum.amountPaise ?? 0;
}

/** Private owner view; it never exposes the shop-base/markup split to students. */
export async function getCommissionOverview(shopId: string) {
  const [balance, entries, statements] = await Promise.all([
    getOpenCommissionBalance(shopId),
    prisma.shopCommissionEntry.findMany({
      where: { shopId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        type: true,
        amountPaise: true,
        shopFundedDiscountPaise: true,
        description: true,
        createdAt: true,
        jobId: true,
      },
    }),
    prisma.shopCommissionStatement.findMany({
      where: { shopId },
      orderBy: { periodEnd: 'desc' },
      take: 12,
      select: {
        id: true,
        periodStart: true,
        periodEnd: true,
        grossCommissionPaise: true,
        creditPaise: true,
        amountDuePaise: true,
        status: true,
        frozenAt: true,
        preDebitNoticeSentAt: true,
        debitNotBefore: true,
      },
    }),
  ]);
  return {
    amountDuePaise: Math.max(0, balance),
    accountCreditPaise: Math.max(0, -balance),
    collectionCadence: 'weekly' as const,
    collectionStatus: 'not_configured' as const,
    entries,
    statements,
  };
}

export const commissionTransactionOptions = {
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
} as const;
