import type { Job, Prisma } from '@prisma/client';
import { transition, type JobEvent, type JobStatus } from '@printq/shared';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';

export type ActorType = 'student' | 'shop' | 'agent' | 'system';

/**
 * The only sanctioned way to change a job's status. Applies the shared state
 * machine, writes the audit JobEvent, and updates atomically — the WHERE
 * clause includes the expected current status so two concurrent transitions
 * can't both win (optimistic concurrency).
 */
export async function applyTransition(
  jobId: string,
  from: JobStatus,
  event: JobEvent,
  actor: { type: ActorType; id?: string },
  extraData: Prisma.JobUncheckedUpdateInput = {},
): Promise<Job | null> {
  const to = transition(from, event); // throws InvalidTransitionError on bad input

  const result = await prisma.job.updateMany({
    where: { id: jobId, status: from },
    data: { ...extraData, status: to },
  });
  if (result.count === 0) {
    // someone else transitioned first — caller decides whether that matters
    logger.warn({ jobId, from, event }, 'transition_lost_race');
    return null;
  }
  await prisma.jobEvent.create({
    data: {
      jobId,
      fromStatus: from,
      toStatus: to,
      event,
      actorType: actor.type,
      actorId: actor.id ?? null,
    },
  });
  return prisma.job.findUnique({ where: { id: jobId } });
}
