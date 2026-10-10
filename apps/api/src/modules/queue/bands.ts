import { Prisma, type Job, type Printer } from '@prisma/client';
import {
  ACTIVE_QUEUE_STATUSES,
  assignBands,
  COUNTER_CAPACITY_MIN,
  type JobSpecs,
  type JobStatus,
  type QueueBand,
} from '@printq/shared';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { timersQueue } from '../../lib/queues.js';
import { notifyStudent } from '../../providers/notification/index.js';
import { runInBackground } from '../../lib/background.js';
import { env } from '../../config/env.js';

type Db = typeof prisma | Prisma.TransactionClient;

export interface QueueEntry {
  job: Job & { student: { id: string; name: string | null } };
  /** 1-based position among the shop's active checked-in jobs. */
  position: number;
  band: QueueBand;
  etaMinutes: number | null;
}

export interface ShopQueue {
  counterCapacity: number;
  revealGraceSeconds: number;
  printers: Printer[];
  entries: QueueEntry[];
}

export type QueueJob = Job & { student: { id: string; name: string | null } };

/** Prisma include/select fragment shared by every queue read: active jobs in line order. */
export const ACTIVE_QUEUE_JOBS = {
  where: { status: { in: ACTIVE_QUEUE_STATUSES as JobStatus[] } },
  orderBy: [{ queuedAt: 'asc' }, { createdAt: 'asc' }],
  include: { student: { select: { id: true, name: true } } },
} satisfies Prisma.Shop$jobsArgs;

/** Pure: bands, positions and ETAs from jobs already in line order. No I/O. */
export function buildShopQueue(
  settings: { counterCapacity: number; revealGraceSeconds: number } | null,
  printers: Printer[],
  jobs: QueueJob[],
): ShopQueue {
  const counterCapacity = settings?.counterCapacity ?? 5;
  const bands = assignBands(jobs.map((j) => ({ id: j.id, revealed: j.revealedAt !== null })), counterCapacity);
  const ppm = new Map(printers.map((p) => [p.id, Math.max(p.avgPagesPerMinute, 1)]));
  const pagesAheadByPrinter = new Map<string, number>();
  const entries = jobs.map((job, index): QueueEntry => {
    const pid = job.assignedPrinterId;
    const pagesAhead = pid ? (pagesAheadByPrinter.get(pid) ?? 0) : 0;
    if (pid) pagesAheadByPrinter.set(pid, pagesAhead + job.pagesPerCopy * (job.specs as unknown as JobSpecs).copies);
    return {
      job,
      position: index + 1,
      band: bands.get(job.id)!,
      etaMinutes: pid ? Math.ceil(pagesAhead / (ppm.get(pid) ?? 15)) : null,
    };
  });
  return { counterCapacity, revealGraceSeconds: settings?.revealGraceSeconds ?? 60, printers, entries };
}

/** Same line order the database query uses (queuedAt asc, nulls last, then createdAt). */
export function sortQueueJobs(jobs: QueueJob[]): QueueJob[] {
  const at = (d: Date | null) => (d === null ? Number.POSITIVE_INFINITY : d.getTime());
  return [...jobs].sort((x, y) => at(x.queuedAt) - at(y.queuedAt) || x.createdAt.getTime() - y.createdAt.getTime());
}

/** Active, checked-in jobs in queue order, with each job's band and ETA. */
export async function loadShopQueue(
  db: Db,
  shopId: string,
  /**
   * Shop settings + printers already read moments ago. Inside an interactive
   * transaction parallel reads are serialised on one connection, so the locked
   * pass re-reads only the jobs (the part that must be consistent).
   */
  known?: Pick<ShopQueue, 'counterCapacity' | 'revealGraceSeconds' | 'printers'>,
): Promise<ShopQueue> {
  if (known) {
    const jobs = await db.job.findMany({
      where: { shopId, status: { in: ACTIVE_QUEUE_STATUSES as JobStatus[] } },
      orderBy: [{ queuedAt: 'asc' }, { createdAt: 'asc' }],
      include: { student: { select: { id: true, name: true } } },
    });
    return buildShopQueue(known, known.printers, jobs);
  }
  // ONE statement: shop settings, printers and the active jobs via a JOIN
  // (each separate query is a full network round trip in production).
  const shop = await db.shop.findUnique({
    where: { id: shopId },
    select: {
      counterCapacity: true,
      revealGraceSeconds: true,
      printers: true,
      jobs: ACTIVE_QUEUE_JOBS,
    },
    relationLoadStrategy: 'join',
  });
  return buildShopQueue(shop, shop?.printers ?? [], shop?.jobs ?? []);
}

