import type { CounterPaymentMethod, Job, Prisma } from '@prisma/client';
import type { JobSpecs, JobStatus } from '@printq/shared';
import { prisma } from '../../lib/prisma.js';
import { digestReleaseCode, verifyOtpHash } from '../../lib/otp.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { publishEvent } from '../../realtime/events.js';
import { applyTransition } from '../jobs/transitions.js';
import { runInBackground } from '../../lib/background.js';
import { ACTIVE_QUEUE_JOBS, buildShopQueue } from './bands.js';
import { dispatchJob, emitQueueUpdate, liveMetricsFromQueue, rankFromSnapshot } from './engine.js';
import { isNormalCounterRelease } from './visibility.js';

/** What the release decision needs about the shop, loaded in the same statement as the job. */
const RELEASE_SHOP_SELECT = {
  id: true,
  autoAssignEnabled: true,
  counterUpiVpa: true,
  counterUpiVerifiedAt: true,
  counterCapacity: true,
  revealGraceSeconds: true,
  printers: true,
  agents: { where: { status: 'online' as const }, select: { id: true, connectedPrinterIds: true } },
  jobs: ACTIVE_QUEUE_JOBS,
} satisfies Prisma.ShopSelect;
type ReleaseShop = Prisma.ShopGetPayload<{ select: typeof RELEASE_SHOP_SELECT }>;

export interface ReleaseResult {
  ok: boolean;
  job?: Job;
  /** auto-assign found no eligible printer — dashboard must show manual dropdown */
  requiresManualAssignment?: boolean;
  /** paid order exists, but staff must explicitly confirm serving it out of turn */
  requiresQueueOverride?: boolean;
  position?: number | null;
  queueStatus?: string;
  eligiblePrinters?: { printerId: string; estimatedWaitMinutes: number }[];
  /** Pay-at-shop orders stop here until counter staff verifies the full amount. */
  requiresPaymentConfirmation?: boolean;
  counterPaymentAmountPaise?: number;
  selectedPrinterId?: string;
}

/**
 * Counter-code lookup deliberately includes prepared and legacy removed jobs:
 * the advisory queue can never make a paid document unrecoverable at the
 * physical counter. Terminal/in-flight statuses stay in the lookup so staff
 * receive an accurate "already released" result instead of "invalid code".
 */
export const COUNTER_CODE_LOOKUP_STATUSES = [
  'awaiting_arrival',
  'queued',
  'notified',
  'no_show',
  'requeued',
  'otp_verified',
  'printing',
  'finishing',
  'ready_for_pickup',
] as const satisfies readonly JobStatus[];

/** A direct counter release is allowed even when the job has no live position. */
export function isDirectCounterReleaseRecoverable(status: JobStatus): boolean {
  return (['awaiting_arrival', 'queued', 'notified', 'no_show', 'requeued'] as readonly JobStatus[]).includes(status);
}

/**
 * The shop's single counter-code input. It is intentionally independent of
 * advisory queue order: any student physically at the counter can release a
 * prepared, print-ready order, even after a missed/removed queue position.
 */
