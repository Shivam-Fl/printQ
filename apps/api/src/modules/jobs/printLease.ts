import type { Job, Prisma } from '@prisma/client';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import {
  PRINT_ERROR_AGENT_OFFLINE,
  PRINT_ERROR_AGENT_RESTARTED,
  PRINT_ERROR_CLAIM_TIMEOUT,
  PRINT_ERROR_SPOOL_TIMEOUT,
  STUDENT_PRINT_PROBLEM_MESSAGE,
  describePrintProblem,
} from '../../lib/printProblem.js';
import { notifyStudent } from '../../providers/notification/index.js';
import { publishEvent } from '../../realtime/events.js';
import { applyTransition, type ActorType } from './transitions.js';

/** Heartbeats arrive every few seconds; staff may act once the computer is clearly silent. */
const STAFF_OFFLINE_AFTER_MS = 45_000;
/** A heartbeat computed just before a claim may reach the server just after it. */
const IN_FLIGHT_GRACE_MS = 15_000;

type AgentLiveness = {
  status: string;
  lastHeartbeatAt: Date | null;
  createdAt: Date;
  sessionId?: string | null;
} | null;

type PrintingJob = Pick<Job, 'claimedByAgentId' | 'claimedBySessionId' | 'spoolAcceptedAt' | 'updatedAt'>;

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

/**
 * Why a `printing` job can no longer complete, or null while it still can.
 * Heartbeat age alone is not enough: an agent that RESTARTS keeps the same id
 * and keeps heartbeating, so the claiming process (sessionId) is compared too,
 * and two hard time limits back everything else up even for a healthy agent.
 * `staff` uses the shorter "computer is clearly silent" cut-off.
 */
export function printLostReason(
  job: PrintingJob,
  agent: AgentLiveness,
  now: number,
  mode: 'sweep' | 'staff',
): string | null {
  const spooled = job.spoolAcceptedAt !== null;
  // A different process is running now; the one that held the job is gone.
  if (!spooled && agent && job.claimedBySessionId && agent.sessionId && job.claimedBySessionId !== agent.sessionId) {
    return PRINT_ERROR_AGENT_RESTARTED;
  }
  const jobAgeMs = now - job.updatedAt.getTime();
  const leaseMs = env.PRINT_LEASE_TIMEOUT_SECONDS * 1000;
  const gone = mode === 'staff'
    ? agentGoneForStaff(agent, now)
    : jobAgeMs >= leaseMs && !agentHoldsLease(agent, now, leaseMs);
  if (gone) return PRINT_ERROR_AGENT_OFFLINE;
  if (!spooled && jobAgeMs >= env.PRINT_CLAIM_TIMEOUT_SECONDS * 1000) return PRINT_ERROR_CLAIM_TIMEOUT;
  if (spooled && now - job.spoolAcceptedAt!.getTime() >= env.PRINT_SPOOL_TIMEOUT_SECONDS * 1000) {
    return PRINT_ERROR_SPOOL_TIMEOUT;
  }
  return null;
}

export async function isPrintOrphaned(job: PrintingJob, now = Date.now()): Promise<boolean> {
  if (!job.claimedByAgentId) return true;
  const agent = await prisma.agent.findUnique({
    where: { id: job.claimedByAgentId },
    select: { status: true, lastHeartbeatAt: true, createdAt: true, sessionId: true },
  });
  return printLostReason(job, agent, now, 'staff') !== null;
}

/**
 * Move one lost `printing` job to the print-failed state and tell the shop
 * dashboard and the student. Race-safe: the conditional UPDATE only matches
 * while the same agent still holds the job (and, for a restart, while the
 * spooler has not acknowledged it), so a concurrent staff confirmation, a late
 * spool report or a re-claim wins over this.
 */