export interface RevealEvent { jobId: string; studentId: string; revealedAtMs: number; graceSeconds: number }
export interface ArrivingEvent { jobId: string; studentId: string; checkInCount: number }
export interface ReconciledQueue {
  /** Fresh queue as of this reconcile; reveals this pass won are already patched in. */
  queue: ShopQueue;
  /**
   * Settles when the reveal timers and "your turn"/"coming up" notifications of
   * the pass that produced `queue` have been sent. The pass starts them itself,
   * exactly once, in the background; request handlers must NOT await this,
   * batch/sweeper callers may. Never rejects.
   */
  dispatched: Promise<void>;
  count: number;
}

/** What one locked pass won: rows it newly revealed / newly flagged "coming up". */
export interface RevealPass {
  reveals: (RevealEvent & { revealedAt: Date; revealDeadlineAt: Date | null })[];
  arrivals: (ArrivingEvent & { arrivingNotifiedAt: Date })[];
  /** Settles when this pass's timers + notifications were sent (started by the pass itself). Never rejects. */
  dispatched: Promise<void>;
}

/** Does the queue contain anything a reconcile pass would have to write? */
export function needsReconcile(queue: ShopQueue): boolean {
  return queue.entries.some(
    ({ job, band }) =>
      job.revealedAt === null && (band === 'revealed' || (band === 'arriving' && job.arrivingNotifiedAt === null)),
  );
}

interface PassRow {
  id: string;
  studentId: string;
  checkInCount: number;
  isReveal: boolean;
  graceSeconds: number;
  revealedAt: Date | null;
  revealDeadlineAt: Date | null;
}

const ACTIVE_STATUS_SQL = Prisma.join(
  (ACTIVE_QUEUE_STATUSES as JobStatus[]).map((status) => Prisma.sql`CAST(${status}::text AS "JobStatus")`),
);

/**
 * The locked reveal pass: BEGIN, advisory lock, ONE statement, COMMIT. The
 * statement re-reads the shop's line AFTER the lock (a new statement = a new
 * snapshot) and applies exactly the rule of assignBands(): free counter slots
 * go to the earliest unrevealed jobs, the next `capacity` are "arriving".
 * Rows are only won while still unrevealed / un-notified, so concurrent
 * callers reveal and notify each job exactly once. All values are bound
 * parameters (tagged template); no notification or timer runs in here.
 */
