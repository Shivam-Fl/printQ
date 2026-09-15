import { Router } from 'express';
import {
  applyCoupon,
  applyPlatformMarkup,
  computePrice,
  couponCodeSchema,
  createJobSchema,
  jobSpecsSchema,
  type JobSpecs,
  type PriceBreakdown,
} from '@printq/shared';
import { shopOptions } from '../../lib/shopOptions.js';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, badRequest, conflict, notFound } from '../../lib/errors.js';
import { param } from '../../lib/http.js';
import { requireStudent } from '../../middleware/auth.js';
import { validateBody } from '../../middleware/validate.js';
import { paymentProvider } from '../../providers/payment/index.js';
import { advancePrinterQueue, checkInJob, emitQueueUpdate, getJobLiveMetrics, onCashSelected, requeueJob } from '../queue/engine.js';
import { refundIfPaid } from '../payments/refund.js';
import { renderReceipt } from '../../lib/receipt.js';
import { resolveCoupon, redeemCoupon } from './coupons.js';
import { applyTransition } from './transitions.js';
import { scheduleFileDeletion } from '../../lib/fileRetention.js';
import { z } from 'zod';
import { decryptReleaseCode } from '../../lib/otp.js';
import { env } from '../../config/env.js';
import { isShopOperational } from '../shops/availability.js';
import { isCounterCodeAvailable } from '../queue/visibility.js';
import { getProjectedCashSettlementBalance } from '../earnings/service.js';

export const jobsRouter = Router();

const checkInSchema = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  accuracyM: z.number().finite().min(0).max(1_000),
  measuredAt: z.coerce.date(),
});

/** Live price quote — server-computed from the shop's rate card, never client math. */
jobsRouter.post(
  '/quote',
  requireStudent,
  validateBody(z.object({ fileId: z.string().uuid(), specs: jobSpecsSchema, couponCode: couponCodeSchema.optional() })),
  asyncHandler(async (req, res) => {
    const { fileId, specs, couponCode } = req.body as { fileId: string; specs: JobSpecs; couponCode?: string };
    const file = await prisma.uploadedFile.findFirst({
      where: { id: fileId, studentId: req.student!.id, status: 'ready' },
      include: { shop: true },
    });
    if (!file || file.pages == null) throw notFound('File not ready');
    if (!(await isShopOperational(file.shopId))) {
      throw conflict('This shop has paused new orders or has no connected printer. Try again when it reopens.');
    }

    let breakdown = applyPlatformMarkup(
      computePrice(specs, file.pages, shopOptions(file.shop)),
      env.PLATFORM_MARKUP_BPS,
    );
    if (couponCode) breakdown = applyCoupon(breakdown, await resolveCoupon(couponCode, file.shopId));
    // Student-facing pricing is intentionally one final amount. The shop base,
    // platform markup and line-item split remain private server-side data.
    res.json({ quote: { pagesPerCopy: breakdown.pagesPerCopy, totalPaise: breakdown.totalPaise }, pages: file.pages });
  }),
);

/**
 * Create a job (pending_payment) + a payment order. The job only enters the
 * queue when payment is confirmed server-side (webhook / mock confirm).
 */
