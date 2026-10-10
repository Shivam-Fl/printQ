import type { Job, Prisma, Printer } from '@prisma/client';
import {
  ACTIVE_QUEUE_STATUSES,
  rankPrinters,
  type JobSpecs,
  type JobStatus,
  type PrinterProfile,
  type QueueBand,
} from '@printq/shared';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { env } from '../../config/env.js';
import { digestReleaseCode, encryptReleaseCode, generateOtp } from '../../lib/otp.js';
import { timersQueue } from '../../lib/queues.js';
import { publishEvent } from '../../realtime/events.js';
import { notifyStudent } from '../../providers/notification/index.js';
import { conflict, notFound } from '../../lib/errors.js';
import { applyTransition, type ActorType } from '../jobs/transitions.js';
import { refundIfPaid } from '../payments/refund.js';
import { scheduleFileDeletion } from '../../lib/fileRetention.js';
import { distanceMeters, isWithinRadius, type Coordinates } from '../../lib/geo.js';
import { reachablePrinterIds } from '../shops/availability.js';
import { isCounterCodeAvailable } from './visibility.js';
import { loadShopQueue, syncShopQueue } from './bands.js';

const leadMs = () => env.SCHEDULE_LEAD_MINUTES * 60_000;
const MAX_LOCATION_AGE_MS = 90_000;
const MAX_LOCATION_ACCURACY_M = 100;

export interface ArrivalProof extends Coordinates {
  accuracyM: number;
  measuredAt: Date;
}

function toProfile(p: Printer): PrinterProfile {
  return {
    id: p.id,
    label: p.label,
    paperSizesLoaded: p.paperSizesLoaded as PrinterProfile['paperSizesLoaded'],
    colorSupport: p.colorSupport,
    finishingOptions: p.finishingOptions as PrinterProfile['finishingOptions'],
    avgPagesPerMinute: p.avgPagesPerMinute,
    status: p.status,
  };
}

export interface JobLiveMetrics {
  position: number | null;
  etaMinutes: number | null;
  /** Server-computed counter band; null when the job is not in the live line. */
  band: QueueBand | null;
  /** When a revealed student must be at the counter (null = no timer running). */
  revealDeadlineAt: Date | null;
}

const NOT_IN_LINE: JobLiveMetrics = { position: null, etaMinutes: null, band: null, revealDeadlineAt: null };

/** Current student-facing queue position/ETA/band, also used as a socket fallback. */
export async function getJobLiveMetrics(jobId: string): Promise<JobLiveMetrics> {
  const target = await prisma.job.findUnique({ where: { id: jobId }, select: { shopId: true, status: true } });
  if (!target || !ACTIVE_QUEUE_STATUSES.includes(target.status as JobStatus)) return NOT_IN_LINE;
  const queue = await loadShopQueue(prisma, target.shopId);
  const entry = queue.entries.find((e) => e.job.id === jobId);
  if (!entry) return NOT_IN_LINE;
  return {
    // One shop-wide walk-in line avoids duplicate "#1" tokens when the shop
    // has several printers. ETA still reflects the assigned device.
    position: entry.position,
    etaMinutes: entry.etaMinutes,
    band: entry.band,
    revealDeadlineAt: entry.band === 'revealed' ? entry.job.revealDeadlineAt : null,
  };
}

/** Rank the shop's printers for a job. Used at queue entry, release and manual assign. */
export async function recommendPrinter(
  shopId: string,
  specs: JobSpecs,
  pagesPerCopy: number,
  excludeJobId?: string,
) {
  const [printers, active, reachable] = await Promise.all([
    prisma.printer.findMany({ where: { shopId } }),
    prisma.job.findMany({
      where: {
        shopId,
        status: { in: ACTIVE_QUEUE_STATUSES as JobStatus[] },
        ...(excludeJobId ? { id: { not: excludeJobId } } : {}),
      },
    }),
    reachablePrinterIds(shopId),
  ]);
  return rankPrinters(
    printers.filter((printer) => reachable.has(printer.id)).map(toProfile),
    specs,
    pagesPerCopy,
    active.map((j) => ({
      id: j.id,
      assignedPrinterId: j.assignedPrinterId,
      pages: j.pagesPerCopy,
      copies: (j.specs as unknown as JobSpecs).copies,
    })),
  );
}