export async function releaseByOtp(
  shopId: string,
  otp: string,
  shopUserId: string,
  manualPrinterId?: string,
  overrideQueue = false,
  paymentConfirmation?: { method: CounterPaymentMethod; reference?: string },
): Promise<ReleaseResult> {
  const digest = digestReleaseCode(shopId, otp);
  // ONE statement: the matched job plus everything the decision needs about
  // its shop (settings, printers, online agents, the current line) via a JOIN.
  const found = await prisma.job.findFirst({
    where: {
      shopId,
      releaseCodeDigest: digest,
      OR: [
        { paymentStatus: 'paid' },
        { paymentProvider: 'pay_at_shop', paymentStatus: 'counter_due' },
        // Pre-cutover orders may finish safely, but are never used for new work.
        { paymentProvider: 'cash', paymentStatus: 'cash_due' },
      ],
      status: {
        in: [...COUNTER_CODE_LOOKUP_STATUSES],
      },
    },
    orderBy: { createdAt: 'desc' },
    include: { shop: { select: RELEASE_SHOP_SELECT } },
    relationLoadStrategy: 'join',
  });
  let matched: Job | null = null;
  let shop: ReleaseShop | null = null;
  if (found) {
    const { shop: joined, ...row } = found;
    matched = row;
    shop = joined;
  }

  // Rolling-deploy compatibility for old jobs whose temporary OTP was argon2
  // hashed before stable release codes existed.
  if (!matched) {
    const legacyCandidates = await prisma.job.findMany({
      where: { shopId, status: 'notified', paymentStatus: 'paid', otpHash: { not: null } },
    });
    for (const candidate of legacyCandidates) {
      if (await verifyOtpHash(candidate.otpHash!, otp)) {
        matched = candidate;
        break;
      }
    }
    if (matched) shop = await prisma.shop.findUnique({ where: { id: shopId }, select: RELEASE_SHOP_SELECT });
  }
  if (!matched) throw badRequest('Invalid OTP', 'OTP_INVALID');
  if (!shop) throw notFound();
  if (!matched.releaseCodeDigest && matched.otpExpiresAt && matched.otpExpiresAt.getTime() < Date.now()) {
    throw conflict('This OTP has expired');
  }
  if (matched.status === 'otp_verified' || matched.status === 'printing' || matched.status === 'finishing') {
    throw conflict('This order has already been released to a printer');
  }
  if (matched.status === 'ready_for_pickup') {
    throw conflict('This order is already printed and ready for pickup');
  }

  // Counter-code lookup means the student is physically present. When this
  // call cannot finish the release (staff must still confirm payment, a
  // printer, or serving out of turn) disarm the absent timer so the student
  // is not marked absent while staff are mid-flow. A COMPLETING release needs
  // no separate write: its transition changes the status, which the expiry
  // sweeper's guarded UPDATE can never beat (exactly one of them wins).
  const matchedJob = matched;
  const disarmAbsentTimer = async (): Promise<void> => {
    if (matchedJob.status !== 'queued' && matchedJob.status !== 'notified') return;
    if (matchedJob.revealDeadlineAt === null) return;
    const disarmed = await prisma.job.updateMany({
      where: { id: matchedJob.id, shopId, status: { in: ['queued', 'notified'] } },
      data: { revealDeadlineAt: null },
    });
    // Tell the dashboard and the student so the stale countdown disappears.
    if (disarmed.count > 0) runInBackground('release-disarm-fanout', () => emitQueueUpdate(shopId));
  };

  const queue = buildShopQueue(shop, shop.printers, shop.jobs);
  const live = liveMetricsFromQueue(queue, matched.id);
  const inNormalReleaseWindow = isNormalCounterRelease(matched.status, live.band);
  if (!inNormalReleaseWindow && !overrideQueue) {
    await disarmAbsentTimer();
    return {
      ok: false,
      requiresQueueOverride: true,
      position: live.position,
      queueStatus: matched.status,
      job: matched,
    };
  }

  const specs = matched.specs as unknown as JobSpecs;

  // Final printer choice. The provisional assignment from queue time is
  // re-validated — printers can go offline/jam while the student walks over.
  const { eligible, recommended } = rankFromSnapshot(shop.printers, shop.agents, shop.jobs, specs, matched.pagesPerCopy, matched.id);
  let printerId = manualPrinterId ?? null;
  if (!printerId) {
    const stillEligible = eligible.some((e) => e.printerId === matched!.assignedPrinterId);
    printerId = stillEligible ? matched.assignedPrinterId : (recommended?.printerId ?? null);

    if (!printerId || (!shop.autoAssignEnabled && !manualPrinterId)) {
      // manual mode always confirms via dropdown; auto mode falls back to it
      // when nothing is eligible (never fail silently — printQ.md §5.4)
      await disarmAbsentTimer();
      return {
        ok: false,
        requiresManualAssignment: true,
        eligiblePrinters: eligible.map((e) => ({
          printerId: e.printerId,
          estimatedWaitMinutes: e.estimatedWaitMinutes,
        })),
        job: matched,
      };
    }
  } else {
    // Manual choice is still constrained to an online, capability-compatible
    // printer. Owners update the printer profile when they swap paper/finishers.
    if (!eligible.some((entry) => entry.printerId === printerId)) {
      throw badRequest('That printer is offline or cannot produce this job');
    }
  }

  const isCounterDue = matched.paymentProvider === 'pay_at_shop' && matched.paymentStatus === 'counter_due';
  const isLegacyCashDue = matched.paymentProvider === 'cash' && matched.paymentStatus === 'cash_due';
  if ((isCounterDue || isLegacyCashDue) && !paymentConfirmation) {
    await disarmAbsentTimer();
    return {
      ok: false,
      requiresPaymentConfirmation: true,
      counterPaymentAmountPaise: matched.totalPaise,
      selectedPrinterId: printerId,
      job: matched,
    };
  }
  if (paymentConfirmation?.method === 'shop_upi' && (!shop.counterUpiVpa || !shop.counterUpiVerifiedAt)) {
    throw conflict('Verify this shop’s merchant UPI VPA before confirming a UPI counter payment');
  }

  const arrivedAtCounter = ['awaiting_arrival', 'no_show', 'requeued'].includes(matched.status);
  const updated = await applyTransition(
    matched.id,
    matched.status,
    matched.releaseCodeDigest ? 'COUNTER_RELEASE' : 'OTP_VERIFIED',
    { type: 'shop', id: shopUserId },
    {
      assignedPrinterId: printerId,
      claimedByAgentId: null,
      printError: null,
      ...(isCounterDue || isLegacyCashDue
        ? {
            paymentStatus: 'paid',
            paymentId: `counter_${paymentConfirmation!.method}_${matched.id}`,
            cashCollectedAt: paymentConfirmation!.method === 'cash' ? new Date() : null,
            counterPaymentMethod: paymentConfirmation!.method,
            counterPaymentConfirmedAt: new Date(),
            counterPaymentConfirmedById: shopUserId,
            counterPaymentReference: paymentConfirmation!.reference ?? null,
            // The browser supplies no amount. This immutable snapshot is the
            // server-calculated amount staff were required to verify.
            counterPaymentAmountPaise: matched.totalPaise,
          }
        : {}),
      ...(arrivedAtCounter
        ? {
            arrivedAt: new Date(),
            // A counter-code release proves staff have the student in front
            // of them, but it is not a proximity check-in and must never
            // fabricate a physical queue position or consume a check-in.
            queuedAt: null,
            queueLeftAt: new Date(),
          }
        : {}),
      // Clear only legacy temporary OTP data. The encrypted stable code stays
      // available to the owning student through pickup.
      otpHash: null,
      otpCode: null,
      otpExpiresAt: null,
    },
    !inNormalReleaseWindow ? 'COUNTER_QUEUE_OVERRIDE_RELEASE' : undefined,
  );
  if (!updated) {
    // Lost the race (e.g. the absent timer moved the job to awaiting_arrival a
    // moment ago). Re-read so staff get the true state: a recoverable job asks
    // them to confirm serving it out of turn, anything else is a plain conflict.
    const current = await prisma.job.findFirst({ where: { id: matched.id, shopId } });
    if (current && isDirectCounterReleaseRecoverable(current.status as JobStatus) && current.status !== matched.status) {
      return { ok: false, requiresQueueOverride: true, position: null, queueStatus: current.status, job: current };
    }
    throw conflict('Job state changed, try again');
  }

  await dispatchJob(updated, { type: 'shop', id: shopUserId }, shop.agents);
  publishEvent(`student:${updated.studentId}`, 'job:update', {
    jobId: updated.id,
    status: updated.status,
  });
  // Re-syncing the line (frees the counter slot, reveals the next student) is a
  // follow-up: the release is already committed and dispatched.
  runInBackground('release-queue-sync', () => emitQueueUpdate(shopId));
  return { ok: true, job: updated };
}
