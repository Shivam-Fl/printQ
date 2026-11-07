import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

const state = vi.hoisted(() => ({
  admin: { id: 'admin-1', active: true, role: 'platform_admin', sessionVersion: 0 },
  campuses: [] as { id: string; name: string; isActive: boolean }[],
  audit: [] as { action: string; subjectId: string; metadata?: unknown }[],
  invalidate: vi.fn(),
  campusCreate: vi.fn(async ({ data }: { data: { name: string; isActive: boolean } }) => ({ id: 'campus-new', ...data })),
}));

vi.mock('../../middleware/rateLimit.js', () => ({
  loginLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  otpRequestLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  otpVerifyLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../providers/email/index.js', () => ({ emailProvider: { name: 'console', send: vi.fn() } }));
vi.mock('../public/cache.js', () => ({ invalidatePublicCaches: state.invalidate }));
vi.mock('../../lib/prisma.js', () => ({ prisma: {
  $disconnect: vi.fn(async () => undefined),
  adminUser: {
    findUnique: vi.fn(async () => ({ ...state.admin, name: 'Ops' })),
    updateMany: vi.fn(async ({ where, data }: { where: { id: string }; data: { sessionVersion: { increment: number } } }) => {
      if (where.id !== state.admin.id) return { count: 0 };
      state.admin.sessionVersion += data.sessionVersion.increment;
      return { count: 1 };
    }),
  },
  campus: {
    findFirst: vi.fn(async ({ where }: { where: { name: { equals: string }; NOT?: { id: string } } }) =>
      state.campuses.find((c) => c.name.toLowerCase() === where.name.equals.toLowerCase() && c.id !== where.NOT?.id) ?? null),
    findUnique: vi.fn(async ({ where }: { where: { id?: string; slug?: string } }) =>
      where.id ? state.campuses.find((c) => c.id === where.id) ?? null : null),
    create: state.campusCreate,
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: object }) => ({ ...state.campuses.find((c) => c.id === where.id), ...data })),
  },
  shop: {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (where.id === 'shop-1' ? { id: 'shop-1' } : null)),
    update: vi.fn(async () => ({ id: 'shop-1', verificationStatus: 'verified', publishedAt: null })),
  },
  adminAuditEvent: { create: vi.fn(async ({ data }: { data: { action: string; subjectId: string; metadata?: unknown } }) => { state.audit.push(data); return data; }) },
  $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback((await import('../../lib/prisma.js')).prisma)),
} }));

let server: Server;
let base: string;
let token: string;
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
  state.admin.sessionVersion = 0;
  state.campuses = [{ id: 'campus-1', name: 'IIT Delhi', isActive: true }];
  state.audit = [];
  state.invalidate.mockClear();
  state.campusCreate.mockClear();
  token = signAdminToken(state.admin.id, 0);
});

function call(path: string, method = 'GET', body?: object) {
  return fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe('admin console API', () => {
  it('sign out revokes the admin token server-side', async () => {
    expect((await call('/me')).status).toBe(200);
    expect((await call('/auth/logout', 'POST')).status).toBe(200);
    expect(state.admin.sessionVersion).toBe(1);
    expect((await call('/me')).status).toBe(401);
  });

  it('refuses a campus whose name already exists, ignoring case and extra spaces', async () => {
    const response = await call('/campuses', 'POST', { name: '  iit   delhi ', address: 'Hauz Khas, New Delhi' });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain('IIT Delhi');
    expect(state.campusCreate).not.toHaveBeenCalled();
  });

  it('creates a new campus and clears the public caches', async () => {
    const response = await call('/campuses', 'POST', { name: 'DU  North Campus', address: 'Delhi University' });
    expect(response.status).toBe(201);
    expect(state.campusCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ name: 'DU North Campus' }) }));
    expect(state.invalidate).toHaveBeenCalledOnce();
  });

  it('deactivating a campus is audited and clears the public caches', async () => {
    const response = await call('/campuses/campus-1', 'PATCH', { isActive: false });
    expect(response.status).toBe(200);
    expect(state.audit[0]).toMatchObject({ action: 'campus.updated', metadata: { active: false, changed: ['isActive'] } });
    expect(state.invalidate).toHaveBeenCalledOnce();
  });

  it('renaming a campus to another campus name is refused', async () => {
    state.campuses.push({ id: 'campus-2', name: 'DU North', isActive: false });
    const response = await call('/campuses/campus-1', 'PATCH', { name: 'du north' });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain('inactive');
  });

  it('records the unpublish reason in the audit event', async () => {
    expect((await call('/shops/shop-1/unpublish', 'POST', { reason: '  Fake shop, reported by students ' })).status).toBe(200);
    expect(state.audit[0]).toMatchObject({ action: 'shop.unpublished', subjectId: 'shop-1', metadata: { reason: 'Fake shop, reported by students' } });
    expect(state.invalidate).toHaveBeenCalledOnce();
  });

  it('still unpublishes without a body or reason', async () => {
    expect((await call('/shops/shop-1/unpublish', 'POST')).status).toBe(200);
    expect((await call('/shops/shop-1/unpublish', 'POST', { reason: '' })).status).toBe(200);
    expect(state.audit.map((event) => event.metadata)).toEqual([undefined, undefined]);
    expect((await call('/shops/missing/unpublish', 'POST', {})).status).toBe(404);
  });

  it('rejects an unknown shop filter', async () => {
    expect((await call('/shops?view=everything')).status).toBe(400);
  });
});