/**
 * Reconcile reveals (new reveals + notifications), then push live positions,
 * ETAs and bands to the shop dashboard and every queued student. The counter
 * code itself is never part of any socket payload; students fetch it from the
 * authenticated job endpoint, which only returns it in the revealed band.
 */
export async function emitQueueUpdate(shopId: string): Promise<void> {
  await syncShopQueue(shopId);
  const queue = await loadShopQueue(prisma, shopId);

  const snapshot = queue.entries.map(({ job, position, band, etaMinutes }) => ({
    jobId: job.id,
    status: job.status,
    mode: job.mode,
    scheduledTime: job.scheduledTime,
    printerId: job.assignedPrinterId,
    studentName: job.student.name,
    position,
    etaMinutes,
    band,
    revealDeadlineAt: band === 'revealed' ? job.revealDeadlineAt : null,
    needsManualAssignment: job.assignedPrinterId === null,
  }));
  publishEvent(`shop:${shopId}`, 'queue:update', { jobs: snapshot, counterCapacity: queue.counterCapacity });

  for (const { job, position, band, etaMinutes } of queue.entries) {
    publishEvent(`student:${job.studentId}`, 'job:update', {
      jobId: job.id,
      status: job.status,
      position,
      etaMinutes,
      band,
      revealDeadlineAt: band === 'revealed' ? job.revealDeadlineAt : null,
      counterCodeAvailable: isCounterCodeAvailable(job.status as JobStatus, job.revealedAt),
    });
  }
}

/**
 * A pay-at-shop order receives a stable counter code but never a physical
 * queue position. Counter staff—not a student browser—will later confirm the
 * exact server-calculated total before the print is released.
 */
export async function preparePayAtShopOrder(jobId: string): Promise<void> {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job || job.status !== 'pending_payment') return;

  let code = '';
  let codeDigest = '';
  // Six digits are easy to exchange over a noisy counter. Keep them unique
  // among unfinished jobs in this shop so lookup is deterministic.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = generateOtp();
    const digest = digestReleaseCode(job.shopId, candidate);
    const collision = await prisma.job.count({
      where: {
        shopId: job.shopId,
        releaseCodeDigest: digest,
        status: { notIn: ['completed', 'expired', 'cancelled'] },
      },
    });
    if (collision === 0) {
      code = candidate;
      codeDigest = digest;
      break;
    }
  }
  if (!code) throw new Error('Could not allocate a unique release code');

  const updated = await applyTransition(
    jobId,
    'pending_payment',
    'CASH_SELECTED',
    { type: 'system' },
    {
      paymentStatus: 'counter_due',
      paymentProvider: 'pay_at_shop',
      releaseCodeDigest: codeDigest,
      releaseCodeEncrypted: encryptReleaseCode(job.shopId, code),
      releaseCodeGeneratedAt: new Date(),
    },
  );
  if (!updated) return; // lost race (e.g. duplicate webhook) — already handled

  if (job.mode === 'scheduled' && job.scheduledTime) {
    const wakeAt = job.scheduledTime.getTime() - leadMs();
    await timersQueue.add(
      'scheduledDue',
      { jobId },
      { delay: Math.max(wakeAt - Date.now(), 0), jobId: `due-${jobId}` },
    );
    await notifyStudent(job.studentId, {
      title: 'Print order prepared ✓',
      body: `Your files are ready for ${job.scheduledTime.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })}. Check in after you arrive and pay the shop at the counter before printing.`,
      url: `/jobs/${jobId}`,
      eventKey: `prepared:${jobId}:pay-at-shop`,
    });
  } else {
    await notifyStudent(job.studentId, {
      title: 'Print order prepared ✓',
      body: 'Travel when convenient. Check in only after you arrive, then pay the shop at the counter when staff verifies your counter code.',
      url: `/jobs/${jobId}`,
      eventKey: `prepared:${jobId}:pay-at-shop`,
    });
  }

  await emitQueueUpdate(job.shopId);
}

