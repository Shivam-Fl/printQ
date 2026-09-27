import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  env: { SHOP_COLLECTION_MODE: 'test', PRINTQ_ENVIRONMENT: 'development' },
  attempt: null as null | {
    id: string; statementId: string; provider: string; providerOrderId: string;
    providerCollectionId: string | null; amountPaise: number; status: string;
    statement: {
      id: string; shopId: string; amountDuePaise: number; status: string;
      mandate: { environment: string; providerCustomerId: string };
      settlementEntry: { amountPaise: number } | null;
    };
  },
  entries: 0,
  transactions: 0,
}));

vi.mock('../../config/env.js', () => ({ env: state.env }));
vi.mock('../../lib/prisma.js', () => {
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: 'statement-1' }]),
    shopCommissionCollectionAttempt: {
      findUnique: vi.fn(async ({ where }: { where: { providerOrderId?: string; id?: string } }) =>
        where.providerOrderId ? (state.attempt?.providerOrderId === where.providerOrderId
          ? { id: state.attempt.id, statementId: state.attempt.statementId } : null) : state.attempt),
      update: vi.fn(async ({ data }: { data: { status: string; providerCollectionId: string } }) => {
        if (state.attempt) Object.assign(state.attempt, data);
      }),
    },
    shopCommissionEntry: { create: vi.fn(async ({ data }: { data: { amountPaise: number } }) => {
      state.entries += 1;
      if (state.attempt) state.attempt.statement.settlementEntry = { amountPaise: data.amountPaise };
    }) },
    shopCommissionStatement: { update: vi.fn(async ({ data }: { data: { status: string } }) => {
      if (state.attempt) state.attempt.statement.status = data.status;
    }) },
  };
  return { prisma: {
    $disconnect: vi.fn(async () => undefined),
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => {
      state.transactions += 1;
      return callback(tx);
    }),
  } };
});

import { parseCapturedRecurringPayment, settleTestCapturedRecurringPayment } from './settlementService.js';

const captured = {
  id: 'pay_Test123', orderId: 'order_Test123', amountPaise: 250,
  currency: 'INR' as const, status: 'captured' as const, customerId: 'cust_Test123',
};

beforeEach(() => {
  state.env.SHOP_COLLECTION_MODE = 'test';
  state.env.PRINTQ_ENVIRONMENT = 'development';
  state.entries = 0;
  state.transactions = 0;
  state.attempt = {
    id: 'attempt-1', statementId: 'statement-1', provider: 'razorpay_test',
    providerOrderId: captured.orderId, providerCollectionId: null,
    amountPaise: 250, status: 'submitted',
    statement: {
      id: 'statement-1', shopId: 'shop-1', amountDuePaise: 250,
      status: 'debit_pending',
      mandate: { environment: 'test', providerCustomerId: 'cust_Test123' },
      settlementEntry: null,
    },
  };
});

describe('signed Razorpay capture mapping', () => {
  it('ignores out-of-order non-capture events and parses exact captured fields', () => {
    expect(parseCapturedRecurringPayment({ event: 'payment.authorized' })).toBeNull();
    expect(parseCapturedRecurringPayment({ event: 'payment.captured', payload: { payment: { entity: {
      id: captured.id, order_id: captured.orderId, amount: 250,
      currency: 'INR', status: 'captured', customer_id: captured.customerId,
    } } } })).toEqual(captured);
  });

  it('rejects malformed captured events without inventing financial facts', () => {
    expect(() => parseCapturedRecurringPayment({ event: 'payment.captured' })).toThrow();
    expect(() => parseCapturedRecurringPayment({ event: 'payment.captured', payload: { payment: { entity: {
      id: captured.id, order_id: captured.orderId, amount: 250,
      currency: 'INR', status: 'captured',
    } } } })).toThrow();
    expect(() => parseCapturedRecurringPayment({ event: 'payment.captured', payload: { payment: { entity: {
      id: captured.id, order_id: captured.orderId, amount: 251,
      currency: 'USD', status: 'captured',
    } } } })).toThrow();
  });
});

describe('TEST weekly settlement', () => {
  it('posts exactly one reversing entry under duplicate captures', async () => {
    expect(await settleTestCapturedRecurringPayment(captured)).toBe(true);
    expect(await settleTestCapturedRecurringPayment(captured)).toBe(true);
    expect(state.entries).toBe(1);
    expect(state.attempt?.statement.settlementEntry?.amountPaise).toBe(-250);
    expect(state.attempt?.statement.status).toBe('settled');
  });

  it('rejects mismatched amount, customer and a second payment without a second entry', async () => {
    await expect(settleTestCapturedRecurringPayment({ ...captured, amountPaise: 251 })).rejects.toThrow();
    await expect(settleTestCapturedRecurringPayment({ ...captured, customerId: 'cust_Wrong' })).rejects.toThrow();
    expect(state.entries).toBe(0);
    await settleTestCapturedRecurringPayment(captured);
    await expect(settleTestCapturedRecurringPayment({ ...captured, id: 'pay_Another123' })).rejects.toThrow();
    expect(state.entries).toBe(1);
  });

  it('has no money effect when production collection is disabled', async () => {
    state.env.SHOP_COLLECTION_MODE = 'disabled';
    state.env.PRINTQ_ENVIRONMENT = 'production';
    expect(await settleTestCapturedRecurringPayment(captured)).toBe(false);
    expect(state.transactions).toBe(0);
    expect(state.entries).toBe(0);
  });
});
