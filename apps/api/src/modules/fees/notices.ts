import { Prisma } from '@prisma/client';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { emailProvider } from '../../providers/email/index.js';
import { sendPushToShopUsers } from '../../providers/push/index.js';
import { publishEvent } from '../../realtime/events.js';

export type FeeNoticeKind =
  | 'statement_ready'
  | 'reminder'
  | 'final_warning'
  | 'blocked'
  | 'unblocked'
  | 'payment_received';

export interface FeeNoticeInput {
  shopId: string;
  statementId?: string;
  kind: FeeNoticeKind;
  /** Unique per (statement|payment, threshold): the notice is created exactly once. */
  dedupeKey: string;
  title: string;
  body: string;
}

const MAX_DELIVERY_ATTEMPTS = 3;
const EARNINGS_PATH = '/dashboard/earnings';

export const formatRupees = (paise: number): string => `₹${(paise / 100).toLocaleString('en-IN', {
  minimumFractionDigits: paise % 100 === 0 ? 0 : 2,
  maximumFractionDigits: 2,
})}`;

export const formatIstDate = (date: Date): string => date.toLocaleDateString('en-IN', {
  day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
});

/**
 * Record then deliver one notice to the shop's owner(s): in-app (the dashboard
 * banner is derived from live state; a socket nudge refreshes it), email via the
 * configured provider, and Web Push where the owner subscribed. Returns false
 * when this notice was already created (dedupe). Delivery failures never throw.
 */
export async function emitFeeNotice(input: FeeNoticeInput): Promise<boolean> {
  let id: string;
  try {
    const row = await prisma.shopFeeNotice.create({
      data: {
        shopId: input.shopId,
        statementId: input.statementId ?? null,
        kind: input.kind,
        dedupeKey: input.dedupeKey,
        title: input.title,
        body: input.body,
      },
      select: { id: true },
    });
    id = row.id;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return false;
    throw error;
  }
  publishEvent(`shop:${input.shopId}`, 'fee:update', { kind: input.kind });
  await deliverFeeNotice(id);
  return true;
}

async function deliverFeeNotice(noticeId: string): Promise<void> {
  const notice = await prisma.shopFeeNotice.findUnique({ where: { id: noticeId } });
  if (!notice) return;
  const owners = await prisma.shopUser.findMany({
    where: { shopId: notice.shopId, role: 'owner' },
    select: { id: true, email: true },
  });

  let emailStatus = notice.emailStatus;
  if (emailStatus === 'pending' || emailStatus === 'failed') {
    if (owners.length === 0 || emailProvider.name !== 'resend') {
      emailStatus = 'skipped';
    } else {
      const text = `${notice.body}\n\nOpen your PrintQs dashboard: ${env.PUBLIC_WEB_URL}${EARNINGS_PATH}\n\nPrintQs — Shivam Ramkumar Mishra (individual proprietor), trading as PrintQs`;
      const results = await Promise.allSettled(
        owners.map((owner) => emailProvider.send(owner.email, notice.title, text)),
      );
      emailStatus = results.every((r) => r.status === 'fulfilled') ? 'sent' : 'failed';
      if (emailStatus === 'failed') logger.error({ noticeId, kind: notice.kind }, 'fee_notice_email_failed');
    }
  }

  let pushStatus = notice.pushStatus;
  if (pushStatus === 'pending') {
    try {
      const delivered = await sendPushToShopUsers(owners.map((o) => o.id), {
        title: notice.title,
        body: notice.body,
        url: EARNINGS_PATH,
        eventKey: `fee-${notice.dedupeKey}`,
      });
      pushStatus = delivered > 0 ? 'sent' : 'skipped';
    } catch (error) {
      logger.warn({ error, noticeId }, 'fee_notice_push_failed');
      pushStatus = 'skipped';
    }
  }

  await prisma.shopFeeNotice.update({
    where: { id: noticeId },
    data: { emailStatus, pushStatus, attempts: { increment: 1 } },
  });
}

/** Retry only the channels that failed, a bounded number of times. */
export async function retryFailedFeeNotices(now = new Date()): Promise<number> {
  const since = new Date(now.getTime() - 3 * 86_400_000);
  const rows = await prisma.shopFeeNotice.findMany({
    where: { emailStatus: 'failed', attempts: { lt: MAX_DELIVERY_ATTEMPTS }, createdAt: { gt: since } },
    select: { id: true },
    take: 50,
  });
  for (const row of rows) await deliverFeeNotice(row.id);
  return rows.length;
}
