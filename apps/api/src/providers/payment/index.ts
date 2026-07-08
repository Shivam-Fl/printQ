import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';

export interface CreatedOrder {
  provider: 'mock' | 'razorpay';
  providerOrderId: string;
  /** passed to the client to open the provider's checkout */
  checkout: Record<string, unknown>;
}

export interface PaymentProvider {
  name: 'mock' | 'razorpay';
  createOrder(jobId: string, amountPaise: number): Promise<CreatedOrder>;
  /** Full refund of a captured payment (cancelled or expired-without-print jobs). */
  refund(paymentId: string, amountPaise: number): Promise<void>;
}

/**
 * Dev/pilot provider. Orders are fake; payment is confirmed via the dev-only
 * /api/payments/mock/confirm endpoint (disabled when PAYMENT_PROVIDER != mock).
 */
class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock' as const;

  async createOrder(jobId: string, amountPaise: number): Promise<CreatedOrder> {
    return {
      provider: 'mock',
      providerOrderId: `mock_${randomUUID()}`,
      checkout: { mode: 'mock', jobId, amountPaise },
    };
  }

  async refund(): Promise<void> {
    // dev/pilot: nothing to call out to — the paymentStatus flip is the record
  }
}

/** Razorpay Orders API via REST (basic auth) — no SDK dependency needed. */
class RazorpayProvider implements PaymentProvider {
  readonly name = 'razorpay' as const;

  async createOrder(jobId: string, amountPaise: number): Promise<CreatedOrder> {
    const auth = Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64');
    const res = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: amountPaise,
        currency: 'INR',
        receipt: jobId,
        notes: { jobId },
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Razorpay order creation failed (${res.status}): ${body}`);
    }
    const order = (await res.json()) as { id: string };
    return {
      provider: 'razorpay',
      providerOrderId: order.id,
      checkout: {
        mode: 'razorpay',
        keyId: env.RAZORPAY_KEY_ID,
        orderId: order.id,
        amountPaise,
        currency: 'INR',
      },
    };
  }

  async refund(paymentId: string, amountPaise: number): Promise<void> {
    const auth = Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64');
    const res = await fetch(`https://api.razorpay.com/v1/payments/${paymentId}/refund`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: amountPaise }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Razorpay refund failed (${res.status}): ${body}`);
    }
  }
}

export const paymentProvider: PaymentProvider =
  env.PAYMENT_PROVIDER === 'razorpay' ? new RazorpayProvider() : new MockPaymentProvider();

/** Constant-time HMAC-SHA256 verification of the Razorpay webhook signature. */
export function verifyRazorpayWebhookSignature(rawBody: Buffer, signature: string): boolean {
  const expected = createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET ?? '')
    .update(rawBody)
    .digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
