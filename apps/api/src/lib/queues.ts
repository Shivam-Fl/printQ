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
    maxRetriesPerRequest: null,
  };
}

export type TimerJobName = 'noShowCheck' | 'graceExpiry';

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
