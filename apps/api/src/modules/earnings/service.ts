import { Prisma, type ShopPayout } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { conflict } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { payoutProvider, PayoutProviderError } from '../../providers/payout/index.js';
import { paymentProvider } from '../../providers/payment/index.js';

const PRE_PRINT_STATUSES = [
  'awaiting_arrival',
  'queued',
  'notified',
  'no_show',
  'requeued',
  'otp_verified',
  'printing',
] as const;

// Physical printing is final before a human performs binding/stapling. A
// finishing job has already met the only condition for its immutable earning;
// it must not be deferred until pickup or a later manual step.
const POST_PRINT_STATUSES = ['finishing', 'ready_for_pickup', 'completed'] as const;

/** Ledger balance including cash orders whose print has not completed yet. */
export async function getProjectedCashSettlementBalance(shopId: string): Promise<number> {
  const [balance, unsettledCashJobs] = await Promise.all([
    prisma.shopLedgerEntry.aggregate({ where: { shopId }, _sum: { amountPaise: true } }),
    prisma.job.findMany({
      where: {
        shopId,
        paymentProvider: 'cash',
        status: { notIn: ['completed', 'expired', 'cancelled'] },
        ledgerEntries: { none: { type: 'cash_settlement' } },
      },
      select: { shopBasePaise: true, totalPaise: true },
    }),
  ]);
  return (balance._sum.amountPaise ?? 0)
    + unsettledCashJobs.reduce((total, job) => total + job.shopBasePaise - job.totalPaise, 0);
}

export async function canShopAcceptCash(shopId: string): Promise<boolean> {
  return (await getProjectedCashSettlementBalance(shopId)) > -env.MAX_SHOP_CASH_DEBT_PAISE;
}

/** Credit the private shop ledger exactly once, after physical printing succeeds. */
export async function creditPrintEarning(jobId: string): Promise<void> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      shopId: true,
      shopBasePaise: true,
      totalPaise: true,
      status: true,
      paymentStatus: true,
      paymentProvider: true,
    },
  });
  if (!job || !POST_PRINT_STATUSES.includes(job.status as (typeof POST_PRINT_STATUSES)[number]) || job.paymentStatus !== 'paid') return;
  if (job.shopBasePaise <= 0) {
    logger.error({ jobId }, 'shop_earning_missing_base_snapshot');
    return;
  }
  const isCash = job.paymentProvider === 'cash';
  const type = isCash ? 'cash_settlement' : 'print_earning';
  await prisma.shopLedgerEntry.upsert({
    where: { jobId_type: { jobId, type } },
    create: {
      shopId: job.shopId,
      jobId,
      type,
      // For cash, the shop already holds the student's full payment. Only the
      // net difference belongs in PrintQ's payable ledger.
      amountPaise: isCash ? job.shopBasePaise - job.totalPaise : job.shopBasePaise,
      description: isCash
        ? 'Cash order settlement — cash retained by shop'
        : 'Completed online print order',
    },
    update: {},
  });
}

/** Repairs a rare crash between print completion and the idempotent ledger credit. */
export async function reconcilePrintEarnings(): Promise<void> {
  const missing = await prisma.job.findMany({
    where: {
      status: { in: [...POST_PRINT_STATUSES] },
      paymentStatus: 'paid',
      shopBasePaise: { gt: 0 },
      ledgerEntries: { none: { type: { in: ['print_earning', 'cash_settlement'] } } },
    },
    select: { id: true },
    take: 200,
  });
  await Promise.all(missing.map((job) => creditPrintEarning(job.id)));
}

export async function getShopEarnings(shopId: string) {
  const [balance, lifetime, cashCollected, pending, shop, entries, payouts, balancePayments] = await Promise.all([
    prisma.shopLedgerEntry.aggregate({ where: { shopId }, _sum: { amountPaise: true } }),
    prisma.job.aggregate({
      where: { shopId, paymentStatus: 'paid', status: { in: [...POST_PRINT_STATUSES] } },
      _sum: { shopBasePaise: true },
    }),
    prisma.job.aggregate({
      where: {
        shopId,
        paymentProvider: 'cash',
        paymentStatus: 'paid',
        cashCollectedAt: { not: null },
      },
      _sum: { totalPaise: true },
    }),
    prisma.job.aggregate({
      where: { shopId, paymentStatus: 'paid', status: { in: [...PRE_PRINT_STATUSES] } },
      _sum: { shopBasePaise: true },
    }),
    prisma.shop.findUnique({
      where: { id: shopId },
      select: { payoutSchedule: true, razorpayLinkedAccountId: true },
    }),
    prisma.shopLedgerEntry.findMany({
      where: { shopId },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: {
        id: true,
        type: true,
        amountPaise: true,
        description: true,
        createdAt: true,
        jobId: true,
        balancePaymentId: true,
      },
    }),
    prisma.shopPayout.findMany({
      where: { shopId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, amountPaise: true, status: true, provider: true, createdAt: true, paidAt: true, lastError: true },
    }),
    prisma.shopBalancePayment.findMany({
      where: { shopId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, amountPaise: true, status: true, provider: true, createdAt: true, paidAt: true },
    }),
  ]);
  if (!shop) throw conflict('Shop not found');
  const settlementBalancePaise = balance._sum.amountPaise ?? 0;
  return {
    settlementBalancePaise,
    availablePaise: Math.max(0, settlementBalancePaise),
    amountDuePaise: Math.max(0, -settlementBalancePaise),
    pendingPaise: pending._sum.shopBasePaise ?? 0,
    lifetimeEarnedPaise: lifetime._sum.shopBasePaise ?? 0,
    cashCollectedPaise: cashCollected._sum.totalPaise ?? 0,
    minimumPayoutPaise: env.MIN_SHOP_PAYOUT_PAISE,
    payoutSchedule: shop.payoutSchedule,
    payoutProvider: payoutProvider.name,
    balancePaymentProvider: paymentProvider.name,
    payoutAccountReady: payoutProvider.name === 'mock' || Boolean(shop.razorpayLinkedAccountId),
    entries,
    payouts,
    balancePayments,
  };
}

