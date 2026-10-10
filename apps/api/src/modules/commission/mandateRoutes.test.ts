import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const JWT_SECRET = 'route-test-jwt-secret-that-is-long-enough-to-pass';
const state = vi.hoisted(() => ({
  start: vi.fn(async () => ({ keyId: 'rzp_test_x', orderId: 'order_1', customerId: 'cust_1', maxAmountPaise: 1000, expiresAt: 'x' })),
  cancel: vi.fn(async () => undefined),
  view: vi.fn(async () => ({ enabled: true, pilotCapPaise: 1000, mandate: null })),
}));

vi.mock('../../config/env.js', () => ({ env: { JWT_SECRET: 'route-test-jwt-secret-that-is-long-enough-to-pass', LOG_LEVEL: 'silent' } }));
vi.mock('../../lib/prisma.js', () => ({ prisma: { $disconnect: vi.fn(async () => undefined) } }));
vi.mock('./mandateService.js', () => ({
  startMandate: state.start, cancelMandate: state.cancel, getMandateView: state.view,
}));

import { mandateRouter } from './mandateRoutes.js';
import { errorHandler } from '../../middleware/error.js';

let server: Server;
let base: string;
const token = (role: 'owner' | 'staff', typ = 'shop') =>
  jwt.sign({ typ, shopId: 'shop-1', role }, JWT_SECRET, { subject: 'user-1', expiresIn: '1h' });
const call = (path: string, init: { method?: string; auth?: string; body?: unknown } = {}) =>
  fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(init.auth ? { authorization: `Bearer ${init.auth}` } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/shop/collection-mandate', mandateRouter);
  app.use(errorHandler);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/shop/collection-mandate`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

describe('mandate routes authorization and input', () => {
  it('requires a shop owner on every route', async () => {
    for (const [path, method] of [['', 'GET'], ['', 'POST'], ['/cancel', 'POST']] as const) {
      expect((await call(path, { method })).status).toBe(401);
      expect((await call(path, { method, auth: token('staff') })).status).toBe(401);
      expect((await call(path, { method, auth: token('owner', 'student') })).status).toBe(401);
    }
    expect(state.start).not.toHaveBeenCalled();
    expect(state.cancel).not.toHaveBeenCalled();
  });

  it('start requires acceptTerms:true and a valid contact, and takes no amount', async () => {
    const auth = token('owner');
    for (const body of [{}, { contact: '+919876543210' }, { acceptTerms: false, contact: '+919876543210' },
      { acceptTerms: true, contact: '9876543210' }, { acceptTerms: true, contact: '+919876543210', maxAmountPaise: 99 }]) {
      expect((await call('', { method: 'POST', auth, body })).status).toBe(400);
    }
    expect(state.start).not.toHaveBeenCalled();
    const ok = await call('', { method: 'POST', auth, body: { acceptTerms: true, contact: '+919876543210' } });
    expect(ok.status).toBe(201);
    expect(state.start).toHaveBeenCalledWith({
      shopId: 'shop-1', ownerId: 'user-1', acceptTerms: true, contactE164: '+919876543210',
    });
  });

  it('scopes status and cancel to the token shop', async () => {
    const auth = token('owner');
    expect((await call('', { auth })).status).toBe(200);
    expect(state.view).toHaveBeenCalledWith('shop-1');
    expect((await call('/cancel', { method: 'POST', auth })).status).toBe(200);
    expect(state.cancel).toHaveBeenCalledWith('shop-1');
  });
});
