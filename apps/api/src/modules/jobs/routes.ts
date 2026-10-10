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
import { advancePrinterQueue, checkInJob, emitQueueUpdate, getJobLiveMetrics, preparePayAtShopOrder, requeueJob } from '../queue/engine.js';
import { refundIfPaid } from '../payments/refund.js';
import { renderReceipt } from '../../lib/receipt.js';
import { resolveCoupon, redeemCoupon } from './coupons.js';
import { applyTransition } from './transitions.js';
import { ACTIVE_FILE_JOB_STATUSES, assertFileCanBackNewJob, scheduleFileDeletion } from '../../lib/fileRetention.js';
import {
  claimIdempotency,
  completeIdempotency,
  parseIdempotencyKey,
  releaseIdempotency,
  tryLock,
  unlock,
} from '../../lib/idempotency.js';

const DUPLICATE_ORDER_MESSAGE =
  'You already have an active order for this file. Open it from My jobs, or upload the file again for a new order.';
import { z } from 'zod';
import { decryptReleaseCode } from '../../lib/otp.js';
import { env } from '../../config/env.js';
import { isShopOperational } from '../shops/availability.js';
import { isCounterCodeAvailable } from '../queue/visibility.js';
import { STUDENT_PRINT_PROBLEM_MESSAGE } from '../../lib/printProblem.js';

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
 * Create a prepared pay-at-shop job. Uploading creates no physical position;
 * location check-in does, and only authenticated counter staff can confirm
 * the final server-calculated amount before a printer receives the document.
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
    const studentId = req.student!.id;
    // Double-submit protection, two independent layers:
    //  1. optional Idempotency-Key (one UUID per "Prepare order" attempt): a
    //     repeat replays the first result instead of creating another job;
    //  2. a per student+file+shop guard: one ACTIVE order per file, enforced
    //     under a short lock (and re-checked in the DB) even without a key.
    const idemKey = parseIdempotencyKey(req.headers['idempotency-key']);
    if (idemKey) {
      const claim = await claimIdempotency(studentId, idemKey);
      if (claim.state === 'replay') {
        const existing = await prisma.job.findFirst({
          where: { id: claim.resultId, studentId },
          select: { id: true, totalPaise: true },
        });
        if (existing) {
          res.status(200).json({
            job: { id: existing.id, status: 'awaiting_arrival', totalPaise: existing.totalPaise },
            checkout: { mode: 'pay_at_shop', amountPaise: existing.totalPaise },
          });
          return;
        }
      } else if (claim.state === 'in_flight') {
        throw conflict(DUPLICATE_ORDER_MESSAGE);
      }
    }
    const lockName = `job-create:${studentId}:${fileId}`;
    if (!(await tryLock(lockName))) {
      if (idemKey) await releaseIdempotency(studentId, idemKey);
      throw conflict(DUPLICATE_ORDER_MESSAGE);
    }
    try {
      const created = await createPreparedJob();
      if (idemKey) await completeIdempotency(studentId, idemKey, created.job.id);
      res.status(201).json(created);
    } catch (err) {
      if (idemKey) await releaseIdempotency(studentId, idemKey);
      throw err;
    } finally {
      await unlock(lockName);
    }

    async function createPreparedJob() {
    const file = await prisma.uploadedFile.findFirst({
      where: { id: fileId, studentId, status: 'ready' },
      include: { shop: true },
    });
    if (!file || file.pages == null) throw notFound('File not ready');
    // one active order per student+file+shop
    const active = await prisma.job.findFirst({
      where: {
        studentId,
        fileId: file.id,
        shopId: file.shopId,
        status: { in: [...ACTIVE_FILE_JOB_STATUSES] },
      },
      select: { id: true },
    });
    if (active) throw conflict(DUPLICATE_ORDER_MESSAGE);
    // reference-counted file semantics: see fileRetention.ts
    await assertFileCanBackNewJob(file);

    if (!(await isShopOperational(file.shopId))) {
      throw conflict('This shop has paused new orders or has no connected printer. Try again when it reopens.');
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
        paymentProvider: 'pay_at_shop',
      },
    });
    if (resolvedCouponCode) await redeemCoupon(resolvedCouponCode);

    await preparePayAtShopOrder(job.id);
    return {
      job: { id: job.id, status: 'awaiting_arrival' as const, totalPaise: job.totalPaise },
      checkout: { mode: 'pay_at_shop' as const, amountPaise: job.totalPaise },
    };
    }
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
        revealedAt: true,
        absentAt: true,
        otpExpiresAt: true,
        noShowCount: true,
        arrivedAt: true,
        checkInCount: true,
        assignedPrinterId: true,
        paymentStatus: true,
        printError: true,
        printAttempts: true,
        rating: true,
        shop: {
          select: {
            name: true,
            slug: true,
            address: true,
            counterUpiVpa: true,
            counterUpiPayeeName: true,
            counterUpiVerifiedAt: true,
          },
        },
        file: { select: { originalName: true, pages: true } },
      },
    });
    if (!job) throw notFound();
    const live = await getJobLiveMetrics(job.id);
    const { releaseCodeEncrypted, shopId, revealedAt, absentAt, shop, printError, ...safeJob } = job;
    const safeShop = {
      name: shop.name,
      slug: shop.slug,
      address: shop.address,
      counterUpi: shop.counterUpiVerifiedAt && shop.counterUpiVpa && shop.counterUpiPayeeName
        ? { vpa: shop.counterUpiVpa, payeeName: shop.counterUpiPayeeName }
        : null,
    };
    // The code is decrypted only in the revealed band (or when ready for
    // pickup). Arriving/waiting/absent responses never carry it.
    const codeVisible = isCounterCodeAvailable(job.status, revealedAt)
      && (job.status === 'ready_for_pickup' || live.band === 'revealed');
    const checkInOpensAt = job.mode === 'scheduled' && job.scheduledTime
      ? new Date(job.scheduledTime.getTime() - env.SCHEDULE_LEAD_MINUTES * 60_000).toISOString()
      : null;
    res.json({
      job: {
        ...safeJob,
        // Raw agent/driver text is never exposed: a fixed, friendly student message only.
        printError: printError ? STUDENT_PRINT_PROBLEM_MESSAGE : null,
        shop: safeShop,
        ...live,
        otpCode: codeVisible ? decryptReleaseCode(shopId, releaseCodeEncrypted) : null,
        counterCodeAvailable: codeVisible,
        // Missed turn: back in awaiting_arrival, must check in again to get a new place.
        absent: absentAt !== null && job.status === 'awaiting_arrival',
        // A scheduled order cannot check in before its window opens (the
        // server refuses it), so don't advertise the action until then.
        canCheckIn: ['paid', 'counter_due', 'cash_due'].includes(job.paymentStatus)
          && ['awaiting_arrival', 'no_show', 'requeued'].includes(job.status)
          && (checkInOpensAt === null || Date.parse(checkInOpensAt) <= Date.now()),
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
    // A receipt is proof of payment: never issue one while the order is merely
    // prepared (counter_due) or unpaid. Staff confirming payment flips this.
    if (job.paymentStatus !== 'paid') {
      throw conflict('Your receipt is available once the shop confirms your payment.');
    }

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
    const { live, ...job } = await checkInJob(param(req, 'id'), req.student!.id, req.body as z.infer<typeof checkInSchema>);
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
    if (job.paymentProvider === 'pay_at_shop' && job.paymentStatus === 'paid') {
      throw conflict('Counter payment has been confirmed. Ask shop staff or PrintQs support to record an auditable refund.');
    }
    const updated = await applyTransition(
      job.id,
      job.status,
      'CANCEL',
      { type: 'student', id: req.student!.id },
      ['counter_due', 'cash_due'].includes(job.paymentStatus)
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