/** Timer handler: remind a scheduled student that their arrival window opened. */
export async function handleScheduledDue(jobId: string): Promise<void> {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job || job.status !== 'awaiting_arrival') return;
  await notifyStudent(job.studentId, {
    title: 'Your planned arrival window is open',
    body: 'When you reach the shop, open this order and tap “I’m at the shop” to join the live line.',
    url: `/jobs/${job.id}`,
    eventKey: `scheduled-arrival:${job.id}`,
  });
}

/** Compatibility hook used when printer topology changes. */
export async function advanceShopQueues(shopId: string): Promise<void> {
  await emitQueueUpdate(shopId);
}

/**
 * The counter code—not an automatic promotion—authorizes printing. This hook
 * now only refreshes advisory positions, so an absent front student can never
 * hold a printer or the shop's counter hostage.
 */
export async function advancePrinterQueue(printerId: string, shopId: string): Promise<void> {
  void printerId;
  await emitQueueUpdate(shopId);
}

/**
 * Join the physical walk-in line. Repeated taps are idempotent, and printer
 * eligibility is checked at arrival rather than hours earlier at upload time.
 */
export async function checkInJob(jobId: string, studentId: string, arrival: ArrivalProof): Promise<Job> {
  const job = await prisma.job.findFirst({ where: { id: jobId, studentId } });
  if (!job) throw notFound();
  if (job.status === 'queued') return job;
  if (job.status !== 'awaiting_arrival' && job.status !== 'no_show' && job.status !== 'requeued') {
    throw conflict('This order cannot join the live line in its current state');
  }
  const paymentReady = job.paymentStatus === 'paid'
    || (job.paymentProvider === 'pay_at_shop' && job.paymentStatus === 'counter_due')
    // Compatibility only for pre-cutover cash orders that must still finish.
    || (job.paymentProvider === 'cash' && job.paymentStatus === 'cash_due');
  if (!paymentReady) throw conflict('This order is not prepared for counter payment yet');

  const locationAge = Date.now() - arrival.measuredAt.getTime();
  if (locationAge < -10_000 || locationAge > MAX_LOCATION_AGE_MS) {
    throw conflict('Your location reading is stale. Check your location again at the shop entrance.');
  }
  const shop = await prisma.shop.findUnique({
    where: { id: job.shopId },
    select: { latitude: true, longitude: true, checkInRadiusM: true },
  });
  if (shop?.latitude == null || shop.longitude == null) {
    throw conflict('This shop has not enabled secure arrival check-in. Show your counter code to staff.');
  }
  const requiredAccuracyM = Math.min(MAX_LOCATION_ACCURACY_M, shop.checkInRadiusM);
  if (arrival.accuracyM > requiredAccuracyM) {
    throw conflict(
      `Your phone location is accurate to about ${Math.round(arrival.accuracyM)} m, but this shop uses a ${shop.checkInRadiusM} m check-in zone. Enable precise location near the entrance and retry.`,
    );
  }
  const arrivalDistanceM = distanceMeters(arrival, {
    latitude: shop.latitude,
    longitude: shop.longitude,
  });
  if (!isWithinRadius(arrivalDistanceM, shop.checkInRadiusM)) {
    throw conflict(`You need to be within ${shop.checkInRadiusM} m of the shop to join its live line.`);
  }

  if (job.mode === 'scheduled' && job.scheduledTime) {
    const opensAt = job.scheduledTime.getTime() - leadMs();
    if (Date.now() < opensAt) {
      throw conflict(
        `Check-in opens at ${new Date(opensAt).toLocaleTimeString('en-IN', {
          hour: '2-digit',
          minute: '2-digit',
          timeZone: 'Asia/Kolkata',
        })}`,
      );
    }
  }

  const specs = job.specs as unknown as JobSpecs;
  const { recommended } = await recommendPrinter(job.shopId, specs, job.pagesPerCopy);
  if (!recommended) {
    throw conflict('No compatible connected printer is available right now. Ask the shop before joining the line.');
  }

  const now = new Date();
  const updated = await applyTransition(
    job.id,
    job.status,
    'ARRIVED',
    { type: 'student', id: studentId },
    {
      assignedPrinterId: recommended.printerId,
      queuedAt: now,
      arrivedAt: now,
      queueLeftAt: null,
      nearFrontNotifiedAt: null,
      // A fresh check-in always starts a fresh place at the BACK of the line:
      // reveal/absent state from an earlier stay is discarded.
      revealedAt: null,
      revealDeadlineAt: null,
      arrivingNotifiedAt: null,
      absentAt: null,
      absentReason: null,
      checkInCount: { increment: 1 },
      // Clear any legacy turn-window state; the stable release code remains.
      otpHash: null,
      otpCode: null,
      otpExpiresAt: null,
    },
  );
  if (!updated) {
    const current = await prisma.job.findUnique({ where: { id: job.id } });
    if (current?.status === 'queued') return current;
    throw conflict('Order state changed, refresh and try again');
  }

  await notifyStudent(job.studentId, {
    title: 'Checked in at the shop ✓',
    body: 'You are in the live walk-in line. We will tell you when it is your turn at the counter.',
    url: `/jobs/${job.id}`,
    eventKey: `checked-in:${job.id}:${job.checkInCount + 1}`,
  });
  publishEvent(`shop:${job.shopId}`, 'queue:arrival', { jobId: job.id });
  await emitQueueUpdate(job.shopId);
  return updated;
}

