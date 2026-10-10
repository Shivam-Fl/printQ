import type { Prisma } from '@prisma/client';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { publishEvent } from '../../realtime/events.js';
import { invalidatePublicCaches } from '../public/cache.js';
import { notifyShopReopened } from '../shops/availability.js';
import { feePaymentsEnabled, blockAtFor, dueAtFor, finalWarningAtFor, reminderAtFor, statementReadyAtFor, UNPAID_STATEMENT_STATUSES } from './feeConfig.js';
import { emitFeeNotice, formatIstDate, formatRupees, retryFailedFeeNotices, type FeeNoticeKind } from './notices.js';

export type BlockChange =
  | { change: 'none' }
  | { change: 'blocked'; statementId: string; outstandingPaise: number; dueAt: Date }
  | { change: 'unblocked' };

/**
 * Decide, inside the caller's transaction (which must hold the shop row lock),
 * whether the shop should be blocked. A shop is blocked when its oldest unpaid
 * statement is past blockAt (= dueAt + FEE_OVERDUE_BLOCK_AFTER_DAYS) and no
 * support override is active. It unblocks as soon as nothing is that overdue,
 * and always when fee payments are switched off (the owner could not pay).
 */
export async function evaluateShopFeeBlockTx(
  tx: Prisma.TransactionClient,
  shopId: string,
  now: Date,
): Promise<BlockChange> {
  const shop = await tx.shop.findUnique({
    where: { id: shopId },
    select: { feeBlockedAt: true, feeBlockOverrideUntil: true },
  });
  if (!shop) return { change: 'none' };

  const unpaid = feePaymentsEnabled()
    ? await tx.shopCommissionStatement.findMany({
      where: { shopId, status: { in: UNPAID_STATEMENT_STATUSES }, amountDuePaise: { gt: 0 }, dueAt: { not: null } },
      orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
    })
    : [];
  const overdue = unpaid.find((s) => s.dueAt && s.amountDuePaise > s.paidPaise && blockAtFor(s.dueAt) <= now);
  const overrideActive = Boolean(shop.feeBlockOverrideUntil && shop.feeBlockOverrideUntil > now);

  if (overdue && !overrideActive && !shop.feeBlockedAt) {
    await tx.shop.update({
      where: { id: shopId },
      data: { feeBlockedAt: now, feeBlockReason: `Statement ${overdue.id} unpaid past its due date` },
    });
    await tx.shopFeeEvent.create({
      data: { shopId, kind: 'blocked', metadata: { statementId: overdue.id, dueAt: overdue.dueAt!.toISOString() } },
    });
    return {
      change: 'blocked',
      statementId: overdue.id,
      outstandingPaise: overdue.amountDuePaise - overdue.paidPaise,
      dueAt: overdue.dueAt!,
    };
  }
  if ((!overdue || overrideActive) && shop.feeBlockedAt) {
    await tx.shop.update({ where: { id: shopId }, data: { feeBlockedAt: null, feeBlockReason: null } });
    await tx.shopFeeEvent.create({
      data: { shopId, kind: 'unblocked', metadata: { reason: overrideActive ? 'override' : 'settled' } },
    });
    return { change: 'unblocked' };
  }
  return { change: 'none' };
}

/** Side effects that must happen only after the block decision is committed. */
export async function afterBlockChange(shopId: string, result: BlockChange): Promise<void> {
  if (result.change === 'none') return;
  invalidatePublicCaches();
  publishEvent(`shop:${shopId}`, 'fee:update', { kind: result.change });
  if (result.change === 'blocked') {
    logger.warn({ shopId, statementId: result.statementId }, 'shop_fee_blocked');
    await emitFeeNotice({
      shopId,
      statementId: result.statementId,
      kind: 'blocked',
      dedupeKey: `stmt-${result.statementId}-blocked`,
      title: 'Your PrintQs shop is temporarily paused',
      body: `Your PrintQs fee of ${formatRupees(result.outstandingPaise)} was due on ${formatIstDate(result.dueAt)}, so new orders are paused. Pay now and your shop reopens right away. Orders already in your queue are unaffected.`,
    });
  } else {
    logger.info({ shopId }, 'shop_fee_unblocked');
    await notifyShopReopened(shopId).catch((error) => logger.warn({ error, shopId }, 'shop_reopen_notify_failed'));
  }
}

/** Evaluate one shop under its row lock, then run post-commit effects. */
export async function evaluateShopFeeBlock(shopId: string, now = new Date()): Promise<BlockChange> {
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Shop" WHERE "id" = ${shopId} FOR UPDATE`;
    return evaluateShopFeeBlockTx(tx, shopId, now);
  });
  await afterBlockChange(shopId, result);
  return result;
}

