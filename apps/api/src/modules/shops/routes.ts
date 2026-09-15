import { Router } from 'express';
import argon2 from 'argon2';
import { z } from 'zod';
import {
  createStaffSchema,
  printOptionsSchema,
  printerInputSchema,
  releaseOtpSchema,
  type JobSpecs,
  type PriceBreakdown,
} from '@printq/shared';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, badRequest, conflict, HttpError, notFound } from '../../lib/errors.js';
import { param } from '../../lib/http.js';
import { requireShopOwner, requireShopUser } from '../../middleware/auth.js';
import { otpVerifyLimiter } from '../../middleware/rateLimit.js';
import { validateBody } from '../../middleware/validate.js';
import { generateAgentToken } from '../../lib/otp.js';
import { shopOptions } from '../../lib/shopOptions.js';
import { renderReceipt } from '../../lib/receipt.js';
import { releaseByOtp } from '../queue/release.js';
import {
  advancePrinterQueue,
  advanceShopQueues,
  emitQueueUpdate,
  removeFromLiveQueue,
  recommendPrinter,
  dispatchJob,
} from '../queue/engine.js';
import { applyTransition } from '../jobs/transitions.js';
import { env } from '../../config/env.js';
import { scheduleFileDeletion } from '../../lib/fileRetention.js';
import { publishEvent } from '../../realtime/events.js';
import { connectPrinterToDetectingAgents, notifyShopReopened } from './availability.js';
import {
  confirmShopBalancePayment,
  createShopBalancePayment,
  creditPrintEarning,
  getShopEarnings,
  requestShopPayout,
} from '../earnings/service.js';
import { notifyStudent } from '../../providers/notification/index.js';
import { searchIndianLocations } from '../../providers/geocoding/index.js';

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
        latitude: true,
        longitude: true,
        checkInRadiusM: true,
        locationUpdatedAt: true,
        autoAssignEnabled: true,
        cashPaymentsEnabled: true,
        acceptingOrders: true,
        printOptions: true,
        otpWindowMinutes: true,
      },
    });
    if (!shop) throw notFound();
    // always return a concrete menu (defaults when the shop hasn't customised)
    res.json({
      shop: { ...shop, printOptions: shopOptions(shop) },
      user: { role: req.shopUser!.role },
    });
  }),
);

/** One-time shop setup search; server-side so provider throttling/caching is centralized. */
shopRouter.get(
  '/location-search',
  requireShopOwner,
  asyncHandler(async (req, res) => {
    const query = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 180) : '';
    if (query.length < 3) throw badRequest('Enter at least 3 characters to search');
    try {
      res.json({ results: await searchIndianLocations(query) });
    } catch {
      throw new HttpError(503, 'Address search is temporarily unavailable. Use device location or manual coordinates.');
    }
  }),
);

/** Guided-onboarding status derived from real configuration, never a checkbox. */
shopRouter.get(
  '/setup-status',
  requireShopUser,
  asyncHandler(async (req, res) => {
    const shopId = req.shopUser!.shopId;
    const [shop, printers, agents] = await Promise.all([
      prisma.shop.findUnique({ where: { id: shopId } }),
      prisma.printer.findMany({ where: { shopId } }),
      prisma.agent.findMany({ where: { shopId } }),
    ]);
    if (!shop) throw notFound();

    const linkedPrinters = printers.filter((printer) => Boolean(printer.osPrinterName));
    const readyPrinters = linkedPrinters.filter((printer) => printer.status === 'online');
    const onlineAgents = agents.filter((agent) => agent.status === 'online');
    const options = shopOptions(shop);
    const pricingReady = options.papers.length > 0;
    const locationReady = shop.latitude != null && shop.longitude != null;
    const agentReady = onlineAgents.some((agent) =>
      agent.connectedPrinterIds.some((id) => readyPrinters.some((printer) => printer.id === id)),
    );

    res.json({
      setup: {
        profileReady: Boolean(shop.name.trim() && shop.address.trim()),
        locationReady,
        pricingReady,
        printerReady: readyPrinters.length > 0,
        agentReady,
        ready: locationReady && pricingReady && readyPrinters.length > 0 && agentReady,
        acceptingOrders: shop.acceptingOrders,
        counts: {
          printers: printers.length,
          linkedPrinters: linkedPrinters.length,
          onlinePrinters: readyPrinters.length,
          agents: agents.length,
          onlineAgents: onlineAgents.length,
        },
        studentUrl: `${env.PUBLIC_WEB_URL.replace(/\/$/, '')}/s/${shop.slug}`,
      },
    });
  }),
);

const shopPatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  address: z.string().trim().min(1).max(300).optional(),
  campusName: z.string().trim().max(120).nullable().optional(),
  latitude: z.number().finite().min(-90).max(90).nullable().optional(),
  longitude: z.number().finite().min(-180).max(180).nullable().optional(),
  checkInRadiusM: z.number().int().min(20).max(500).optional(),
  autoAssignEnabled: z.boolean().optional(),
  cashPaymentsEnabled: z.boolean().optional(),
  acceptingOrders: z.boolean().optional(),
  printOptions: printOptionsSchema.optional(),
}).superRefine((value, context) => {
  const latitudeProvided = value.latitude !== undefined;
  const longitudeProvided = value.longitude !== undefined;
  if (latitudeProvided !== longitudeProvided || (latitudeProvided && ((value.latitude == null) !== (value.longitude == null)))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['latitude'],
      message: 'Latitude and longitude must be updated together',
    });
  }
});

/** Owner-only settings updates (details, auto-assign, print menu + pricing). */
shopRouter.patch(
  '/me',
  requireShopOwner,
  validateBody(shopPatchSchema),
  asyncHandler(async (req, res) => {
    const shop = await prisma.shop.update({
      where: { id: req.shopUser!.shopId },
      data: {
        ...(req.body as object),
        ...('latitude' in req.body ? {
          locationUpdatedAt: typeof req.body.latitude === 'number' && typeof req.body.longitude === 'number'
            ? new Date()
            : null,
        } : {}),
      },
      select: {
        id: true,
        name: true,
        address: true,
        campusName: true,
        latitude: true,
        longitude: true,
        checkInRadiusM: true,
        locationUpdatedAt: true,
        autoAssignEnabled: true,
        cashPaymentsEnabled: true,
        acceptingOrders: true,
        printOptions: true,
      },
    });
    res.json({ shop: { ...shop, printOptions: shopOptions(shop) } });
  }),
);

/** Staff-accessible operational switch: stop new sales while finishing paid work. */
shopRouter.patch(
  '/availability',
  requireShopUser,
  validateBody(z.object({ acceptingOrders: z.boolean() })),
  asyncHandler(async (req, res) => {
    const { acceptingOrders } = req.body as { acceptingOrders: boolean };
    const shop = await prisma.shop.update({
      where: { id: req.shopUser!.shopId },
      data: { acceptingOrders },
      select: { id: true, acceptingOrders: true },
    });
    publishEvent(`shop:${shop.id}`, 'shop:availability', { acceptingOrders });
    if (acceptingOrders) await notifyShopReopened(shop.id);
    res.json({ shop });
  }),
);

/** Private owner ledger. Never mounted on any student/public route. */
shopRouter.get(
  '/earnings',
  requireShopOwner,
  asyncHandler(async (req, res) => {
    res.json({ earnings: await getShopEarnings(req.shopUser!.shopId) });
  }),
);

shopRouter.patch(
  '/earnings/settings',
  requireShopOwner,
  validateBody(z.object({ payoutSchedule: z.enum(['daily', 'on_demand']) })),
  asyncHandler(async (req, res) => {
    const { payoutSchedule } = req.body as { payoutSchedule: 'daily' | 'on_demand' };
    const shop = await prisma.shop.update({
      where: { id: req.shopUser!.shopId },
      data: { payoutSchedule },
      select: { payoutSchedule: true },
    });
    res.json({ settings: shop });
  }),
);

shopRouter.post(
  '/earnings/payout',
  requireShopOwner,
  asyncHandler(async (req, res) => {
    const payout = await requestShopPayout(req.shopUser!.shopId, req.shopUser!.id);
    res.status(201).json({ payout });
  }),
);

