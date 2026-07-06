import type { Job, Printer } from '@prisma/client';
import {
  ACTIVE_QUEUE_STATUSES,
  isPendingScheduled,
  pickNextJob,
  rankPrinters,
  type JobSpecs,
  type JobStatus,
  type PrinterProfile,
} from '@printq/shared';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { env } from '../../config/env.js';
import { generateOtp, hashOtp } from '../../lib/otp.js';
import { timersQueue } from '../../lib/queues.js';
import { publishEvent } from '../../realtime/events.js';
import { notifyStudent } from '../../providers/notification/index.js';
import { conflict, notFound } from '../../lib/errors.js';
import { applyTransition, type ActorType } from '../jobs/transitions.js';

const leadMs = () => env.SCHEDULE_LEAD_MINUTES * 60_000;

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

/** Rank the shop's printers for a job. Used at queue entry, release and manual assign. */
export async function recommendPrinter(shopId: string, specs: JobSpecs, pagesPerCopy: number) {
  const [printers, active] = await Promise.all([
    prisma.printer.findMany({ where: { shopId } }),
    prisma.job.findMany({
      where: { shopId, status: { in: ACTIVE_QUEUE_STATUSES as JobStatus[] } },
    }),
  ]);
  return rankPrinters(
    printers.map(toProfile),
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
  const positionByJob = new Map<string, { position: number; etaMinutes: number }>();
  const perPrinterCount = new Map<string, number>();
  const perPrinterPages = new Map<string, number>();

  for (const job of jobs) {
    if (!job.assignedPrinterId) continue;
    // a scheduled job outside its lead window holds no live position yet
    if (isPendingScheduled({ mode: job.mode, scheduledTime: job.scheduledTime }, now, leadMs())) continue;
    const pid = job.assignedPrinterId;
    const pos = (perPrinterCount.get(pid) ?? 0) + 1;
    const pagesAhead = perPrinterPages.get(pid) ?? 0;
    const specs = job.specs as unknown as JobSpecs;
    perPrinterCount.set(pid, pos);
    perPrinterPages.set(pid, pagesAhead + job.pagesPerCopy * specs.copies);
    positionByJob.set(job.id, {
      position: pos,
      etaMinutes: Math.ceil(pagesAhead / (ppmByPrinter.get(pid) ?? 15)),
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
    publishEvent(`student:${job.studentId}`, 'job:update', {
      jobId: job.id,
      status: job.status,
      position: live?.position ?? null,
      etaMinutes: live?.etaMinutes ?? null,
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
        title: 'Almost your turn!',
        body: `${live.position - 1 === 0 ? 'You are next' : `${live.position - 1} ahead of you`} — start walking to the shop.`,
        url: `/jobs/${job.id}`,
      });
    }
  }
}

/**
 * Payment confirmed → job joins the queue. Provisional printer assignment
 * happens here; the final eligibility check re-runs at OTP time.
 * Scheduled jobs wait for their slot (a delayed timer wakes the queue).
 */
export async function onPaymentConfirmed(jobId: string): Promise<void> {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job || job.status !== 'pending_payment') return;

  const specs = job.specs as unknown as JobSpecs;
  const { recommended } = await recommendPrinter(job.shopId, specs, job.pagesPerCopy);

  const updated = await applyTransition(jobId, 'pending_payment', 'PAYMENT_CONFIRMED', { type: 'system' }, {
    paymentStatus: 'paid',
    queuedAt: new Date(),
    assignedPrinterId: recommended?.printerId ?? null,
  });
  if (!updated) return; // lost race (e.g. duplicate webhook) — already handled

  if (!recommended) {
    logger.warn({ jobId, shopId: job.shopId }, 'no_eligible_printer_at_queue_time');
    publishEvent(`shop:${job.shopId}`, 'queue:manual_assign_needed', { jobId });
  }

  if (job.mode === 'scheduled' && job.scheduledTime) {
    const wakeAt = job.scheduledTime.getTime() - leadMs();
    await timersQueue.add(
      'scheduledDue',
      { jobId },
      { delay: Math.max(wakeAt - Date.now(), 0), jobId: `due-${jobId}` },
    );
    await notifyStudent(job.studentId, {
      title: 'Slot booked ✓',
      body: `Your print is scheduled for ${job.scheduledTime.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })}. We'll ping you when it's time.`,
      url: `/jobs/${jobId}`,
    });
  } else {
    await notifyStudent(job.studentId, {
      title: 'Paid & in queue ✓',
      body: "You're in line. Watch your live position in the app.",
      url: `/jobs/${jobId}`,
    });
  }

  await advanceShopQueues(job.shopId);
  await emitQueueUpdate(job.shopId);
}

/** Timer handler: a scheduled job's lead window opened — wake its printer queue. */
export async function handleScheduledDue(jobId: string): Promise<void> {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job || job.status !== 'queued') return;
  if (job.assignedPrinterId) await advancePrinterQueue(job.assignedPrinterId, job.shopId);
  await emitQueueUpdate(job.shopId);
}

