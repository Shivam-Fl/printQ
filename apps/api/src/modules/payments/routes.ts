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
import { applyPayoutProviderStatus, confirmShopBalancePayment } from '../earnings/service.js';

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
      payload?: {
        payment?: {
          entity?: {
            id?: string;
            order_id?: string;
            amount?: number;
            currency?: string;
            status?: string;
            fee?: number;
            tax?: number;
          };
        };
        transfer?: {
          entity?: {
            id?: string;
            status?: string;
            error_description?: string;
            notes?: { printqPayoutId?: string };
          };
        };
      };
    };

    // Every effect below is idempotent as well as the event insert. We still
    // replay the effect for duplicate deliveries so a crash after recording an
    // event can be repaired by the provider's normal webhook retry.

    if (['transfer.processed', 'transfer.failed', 'transfer.reversed'].includes(payload.event)) {
      const transfer = payload.payload?.transfer?.entity;
      const transferId = transfer?.id;
      const payoutId = transfer?.notes?.printqPayoutId;
      const providerEventId = typeof eventId === 'string'
        ? eventId
        : `rzp_route_${transferId ?? payoutId ?? 'unknown'}_${payload.event}`;

      await prisma.paymentEvent.upsert({
        where: { providerEventId },
        create: { provider: 'razorpay_route', providerEventId, jobId: null, payload: payload as object },
        update: {},
      });

      // If the original API response was lost after Razorpay accepted it, the
      // idempotency note lets the webhook attach the provider transfer safely.
      if (transferId && payoutId) {
        await prisma.shopPayout.updateMany({
          where: { id: payoutId, providerTransferId: null },
          data: { providerTransferId: transferId },
        });
      }
      if (transferId) {
        const status = payload.event.slice('transfer.'.length) as 'processed' | 'failed' | 'reversed';
        await applyPayoutProviderStatus(transferId, status, transfer?.error_description);
      } else {
        logger.warn({ event: payload.event }, 'razorpay_transfer_webhook_missing_id');
      }
      res.json({ ok: true });
      return;
    }

    if (payload.event === 'payment.captured') {
      const payment = payload.payload?.payment?.entity;
      const orderId = payment?.order_id;
      const job = orderId
        ? await prisma.job.findUnique({ where: { paymentOrderId: orderId } })
        : null;
      const balancePayment = orderId && !job
        ? await prisma.shopBalancePayment.findUnique({ where: { providerOrderId: orderId } })
        : null;
      const expectedAmount = job?.totalPaise ?? balancePayment?.amountPaise;

      if (
        expectedAmount != null &&
        (payment?.amount !== expectedAmount || payment.currency !== 'INR' || payment.status !== 'captured')
      ) {
        logger.error(
          {
            jobId: job?.id,
            balancePaymentId: balancePayment?.id,
            expectedAmount,
            receivedAmount: payment?.amount,
            currency: payment?.currency,
            status: payment?.status,
          },
          'razorpay_captured_payment_mismatch',
        );
        res.status(400).json({ error: 'Payment details do not match order' });
        return;
      }

      await prisma.paymentEvent.upsert({
        where: {
          providerEventId: typeof eventId === 'string' ? eventId : `rzp_${payment?.id ?? orderId ?? 'unknown'}`,
        },
        create: {
          provider: 'razorpay',
          providerEventId: typeof eventId === 'string' ? eventId : `rzp_${payment?.id ?? orderId ?? 'unknown'}`,
          jobId: job?.id ?? null,
          payload: payload as object,
        },
        update: {},
      });

      if (job) {
        await prisma.job.update({
          where: { id: job.id },
          data: {
            paymentId: payment?.id ?? null,
            gatewayFeePaise: typeof payment?.fee === 'number' ? payment.fee : null,
            gatewayTaxPaise: typeof payment?.tax === 'number' ? payment.tax : null,
          },
        });
        await onPaymentConfirmed(job.id);
      } else if (balancePayment && payment?.id && orderId) {
        await confirmShopBalancePayment(orderId, payment.id);
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