/** Create or reuse an exact payment order for the shop's current amount due. */
export async function createShopBalancePayment(shopId: string, requestedById: string) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Shop" WHERE "id" = ${shopId} FOR UPDATE`;
    const shop = await tx.shop.findUnique({ where: { id: shopId }, select: { id: true } });
    if (!shop) throw conflict('Shop not found');

    const balance = await tx.shopLedgerEntry.aggregate({ where: { shopId }, _sum: { amountPaise: true } });
    const amountPaise = Math.max(0, -(balance._sum.amountPaise ?? 0));
    if (amountPaise <= 0) throw conflict('There is no amount due');

    const existing = await tx.shopBalancePayment.findFirst({
      where: { shopId, status: 'pending', amountPaise },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) {
      return {
        created: false,
        balancePayment: existing,
        checkout: paymentProvider.checkout(existing.providerOrderId, existing.amountPaise, existing.id),
      };
    }

    const id = randomUUID();
    const order = await paymentProvider.createOrder(id, amountPaise, 'shop_balance');
    const balancePayment = await tx.shopBalancePayment.create({
      data: {
        id,
        shopId,
        amountPaise,
        provider: order.provider,
        providerOrderId: order.providerOrderId,
        requestedById,
      },
    });
    return { created: true, balancePayment, checkout: order.checkout };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

/** Credit a captured shop settlement payment exactly once. */
export async function confirmShopBalancePayment(providerOrderId: string, paymentId: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const payment = await tx.shopBalancePayment.findUnique({ where: { providerOrderId } });
    if (!payment) return false;
    if (payment.status === 'paid') return true;
    if (payment.status !== 'pending') return false;

    await tx.$queryRaw`SELECT "id" FROM "Shop" WHERE "id" = ${payment.shopId} FOR UPDATE`;
    await tx.shopBalancePayment.update({
      where: { id: payment.id },
      data: { status: 'paid', paymentId, paidAt: new Date() },
    });
    await tx.shopLedgerEntry.upsert({
      where: { balancePaymentId_type: { balancePaymentId: payment.id, type: 'balance_payment' } },
      create: {
        shopId: payment.shopId,
        balancePaymentId: payment.id,
        type: 'balance_payment',
        amountPaise: payment.amountPaise,
        description: 'Cash-order balance paid to PrintQ',
      },
      update: {},
    });
    return true;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

async function reserveFullBalance(shopId: string, requestedById?: string): Promise<ShopPayout> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Shop" WHERE "id" = ${shopId} FOR UPDATE`;
    const shop = await tx.shop.findUnique({
      where: { id: shopId },
      select: { razorpayLinkedAccountId: true },
    });
    if (!shop) throw conflict('Shop not found');
    if (payoutProvider.name === 'razorpay_route' && !shop.razorpayLinkedAccountId) {
      throw conflict('Complete Razorpay linked-account verification before requesting a payout');
    }
    const balance = await tx.shopLedgerEntry.aggregate({ where: { shopId }, _sum: { amountPaise: true } });
    const amountPaise = balance._sum.amountPaise ?? 0;
    if (amountPaise < env.MIN_SHOP_PAYOUT_PAISE) {
      throw conflict(`Payouts open after your available balance reaches ₹${(env.MIN_SHOP_PAYOUT_PAISE / 100).toFixed(2)}`);
    }
    const payout = await tx.shopPayout.create({
      data: { shopId, amountPaise, status: 'requested', provider: payoutProvider.name, requestedById },
    });
    await tx.shopLedgerEntry.create({
      data: {
        shopId,
        payoutId: payout.id,
        type: 'payout_reserved',
        amountPaise: -amountPaise,
        description: 'Payout reserved',
      },
    });
    return payout;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function processPayout(payoutId: string): Promise<void> {
  const retryBefore = new Date(Date.now() - 5 * 60_000);
  const claimed = await prisma.shopPayout.updateMany({
    where: {
      id: payoutId,
      OR: [
        { status: 'requested' },
        { status: 'processing', lastAttemptAt: { lt: retryBefore } },
        { status: 'processing', lastAttemptAt: null },
      ],
    },
    data: { status: 'processing', attempts: { increment: 1 }, lastAttemptAt: new Date(), lastError: null },
  });
  if (claimed.count === 0) return;

  const payout = await prisma.shopPayout.findUnique({
    where: { id: payoutId },
    include: { shop: { select: { razorpayLinkedAccountId: true } } },
  });
  if (!payout) return;

  try {
    const result = await payoutProvider.send({
      payoutId: payout.id,
      linkedAccountId: payout.shop.razorpayLinkedAccountId,
      amountPaise: payout.amountPaise,
      shopId: payout.shopId,
    });
    await prisma.shopPayout.update({
      where: { id: payout.id },
      data: {
        providerTransferId: result.providerTransferId,
        status: result.status,
        paidAt: result.status === 'paid' ? new Date() : null,
      },
    });
  } catch (error) {
    const providerError = error instanceof PayoutProviderError ? error : new PayoutProviderError('Payout failed', true);
    if (providerError.retryable) {
      await prisma.shopPayout.update({
        where: { id: payout.id },
        data: { lastError: 'Provider confirmation is pending; PrintQ will retry with the same idempotency key.' },
      });
      logger.error({ error, payoutId }, 'payout_retry_pending');
      return;
    }
    await prisma.$transaction([
      prisma.shopPayout.update({ where: { id: payout.id }, data: { status: 'failed', lastError: providerError.message } }),
      prisma.shopLedgerEntry.upsert({
        where: { payoutId_type: { payoutId: payout.id, type: 'payout_released' } },
        create: {
          shopId: payout.shopId,
          payoutId: payout.id,
          type: 'payout_released',
          amountPaise: payout.amountPaise,
          description: 'Failed payout returned to balance',
        },
        update: {},
      }),
    ]);
  }
}

export async function requestShopPayout(shopId: string, requestedById: string): Promise<ShopPayout> {
  const payout = await reserveFullBalance(shopId, requestedById);
  await processPayout(payout.id);
  return (await prisma.shopPayout.findUnique({ where: { id: payout.id } }))!;
}

/** Apply an authenticated Razorpay Route transfer webhook to the private ledger. */
export async function applyPayoutProviderStatus(
  providerTransferId: string,
  status: 'processed' | 'failed' | 'reversed',
  reason?: string,
): Promise<void> {
  const payout = await prisma.shopPayout.findUnique({ where: { providerTransferId } });
  if (!payout) {
    logger.warn({ providerTransferId, status }, 'payout_webhook_for_unknown_transfer');
    return;
  }

  if (status === 'processed') {
    await prisma.shopPayout.updateMany({
      where: { id: payout.id, status: { in: ['requested', 'processing'] } },
      data: { status: 'paid', paidAt: new Date(), lastError: null },
    });
    return;
  }

  if (payout.status === 'failed' || payout.status === 'cancelled') return;
  await prisma.$transaction([
    prisma.shopPayout.update({
      where: { id: payout.id },
      data: {
        status: 'failed',
        paidAt: null,
        lastError: reason?.slice(0, 500) || `Razorpay transfer ${status}`,
      },
    }),
    prisma.shopLedgerEntry.upsert({
      where: { payoutId_type: { payoutId: payout.id, type: 'payout_released' } },
      create: {
        shopId: payout.shopId,
        payoutId: payout.id,
        type: 'payout_released',
        amountPaise: payout.amountPaise,
        description: 'Unsuccessful payout returned to balance',
      },
      update: {},
    }),
  ]);
}

function startOfTodayInIndia(): Date {
  const nowInIndia = new Date(Date.now() + 330 * 60_000);
  return new Date(Date.UTC(nowInIndia.getUTCFullYear(), nowInIndia.getUTCMonth(), nowInIndia.getUTCDate()) - 330 * 60_000);
}

/** Hourly sweep: retry uncertain transfers, then create at most one daily payout per shop. */
export async function runPayoutSweep(): Promise<void> {
  await reconcilePrintEarnings();
  const retryBefore = new Date(Date.now() - 5 * 60_000);
  const retryable = await prisma.shopPayout.findMany({
    where: { OR: [{ status: 'requested' }, { status: 'processing', lastAttemptAt: { lt: retryBefore } }] },
    select: { id: true },
    take: 50,
  });
  for (const payout of retryable) await processPayout(payout.id);

  const shops = await prisma.shop.findMany({ where: { payoutSchedule: 'daily' }, select: { id: true } });
  const today = startOfTodayInIndia();
  for (const shop of shops) {
    const alreadyCreated = await prisma.shopPayout.count({ where: { shopId: shop.id, createdAt: { gte: today } } });
    if (alreadyCreated) continue;
    try {
      const payout = await reserveFullBalance(shop.id);
      await processPayout(payout.id);
    } catch {
      // Below threshold or linked-account onboarding incomplete: try next sweep.
    }
  }
}
