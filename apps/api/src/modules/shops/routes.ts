import { Router } from 'express';
import { z } from 'zod';
import {
  printOptionsSchema,
  printerInputSchema,
  releaseOtpSchema,
  type JobSpecs,
} from '@printq/shared';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, badRequest, conflict, notFound } from '../../lib/errors.js';
import { param } from '../../lib/http.js';
import { requireShopOwner, requireShopUser } from '../../middleware/auth.js';
import { otpVerifyLimiter } from '../../middleware/rateLimit.js';
import { validateBody } from '../../middleware/validate.js';
import { generateAgentToken } from '../../lib/otp.js';
import { shopOptions } from '../../lib/shopOptions.js';
import { releaseByOtp } from '../queue/release.js';
import {
  advancePrinterQueue,
  emitQueueUpdate,
  markNoShow,
  recommendPrinter,
} from '../queue/engine.js';
import { applyTransition } from '../jobs/transitions.js';
import { env } from '../../config/env.js';

export const shopRouter = Router();

const maskPhone = (phone: string) => `•••${phone.slice(-4)}`;

/** Shop settings + profile for the logged-in staff member. */
shopRouter.get(
  '/me',
  requireShopUser,
  asyncHandler(async (req, res) => {
    const shop = await prisma.shop.findUnique({
      where: { id: req.shopUser!.shopId },
      select: {
        id: true,
        slug: true,
        name: true,
        address: true,
        campusName: true,
        autoAssignEnabled: true,
        printOptions: true,
        otpWindowMinutes: true,
      },
    });
    if (!shop) throw notFound();
    // always return a concrete menu (defaults when the shop hasn't customised)
    res.json({ shop: { ...shop, printOptions: shopOptions(shop) } });
  }),
);

const shopPatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  address: z.string().trim().min(1).max(300).optional(),
  autoAssignEnabled: z.boolean().optional(),
  printOptions: printOptionsSchema.optional(),
});

/** Owner-only settings updates (details, auto-assign, print menu + pricing). */
shopRouter.patch(
  '/me',
  requireShopOwner,
  validateBody(shopPatchSchema),
  asyncHandler(async (req, res) => {
    const shop = await prisma.shop.update({
      where: { id: req.shopUser!.shopId },
      data: req.body as object,
      select: { id: true, name: true, address: true, autoAssignEnabled: true, printOptions: true },
    });
    res.json({ shop: { ...shop, printOptions: shopOptions(shop) } });
  }),
);

/** Analytics: revenue, prints and pages for the owner dashboard. */
shopRouter.get(
  '/stats',
  requireShopUser,
  asyncHandler(async (req, res) => {
    const shopId = req.shopUser!.shopId;
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const since = new Date(Date.now() - 30 * 86_400_000);

    const [allTime, completedCount, printers, recentCompleted] = await Promise.all([
      prisma.job.aggregate({ where: { shopId, paymentStatus: 'paid' }, _sum: { totalPaise: true }, _count: true }),
      prisma.job.count({ where: { shopId, status: 'completed' } }),
      prisma.printer.findMany({ where: { shopId }, select: { id: true, label: true } }),
      prisma.job.findMany({
        where: { shopId, status: 'completed', updatedAt: { gte: since } },
        select: { pagesPerCopy: true, specs: true, totalPaise: true, assignedPrinterId: true, updatedAt: true },
      }),
    ]);

    const label = new Map(printers.map((p) => [p.id, p.label]));
    let pagesPrinted = 0;
    let todayRevenue = 0;
    let todayJobs = 0;
    const byPrinter = new Map<string, { label: string; jobs: number; pages: number }>();
    const byDay = new Map<string, number>();

    for (const j of recentCompleted) {
      const copies = (j.specs as unknown as JobSpecs).copies ?? 1;
      const sheets = j.pagesPerCopy * copies;
      pagesPrinted += sheets;
      if (j.updatedAt >= startOfToday) {
        todayRevenue += j.totalPaise;
        todayJobs += 1;
      }
      const pid = j.assignedPrinterId ?? 'unassigned';
      const row = byPrinter.get(pid) ?? { label: label.get(pid) ?? '—', jobs: 0, pages: 0 };
      row.jobs += 1;
      row.pages += sheets;
      byPrinter.set(pid, row);
      const day = j.updatedAt.toISOString().slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + j.totalPaise);
    }

    const days = [...Array(7)].map((_, i) => {
      const d = new Date(Date.now() - (6 - i) * 86_400_000).toISOString().slice(0, 10);
      return { day: d, revenuePaise: byDay.get(d) ?? 0 };
    });

    res.json({
      stats: {
        totalRevenuePaise: allTime._sum.totalPaise ?? 0,
        totalPaidJobs: allTime._count,
        completedJobs: completedCount,
        pagesPrinted30d: pagesPrinted,
        todayRevenuePaise: todayRevenue,
        todayJobs,
        perPrinter: [...byPrinter.values()].sort((a, b) => b.jobs - a.jobs),
        last7Days: days,
      },
    });
  }),
);