/** Pick the single most advanced milestone a statement has reached (null once overdue). */
export function milestoneFor(dueAt: Date, now: Date): { kind: FeeNoticeKind; key: string } | null {
  if (now >= blockAtFor(dueAt) || now >= dueAt) return null;
  if (now >= finalWarningAtFor(dueAt)) return { kind: 'final_warning', key: 'final-warning' };
  if (now >= reminderAtFor(dueAt)) return { kind: 'reminder', key: 'reminder' };
  if (now >= statementReadyAtFor(dueAt)) return { kind: 'statement_ready', key: 'ready' };
  return null;
}

function noticeText(kind: FeeNoticeKind, outstandingPaise: number, dueAt: Date): { title: string; body: string } {
  const amount = formatRupees(outstandingPaise);
  const days = env.FEE_PAYMENT_TERMS_DAYS;
  if (kind === 'final_warning') {
    return {
      title: 'Your PrintQs shop will be paused tomorrow',
      body: `Your PrintQs fee of ${amount} is due by ${formatIstDate(dueAt)}. Pay today to keep accepting new orders — your shop will be paused tomorrow if it is still unpaid.`,
    };
  }
  if (kind === 'reminder') {
    return {
      title: 'Reminder: PrintQs fee due soon',
      body: `Your PrintQs fee of ${amount} is still unpaid. Please pay by ${formatIstDate(dueAt)} to avoid a temporary pause on new orders.`,
    };
  }
  return {
    title: `Your weekly PrintQs fee ${amount} is ready`,
    body: `Your weekly PrintQs fee ${amount} is ready — pay within ${days} days (by ${formatIstDate(dueAt)}).`,
  };
}

export interface FeeMaintenanceResult {
  adopted: number;
  noticesSent: number;
  blocked: number;
  unblocked: number;
}

/**
 * Hourly, DB-driven (survives Redis loss exactly like the queue sweepers):
 *  1. adopt statements frozen while fee payments were off (dueAt = now + terms),
 *  2. apply / clear blocks,
 *  3. send each statement's next milestone notice at most once,
 *  4. retry failed email deliveries.
 * Statement freezing itself is the separate weekly job.
 */
export async function runFeeMaintenance(now = new Date()): Promise<FeeMaintenanceResult> {
  const result: FeeMaintenanceResult = { adopted: 0, noticesSent: 0, blocked: 0, unblocked: 0 };

  if (feePaymentsEnabled()) {
    const adopted = await prisma.shopCommissionStatement.updateMany({
      where: { status: { in: UNPAID_STATEMENT_STATUSES }, amountDuePaise: { gt: 0 }, dueAt: null },
      data: { dueAt: dueAtFor(now) },
    });
    result.adopted = adopted.count;
  }

  const shops = await prisma.shop.findMany({
    where: {
      OR: [
        { feeBlockedAt: { not: null } },
        { commissionStatements: { some: { status: { in: UNPAID_STATEMENT_STATUSES }, amountDuePaise: { gt: 0 } } } },
      ],
    },
    select: { id: true },
    take: 1_000,
  });
  for (const shop of shops) {
    try {
      const change = await evaluateShopFeeBlock(shop.id, now);
      if (change.change === 'blocked') result.blocked += 1;
      if (change.change === 'unblocked') result.unblocked += 1;
    } catch (error) {
      logger.error({ error, shopId: shop.id }, 'fee_block_evaluation_failed');
    }
  }

  if (feePaymentsEnabled()) {
    const statements = await prisma.shopCommissionStatement.findMany({
      where: { status: { in: UNPAID_STATEMENT_STATUSES }, amountDuePaise: { gt: 0 }, dueAt: { not: null } },
      take: 2_000,
    });
    for (const statement of statements) {
      if (!statement.dueAt || statement.amountDuePaise <= statement.paidPaise) continue;
      const milestone = milestoneFor(statement.dueAt, now);
      if (!milestone) continue;
      const outstanding = statement.amountDuePaise - statement.paidPaise;
      try {
        const sent = await emitFeeNotice({
          shopId: statement.shopId,
          statementId: statement.id,
          kind: milestone.kind,
          dedupeKey: `stmt-${statement.id}-${milestone.key}`,
          ...noticeText(milestone.kind, outstanding, statement.dueAt),
        });
        if (sent) result.noticesSent += 1;
      } catch (error) {
        logger.error({ error, statementId: statement.id }, 'fee_notice_failed');
      }
    }
    await retryFailedFeeNotices(now);
  }
  return result;
}