export type AbsentReason = 'staff' | 'grace_expired';

/**
 * The single "absent" code path (staff button, legacy removal route and the
 * automatic grace expiry all land here). The paid job stays valid and keeps
 * its stable counter code, but the student loses their place: queue/reveal
 * state is cleared, so only a FRESH proximity check-in (which places them at
 * the back) or staff finding the job by counter code can bring it back.
 * Location-free requeue stays rejected.
 *
 * `guard` joins the conditional UPDATE inside applyTransition, so a timer
 * can never mark absent a job that staff released / touched a moment ago.
 */
async function markAbsent(
  job: Job,
  actor: { type: 'shop' | 'system'; id?: string },
  reason: AbsentReason,
  guard?: Prisma.JobWhereInput,
): Promise<Job | null> {
  const now = new Date();
  const updated = await applyTransition(
    job.id,
    job.status,
    'QUEUE_SKIPPED',
    actor,
    {
      queuedAt: null,
      queueLeftAt: now,
      otpHash: null,
      otpCode: null,
      otpExpiresAt: null,
      // Losing the place also hides the code again (not in the revealed band).
      revealedAt: null,
      revealDeadlineAt: null,
      arrivingNotifiedAt: null,
      absentAt: now,
      absentReason: reason,
    },
    reason === 'grace_expired' ? 'ABSENT_TIMEOUT' : 'ABSENT_STAFF',
    guard,
  );
  if (!updated) return null;

  await notifyStudent(job.studentId, {
    title: 'You missed your turn',
    body: 'Check in again to get a new place. Your paid order is still safe.',
    url: `/jobs/${job.id}`,
    eventKey: `absent-${job.id}-${job.checkInCount}`,
  });
  publishEvent(`student:${job.studentId}`, 'job:update', {
    jobId: job.id,
    status: updated.status,
    position: null,
    etaMinutes: null,
    band: null,
    revealDeadlineAt: null,
    counterCodeAvailable: false,
    absent: true,
  });
  // Closes the gap: recomputes bands, reveals + notifies the next student.
  await emitQueueUpdate(job.shopId);
  return updated;
}

/**
 * Staff marks a student absent. Owner scope (shopId) is in the WHERE clause;
 * missing and foreign jobs are both 404.
 */
export async function removeFromLiveQueue(jobId: string, shopId: string, actorId: string): Promise<Job> {
  const job = await prisma.job.findFirst({ where: { id: jobId, shopId } });
  if (!job) throw notFound();
  if (job.status === 'awaiting_arrival') return job;
  if (job.status !== 'queued' && job.status !== 'notified') {
    throw conflict('Only a waiting order can be marked absent');
  }
  const updated = await markAbsent(job, { type: 'shop', id: actorId }, 'staff');
  if (!updated) throw conflict('Order state changed, refresh and try again');
  return updated;
}