/** Past jobs with which printer they went to (owner record). */
shopRouter.get(
  '/history',
  requireShopUser,
  asyncHandler(async (req, res) => {
    const jobs = await prisma.job.findMany({
      where: {
        shopId: req.shopUser!.shopId,
        status: { in: ['completed', 'expired', 'cancelled'] },
      },
      orderBy: { updatedAt: 'desc' },
      take: 100,
      select: {
        id: true,
        status: true,
        specs: true,
        pagesPerCopy: true,
        totalPaise: true,
        mode: true,
        updatedAt: true,
        assignedPrinter: { select: { label: true } },
        student: { select: { name: true, phone: true } },
        file: { select: { originalName: true } },
      },
    });
    res.json({
      jobs: jobs.map((j) => ({
        id: j.id,
        status: j.status,
        specs: j.specs,
        pagesPerCopy: j.pagesPerCopy,
        totalPaise: j.totalPaise,
        mode: j.mode,
        at: j.updatedAt,
        printer: j.assignedPrinter?.label ?? null,
        student: { name: j.student.name, phoneMasked: maskPhone(j.student.phone) },
        file: j.file.originalName,
      })),
    });
  }),
);

/** Live queue for the dashboard — jobs arrive fully specified (§2). */
shopRouter.get(
  '/queue',
  requireShopUser,
  asyncHandler(async (req, res) => {
    const shopId = req.shopUser!.shopId;
    const jobs = await prisma.job.findMany({
      where: { shopId, status: { in: ['queued', 'notified', 'otp_verified', 'printing', 'ready_for_pickup'] } },
      orderBy: { queuedAt: 'asc' },
      select: {
        id: true,
        status: true,
        specs: true,
        pagesPerCopy: true,
        totalPaise: true,
        assignedPrinterId: true,
        otpExpiresAt: true,
        queuedAt: true,
        student: { select: { name: true, phone: true } },
        file: { select: { originalName: true, pages: true } },
      },
    });
    res.json({
      jobs: jobs.map((j) => ({
        ...j,
        student: { name: j.student.name, phoneMasked: maskPhone(j.student.phone) },
      })),
    });
  }),
);

/**
 * THE shop-owner action (§5.2): one OTP input. Auto mode prints directly;
 * manual mode / no-eligible-printer returns the dropdown data instead.
 */
shopRouter.post(
  '/release',
  requireShopUser,
  otpVerifyLimiter,
  validateBody(releaseOtpSchema),
  asyncHandler(async (req, res) => {
    const { otp, printerId } = req.body as { otp: string; printerId?: string };
    const result = await releaseByOtp(req.shopUser!.shopId, otp, req.shopUser!.id, printerId);
    if (!result.ok) {
      res.status(200).json({
        requiresManualAssignment: true,
        jobId: result.job?.id,
        eligiblePrinters: result.eligiblePrinters,
      });
      return;
    }
    res.json({ ok: true, job: { id: result.job!.id, status: result.job!.status } });
  }),
);

