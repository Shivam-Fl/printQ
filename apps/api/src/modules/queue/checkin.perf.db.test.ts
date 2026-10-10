/**
 * Regression budget for POST /api/jobs/:id/check-in (production QA S3-4: 8.6 s).
 *
 * The handler used to run ~25 sequential database round trips plus awaited FCM /
 * Web Push delivery on the request path. This test pins:
 *  - the number of SQL statements (each one is a network round trip in prod),
 *  - that slow notification delivery is NOT awaited by the request,
 *  - that the reveal + check-in notifications still fire exactly once,
 *  - that the response already carries the new position / band.
 *
 * Needs the migrated PostgreSQL CI provides; skipped without it. To see real
 * wall-clock numbers behind artificial latency, point DATABASE_URL at a
 * latency-injecting TCP proxy (scripts/dev note in the PR) and read the logged
 * timing line.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const probe = vi.hoisted(() => ({
  sql: [] as string[],
  notes: [] as { studentId: string; title: string; eventKey?: string }[],
  notifyDelayMs: Number(process.env.PRINTQ_PERF_NOTIFY_DELAY_MS ?? 600),
}));

vi.mock('../../lib/prisma.js', async () => {
  const { PrismaClient } = await import('@prisma/client');
  const client = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
  client.$on('query', (e) => { probe.sql.push(e.query); });
  return { prisma: client };
});
// A slow delivery channel (FCM / Web Push). It must never block the request.
vi.mock('../../providers/notification/index.js', () => ({
  notifyStudent: vi.fn(async (studentId: string, message: { title: string; eventKey?: string }) => {
    await new Promise((r) => setTimeout(r, probe.notifyDelayMs));
    probe.notes.push({ studentId, title: message.title, eventKey: message.eventKey });
  }),
}));
vi.mock('../../realtime/events.js', () => ({ publishEvent: vi.fn(), subscribeEvents: vi.fn() }));

import { prisma } from '../../lib/prisma.js';
import { timersQueue } from '../../lib/queues.js';
import { drainBackground } from '../../lib/background.js';
import { signStudentToken } from '../../lib/tokens.js';
import { errorHandler } from '../../middleware/error.js';
import { jobsRouter } from '../jobs/routes.js';
import { getJobLiveMetrics, preparePayAtShopOrder } from './engine.js';

const LAT = 28.6139;
const LNG = 77.209;

const dbReady = await (async () => {
  try {
    await prisma.shop.findFirst({ select: { counterCapacity: true } });
    await prisma.job.findFirst({ select: { revealedAt: true } });
    return true;
  } catch (error) {
    console.warn('checkin.perf.db.test skipped: database not ready -', String(error).slice(0, 200));
    return false;
  }
})();

vi.setConfig({ testTimeout: 60_000 });

/** Statements the check-in request may issue before it answers. */
const CHECKIN_SQL_BUDGET = 6;

