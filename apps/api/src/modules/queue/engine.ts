import type { Job, Printer } from '@prisma/client';
import {
  ACTIVE_QUEUE_STATUSES,
  rankPrinters,
  type JobSpecs,
  type JobStatus,
  type PrinterProfile,
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
import { distanceMeters, type Coordinates } from '../../lib/geo.js';
import { reachablePrinterIds } from '../shops/availability.js';
import { isCounterCodeAvailable } from './visibility.js';

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

/** Current student-facing queue position/ETA, also used as a socket fallback. */
export async function getJobLiveMetrics(jobId: string): Promise<{ position: number | null; etaMinutes: number | null }> {
  const target = await prisma.job.findUnique({ where: { id: jobId } });
  if (!target?.assignedPrinterId || !ACTIVE_QUEUE_STATUSES.includes(target.status as JobStatus)) {
    return { position: null, etaMinutes: null };
  }
  const [printer, jobs] = await Promise.all([
    prisma.printer.findUnique({ where: { id: target.assignedPrinterId } }),
    prisma.job.findMany({
      where: {
        shopId: target.shopId,
        status: { in: ACTIVE_QUEUE_STATUSES as JobStatus[] },
      },
      orderBy: { queuedAt: 'asc' },
    }),
  ]);
  if (!printer) return { position: null, etaMinutes: null };

  let pagesAhead = 0;
  for (let index = 0; index < jobs.length; index += 1) {
    const job = jobs[index]!;
    if (job.id === jobId) {
      return {
        // One shop-wide walk-in line avoids duplicate "#1" tokens when the
        // shop has multiple printers. ETA still reflects the assigned device.
        position: index + 1,
        etaMinutes: Math.ceil(pagesAhead / Math.max(printer.avgPagesPerMinute, 1)),
      };
    }
    if (job.assignedPrinterId === target.assignedPrinterId) {
      pagesAhead += job.pagesPerCopy * (job.specs as unknown as JobSpecs).copies;
    }
  }
  return { position: null, etaMinutes: null };
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
 * Recompute live queue positions + ETAs for a shop, push them to the shop
 * dashboard and each student, and fire the "almost your turn" alert when a
 * job crosses the near-front threshold.
 */
export async function emitQueueUpdate(shopId: string): Promise<void> {
  const now = new Date();
  const [jobs, printers] = await Promise.all([
    prisma.job.findMany({
      where: { shopId, status: { in: ACTIVE_QUEUE_STATUSES as JobStatus[] } },
      orderBy: { queuedAt: 'asc' },
      include: { student: { select: { id: true, name: true } } },
    }),
    prisma.printer.findMany({ where: { shopId } }),
  ]);

  const ppmByPrinter = new Map(printers.map((p) => [p.id, Math.max(p.avgPagesPerMinute, 1)]));
  const positionByJob = new Map<string, { position: number; etaMinutes: number | null }>();
  const perPrinterPages = new Map<string, number>();

  for (let index = 0; index < jobs.length; index += 1) {
    const job = jobs[index]!;
    const pid = job.assignedPrinterId;
    const pagesAhead = pid ? (perPrinterPages.get(pid) ?? 0) : 0;
    const specs = job.specs as unknown as JobSpecs;
    if (pid) perPrinterPages.set(pid, pagesAhead + job.pagesPerCopy * specs.copies);
    positionByJob.set(job.id, {
      position: index + 1,
      etaMinutes: pid ? Math.ceil(pagesAhead / (ppmByPrinter.get(pid) ?? 15)) : null,
    });
  }

  const snapshot = jobs.map((job) => ({
    jobId: job.id,
    status: job.status,
    mode: job.mode,
    scheduledTime: job.scheduledTime,
    printerId: job.assignedPrinterId,
    studentName: job.student.name,
    position: positionByJob.get(job.id)?.position ?? null,
    etaMinutes: positionByJob.get(job.id)?.etaMinutes ?? null,
    needsManualAssignment: job.assignedPrinterId === null,
  }));

  publishEvent(`shop:${shopId}`, 'queue:update', { jobs: snapshot });

  for (const job of jobs) {
    const live = positionByJob.get(job.id);
    const counterCodeAvailable = isCounterCodeAvailable(
      job.status as JobStatus,
      live?.position ?? null,
      env.NEAR_FRONT_THRESHOLD,
      job.nearFrontNotifiedAt !== null,
    );
    publishEvent(`student:${job.studentId}`, 'job:update', {
      jobId: job.id,
      status: job.status,
      position: live?.position ?? null,
      etaMinutes: live?.etaMinutes ?? null,
      counterCodeAvailable,
    });

    // "almost your turn" — once per job, only while still waiting in line
    if (
      job.status === 'queued' &&
      !job.nearFrontNotifiedAt &&
      live &&
      live.position <= env.NEAR_FRONT_THRESHOLD
    ) {
      await prisma.job.updateMany({
        where: { id: job.id, nearFrontNotifiedAt: null },
        data: { nearFrontNotifiedAt: new Date() },
      });
      await notifyStudent(job.studentId, {
        title: live.position === 1 ? 'You are next at the counter' : 'Your turn is getting close',
        body: live.position === 1
          ? 'Your six-digit PrintQ code is ready. Show it at the counter.'
          : `${live.position - 1} ${live.position - 1 === 1 ? 'person is' : 'people are'} ahead of you. Your counter code is now available.`,
        url: `/jobs/${job.id}`,
      });
    }
  }
}

/**
 * Payment confirms a prepared remote order, but never reserves a place in the
 * physical line. A stable counter code is issued now; queue time begins only
 * after an explicit arrival check-in.
 */
export async function onPaymentConfirmed(jobId: string): Promise<void> {
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

  const updated = await applyTransition(jobId, 'pending_payment', 'PAYMENT_CONFIRMED', { type: 'system' }, {
    paymentStatus: 'paid',
    releaseCodeDigest: codeDigest,
    releaseCodeEncrypted: encryptReleaseCode(job.shopId, code),
    releaseCodeGeneratedAt: new Date(),
  });
  if (!updated) return; // lost race (e.g. duplicate webhook) — already handled

  if (job.mode === 'scheduled' && job.scheduledTime) {
    const wakeAt = job.scheduledTime.getTime() - leadMs();
    await timersQueue.add(
      'scheduledDue',
      { jobId },
      { delay: Math.max(wakeAt - Date.now(), 0), jobId: `due-${jobId}` },
    );
    await notifyStudent(job.studentId, {
      title: 'Slot booked ✓',
      body: `Your files are ready for ${job.scheduledTime.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })}. Check in after you physically arrive.`,
      url: `/jobs/${jobId}`,
    });
  } else {
    await notifyStudent(job.studentId, {
      title: 'Paid & ready for arrival ✓',
      body: 'Travel when convenient. Tap “I’m at the shop” only after you arrive to join the live walk-in line.',
      url: `/jobs/${jobId}`,
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
  if (job.status !== 'awaiting_arrival' && job.status !== 'no_show') {
    throw conflict('This order cannot join the live line in its current state');
  }
  if (job.paymentStatus !== 'paid') throw conflict('Payment must be confirmed before check-in');

  const locationAge = Date.now() - arrival.measuredAt.getTime();
  if (locationAge < -10_000 || locationAge > MAX_LOCATION_AGE_MS) {
    throw conflict('Your location reading is stale. Check your location again at the shop entrance.');
  }
  if (arrival.accuracyM > MAX_LOCATION_ACCURACY_M) {
    throw conflict('Location is not accurate enough. Move near the shop entrance, enable precise location, and retry.');
  }

  const shop = await prisma.shop.findUnique({
    where: { id: job.shopId },
    select: { latitude: true, longitude: true, checkInRadiusM: true },
  });
  if (shop?.latitude == null || shop.longitude == null) {
    throw conflict('This shop has not enabled secure arrival check-in. Show your counter code to staff.');
  }
  const arrivalDistanceM = distanceMeters(arrival, {
    latitude: shop.latitude,
    longitude: shop.longitude,
  });
  if (arrivalDistanceM > shop.checkInRadiusM) {
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
    body: `You are in the live walk-in line. Your counter code will appear automatically when you reach the first ${env.NEAR_FRONT_THRESHOLD}.`,
    url: `/jobs/${job.id}`,
  });
  publishEvent(`shop:${job.shopId}`, 'queue:arrival', { jobId: job.id });
  await emitQueueUpdate(job.shopId);
  return updated;
}

/**
 * Remove an absent person from the advisory line without cancelling their
 * paid order. They can check in again later or simply present their code.
 */
export async function removeFromLiveQueue(jobId: string, shopId: string, actorId: string): Promise<Job> {
  const job = await prisma.job.findFirst({ where: { id: jobId, shopId } });
  if (!job) throw notFound();
  if (job.status === 'awaiting_arrival') return job;
  if (job.status !== 'queued' && job.status !== 'notified') {
    throw conflict('Only a waiting order can be removed from the live line');
  }

  const updated = await applyTransition(
    job.id,
    job.status,
    'QUEUE_SKIPPED',
    { type: 'shop', id: actorId },
    {
      queuedAt: null,
      queueLeftAt: new Date(),
      // Once a student has reached the near-front window, keep their code
      // available after an absence. The paid job remains directly recoverable
      // without holding up, or re-entering, the physical line.
      otpHash: null,
      otpCode: null,
      otpExpiresAt: null,
    },
  );
  if (!updated) throw conflict('Order state changed, refresh and try again');

  await notifyStudent(job.studentId, {
    title: 'You were removed from the live line',
    body: 'Your paid order is still safe. Re-checking in places you at the end of the current line; staff can still find it directly with your six-digit code.',
    url: `/jobs/${job.id}`,
  });
  publishEvent(`student:${job.studentId}`, 'job:update', {
    jobId: job.id,
    status: updated.status,
    position: null,
    etaMinutes: null,
  });
  await emitQueueUpdate(job.shopId);
  return updated;
}

async function afterNoShow(job: Job, noShowCount: number): Promise<void> {
  const canRequeue = noShowCount <= 1;
  if (canRequeue) {
    await timersQueue.add(
      'graceExpiry',
      { jobId: job.id },
      { delay: env.NO_SHOW_GRACE_MINUTES * 60_000, jobId: `grace-${job.id}-${Date.now()}` },
    );
  } else {
    // Second no-show: expire and refund immediately. The old implementation
    // transitioned here but never reached the refund path.
    const expired = await applyTransition(job.id, 'no_show', 'GRACE_EXPIRED', { type: 'system' });
    if (expired) {
      await refundIfPaid(expired);
      await scheduleFileDeletion(expired.fileId);
    }
  }
  await notifyStudent(job.studentId, {
    title: canRequeue ? 'You missed your turn' : 'Job expired',
    body: canRequeue
      ? `Requeue for free in the app within ${env.NO_SHOW_GRACE_MINUTES} minutes, or the job expires.`
      : 'You missed your turn twice — please submit a new job.',
    url: `/jobs/${job.id}`,
  });
  publishEvent(`student:${job.studentId}`, 'job:update', {
    jobId: job.id,
    status: canRequeue ? 'no_show' : 'expired',
    canRequeue,
  });
  if (job.assignedPrinterId) await advancePrinterQueue(job.assignedPrinterId, job.shopId);
  await emitQueueUpdate(job.shopId);
}

/** Timer handler: OTP window expired without verification → no-show. */
export async function handleNoShowCheck(jobId: string): Promise<void> {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job || job.status !== 'notified') return; // OTP was given in time
  if (job.otpExpiresAt && job.otpExpiresAt.getTime() > Date.now()) return; // re-notified later

  const updated = await applyTransition(jobId, 'notified', 'WINDOW_EXPIRED', { type: 'system' }, {
    noShowAt: new Date(),
    noShowCount: { increment: 1 },
    otpHash: null,
    otpCode: null,
    otpExpiresAt: null,
  });
  if (!updated) return;
  await afterNoShow(job, updated.noShowCount);
}

/** Shop marks a notified job as no-show before the timer fires (student clearly absent). */
export async function markNoShow(jobId: string, shopId: string, actorId: string): Promise<void> {
  const job = await prisma.job.findFirst({ where: { id: jobId, shopId } });
  if (!job) throw notFound();
  if (job.status !== 'notified') throw conflict('Job is not awaiting an OTP');

  const updated = await applyTransition(jobId, 'notified', 'WINDOW_EXPIRED', { type: 'shop', id: actorId }, {
    noShowAt: new Date(),
    noShowCount: { increment: 1 },
    otpHash: null,
    otpCode: null,
    otpExpiresAt: null,
  });
  if (!updated) return;
  await afterNoShow(job, updated.noShowCount);
}

/** Timer handler: grace period passed with no requeue → expired. */
export async function handleGraceExpiry(jobId: string): Promise<void> {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job || job.status !== 'no_show') return;
  const expired = await applyTransition(jobId, 'no_show', 'GRACE_EXPIRED', { type: 'system' });
  // Requeue and grace-expiry can race. Never refund unless this transition won.
  if (!expired) return;
  await refundIfPaid(expired);
  await scheduleFileDeletion(expired.fileId);
  publishEvent(`student:${job.studentId}`, 'job:update', { jobId, status: 'expired' });
  await emitQueueUpdate(job.shopId);
}

/**
 * Student's one free requeue after a no-show. queuedAt is preserved, so the
 * job rejoins at/near the front rather than the back — they already waited.
 */
export async function requeueJob(jobId: string, studentId: string): Promise<Job> {
  // ownership baked into the query — a student can only requeue their own job
  const job = await prisma.job.findFirst({ where: { id: jobId, studentId } });
  if (!job) throw notFound();
  if (job.status !== 'no_show') throw conflict('Job cannot be requeued');
  if (job.noShowCount > 1) throw conflict('Requeue already used');

  await applyTransition(jobId, 'no_show', 'REQUEUE', { type: 'student', id: studentId });
  const rejoined = await applyTransition(jobId, 'requeued', 'REJOINED', { type: 'system' });

  if (job.assignedPrinterId) await advancePrinterQueue(job.assignedPrinterId, job.shopId);
  await emitQueueUpdate(job.shopId);
  return rejoined ?? job;
}

/**
 * Hourly DB-backed safety sweep. It does not rely on a single delayed Redis
 * timer, so restarts cannot leave forgotten paid documents open forever.
 */
export async function expireStalePreparedOrders(): Promise<void> {
  const cutoff = new Date(Date.now() - env.PREPARED_ORDER_TTL_HOURS * 3_600_000);
  const stale = await prisma.job.findMany({
    where: {
      status: 'awaiting_arrival',
      paymentStatus: 'paid',
      updatedAt: { lt: cutoff },
    },
    take: 100,
  });
  for (const job of stale) {
    const cancelled = await applyTransition(job.id, 'awaiting_arrival', 'CANCEL', { type: 'system' });
    if (!cancelled) continue;
    await refundIfPaid(cancelled);
    await scheduleFileDeletion(cancelled.fileId);
    await notifyStudent(cancelled.studentId, {
      title: 'Unused print order closed',
      body: `You did not check in within ${env.PREPARED_ORDER_TTL_HOURS / 24} days, so the order was cancelled and its refund was started.`,
      url: `/jobs/${cancelled.id}`,
    });
    publishEvent(`student:${cancelled.studentId}`, 'job:update', {
      jobId: cancelled.id,
      status: cancelled.status,
    });
  }

  // Provider outages can leave terminal jobs paid after the first refund call.
  // The atomic paid→refunding reservation keeps this retry idempotent.
  const pendingRefunds = await prisma.job.findMany({
    where: {
      status: { in: ['cancelled', 'expired'] },
      paymentStatus: 'paid',
      paymentId: { not: null },
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