async function lockedRevealPass(shopId: string): Promise<PassRow[]> {
  return prisma.$transaction(
    async (tx) => {
      // Parameterised tagged template (not string-built SQL). Serialises syncs per shop.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`queue-${shopId}`}))`;
      const now = new Date();
      return tx.$queryRaw<PassRow[]>(Prisma.sql`
        WITH sh AS (
          SELECT GREATEST(${COUNTER_CAPACITY_MIN}::int, "counterCapacity") AS cap, "revealGraceSeconds" AS grace
          FROM "Shop" WHERE "id" = ${shopId}
        ), q AS (
          SELECT "id", "revealedAt", "arrivingNotifiedAt",
                 row_number() OVER (ORDER BY "queuedAt" ASC, "createdAt" ASC) AS pos
          FROM "Job" WHERE "shopId" = ${shopId} AND "status" IN (${ACTIVE_STATUS_SQL})
        ), st AS (
          SELECT sh.cap, sh.grace,
                 GREATEST(0, sh.cap - (SELECT count(*) FROM q WHERE q."revealedAt" IS NOT NULL)) AS free
          FROM sh
        ), un AS (
          SELECT q."id", q."arrivingNotifiedAt", row_number() OVER (ORDER BY q.pos) AS urank
          FROM q WHERE q."revealedAt" IS NULL
        ), pick AS (
          SELECT un."id", (un.urank <= st.free) AS is_reveal, st.grace
          FROM un CROSS JOIN st
          WHERE un.urank <= st.free OR (un.urank <= st.free + st.cap AND un."arrivingNotifiedAt" IS NULL)
        )
        UPDATE "Job" j SET
          "revealedAt" = CASE WHEN pick.is_reveal THEN ${now}::timestamp ELSE j."revealedAt" END,
          "revealDeadlineAt" = CASE WHEN pick.is_reveal THEN ${now}::timestamp + pick.grace * interval '1 second' ELSE j."revealDeadlineAt" END,
          "arrivingNotifiedAt" = CASE WHEN pick.is_reveal THEN j."arrivingNotifiedAt" ELSE ${now}::timestamp END,
          "updatedAt" = ${now}::timestamp
        FROM pick
        WHERE j."id" = pick."id" AND j."shopId" = ${shopId} AND j."status" IN (${ACTIVE_STATUS_SQL})
          AND j."revealedAt" IS NULL AND (pick.is_reveal OR j."arrivingNotifiedAt" IS NULL)
        RETURNING j."id", j."studentId", j."checkInCount", pick.is_reveal AS "isReveal",
                  pick.grace AS "graceSeconds", j."revealedAt", j."revealDeadlineAt"`);
    },
    { maxWait: env.QUEUE_SYNC_TX_MAX_WAIT_MS, timeout: env.QUEUE_SYNC_TX_TIMEOUT_MS },
  );
}

async function runRevealPass(shopId: string): Promise<RevealPass> {
  const won = await lockedRevealPass(shopId);
  const wonAt = new Date();
  const reveals = won.filter((w) => w.isReveal).map((w) => ({
    jobId: w.id,
    studentId: w.studentId,
    revealedAtMs: w.revealedAt!.getTime(),
    graceSeconds: Number(w.graceSeconds),
    revealedAt: w.revealedAt!,
    revealDeadlineAt: w.revealDeadlineAt,
  }));
  const arrivals = won.filter((w) => !w.isReveal).map((w) => ({
    jobId: w.id,
    studentId: w.studentId,
    checkInCount: Number(w.checkInCount),
    arrivingNotifiedAt: wonAt,
  }));

  // Exactly once per pass, after commit, off the request path. A crash before
  // this runs only delays the push: reveals are durable, and the 10 s sweeper
  // re-syncs; eventKeys keep delivery idempotent.
  const dispatched = runInBackground('queue-reveal-dispatch', async () => {
    for (const r of reveals) {
      // Delayed timer is the fast path; the DB sweeper is the durable backstop
      // (production Redis is memory-only). BullMQ ids must not contain ':'.
      await timersQueue
        .add('revealExpiry', { jobId: r.jobId }, {
          delay: r.graceSeconds * 1000 + 250,
          jobId: `absent-${r.jobId}-${r.revealedAtMs}`,
        })
        .catch((err) => logger.error({ err, jobId: r.jobId }, 'reveal_timer_enqueue_failed'));
    }
    await Promise.all([
      ...reveals.map((r) =>
        notifyStudent(r.studentId, {
          title: 'It’s your turn',
          body: 'Please be at the counter.',
          url: `/jobs/${r.jobId}`,
          eventKey: `revealed-${r.jobId}-${r.revealedAtMs}`,
        }),
      ),
      ...arrivals.map((a) =>
        notifyStudent(a.studentId, {
          title: 'Your turn is coming up',
          body: 'Please head to the shop.',
          url: `/jobs/${a.jobId}`,
          eventKey: `arriving-${a.jobId}-${a.checkInCount}`,
        }),
      ),
    ]);
  }) as Promise<void>;
  return { reveals, arrivals, dispatched };
}

/** Per-shop single-flight state: at most one pass running and one queued. */
const flights = new Map<string, { running: Promise<RevealPass>; next: Promise<RevealPass> | null }>();

