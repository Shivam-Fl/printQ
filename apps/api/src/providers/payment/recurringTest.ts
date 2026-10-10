import { env } from '../../config/env.js';

const API_ROOT = 'https://api.razorpay.com/v1';
const CUSTOMER_ID = /^cust?_[A-Za-z0-9]+$/;
const TOKEN_ID = /^token_[A-Za-z0-9]+$/;
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

  private post(path: string, body: Record<string, unknown>) {
    return this.request('POST', path, body);
  }

  private async request(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const authorization = this.authorization();
    let response: Response;
    try {
      response = await fetch(`${API_ROOT}${path}`, {
        method,
        headers: {
          Authorization: authorization,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
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

  // ---- UPI AutoPay mandate registration (TEST) ------------------------------
  // https://razorpay.com/docs/payments/recurring-payments/upi/
  // https://razorpay.com/docs/api/payments/recurring-payments/upi/create-authorization-transaction/
  // Flow: POST /customers -> POST /orders (method upi + token{}) -> Checkout
  // with order_id + customer_id + recurring "1" (UPI Intent/QR; Collect is
  // deprecated) -> wait for the signed `token.confirmed` webhook.

  /** Idempotent: `fail_existing: "0"` returns the existing customer for a repeat. */
  async createCustomer(input: { name: string; email: string; contact: string; shopId: string }): Promise<string> {
    if (
      !input.name.trim() || input.name.length > 100
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)
      || !/^\+[1-9]\d{7,14}$/.test(input.contact)
    ) throw new Error('Invalid TEST customer inputs');
    const customer = await this.post('/customers', {
      name: input.name.trim(),
      email: input.email,
      contact: input.contact,
      fail_existing: '0',
      notes: { purpose: 'shop_commission_autopay_test', shop_id: input.shopId },
    });
    if (typeof customer.id !== 'string' || !CUSTOMER_ID.test(customer.id)) {
      throw new Error('Razorpay TEST customer response is invalid');
    }
    return customer.id;
  }

  /**
   * Authorization order for a variable-amount mandate. The authorization
   * charge is the Rs 1 minimum; `max_amount` is the per-debit ceiling.
   * `as_presented` is Razorpay's variable-amount frequency: PrintQs' weekly
   * cadence is enforced by its own statement scheduler, not by the token.
   * `receipt` is our mandate id so a retried start can be matched.
   */
  async createMandateOrder(input: {
    receipt: string; customerId: string; maxAmountPaise: number; expireAt: Date; pilotCapPaise: number;
  }): Promise<string> {
    const expireAtUnix = Math.floor(input.expireAt.getTime() / 1000);
    if (
      !input.receipt || input.receipt.length > 40 || !CUSTOMER_ID.test(input.customerId)
      || !Number.isSafeInteger(input.maxAmountPaise) || input.maxAmountPaise < 100
      || input.maxAmountPaise > input.pilotCapPaise
      || expireAtUnix <= Math.floor(Date.now() / 1000)
    ) throw new Error('Invalid TEST mandate order inputs');
    const order = await this.post('/orders', {
      amount: 100,
      currency: 'INR',
      method: 'upi',
      customer_id: input.customerId,
      receipt: input.receipt,
      description: 'PrintQs weekly commission AutoPay',
      token: { max_amount: input.maxAmountPaise, expire_at: expireAtUnix, frequency: 'as_presented' },
      notes: { purpose: 'shop_commission_mandate_test' },
    });
    if (
      typeof order.id !== 'string' || !/^order_[A-Za-z0-9]+$/.test(order.id)
      || order.receipt !== input.receipt || order.currency !== 'INR'
    ) throw new Error('Razorpay TEST mandate order response does not match the request');
    return order.id;
  }

  /** PUT /customers/:customerId/tokens/:tokenId/cancel */
  async cancelToken(customerId: string, tokenId: string): Promise<void> {
    if (!CUSTOMER_ID.test(customerId) || !TOKEN_ID.test(tokenId)) throw new Error('Invalid TEST token identifiers');
    await this.request('PUT', `/customers/${customerId}/tokens/${tokenId}/cancel`, {});
  }

  /** GET /customers/:customerId/tokens/:tokenId; returns only safe fields. */
  async fetchToken(customerId: string, tokenId: string): Promise<{ id: string; status: string | null; maxAmountPaise: number | null }> {
    if (!CUSTOMER_ID.test(customerId) || !TOKEN_ID.test(tokenId)) throw new Error('Invalid TEST token identifiers');
    const token = await this.request('GET', `/customers/${customerId}/tokens/${tokenId}`);
    if (token.id !== tokenId) throw new Error('Razorpay TEST token response is invalid');
    const details = token.recurring_details as { status?: unknown } | undefined;
    return {
      id: tokenId,
      status: typeof details?.status === 'string' ? details.status : null,
      maxAmountPaise: typeof token.max_amount === 'number' ? token.max_amount : null,
    };
  }
}