/** Settle a negative shop ledger created by cash-collected platform fees. */
shopRouter.post(
  '/earnings/pay-due',
  requireShopOwner,
  asyncHandler(async (req, res) => {
    const result = await createShopBalancePayment(req.shopUser!.shopId, req.shopUser!.id);
    res.status(result.created ? 201 : 200).json(result);
  }),
);

/** Local/test provider equivalent of Razorpay's captured-payment webhook. */
shopRouter.post(
  '/earnings/pay-due/mock-confirm',
  requireShopOwner,
  validateBody(z.object({ balancePaymentId: z.string().uuid() })),
  asyncHandler(async (req, res) => {
    if (env.PAYMENT_PROVIDER !== 'mock') throw notFound();
    const balancePayment = await prisma.shopBalancePayment.findFirst({
      where: {
        id: (req.body as { balancePaymentId: string }).balancePaymentId,
        shopId: req.shopUser!.shopId,
      },
    });
    if (!balancePayment) throw notFound();
    await confirmShopBalancePayment(balancePayment.providerOrderId, `mock_balance_${balancePayment.id}`);
    res.json({ ok: true });
  }),
);

/** Analytics: the shop's private base earnings, prints and pages. */
shopRouter.get(
  '/stats',
  requireShopOwner,
  asyncHandler(async (req, res) => {
    const shopId = req.shopUser!.shopId;
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const since = new Date(Date.now() - 30 * 86_400_000);

    const [allTime, completedCount, printers, recentCompleted] = await Promise.all([
      prisma.job.aggregate({
        where: { shopId, paymentStatus: 'paid', status: { in: ['ready_for_pickup', 'completed'] } },
        _sum: { shopBasePaise: true },
        _count: true,
      }),
      prisma.job.count({ where: { shopId, status: 'completed' } }),
      prisma.printer.findMany({ where: { shopId }, select: { id: true, label: true } }),
      prisma.job.findMany({
        where: { shopId, status: 'completed', updatedAt: { gte: since } },
        select: { pagesPerCopy: true, specs: true, shopBasePaise: true, assignedPrinterId: true, updatedAt: true },
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
        todayRevenue += j.shopBasePaise;
        todayJobs += 1;
      }
      const pid = j.assignedPrinterId ?? 'unassigned';
      const row = byPrinter.get(pid) ?? { label: label.get(pid) ?? '—', jobs: 0, pages: 0 };
      row.jobs += 1;
      row.pages += sheets;
      byPrinter.set(pid, row);
      const day = j.updatedAt.toISOString().slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + j.shopBasePaise);
    }

    const days = [...Array(7)].map((_, i) => {
      const d = new Date(Date.now() - (6 - i) * 86_400_000).toISOString().slice(0, 10);
      return { day: d, revenuePaise: byDay.get(d) ?? 0 };
    });

    res.json({
      stats: {
        totalRevenuePaise: allTime._sum.shopBasePaise ?? 0,
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
        paymentStatus: true,
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
        paymentStatus: j.paymentStatus,
        printer: j.assignedPrinter?.label ?? null,
        student: { name: j.student.name, phoneMasked: maskPhone(j.student.phone) },
        file: j.file.originalName,
      })),
    });
  }),
);

const csvCell = (v: string | number) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Same history data as CSV, for the owner's own bookkeeping/accounting. */
shopRouter.get(
  '/history.csv',
  requireShopUser,
  asyncHandler(async (req, res) => {
    const jobs = await prisma.job.findMany({
      where: { shopId: req.shopUser!.shopId, status: { in: ['completed', 'expired', 'cancelled'] } },
      orderBy: { updatedAt: 'desc' },
      take: 1000,
      select: {
        updatedAt: true,
        student: { select: { name: true, phone: true } },
        file: { select: { originalName: true } },
        assignedPrinter: { select: { label: true } },
        status: true,
        totalPaise: true,
        discountPaise: true,
        paymentStatus: true,
      },
    });

    const header = ['Date', 'Student', 'File', 'Printer', 'Status', 'Amount (INR)', 'Discount (INR)', 'Payment'];
    const rows = jobs.map((j) =>
      [
        j.updatedAt.toISOString(),
        j.student.name ?? maskPhone(j.student.phone),
        j.file.originalName,
        j.assignedPrinter?.label ?? '',
        j.status,
        (j.totalPaise / 100).toFixed(2),
        (j.discountPaise / 100).toFixed(2),
        j.paymentStatus,
      ]
        .map(csvCell)
        .join(','),
    );
    const csv = [header.join(','), ...rows].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="printq-history.csv"');
    res.send(csv);
  }),
);

