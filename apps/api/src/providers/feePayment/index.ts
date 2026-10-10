import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';

/**
 * Provider abstraction for shop platform-fee payments. This is deliberately
 * separate from the retired student `paymentProvider`: it moves money only from
 * a shop owner to PrintQs through a one-time Razorpay Checkout order.
 */
export interface FeeOrderInput {
  receipt: string;
  amountPaise: number;
  notes: Record<string, string>;
}

export interface ProviderPayment {
  id: string;
  orderId: string;
  amountPaise: number;
  currency: string;
  status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';
}

export interface FeePaymentProvider {
  readonly name: 'mock' | 'razorpay';
  createOrder(input: FeeOrderInput): Promise<{ providerOrderId: string }>;
  /** Public checkout parameters (never includes a secret). */
  checkout(order: { providerOrderId: string; amountPaise: number }): Record<string, unknown>;
  fetchOrderPayments(providerOrderId: string): Promise<ProviderPayment[]>;
  /** Capture an authorized payment (accounts without auto-capture). */
  capturePayment(paymentId: string, amountPaise: number): Promise<void>;
  /** Razorpay Checkout success signature over `order_id|payment_id`. */
  verifyCheckoutSignature(orderId: string, paymentId: string, signature: string): boolean;
}

const RAZORPAY_API = 'https://api.razorpay.com/v1';

class MockFeeProvider implements FeePaymentProvider {
  readonly name = 'mock' as const;

  async createOrder(): Promise<{ providerOrderId: string }> {
    return { providerOrderId: `order_mock${randomUUID().replace(/-/g, '').slice(0, 20)}` };
  }

  checkout(order: { providerOrderId: string; amountPaise: number }): Record<string, unknown> {
    return { mode: 'mock', orderId: order.providerOrderId, amountPaise: order.amountPaise, currency: 'INR' };
  }

  async fetchOrderPayments(): Promise<ProviderPayment[]> {
    return [];
  }

  async capturePayment(): Promise<void> {
    // nothing to capture in dev
  }

  verifyCheckoutSignature(): boolean {
    return false;
  }
}

/** Razorpay REST (basic auth) — no SDK, same style as the other providers. */
class RazorpayFeeProvider implements FeePaymentProvider {
  readonly name = 'razorpay' as const;

  private authorization(): string {
    return `Basic ${Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64')}`;
  }

  private async call(path: string, init: { method: 'GET' | 'POST'; body?: unknown }): Promise<Record<string, unknown>> {
    const response = await fetch(`${RAZORPAY_API}${path}`, {
      method: init.method,
      headers: { Authorization: this.authorization(), 'Content-Type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(15_000),
    });
    // Provider bodies can contain account details: report only the status.
    if (!response.ok) throw new Error(`Razorpay request failed (HTTP ${response.status})`);
    const data: unknown = await response.json().catch(() => null);
    if (!data || typeof data !== 'object') throw new Error('Razorpay response is invalid');
    return data as Record<string, unknown>;
  }

  async createOrder(input: FeeOrderInput): Promise<{ providerOrderId: string }> {
    const order = await this.call('/orders', {
      method: 'POST',
      body: { amount: input.amountPaise, currency: 'INR', receipt: input.receipt, notes: input.notes },
    });
    if (
      typeof order.id !== 'string' || !/^order_[A-Za-z0-9]+$/.test(order.id)
      || order.amount !== input.amountPaise || order.currency !== 'INR'
    ) throw new Error('Razorpay order response does not match the request');
    return { providerOrderId: order.id };
  }

  checkout(order: { providerOrderId: string; amountPaise: number }): Record<string, unknown> {
    return {
      mode: 'razorpay',
      keyId: env.RAZORPAY_KEY_ID,
      orderId: order.providerOrderId,
      amountPaise: order.amountPaise,
      currency: 'INR',
    };
  }

  async fetchOrderPayments(providerOrderId: string): Promise<ProviderPayment[]> {
    if (!/^order_[A-Za-z0-9]+$/.test(providerOrderId)) throw new Error('Invalid order id');
    const data = await this.call(`/orders/${providerOrderId}/payments`, { method: 'GET' });
    const items = Array.isArray(data.items) ? data.items : [];
    const payments: ProviderPayment[] = [];
    for (const raw of items) {
      const p = raw as Record<string, unknown>;
      if (
        typeof p.id === 'string' && typeof p.order_id === 'string'
        && typeof p.amount === 'number' && typeof p.currency === 'string' && typeof p.status === 'string'
        && ['created', 'authorized', 'captured', 'refunded', 'failed'].includes(p.status)
      ) {
        payments.push({
          id: p.id,
          orderId: p.order_id,
          amountPaise: p.amount,
          currency: p.currency,
          status: p.status as ProviderPayment['status'],
        });
      }
    }
    return payments;
  }

  async capturePayment(paymentId: string, amountPaise: number): Promise<void> {
    if (!/^pay_[A-Za-z0-9]+$/.test(paymentId)) throw new Error('Invalid payment id');
    await this.call(`/payments/${paymentId}/capture`, { method: 'POST', body: { amount: amountPaise, currency: 'INR' } });
  }

  verifyCheckoutSignature(orderId: string, paymentId: string, signature: string): boolean {
    return verifyHmacHex(`${orderId}|${paymentId}`, signature, env.RAZORPAY_KEY_SECRET);
  }
}

function verifyHmacHex(message: string | Buffer, signature: string, secret: string | undefined): boolean {
  // An empty secret would make the HMAC forgeable: refuse outright.
  if (!secret || !/^[0-9a-fA-F]{64}$/.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(message).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

/** Constant-time verification of the Razorpay webhook signature (raw body bytes). */
export function verifyFeeWebhookSignature(rawBody: Buffer, signature: string): boolean {
  return verifyHmacHex(rawBody, signature, env.RAZORPAY_WEBHOOK_SECRET);
}

let cached: FeePaymentProvider | null = null;
let cachedFor: string | null = null;

/** Null when fee payments are disabled. Resolved lazily so config is read once per process. */
export function getFeePaymentProvider(): FeePaymentProvider | null {
  if (env.FEE_PAYMENT_PROVIDER === 'disabled') return null;
  if (cachedFor !== env.FEE_PAYMENT_PROVIDER) {
    cached = env.FEE_PAYMENT_PROVIDER === 'razorpay' ? new RazorpayFeeProvider() : new MockFeeProvider();
    cachedFor = env.FEE_PAYMENT_PROVIDER;
  }
  return cached;
}