/**
 * Absent timer (BullMQ delayed job and DB sweeper share this). Idempotent and
 * race-safe: the overdue-deadline guard is part of the same conditional UPDATE
 * as the status change, so if staff released/looked up the job (which clears
 * the deadline or changes status) exactly one side wins.
 */
export async function expireReveal(jobId: string): Promise<boolean> {
  const now = new Date();
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job || (job.status !== 'queued' && job.status !== 'notified')) return false;
  if (!job.revealedAt || !job.revealDeadlineAt || job.revealDeadlineAt.getTime() > now.getTime()) return false;
  const updated = await markAbsent(job, { type: 'system' }, 'grace_expired', {
    revealedAt: { not: null },
    revealDeadlineAt: { lte: now },
  });
  return updated !== null;
}

/** Durable backstop for lost/never-run delayed timers (memory-only Redis). Runs every ~10 s. */
export async function sweepExpiredReveals(): Promise<number> {
  const overdue = await prisma.job.findMany({
    where: { status: { in: ['queued', 'notified'] }, revealDeadlineAt: { lte: new Date() } },
    select: { id: true },
    orderBy: { revealDeadlineAt: 'asc' },
    take: 100,
  });
  let expired = 0;
  for (const { id } of overdue) {
    try {
      if (await expireReveal(id)) expired += 1;
    } catch (err) {
      logger.error({ err, jobId: id }, 'reveal_expiry_failed');
    }
  }
  // Repair any queue whose reveal pass was missed (e.g. a crash between a
  // status change and its follow-up sync).
  const stale = await prisma.job.findMany({
    where: { status: { in: ['queued', 'notified'] }, revealedAt: null },
    select: { shopId: true },
    distinct: ['shopId'],
    take: 100,
  });
  for (const { shopId } of stale) {
    try {
      if ((await syncShopQueue(shopId)) > 0) await emitQueueUpdate(shopId);
    } catch (err) {
      logger.error({ err, shopId }, 'queue_sync_failed');
    }
  }
  return expired;
}

/**
 * Compatibility handler for delayed timers created before arrival-based
 * queuing. Current orders never create these timers. If an old timer fires,
 * remove the job from the physical line but preserve the paid order and its
 * stable code rather than creating a timed no-show/refund branch.
 */
export function isLegacyNoShowTimerDue(otpExpiresAt: Date | null, now = Date.now()): boolean {
  return otpExpiresAt === null || otpExpiresAt.getTime() <= now;
}

export async function handleNoShowCheck(jobId: string): Promise<void> {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  // An older delayed timer may fire after a job's old turn window was
  // extended. It must not remove the student until the newest window ends.
  if (!job || job.status !== 'notified' || !isLegacyNoShowTimerDue(job.otpExpiresAt)) return;
  await removeFromLiveQueue(job.id, job.shopId, 'legacy-no-show-sweeper');
}

/** Compatibility alias for callers from the retired timed no-show model. */
export async function markNoShow(jobId: string, shopId: string, actorId: string): Promise<void> {
  await removeFromLiveQueue(jobId, shopId, actorId);
}

/**
 * Compatibility handler for an old grace timer. Do not expire/refund a paid
 * order merely because that obsolete timer fired; return it to the prepared
 * state so a fresh proximity check-in or counter-code release can recover it.
 */
export async function handleGraceExpiry(jobId: string): Promise<void> {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job || job.status !== 'no_show') return;
  const restored = await applyTransition(jobId, 'no_show', 'QUEUE_SKIPPED', { type: 'system' }, {
    queuedAt: null,
    queueLeftAt: new Date(),
  });
  if (!restored) return;
  await notifyStudent(job.studentId, {
    title: 'Your print order is ready when you are',
    body: 'Check in again after reaching the shop, or show your six-digit code to staff at the counter.',
    url: `/jobs/${job.id}`,
    eventKey: `legacy-queue-skipped:${job.id}`,
  });
  await emitQueueUpdate(job.shopId);
}

