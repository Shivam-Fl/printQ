import { Router } from 'express';
import {
  applyCoupon,
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
import { advancePrinterQueue, emitQueueUpdate, requeueJob } from '../queue/engine.js';
import { refundIfPaid } from '../payments/refund.js';
import { renderReceipt } from '../../lib/receipt.js';
import { resolveCoupon, redeemCoupon } from './coupons.js';
import { applyTransition } from './transitions.js';
import { z } from 'zod';

export const jobsRouter = Router();

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

    let breakdown = computePrice(specs, file.pages, shopOptions(file.shop));
    if (couponCode) breakdown = applyCoupon(breakdown, await resolveCoupon(couponCode, file.shopId));
    res.json({ quote: breakdown, pages: file.pages });
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
    const { fileId, specs, mode, scheduledTime, couponCode } = req.body as {
      fileId: string;
      specs: JobSpecs;
      mode: 'instant' | 'scheduled';
      scheduledTime?: Date;
      couponCode?: string;
    };
    const file = await prisma.uploadedFile.findFirst({
      where: { id: fileId, studentId: req.student!.id, status: 'ready' },
      include: { shop: true },
    });
    if (!file || file.pages == null) throw notFound('File not ready');

    let breakdown = computePrice(specs, file.pages, shopOptions(file.shop));
    let resolvedCouponCode: string | null = null;
    if (couponCode) {
      const resolved = await resolveCoupon(couponCode, file.shopId);
      breakdown = applyCoupon(breakdown, resolved);
      resolvedCouponCode = resolved.code;
    }
    if (breakdown.totalPaise < 100) throw badRequest('Minimum order is ₹1');

    const job = await prisma.job.create({
      data: {
        shopId: file.shopId,
        studentId: req.student!.id,
        fileId: file.id,
        specs: specs as object,
        pagesPerCopy: breakdown.pagesPerCopy,
        priceBreakdown: breakdown as unknown as object,
        totalPaise: breakdown.totalPaise,
        couponCode: resolvedCouponCode,
        discountPaise: breakdown.discountPaise,
        mode,
        scheduledTime: mode === 'scheduled' ? scheduledTime : null,
      },
    });
    if (resolvedCouponCode) await redeemCoupon(resolvedCouponCode);

    const order = await paymentProvider.createOrder(job.id, breakdown.totalPaise);
    await prisma.job.update({
      where: { id: job.id },
      data: { paymentProvider: order.provider, paymentOrderId: order.providerOrderId },
    });

    res.status(201).json({
      job: { id: job.id, status: job.status, totalPaise: job.totalPaise, breakdown },
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
        status: true,
        totalPaise: true,
        priceBreakdown: true,
        specs: true,
        mode: true,
        scheduledTime: true,
        createdAt: true,
        // the release OTP belongs to this student — shown in-app while active
        otpCode: true,
        otpExpiresAt: true,
        noShowCount: true,
        assignedPrinterId: true,
        paymentStatus: true,
        rating: true,
        shop: { select: { name: true, slug: true, address: true } },
        file: { select: { originalName: true, pages: true } },
      },
    });
    if (!job) throw notFound();
    res.json({ job: { ...job, otpCode: job.status === 'notified' ? job.otpCode : null } });
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
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="printq-receipt-${job.id.slice(0, 8)}.pdf"`);
    res.send(Buffer.from(pdf));
  }),
);

/** One free requeue after a no-show (printQ.md §5.3). */
jobsRouter.post(
  '/:id/requeue',
  requireStudent,
  asyncHandler(async (req, res) => {
    const job = await requeueJob(param(req, 'id'), req.student!.id);
    res.json({ job: { id: job.id, status: 'queued' } });
  }),
);

/** Cancel before the print is released (queued/notified only). */
jobsRouter.post(
  '/:id/cancel',
  requireStudent,
  asyncHandler(async (req, res) => {
    const job = await prisma.job.findFirst({
      where: { id: param(req, 'id'), studentId: req.student!.id },
    });
    if (!job) throw notFound();
    if (job.status !== 'queued' && job.status !== 'notified' && job.status !== 'pending_payment') {
      throw conflict('Job can no longer be cancelled');
    }
    const updated = await applyTransition(job.id, job.status, 'CANCEL', {
      type: 'student',
      id: req.student!.id,
    });
    if (!updated) throw conflict('Job state changed, try again');
    await refundIfPaid(job);
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