export async function markPrintFailedAgentGone(
  job: Pick<Job, 'id' | 'shopId' | 'studentId' | 'claimedByAgentId'>,
  actor: { type: ActorType; id?: string },
  reason: string = PRINT_ERROR_AGENT_OFFLINE,
): Promise<Job | null> {
  const updated = await applyTransition(
    job.id,
    'printing',
    'PRINT_FAILED',
    actor,
    { claimedByAgentId: null, claimedBySessionId: null, printError: reason },
    reason === PRINT_ERROR_AGENT_OFFLINE ? 'print_lease_expired' : `print_${reason}`,
    {
      claimedByAgentId: job.claimedByAgentId,
      ...(reason === PRINT_ERROR_AGENT_RESTARTED ? { spoolAcceptedAt: null } : {}),
    },
  );
  if (!updated) return null;
  logger.warn({ jobId: job.id, agentId: job.claimedByAgentId, actor: actor.type, reason }, 'print_lease_expired');
  const problem = describePrintProblem(reason)!;
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
 * Called when an agent registers (socket connect) or heartbeats with its
 * process sessionId. Any job this agent id claimed that the CURRENT process
 * cannot be working on is failed right away (reason agent_restarted):
 *  - claimed by a different, earlier session (the process was restarted), or
 *  - the agent reports its in-flight job ids (heartbeat `inFlightJobIds`) and
 *    the job is not among them (after a short grace for claim/heartbeat races).
 * Jobs the spooler already acknowledged are left alone: the agent has nothing
 * more to do for them and staff confirm the output.
 */
export async function reconcileAgentSession(
  agent: { id: string },
  sessionId: string,
  inFlightJobIds?: string[],
): Promise<number> {
  const or: Prisma.JobWhereInput[] = [{ claimedBySessionId: { not: sessionId } }];
  if (inFlightJobIds) {
    or.push({ id: { notIn: inFlightJobIds }, updatedAt: { lt: new Date(Date.now() - IN_FLIGHT_GRACE_MS) } });
  }
  const lost = await prisma.job.findMany({
    where: { status: 'printing', claimedByAgentId: agent.id, spoolAcceptedAt: null, OR: or },
    select: { id: true, shopId: true, studentId: true, claimedByAgentId: true },
    take: 50,
  });
  let failed = 0;
  for (const job of lost) {
    if (await markPrintFailedAgentGone(job, { type: 'system' }, PRINT_ERROR_AGENT_RESTARTED)) failed += 1;
  }
  return failed;
}

/**
 * Maintenance sweep (DB-driven, every <= 30 s): fails `printing` jobs that can
 * no longer complete (see printLostReason) through the ordinary PRINT_FAILED
 * transition so staff get retry / cancel options. The guard on claimedByAgentId
 * makes a concurrent staff confirmation or a re-claim win over this sweep.
 */
export async function failOrphanedPrints(now = new Date()): Promise<number> {
  const earliestMs = Math.min(env.PRINT_LEASE_TIMEOUT_SECONDS, env.PRINT_CLAIM_TIMEOUT_SECONDS) * 1000;
  const printing = await prisma.job.findMany({
    where: {
      status: 'printing',
      OR: [
        { updatedAt: { lt: new Date(now.getTime() - earliestMs) } },
        // a restarted agent is recognisable at any age
        { claimedBySessionId: { not: null }, spoolAcceptedAt: null },
      ],
    },
    take: 200,
  });
  if (printing.length === 0) return 0;

  const agentIds = [...new Set(printing.map((j) => j.claimedByAgentId).filter((id): id is string => Boolean(id)))];
  const agents = agentIds.length
    ? await prisma.agent.findMany({
        where: { id: { in: agentIds } },
        select: { id: true, status: true, lastHeartbeatAt: true, createdAt: true, sessionId: true },
      })
    : [];
  const byId = new Map(agents.map((a) => [a.id, a]));

  let failed = 0;
  for (const job of printing) {
    const agent = job.claimedByAgentId ? byId.get(job.claimedByAgentId) ?? null : null;
    const reason = printLostReason(job, agent, now.getTime(), 'sweep');
    if (!reason) continue;
    if (await markPrintFailedAgentGone(job, { type: 'system' }, reason)) failed += 1;
  }
  return failed;
}
