import { randomUUID } from 'node:crypto';
import { Prisma, type Job } from '@prisma/client';
import { transition, type JobEvent, type JobStatus } from '@printq/shared';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';

export type ActorType = 'student' | 'shop' | 'agent' | 'system';

/**
 * Job columns the single-statement fast path may SET, with the SQL type each
 * one needs. Identifiers come ONLY from this constant map (never from input);
 * every value is a bound parameter. Anything else (JSON columns, relations,
 * nested writes, unlisted columns) takes the interactive-transaction path.
 */
type ColumnKind = 'text' | 'int' | 'ts' | { enum: string } | 'increment';
const FAST_COLUMNS: Readonly<Record<string, ColumnKind>> = {
  assignedPrinterId: 'text',
  claimedByAgentId: 'text',
  claimedBySessionId: 'text',
  releaseCodeDigest: 'text',
  releaseCodeEncrypted: 'text',
  releaseCodeGeneratedAt: 'ts',
  printConfirmedById: 'text',
  printError: 'text',
  paymentId: 'text',
  paymentProvider: 'text',
  otpHash: 'text',
  otpCode: 'text',
  absentReason: 'text',
  counterPaymentConfirmedById: 'text',
  counterPaymentReference: 'text',
  counterPaymentAmountPaise: 'int',
  queuedAt: 'ts',
  arrivedAt: 'ts',
  queueLeftAt: 'ts',
  nearFrontNotifiedAt: 'ts',
  revealedAt: 'ts',
  revealDeadlineAt: 'ts',
  arrivingNotifiedAt: 'ts',
  absentAt: 'ts',
  spoolAcceptedAt: 'ts',
  printConfirmedAt: 'ts',
  otpExpiresAt: 'ts',
  cashCollectedAt: 'ts',
  counterPaymentConfirmedAt: 'ts',
  paymentStatus: { enum: 'PaymentStatus' },
  counterPaymentMethod: { enum: 'CounterPaymentMethod' },
  printCompletionMethod: { enum: 'PrintCompletionMethod' },
  checkInCount: 'increment',
  printAttempts: 'increment',
};
/** Columns a guard may compare (all timestamps), with the operators supported. */
const GUARD_TS_COLUMNS = new Set(['revealedAt', 'revealDeadlineAt']);
/** Columns a guard may compare for equality / NULL (value is a string or null). */
const GUARD_TEXT_COLUMNS = new Set(['claimedByAgentId', 'claimedBySessionId']);
const GUARD_NULL_ONLY_COLUMNS = new Set(['spoolAcceptedAt']);

const ident = (column: string) => Prisma.raw(`"${column}"`);

function setClause(column: string, kind: ColumnKind, value: unknown): Prisma.Sql | null {
  if (kind === 'increment') {
    const inc = (value as { increment?: unknown } | null)?.increment;
    return typeof inc === 'number' && Number.isInteger(inc) ? Prisma.sql`${ident(column)} = ${ident(column)} + ${inc}` : null;
  }
  if (value === null) return Prisma.sql`${ident(column)} = NULL`;
  if (kind === 'text') return typeof value === 'string' ? Prisma.sql`${ident(column)} = ${value}` : null;
  if (kind === 'int') return typeof value === 'number' && Number.isInteger(value) ? Prisma.sql`${ident(column)} = ${value}` : null;
  if (kind === 'ts') return value instanceof Date ? Prisma.sql`${ident(column)} = ${value}` : null;
  return typeof value === 'string'
    ? Prisma.sql`${ident(column)} = CAST(${value}::text AS ${Prisma.raw(`"${kind.enum}"`)})`
    : null;
}

/** Translate the few guard shapes callers use; null = unsupported (use the transaction path). */
function guardClauses(guard: Prisma.JobWhereInput | undefined): Prisma.Sql[] | null {
  if (!guard) return [];
  const out: Prisma.Sql[] = [];
  for (const [column, cond] of Object.entries(guard)) {
    if (GUARD_TEXT_COLUMNS.has(column) && (cond === null || typeof cond === 'string')) {
      out.push(cond === null ? Prisma.sql`${ident(column)} IS NULL` : Prisma.sql`${ident(column)} = ${cond}`);
      continue;
    }
    if (GUARD_NULL_ONLY_COLUMNS.has(column) && cond === null) {
      out.push(Prisma.sql`${ident(column)} IS NULL`);
      continue;
    }
    if (!GUARD_TS_COLUMNS.has(column) || cond === null || typeof cond !== 'object' || cond instanceof Date) return null;
    for (const [op, operand] of Object.entries(cond as Record<string, unknown>)) {
      if (op === 'not' && operand === null) out.push(Prisma.sql`${ident(column)} IS NOT NULL`);
      else if (op === 'lte' && operand instanceof Date) out.push(Prisma.sql`${ident(column)} <= ${operand}`);
      else return null;
    }
  }
  return out;
}

function fastPathSql(
  jobId: string,
  from: JobStatus,
  to: JobStatus,
  eventName: string,
  actor: { type: ActorType; id?: string },
  extraData: Prisma.JobUncheckedUpdateInput,
  guard: Prisma.JobWhereInput | undefined,
): Prisma.Sql | null {
  const sets: Prisma.Sql[] = [];
  for (const [column, value] of Object.entries(extraData)) {
    if (value === undefined) continue;
    const kind = FAST_COLUMNS[column];
    const clause = kind ? setClause(column, kind, value) : null;
    if (!clause) return null;
    sets.push(clause);
  }
  const guards = guardClauses(guard);
  if (!guards) return null;
  sets.push(Prisma.sql`"status" = CAST(${to}::text AS "JobStatus")`, Prisma.sql`"updatedAt" = ${new Date()}`);
  const guardSql = guards.length > 0 ? Prisma.sql` AND ${Prisma.join(guards, ' AND ')}` : Prisma.empty;
  // ONE statement: the guarded UPDATE, its audit JobEvent and the realtime
  // outbox row commit atomically (a single statement is its own transaction),
  // so a transition costs one network round trip instead of five.
  return Prisma.sql`
    WITH upd AS (
      UPDATE "Job" SET ${Prisma.join(sets, ', ')}
      WHERE "id" = ${jobId} AND "status" = CAST(${from}::text AS "JobStatus")${guardSql}
      RETURNING *
    ), ev AS (
      INSERT INTO "JobEvent" ("id", "jobId", "fromStatus", "toStatus", "event", "actorType", "actorId")
      SELECT ${randomUUID()}, upd."id", ${from}::text, ${to}::text, ${eventName}::text, ${actor.type}::text, ${actor.id ?? null}::text
      FROM upd
      RETURNING "id"
    ), ob AS (
      INSERT INTO "RealtimeOutbox" ("id", "jobEventId", "jobId")
      SELECT ${randomUUID()}, ev."id", ${jobId}::text FROM ev
      RETURNING "id"
    )
    SELECT upd.* FROM upd`;
}

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

  const fast = fastPathSql(jobId, from, to, auditEvent ?? event, actor, extraData, guard);
  if (fast) {
    const [updated] = await prisma.$queryRaw<Job[]>(fast);
    if (!updated) {
      logger.warn({ jobId, from, event }, 'transition_lost_race');
      return null;
    }
    return updated;
  }

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
