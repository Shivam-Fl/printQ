import type { Job } from '@prisma/client';
import type { JobSpecs } from '@printq/shared';
import { prisma } from '../../lib/prisma.js';
import { verifyOtpHash } from '../../lib/otp.js';
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
 * The shop's single OTP input (printQ.md §5.3–5.4). Finds which notified job
 * in this shop the OTP belongs to, verifies it, finalizes printer assignment
 * per the auto-assign setting, and dispatches the print.
 */
export async function releaseByOtp(
  shopId: string,
  otp: string,
  shopUserId: string,
  manualPrinterId?: string,
): Promise<ReleaseResult> {
  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  if (!shop) throw notFound();

  // A shop has at most one notified job per printer — small candidate set.
  const candidates = await prisma.job.findMany({
    where: { shopId, status: 'notified', otpHash: { not: null } },
  });

  let matched: Job | null = null;
  for (const candidate of candidates) {
    if (await verifyOtpHash(candidate.otpHash!, otp)) {
      matched = candidate;
      break;
    }
  }
  if (!matched) throw badRequest('Invalid OTP', 'OTP_INVALID');
  if (matched.otpExpiresAt && matched.otpExpiresAt.getTime() < Date.now()) {
    throw conflict('This OTP has expired');
  }

  const specs = matched.specs as unknown as JobSpecs;

  // Final printer choice. The provisional assignment from queue time is
  // re-validated — printers can go offline/jam while the student walks over.
  let printerId = manualPrinterId ?? null;
  if (!printerId) {
    const { eligible, recommended } = await recommendPrinter(shopId, specs, matched.pagesPerCopy);
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
    // manual override: printer must belong to this shop (no cross-shop IDs)
    const printer = await prisma.printer.findFirst({ where: { id: printerId, shopId } });
    if (!printer) throw badRequest('Unknown printer');
  }

  const updated = await applyTransition(
    matched.id,
    'notified',
    'OTP_VERIFIED',
    { type: 'shop', id: shopUserId },
    { assignedPrinterId: printerId, otpHash: null, claimedByAgentId: null },
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
