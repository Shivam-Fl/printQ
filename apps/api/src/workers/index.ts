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
import { expireReveal, expireStalePreparedOrders, handleGraceExpiry, sweepExpiredReveals, handleNoShowCheck, handleScheduledDue } from '../modules/queue/engine.js';
import { failOrphanedPrints } from '../modules/jobs/printLease.js';
import { reconcileVerifiedPrintCommissions } from '../modules/commission/service.js';
import { freezeCompletedWeeklyStatements } from '../modules/commission/statementService.js';
import { runFeeMaintenance } from '../modules/fees/enforcement.js';
import { reconcileStuckFeeOrders } from '../modules/fees/payments.js';
import { runsConversionWorker, runsMaintenanceWorkers, type WorkerRole } from './roles.js';
import { publishPendingRealtimeProjections } from '../realtime/projections.js';
import { publishPendingFirebaseNotifications } from '../providers/fcm/outbox.js';

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
        else if (job.name === 'revealExpiry') await expireReveal(jobId);
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
          await reconcileVerifiedPrintCommissions();
        }
        else if (job.name === 'fileRetention') {
          await reconcileFileDeletionSchedules();
          await cleanupExpiredFiles();
        }
        else if (job.name === 'staleAgents') {
          await detectStaleAgents();
          await failOrphanedPrints();
        }
        else if (job.name === 'revealExpirySweep') await sweepExpiredReveals();
        else if (job.name === 'weeklyStatements') await freezeCompletedWeeklyStatements();
        else if (job.name === 'feeMaintenance') {
          // Freeze first so a just-ended week is billable and notified in this pass.
          await freezeCompletedWeeklyStatements();
          await runFeeMaintenance();
        }
        else if (job.name === 'feeReconcile') await reconcileStuckFeeOrders();
        else if (job.name === 'firebaseProjections') await publishPendingRealtimeProjections();
        else if (job.name === 'firebaseNotifications') await publishPendingFirebaseNotifications();
      },
      { connection: bullConnection(), concurrency: 1 },
    ));

    await maintenanceQueue.upsertJobScheduler('cleanup-hourly', { every: 3_600_000 }, { name: 'cleanup' });
    // Exact deadlines live in PostgreSQL; this one-minute sweeper repairs
    // scheduler/outage gaps and guarantees no old hourly retention behaviour.
    await maintenanceQueue.upsertJobScheduler('file-retention-minute', { every: 60_000 }, { name: 'fileRetention' });
    // Durable backstop for the per-reveal delayed absent timers (Redis may be
    // memory-only): overdue reveals are expired from PostgreSQL every 10 s.
    await maintenanceQueue.upsertJobScheduler('reveal-expiry-sweep', { every: 10_000 }, { name: 'revealExpirySweep' });
    await maintenanceQueue.upsertJobScheduler('stale-agents', { every: 30_000 }, { name: 'staleAgents' });
    // The unique shop/week constraint makes the hourly trigger safe; it only
    // freezes the prior completed IST week and cannot debit or notify anyone.
    await maintenanceQueue.upsertJobScheduler('weekly-statements', { every: 3_600_000 }, { name: 'weeklyStatements' });
    // Platform-fee cycle: hourly and entirely PostgreSQL-driven (like the
    // sweepers above), so a Redis loss only delays it until the scheduler is
    // re-registered at boot. Notices are deduped by a unique key per
    // statement/threshold; blocks/unblocks are idempotent. The reconcile job
    // settles orders whose webhook was missed.
    await maintenanceQueue.upsertJobScheduler('fee-maintenance-hourly', { every: 3_600_000 }, { name: 'feeMaintenance' });
    await maintenanceQueue.upsertJobScheduler('fee-reconcile', { every: 300_000 }, { name: 'feeReconcile' });
    // Remove the retired daily Route-payout scheduler.
    await maintenanceQueue.removeJobScheduler('payout-sweep').catch(() => undefined);
    // The worker is a no-op until the explicitly isolated Firebase projection
    // target is enabled. Once enabled, it repairs temporary Firebase outages
    // from PostgreSQL's durable transactional outbox.
    await maintenanceQueue.upsertJobScheduler('firebase-projections', { every: 10_000 }, { name: 'firebaseProjections' });
    await maintenanceQueue.upsertJobScheduler('firebase-notifications', { every: 10_000 }, { name: 'firebaseNotifications' });
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
