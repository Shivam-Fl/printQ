import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const now = new Date('2026-09-28T12:00:00.000Z');
const state = vi.hoisted(() => ({
  env: { SHOP_COLLECTION_MODE: 'test', PRINTQ_ENVIRONMENT: 'development', SHOP_COLLECTION_PILOT_CAP_PAISE: 1_500_000 },
  attempt: null as null | {
    id: string; status: string; provider: string; amountPaise: number;
    providerOrderId: string | null; providerCollectionId: string | null;
    statement: {
      id: string; shopId: string; status: string; amountDuePaise: number;
      preDebitNoticeSentAt: Date; debitNotBefore: Date;
      mandate: {
        shopId: string; provider: string; environment: string; status: string; method: string;
        frequency: string; providerMandateId: string; maxAmountPaise: number;
        validFrom: Date; validUntil: Date; cancellationTermsAcceptedAt: Date;
        providerCustomerId: string; providerTokenId: string;
        ownerDebitEmail: string; ownerDebitContactE164: string;
      };
    };
  },
  otherSubmitted: false,
  orderCalls: 0,
  chargeCalls: 0,
}));

vi.mock('../../config/env.js', () => ({ env: state.env }));
vi.mock('../../lib/prisma.js', () => {
  const attemptRepo = {
    findUnique: vi.fn(async () => state.attempt),
    findFirst: vi.fn(async () => state.otherSubmitted ? { id: 'other' } : null),
    updateMany: vi.fn(async ({ where, data }: { where: { status: string; providerOrderId?: null; providerCollectionId?: null }; data: Record<string, unknown> }) => {
      if (!state.attempt || state.attempt.status !== where.status) return { count: 0 };
      if (where.providerOrderId === null && state.attempt.providerOrderId !== null) return { count: 0 };
      if (where.providerCollectionId === null && state.attempt.providerCollectionId !== null) return { count: 0 };
      Object.assign(state.attempt, data);
      return { count: 1 };
    }),
  };
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: 'shop-1' }]),
    shopCommissionCollectionAttempt: attemptRepo,
  };
  return { prisma: {
    $disconnect: vi.fn(async () => undefined),
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    shopCommissionCollectionAttempt: attemptRepo,
  } };
});

import { dispatchTestCollectionAttempt } from './testDispatchService.js';

const client = {
  createOrder: vi.fn(async () => { state.orderCalls += 1; return 'order_Test123'; }),
  charge: vi.fn(async () => { state.chargeCalls += 1; return 'pay_Test123'; }),
};

beforeEach(() => {
  // The service re-checks the mandate window against the real clock inside the
  // transaction, so pin Date to the fixture's `now` (fixture is relative to it).
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  state.env.SHOP_COLLECTION_MODE = 'test';
  state.env.PRINTQ_ENVIRONMENT = 'development';
  state.orderCalls = 0;
  state.chargeCalls = 0;
  state.otherSubmitted = false;
  client.createOrder.mockClear();
  client.charge.mockClear();
  state.attempt = {
    id: 'attempt-1', status: 'pending', provider: 'razorpay_test', amountPaise: 250,
    providerOrderId: null, providerCollectionId: null,
    statement: {
      id: 'statement-1', shopId: 'shop-1', status: 'debit_pending', amountDuePaise: 250,
      preDebitNoticeSentAt: new Date(now.getTime() - 49 * 60 * 60_000),
      debitNotBefore: new Date(now.getTime() - 25 * 60 * 60_000),
      mandate: {
        shopId: 'shop-1', provider: 'razorpay', environment: 'test', status: 'active', method: 'upi_autopay',
        frequency: 'weekly', providerMandateId: 'mandate_Test123', maxAmountPaise: 500,
        validFrom: new Date(now.getTime() - 7 * 86_400_000),
        validUntil: new Date(now.getTime() + 7 * 86_400_000),
        cancellationTermsAcceptedAt: new Date(now.getTime() - 14 * 86_400_000),
        providerCustomerId: 'cus_Test123', providerTokenId: 'token_Test123',
        ownerDebitEmail: 'owner@example.test', ownerDebitContactE164: '+919876543210',
      },
    },
  };
});

afterEach(() => { vi.useRealTimers(); });

describe('Razorpay TEST weekly debit dispatch', () => {
  it('binds the order before one charge and refuses a second dispatch', async () => {
    expect(await dispatchTestCollectionAttempt('attempt-1', client, now)).toEqual({
      orderId: 'order_Test123', paymentId: 'pay_Test123',
    });
    expect(client.charge).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 'order_Test123', amountPaise: 250, customerId: 'cus_Test123', tokenId: 'token_Test123',
    }));
    expect(state.attempt?.providerOrderId).toBe('order_Test123');
    expect(state.attempt?.providerCollectionId).toBe('pay_Test123');
    await expect(dispatchTestCollectionAttempt('attempt-1', client, now)).rejects.toThrow();
    expect(state.chargeCalls).toBe(1);
  });

  it('requires 48 hours of notice for UPI and an active, capped mandate', async () => {
    state.attempt!.statement.preDebitNoticeSentAt = new Date(now.getTime() - 25 * 60 * 60_000);
    await expect(dispatchTestCollectionAttempt('attempt-1', client, now)).rejects.toThrow();
    state.attempt!.statement.preDebitNoticeSentAt = new Date(now.getTime() - 49 * 60 * 60_000);
    state.attempt!.statement.mandate.status = 'revoked';
    await expect(dispatchTestCollectionAttempt('attempt-1', client, now)).rejects.toThrow();
    state.attempt!.statement.mandate.status = 'active';
    state.attempt!.statement.mandate.maxAmountPaise = 200;
    await expect(dispatchTestCollectionAttempt('attempt-1', client, now)).rejects.toThrow();
    expect(state.orderCalls).toBe(0);
  });

  it('does not retry when a recurring charge response is ambiguous', async () => {
    client.charge.mockImplementationOnce(async () => { state.chargeCalls += 1; throw new Error('timeout'); });
    await expect(dispatchTestCollectionAttempt('attempt-1', client, now)).rejects.toThrow('reconcile');
    expect(state.attempt?.status).toBe('submitted');
    expect(state.attempt?.providerOrderId).toBe('order_Test123');
    await expect(dispatchTestCollectionAttempt('attempt-1', client, now)).rejects.toThrow();
    expect(state.chargeCalls).toBe(1);
  });

  it('does not charge while another weekly debit for that shop is unresolved', async () => {
    state.otherSubmitted = true;
    await expect(dispatchTestCollectionAttempt('attempt-1', client, now)).rejects.toThrow('Another shop debit');
    expect(state.orderCalls).toBe(1);
    expect(state.chargeCalls).toBe(0);
    expect(state.attempt?.status).toBe('pending');
  });

  it('does not call Razorpay for a disabled or production environment', async () => {
    state.env.PRINTQ_ENVIRONMENT = 'production';
    await expect(dispatchTestCollectionAttempt('attempt-1', client, now)).rejects.toThrow();
    expect(state.orderCalls).toBe(0);
    expect(state.chargeCalls).toBe(0);
  });
});
