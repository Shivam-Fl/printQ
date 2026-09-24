import type { CounterPaymentMethod, Job } from '@prisma/client';
import type { JobSpecs, JobStatus } from '@printq/shared';
import { prisma } from '../../lib/prisma.js';
import { digestReleaseCode, verifyOtpHash } from '../../lib/otp.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { publishEvent } from '../../realtime/events.js';
import { applyTransition } from '../jobs/transitions.js';
import { dispatchJob, emitQueueUpdate, getJobLiveMetrics, recommendPrinter } from './engine.js';
import { isNormalCounterRelease } from './visibility.js';

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
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { id: true, autoAssignEnabled: true, counterUpiVpa: true, counterUpiVerifiedAt: true },
  });
  if (!shop) throw notFound();

  const digest = digestReleaseCode(shopId, otp);
  let matched: Job | null = await prisma.job.findFirst({
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
  });

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
  }
  if (!matched) throw badRequest('Invalid OTP', 'OTP_INVALID');
  if (!matched.releaseCodeDigest && matched.otpExpiresAt && matched.otpExpiresAt.getTime() < Date.now()) {
    throw conflict('This OTP has expired');
  }
  if (matched.status === 'otp_verified' || matched.status === 'printing' || matched.status === 'finishing') {
    throw conflict('This order has already been released to a printer');
  }
  if (matched.status === 'ready_for_pickup') {
    throw conflict('This order is already printed and ready for pickup');
  }

  const live = await getJobLiveMetrics(matched.id);
  const inNormalReleaseWindow = isNormalCounterRelease(matched.status, live.position);
  if (!inNormalReleaseWindow && !overrideQueue) {
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
  const { eligible, recommended } = await recommendPrinter(shopId, specs, matched.pagesPerCopy, matched.id);
  let printerId = manualPrinterId ?? null;
  if (!printerId) {
    const stillEligible = eligible.some((e) => e.printerId === matched!.assignedPrinterId);
    printerId = stillEligible ? matched.assignedPrinterId : (recommended?.printerId ?? null);

    if (!printerId || (!shop.autoAssignEnabled && !manualPrinterId)) {
      // manual mode always confirms via dropdown; auto mode falls back to it
      // when nothing is eligible (never fail silently — printQ.md §5.4)
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
  if (!updated) throw conflict('Job state changed, try again');

  await dispatchJob(updated, { type: 'shop', id: shopUserId });
  publishEvent(`student:${updated.studentId}`, 'job:update', {
    jobId: updated.id,
    status: updated.status,
  });
  await emitQueueUpdate(shopId);
  return { ok: true, job: updated };
}
