import { Router, raw } from 'express';
import { createHash } from 'node:crypto';
import { logger } from '../../lib/logger.js';
import { asyncHandler } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { verifyFeeWebhookSignature } from '../../providers/feePayment/index.js';
import { handleFeeWebhook } from '../fees/webhook.js';

/**
 * There is deliberately no student-payment API. Students pay the shop at the
 * counter; staff verify its merchant app or cash drawer before a print starts.
 * Razorpay is used only for shops paying PrintQs their platform fee
 * (one-time Checkout orders, see modules/fees), never for student money.
 */
export const paymentsRouter = Router();

/** Mounted before global JSON parsing so signature verification sees raw bytes. */
export const webhookRouter = Router();

/**
 * Public by necessity: authenticated solely by the Razorpay HMAC signature
 * over the raw body (RAZORPAY_WEBHOOK_SECRET). Dispatch is by our own fee
 * order table; unknown orders/events are acknowledged without effect.
 */
webhookRouter.post(
  '/razorpay',
  raw({ type: 'application/json' }),
  asyncHandler(async (req, res) => {
    const signature = req.headers['x-razorpay-signature'];
    if (typeof signature !== 'string' || !verifyFeeWebhookSignature(req.body as Buffer, signature)) {
      logger.warn('razorpay_webhook_bad_signature');
      res.status(400).json({ error: 'Invalid signature' });
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse((req.body as Buffer).toString('utf8'));
    } catch {
      res.status(400).json({ error: 'Invalid payload' });
      return;
    }
    const event = typeof (payload as { event?: unknown } | null)?.event === 'string'
      ? (payload as { event: string }).event
      : 'unknown';
    const receivedEventId = req.headers['x-razorpay-event-id'];
    const providerEventId = typeof receivedEventId === 'string' && receivedEventId.length > 0 && receivedEventId.length <= 200
      ? receivedEventId
      : `razorpay_sha256_${createHash('sha256').update(req.body as Buffer).digest('hex')}`;

    // Delivery evidence only (no customer data). Settlement is itself
    // idempotent per order, so a retried or replayed event is always safe to
    // re-run and an event whose first attempt crashed is never lost.
    await prisma.paymentEvent.upsert({
      where: { providerEventId },
      create: { provider: 'razorpay', providerEventId, jobId: null, payload: { event } },
      update: {},
    });
    const result = await handleFeeWebhook(payload);
    logger.info({ event, providerEventId, ...result }, 'razorpay_webhook_processed');
    res.json({ ok: true });
  }),
);
