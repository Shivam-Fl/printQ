/**
 * Round-trip budget for the hot queue mutations (production QA: 3-8 s).
 * Production API (Oregon) -> DB (Mumbai) is ~230 ms RTT per statement, so the
 * number of SQL statements issued BEFORE the response is the latency. Pins:
 *  - check-in, staff mark-absent, counter release and student cancel,
 *  - that slow notification delivery is never awaited by the request,
 *  - that every follow-up (notifications, timers, projections) still happens once.
 *
 * Needs the migrated PostgreSQL CI provides; skipped without it. Point
 * DATABASE_URL at a latency-injecting TCP proxy and set PRINTQ_PERF_OUT to log
 * statements + wall-clock per endpoint (PRINTQ_PERF_VERBOSE=1 also prints SQL).
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
}));

vi.mock('../../lib/prisma.js', async () => {
  const { PrismaClient } = await import('@prisma/client');
  const client = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
  client.$on('query', (e) => { probe.sql.push(e.query); });
  return { prisma: client };
});
vi.mock('../../providers/notification/index.js', () => ({
  notifyStudent: vi.fn(async (studentId: string, message: { title: string; eventKey?: string }) => {
    await new Promise((r) => setTimeout(r, 4000));
    probe.notes.push({ studentId, title: message.title, eventKey: message.eventKey });
  }),
}));
vi.mock('../../realtime/events.js', () => ({ publishEvent: vi.fn(), subscribeEvents: vi.fn() }));

import { prisma } from '../../lib/prisma.js';
import { timersQueue } from '../../lib/queues.js';
import { drainBackground } from '../../lib/background.js';
import { decryptReleaseCode } from '../../lib/otp.js';
import { signShopToken, signStudentToken } from '../../lib/tokens.js';
import { errorHandler } from '../../middleware/error.js';
import { jobsRouter } from '../jobs/routes.js';
import { shopRouter } from '../shops/routes.js';
import { preparePayAtShopOrder } from './engine.js';

const LAT = 28.6139;
const LNG = 77.209;

const dbReady = await (async () => {
  try {
    await prisma.shop.findFirst({ select: { counterCapacity: true } });
    await prisma.job.findFirst({ select: { revealedAt: true } });
    return true;
  } catch (error) {
    console.warn('mutations.perf.db.test skipped: database not ready -', String(error).slice(0, 200));
    return false;
  }
})();

vi.setConfig({ testTimeout: 90_000 });

/** Statements each mutation may issue before it answers (incl. auth lookup). */
const BUDGET = { checkIn: 6, noShow: 6, release: 6, cancel: 6 } as const;

