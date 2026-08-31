import { Worker } from 'bullmq';
import { bullConnection, maintenanceQueue } from '../lib/queues.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { publishEvent } from '../realtime/events.js';
import { convertFile, cleanupExpiredFiles } from './conversion.js';
import { expireStalePreparedOrders, handleGraceExpiry, handleNoShowCheck, handleScheduledDue } from '../modules/queue/engine.js';

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
 * Starts all BullMQ workers. Runs inside the API process by default
 * (single-deploy pilot); run dist/worker.js separately to scale out.
 */
export async function startWorkers(): Promise<void> {
  new Worker(
    'convert',
    async (job) => {
      await convertFile((job.data as { fileId: string }).fileId);
    },
    { connection: bullConnection(), concurrency: 2 },
  );

  new Worker(
    'timers',
    async (job) => {
      const { jobId } = job.data as { jobId: string };
      if (job.name === 'noShowCheck') await handleNoShowCheck(jobId);
      else if (job.name === 'graceExpiry') await handleGraceExpiry(jobId);
      else if (job.name === 'scheduledDue') await handleScheduledDue(jobId);
    },
    { connection: bullConnection(), concurrency: 5 },
  );

  new Worker(
    'maintenance',
    async (job) => {
      if (job.name === 'cleanup') {
        await expireStalePreparedOrders();
        await cleanupExpiredFiles();
      }
      else if (job.name === 'staleAgents') await detectStaleAgents();
    },
    { connection: bullConnection(), concurrency: 1 },
  );

  await maintenanceQueue.upsertJobScheduler('cleanup-hourly', { every: 3_600_000 }, { name: 'cleanup' });
  await maintenanceQueue.upsertJobScheduler('stale-agents', { every: 60_000 }, { name: 'staleAgents' });

  logger.info('workers_started');
}
