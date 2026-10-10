import { env } from '../config/env.js';
import { conflict } from './errors.js';
import { logger } from './logger.js';
import { prisma } from './prisma.js';
import { fileRetentionQueue } from './queues.js';

/**
 * The policy is intentionally measured from a verified physical print or a
 * terminal cancellation/expiry, not from a browser action, a queue event, or
 * a spool submission. The sweeper runs at least every minute; this timestamp
 * remains the authoritative deadline and is retained as privacy audit data.
 */
export const VERIFIED_PRINT_DELETE_DELAY_MS = 10 * 60_000;
export const TERMINAL_JOB_DELETE_DELAY_MS = 10 * 60_000;

export const fileRetentionDeadline = (now = Date.now()): Date =>
  new Date(now + env.FILE_UNPRINTED_RETENTION_MINUTES * 60_000);

export const verifiedPrintDeletionDeadline = (now = Date.now()): Date =>
  new Date(now + VERIFIED_PRINT_DELETE_DELAY_MS);

export const terminalJobDeletionDeadline = (now = Date.now()): Date =>
  new Date(now + TERMINAL_JOB_DELETE_DELAY_MS);

/**
 * FILE REUSE / REFERENCE-COUNT SEMANTICS
 *
 * One UploadedFile may back several Jobs (a student re-orders the same upload
 * with different options before printing). The file's content is therefore
 * reference counted by its jobs:
 *
 *  - While ANY job referencing the file is still active (these statuses), the
 *    short post-print / post-cancel deletion clock is NOT started: cancelling
 *    or finishing one job never schedules deletion of content another job
 *    still needs. The clock starts when the LAST active job ends.
 *  - A file that already produced a verified physical print is spent. A new
 *    job may not be created on it (the content is deleted ten minutes after
 *    that print); the student uploads the document again for another run.
 *  - A file whose short deletion clock has started cannot back a new job
 *    either; deleting content that a fresh order depends on is worse than
 *    asking for a re-upload.
 *  - The independent 24 h hard maximum (deleteDueFile) also looks at every
 *    job on the file and defers, loudly, if one is still recoverable.
 */
export const ACTIVE_FILE_JOB_STATUSES = [
  'pending_payment',
  'awaiting_arrival',
  'queued',
  'notified',
  'otp_verified',
  'printing',
] as const;

/** True while some job still needs the file's content. */
export async function fileHasActiveJobs(fileId: string): Promise<boolean> {
  return (
    (await prisma.job.count({ where: { fileId, status: { in: [...ACTIVE_FILE_JOB_STATUSES] } } })) > 0
  );
}

/**
 * Throws a clear 409 when a file may not back one more job. Call from job
 * creation, after ownership + readiness have been established.
 */
export async function assertFileCanBackNewJob(file: { id: string; deletionScheduledAt: Date | null }): Promise<void> {
  const printed = await prisma.job.count({
    where: {
      fileId: file.id,
      OR: [
        { printConfirmedAt: { not: null } },
        { status: { in: ['finishing', 'ready_for_pickup', 'completed'] } },
      ],
    },
  });
  if (printed > 0) {
    throw conflict('This file has already been printed. Upload it again to place a new order.');
  }
  if (file.deletionScheduledAt) {
    throw conflict('This file is about to be deleted. Upload it again to place a new order.');
  }
}

/**
 * Schedule only earlier deadlines. A duplicate terminal event can never extend
 * retention, and a stale retry cannot undo a confirmed-print deletion time.
 * Deadlines are only started once no active job still references the file.
 */
async function scheduleEarlierDeletion(fileId: string, deadline: Date, now: Date): Promise<void> {
  if (await fileHasActiveJobs(fileId)) {
    logger.info({ fileId }, 'file_deletion_deferred_active_jobs');
    return;
  }
  const updated = await prisma.uploadedFile.updateMany({
    where: {
      id: fileId,
      status: { not: 'deleted' },
      OR: [{ deleteAfter: null }, { deleteAfter: { gt: deadline } }],
    },
    data: { deleteAfter: deadline, deletionScheduledAt: now, lastDeletionError: null },
  });
  if (updated.count === 0) return;

  await ensureFileDeletionJob(fileId, deadline, now);
}

/** Re-enqueue a durable deadline after a Redis/worker outage. Job IDs are
 * deterministic, so repeated reconciliations do not create duplicate work. */
export async function ensureFileDeletionJob(fileId: string, deadline: Date, now = new Date()): Promise<void> {
  // A queue outage does not erase the PostgreSQL deadline or fail a completed
  // print/cancellation. The minute reconciler will enqueue/retry from that
  // durable row; record the outage without exposing document data.
  await fileRetentionQueue.add(
    'delete',
    { fileId },
    {
      jobId: `delete-${fileId}-${deadline.getTime()}`,
      delay: Math.max(0, deadline.getTime() - now.getTime()),
    },
  ).catch((error) => logger.error({ error, fileId }, 'file_deletion_delayed_job_enqueue_failed'));
}

/**
 * Terminal jobs (cancelled or expired) lose content within ten minutes. This
 * compatibility export replaces the legacy hours-based retention call sites.
 */
export async function scheduleFileDeletion(fileId: string, now = new Date()): Promise<void> {
  await scheduleEarlierDeletion(fileId, terminalJobDeletionDeadline(now.getTime()), now);
}

/** A verified print, including a simulator completion used only outside production. */
export async function scheduleVerifiedPrintFileDeletion(fileId: string, now = new Date()): Promise<void> {
  await scheduleEarlierDeletion(fileId, verifiedPrintDeletionDeadline(now.getTime()), now);
}
