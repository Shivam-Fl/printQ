import type { Job, Prisma, Printer } from '@prisma/client';
import {
  ACTIVE_QUEUE_STATUSES,
  assignBands,
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
  const jobsQuery = () =>
    db.job.findMany({
      where: { shopId, status: { in: ACTIVE_QUEUE_STATUSES as JobStatus[] } },
      orderBy: [{ queuedAt: 'asc' }, { createdAt: 'asc' }],
      include: { student: { select: { id: true, name: true } } },
    });
  const [shop, jobs, printers] = known
    ? [
        { counterCapacity: known.counterCapacity, revealGraceSeconds: known.revealGraceSeconds },
        await jobsQuery(),
        known.printers,
      ] as const
    : await Promise.all([
        db.shop.findUnique({ where: { id: shopId }, select: { counterCapacity: true, revealGraceSeconds: true } }),
        jobsQuery(),
        db.printer.findMany({ where: { shopId } }),
      ]);
  const counterCapacity = shop?.counterCapacity ?? 5;
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
  return { counterCapacity, revealGraceSeconds: shop?.revealGraceSeconds ?? 60, printers, entries };
}

interface RevealEvent { jobId: string; studentId: string; revealedAtMs: number; graceSeconds: number }
interface ArrivingEvent { jobId: string; studentId: string; checkInCount: number }
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

/** Does the queue contain anything a reconcile pass would have to write? */
function needsReconcile(queue: ShopQueue): boolean {
  return queue.entries.some(
    ({ job, band }) =>
      job.revealedAt === null && (band === 'revealed' || (band === 'arriving' && job.arrivingNotifiedAt === null)),
  );
}

async function runReconcilePass(shopId: string): Promise<ReconciledQueue> {
  const preview = await loadShopQueue(prisma, shopId);
  if (!needsReconcile(preview)) {
    return { queue: preview, dispatched: Promise.resolve(), count: 0 };
  }

  // Keep the advisory-locked section to: lock, one job read, at most two
  // batched UPDATEs. No notifications, timers or socket emits in here.
  const { queue, reveals, arrivals } = await prisma.$transaction(
    async (tx) => {
      // Parameterised tagged template (not string-built SQL). Serialises syncs per shop.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`queue-${shopId}`}))`;
      const locked = await loadShopQueue(tx, shopId, preview);
      const now = new Date();
      const deadline = new Date(now.getTime() + locked.revealGraceSeconds * 1000);
      const toReveal = locked.entries.filter((e) => e.band === 'revealed' && e.job.revealedAt === null);
      const toNotify = locked.entries.filter(
        (e) => e.band === 'arriving' && e.job.arrivingNotifiedAt === null && e.job.revealedAt === null,
      );
      const reveals: RevealEvent[] = [];
      const arrivals: ArrivingEvent[] = [];
      const byId = new Map(locked.entries.map((e) => [e.job.id, e.job]));

      if (toReveal.length > 0) {
        // Conditional UPDATE ... RETURNING: only rows still unrevealed are won.
        const won = await tx.job.updateManyAndReturn({
          where: {
            id: { in: toReveal.map((e) => e.job.id) },
            shopId,
            status: { in: ACTIVE_QUEUE_STATUSES as JobStatus[] },
            revealedAt: null,
          },
          data: { revealedAt: now, revealDeadlineAt: deadline },
          select: { id: true, studentId: true },
        });
        for (const w of won) {
          const job = byId.get(w.id)!;
          job.revealedAt = now;
          job.revealDeadlineAt = deadline;
          reveals.push({ jobId: w.id, studentId: w.studentId, revealedAtMs: now.getTime(), graceSeconds: locked.revealGraceSeconds });
        }
      }
      if (toNotify.length > 0) {
        const won = await tx.job.updateManyAndReturn({
          where: {
            id: { in: toNotify.map((e) => e.job.id) },
            shopId,
            status: { in: ACTIVE_QUEUE_STATUSES as JobStatus[] },
            revealedAt: null,
            arrivingNotifiedAt: null,
          },
          data: { arrivingNotifiedAt: now },
          select: { id: true, studentId: true, checkInCount: true },
        });
        for (const w of won) {
          byId.get(w.id)!.arrivingNotifiedAt = now;
          arrivals.push({ jobId: w.id, studentId: w.studentId, checkInCount: w.checkInCount });
        }
      }
      return { queue: locked, reveals, arrivals };
    },
    { maxWait: env.QUEUE_SYNC_TX_MAX_WAIT_MS, timeout: env.QUEUE_SYNC_TX_TIMEOUT_MS },
  );

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
  return { queue, dispatched, count: reveals.length + arrivals.length };
}

/** Per-shop single-flight state: at most one pass running and one queued. */
const flights = new Map<string, { running: Promise<ReconciledQueue>; next: Promise<ReconciledQueue> | null }>();

/**
 * Reconcile reveals with the current queue and return the resulting queue.
 * Safe to call as often as needed (every queue change, owner settings change
 * and the 10 s sweeper).
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
 *
 * Performance: the common "nothing to reveal" case is one read with no
 * transaction and no lock.
 */
export function reconcileShopQueue(shopId: string): Promise<ReconciledQueue> {
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

function startPass(shopId: string): Promise<ReconciledQueue> {
  const pass = runReconcilePass(shopId);
  const entry = { running: pass, next: null as Promise<ReconciledQueue> | null };
  flights.set(shopId, entry);
  const finish = () => {
    if (flights.get(shopId) === entry) flights.delete(shopId);
  };
  pass.then(finish, finish);
  return pass;
}

/** Reconcile and wait for the resulting notifications (sweeper, shop actions, tests). */
export async function syncShopQueue(shopId: string): Promise<number> {
  const { dispatched, count } = await reconcileShopQueue(shopId);
  await dispatched;
  return count;
}