/** Mark a notified job as no-show without waiting for the window to expire. */
shopRouter.post(
  '/jobs/:id/no-show',
  requireShopUser,
  asyncHandler(async (req, res) => {
    await markNoShow(param(req, 'id'), req.shopUser!.shopId, req.shopUser!.id);
    res.json({ ok: true });
  }),
);

/** Assign a printer to a queued job that has none (auto-assign found no match). */
shopRouter.post(
  '/jobs/:id/assign',
  requireShopUser,
  validateBody(z.object({ printerId: z.string().uuid() })),
  asyncHandler(async (req, res) => {
    const shopId = req.shopUser!.shopId;
    const { printerId } = req.body as { printerId: string };
    const [job, printer] = await Promise.all([
      prisma.job.findFirst({ where: { id: param(req, 'id'), shopId } }),
      prisma.printer.findFirst({ where: { id: printerId, shopId } }),
    ]);
    if (!job || !printer) throw notFound();
    if (job.status !== 'queued') throw conflict('Only queued jobs can be reassigned');

    await prisma.job.update({ where: { id: job.id }, data: { assignedPrinterId: printerId } });
    await advancePrinterQueue(printerId, shopId);
    await emitQueueUpdate(shopId);
    res.json({ ok: true });
  }),
);

/** Hand the finished print to the student — closes the job and starts file retention. */
shopRouter.post(
  '/jobs/:id/handover',
  requireShopUser,
  asyncHandler(async (req, res) => {
    const shopId = req.shopUser!.shopId;
    const job = await prisma.job.findFirst({ where: { id: param(req, 'id'), shopId } });
    if (!job) throw notFound();
    if (job.status !== 'ready_for_pickup') throw conflict('Job is not ready for pickup');

    const updated = await applyTransition(job.id, 'ready_for_pickup', 'HANDED_OVER', {
      type: 'shop',
      id: req.shopUser!.id,
    });
    if (!updated) throw conflict('Job state changed, try again');

    await prisma.uploadedFile.update({
      where: { id: job.fileId },
      data: { deleteAfter: new Date(Date.now() + env.FILE_RETENTION_HOURS * 3_600_000) },
    });
    await emitQueueUpdate(shopId);
    res.json({ ok: true });
  }),
);

/** Recommendation preview for the manual-assign dropdown (highlighted top pick). */
shopRouter.get(
  '/jobs/:id/recommendation',
  requireShopUser,
  asyncHandler(async (req, res) => {
    const job = await prisma.job.findFirst({
      where: { id: param(req, 'id'), shopId: req.shopUser!.shopId },
    });
    if (!job) throw notFound();
    const result = await recommendPrinter(
      job.shopId,
      job.specs as unknown as JobSpecs,
      job.pagesPerCopy,
    );
    res.json(result);
  }),
);

// ---------- Printer management ----------

shopRouter.get(
  '/printers',
  requireShopUser,
  asyncHandler(async (req, res) => {
    const printers = await prisma.printer.findMany({
      where: { shopId: req.shopUser!.shopId },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ printers });
  }),
);

shopRouter.post(
  '/printers',
  requireShopOwner,
  validateBody(printerInputSchema),
  asyncHandler(async (req, res) => {
    const printer = await prisma.printer.create({
      data: { ...(req.body as object), shopId: req.shopUser!.shopId } as never,
    });
    res.status(201).json({ printer });
  }),
);

