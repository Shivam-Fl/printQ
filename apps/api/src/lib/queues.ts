import { Queue } from 'bullmq';
import { env } from '../config/env.js';

/**
 * BullMQ connections are passed as plain options (not shared ioredis
 * instances): avoids type clashes with BullMQ's bundled ioredis and satisfies
 * its maxRetriesPerRequest: null requirement.
 */
export function bullConnection() {
  const url = new URL(env.REDIS_URL);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password || undefined,
    db: url.pathname && url.pathname !== '/' ? Number(url.pathname.slice(1)) : 0,
    tls: url.protocol === 'rediss:' ? {} : undefined,
    // Unit tests import queue-owning modules without enqueueing work. Delay
    // the socket until an operation actually needs Redis, while workers and
    // E2E still connect immediately on their first real queue operation.
    lazyConnect: true,
    maxRetriesPerRequest: null,
  };
}

export type TimerJobName = 'noShowCheck' | 'graceExpiry' | 'scheduledDue';

/** File conversion (upload → print-ready PDF). */
export const convertQueue = new Queue<{ fileId: string }>('convert', {
  connection: bullConnection(),
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  },
});

/** Delayed timers: OTP-window expiry and no-show grace expiry. */
export const timersQueue = new Queue<{ jobId: string }, void, TimerJobName>('timers', {
  connection: bullConnection(),
  defaultJobOptions: { attempts: 3, removeOnComplete: 1000, removeOnFail: 5000 },
});

/** Hourly maintenance (file retention cleanup, stale-agent detection). */
export const maintenanceQueue = new Queue('maintenance', {
  connection: bullConnection(),
  defaultJobOptions: { removeOnComplete: 100, removeOnFail: 100 },
});

/** Exact T+10m object deletion jobs. PostgreSQL's deleteAfter remains the
 * authority; this queue gives normal cases a prompt execution path while the
 * minute sweeper repairs Redis/worker outages. */
export const fileRetentionQueue = new Queue<{ fileId: string }>('file-retention', {
  connection: bullConnection(),
  defaultJobOptions: {
    attempts: 10,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  },
});

/** Failed terminal deletion jobs are retained here for operational alerting and
 * investigation; no document content or object key is included in the payload. */
export const fileDeletionDeadLetterQueue = new Queue<{ fileId: string; reason: string }>('file-retention-dlq', {
  connection: bullConnection(),
  defaultJobOptions: { removeOnComplete: 100, removeOnFail: 5000 },
});

/** Close BullMQ connections explicitly so CI/test workers cannot leak handles. */
export async function closeQueues(): Promise<void> {
  await Promise.allSettled([
    convertQueue.close(),
    timersQueue.close(),
    maintenanceQueue.close(),
    fileRetentionQueue.close(),
    fileDeletionDeadLetterQueue.close(),
  ]);
}