/**
 * Run the locked reveal pass for a shop. Safe to call as often as needed
 * (every queue change, owner settings change and the 10 s sweeper).
 *
 * Semantics:
 *  - Jobs are revealed in queue order while fewer than `counterCapacity` jobs
 *    are revealed. Free slots appear when a job completes, is cancelled,
 *    released or marked absent.
 *  - A newly revealed job gets revealedAt = now and revealDeadlineAt = now +
 *    the shop's CURRENT grace (grace changes only affect future reveals).
 *  - Already revealed jobs are never un-revealed: lowering capacity only
 *    stops new reveals until enough revealed jobs leave; raising it reveals
 *    the extra students immediately.
 *  - Every transition is a conditional UPDATE, and the writing pass holds a
 *    per-shop advisory lock, so concurrent callers reveal/notify exactly once.
 *
 * Contention: calls for the same shop in this process are coalesced. While a
 * pass runs, every further caller shares ONE follow-up pass (it starts after
 * the running one commits, so it sees all their writes). A burst of N
 * check-ins therefore costs at most two locked transactions instead of N
 * transactions queueing on the advisory lock and the connection pool.
 */
export function revealPass(shopId: string): Promise<RevealPass> {
  const flight = flights.get(shopId);
  if (!flight) return startPass(shopId);
  if (!flight.next) {
    // Starts synchronously the moment the running pass settles, replacing the
    // flight entry, so later callers queue behind it and never join a pass
    // that began reading before their write.
    flight.next = flight.running.then(() => undefined, () => undefined).then(() => startPass(shopId));
  }
  return flight.next;
}

function startPass(shopId: string): Promise<RevealPass> {
  const pass = runRevealPass(shopId);
  const entry = { running: pass, next: null as Promise<RevealPass> | null };
  flights.set(shopId, entry);
  const finish = () => {
    if (flights.get(shopId) === entry) flights.delete(shopId);
  };
  pass.then(finish, finish);
  return pass;
}

/**
 * Patch the reveals/arrivals a pass won into an already-loaded queue so its
 * bands carry the real timestamps. Returns false when the pass touched a job
 * this snapshot does not contain (a concurrent writer) - the caller reloads.
 */
export function applyPassToQueue(queue: ShopQueue, pass: RevealPass): boolean {
  const byId = new Map(queue.entries.map((e) => [e.job.id, e.job]));
  for (const r of pass.reveals) {
    const job = byId.get(r.jobId);
    if (!job) return false;
    job.revealedAt = r.revealedAt;
    job.revealDeadlineAt = r.revealDeadlineAt;
  }
  for (const a of pass.arrivals) {
    const job = byId.get(a.jobId);
    if (!job) return false;
    job.arrivingNotifiedAt = a.arrivingNotifiedAt;
  }
  return true;
}

/** Rebuild bands/positions from a patched snapshot (no I/O). */
export function rebuildQueue(queue: ShopQueue): ShopQueue {
  return buildShopQueue(queue, queue.printers, queue.entries.map((e) => e.job));
}

/**
 * Reconcile reveals with the current queue and return the resulting queue.
 *
 * Performance: the common "nothing to reveal" case is one read (a single
 * JOIN statement) with no transaction and no lock.
 */
export async function reconcileShopQueue(shopId: string): Promise<ReconciledQueue> {
  const preview = await loadShopQueue(prisma, shopId);
  if (!needsReconcile(preview)) {
    return { queue: preview, dispatched: Promise.resolve(), count: 0 };
  }
  const pass = await revealPass(shopId);
  const queue = applyPassToQueue(preview, pass) ? rebuildQueue(preview) : await loadShopQueue(prisma, shopId);
  return { queue, dispatched: pass.dispatched, count: pass.reveals.length + pass.arrivals.length };
}

/** Reconcile and wait for the resulting notifications (sweeper, shop actions, tests). */
export async function syncShopQueue(shopId: string): Promise<number> {
  const { dispatched, count } = await reconcileShopQueue(shopId);
  await dispatched;
  return count;
}
