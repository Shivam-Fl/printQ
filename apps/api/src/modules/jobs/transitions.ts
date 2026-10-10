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
  /** Optional immutable audit label when one state transition has extra significance. */
  auditEvent?: string,
  /**
   * Extra conditions evaluated in the SAME conditional UPDATE as the status
   * check (e.g. an absent timer's overdue deadline), so a concurrent change
   * to those fields makes this transition lose instead of overwriting it.
   */
  guard?: Prisma.JobWhereInput,
): Promise<Job | null> {
  const to = transition(from, event); // throws InvalidTransitionError on bad input

  return prisma.$transaction(async (tx) => {
    // One conditional UPDATE ... RETURNING (a single round trip) both enforces
    // the expected status and returns the new row.
    const [updated] = await tx.job.updateManyAndReturn({
      where: { id: jobId, status: from, ...(guard ?? {}) },
      data: { ...(extraData as Prisma.JobUncheckedUpdateManyInput), status: to },
    });
    if (!updated) {
      // someone else transitioned first — caller decides whether that matters
      logger.warn({ jobId, from, event }, 'transition_lost_race');
      return null;
    }
    const jobEvent = await tx.jobEvent.create({
      data: {
        jobId,
        fromStatus: from,
        toStatus: to,
        event: auditEvent ?? event,
        actorType: actor.type,
        actorId: actor.id ?? null,
      },
    });
    // The projection event is committed with the authoritative transition.
    // A Firebase outage therefore delays only a rebuildable view, never loses
    // the state change or makes Firestore a financial/queue authority.
    await tx.realtimeOutbox.create({ data: { jobEventId: jobEvent.id, jobId } });
    return updated;
  });
}
