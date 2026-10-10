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
  /** Fresh queue as of this reconcile; reveals this call won are already patched in. */
  queue: ShopQueue;
  /** Reveal timers + "your turn"/"coming up" notifications this call is responsible for. */
  dispatchNotifications: () => Promise<void>;
  count: number;
}

/** Does the queue contain anything a reconcile pass would have to write? */
function needsReconcile(queue: ShopQueue): boolean {
  return queue.entries.some(
    ({ job, band }) =>
      job.revealedAt === null && (band === 'revealed' || (band === 'arriving' && job.arrivingNotifiedAt === null)),
  );
}

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
 * Performance: the common "nothing to reveal" case is one read with no
 * transaction and no lock. Only when a reveal/arriving write is needed do we
 * open the short advisory-lock transaction (which re-reads, so the decision is
 * always made on locked state). Notifications are NOT sent here; the caller
 * decides whether to await `dispatchNotifications` or run it in the background.
 */
export async function reconcileShopQueue(shopId: string): Promise<ReconciledQueue> {
  const preview = await loadShopQueue(prisma, shopId);
  if (!needsReconcile(preview)) {
    return { queue: preview, dispatchNotifications: async () => undefined, count: 0 };
  }

  const { queue, reveals, arrivals } = await prisma.$transaction(async (tx) => {
    // Parameterised tagged template (not string-built SQL). Serialises syncs per shop.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`queue-${shopId}`}))`;
    const locked = await loadShopQueue(tx, shopId, preview);
    const now = new Date();
    const reveals: RevealEvent[] = [];
    const arrivals: ArrivingEvent[] = [];
    for (const { job, band } of locked.entries) {
      if (band === 'revealed' && job.revealedAt === null) {
        const deadline = new Date(now.getTime() + locked.revealGraceSeconds * 1000);
        const won = await tx.job.updateMany({
          where: { id: job.id, shopId, status: { in: ACTIVE_QUEUE_STATUSES as JobStatus[] }, revealedAt: null },
          data: { revealedAt: now, revealDeadlineAt: deadline },
        });
        if (won.count === 1) {
          job.revealedAt = now;
          job.revealDeadlineAt = deadline;
          reveals.push({
            jobId: job.id,
            studentId: job.studentId,
            revealedAtMs: now.getTime(),
            graceSeconds: locked.revealGraceSeconds,
          });
        }
      } else if (band === 'arriving' && job.arrivingNotifiedAt === null && job.revealedAt === null) {
        const won = await tx.job.updateMany({
          where: {
            id: job.id,
            shopId,
            status: { in: ACTIVE_QUEUE_STATUSES as JobStatus[] },
            revealedAt: null,
            arrivingNotifiedAt: null,
          },
          data: { arrivingNotifiedAt: now },
        });
        if (won.count === 1) {
          job.arrivingNotifiedAt = now;
          arrivals.push({ jobId: job.id, studentId: job.studentId, checkInCount: job.checkInCount });
        }
      }
    }
    return { queue: locked, reveals, arrivals };
  });

  const dispatchNotifications = async () => {
    for (const r of reveals) {
      // Delayed timer is the fast path; the DB sweeper is the durable backstop
      // (production Redis is memory-only). BullMQ ids must not contain ':'.
      await timersQueue
        .add('revealExpiry', { jobId: r.jobId }, {
          delay: r.graceSeconds * 1000 + 250,
          jobId: `absent-${r.jobId}-${r.revealedAtMs}`,
        })
        .catch((err) => logger.error({ err, jobId: r.jobId }, 'reveal_timer_enqueue_failed'));
      await notifyStudent(r.studentId, {
        title: 'It’s your turn',
        body: 'Please be at the counter.',
        url: `/jobs/${r.jobId}`,
        eventKey: `revealed-${r.jobId}-${r.revealedAtMs}`,
      });
    }
    for (const a of arrivals) {
      await notifyStudent(a.studentId, {
        title: 'Your turn is coming up',
        body: 'Please head to the shop.',
        url: `/jobs/${a.jobId}`,
        eventKey: `arriving-${a.jobId}-${a.checkInCount}`,
      });
    }
  };
  return { queue, dispatchNotifications, count: reveals.length + arrivals.length };
}

/** Reconcile and send the resulting notifications before returning (sweeper, shop actions). */
export async function syncShopQueue(shopId: string): Promise<number> {
  const { dispatchNotifications, count } = await reconcileShopQueue(shopId);
  await dispatchNotifications();
  return count;
}