jobsRouter.post(
  '/',
  requireStudent,
  validateBody(createJobSchema),
  asyncHandler(async (req, res) => {
    const { fileId, specs, mode, scheduledTime, couponCode, paymentMethod } = req.body as {
      fileId: string;
      specs: JobSpecs;
      mode: 'instant' | 'scheduled';
      scheduledTime?: Date;
      couponCode?: string;
      paymentMethod: 'online' | 'cash';
    };
    const file = await prisma.uploadedFile.findFirst({
      where: { id: fileId, studentId: req.student!.id, status: 'ready' },
      include: { shop: true },
    });
    if (!file || file.pages == null) throw notFound('File not ready');

    if (!(await isShopOperational(file.shopId))) {
      throw conflict('This shop has paused new orders or has no connected printer. Try again when it reopens.');
    }
    if (paymentMethod === 'cash' && !file.shop.cashPaymentsEnabled) {
      throw conflict('This shop is not accepting cash orders. Pay online or ask the shop to enable cash.');
    }
    if (paymentMethod === 'cash') {
      const existingCashOrder = await prisma.job.count({
        where: {
          shopId: file.shopId,
          studentId: req.student!.id,
          paymentProvider: 'cash',
          paymentStatus: 'cash_due',
          status: { notIn: ['completed', 'expired', 'cancelled'] },
        },
      });
      if (existingCashOrder > 0) {
        throw conflict('Finish or cancel your existing cash order at this shop before creating another.');
      }
    }

    const shopBase = computePrice(specs, file.pages, shopOptions(file.shop));
    let breakdown = applyPlatformMarkup(shopBase, env.PLATFORM_MARKUP_BPS);
    const platformMarkupPaise = breakdown.totalPaise - shopBase.totalPaise;
    let resolvedCouponCode: string | null = null;
    if (couponCode) {
      const resolved = await resolveCoupon(couponCode, file.shopId);
      breakdown = applyCoupon(breakdown, resolved);
      resolvedCouponCode = resolved.code;
    }
    if (breakdown.totalPaise < 100) throw badRequest('Minimum order is ₹1');
    if (paymentMethod === 'cash') {
      const projectedBalance = await getProjectedCashSettlementBalance(file.shopId);
      const thisOrderSettlement = shopBase.totalPaise - breakdown.totalPaise;
      if (projectedBalance + thisOrderSettlement < -env.MAX_SHOP_CASH_DEBT_PAISE) {
        throw conflict('Cash is temporarily unavailable at this shop. Pay online while the shop settles its cash balance.');
      }
    }

    const job = await prisma.job.create({
      data: {
        shopId: file.shopId,
        studentId: req.student!.id,
        fileId: file.id,
        specs: specs as object,
        pagesPerCopy: breakdown.pagesPerCopy,
        priceBreakdown: breakdown as unknown as object,
        totalPaise: breakdown.totalPaise,
        shopBasePaise: shopBase.totalPaise,
        platformMarkupPaise,
        platformDiscountPaise: breakdown.discountPaise,
        couponCode: resolvedCouponCode,
        discountPaise: breakdown.discountPaise,
        mode,
        scheduledTime: mode === 'scheduled' ? scheduledTime : null,
        paymentProvider: paymentMethod === 'cash' ? 'cash' : null,
      },
    });
    if (resolvedCouponCode) await redeemCoupon(resolvedCouponCode);

    if (paymentMethod === 'cash') {
      await onCashSelected(job.id);
      res.status(201).json({
        job: { id: job.id, status: 'awaiting_arrival', totalPaise: job.totalPaise },
        checkout: { mode: 'cash', amountPaise: job.totalPaise },
      });
      return;
    }

    const order = await paymentProvider.createOrder(job.id, breakdown.totalPaise, 'print_job');
    await prisma.job.update({
      where: { id: job.id },
      data: { paymentProvider: order.provider, paymentOrderId: order.providerOrderId },
    });

    res.status(201).json({
      job: { id: job.id, status: job.status, totalPaise: job.totalPaise },
      checkout: order.checkout,
    });
  }),
);

/** Student's jobs (own only — ownership in the WHERE clause). */
jobsRouter.get(
  '/',
  requireStudent,
  asyncHandler(async (req, res) => {
    const jobs = await prisma.job.findMany({
      where: { studentId: req.student!.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        status: true,
        totalPaise: true,
        pagesPerCopy: true,
        specs: true,
        mode: true,
        scheduledTime: true,
        arrivedAt: true,
        checkInCount: true,
        createdAt: true,
        otpExpiresAt: true,
        noShowCount: true,
        shop: { select: { name: true, slug: true, address: true } },
        file: { select: { originalName: true } },
      },
    });
    res.json({ jobs });
  }),
);

jobsRouter.get(
  '/:id',
  requireStudent,
  asyncHandler(async (req, res) => {
    const job = await prisma.job.findFirst({
      where: { id: param(req, 'id'), studentId: req.student!.id },
      select: {
        id: true,
        shopId: true,
        status: true,
        totalPaise: true,
        specs: true,
        mode: true,
        scheduledTime: true,
        createdAt: true,
        releaseCodeEncrypted: true,
        nearFrontNotifiedAt: true,
        otpExpiresAt: true,
        noShowCount: true,
        arrivedAt: true,
        checkInCount: true,
        assignedPrinterId: true,
        paymentStatus: true,
        paymentProvider: true,
        cashCollectedAt: true,
        printError: true,
        printAttempts: true,
        rating: true,
        shop: { select: { name: true, slug: true, address: true } },
        file: { select: { originalName: true, pages: true } },
      },
    });
    if (!job) throw notFound();
    const live = await getJobLiveMetrics(job.id);
    const { releaseCodeEncrypted, shopId, nearFrontNotifiedAt, ...safeJob } = job;
    const codeVisible = isCounterCodeAvailable(
      job.status,
      live.position,
      env.NEAR_FRONT_THRESHOLD,
      nearFrontNotifiedAt !== null,
    );
    const checkInOpensAt = job.mode === 'scheduled' && job.scheduledTime
      ? new Date(job.scheduledTime.getTime() - env.SCHEDULE_LEAD_MINUTES * 60_000).toISOString()
      : null;
    res.json({
      job: {
        ...safeJob,
        ...live,
        otpCode: codeVisible ? decryptReleaseCode(shopId, releaseCodeEncrypted) : null,
        counterCodeAvailable: codeVisible,
        counterCodeThreshold: env.NEAR_FRONT_THRESHOLD,
        canCheckIn: ['paid', 'cash_due'].includes(job.paymentStatus) && ['awaiting_arrival', 'no_show'].includes(job.status),
        checkInOpensAt,
      },
    });
  }),
);

