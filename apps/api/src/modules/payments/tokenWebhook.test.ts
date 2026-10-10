import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Prisma } from '@prisma/client';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  create: vi.fn(async () => ({})),
  deleteMany: vi.fn(async () => ({})),
  upsert: vi.fn(async () => ({})),
  apply: vi.fn(async () => 'applied'),
}));

vi.mock('../../config/env.js', () => ({ env: {
  LOG_LEVEL: 'silent',
  PAYMENT_PROVIDER: 'mock',
  RAZORPAY_WEBHOOK_SECRET: 'retired-student-webhook-secret',
  RAZORPAY_RECURRING_WEBHOOK_SECRET: 'recurring-test-webhook-secret',
} }));
vi.mock('../../lib/prisma.js', () => ({ prisma: {
  $disconnect: vi.fn(async () => undefined),
  paymentEvent: { create: state.create, deleteMany: state.deleteMany, upsert: state.upsert },
} }));
vi.mock('../commission/mandateService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../commission/mandateService.js')>();
  return { ...actual, applyTokenEvent: state.apply };
});

import { webhookRouter } from './routes.js';

let server: Server;
let endpoint: string;
const body = JSON.stringify({
  event: 'token.confirmed',
  payload: { token: { entity: { id: 'token_Abc1', customer_id: 'cust_Test1' } } },
});
const post = (payload: string, secret: string, eventId: string) => fetch(endpoint, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-razorpay-signature': createHmac('sha256', secret).update(payload).digest('hex'),
    'x-razorpay-event-id': eventId,
  },
  body: payload,
});

beforeAll(async () => {
  const app = express();
  app.use('/api/payments/webhook', webhookRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/payments/webhook/razorpay`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
beforeEach(() => Object.values(state).forEach((fn) => fn.mockClear()));

describe('token.* webhook', () => {
  it('rejects a bad signature (including the retired student secret) without touching state', async () => {
    expect((await post(body, 'retired-student-webhook-secret', 'e1')).status).toBe(400);
    expect((await post(body, 'wrong', 'e1')).status).toBe(400);
    expect(state.create).not.toHaveBeenCalled();
    expect(state.apply).not.toHaveBeenCalled();
  });

  it('applies a signed token event once', async () => {
    expect((await post(body, 'recurring-test-webhook-secret', 'evt_token_1')).status).toBe(200);
    expect(state.apply).toHaveBeenCalledWith(
      { event: 'token.confirmed', tokenId: 'token_Abc1', customerId: 'cust_Test1', maxAmountPaise: null },
      'evt_token_1',
    );
  });

  it('treats a replayed event id as a duplicate', async () => {
    state.create.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }));
    const response = await post(body, 'recurring-test-webhook-secret', 'evt_token_1');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ duplicate: true });
    expect(state.apply).not.toHaveBeenCalled();
  });

  it('forgets the dedupe row when processing fails so the provider retry re-applies', async () => {
    state.apply.mockRejectedValueOnce(new Error('db down'));
    const response = await post(body, 'recurring-test-webhook-secret', 'evt_token_2');
    expect(response.status).toBe(500);
    expect(state.deleteMany).toHaveBeenCalledWith({ where: { providerEventId: 'evt_token_2' } });
  });

  it('does not route non-token events to the mandate handler', async () => {
    await post(JSON.stringify({ event: 'payment.authorized' }), 'recurring-test-webhook-secret', 'evt_pay_1');
    expect(state.apply).not.toHaveBeenCalled();
    expect(state.upsert).toHaveBeenCalled();
  });
});
