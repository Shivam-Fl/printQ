import { beforeEach, describe, expect, it, vi } from 'vitest';

const now = new Date('2026-10-10T12:00:00.000Z');
const KEY = Buffer.alloc(32, 9).toString('base64');

interface Row {
  id: string; shopId: string; provider: string; environment: string; status: string;
  maxAmountPaise: number; validUntil: Date; validFrom: Date; createdAt: Date;
  activatedAt: Date | null; revokedAt: Date | null;
  providerCustomerId: string | null; providerMandateId: string | null; providerTokenId: string | null;
  cancellationTermsAcceptedAt: Date | null; ownerDebitEmail: string | null; ownerDebitContactE164: string | null;
}

const state = vi.hoisted(() => ({
  env: {
    SHOP_COLLECTION_MODE: 'test', PRINTQ_ENVIRONMENT: 'development', SHOP_COLLECTION_PILOT_CAP_PAISE: 1_500_000,
    RAZORPAY_RECURRING_TEST_KEY_ID: 'rzp_test_example', COLLECTION_TOKEN_ENC_KEY: '',
  } as Record<string, unknown>,
  rows: [] as Array<Record<string, unknown>>,
  seq: 0,
  lock: Promise.resolve() as Promise<unknown>,
}));
state.env.COLLECTION_TOKEN_ENC_KEY = Buffer.alloc(32, 9).toString('base64');

vi.mock('../../config/env.js', () => ({ env: state.env }));
vi.mock('../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../lib/prisma.js', () => {
  type W = Record<string, unknown>;
  const match = (row: Record<string, unknown>, where: W): boolean => Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && 'in' in (v as object)) return ((v as { in: unknown[] }).in).includes(row[k]);
    return row[k] === v;
  });
  const repo = {
    findFirst: vi.fn(async ({ where }: { where: W }) =>
      [...state.rows].reverse().find((r) => match(r, where)) ?? null),
    findMany: vi.fn(async ({ where }: { where: W }) =>
      [...state.rows].reverse().filter((r) => match(r, where))),
    create: vi.fn(async ({ data }: { data: W }) => {
      const row = {
        id: `m${++state.seq}`, createdAt: new Date(), activatedAt: null, revokedAt: null,
        providerCustomerId: null, providerMandateId: null, providerTokenId: null, ...data,
      };
      row.createdAt = (data.validFrom as Date) ?? new Date();
      state.rows.push(row);
      return row;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: W; data: W }) => {
      const hits = state.rows.filter((r) => match(r, where));
      hits.forEach((r) => Object.assign(r, data));
      return { count: hits.length };
    }),
  };
  const tx = { $queryRaw: vi.fn(async () => []), shopCollectionMandate: repo };
  return {
    prisma: {
      $disconnect: vi.fn(async () => undefined),
      shopUser: {
        findFirst: vi.fn(async ({ where }: { where: { id: string; shopId: string; role: string } }) =>
          where.id === 'owner-1' && where.shopId === 'shop-1' && where.role === 'owner'
            ? { email: 'owner@example.test', name: 'Owner' } : null),
      },
      shopCollectionMandate: repo,
      // Serialize transactions like the Shop row lock does.
      $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => {
        const run = state.lock.then(() => fn(tx));
        state.lock = run.catch(() => undefined);
        return run;
      }),
    },
  };
});

import {
  applyTokenEvent, cancelMandate, getMandateView, parseTokenEvent, startMandate, PENDING_MANDATE_TTL_MS,
} from './mandateService.js';
import { decryptToken } from '../../lib/tokenCrypto.js';

const makeClient = () => ({
  createCustomer: vi.fn(async () => 'cust_Test1'),
  createMandateOrder: vi.fn(async () => 'order_Test1'),
  cancelToken: vi.fn(async () => undefined),
});
const start = (client = makeClient(), over: Partial<Parameters<typeof startMandate>[0]> = {}, at = now) =>
  startMandate({ shopId: 'shop-1', ownerId: 'owner-1', acceptTerms: true, contactE164: '+919876543210', ...over }, client, at);

const tokenPayload = (event: string, over: Record<string, unknown> = {}) => ({
  event, payload: { token: { entity: { id: 'token_Abc1', customer_id: 'cust_Test1', ...over } } },
});
const ev = (event: string, over: Record<string, unknown> = {}) => parseTokenEvent(tokenPayload(event, over))!;
const noCancel = { cancelToken: vi.fn(async () => undefined) };
const only = () => state.rows[0] as unknown as Row;

beforeEach(() => {
  state.rows = [];
  state.seq = 0;
  state.env.SHOP_COLLECTION_MODE = 'test';
  state.env.PRINTQ_ENVIRONMENT = 'development';
  state.env.SHOP_COLLECTION_PILOT_CAP_PAISE = 1_500_000;
  state.env.COLLECTION_TOKEN_ENC_KEY = KEY;
  noCancel.cancelToken.mockClear();
});

