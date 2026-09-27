import { env } from '../../config/env.js';

const API_ROOT = 'https://api.razorpay.com/v1';
const RAZORPAY_ID = /^(?:order|pay|cus|cust|token)_[A-Za-z0-9]+$/;

export interface TestRecurringCharge {
  orderId: string;
  amountPaise: number;
  customerId: string;
  tokenId: string;
  email: string;
  contact: string;
}

/**
 * This transport is deliberately TEST-only. No method retries an ambiguous
 * request: a timeout after a debit must be reconciled by order/webhook first.
 * It is never the retired student-payment or production Razorpay client.
 */
export class RazorpayTestRecurringClient {
  private authorization(): string {
    if (env.SHOP_COLLECTION_MODE !== 'test' || env.PRINTQ_ENVIRONMENT === 'production') {
      throw new Error('Razorpay recurring TEST collection is disabled');
    }
    const keyId = env.RAZORPAY_RECURRING_TEST_KEY_ID;
    const keySecret = env.RAZORPAY_RECURRING_TEST_KEY_SECRET;
    if (!keyId?.startsWith('rzp_test_') || !keySecret) {
      throw new Error('Dedicated Razorpay recurring TEST credentials are missing or invalid');
    }
    return `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;
  }

  private async post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const authorization = this.authorization();
    let response: Response;
    try {
      response = await fetch(`${API_ROOT}${path}`, {
        method: 'POST',
        headers: { Authorization: authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new Error('Razorpay TEST transport outcome is unknown');
    }
    // Provider error bodies can contain customer or account details. Do not log
    // or propagate them; HTTP status is sufficient for a reconciliation alarm.
    if (!response.ok) throw new Error(`Razorpay TEST request failed (HTTP ${response.status})`);
    const data: unknown = await response.json().catch(() => {
      throw new Error('Razorpay TEST response is invalid');
    });
    if (!data || typeof data !== 'object') throw new Error('Razorpay TEST response is invalid');
    return data as Record<string, unknown>;
  }

  async createOrder(attemptId: string, amountPaise: number): Promise<string> {
    if (!attemptId || attemptId.length > 40 || !Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
      throw new Error('Invalid TEST collection order inputs');
    }
    const order = await this.post('/orders', {
      amount: amountPaise,
      currency: 'INR',
      payment_capture: true,
      receipt: attemptId,
      notes: { purpose: 'shop_weekly_commission_test' },
    });
    if (
      typeof order.id !== 'string' || !/^order_[A-Za-z0-9]+$/.test(order.id)
      || order.amount !== amountPaise || order.currency !== 'INR'
      || order.receipt !== attemptId || order.status !== 'created'
    ) throw new Error('Razorpay TEST order response does not match the statement');
    return order.id;
  }

  async charge(input: TestRecurringCharge): Promise<string> {
    if (
      !RAZORPAY_ID.test(input.orderId) || !input.orderId.startsWith('order_')
      || !RAZORPAY_ID.test(input.customerId) || !/^(?:cus|cust)_/.test(input.customerId)
      || !RAZORPAY_ID.test(input.tokenId) || !input.tokenId.startsWith('token_')
      || !Number.isSafeInteger(input.amountPaise) || input.amountPaise <= 0
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)
      || !/^\+[1-9]\d{7,14}$/.test(input.contact)
    ) throw new Error('Invalid TEST recurring charge inputs');
    const payment = await this.post('/payments/create/recurring', {
      email: input.email,
      contact: input.contact,
      amount: input.amountPaise,
      currency: 'INR',
      order_id: input.orderId,
      customer_id: input.customerId,
      token: input.tokenId,
      recurring: true,
      description: 'PrintQs weekly shop commission TEST',
    });
    if (typeof payment.razorpay_payment_id !== 'string' || !/^pay_[A-Za-z0-9]+$/.test(payment.razorpay_payment_id)) {
      throw new Error('Razorpay TEST recurring payment response is invalid');
    }
    return payment.razorpay_payment_id;
  }
}
