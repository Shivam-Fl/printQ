import { logger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { markFeeAttemptFailed, settleFeePayment, type SettleOutcome } from './payments.js';

interface PaymentEntity {
  id: string;
  orderId: string;
  amountPaise: number;
  currency: string;
  status: string | null;
  notes: Record<string, unknown> | null;
}

const ORDER_ID = /^order_[A-Za-z0-9]+$/;
const PAYMENT_ID = /^pay_[A-Za-z0-9]+$/;

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function parsePayment(entity: unknown): PaymentEntity | null {
  const p = asObject(entity);
  if (!p) return null;
  if (
    typeof p.id !== 'string' || !PAYMENT_ID.test(p.id)
    || typeof p.order_id !== 'string' || !ORDER_ID.test(p.order_id)
    || typeof p.amount !== 'number' || !Number.isSafeInteger(p.amount) || p.amount <= 0
    || typeof p.currency !== 'string'
  ) return null;
  return {
    id: p.id,
    orderId: p.order_id,
    amountPaise: p.amount,
    currency: p.currency,
    status: typeof p.status === 'string' ? p.status : null,
    notes: asObject(p.notes),
  };
}

export type FeeWebhookResult =
  | { handled: false }
  | { handled: true; event: string; outcome: SettleOutcome | 'failed_marked' | 'ignored' };

/** Razorpay carries `notes` as `[]` when empty; only a populated object can contradict our order. */
function notesContradict(notes: Record<string, unknown> | null, feePaymentId: string): boolean {
  if (!notes || Object.keys(notes).length === 0) return false;
  return notes.kind !== 'shop_fee' || notes.feePaymentId !== feePaymentId;
}

/**
 * Apply a signature-verified Razorpay event to a fee order. The caller has
 * already authenticated the delivery. Events for orders that are not ours are
 * not handled (handled:false). Amount, currency, order id and notes must match
 * our order or no money effect occurs. Throws only for infrastructure errors
 * so Razorpay retries those deliveries.
 */
export async function handleFeeWebhook(payload: unknown): Promise<FeeWebhookResult> {
  const body = asObject(payload);
  const event = typeof body?.event === 'string' ? body.event : null;
  if (!body || !event) return { handled: false };
  if (event !== 'payment.captured' && event !== 'order.paid' && event !== 'payment.failed') {
    return { handled: false };
  }
  const inner = asObject(body.payload);
  const payment = parsePayment(asObject(asObject(inner?.payment)?.entity));
  if (!payment) return { handled: false };

  // Our own order table is the authority for "is this a fee payment".
  const order = await prisma.shopFeePayment.findUnique({
    where: { providerOrderId: payment.orderId },
    select: { id: true, shopId: true },
  });
  if (!order) return { handled: false };

  let orderNotes: Record<string, unknown> | null = null;
  if (event === 'order.paid') {
    const entity = asObject(asObject(inner?.order)?.entity);
    if (!entity || entity.id !== payment.orderId) {
      logger.warn({ paymentId: order.id }, 'fee_webhook_order_entity_mismatch');
      return { handled: true, event, outcome: 'ignored' };
    }
    orderNotes = asObject(entity.notes);
  }
  if (notesContradict(payment.notes, order.id) || notesContradict(orderNotes, order.id)) {
    logger.error({ paymentId: order.id, event }, 'fee_webhook_notes_mismatch');
    return { handled: true, event, outcome: 'ignored' };
  }

  if (event === 'payment.failed') {
    const marked = await markFeeAttemptFailed(payment.orderId, 'payment_failed');
    return { handled: true, event, outcome: marked ? 'failed_marked' : 'ignored' };
  }
  if (payment.status !== null && payment.status !== 'captured') {
    return { handled: true, event, outcome: 'ignored' };
  }

  const outcome = await settleFeePayment({
    providerOrderId: payment.orderId,
    providerPaymentId: payment.id,
    amountPaise: payment.amountPaise,
    currency: payment.currency,
    source: 'webhook',
  });
  if (outcome === 'mismatch' || outcome === 'conflict') {
    logger.error({ event, outcome, paymentId: order.id }, 'fee_webhook_rejected');
  }
  return { handled: true, event, outcome };
}
