import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  mandate: { id: 'mandate-test-1' } as { id: string } | null,
  mandateQuery: vi.fn(),
  createdData: null as Record<string, unknown> | null,
  env: { SHOP_COLLECTION_MODE: 'test', PRINTQ_ENVIRONMENT: 'development' },
}));

vi.mock('../../config/env.js', () => ({
  env: state.env,
}));

vi.mock('../../lib/prisma.js', () => {
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: 'shop-1' }]),
    shopCommissionStatement: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        state.createdData = data;
        return { id: 'statement-1', ...data };
      }),
    },
    shopCommissionEntry: {
      findMany: vi.fn(async () => [{ id: 'entry-1', amountPaise: 250 }]),
    },
    shopCollectionMandate: {
      findFirst: vi.fn(async (query: unknown) => {
        state.mandateQuery(query);
        return state.mandate;
      }),
    },
  };
  return { prisma: {
    $disconnect: vi.fn(async () => undefined),
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
  } };
});

import { freezeWeeklyCommissionStatement } from './statementService.js';

describe('weekly statement mandate binding', () => {
  const period = {
    start: new Date('2026-09-14T00:00:00.000Z'),
    end: new Date('2026-09-21T00:00:00.000Z'),
  };
  const now = new Date('2026-09-21T12:00:00.000Z');

  beforeEach(() => {
    state.mandate = { id: 'mandate-test-1' };
    state.mandateQuery.mockClear();
    state.createdData = null;
    state.env.SHOP_COLLECTION_MODE = 'test';
    state.env.PRINTQ_ENVIRONMENT = 'development';
  });

  it('binds an eligible TEST mandate to the exact frozen statement', async () => {
    await freezeWeeklyCommissionStatement('shop-1', period, now);
    expect(state.mandateQuery).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        shopId: 'shop-1',
        environment: 'test',
        status: 'active',
        maxAmountPaise: { gte: 250 },
      }),
    }));
    expect(state.createdData).toMatchObject({ mandateId: 'mandate-test-1', amountDuePaise: 250 });
  });

  it('leaves the statement unbound when no eligible mandate exists', async () => {
    state.mandate = null;
    await freezeWeeklyCommissionStatement('shop-1', period, now);
    expect(state.createdData).toMatchObject({ mandateId: null, amountDuePaise: 250 });
  });

  it('never queries or binds a mandate while collection is disabled', async () => {
    state.env.SHOP_COLLECTION_MODE = 'disabled';
    state.env.PRINTQ_ENVIRONMENT = 'production';
    await freezeWeeklyCommissionStatement('shop-1', period, now);
    expect(state.mandateQuery).not.toHaveBeenCalled();
    expect(state.createdData).toMatchObject({ mandateId: null, amountDuePaise: 250 });
  });
});