describe.runIf(dbReady)('check-in request budget (database)', () => {
  let shopId = '';
  let server: Server;
  let base = '';
  const studentIds: string[] = [];
  const timerAdd = vi.spyOn(timersQueue, 'add').mockResolvedValue(undefined as never);

  async function prepared(forShop: string) {
    const student = await prisma.student.create({
      data: { phone: `+91${Math.floor(1_000_000_000 + Math.random() * 8_999_999_999)}`, name: 'Perf' },
    });
    studentIds.push(student.id);
    const file = await prisma.uploadedFile.create({
      data: {
        studentId: student.id, shopId: forShop, originalName: 'a.pdf', originalKey: `k-${randomUUID()}`,
        mimeType: 'application/pdf', sizeBytes: 1, pages: 1, status: 'ready',
      },
    });
    const job = await prisma.job.create({
      data: {
        shopId: forShop, studentId: student.id, fileId: file.id,
        specs: { copies: 1, paperSize: 'A4', color: false, duplex: false, binding: null, pageRange: null },
        pagesPerCopy: 1, priceBreakdown: {}, totalPaise: 500, paymentProvider: 'pay_at_shop',
      },
    });
    await preparePayAtShopOrder(job.id);
    await drainBackground();
    return { jobId: job.id, studentId: student.id, token: signStudentToken(student.id) };
  }

  const checkIn = (jobId: string, token: string) =>
    fetch(`${base}/api/jobs/${jobId}/check-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ latitude: LAT, longitude: LNG, accuracyM: 10, measuredAt: new Date().toISOString() }),
    });

  beforeAll(async () => {
    const shop = await prisma.shop.create({
      data: {
        slug: `perf-${randomUUID().slice(0, 8)}`, name: 'Perf shop', address: 'Test lane',
        latitude: LAT, longitude: LNG, rateCard: {}, counterCapacity: 5,
      },
    });
    shopId = shop.id;
    const printer = await prisma.printer.create({
      data: { shopId, label: 'P1', paperSizesLoaded: ['A4'], colorSupport: false, status: 'online' },
    });
    await prisma.agent.create({
      data: {
        shopId, machineLabel: 'PC', tokenHash: randomUUID(), status: 'online',
        connectedPrinterIds: [printer.id], lastHeartbeatAt: new Date(),
      },
    });
    // open several pooled connections so timings measure the request, not TCP/auth setup
    await Promise.all(Array.from({ length: 6 }, () => prisma.shop.findFirst({ select: { id: true } })));
    const app = express();
    app.use(express.json());
    app.use('/api/jobs', jobsRouter);
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
    await prisma.realtimeOutbox.deleteMany({ where: { jobId: { in: ids } } });
    await prisma.jobEvent.deleteMany({ where: { jobId: { in: ids } } });
    await prisma.job.deleteMany({ where: { id: { in: ids } } });
    await prisma.uploadedFile.deleteMany({ where: { studentId: { in: studentIds } } });
    await prisma.agent.deleteMany({ where: { shopId } });
    await prisma.printer.deleteMany({ where: { shopId } });
    await prisma.shop.delete({ where: { id: shopId } });
    await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
  });

  it('answers within the SQL budget, without waiting for slow notifications, with position+band', async () => {
    // warm prepared statements / pooled connections so timings reflect steady state
    const warm = await prepared(shopId);
    await checkIn(warm.jobId, warm.token);
    await drainBackground();
    const order = await prepared(shopId);
    probe.sql.length = 0;
    probe.notes.length = 0;
    timerAdd.mockClear();

    const started = performance.now();
    const res = await checkIn(order.jobId, order.token);
    const elapsedMs = Math.round(performance.now() - started);
    const sqlOnRequestPath = probe.sql.length;
    const notesAtResponse = probe.notes.length;
    if (process.env.PRINTQ_PERF_VERBOSE) {
      // eslint-disable-next-line no-console
      console.log(probe.sql.map((s, i) => `${i + 1}. ${s.replace(/\s+/g, ' ').slice(0, 110)}`).join('\n'));
    }
    const body = (await res.json()) as { job: { status: string; position: number; band: string; etaMinutes: number | null } };
    // Optional timing report (e.g. when DATABASE_URL points at a latency proxy).
    if (process.env.PRINTQ_PERF_OUT) {
      appendFileSync(process.env.PRINTQ_PERF_OUT, `${sqlOnRequestPath} SQL statements before response, ${elapsedMs} ms\n`);
    }

    expect(res.status).toBe(200);
    // New place is returned directly so the UI updates without a second fetch.
    expect(body.job).toMatchObject({ status: 'queued', position: 2, band: 'revealed' });
    expect(sqlOnRequestPath).toBeLessThanOrEqual(CHECKIN_SQL_BUDGET);
    // Two notifications (checked in + your turn) take 600 ms each: none may have
    // been delivered (let alone awaited) when the response is sent.
    expect(notesAtResponse).toBe(0);

    // Side effects still happen, exactly once, after the response.
    await drainBackground();
    const titles = probe.notes.map((n) => n.title).sort();
    expect(titles).toEqual(['Checked in at the shop ✓', 'It’s your turn']);
    expect(new Set(probe.notes.map((n) => n.eventKey)).size).toBe(2);
    expect(timerAdd).toHaveBeenCalledTimes(1);
    const job = await prisma.job.findUniqueOrThrow({ where: { id: order.jobId } });
    expect(job.revealedAt).not.toBeNull();
    const outbox = await prisma.realtimeOutbox.count({ where: { jobId: order.jobId } });
    expect(outbox).toBeGreaterThanOrEqual(2);
  });

  it('6 parallel check-ins from different students: all 200, unique positions, reveals == capacity, no duplicate notifications (D1)', async () => {
    const shop = await prisma.shop.create({
      data: {
        slug: `par-${randomUUID().slice(0, 8)}`, name: 'Parallel shop', address: 'Test lane',
        latitude: LAT, longitude: LNG, rateCard: {}, counterCapacity: 3,
      },
    });
    const printer = await prisma.printer.create({
      data: { shopId: shop.id, label: 'P', paperSizesLoaded: ['A4'], colorSupport: false, status: 'online' },
    });
    await prisma.agent.create({
      data: {
        shopId: shop.id, machineLabel: 'PC', tokenHash: randomUUID(), status: 'online',
        connectedPrinterIds: [printer.id], lastHeartbeatAt: new Date(),
      },
    });
    try {
      const orders = [];
      for (let i = 0; i < 6; i += 1) orders.push(await prepared(shop.id));
      probe.notes.length = 0;
      timerAdd.mockClear();

      const t0 = performance.now();
      const timed: number[] = [];
      const results = await Promise.all(
        orders.map(async (o) => {
          const r = await checkIn(o.jobId, o.token);
          timed.push(Math.round(performance.now() - t0));
          return r;
        }),
      );
      if (process.env.PRINTQ_PERF_OUT) {
        appendFileSync(process.env.PRINTQ_PERF_OUT, `6 parallel check-ins: response times ms ${timed.sort((a, b) => a - b).join(',')}\n`);
      }
      const bodies = (await Promise.all(results.map((r) => r.json()))) as {
        job: { position: number | null; band: string | null };
      }[];
      expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
      // The response itself carries the committed place (never a bare 500).
      expect(bodies.every((b) => b.job.position !== null)).toBe(true);

      await drainBackground();
      const rows = await prisma.job.findMany({ where: { shopId: shop.id }, orderBy: { queuedAt: 'asc' } });
      expect(rows.every((r) => r.status === 'queued')).toBe(true);
      const finalPositions = await Promise.all(orders.map((o) => getJobLiveMetrics(o.jobId)));
      expect(new Set(finalPositions.map((m) => m.position)).size).toBe(6);
      expect(finalPositions.map((m) => m.position).sort()).toEqual([1, 2, 3, 4, 5, 6]);
      expect(rows.filter((r) => r.revealedAt !== null)).toHaveLength(3);
      // exactly one "your turn" per revealed student, one "coming up" per arriving one, one "checked in" each
      expect(probe.notes.filter((n) => n.title === 'It’s your turn')).toHaveLength(3);
      expect(probe.notes.filter((n) => n.title === 'Your turn is coming up')).toHaveLength(3);
      expect(probe.notes.filter((n) => n.title.startsWith('Checked in'))).toHaveLength(6);
      const keys = probe.notes.map((n) => n.eventKey);
      expect(new Set(keys).size).toBe(keys.length);
      expect(timerAdd).toHaveBeenCalledTimes(3);
    } finally {
      const jobs = await prisma.job.findMany({ where: { shopId: shop.id }, select: { id: true } });
      const ids = jobs.map((j) => j.id);
      await prisma.realtimeOutbox.deleteMany({ where: { jobId: { in: ids } } });
      await prisma.jobEvent.deleteMany({ where: { jobId: { in: ids } } });
      await prisma.job.deleteMany({ where: { id: { in: ids } } });
      await prisma.agent.deleteMany({ where: { shopId: shop.id } });
      await prisma.printer.deleteMany({ where: { shopId: shop.id } });
      await prisma.uploadedFile.deleteMany({ where: { shopId: shop.id } });
      await prisma.shop.delete({ where: { id: shop.id } });
    }
  });

  it('a failing post-commit queue sync never turns a committed check-in into a 500 (D1)', async () => {
    const order = await prepared(shopId);
    // Simulate the production failure: the advisory-locked reconcile transaction
    // (the only interactive transaction of a check-in) times out.
    const original = prisma.$transaction.bind(prisma) as (...a: unknown[]) => Promise<unknown>;
    let calls = 0;
    const spy = vi.spyOn(prisma, '$transaction').mockImplementation(((...args: unknown[]) => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('Transaction API error: timeout'));
      return original(...args);
    }) as never);
    let res: Response;
    try {
      res = await checkIn(order.jobId, order.token);
    } finally {
      spy.mockRestore();
    }
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(res.status).toBe(200);
    const row = await prisma.job.findUniqueOrThrow({ where: { id: order.jobId } });
    expect(row.status).toBe('queued');
    await drainBackground();
  });

  it('concurrent repeated check-ins reveal and notify exactly once', async () => {
    const order = await prepared(shopId);
    probe.notes.length = 0;
    const results = await Promise.all([1, 2, 3].map(() => checkIn(order.jobId, order.token)));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    await drainBackground();
    expect(probe.notes.filter((n) => n.title === 'It’s your turn')).toHaveLength(1);
    expect(probe.notes.filter((n) => n.title.startsWith('Checked in'))).toHaveLength(1);
  });
});
