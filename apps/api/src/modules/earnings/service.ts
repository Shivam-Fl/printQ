import { Prisma, type ShopPayout } from '@prisma/client';
import { env } from '../../config/env.js';
import { conflict } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { payoutProvider, PayoutProviderError } from '../../providers/payout/index.js';

const PRE_PRINT_STATUSES = [
  'awaiting_arrival',
  'queued',
  'notified',
  'no_show',
  'requeued',
  'otp_verified',
  'printing',
] as const;

/** Credit the private shop ledger exactly once, after physical printing succeeds. */
export async function creditPrintEarning(jobId: string): Promise<void> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { id: true, shopId: true, shopBasePaise: true, status: true, paymentStatus: true },
  });
  if (!job || !['ready_for_pickup', 'completed'].includes(job.status) || job.paymentStatus !== 'paid') return;
  if (job.shopBasePaise <= 0) {
    logger.error({ jobId }, 'shop_earning_missing_base_snapshot');
    return;
  }
  await prisma.shopLedgerEntry.upsert({
    where: { jobId_type: { jobId, type: 'print_earning' } },
    create: {
      shopId: job.shopId,
      jobId,
      type: 'print_earning',
      amountPaise: job.shopBasePaise,
      description: 'Completed print order',
    },
    update: {},
  });
}

/** Repairs a rare crash between print completion and the idempotent ledger credit. */
export async function reconcilePrintEarnings(): Promise<void> {
  const missing = await prisma.job.findMany({
    where: {
      status: { in: ['ready_for_pickup', 'completed'] },
      paymentStatus: 'paid',
      shopBasePaise: { gt: 0 },
      ledgerEntries: { none: { type: 'print_earning' } },
    },
    select: { id: true },
    take: 200,
  });
  await Promise.all(missing.map((job) => creditPrintEarning(job.id)));
}

export async function getShopEarnings(shopId: string) {
  const [available, lifetime, pending, shop, entries, payouts] = await Promise.all([
    prisma.shopLedgerEntry.aggregate({ where: { shopId }, _sum: { amountPaise: true } }),
    prisma.shopLedgerEntry.aggregate({ where: { shopId, type: 'print_earning' }, _sum: { amountPaise: true } }),
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
      select: { id: true, type: true, amountPaise: true, description: true, createdAt: true, jobId: true },
    }),
    prisma.shopPayout.findMany({
      where: { shopId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, amountPaise: true, status: true, provider: true, createdAt: true, paidAt: true, lastError: true },
    }),
  ]);
  if (!shop) throw conflict('Shop not found');
  return {
    availablePaise: available._sum.amountPaise ?? 0,
    pendingPaise: pending._sum.shopBasePaise ?? 0,
    lifetimeEarnedPaise: lifetime._sum.amountPaise ?? 0,
    minimumPayoutPaise: env.MIN_SHOP_PAYOUT_PAISE,
    payoutSchedule: shop.payoutSchedule,
    payoutProvider: payoutProvider.name,
    payoutAccountReady: payoutProvider.name === 'mock' || Boolean(shop.razorpayLinkedAccountId),
    entries,
    payouts,
  };
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