/** A downloadable receipt for the student's own job. */
jobsRouter.get(
  '/:id/receipt',
  requireStudent,
  asyncHandler(async (req, res) => {
    const job = await prisma.job.findFirst({
      where: { id: param(req, 'id'), studentId: req.student!.id },
      include: { shop: true, student: true, file: true },
    });
    if (!job) throw notFound();

    const pdf = await renderReceipt({
      jobId: job.id,
      createdAt: job.createdAt,
      shopName: job.shop.name,
      shopAddress: job.shop.address,
      studentLabel: job.student.name ?? job.student.phone,
      fileName: job.file.originalName,
      specs: job.specs as unknown as JobSpecs,
      breakdown: job.priceBreakdown as unknown as PriceBreakdown,
      totalPaise: job.totalPaise,
      paymentStatus: job.paymentStatus,
      showPriceBreakdown: false,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="printq-receipt-${job.id.slice(0, 8)}.pdf"`);
    res.send(Buffer.from(pdf));
  }),
);

/** Student confirms physical arrival; only then does queue time start. */
jobsRouter.post(
  '/:id/check-in',
  requireStudent,
  validateBody(checkInSchema),
  asyncHandler(async (req, res) => {
    const job = await checkInJob(param(req, 'id'), req.student!.id, req.body as z.infer<typeof checkInSchema>);
    const live = await getJobLiveMetrics(job.id);
    res.json({ job: { id: job.id, status: job.status, ...live } });
  }),
);

/** Compatibility path for jobs created under the old timed no-show model. */
jobsRouter.post(
  '/:id/requeue',
  requireStudent,
  asyncHandler(async (req, res) => {
    const job = await requeueJob(param(req, 'id'), req.student!.id);
    res.json({ job: { id: job.id, status: 'queued' } });
  }),
);

/** Cancel before the print is released. Prepared remote orders are refundable. */
jobsRouter.post(
  '/:id/cancel',
  requireStudent,
  asyncHandler(async (req, res) => {
    const job = await prisma.job.findFirst({
      where: { id: param(req, 'id'), studentId: req.student!.id },
    });
    if (!job) throw notFound();
    if (
      job.status !== 'awaiting_arrival' &&
      job.status !== 'queued' &&
      job.status !== 'notified' &&
      job.status !== 'pending_payment'
    ) {
      throw conflict('Job can no longer be cancelled');
    }
    const updated = await applyTransition(
      job.id,
      job.status,
      'CANCEL',
      { type: 'student', id: req.student!.id },
      job.paymentProvider === 'cash' && job.paymentStatus === 'cash_due'
        ? { paymentStatus: 'failed' }
        : {},
    );
    if (!updated) throw conflict('Job state changed, try again');
    await refundIfPaid(job);
    await scheduleFileDeletion(job.fileId);
    // a cancelled front job must not block the printer's queue
    if (job.assignedPrinterId) await advancePrinterQueue(job.assignedPrinterId, job.shopId);
    await emitQueueUpdate(job.shopId);
    res.json({ job: { id: job.id, status: updated.status } });
  }),
);

const rateJobSchema = z.object({
  rating: z.number().int().min(1).max(5),
  reviewText: z.string().trim().max(500).optional(),
});

/** A student rates a completed job — settable once. */
jobsRouter.post(
  '/:id/rating',
  requireStudent,
  validateBody(rateJobSchema),
  asyncHandler(async (req, res) => {
    const { rating, reviewText } = req.body as { rating: number; reviewText?: string };
    const job = await prisma.job.findFirst({ where: { id: param(req, 'id'), studentId: req.student!.id } });
    if (!job) throw notFound();
    if (job.status !== 'completed') throw conflict('Only a completed job can be rated');
    if (job.rating != null) throw conflict('This job has already been rated');

    await prisma.job.update({
      where: { id: job.id },
      data: { rating, reviewText: reviewText ?? null },
    });
    res.json({ ok: true });
  }),
);