/** A downloadable receipt for the shop's own record of a job. */
shopRouter.get(
  '/jobs/:id/receipt',
  requireShopUser,
  asyncHandler(async (req, res) => {
    const job = await prisma.job.findFirst({
      where: { id: param(req, 'id'), shopId: req.shopUser!.shopId },
      include: { shop: true, student: true, file: true },
    });
    if (!job) throw notFound();

    const pdf = await renderReceipt({
      jobId: job.id,
      createdAt: job.createdAt,
      shopName: job.shop.name,
      shopAddress: job.shop.address,
      studentLabel: job.student.name ?? maskPhone(job.student.phone),
      fileName: job.file.originalName,
      specs: job.specs as unknown as JobSpecs,
      breakdown: job.priceBreakdown as unknown as PriceBreakdown,
      totalPaise: job.totalPaise,
      paymentStatus: job.paymentStatus,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="printq-receipt-${job.id.slice(0, 8)}.pdf"`);
    res.send(Buffer.from(pdf));
  }),
);

/** Prepared orders, live arrivals and in-flight work for the counter dashboard. */
shopRouter.get(
  '/queue',
  requireShopUser,
  asyncHandler(async (req, res) => {
    const shopId = req.shopUser!.shopId;
    const jobs = await prisma.job.findMany({
      where: {
        shopId,
        status: { in: ['awaiting_arrival', 'queued', 'notified', 'otp_verified', 'printing', 'finishing', 'ready_for_pickup'] },
      },
      orderBy: [{ queuedAt: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        status: true,
        mode: true,
        scheduledTime: true,
        specs: true,
        pagesPerCopy: true,
        totalPaise: true,
        paymentStatus: true,
        paymentProvider: true,
        cashCollectedAt: true,
        assignedPrinterId: true,
        otpExpiresAt: true,
        printError: true,
        printAttempts: true,
        queuedAt: true,
        arrivedAt: true,
        checkInCount: true,
        createdAt: true,
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
    const { otp, printerId, overrideQueue, cashReceived } = req.body as {
      otp: string;
      printerId?: string;
      overrideQueue: boolean;
      cashReceived: boolean;
    };
    const result = await releaseByOtp(
      req.shopUser!.shopId,
      otp,
      req.shopUser!.id,
      printerId,
      overrideQueue,
      cashReceived,
    );
    if (!result.ok) {
      res.status(200).json({
        requiresManualAssignment: result.requiresManualAssignment,
        requiresQueueOverride: result.requiresQueueOverride,
        requiresCashConfirmation: result.requiresCashConfirmation,
        cashAmountPaise: result.cashAmountPaise,
        selectedPrinterId: result.selectedPrinterId,
        position: result.position,
        queueStatus: result.queueStatus,
        jobId: result.job?.id,
        eligiblePrinters: result.eligiblePrinters,
      });
      return;
    }
    res.json({ ok: true, job: { id: result.job!.id, status: result.job!.status } });
  }),
);

/** Remove an absent student from the advisory line; their paid order remains usable. */
shopRouter.post(
  '/jobs/:id/no-show',
  requireShopUser,
  asyncHandler(async (req, res) => {
    const job = await removeFromLiveQueue(param(req, 'id'), req.shopUser!.shopId, req.shopUser!.id);
    res.json({ ok: true, job: { id: job.id, status: job.status } });
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
    const recommendation = await recommendPrinter(
      shopId,
      job.specs as unknown as JobSpecs,
      job.pagesPerCopy,
      job.id,
    );
    if (!recommendation.eligible.some((entry) => entry.printerId === printer.id)) {
      throw conflict('That printer is offline or cannot produce this job');
    }

    await prisma.job.update({ where: { id: job.id }, data: { assignedPrinterId: printerId } });
    await advancePrinterQueue(printerId, shopId);
    await emitQueueUpdate(shopId);
    res.json({ ok: true });
  }),
);

/** Retry a failed print without asking the student for a second OTP. */
shopRouter.post(
  '/jobs/:id/retry-print',
  requireShopUser,
  validateBody(z.object({ printerId: z.string().uuid().optional() })),
  asyncHandler(async (req, res) => {
    const shopId = req.shopUser!.shopId;
    const job = await prisma.job.findFirst({ where: { id: param(req, 'id'), shopId } });
    if (!job) throw notFound();
    if (job.status !== 'otp_verified') throw conflict('This job is not waiting for a print retry');

    const recommendation = await recommendPrinter(
      shopId,
      job.specs as unknown as JobSpecs,
      job.pagesPerCopy,
      job.id,
    );
    const requested = (req.body as { printerId?: string }).printerId;
    const printerId = requested ??
      (recommendation.eligible.some((entry) => entry.printerId === job.assignedPrinterId)
        ? job.assignedPrinterId
        : recommendation.recommended?.printerId);
    if (!printerId || !recommendation.eligible.some((entry) => entry.printerId === printerId)) {
      throw conflict('No compatible online printer is available');
    }

    const updated = await prisma.job.update({
      where: { id: job.id },
      data: { assignedPrinterId: printerId, claimedByAgentId: null, printError: null },
    });
    await dispatchJob(updated, { type: 'shop', id: req.shopUser!.id });
    publishEvent(`shop:${shopId}`, 'queue:retry_dispatched', { jobId: updated.id, printerId });
    res.json({ ok: true, job: { id: updated.id, status: updated.status, printerId } });
  }),
);

/** Close a collected-cash order only after staff physically returns the cash. */
shopRouter.post(
  '/jobs/:id/cash-returned',
  requireShopUser,
  asyncHandler(async (req, res) => {
    const shopId = req.shopUser!.shopId;
    const job = await prisma.job.findFirst({ where: { id: param(req, 'id'), shopId } });
    if (!job) throw notFound();
    if (
      job.paymentProvider !== 'cash'
      || job.paymentStatus !== 'paid'
      || !job.cashCollectedAt
      || job.status !== 'otp_verified'
    ) {
      throw conflict('This cash order cannot be closed in its current state');
    }

    const updated = await applyTransition(
      job.id,
      'otp_verified',
      'CASH_RETURNED',
      { type: 'shop', id: req.shopUser!.id },
      { paymentStatus: 'refunded', claimedByAgentId: null, printError: null },
    );
    if (!updated) throw conflict('Job state changed, try again');
    await prisma.paymentEvent.upsert({
      where: { providerEventId: `cash_returned_${job.id}` },
      create: {
        provider: 'cash',
        providerEventId: `cash_returned_${job.id}`,
        jobId: job.id,
        payload: { cashReturned: true, returnedByShopUserId: req.shopUser!.id },
      },
      update: {},
    });
    await scheduleFileDeletion(job.fileId);
    await notifyStudent(job.studentId, {
      title: 'Cash returned — order closed',
      body: 'The shop could not complete this print and returned your cash. The order has been cancelled.',
      url: `/jobs/${job.id}`,
    });
    publishEvent(`student:${job.studentId}`, 'job:update', { jobId: job.id, status: 'cancelled' });
    await emitQueueUpdate(shopId);
    res.json({ ok: true, job: { id: updated.id, status: updated.status, paymentStatus: updated.paymentStatus } });
  }),
);

/** Confirm hand-finished binding/stapling before telling the student to collect. */
shopRouter.post(
  '/jobs/:id/finishing-complete',
  requireShopUser,
  asyncHandler(async (req, res) => {
    const shopId = req.shopUser!.shopId;
    const job = await prisma.job.findFirst({ where: { id: param(req, 'id'), shopId } });
    if (!job) throw notFound();
    if (job.status !== 'finishing') throw conflict('This job is not waiting for manual finishing');

    const updated = await applyTransition(job.id, 'finishing', 'FINISHING_COMPLETED', {
      type: 'shop',
      id: req.shopUser!.id,
    });
    if (!updated) throw conflict('Job state changed, try again');

    await creditPrintEarning(updated.id);
    await notifyStudent(job.studentId, {
      title: 'Print ready ✓',
      body: 'Printing and finishing are complete. Collect it at the counter.',
      url: `/jobs/${job.id}`,
    });
    publishEvent(`student:${job.studentId}`, 'job:update', { jobId: job.id, status: 'ready_for_pickup' });
    publishEvent(`shop:${shopId}`, 'queue:job_ready', { jobId: job.id });
    res.json({ ok: true, job: { id: updated.id, status: updated.status } });
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

    await scheduleFileDeletion(job.fileId);
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
    const shopId = req.shopUser!.shopId;
    const printer = await prisma.printer.create({
      data: { ...(req.body as object), shopId } as never,
    });
    if (printer.osPrinterName) {
      await connectPrinterToDetectingAgents(shopId, printer.id, printer.osPrinterName);
      await advanceShopQueues(shopId);
      await notifyShopReopened(shopId);
    }
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
    const otherOnlineBefore = await prisma.printer.count({
      where: { shopId, id: { not: existing.id }, status: 'online' },
    });
    const printer = await prisma.printer.update({
      where: { id: existing.id },
      data: req.body as object,
    });
    // a printer coming online may unblock its queue
    if (printer.status === 'online') {
      await advancePrinterQueue(printer.id, shopId);
      // shop was fully closed and just came back online — tell anyone waiting
      if (existing.status !== 'online' && otherOnlineBefore === 0) await notifyShopReopened(shopId);
    }

    // linking to an OS printer name: any agent that already sees that name on
    // its PC is reachable from here — auto-add without a manual chip-pick.
    if (printer.osPrinterName) {
      await connectPrinterToDetectingAgents(shopId, printer.id, printer.osPrinterName);
      await advanceShopQueues(shopId);
      await notifyShopReopened(shopId);
    }

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
      where: { assignedPrinterId: existing.id, status: { in: ['queued', 'notified', 'otp_verified', 'printing', 'finishing'] } },
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
        detectedPrinters: true,
        detectedAt: true,
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

// ---------- Staff management (owner-only) ----------

shopRouter.get(
  '/staff',
  requireShopOwner,
  asyncHandler(async (req, res) => {
    const staff = await prisma.shopUser.findMany({
      where: { shopId: req.shopUser!.shopId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, email: true, name: true, role: true, createdAt: true },
    });
    res.json({ staff });
  }),
);

/** Counter staff get a short PIN instead of a full password — fast login on a shared PC. */
shopRouter.post(
  '/staff',
  requireShopOwner,
  validateBody(createStaffSchema),
  asyncHandler(async (req, res) => {
    const { email, name, pin } = req.body as { email: string; name: string; pin: string };
    const existing = await prisma.shopUser.findUnique({ where: { email } });
    if (existing) throw badRequest('An account with this email already exists');

    const staff = await prisma.shopUser.create({
      data: {
        shopId: req.shopUser!.shopId,
        email,
        name,
        role: 'staff',
        passwordHash: await argon2.hash(pin, { type: argon2.argon2id }),
      },
      select: { id: true, email: true, name: true, role: true, createdAt: true },
    });
    res.status(201).json({ staff });
  }),
);

shopRouter.delete(
  '/staff/:id',
  requireShopOwner,
  asyncHandler(async (req, res) => {
    const shopId = req.shopUser!.shopId;
    const staff = await prisma.shopUser.findFirst({ where: { id: param(req, 'id'), shopId } });
    if (!staff) throw notFound();
    if (staff.role === 'owner') throw conflict('The owner account can\'t be removed');
    await prisma.shopUser.delete({ where: { id: staff.id } });
    res.json({ ok: true });
  }),
);
