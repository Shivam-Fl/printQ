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
import { generateOtp, hashOtp } from '../../lib/otp.js';
import { timersQueue } from '../../lib/queues.js';
import { publishEvent } from '../../realtime/events.js';
import { notify } from '../../providers/notification/index.js';
import { conflict, notFound } from '../../lib/errors.js';
import { applyTransition, type ActorType } from '../jobs/transitions.js';

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

async function activeJobsLite(shopId: string) {
  const jobs = await prisma.job.findMany({
    where: { shopId, status: { in: ACTIVE_QUEUE_STATUSES as JobStatus[] } },
    orderBy: { queuedAt: 'asc' },
  });
  return jobs;
}

/** Rank the shop's printers for a job. Used at queue entry, release and manual assign. */
export async function recommendPrinter(shopId: string, specs: JobSpecs, pagesPerCopy: number) {
  const printers = await prisma.printer.findMany({ where: { shopId } });
  const active = await activeJobsLite(shopId);
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
 * Recompute live queue positions + ETAs for a shop and push them to the shop
 * dashboard room and each affected student's room.
 */
export async function emitQueueUpdate(shopId: string): Promise<void> {
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
    printerId: job.assignedPrinterId,
    studentName: job.student.name,
    position: positionByJob.get(job.id)?.position ?? null,
    etaMinutes: positionByJob.get(job.id)?.etaMinutes ?? null,
    needsManualAssignment: job.assignedPrinterId === null,
  }));

  publishEvent(`shop:${shopId}`, 'queue:update', { jobs: snapshot });
  for (const job of jobs) {
    publishEvent(`student:${job.studentId}`, 'job:update', {
      jobId: job.id,
      status: job.status,
      position: positionByJob.get(job.id)?.position ?? null,
      etaMinutes: positionByJob.get(job.id)?.etaMinutes ?? null,
    });
  }
}

/**
 * Payment confirmed → job joins the queue. Provisional printer assignment
 * happens here so per-printer positions/ETAs exist; the final eligibility
 * check re-runs at OTP time (printers can go offline in between).
 */
export async function onPaymentConfirmed(jobId: string): Promise<void> {
  const job = await prisma.job.findUnique({ where: { id: jobId }, include: { student: true } });
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

  await notify(
    job.student.phone,
    `PrintQ: your print job is paid and in the queue. We'll message you when it's your turn.`,
  );
  await advanceShopQueues(job.shopId);
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
 * If this printer has no job currently in the OTP window, promote its earliest
 * queued job to `notified`: generate the release OTP, message the student and
 * arm the no-show timer.
 */
export async function advancePrinterQueue(printerId: string, shopId: string): Promise<void> {
  const alreadyNotified = await prisma.job.findFirst({
    where: { assignedPrinterId: printerId, status: 'notified' },
  });
  if (alreadyNotified) return;

  const front = await prisma.job.findFirst({
    where: { assignedPrinterId: printerId, status: 'queued' },
    orderBy: { queuedAt: 'asc' },
    include: { student: true },
  });
  if (!front) return;

  const otp = generateOtp();
  const otpHash = await hashOtp(otp);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + env.OTP_WINDOW_MINUTES * 60_000);

  const updated = await applyTransition(front.id, 'queued', 'FRONT_REACHED', { type: 'system' }, {
    otpHash,
    otpGeneratedAt: now,
    otpExpiresAt: expiresAt,
    otpAttempts: 0,
  });
  if (!updated) return;

  await timersQueue.add(
    'noShowCheck',
    { jobId: front.id },
    { delay: expiresAt.getTime() - Date.now(), jobId: `noshow:${front.id}:${now.getTime()}` },
  );

  await notify(
    front.student.phone,
    `PrintQ: it's your turn! Give this OTP at the shop within ${env.OTP_WINDOW_MINUTES} minutes to print: ${otp}`,
  );
  // the OTP also goes to the student's own authenticated socket room — same
  // trust boundary as their WhatsApp, and keeps the pilot usable before the
  // WhatsApp Business account exists
  publishEvent(`student:${front.studentId}`, 'job:your_turn', {
    jobId: front.id,
    otp,
    expiresAt: expiresAt.toISOString(),
  });
  logger.info({ jobId: front.id, printerId, shopId }, 'job_notified');
}

/** Timer handler: OTP window expired without verification → no-show. */
export async function handleNoShowCheck(jobId: string): Promise<void> {
  const job = await prisma.job.findUnique({ where: { id: jobId }, include: { student: true } });
  if (!job || job.status !== 'notified') return; // OTP was given in time — nothing to do
  if (job.otpExpiresAt && job.otpExpiresAt.getTime() > Date.now()) return; // re-notified later

  const updated = await applyTransition(jobId, 'notified', 'WINDOW_EXPIRED', { type: 'system' }, {
    noShowAt: new Date(),
    noShowCount: { increment: 1 },
    otpHash: null,
    otpExpiresAt: null,
  });
  if (!updated) return;

  await timersQueue.add(
    'graceExpiry',
    { jobId },
    { delay: env.NO_SHOW_GRACE_MINUTES * 60_000, jobId: `grace:${jobId}:${Date.now()}` },
  );

  const canRequeue = updated.noShowCount <= 1;
  await notify(
    job.student.phone,
    canRequeue
      ? `PrintQ: you missed your turn. Open the app within ${env.NO_SHOW_GRACE_MINUTES} minutes to requeue for free, or the job expires.`
      : `PrintQ: you missed your turn again. This job has expired — please submit a new one.`,
  );
  publishEvent(`student:${job.studentId}`, 'job:update', { jobId, status: 'no_show', canRequeue });

  if (!canRequeue) {
    // second no-show: skip the grace period, expire immediately
    await applyTransition(jobId, 'no_show', 'GRACE_EXPIRED', { type: 'system' });
  }

  if (job.assignedPrinterId) await advancePrinterQueue(job.assignedPrinterId, job.shopId);
  await emitQueueUpdate(job.shopId);
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

/** Shop marks a notified job as no-show before the timer fires (student clearly absent). */
export async function markNoShow(jobId: string, shopId: string, actorId: string): Promise<void> {
  const job = await prisma.job.findFirst({
    where: { id: jobId, shopId },
    include: { student: true },
  });
  if (!job) throw notFound();
  if (job.status !== 'notified') throw conflict('Job is not awaiting an OTP');

  const updated = await applyTransition(jobId, 'notified', 'WINDOW_EXPIRED', { type: 'shop', id: actorId }, {
    noShowAt: new Date(),
    noShowCount: { increment: 1 },
    otpHash: null,
    otpExpiresAt: null,
  });
  if (!updated) return;

  await timersQueue.add(
    'graceExpiry',
    { jobId },
    { delay: env.NO_SHOW_GRACE_MINUTES * 60_000, jobId: `grace:${jobId}:${Date.now()}` },
  );
  const canRequeue = updated.noShowCount <= 1;
  if (!canRequeue) await applyTransition(jobId, 'no_show', 'GRACE_EXPIRED', { type: 'system' });

  await notify(
    job.student.phone,
    canRequeue
      ? `PrintQ: the shop marked you as a no-show. Requeue for free in the app within ${env.NO_SHOW_GRACE_MINUTES} minutes.`
      : `PrintQ: this job has expired after repeated no-shows. Please submit a new one.`,
  );
  publishEvent(`student:${job.studentId}`, 'job:update', { jobId, status: updated.status, canRequeue });

  if (job.assignedPrinterId) await advancePrinterQueue(job.assignedPrinterId, job.shopId);
  await emitQueueUpdate(job.shopId);
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
