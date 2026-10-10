import type { Job } from '@prisma/client';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import {
  PRINT_ERROR_AGENT_OFFLINE,
  STUDENT_PRINT_PROBLEM_MESSAGE,
  describePrintProblem,
} from '../../lib/printProblem.js';
import { notifyStudent } from '../../providers/notification/index.js';
import { publishEvent } from '../../realtime/events.js';
import { applyTransition, type ActorType } from './transitions.js';

/** Heartbeats arrive every few seconds; staff may act once the computer is clearly silent. */
const STAFF_OFFLINE_AFTER_MS = 45_000;

type AgentLiveness = { status: string; lastHeartbeatAt: Date | null; createdAt: Date } | null;

/**
 * Lease semantics for a `printing` job: the claiming agent (claimedByAgentId)
 * holds the job for as long as it keeps heartbeating. A deleted/revoked agent
 * (row gone) or one silent past the cut-off has lost the lease.
 */
export function agentHoldsLease(agent: AgentLiveness, now: number, silentMs: number): boolean {
  if (!agent) return false;
  const lastSeen = (agent.lastHeartbeatAt ?? agent.createdAt).getTime();
  return now - lastSeen <= silentMs;
}

/** True when staff may treat the print computer as gone (offline, deleted or silent). */
export function agentGoneForStaff(agent: AgentLiveness, now = Date.now()): boolean {
  return !agent || agent.status === 'offline' || !agentHoldsLease(agent, now, STAFF_OFFLINE_AFTER_MS);
}

export async function isPrintOrphaned(job: Pick<Job, 'claimedByAgentId'>, now = Date.now()): Promise<boolean> {
  if (!job.claimedByAgentId) return true;
  const agent = await prisma.agent.findUnique({
    where: { id: job.claimedByAgentId },
    select: { status: true, lastHeartbeatAt: true, createdAt: true },
  });
  return agentGoneForStaff(agent, now);
}

/**
 * Move one orphaned `printing` job to the print-failed state (reason
 * agent_offline) and tell the shop dashboard and the student. Race-safe: the
 * conditional UPDATE only matches while the same agent still holds the job.
 */
export async function markPrintFailedAgentGone(
  job: Pick<Job, 'id' | 'shopId' | 'studentId' | 'claimedByAgentId'>,
  actor: { type: ActorType; id?: string },
): Promise<Job | null> {
  const updated = await applyTransition(
    job.id,
    'printing',
    'PRINT_FAILED',
    actor,
    { claimedByAgentId: null, printError: PRINT_ERROR_AGENT_OFFLINE },
    'print_lease_expired',
    { claimedByAgentId: job.claimedByAgentId },
  );
  if (!updated) return null;
  logger.warn({ jobId: job.id, agentId: job.claimedByAgentId, actor: actor.type }, 'print_lease_expired');
  const problem = describePrintProblem(PRINT_ERROR_AGENT_OFFLINE)!;
  publishEvent(`shop:${job.shopId}`, 'queue:print_failed', { jobId: job.id, code: problem.code, message: problem.message });
  publishEvent(`student:${job.studentId}`, 'job:update', { jobId: job.id, status: 'otp_verified' });
  await notifyStudent(job.studentId, {
    title: 'Print problem at the shop',
    body: STUDENT_PRINT_PROBLEM_MESSAGE,
    url: `/jobs/${job.id}`,
    eventKey: `print-problem:${job.id}:${updated.updatedAt.toISOString()}`,
  }).catch((error) => logger.error({ error, jobId: job.id }, 'print_problem_notification_failed'));
  return updated;
}

/**
 * Maintenance sweep (DB-driven, every <= 30 s): any `printing` job whose agent
 * has been gone for longer than PRINT_LEASE_TIMEOUT_SECONDS goes through the
 * ordinary PRINT_FAILED transition so staff get retry / cancel options. The
 * guard on claimedByAgentId makes a concurrent staff confirmation or a re-claim
 * win over this sweep (it simply loses the race).
 */
export async function failOrphanedPrints(now = new Date()): Promise<number> {
  const leaseMs = env.PRINT_LEASE_TIMEOUT_SECONDS * 1000;
  const printing = await prisma.job.findMany({
    where: { status: 'printing', updatedAt: { lt: new Date(now.getTime() - leaseMs) } },
    take: 200,
  });
  if (printing.length === 0) return 0;

  const agentIds = [...new Set(printing.map((j) => j.claimedByAgentId).filter((id): id is string => Boolean(id)))];
  const agents = agentIds.length
    ? await prisma.agent.findMany({
        where: { id: { in: agentIds } },
        select: { id: true, status: true, lastHeartbeatAt: true, createdAt: true },
      })
    : [];
  const byId = new Map(agents.map((a) => [a.id, a]));

  let failed = 0;
  for (const job of printing) {
    const agent = job.claimedByAgentId ? byId.get(job.claimedByAgentId) ?? null : null;
    if (agentHoldsLease(agent, now.getTime(), leaseMs)) continue;
    if (await markPrintFailedAgentGone(job, { type: 'system' })) failed += 1;
  }
  return failed;
}
