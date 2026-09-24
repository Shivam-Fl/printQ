import { env } from '../config/env.js';
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
 * Schedule only earlier deadlines. A duplicate terminal event can never extend
 * retention, and a stale retry cannot undo a confirmed-print deletion time.
 */
async function scheduleEarlierDeletion(fileId: string, deadline: Date, now: Date): Promise<void> {
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
