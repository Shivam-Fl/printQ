import type { Job, PrintCompletionMethod } from '@prisma/client';
import type { JobSpecs } from '@printq/shared';
import { scheduleVerifiedPrintFileDeletion } from '../../lib/fileRetention.js';
import { logger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { notifyStudent } from '../../providers/notification/index.js';
import { publishEvent } from '../../realtime/events.js';
import { creditPrintEarning } from '../earnings/service.js';
import { applyTransition, type ActorType } from './transitions.js';

export type PrintConfirmationActor = { type: ActorType; id?: string };

/**
 * Commit the one event that means paper was actually produced. The caller has
 * already established either deterministic simulator completion or a staff
 * member's physical inspection. Spool acceptance must use recordSpoolAccepted
 * instead and cannot call this function.
 */
export async function confirmSuccessfulPrint(
  job: Job,
  actor: PrintConfirmationActor,
  completionMethod: PrintCompletionMethod,
): Promise<{ job: Job; finishingRequired: boolean } | null> {
  const specs = job.specs as unknown as JobSpecs;
  const finishingRequired = Boolean(specs.binding);
  const confirmedAt = new Date();
  const updated = await applyTransition(
    job.id,
    'printing',
    finishingRequired ? 'FINISHING_REQUIRED' : 'PRINT_COMPLETED',
    actor,
    {
      printError: null,
      spoolAcceptedAt: job.spoolAcceptedAt ?? confirmedAt,
      printConfirmedAt: confirmedAt,
      printConfirmedById: completionMethod === 'staff_confirmed' ? actor.id ?? null : null,
      printCompletionMethod: completionMethod,
    },
  );
  if (!updated) return null;

  // The timestamp is in PostgreSQL before scheduling work begins. If Redis or
  // storage orchestration is temporarily unavailable, the minute reconciler
  // finds printConfirmedAt and schedules the same earlier deadline; never
  // extend retention to mask that outage.
  await scheduleVerifiedPrintFileDeletion(updated.fileId, confirmedAt).catch((error) => {
    logger.error({ error, fileId: updated.fileId, jobId: updated.id }, 'verified_print_deletion_schedule_failed');
  });

  // A completed physical print, not pickup or a browser click, is the legacy
  // earning event. The idempotent ledger upsert prevents a duplicate simulator
  // callback or repeated staff action from posting twice.
  await creditPrintEarning(updated.id).catch((error) => {
    logger.error({ error, jobId: updated.id }, 'shop_earning_credit_deferred');
  });

  if (finishingRequired) {
    await notifyStudent(job.studentId, {
      title: 'Printing complete — finishing in progress',
      body: 'The shop is completing the requested binding. We’ll tell you when it is ready to collect.',
      url: `/jobs/${job.id}`,
      eventKey: `printing-finished:${job.id}:${confirmedAt.toISOString()}`,
    }).catch((error) => logger.error({ error, jobId: job.id }, 'print_finishing_notification_failed'));
    publishEvent(`student:${job.studentId}`, 'job:update', { jobId: job.id, status: 'finishing' });
    publishEvent(`shop:${job.shopId}`, 'queue:finishing_required', { jobId: job.id, binding: specs.binding });
    return { job: updated, finishingRequired: true };
  }

  await notifyStudent(job.studentId, {
    title: 'Print ready ✓',
    body: 'Collect it at the counter.',
    url: `/jobs/${job.id}`,
    eventKey: `print-ready:${job.id}:${confirmedAt.toISOString()}`,
  }).catch((error) => logger.error({ error, jobId: job.id }, 'print_ready_notification_failed'));
  publishEvent(`student:${job.studentId}`, 'job:update', { jobId: job.id, status: 'ready_for_pickup' });
  publishEvent(`shop:${job.shopId}`, 'queue:job_ready', { jobId: job.id });
  return { job: updated, finishingRequired: false };
}

/** Record a driver/spooler acknowledgement without declaring a print successful. */
export async function recordSpoolAccepted(jobId: string): Promise<void> {
  await prisma.job.updateMany({
    where: { id: jobId, status: 'printing', spoolAcceptedAt: null },
    data: { spoolAcceptedAt: new Date(), printError: null },
  });
}