describe('startMandate', () => {
  it('requires explicit terms acceptance and records the timestamp', async () => {
    await expect(start(makeClient(), { acceptTerms: false })).rejects.toMatchObject({ status: 400 });
    expect(state.rows).toHaveLength(0);
    const out = await start();
    expect(only().cancellationTermsAcceptedAt).toEqual(now);
    expect(out).toMatchObject({ keyId: 'rzp_test_example', orderId: 'order_Test1', customerId: 'cust_Test1', maxAmountPaise: 1_500_000 });
  });

  it('decides the cap server-side and never exceeds the pilot cap', async () => {
    state.env.SHOP_COLLECTION_PILOT_CAP_PAISE = 700_000;
    const client = makeClient();
    await start(client);
    expect(client.createMandateOrder).toHaveBeenCalledWith(expect.objectContaining({
      maxAmountPaise: 700_000, pilotCapPaise: 700_000, customerId: 'cust_Test1',
    }));
    expect(only().maxAmountPaise).toBe(700_000);
  });

  it('is 404 when disabled or in production, and for an owner that is not in the shop', async () => {
    state.env.SHOP_COLLECTION_MODE = 'disabled';
    await expect(start()).rejects.toMatchObject({ status: 404 });
    state.env.SHOP_COLLECTION_MODE = 'test';
    state.env.PRINTQ_ENVIRONMENT = 'production';
    await expect(start()).rejects.toMatchObject({ status: 404 });
    state.env.PRINTQ_ENVIRONMENT = 'development';
    await expect(start(makeClient(), { shopId: 'shop-2' })).rejects.toMatchObject({ status: 404 });
    expect(state.rows).toHaveLength(0);
  });

  it('allows only one open mandate per shop under concurrent starts', async () => {
    const client = makeClient();
    const results = await Promise.allSettled([start(client), start(client), start(client)]);
    expect(state.rows).toHaveLength(1);
    // Losers either see "setup in progress" (409) or resume the same checkout;
    // there is never a second provider order or a second row.
    expect(client.createMandateOrder).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    for (const r of results) if (r.status === 'rejected') expect(r.reason).toMatchObject({ status: 409 });
  });

  it('rejects a new start when a mandate is active, and restarts a stale pending one', async () => {
    await start();
    only().status = 'active';
    await expect(start()).rejects.toMatchObject({ status: 409 });
    only().status = 'pending';
    const later = new Date(now.getTime() + PENDING_MANDATE_TTL_MS + 1);
    await start(makeClient(), {}, later);
    expect(state.rows).toHaveLength(2);
    expect(only().status).toBe('failed');
  });

  it('maps provider failures to a generic error and fails the reservation', async () => {
    const client = makeClient();
    client.createCustomer.mockRejectedValueOnce(new Error('Razorpay TEST request failed (HTTP 400) secret-detail'));
    const error = await start(client).catch((e) => e as Error);
    expect(error).toMatchObject({ status: 502 });
    expect(String(error.message)).not.toContain('secret-detail');
    expect(only().status).toBe('failed');
    await start(makeClient()); // the shop can retry immediately
  });
});

describe('getMandateView', () => {
  it('hides everything unless TEST mode is on, and never exposes ids or tokens', async () => {
    state.env.SHOP_COLLECTION_MODE = 'disabled';
    expect(await getMandateView('shop-1')).toMatchObject({ enabled: false, mandate: null });
    state.env.SHOP_COLLECTION_MODE = 'test';
    await start();
    const view = await getMandateView('shop-1');
    expect(view.enabled).toBe(true);
    expect(view.mandate?.status).toBe('pending');
    expect(JSON.stringify(view)).not.toMatch(/cust_|order_|token/);
    expect((await getMandateView('shop-2')).mandate).toBeNull();
  });
});

