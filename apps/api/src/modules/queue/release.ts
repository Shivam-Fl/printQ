import type { Job } from '@prisma/client';
import type { JobSpecs } from '@printq/shared';
import { prisma } from '../../lib/prisma.js';
import { digestReleaseCode, verifyOtpHash } from '../../lib/otp.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { publishEvent } from '../../realtime/events.js';
import { applyTransition } from '../jobs/transitions.js';
import { dispatchJob, emitQueueUpdate, recommendPrinter } from './engine.js';

export interface ReleaseResult {
  ok: boolean;
  job?: Job;
  /** auto-assign found no eligible printer — dashboard must show manual dropdown */
  requiresManualAssignment?: boolean;
  eligiblePrinters?: { printerId: string; estimatedWaitMinutes: number }[];
}

/**
 * The shop's single counter-code input. It is intentionally independent of
 * advisory queue order: any student physically at the counter can release a
 * paid, print-ready order, even after a missed/removed queue position.
 */
export async function releaseByOtp(
  shopId: string,
  otp: string,
  shopUserId: string,
  manualPrinterId?: string,
): Promise<ReleaseResult> {
  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  if (!shop) throw notFound();

  const digest = digestReleaseCode(shopId, otp);
  let matched: Job | null = await prisma.job.findFirst({
    where: {
      shopId,
      releaseCodeDigest: digest,
      paymentStatus: 'paid',
      status: {
        in: ['awaiting_arrival', 'queued', 'notified', 'no_show', 'otp_verified', 'printing', 'ready_for_pickup'],
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  // Rolling-deploy compatibility for old jobs whose temporary OTP was argon2
  // hashed before stable release codes existed.
  if (!matched) {
    const legacyCandidates = await prisma.job.findMany({
      where: { shopId, status: 'notified', otpHash: { not: null } },
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
  if (matched.status === 'otp_verified' || matched.status === 'printing') {
    throw conflict('This order has already been released to a printer');
  }
  if (matched.status === 'ready_for_pickup') {
    throw conflict('This order is already printed and ready for pickup');
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

  const arrivedAtCounter = matched.status === 'awaiting_arrival' || matched.status === 'no_show';
  const updated = await applyTransition(
    matched.id,
    matched.status,
    matched.releaseCodeDigest ? 'COUNTER_RELEASE' : 'OTP_VERIFIED',
    { type: 'shop', id: shopUserId },
    {
      assignedPrinterId: printerId,
      claimedByAgentId: null,
      printError: null,
      ...(arrivedAtCounter
        ? {
            arrivedAt: new Date(),
            queuedAt: new Date(),
            checkInCount: { increment: 1 },
          }
        : {}),
      // Clear only legacy temporary OTP data. The encrypted stable code stays
      // available to the owning student through pickup.
      otpHash: null,
      otpCode: null,
      otpExpiresAt: null,
    },
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
