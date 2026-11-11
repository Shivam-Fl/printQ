import type { Job, PrintCompletionMethod } from '@prisma/client';
import type { JobSpecs } from '@printq/shared';
import { scheduleVerifiedPrintFileDeletion } from '../../lib/fileRetention.js';
import { logger } from '../../lib/logger.js';
import { runInBackground } from '../../lib/background.js';
import { PRINT_ERROR_SPOOL_TIMEOUT } from '../../lib/printProblem.js';
import { prisma } from '../../lib/prisma.js';
import { notifyStudent } from '../../providers/notification/index.js';
import { publishEvent } from '../../realtime/events.js';
import { postVerifiedPrintCommission } from '../commission/service.js';
import { applyTransition, type ActorType } from './transitions.js';

export type PrintConfirmationActor = { type: ActorType; id?: string };

/** A print the printer accepted but nobody confirmed in time: staff may still confirm it. */
export function isLatePrintConfirmable(job: Pick<Job, 'status' | 'printError'>): boolean {
  return job.status === 'otp_verified' && job.printError === PRINT_ERROR_SPOOL_TIMEOUT;
}

/**
 * Commit the one event that means paper was actually produced. The caller has
 * already established either deterministic simulator completion or a staff
 * member's physical inspection. Spool acceptance must use recordSpoolAccepted
 * instead and cannot call this function.
 *
 * Normally the job is `printing`. A print whose spool acknowledgement timed out
 * went back to `otp_verified` with printError = spool_timeout; staff who find the
 * pages in the tray confirm it from there (the guard keeps a concurrent retry or
 * refund from being overwritten).
 */
export async function confirmSuccessfulPrint(
  job: Job,
  actor: PrintConfirmationActor,
  completionMethod: PrintCompletionMethod,
): Promise<{ job: Job; finishingRequired: boolean } | null> {
  const specs = job.specs as unknown as JobSpecs;
  const finishingRequired = Boolean(specs.binding);
  const confirmedAt = new Date();
  const late = isLatePrintConfirmable(job);
  const updated = await applyTransition(
    job.id,
    late ? 'otp_verified' : 'printing',
    finishingRequired ? 'FINISHING_REQUIRED' : 'PRINT_COMPLETED',
    actor,
    {
      printError: null,
      spoolAcceptedAt: job.spoolAcceptedAt ?? confirmedAt,
      printConfirmedAt: confirmedAt,
      printConfirmedById: completionMethod === 'staff_confirmed' ? actor.id ?? null : null,
      printCompletionMethod: completionMethod,
    },
    late ? 'PRINT_CONFIRMED_AFTER_TIMEOUT' : undefined,
    late ? { printError: PRINT_ERROR_SPOOL_TIMEOUT } : undefined,
  );
  if (!updated) return null;

  // Live updates go out FIRST, straight after the committed transition: the
  // student's page and the dashboard must not wait behind file-deletion
  // scheduling, the commission upsert or a (possibly slow) push delivery.
  if (finishingRequired) {
    publishEvent(`student:${job.studentId}`, 'job:update', { jobId: job.id, status: 'finishing' });
    publishEvent(`shop:${job.shopId}`, 'queue:finishing_required', { jobId: job.id, binding: specs.binding });
  } else {
    publishEvent(`student:${job.studentId}`, 'job:update', { jobId: job.id, status: 'ready_for_pickup' });
    publishEvent(`shop:${job.shopId}`, 'queue:job_ready', { jobId: job.id });
  }

  // Everything below is durable-by-reconciliation, so it runs AFTER the response
  // (each step is several database round trips; production RTT is ~230 ms):
  // printConfirmedAt is already committed, and the minute reconciler / the
  // commission reconciler re-derive deletion deadlines and receivables from it
  // if this process dies first. Never extend retention to mask an outage.
  runInBackground('print-confirmed-effects', async () => {
    const deletion = scheduleVerifiedPrintFileDeletion(updated.fileId, confirmedAt).catch((error) => {
      logger.error({ error, fileId: updated.fileId, jobId: updated.id }, 'verified_print_deletion_schedule_failed');
    });
    // A completed physical print, not pickup or a browser click, is the only
    // event that can post the pay-at-shop commission receivable. The idempotent
    // PostgreSQL upsert prevents duplicate simulator callbacks or staff actions
    // from creating a second amount due.
    const commission = postVerifiedPrintCommission(updated.id).catch((error) => {
      logger.error({ error, jobId: updated.id }, 'commission_receivable_post_deferred');
    });
    await Promise.all([deletion, commission]);

    if (finishingRequired) {
      await notifyStudent(job.studentId, {
        title: 'Printing complete — finishing in progress',
        body: 'The shop is completing the requested binding. We’ll tell you when it is ready to collect.',
        url: `/jobs/${job.id}`,
        eventKey: `printing-finished:${job.id}:${confirmedAt.toISOString()}`,
      }).catch((error) => logger.error({ error, jobId: job.id }, 'print_finishing_notification_failed'));
      return;
    }
    await notifyStudent(job.studentId, {
      title: 'Print ready ✓',
      body: 'Collect it at the counter.',
      url: `/jobs/${job.id}`,
      eventKey: `print-ready:${job.id}:${confirmedAt.toISOString()}`,
    }).catch((error) => logger.error({ error, jobId: job.id }, 'print_ready_notification_failed'));
  });
  return { job: updated, finishingRequired };
}

/** Record a driver/spooler acknowledgement without declaring a print successful. */
export async function recordSpoolAccepted(jobId: string): Promise<void> {
  await prisma.job.updateMany({
    where: { id: jobId, status: 'printing', spoolAcceptedAt: null },
    data: { spoolAcceptedAt: new Date(), printError: null },
  });
}
