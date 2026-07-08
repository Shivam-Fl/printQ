import { Router, raw } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { asyncHandler, badRequest, notFound } from '../../lib/errors.js';
import { requireStudent } from '../../middleware/auth.js';
import { validateBody } from '../../middleware/validate.js';
import { verifyRazorpayWebhookSignature } from '../../providers/payment/index.js';
import { onPaymentConfirmed } from '../queue/engine.js';

export const paymentsRouter = Router();

/**
 * Webhook router — mounted BEFORE the global express.json() so the raw bytes
 * survive for signature verification.
 */
export const webhookRouter = Router();

/**
 * Razorpay webhook — the ONLY path that marks a real payment as paid.
 * Client-side checkout callbacks are never trusted.
 */
webhookRouter.post(
  '/razorpay',
  raw({ type: 'application/json' }),
  asyncHandler(async (req, res) => {
    const signature = req.headers['x-razorpay-signature'];
    if (typeof signature !== 'string' || !verifyRazorpayWebhookSignature(req.body as Buffer, signature)) {
      logger.warn('razorpay_webhook_bad_signature');
      res.status(400).json({ error: 'Invalid signature' });
      return;
    }

    const eventId = req.headers['x-razorpay-event-id'];
    const payload = JSON.parse((req.body as Buffer).toString('utf8')) as {
      event: string;
      payload?: { payment?: { entity?: { id?: string; order_id?: string } } };
    };

    // idempotency: a webhook can fire more than once for the same event
    if (typeof eventId === 'string') {
      const existing = await prisma.paymentEvent.findUnique({ where: { providerEventId: eventId } });
      if (existing) {
        res.json({ ok: true, duplicate: true });
        return;
      }
    }

    if (payload.event === 'payment.captured') {
      const payment = payload.payload?.payment?.entity;
      const orderId = payment?.order_id;
      const job = orderId
        ? await prisma.job.findUnique({ where: { paymentOrderId: orderId } })
        : null;

      await prisma.paymentEvent.create({
        data: {
          provider: 'razorpay',
          providerEventId: typeof eventId === 'string' ? eventId : `rzp_${payment?.id ?? Date.now()}`,
          jobId: job?.id ?? null,
          payload: payload as object,
        },
      });

      if (job) {
        await prisma.job.update({ where: { id: job.id }, data: { paymentId: payment?.id ?? null } });
        await onPaymentConfirmed(job.id);
      } else {
        logger.warn({ orderId }, 'razorpay_payment_for_unknown_order');
      }
    }

    res.json({ ok: true });
  }),
);

/**
 * Dev/pilot-only payment confirmation. Hard-disabled unless the server runs
 * with PAYMENT_PROVIDER=mock, so it cannot exist alongside real payments.
 */
paymentsRouter.post(
  '/mock/confirm',
  requireStudent,
  validateBody(z.object({ jobId: z.string().uuid() })),
  asyncHandler(async (req, res) => {
    if (env.PAYMENT_PROVIDER !== 'mock') throw notFound();
    const { jobId } = req.body as { jobId: string };
    const job = await prisma.job.findFirst({
      where: { id: jobId, studentId: req.student!.id },
    });
    if (!job) throw notFound();
    if (job.status !== 'pending_payment') throw badRequest('Job is not awaiting payment');

    await prisma.paymentEvent.upsert({
      where: { providerEventId: `mock_${jobId}` },
      create: {
        provider: 'mock',
        providerEventId: `mock_${jobId}`,
        jobId,
        payload: { simulated: true },
      },
      update: {},
    });
    // mirrors the real Razorpay webhook setting paymentId before confirming —
    // a job needs a payment reference for refundIfPaid to act on later
    await prisma.job.update({ where: { id: jobId }, data: { paymentId: `mock_${jobId}` } });
    await onPaymentConfirmed(jobId);
    res.json({ ok: true });
  }),
);
