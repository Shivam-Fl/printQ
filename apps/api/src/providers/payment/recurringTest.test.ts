import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  env: {
    SHOP_COLLECTION_MODE: 'test',
    PRINTQ_ENVIRONMENT: 'development',
    RAZORPAY_RECURRING_TEST_KEY_ID: 'rzp_test_example',
    RAZORPAY_RECURRING_TEST_KEY_SECRET: 'test-only-secret',
  },
}));

vi.mock('../../config/env.js', () => ({ env: state.env }));

import { RazorpayTestRecurringClient } from './recurringTest.js';

afterEach(() => vi.unstubAllGlobals());

describe('isolated Razorpay recurring TEST transport', () => {
  it('creates one exact-amount order and charges its approved token without exposing secrets', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      requests.push({ url, body });
      if (url.endsWith('/orders')) return Response.json({
        id: 'order_Test123', amount: 250, currency: 'INR', receipt: 'attempt-1', status: 'created',
      });
      return Response.json({ razorpay_payment_id: 'pay_Test123' });
    }));
    const client = new RazorpayTestRecurringClient();
    const orderId = await client.createOrder('attempt-1', 250);
    expect(orderId).toBe('order_Test123');
    const paymentId = await client.charge({
      orderId, amountPaise: 250, customerId: 'cus_Test123', tokenId: 'token_Test123',
      email: 'owner@example.test', contact: '+919876543210',
    });
    expect(paymentId).toBe('pay_Test123');
    expect(requests).toEqual([
      { url: 'https://api.razorpay.com/v1/orders', body: {
        amount: 250, currency: 'INR', payment_capture: true, receipt: 'attempt-1',
        notes: { purpose: 'shop_weekly_commission_test' },
      } },
      { url: 'https://api.razorpay.com/v1/payments/create/recurring', body: {
        email: 'owner@example.test', contact: '+919876543210', amount: 250, currency: 'INR',
        order_id: 'order_Test123', customer_id: 'cus_Test123', token: 'token_Test123',
        recurring: true, description: 'PrintQs weekly shop commission TEST',
      } },
    ]);
  });

  it('rejects live credentials and production before a provider call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    state.env.RAZORPAY_RECURRING_TEST_KEY_ID = 'rzp_live_forbidden';
    await expect(new RazorpayTestRecurringClient().createOrder('attempt-1', 250)).rejects.toThrow();
    state.env.RAZORPAY_RECURRING_TEST_KEY_ID = 'rzp_test_example';
    state.env.PRINTQ_ENVIRONMENT = 'production';
    await expect(new RazorpayTestRecurringClient().createOrder('attempt-1', 250)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    state.env.PRINTQ_ENVIRONMENT = 'development';
  });

  it('rejects provider amount mismatch and never includes response bodies in errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      id: 'order_Test123', amount: 251, currency: 'INR', receipt: 'attempt-1', status: 'created',
    })));
    await expect(new RazorpayTestRecurringClient().createOrder('attempt-1', 250)).rejects.toThrow('order response');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('secret-provider-message', { status: 422 })));
    await expect(new RazorpayTestRecurringClient().createOrder('attempt-1', 250)).rejects.not.toThrow('secret-provider-message');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('secret-malformed-response', { status: 200 })));
    await expect(new RazorpayTestRecurringClient().createOrder('attempt-1', 250)).rejects.not.toThrow('secret-malformed-response');
  });
});
