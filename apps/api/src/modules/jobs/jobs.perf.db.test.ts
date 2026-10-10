/**
 * Regression budgets for the hot student/shop endpoints (production QA S3-3:
 * POST /api/jobs p50 5.5 s and POST confirm-print-completion p50 5.4 s, i.e.
 * ~230 ms per sequential database round trip Oregon -> Mumbai).
 *
 * Pins the number of SQL statements each request issues BEFORE it answers
 * (every statement is a network round trip in production) and that slow
 * notification delivery is not awaited. Set PRINTQ_PERF_OUT=<file> (and point
 * DATABASE_URL at a latency proxy) to append "<endpoint>: N statements, T ms".
 * Skipped without a migrated PostgreSQL.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const probe = vi.hoisted(() => ({
  sql: [] as string[],
  notifyDelayMs: Number(process.env.PRINTQ_PERF_NOTIFY_DELAY_MS ?? 600),
  notified: 0,
}));

vi.mock('../../lib/prisma.js', async () => {
  const { PrismaClient } = await import('@prisma/client');
  const client = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
  client.$on('query', (e) => { probe.sql.push(e.query); });
  return { prisma: client };
});
vi.mock('../../providers/notification/index.js', () => ({
  notifyStudent: vi.fn(async () => {
    await new Promise((r) => setTimeout(r, probe.notifyDelayMs));
    probe.notified += 1;
  }),
}));
vi.mock('../../realtime/events.js', () => ({ publishEvent: vi.fn(), subscribeEvents: vi.fn() }));

import { prisma } from '../../lib/prisma.js';
import { fileRetentionQueue, timersQueue } from '../../lib/queues.js';
import { drainBackground } from '../../lib/background.js';
import { signShopToken, signStudentToken } from '../../lib/tokens.js';
import { errorHandler } from '../../middleware/error.js';
import { shopRouter } from '../shops/routes.js';
import { jobsRouter } from './routes.js';

const dbReady = await (async () => {
  try {
    await prisma.shop.findFirst({ select: { counterCapacity: true } });
    await prisma.job.findFirst({ select: { claimedBySessionId: true } });
    return true;
  } catch (error) {
    console.warn('jobs.perf.db.test skipped: database not ready -', String(error).slice(0, 200));
    return false;
  }
})();

vi.setConfig({ testTimeout: 60_000 });

/** Statements allowed on the request path (before the response). */
const BUDGET = { create: 6, quote: 2, status: 4, confirm: 4 };

const specs = { copies: 1, paperSize: 'A4', color: false, duplex: false, binding: null, pageRange: null };

