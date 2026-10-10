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

describe('TEST mandate registration calls', () => {
  const calls: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
  const stub = (respond: (url: string, method: string) => Response) => vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, method: String(init.method), body: init.body ? JSON.parse(init.body as string) : null });
    return respond(url, String(init.method));
  }));
  const expireAt = new Date(Date.now() + 86_400_000);

  it('creates a customer idempotently, a capped upi mandate order, fetches and cancels a token', async () => {
    calls.length = 0;
    stub((url, method) => {
      if (url.endsWith('/customers')) return Response.json({ id: 'cust_Test1' });
      if (url.endsWith('/orders')) return Response.json({ id: 'order_Test1', receipt: 'm1', currency: 'INR' });
      if (method === 'GET') return Response.json({ id: 'token_Abc1', max_amount: 1000, recurring_details: { status: 'confirmed' } });
      return Response.json({});
    });
    const client = new RazorpayTestRecurringClient();
    expect(await client.createCustomer({ name: 'Owner', email: 'o@example.test', contact: '+919876543210', shopId: 's1' })).toBe('cust_Test1');
    expect(await client.createMandateOrder({
      receipt: 'm1', customerId: 'cust_Test1', maxAmountPaise: 1000, expireAt, pilotCapPaise: 1000,
    })).toBe('order_Test1');
    expect(await client.fetchToken('cust_Test1', 'token_Abc1')).toEqual({ id: 'token_Abc1', status: 'confirmed', maxAmountPaise: 1000 });
    await client.cancelToken('cust_Test1', 'token_Abc1');
    expect(calls[0]!.body).toMatchObject({ fail_existing: '0' });
    expect(calls[1]!.body).toMatchObject({
      method: 'upi', customer_id: 'cust_Test1', receipt: 'm1',
      token: { max_amount: 1000, frequency: 'as_presented', expire_at: Math.floor(expireAt.getTime() / 1000) },
    });
    expect(calls[2]).toMatchObject({ method: 'GET', url: 'https://api.razorpay.com/v1/customers/cust_Test1/tokens/token_Abc1' });
    expect(calls[3]).toMatchObject({ method: 'PUT', url: 'https://api.razorpay.com/v1/customers/cust_Test1/tokens/token_Abc1/cancel' });
  });

  it('refuses a max_amount above the pilot cap or in the past before any call', async () => {
    calls.length = 0;
    stub(() => Response.json({}));
    const client = new RazorpayTestRecurringClient();
    await expect(client.createMandateOrder({
      receipt: 'm1', customerId: 'cust_Test1', maxAmountPaise: 1001, expireAt, pilotCapPaise: 1000,
    })).rejects.toThrow('Invalid');
    await expect(client.createMandateOrder({
      receipt: 'm1', customerId: 'cust_Test1', maxAmountPaise: 1000, expireAt: new Date(0), pilotCapPaise: 1000,
    })).rejects.toThrow('Invalid');
    await expect(client.cancelToken('cust_Test1', '../x')).rejects.toThrow('Invalid');
    expect(calls).toHaveLength(0);
  });

  it('refuses live keys and production for the mandate calls, and hides provider errors', async () => {
    calls.length = 0;
    stub(() => new Response('secret-provider-body', { status: 400 }));
    state.env.RAZORPAY_RECURRING_TEST_KEY_ID = 'rzp_live_forbidden';
    await expect(new RazorpayTestRecurringClient().cancelToken('cust_Test1', 'token_Abc1')).rejects.toThrow();
    state.env.RAZORPAY_RECURRING_TEST_KEY_ID = 'rzp_test_example';
    state.env.PRINTQ_ENVIRONMENT = 'production';
    await expect(new RazorpayTestRecurringClient().createCustomer({
      name: 'O', email: 'o@example.test', contact: '+919876543210', shopId: 's',
    })).rejects.toThrow();
    state.env.PRINTQ_ENVIRONMENT = 'development';
    expect(calls).toHaveLength(0);
    const err = await new RazorpayTestRecurringClient().cancelToken('cust_Test1', 'token_Abc1').catch((e) => e as Error);
    expect(err.message).toBe('Razorpay TEST request failed (HTTP 400)');
  });
});