/**
 * Compatibility endpoint for the retired timed no-show model. Re-entry now
 * always happens through checkInJob(), which verifies a fresh location and
 * writes a new queuedAt timestamp at the end of the live line.
 */
export async function requeueJob(jobId: string, studentId: string): Promise<Job> {
  // ownership baked into the query — a student can only requeue their own job
  const job = await prisma.job.findFirst({ where: { id: jobId, studentId } });
  if (!job) throw notFound();
  throw conflict('Rejoining the live line requires a fresh location check-in at the shop');
}

/**
 * Hourly DB-backed safety sweep. It does not rely on a single delayed Redis
 * timer. It closes only unpaid counter-due documents; a staff-confirmed shop
 * payment is never silently cancelled or refunded by a timer.
 */
export async function expireStalePreparedOrders(): Promise<void> {
  const cutoff = new Date(Date.now() - env.PREPARED_ORDER_TTL_HOURS * 3_600_000);
  const stale = await prisma.job.findMany({
    where: {
      status: 'awaiting_arrival',
      paymentStatus: { in: ['counter_due', 'cash_due'] },
      updatedAt: { lt: cutoff },
    },
    take: 100,
  });
  for (const job of stale) {
    const cancelled = await applyTransition(
      job.id,
      'awaiting_arrival',
      'CANCEL',
      { type: 'system' },
      ['counter_due', 'cash_due'].includes(job.paymentStatus)
        ? { paymentStatus: 'failed' }
        : {},
    );
    if (!cancelled) continue;
    await refundIfPaid(cancelled);
    await scheduleFileDeletion(cancelled.fileId);
    await notifyStudent(cancelled.studentId, {
      title: 'Unused print order closed',
      body: `You did not check in within ${env.PREPARED_ORDER_TTL_HOURS / 24} days, so this unpaid pay-at-shop order was cancelled.`,
      url: `/jobs/${cancelled.id}`,
      eventKey: `expired:${cancelled.id}`,
    });
    publishEvent(`student:${cancelled.studentId}`, 'job:update', {
      jobId: cancelled.id,
      status: cancelled.status,
    });
  }

  // Legacy online orders may still need their pre-cutover provider refund.
  // Pay-at-shop refunds require an auditable human confirmation instead.
  const pendingRefunds = await prisma.job.findMany({
    where: {
      status: { in: ['cancelled', 'expired'] },
      paymentStatus: 'paid',
      paymentId: { not: null },
      paymentProvider: { not: 'pay_at_shop' },
    },
    take: 100,
  });
  for (const job of pendingRefunds) await refundIfPaid(job);
}

/** After OTP verification: dispatch the print command to agents that can reach the printer. */
export async function dispatchJob(job: Job, actor: { type: ActorType; id?: string }): Promise<void> {
  if (!job.assignedPrinterId) {
    logger.error({ jobId: job.id }, 'dispatch_without_printer');
    return;
  }
  const agents = await prisma.agent.findMany({
    where: { shopId: job.shopId, connectedPrinterIds: { has: job.assignedPrinterId } },
  });
  const onlineAgents = agents.filter((agent) => agent.status === 'online');
  if (onlineAgents.length === 0) {
    await prisma.job.updateMany({
      where: { id: job.id, status: 'otp_verified' },
      data: { printError: 'No connected print agent is online for this printer.' },
    });
    publishEvent(`shop:${job.shopId}`, 'queue:no_agent', {
      jobId: job.id,
      printerId: job.assignedPrinterId,
    });
    logger.warn(
      { jobId: job.id, printerId: job.assignedPrinterId, registeredAgents: agents.length },
      'no_online_agent_for_printer',
    );
    return;
  }
  const specs = job.specs as unknown as JobSpecs;
  for (const agent of onlineAgents) {
    publishEvent(`agent:${agent.id}`, 'job:dispatch', {
      jobId: job.id,
      printerId: job.assignedPrinterId,
      specs,
    });
  }
  logger.info({ jobId: job.id, agents: onlineAgents.length, actor: actor.type }, 'job_dispatched');
}
