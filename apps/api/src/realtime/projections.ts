import type { Job } from '@prisma/client';
import { getFirestore } from 'firebase-admin/firestore';
import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { getFirebaseAdminApp } from '../providers/firebaseAdmin/index.js';
import { getJobLiveMetrics } from '../modules/queue/engine.js';
import { isCounterCodeAvailable } from '../modules/queue/visibility.js';
import { ACTIVE_QUEUE_STATUSES, type JobStatus } from '@printq/shared';

interface ProjectionDocument {
  set(data: Record<string, unknown>): Promise<unknown>;
}

export interface ProjectionFirestore {
  doc(path: string): ProjectionDocument;
}

export type ProjectionJob = Pick<
  Job,
  'id' | 'shopId' | 'status' | 'assignedPrinterId' | 'updatedAt' | 'nearFrontNotifiedAt'
> & { student: { firebaseUid: string | null } };

/**
 * A queue transition changes every following job's position, not only the
 * transitioned job's. Keep the just-transitioned job (including terminal
 * state) and every currently active job in a stable, de-duplicated delivery
 * set. The caller marks the outbox row complete only after this whole set is
 * written, so a retry repairs a partial Firebase outage.
 */
export function projectionTargets(eventJob: ProjectionJob, activeJobs: ProjectionJob[]): ProjectionJob[] {
  const targets = new Map<string, ProjectionJob>([[eventJob.id, eventJob]]);
  for (const job of activeJobs) targets.set(job.id, job);
  return [...targets.values()];
}

export function projectionPayload(
  job: ProjectionJob,
  metrics: { position: number | null; etaMinutes: number | null },
): { student: Record<string, unknown>; shop: Record<string, unknown> } {
  const counterCodeAvailable = isCounterCodeAvailable(
    job.status as JobStatus,
    metrics.position,
    env.NEAR_FRONT_THRESHOLD,
    job.nearFrontNotifiedAt !== null,
  );
  const timestamp = job.updatedAt.toISOString();
  // Deliberately minimal: no filename/content URL, location proof, phone,
  // price, commission, or financial split enters Firebase.
  return {
    student: {
      jobId: job.id,
      shopId: job.shopId,
      status: job.status,
      position: metrics.position,
      etaMinutes: metrics.etaMinutes,
      counterCodeAvailable,
      updatedAt: timestamp,
    },
    shop: {
      jobId: job.id,
      status: job.status,
      printerId: job.assignedPrinterId,
      position: metrics.position,
      updatedAt: timestamp,
    },
  };
}

export class FirebaseProjectionWriter {
  constructor(private readonly firestore: ProjectionFirestore = getFirestore(getFirebaseAdminApp())) {}

  async write(job: ProjectionJob, metrics: { position: number | null; etaMinutes: number | null }): Promise<void> {
    const payload = projectionPayload(job, metrics);
    const writes: Promise<unknown>[] = [
      this.firestore.doc(`shopProjections/${job.shopId}/jobs/${job.id}`).set(payload.shop),
    ];
    if (job.student.firebaseUid) {
      writes.push(
        this.firestore.doc(`studentProjections/${job.student.firebaseUid}/jobs/${job.id}`).set(payload.student),
      );
    }
    await Promise.all(writes);
  }
}

/**
 * Drains committed events at-least-once. Duplicate Firestore `set` operations
 * overwrite the same document and are safe; PostgreSQL records the delivery
 * outcome and remains sufficient to rebuild every projection.
 */
export async function publishPendingRealtimeProjections(
  limit = 100,
  writer?: FirebaseProjectionWriter,
): Promise<number> {
  if (!env.FIREBASE_PROJECTIONS_ENABLED) return 0;
  const pending = await prisma.realtimeOutbox.findMany({
    where: { publishedAt: null },
    orderBy: { createdAt: 'asc' },
    take: limit,
    include: { job: { include: { student: { select: { firebaseUid: true } } } } },
  });
  const activeWriter = writer ?? new FirebaseProjectionWriter();
  let delivered = 0;

  for (const event of pending) {
    try {
      const activeJobs = await prisma.job.findMany({
        where: {
          shopId: event.job.shopId,
          status: { in: ACTIVE_QUEUE_STATUSES as JobStatus[] },
        },
        include: { student: { select: { firebaseUid: true } } },
        orderBy: { queuedAt: 'asc' },
      });
      for (const job of projectionTargets(event.job, activeJobs)) {
        const metrics = await getJobLiveMetrics(job.id);
        await activeWriter.write(job, metrics);
      }
      const marked = await prisma.realtimeOutbox.updateMany({
        where: { id: event.id, publishedAt: null },
        data: { publishedAt: new Date(), attempts: { increment: 1 }, lastError: null },
      });
      delivered += marked.count;
    } catch (error) {
      await prisma.realtimeOutbox.update({
        where: { id: event.id },
        data: {
          attempts: { increment: 1 },
          lastError: error instanceof Error ? error.message.slice(0, 300) : 'Firebase projection failed',
        },
      }).catch((recordError) => logger.error({ recordError, outboxId: event.id }, 'realtime_outbox_record_failed'));
      logger.error({ error, outboxId: event.id, jobId: event.jobId }, 'realtime_projection_failed');
    }
  }
  return delivered;
}