shopRouter.patch(
  '/printers/:id',
  requireShopUser,
  validateBody(printerInputSchema.partial()),
  asyncHandler(async (req, res) => {
    const shopId = req.shopUser!.shopId;
    const existing = await prisma.printer.findFirst({ where: { id: param(req, 'id'), shopId } });
    if (!existing) throw notFound();
    const printer = await prisma.printer.update({
      where: { id: existing.id },
      data: req.body as object,
    });
    // a printer coming online may unblock its queue
    if (printer.status === 'online') await advancePrinterQueue(printer.id, shopId);
    await emitQueueUpdate(shopId);
    res.json({ printer });
  }),
);

shopRouter.delete(
  '/printers/:id',
  requireShopOwner,
  asyncHandler(async (req, res) => {
    const shopId = req.shopUser!.shopId;
    const existing = await prisma.printer.findFirst({ where: { id: param(req, 'id'), shopId } });
    if (!existing) throw notFound();
    const activeJobs = await prisma.job.count({
      where: { assignedPrinterId: existing.id, status: { in: ['queued', 'notified', 'otp_verified', 'printing'] } },
    });
    if (activeJobs > 0) throw conflict('Printer has active jobs — reassign them first');
    await prisma.printer.delete({ where: { id: existing.id } });
    res.json({ ok: true });
  }),
);

// ---------- Agent management ----------

shopRouter.get(
  '/agents',
  requireShopUser,
  asyncHandler(async (req, res) => {
    const agents = await prisma.agent.findMany({
      where: { shopId: req.shopUser!.shopId },
      select: {
        id: true,
        machineLabel: true,
        connectedPrinterIds: true,
        lastHeartbeatAt: true,
        status: true,
        createdAt: true,
      },
    });
    res.json({ agents });
  }),
);

/** Register a shop PC. The agent token is returned exactly once. */
shopRouter.post(
  '/agents',
  requireShopOwner,
  validateBody(
    z.object({
      machineLabel: z.string().trim().min(1).max(80),
      connectedPrinterIds: z.array(z.string().uuid()).default([]),
    }),
  ),
  asyncHandler(async (req, res) => {
    const shopId = req.shopUser!.shopId;
    const { machineLabel, connectedPrinterIds } = req.body as {
      machineLabel: string;
      connectedPrinterIds: string[];
    };
    // printer ids must belong to this shop
    const owned = await prisma.printer.count({ where: { shopId, id: { in: connectedPrinterIds } } });
    if (owned !== connectedPrinterIds.length) throw badRequest('Unknown printer in list');

    const { token, tokenHash } = generateAgentToken();
    const agent = await prisma.agent.create({
      data: { shopId, machineLabel, tokenHash, connectedPrinterIds },
    });
    res.status(201).json({
      agent: { id: agent.id, machineLabel: agent.machineLabel },
      // shown once — only the hash is stored
      token,
    });
  }),
);

shopRouter.patch(
  '/agents/:id',
  requireShopOwner,
  validateBody(z.object({ connectedPrinterIds: z.array(z.string().uuid()) })),
  asyncHandler(async (req, res) => {
    const shopId = req.shopUser!.shopId;
    const agent = await prisma.agent.findFirst({ where: { id: param(req, 'id'), shopId } });
    if (!agent) throw notFound();
    const { connectedPrinterIds } = req.body as { connectedPrinterIds: string[] };
    const owned = await prisma.printer.count({ where: { shopId, id: { in: connectedPrinterIds } } });
    if (owned !== connectedPrinterIds.length) throw badRequest('Unknown printer in list');
    const updated = await prisma.agent.update({
      where: { id: agent.id },
      data: { connectedPrinterIds },
    });
    res.json({ agent: { id: updated.id, connectedPrinterIds: updated.connectedPrinterIds } });
  }),
);

shopRouter.delete(
  '/agents/:id',
  requireShopOwner,
  asyncHandler(async (req, res) => {
    const agent = await prisma.agent.findFirst({
      where: { id: param(req, 'id'), shopId: req.shopUser!.shopId },
    });
    if (!agent) throw notFound();
    await prisma.agent.delete({ where: { id: agent.id } });
    res.json({ ok: true });
  }),
);