describe('token webhook state machine', () => {
  beforeEach(async () => { await start(); });

  it('token.confirmed activates and stores the token encrypted', async () => {
    expect(await applyTokenEvent(ev('token.confirmed'), 'evt1', noCancel, now)).toBe('applied');
    expect(only().status).toBe('active');
    expect(only().providerTokenId).not.toContain('token_Abc1');
    expect(decryptToken(only().providerTokenId!, only().id)).toBe('token_Abc1');
    expect(only().activatedAt).toEqual(now);
  });

  it('a replayed confirmation is a no-op', async () => {
    await applyTokenEvent(ev('token.confirmed'), 'evt1', noCancel, now);
    const stored = only().providerTokenId;
    expect(await applyTokenEvent(ev('token.confirmed'), 'evt1', noCancel, now)).toBe('ignored');
    expect(only().providerTokenId).toBe(stored);
  });

  it('rejected -> failed; a late confirmation cannot resurrect it', async () => {
    await applyTokenEvent(ev('token.rejected', { id: 'token_Rej1' }), 'e1', noCancel, now);
    expect(only().status).toBe('failed');
    expect(await applyTokenEvent(ev('token.confirmed'), 'e2', noCancel, now)).toBe('ignored');
    expect(only().status).toBe('failed');
    expect(only().providerTokenId).toBeNull();
  });

  it('cancelled before confirmed (out of order) stays revoked and cancels the orphan token', async () => {
    await applyTokenEvent(ev('token.cancelled'), 'e1', noCancel, now);
    expect(only().status).toBe('revoked');
    expect(only().revokedAt).toEqual(now);
    expect(await applyTokenEvent(ev('token.confirmed'), 'e2', noCancel, now)).toBe('ignored');
    expect(only().status).toBe('revoked');
    expect(noCancel.cancelToken).toHaveBeenCalledWith('cust_Test1', 'token_Abc1');
  });

  it('paused then confirmed again resumes; pause of a pending mandate is ignored', async () => {
    expect(await applyTokenEvent(ev('token.paused'), 'e0', noCancel, now)).toBe('ignored');
    expect(only().status).toBe('pending');
    await applyTokenEvent(ev('token.confirmed'), 'e1', noCancel, now);
    await applyTokenEvent(ev('token.paused'), 'e2', noCancel, now);
    expect(only().status).toBe('paused');
    await applyTokenEvent(ev('token.confirmed'), 'e3', noCancel, now);
    expect(only().status).toBe('active');
  });

  it('active -> cancelled revokes', async () => {
    await applyTokenEvent(ev('token.confirmed'), 'e1', noCancel, now);
    await applyTokenEvent(ev('token.cancelled'), 'e2', noCancel, now);
    expect(only().status).toBe('revoked');
  });

  it('ignores events for an unknown customer or token safely', async () => {
    expect(await applyTokenEvent(ev('token.confirmed', { customer_id: 'cust_Other' }), 'e1', noCancel, now)).toBe('unknown_token');
    await applyTokenEvent(ev('token.confirmed'), 'e2', noCancel, now);
    expect(await applyTokenEvent(ev('token.cancelled', { id: 'token_Different' }), 'e3', noCancel, now)).toBe('unknown_token');
    expect(only().status).toBe('active');
  });

  it('does not activate when the provider ceiling differs from the requested one', async () => {
    await applyTokenEvent(ev('token.confirmed', { max_amount: 2_000_000 }), 'e1', noCancel, now);
    expect(only().status).toBe('failed');
    expect(only().providerTokenId).toBeNull();
  });

  it('does nothing outside TEST mode', async () => {
    state.env.SHOP_COLLECTION_MODE = 'disabled';
    expect(await applyTokenEvent(ev('token.confirmed'), 'e1', noCancel, now)).toBe('ignored');
    expect(only().status).toBe('pending');
  });
});

describe('parseTokenEvent', () => {
  it('only parses well-formed token events', () => {
    expect(parseTokenEvent({ event: 'payment.captured' })).toBeNull();
    expect(parseTokenEvent({ event: 'token.confirmed', payload: {} })).toBeNull();
    expect(parseTokenEvent(tokenPayload('token.confirmed', { customer_id: 'bad id' }))).toBeNull();
    expect(parseTokenEvent(tokenPayload('token.confirmed', { id: 'weird' }))?.tokenId).toBeNull();
  });
});

describe('cancelMandate', () => {
  it('cancels the provider token, then marks the mandate revoked', async () => {
    await start();
    await applyTokenEvent(ev('token.confirmed'), 'e1', noCancel, now);
    const client = makeClient();
    await cancelMandate('shop-1', client, now);
    expect(client.cancelToken).toHaveBeenCalledWith('cust_Test1', 'token_Abc1');
    expect(only().status).toBe('revoked');
  });

  it('does not mark cancelled when the provider call fails', async () => {
    await start();
    await applyTokenEvent(ev('token.confirmed'), 'e1', noCancel, now);
    const client = makeClient();
    client.cancelToken.mockRejectedValueOnce(new Error('boom'));
    await expect(cancelMandate('shop-1', client, now)).rejects.toMatchObject({ status: 502 });
    expect(only().status).toBe('active');
  });

  it('revokes a pending mandate locally and 404s for another shop or none', async () => {
    await start();
    const client = makeClient();
    await expect(cancelMandate('shop-2', client)).rejects.toMatchObject({ status: 404 });
    await cancelMandate('shop-1', client, now);
    expect(client.cancelToken).not.toHaveBeenCalled();
    expect(only().status).toBe('revoked');
    await expect(cancelMandate('shop-1', client)).rejects.toMatchObject({ status: 404 });
  });
});