/** Notify the front job of each printer queue that has no active notification. */
export async function advanceShopQueues(shopId: string): Promise<void> {
  const printers = await prisma.printer.findMany({ where: { shopId } });
  for (const printer of printers) {
    await advancePrinterQueue(printer.id, shopId);
  }
}

/**
 * If this printer has no job currently in the OTP window, promote the next
 * eligible job (fair instant/scheduled alternation): generate the release
 * OTP, tell the student in-app and arm the no-show timer.
 */
export async function advancePrinterQueue(printerId: string, shopId: string): Promise<void> {
  const [alreadyNotified, printer, waiting] = await Promise.all([
    prisma.job.findFirst({ where: { assignedPrinterId: printerId, status: 'notified' } }),
    prisma.printer.findUnique({ where: { id: printerId } }),
    prisma.job.findMany({
      where: { assignedPrinterId: printerId, status: 'queued' },
      orderBy: { queuedAt: 'asc' },
    }),
  ]);
  if (alreadyNotified || !printer || waiting.length === 0) return;

  const pick = pickNextJob(
    waiting.map((j) => ({
      id: j.id,
      mode: j.mode,
      queuedAt: j.queuedAt ?? j.createdAt,
      scheduledTime: j.scheduledTime,
    })),
    printer.lastPromotedMode,
    new Date(),
    leadMs(),
  );
  if (!pick) return;
  const front = waiting.find((j) => j.id === pick.id)!;

  const otp = generateOtp();
  const otpHash = await hashOtp(otp);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + env.OTP_WINDOW_MINUTES * 60_000);

  const updated = await applyTransition(front.id, 'queued', 'FRONT_REACHED', { type: 'system' }, {
    otpHash,
    otpCode: otp, // shown only to the owning student while `notified`
    otpGeneratedAt: now,
    otpExpiresAt: expiresAt,
    otpAttempts: 0,
  });
  if (!updated) return;

  await prisma.printer.update({
    where: { id: printerId },
    data: { lastPromotedMode: front.mode },
  });

  await timersQueue.add(
    'noShowCheck',
    { jobId: front.id },
    { delay: expiresAt.getTime() - Date.now(), jobId: `noshow-${front.id}-${now.getTime()}` },
  );

  await notifyStudent(front.studentId, {
    title: "It's your turn! 🖨️",
    body: `Show OTP ${otp} at the counter within ${env.OTP_WINDOW_MINUTES} minutes.`,
    url: `/jobs/${front.id}`,
  });
  publishEvent(`student:${front.studentId}`, 'job:your_turn', {
    jobId: front.id,
    otp,
    expiresAt: expiresAt.toISOString(),
  });
  logger.info({ jobId: front.id, printerId, shopId, mode: front.mode }, 'job_notified');
}

async function afterNoShow(job: Job, noShowCount: number): Promise<void> {
  await timersQueue.add(
    'graceExpiry',
    { jobId: job.id },
    { delay: env.NO_SHOW_GRACE_MINUTES * 60_000, jobId: `grace-${job.id}-${Date.now()}` },
  );
  const canRequeue = noShowCount <= 1;
  if (!canRequeue) {
    // second no-show: skip the grace period, expire immediately
    await applyTransition(job.id, 'no_show', 'GRACE_EXPIRED', { type: 'system' });
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
  await applyTransition(jobId, 'no_show', 'GRACE_EXPIRED', { type: 'system' });
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

/** After OTP verification: dispatch the print command to agents that can reach the printer. */
export async function dispatchJob(job: Job, actor: { type: ActorType; id?: string }): Promise<void> {
  if (!job.assignedPrinterId) {
    logger.error({ jobId: job.id }, 'dispatch_without_printer');
    return;
  }
  const agents = await prisma.agent.findMany({
    where: { shopId: job.shopId, connectedPrinterIds: { has: job.assignedPrinterId } },
  });
  if (agents.length === 0) {
    publishEvent(`shop:${job.shopId}`, 'queue:no_agent', {
      jobId: job.id,
      printerId: job.assignedPrinterId,
    });
    logger.warn({ jobId: job.id, printerId: job.assignedPrinterId }, 'no_agent_for_printer');
    return;
  }
  const specs = job.specs as unknown as JobSpecs;
  for (const agent of agents) {
    publishEvent(`agent:${agent.id}`, 'job:dispatch', {
      jobId: job.id,
      printerId: job.assignedPrinterId,
      specs,
    });
  }
  logger.info({ jobId: job.id, agents: agents.length, actor: actor.type }, 'job_dispatched');
}
