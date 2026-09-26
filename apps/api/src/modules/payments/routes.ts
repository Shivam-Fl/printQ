import { Router, raw } from 'express';
import { createHash } from 'node:crypto';
import { logger } from '../../lib/logger.js';
import { asyncHandler } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { parseCapturedRecurringPayment, settleTestCapturedRecurringPayment } from '../commission/settlementService.js';
import { verifyRazorpayRecurringWebhookSignature } from '../../providers/payment/index.js';

/**
 * There is deliberately no student-payment API. Students pay the shop at the
 * counter; staff verify its merchant app or cash drawer before a print starts.
 * Razorpay is reserved for the future, separately approved shop-commission
 * collection workflow, never Route, linked-account payouts, or student money.
 */
export const paymentsRouter = Router();

/** Mounted before global JSON parsing so signature verification sees raw bytes. */
export const webhookRouter = Router();

webhookRouter.post(
  '/razorpay',
  raw({ type: 'application/json' }),
  asyncHandler(async (req, res) => {
    const signature = req.headers['x-razorpay-signature'];
    if (typeof signature !== 'string' || !verifyRazorpayRecurringWebhookSignature(req.body as Buffer, signature)) {
      logger.warn('razorpay_webhook_bad_signature');
      res.status(400).json({ error: 'Invalid signature' });
      return;
    }

    const payload = JSON.parse((req.body as Buffer).toString('utf8')) as { event?: unknown };
    const event = typeof payload.event === 'string' ? payload.event : 'unknown';
    const receivedEventId = req.headers['x-razorpay-event-id'];
    const providerEventId = typeof receivedEventId === 'string'
      ? receivedEventId
      : `razorpay_sha256_${createHash('sha256').update(req.body as Buffer).digest('hex')}`;

    // Preserve delivery evidence without customer or document payloads. The
    // settlement service itself is TEST-only and verifies order, amount and
    // mandate before posting exactly one PostgreSQL ledger reversal.
    await prisma.paymentEvent.upsert({
      where: { providerEventId },
      create: { provider: 'razorpay_recurring_pending', providerEventId, jobId: null, payload: { event } },
      update: {},
    });
    const captured = parseCapturedRecurringPayment(payload);
    const testStatementSettled = captured
      ? await settleTestCapturedRecurringPayment(captured)
      : false;
    logger.info({ event, providerEventId, testStatementSettled }, 'razorpay_recurring_webhook_processed');
    res.json({ ok: true });
  }),
);
