import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

const state = vi.hoisted(() => ({
  admin: { id: 'admin-1', email: 'owner@example.test', active: true, role: 'platform_admin', sessionVersion: 0, passwordHash: '' },
  reset: null as null | { id: string; adminId: string; otpHash: string; attempts: number; expiresAt: Date; consumedAt: Date | null; createdAt: Date },
  known: false,
  sentText: '',
  send: vi.fn(async (_email: string, _subject: string, body: string) => { state.sentText = body; return { providerMessageId: 'test-message' }; }),
  audit: vi.fn(async () => ({})),
}));

vi.mock('../../middleware/rateLimit.js', () => ({
  loginLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  otpRequestLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  otpVerifyLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../providers/email/index.js', () => ({ emailProvider: { name: 'resend', send: state.send } }));
vi.mock('../../lib/prisma.js', () => ({ prisma: {
  $disconnect: vi.fn(async () => undefined),
  adminUser: {
    findUnique: vi.fn(async () => state.known ? state.admin : null),
    update: vi.fn(async ({ data }: { data: { passwordHash: string; sessionVersion: { increment: number } } }) => {
      state.admin.passwordHash = data.passwordHash;
      state.admin.sessionVersion += data.sessionVersion.increment;
      return state.admin;
    }),
  },
  adminPasswordResetOtp: {
    findFirst: vi.fn(async ({ where }: { where: { createdAt?: unknown } }) => where.createdAt ? null : state.reset),
    count: vi.fn(async () => 0),
    create: vi.fn(async ({ data }: { data: { adminId: string; otpHash: string; expiresAt: Date } }) => {
      state.reset = { id: 'reset-1', adminId: data.adminId, otpHash: data.otpHash, attempts: 0,
        expiresAt: data.expiresAt, consumedAt: null, createdAt: new Date() };
      return state.reset;
    }),
    update: vi.fn(async () => state.reset),
    updateMany: vi.fn(async ({ where, data }: { where: { consumedAt: null; attempts: { lt: number } }; data: { consumedAt?: Date; attempts?: { increment: number } } }) => {
      if (!state.reset || state.reset.consumedAt !== where.consumedAt || state.reset.attempts >= where.attempts.lt) return { count: 0 };
      if (data.consumedAt) state.reset.consumedAt = data.consumedAt;
      if (data.attempts) state.reset.attempts += data.attempts.increment;
      return { count: 1 };
    }),
  },
  adminAuditEvent: { create: state.audit },
  $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback((await import('../../lib/prisma.js')).prisma)),
} }));

let server: Server;
let base: string;
let signAdminToken: typeof import('../../lib/tokens.js')['signAdminToken'];

beforeAll(async () => {
  const [{ adminRouter }, { errorHandler }, tokens] = await Promise.all([
    import('./routes.js'), import('../../middleware/error.js'), import('../../lib/tokens.js'),
  ]);
  signAdminToken = tokens.signAdminToken;
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test server address');
  base = `http://127.0.0.1:${address.port}/api/admin`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
beforeEach(() => {
  state.known = false;
  state.reset = null;
  state.sentText = '';
  state.admin.sessionVersion = 0;
  state.admin.passwordHash = '';
  state.send.mockClear();
  state.audit.mockClear();
});

async function post(path: string, body: object) {
  return fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

describe('platform-admin recovery boundary', () => {
  it('does not reveal whether an admin email exists', async () => {
    const response = await post('/auth/request-reset', { email: 'unknown@example.test' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(state.send).not.toHaveBeenCalled();
  });

  it('consumes a valid code once and revokes the previous admin session', async () => {
    state.known = true;
    const oldToken = signAdminToken(state.admin.id, 0);
    expect((await fetch(`${base}/me`, { headers: { Authorization: `Bearer ${oldToken}` } })).status).toBe(200);
    expect((await post('/auth/request-reset', { email: state.admin.email })).status).toBe(200);
    const code = state.sentText.match(/\b\d{6}\b/)?.[0];
    expect(code).toMatch(/^\d{6}$/);
    expect((await post('/auth/reset-password', { email: state.admin.email, otp: 'xxxxxx', newPassword: 'new-secret-password-123' })).status).toBe(400);
    const reset = { email: state.admin.email, otp: code, newPassword: 'new-secret-password-123' };
    expect((await post('/auth/reset-password', reset)).status).toBe(200);
    expect(state.admin.sessionVersion).toBe(1);
    expect(state.audit).toHaveBeenCalledOnce();
    expect((await fetch(`${base}/me`, { headers: { Authorization: `Bearer ${oldToken}` } })).status).toBe(401);
    expect((await post('/auth/reset-password', reset)).status).toBe(400);
  });
});
