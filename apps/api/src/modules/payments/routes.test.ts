import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ upsert: vi.fn(async () => ({})) }));

vi.mock('../../config/env.js', () => ({ env: {
  LOG_LEVEL: 'silent',
  PAYMENT_PROVIDER: 'mock',
  RAZORPAY_WEBHOOK_SECRET: 'retired-student-webhook-secret',
  RAZORPAY_RECURRING_WEBHOOK_SECRET: 'recurring-test-webhook-secret',
} }));
vi.mock('../../lib/prisma.js', () => ({ prisma: {
  $disconnect: vi.fn(async () => undefined),
  paymentEvent: { upsert: state.upsert },
} }));

import { webhookRouter } from './routes.js';

let server: Server;
let endpoint: string;

beforeAll(async () => {
  const app = express();
  app.use('/api/payments/webhook', webhookRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/payments/webhook/razorpay`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('Razorpay recurring webhook endpoint', () => {
  const payload = JSON.stringify({ event: 'payment.captured' });
  const sign = (secret: string) => createHmac('sha256', secret).update(payload).digest('hex');

  it('rejects a retired student signature without recording the event', async () => {
    state.upsert.mockClear();
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': sign('retired-student-webhook-secret') },
      body: payload,
    });
    expect(response.status).toBe(400);
    expect(state.upsert).not.toHaveBeenCalled();
  });

  it('records a valid recurring event without moving money', async () => {
    state.upsert.mockClear();
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': sign('recurring-test-webhook-secret'),
        'x-razorpay-event-id': 'evt_test_recurring_1',
      },
      body: payload,
    });
    expect(response.status).toBe(200);
    expect(state.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ providerEventId: 'evt_test_recurring_1', jobId: null }),
    }));
  });
});