describe.runIf(dbReady)('hot endpoint request budgets (database)', () => {
  let shopId = '';
  let printerId = '';
  let shopToken = '';
  let server: Server;
  let base = '';
  const studentIds: string[] = [];
  const spies = [
    vi.spyOn(timersQueue, 'add').mockResolvedValue(undefined as never),
    vi.spyOn(fileRetentionQueue, 'add').mockResolvedValue(undefined as never),
  ];

  async function student() {
    const s = await prisma.student.create({
      data: { phone: `+91${Math.floor(1_000_000_000 + Math.random() * 8_999_999_999)}`, name: 'Perf' },
    });
    studentIds.push(s.id);
    return { id: s.id, token: signStudentToken(s.id) };
  }
  async function readyFile(studentId: string) {
    return prisma.uploadedFile.create({
      data: {
        studentId, shopId, originalName: 'a.pdf', originalKey: `k-${randomUUID()}`, convertedKey: `c-${randomUUID()}`,
        mimeType: 'application/pdf', sizeBytes: 1, pages: 3, status: 'ready',
        deleteAfter: new Date(Date.now() + 86_400_000),
      },
    });
  }
  const call = (token: string, path: string, method = 'GET', body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  /** Runs `fn`, returns statements + wall time up to the response, and what ran after. */
  async function measure(label: string, budget: number, fn: () => Promise<Response>) {
    await drainBackground();
    probe.sql.length = 0;
    probe.notified = 0;
    const t0 = performance.now();
    const res = await fn();
    const ms = Math.round(performance.now() - t0);
    const before = probe.sql.length;
    const notified = probe.notified;
    if (process.env.PRINTQ_PERF_VERBOSE) {
      console.log(`${label}\n${probe.sql.slice(0, before).map((s, i) => `${i + 1}. ${s.replace(/\s+/g, ' ').slice(0, 120)}`).join('\n')}`);
    }
    if (process.env.PRINTQ_PERF_OUT) appendFileSync(process.env.PRINTQ_PERF_OUT, `${label}: ${before} statements, ${ms} ms\n`);
    // PRINTQ_PERF_NOBUDGET=1 only records numbers (used to capture "before" figures)
    if (!process.env.PRINTQ_PERF_NOBUDGET) expect(before, `${label} statements before response`).toBeLessThanOrEqual(budget);
    expect(notified, `${label} must not wait for notifications`).toBe(0);
    await drainBackground();
    return res;
  }

  beforeAll(async () => {
    const shop = await prisma.shop.create({
      data: {
        slug: `jperf-${randomUUID().slice(0, 8)}`, name: 'Perf shop', address: 'Test lane',
        latitude: 28.6, longitude: 77.2, rateCard: { bw: 100, color: 500 }, counterCapacity: 5,
      },
    });
    shopId = shop.id;
    const printer = await prisma.printer.create({
      data: { shopId, label: 'P1', paperSizesLoaded: ['A4'], colorSupport: false, status: 'online' },
    });
    printerId = printer.id;
    await prisma.agent.create({
      data: {
        shopId, machineLabel: 'PC', tokenHash: randomUUID(), status: 'online',
        connectedPrinterIds: [printerId], lastHeartbeatAt: new Date(),
      },
    });
    const owner = await prisma.shopUser.create({
      data: { shopId, email: `${randomUUID()}@perf.test`, passwordHash: 'x', name: 'Owner', role: 'owner' },
    });
    shopToken = signShopToken(owner.id, shopId, 'owner', owner.sessionVersion);
    await Promise.all(Array.from({ length: 6 }, () => prisma.shop.findFirst({ select: { id: true } })));
    const app = express();
    app.use(express.json());
    app.use('/api/jobs', jobsRouter);
    app.use('/api/shop', shopRouter);
    app.use(errorHandler);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await drainBackground();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const jobs = await prisma.job.findMany({ where: { shopId }, select: { id: true } });
    const ids = jobs.map((j) => j.id);
    await prisma.shopCommissionEntry.deleteMany({ where: { jobId: { in: ids } } });
    await prisma.realtimeOutbox.deleteMany({ where: { jobId: { in: ids } } });
    await prisma.jobEvent.deleteMany({ where: { jobId: { in: ids } } });
    await prisma.job.deleteMany({ where: { id: { in: ids } } });
    await prisma.uploadedFile.deleteMany({ where: { studentId: { in: studentIds } } });
    await prisma.agent.deleteMany({ where: { shopId } });
    await prisma.printer.deleteMany({ where: { shopId } });
    await prisma.shopUser.deleteMany({ where: { shopId } });
    await prisma.shop.delete({ where: { id: shopId } });
    await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
    spies.forEach((s) => s.mockRestore());
  });

  it('POST /api/jobs, quote and GET /:id stay inside their statement budgets and behave the same', async () => {
    const s = await student();
    // warm-up (prepared statements, pooled connections)
    const warmFile = await readyFile(s.id);
    await call(s.token, '/api/jobs', 'POST', { fileId: warmFile.id, specs, mode: 'instant' });
    await drainBackground();

    const file = await readyFile(s.id);
    const quote = await measure('POST /api/jobs/quote', BUDGET.quote, () =>
      call(s.token, '/api/jobs/quote', 'POST', { fileId: file.id, specs }));
    expect(quote.status).toBe(200);

    const created = await measure('POST /api/jobs', BUDGET.create, () =>
      call(s.token, '/api/jobs', 'POST', { fileId: file.id, specs, mode: 'instant' }));
    expect(created.status).toBe(201);
    const body = (await created.json()) as { job: { id: string; status: string; totalPaise: number } };
    expect(body.job.status).toBe('awaiting_arrival');
    await drainBackground();
    const row = await prisma.job.findUniqueOrThrow({ where: { id: body.job.id } });
    expect(row.status).toBe('awaiting_arrival');
    expect(row.paymentStatus).toBe('counter_due');
    expect(row.releaseCodeDigest).toBeTruthy();
    expect(row.releaseCodeEncrypted).toBeTruthy();
    const events = await prisma.jobEvent.findMany({ where: { jobId: row.id } });
    expect(events.map((e) => e.event)).toContain('CASH_SELECTED');
    expect(probe.notified).toBeGreaterThanOrEqual(1); // "order prepared" push still sent, after the response

    // duplicate order for the same file is still refused
    const dup = await call(s.token, '/api/jobs', 'POST', { fileId: file.id, specs, mode: 'instant' });
    expect(dup.status).toBe(409);

    const status = await measure('GET /api/jobs/:id', BUDGET.status, () => call(s.token, `/api/jobs/${body.job.id}`));
    expect(status.status).toBe(200);

    // another student cannot create against this file
    const other = await student();
    const stolen = await call(other.token, '/api/jobs', 'POST', { fileId: file.id, specs, mode: 'instant' });
    expect(stolen.status).toBe(404);
  });

  it('GET /api/shop/queue and GET /api/jobs stay at or under 8 statements', async () => {
    const s = await student();
    const file = await readyFile(s.id);
    await call(s.token, '/api/jobs', 'POST', { fileId: file.id, specs, mode: 'instant' });
    await drainBackground();
    const queue = await measure('GET /api/shop/queue', 8, () => call(shopToken, '/api/shop/queue'));
    expect(queue.status).toBe(200);
    const list = await measure('GET /api/jobs', 8, () => call(s.token, '/api/jobs'));
    expect(list.status).toBe(200);
  });

  it('POST confirm-print-completion stays inside its statement budget; commission posts once', async () => {
    const s = await student();
    const file = await readyFile(s.id);
    const job = await prisma.job.create({
      data: {
        shopId, studentId: s.id, fileId: file.id, specs, pagesPerCopy: 3, priceBreakdown: {}, totalPaise: 500,
        shopBasePaise: 400, paymentProvider: 'pay_at_shop', paymentStatus: 'paid',
        counterPaymentMethod: 'cash', counterPaymentConfirmedAt: new Date(), counterPaymentAmountPaise: 500,
        status: 'printing', assignedPrinterId: printerId, spoolAcceptedAt: new Date(), printAttempts: 1,
      },
    });
    // warm-up on a throwaway job is unnecessary: connections are pooled already
    const res = await measure('POST confirm-print-completion', BUDGET.confirm, () =>
      call(shopToken, `/api/shop/jobs/${job.id}/confirm-print-completion`, 'POST', {}));
    expect(res.status).toBe(200);
    const done = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(done.status).toBe('ready_for_pickup');
    expect(done.printConfirmedAt).not.toBeNull();
    expect(done.printCompletionMethod).toBe('staff_confirmed');
    expect(await prisma.shopCommissionEntry.count({ where: { jobId: job.id, type: 'print_commission' } })).toBe(1);
    expect(probe.notified).toBeGreaterThanOrEqual(1);
    const again = await call(shopToken, `/api/shop/jobs/${job.id}/confirm-print-completion`, 'POST', {});
    expect(again.status).toBe(409);
    expect(await prisma.shopCommissionEntry.count({ where: { jobId: job.id, type: 'print_commission' } })).toBe(1);
  });
});