describe.runIf(dbReady)('hot queue mutations: round-trip budget (database)', () => {
  let shopId = '';
  let staffToken = '';
  let server: Server;
  let base = '';
  const studentIds: string[] = [];
  const timerAdd = vi.spyOn(timersQueue, 'add').mockResolvedValue(undefined as never);

  async function prepared() {
    const student = await prisma.student.create({
      data: { phone: `+91${Math.floor(1_000_000_000 + Math.random() * 8_999_999_999)}`, name: 'Perf' },
    });
    studentIds.push(student.id);
    const file = await prisma.uploadedFile.create({
      data: {
        studentId: student.id, shopId, originalName: 'a.pdf', originalKey: `k-${randomUUID()}`,
        mimeType: 'application/pdf', sizeBytes: 1, pages: 1, status: 'ready',
      },
    });
    const job = await prisma.job.create({
      data: {
        shopId, studentId: student.id, fileId: file.id,
        specs: { copies: 1, paperSize: 'A4', color: false, duplex: false, binding: null, pageRange: null },
        pagesPerCopy: 1, priceBreakdown: {}, totalPaise: 500, paymentProvider: 'pay_at_shop',
      },
    });
    await preparePayAtShopOrder(job.id);
    await drainBackground();
    const row = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    return { jobId: job.id, token: signStudentToken(student.id), code: decryptReleaseCode(shopId, row.releaseCodeEncrypted)! };
  }

  const send = (path: string, token: string, body: unknown = {}) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  const checkInBody = () => ({ latitude: LAT, longitude: LNG, accuracyM: 10, measuredAt: new Date().toISOString() });
  const checkIn = (o: { jobId: string; token: string }) => send(`/api/jobs/${o.jobId}/check-in`, o.token, checkInBody());

  async function checkedIn() {
    const o = await prepared();
    expect((await checkIn(o)).status).toBe(200);
    await drainBackground();
    return o;
  }

  /** Runs `act`, returns statements + ms until the response, and statements after background work settles. */
  async function measure(name: string, act: () => Promise<Response>) {
    probe.sql.length = 0;
    probe.notes.length = 0;
    timerAdd.mockClear();
    const started = performance.now();
    const res = await act();
    const ms = Math.round(performance.now() - started);
    const onPath = probe.sql.length;
    const notesAtResponse = probe.notes.length;
    const pathSql = [...probe.sql];
    await drainBackground();
    const total = probe.sql.length;
    if (process.env.PRINTQ_PERF_OUT) {
      appendFileSync(process.env.PRINTQ_PERF_OUT, `${name}: ${onPath} statements before response (${total} incl. background), ${ms} ms\n`);
      if (process.env.PRINTQ_PERF_VERBOSE) {
        appendFileSync(process.env.PRINTQ_PERF_OUT, `${pathSql.map((s, i) => `  ${i + 1}. ${s.replace(/\s+/g, ' ').slice(0, 130)}`).join('\n')}\n`);
      }
    }
    return { res, onPath, notesAtResponse };
  }

  beforeAll(async () => {
    const shop = await prisma.shop.create({
      data: {
        slug: `mut-${randomUUID().slice(0, 8)}`, name: 'Mutation perf shop', address: 'Test lane',
        latitude: LAT, longitude: LNG, rateCard: {}, counterCapacity: 5,
      },
    });
    shopId = shop.id;
    const owner = await prisma.shopUser.create({
      data: { shopId, email: `mut-${randomUUID()}@example.test`, name: 'Owner', role: 'owner', passwordHash: 'x' },
    });
    staffToken = signShopToken(owner.id, shopId, 'owner');
    const printer = await prisma.printer.create({
      data: { shopId, label: 'P1', paperSizesLoaded: ['A4'], colorSupport: false, status: 'online' },
    });
    await prisma.agent.create({
      data: {
        shopId, machineLabel: 'PC', tokenHash: randomUUID(), status: 'online',
        connectedPrinterIds: [printer.id], lastHeartbeatAt: new Date(),
      },
    });
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
    await prisma.realtimeOutbox.deleteMany({ where: { jobId: { in: ids } } });
    await prisma.jobEvent.deleteMany({ where: { jobId: { in: ids } } });
    await prisma.job.deleteMany({ where: { id: { in: ids } } });
    await prisma.paymentEvent.deleteMany({ where: { jobId: { in: ids } } });
    await prisma.uploadedFile.deleteMany({ where: { studentId: { in: studentIds } } });
    await prisma.agent.deleteMany({ where: { shopId } });
    await prisma.printer.deleteMany({ where: { shopId } });
    await prisma.shopUser.deleteMany({ where: { shopId } });
    await prisma.shop.delete({ where: { id: shopId } });
    await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
  });

  it('check-in', async () => {
    await checkedIn(); // warm pooled connections / prepared statements
    const o = await prepared();
    const { res, onPath, notesAtResponse } = await measure('check-in', () => checkIn(o));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ job: { status: 'queued', band: 'revealed' } });
    expect(onPath).toBeLessThanOrEqual(BUDGET.checkIn);
    expect(notesAtResponse).toBe(0);
    const titles = probe.notes.map((n) => n.title).sort();
    expect(titles).toEqual(['Checked in at the shop ✓', 'It’s your turn']);
    expect(timerAdd).toHaveBeenCalledTimes(1);
    expect(await prisma.realtimeOutbox.count({ where: { jobId: o.jobId } })).toBeGreaterThanOrEqual(2);
  });

  it('staff mark-absent', async () => {
    const warm = await checkedIn();
    await send(`/api/shop/jobs/${warm.jobId}/no-show`, staffToken);
    await drainBackground();
    const o = await checkedIn();
    const { res, onPath, notesAtResponse } = await measure('mark-absent', () => send(`/api/shop/jobs/${o.jobId}/no-show`, staffToken));
    expect(res.status).toBe(200);
    expect(onPath).toBeLessThanOrEqual(BUDGET.noShow);
    expect(notesAtResponse).toBe(0);
    expect(probe.notes.map((n) => n.title)).toContain('You missed your turn');
    const row = await prisma.job.findUniqueOrThrow({ where: { id: o.jobId } });
    expect(row).toMatchObject({ status: 'awaiting_arrival', absentReason: 'staff', revealedAt: null, queuedAt: null });
    const events = await prisma.jobEvent.findMany({ where: { jobId: o.jobId, event: 'ABSENT_STAFF' } });
    expect(events).toHaveLength(1);
    expect(await prisma.realtimeOutbox.count({ where: { jobEventId: events[0]!.id } })).toBe(1);
  });

  it('counter release (counter code + cash confirmation)', async () => {
    const warm = await checkedIn();
    await send('/api/shop/release', staffToken, { otp: warm.code, overrideQueue: false, paymentConfirmation: { method: 'cash' } });
    await drainBackground();
    const o = await checkedIn();
    const { res, onPath, notesAtResponse } = await measure('release', () =>
      send('/api/shop/release', staffToken, { otp: o.code, overrideQueue: false, paymentConfirmation: { method: 'cash' } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, job: { id: o.jobId, status: 'otp_verified' } });
    expect(onPath).toBeLessThanOrEqual(BUDGET.release);
    expect(notesAtResponse).toBe(0);
    const row = await prisma.job.findUniqueOrThrow({ where: { id: o.jobId } });
    expect(row).toMatchObject({ status: 'otp_verified', paymentStatus: 'paid', counterPaymentMethod: 'cash' });
    expect(await prisma.paymentEvent.count({ where: { providerEventId: `counter_payment_${o.jobId}` } })).toBe(1);
  });

  it('student cancel', async () => {
    const warm = await checkedIn();
    await send(`/api/jobs/${warm.jobId}/cancel`, warm.token);
    await drainBackground();
    const o = await checkedIn();
    const { res, onPath } = await measure('cancel', () => send(`/api/jobs/${o.jobId}/cancel`, o.token));
    expect(res.status).toBe(200);
    expect(onPath).toBeLessThanOrEqual(BUDGET.cancel);
    const row = await prisma.job.findUniqueOrThrow({ where: { id: o.jobId } });
    expect(row.status).toBe('cancelled');
    expect(await prisma.jobEvent.count({ where: { jobId: o.jobId, event: 'CANCEL' } })).toBe(1);
  });
});
