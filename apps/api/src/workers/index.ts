import { Worker } from 'bullmq';
import {
  bullConnection,
  closeQueues,
  fileDeletionDeadLetterQueue,
  maintenanceQueue,
  queueName,
} from '../lib/queues.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { publishEvent } from '../realtime/events.js';
import {
  cleanupExpiredFiles,
  convertFile,
  deleteExpiredFileById,
  reconcileFileDeletionSchedules,
} from './conversion.js';
import { expireStalePreparedOrders, handleGraceExpiry, handleNoShowCheck, handleScheduledDue } from '../modules/queue/engine.js';
import { reconcilePrintEarnings, runPayoutSweep } from '../modules/earnings/service.js';
import { runsConversionWorker, runsMaintenanceWorkers, type WorkerRole } from './roles.js';
import { publishPendingRealtimeProjections } from '../realtime/projections.js';

const STALE_AGENT_MS = 2 * 60_000;

/** Agents that stopped heartbeating are flagged offline and the shop is warned. */
async function detectStaleAgents(): Promise<void> {
  const stale = await prisma.agent.findMany({
    where: { status: 'online', lastHeartbeatAt: { lt: new Date(Date.now() - STALE_AGENT_MS) } },
  });
  for (const agent of stale) {
    await prisma.agent.update({ where: { id: agent.id }, data: { status: 'offline' } });
    publishEvent(`shop:${agent.shopId}`, 'agent:offline', {
      agentId: agent.id,
      machineLabel: agent.machineLabel,
    });
    logger.warn({ agentId: agent.id }, 'agent_stale_marked_offline');
  }
}

/**
 * Starts the selected BullMQ workers. `all` is the local/legacy combined mode;
 * Cloud Run uses independent conversion and maintenance worker pools.
 */
export async function startWorkers(role: WorkerRole = env.WORKER_ROLE): Promise<{ close(): Promise<void> }> {
  const workers: Worker[] = [];

  if (runsConversionWorker(role)) {
    workers.push(new Worker(
      queueName('convert'),
      async (job) => {
        await convertFile((job.data as { fileId: string }).fileId);
      },
      { connection: bullConnection(), concurrency: 2 },
    ));
  }

  if (runsMaintenanceWorkers(role)) {
    workers.push(new Worker(
      queueName('timers'),
      async (job) => {
        const { jobId } = job.data as { jobId: string };
        if (job.name === 'noShowCheck') await handleNoShowCheck(jobId);
        else if (job.name === 'graceExpiry') await handleGraceExpiry(jobId);
        else if (job.name === 'scheduledDue') await handleScheduledDue(jobId);
      },
      { connection: bullConnection(), concurrency: 5 },
    ));

    workers.push(new Worker(
      queueName('file-retention'),
      async (job) => {
        try {
          const result = await deleteExpiredFileById((job.data as { fileId: string }).fileId);
          if (result === 'deleted' || result === 'not_due') return;
          // This can occur only for an unexpectedly active job. Treat it as a
          // retryable privacy incident; the database sweeper remains active too.
          throw new Error('file_deletion_deferred');
        } catch (error) {
          const configuredAttempts = typeof job.opts.attempts === 'number' ? job.opts.attempts : 1;
          if (job.attemptsMade + 1 >= configuredAttempts) {
            await fileDeletionDeadLetterQueue.add(
              'failed',
              { fileId: (job.data as { fileId: string }).fileId, reason: 'file_deletion_failed' },
              { jobId: `dead-letter-${job.id ?? (job.data as { fileId: string }).fileId}` },
            );
          }
          throw error;
        }
      },
      { connection: bullConnection(), concurrency: 1 },
    ));

    workers.push(new Worker(
      queueName('maintenance'),
      async (job) => {
        if (job.name === 'cleanup') {
          await expireStalePreparedOrders();
          await reconcilePrintEarnings();
        }
        else if (job.name === 'fileRetention') {
          await reconcileFileDeletionSchedules();
          await cleanupExpiredFiles();
        }
        else if (job.name === 'staleAgents') await detectStaleAgents();
        else if (job.name === 'payoutSweep') await runPayoutSweep();
        else if (job.name === 'firebaseProjections') await publishPendingRealtimeProjections();
      },
      { connection: bullConnection(), concurrency: 1 },
    ));

    await maintenanceQueue.upsertJobScheduler('cleanup-hourly', { every: 3_600_000 }, { name: 'cleanup' });
    // Exact deadlines live in PostgreSQL; this one-minute sweeper repairs
    // scheduler/outage gaps and guarantees no old hourly retention behaviour.
    await maintenanceQueue.upsertJobScheduler('file-retention-minute', { every: 60_000 }, { name: 'fileRetention' });
    await maintenanceQueue.upsertJobScheduler('stale-agents', { every: 60_000 }, { name: 'staleAgents' });
    await maintenanceQueue.upsertJobScheduler('payout-sweep', { every: 3_600_000 }, { name: 'payoutSweep' });
    // The worker is a no-op until the explicitly isolated Firebase projection
    // target is enabled. Once enabled, it repairs temporary Firebase outages
    // from PostgreSQL's durable transactional outbox.
    await maintenanceQueue.upsertJobScheduler('firebase-projections', { every: 10_000 }, { name: 'firebaseProjections' });
  }

  logger.info({ role }, 'workers_started');
  return {
    async close(): Promise<void> {
      await Promise.allSettled(workers.map((worker) => worker.close()));
      await closeQueues();
      logger.info({ role }, 'workers_stopped');
    },
  };
}
