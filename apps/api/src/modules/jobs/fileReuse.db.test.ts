/**
 * Database-backed tests for file reuse (one upload backing several jobs) and
 * for receipts. Skipped when the migrated PostgreSQL is not reachable.
 */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const storageDeletes = vi.hoisted(() => [] as string[]);

vi.mock('../../providers/notification/index.js', () => ({ notifyStudent: vi.fn(async () => undefined) }));
vi.mock('../../realtime/events.js', () => ({ publishEvent: vi.fn(), subscribeEvents: vi.fn() }));
vi.mock('../../providers/storage/index.js', () => ({
  storage: {
    delete: vi.fn(async (key: string) => { storageDeletes.push(key); }),
    get: vi.fn(),
    put: vi.fn(),
    getSignedUrl: vi.fn(async () => null),
  },
}));

import { prisma } from '../../lib/prisma.js';
import { fileRetentionQueue, timersQueue } from '../../lib/queues.js';
import { drainBackground } from '../../lib/background.js';
import { signStudentToken } from '../../lib/tokens.js';
import { scheduleFileDeletion, scheduleVerifiedPrintFileDeletion } from '../../lib/fileRetention.js';
import { errorHandler } from '../../middleware/error.js';
import { deleteExpiredFileById } from '../../workers/conversion.js';
import { jobsRouter } from './routes.js';
import { preparePayAtShopOrder } from '../queue/engine.js';

const dbReady = await (async () => {
  try {
    await prisma.uploadedFile.findFirst({ select: { deletionScheduledAt: true } });
    await prisma.job.findFirst({ select: { printConfirmedAt: true } });
    return true;
  } catch (error) {
    console.warn('fileReuse.db.test skipped: database not ready -', String(error).slice(0, 200));
    return false;
  }
})();

vi.setConfig({ testTimeout: 60_000 });

const LAT = 28.6139;
const LNG = 77.209;
const specs = { copies: 1, paperSize: 'A4', color: false, duplex: false, binding: null, pageRange: null };

describe.runIf(dbReady)('file reuse reference counting + receipts (database)', () => {
  let shopId = '';
  let server: Server;
  let base = '';
  let studentId = '';
  let token = '';
  const spies = [
    vi.spyOn(timersQueue, 'add').mockResolvedValue(undefined as never),
    vi.spyOn(fileRetentionQueue, 'add').mockResolvedValue(undefined as never),
  ];

  const call = (path: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });

  async function newFile() {
    return prisma.uploadedFile.create({
      data: {
        studentId, shopId, originalName: 'reuse.pdf', originalKey: `orig/${randomUUID()}.pdf`,
        convertedKey: `conv/${randomUUID()}.pdf`, mimeType: 'application/pdf', sizeBytes: 10, pages: 2,
        status: 'ready', deleteAfter: new Date(Date.now() + 24 * 3_600_000),
      },
    });
  }
  const orderOn = async (fileId: string) => {
    const res = await call('/api/jobs', { method: 'POST', body: { fileId, specs, mode: 'instant' } });
    return { res, body: (await res.json()) as { job?: { id: string }; error?: string } };
  };
  /** A second job on the same file, created directly (the API refuses a duplicate active order). */
  const extraJobOn = async (fileId: string) => {
    const job = await prisma.job.create({
      data: {
        shopId, studentId, fileId, specs, pagesPerCopy: 2, priceBreakdown: {}, totalPaise: 500,
        paymentProvider: 'pay_at_shop',
      },
    });
    await preparePayAtShopOrder(job.id);
    return { res: { status: 201 }, body: { job: { id: job.id } } as { job?: { id: string }; error?: string } };
  };
  const fileRow = (id: string) => prisma.uploadedFile.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    const shop = await prisma.shop.create({
      data: {
        slug: `reuse-${randomUUID().slice(0, 8)}`, name: 'Reuse shop', address: 'Test lane',
        latitude: LAT, longitude: LNG, rateCard: { bw: 100, color: 500 },
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
    const student = await prisma.student.create({
      data: { phone: `+91${Math.floor(1_000_000_000 + Math.random() * 8_999_999_999)}`, name: 'Reuse' },
    });
    studentId = student.id;
    token = signStudentToken(studentId);
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
    await prisma.paymentEvent.deleteMany({ where: { jobId: { in: ids } } });
    await prisma.job.deleteMany({ where: { id: { in: ids } } });
    await prisma.uploadedFile.deleteMany({ where: { studentId } });
    await prisma.agent.deleteMany({ where: { shopId } });
    await prisma.printer.deleteMany({ where: { shopId } });
    await prisma.shop.delete({ where: { id: shopId } });
    await prisma.student.delete({ where: { id: studentId } });
    spies.forEach((s) => s.mockRestore());
  });

  it('cancelling one of two active jobs does not start deletion; cancelling the last does (10 min)', async () => {
    const file = await newFile();
    const a = await orderOn(file.id);
    const b = await extraJobOn(file.id);
    expect(a.res.status).toBe(201);
    expect(b.res.status).toBe(201);

    expect((await call(`/api/jobs/${a.body.job!.id}/cancel`, { method: 'POST' })).status).toBe(200);
    const afterFirst = await fileRow(file.id);
    expect(afterFirst.deletionScheduledAt).toBeNull();
    expect(afterFirst.deleteAfter!.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);

    expect((await call(`/api/jobs/${b.body.job!.id}/cancel`, { method: 'POST' })).status).toBe(200);
    const afterLast = await fileRow(file.id);
    expect(afterLast.deletionScheduledAt).not.toBeNull();
    const msLeft = afterLast.deleteAfter!.getTime() - Date.now();
    expect(msLeft).toBeLessThanOrEqual(10 * 60_000);
    expect(msLeft).toBeGreaterThan(9 * 60_000);
  });

  it('a verified print does not schedule deletion while another job on the file is active', async () => {
    const file = await newFile();
    const printed = await orderOn(file.id);
    const other = await extraJobOn(file.id);
    // simulate the physical print of job 1 (state set directly: fixture only)
    await prisma.job.update({
      where: { id: printed.body.job!.id },
      data: { printConfirmedAt: new Date(), status: 'ready_for_pickup' },
    });

    await scheduleVerifiedPrintFileDeletion(file.id, new Date());
    expect((await fileRow(file.id)).deletionScheduledAt).toBeNull();

    // ...and once the remaining job ends, the same call starts the 10-minute clock
    expect((await call(`/api/jobs/${other.body.job!.id}/cancel`, { method: 'POST' })).status).toBe(200);
    expect((await fileRow(file.id)).deletionScheduledAt).not.toBeNull();
  });

  it('D3: one file never backs two live orders (concurrent creates -> exactly one), so a printed file is gone at T+10', async () => {
    const file = await newFile();
    const results = await Promise.all([orderOn(file.id), orderOn(file.id), orderOn(file.id)]);
    expect(results.filter((r) => r.res.status === 201)).toHaveLength(1);
    expect(await prisma.job.count({ where: { fileId: file.id } })).toBe(1);
    const winner = results.find((r) => r.res.status === 201)!;
    // print it: nothing else references the file, so the 10-minute clock starts immediately
    await prisma.job.update({ where: { id: winner.body.job!.id }, data: { printConfirmedAt: new Date(), status: 'ready_for_pickup' } });
    await scheduleVerifiedPrintFileDeletion(file.id, new Date());
    const msLeft = (await fileRow(file.id)).deleteAfter!.getTime() - Date.now();
    expect(msLeft).toBeLessThanOrEqual(10 * 60_000);
  });

  it('D3: a legacy requeued/no_show order still counts as a live order on the file', async () => {
    const file = await newFile();
    const first = await orderOn(file.id);
    await prisma.job.update({ where: { id: first.body.job!.id }, data: { status: 'requeued' } });
    const again = await orderOn(file.id);
    expect(again.res.status).toBe(409);
    await scheduleFileDeletion(file.id, new Date());
    expect((await fileRow(file.id)).deletionScheduledAt).toBeNull();
  });

  it('D7: quote flags options the shop cannot print and order creation is refused with the same message', async () => {
    const file = await newFile();
    const colourSpecs = { ...specs, color: true };
    const quote = await call('/api/jobs/quote', { method: 'POST', body: { fileId: file.id, specs: colourSpecs } });
    expect(quote.status).toBe(200);
    const body = (await quote.json()) as { unsupported?: { code: string; message: string }[] };
    expect(body.unsupported?.map((u) => u.code)).toEqual(['color']);
    expect(body.unsupported![0]!.message).toMatch(/colour/i);

    const order = await call('/api/jobs', { method: 'POST', body: { fileId: file.id, specs: colourSpecs, mode: 'instant' } });
    expect(order.status).toBe(409);
    expect(((await order.json()) as { error: string }).error).toBe(body.unsupported![0]!.message);
    expect(await prisma.job.count({ where: { fileId: file.id } })).toBe(0);

    const bwQuote = await call('/api/jobs/quote', { method: 'POST', body: { fileId: file.id, specs } });
    expect(((await bwQuote.json()) as { unsupported?: unknown }).unsupported).toBeUndefined();
    const oddPaper = await call('/api/jobs/quote', { method: 'POST', body: { fileId: file.id, specs: { ...specs, paperSize: 'A3' } } });
    expect(((await oddPaper.json()) as { unsupported: { code: string }[] }).unsupported[0]!.code).toBe('paper_size');
  });

  it('D5: concurrent ratings are once-only (one 200, the rest 409)', async () => {
    const file = await newFile();
    const order = await orderOn(file.id);
    const id = order.body.job!.id;
    await prisma.job.update({ where: { id }, data: { status: 'completed', paymentStatus: 'paid' } });
    const results = await Promise.all(
      [5, 4, 3, 2].map((rating) => call(`/api/jobs/${id}/rating`, { method: 'POST', body: { rating } })),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409, 409, 409]);
    const stored = await prisma.job.findUniqueOrThrow({ where: { id } });
    expect([2, 3, 4, 5]).toContain(stored.rating);
  });

  it('refuses a new job on a file that already printed, with a clear message', async () => {
    const file = await newFile();
    const first = await orderOn(file.id);
    await prisma.job.update({
      where: { id: first.body.job!.id },
      data: { printConfirmedAt: new Date(), status: 'completed' },
    });
    const again = await orderOn(file.id);
    expect(again.res.status).toBe(409);
    expect(again.body.error).toMatch(/already been printed.*upload it again/i);
  });

  it('refuses a new job on a file whose deletion clock already started', async () => {
    const file = await newFile();
    const only = await orderOn(file.id);
    await call(`/api/jobs/${only.body.job!.id}/cancel`, { method: 'POST' });
    const again = await orderOn(file.id);
    expect(again.res.status).toBe(409);
    expect(again.body.error).toMatch(/about to be deleted/i);
  });

  it('the hard-deadline sweep considers ALL jobs: defers while one is active, deletes once none is', async () => {
    const file = await newFile();
    const a = await orderOn(file.id);
    const b = await extraJobOn(file.id);
    await call(`/api/jobs/${a.body.job!.id}/cancel`, { method: 'POST' });
    await prisma.uploadedFile.update({ where: { id: file.id }, data: { deleteAfter: new Date(Date.now() - 1_000) } });

    storageDeletes.length = 0;
    expect(await deleteExpiredFileById(file.id)).toBe('deferred');
    expect(storageDeletes).toEqual([]);
    expect((await fileRow(file.id)).status).toBe('ready');

    await call(`/api/jobs/${b.body.job!.id}/cancel`, { method: 'POST' });
    await prisma.uploadedFile.update({ where: { id: file.id }, data: { deleteAfter: new Date(Date.now() - 1_000) } });
    expect(await deleteExpiredFileById(file.id)).toBe('deleted');
    expect(storageDeletes).toContain(file.convertedKey);
    expect((await fileRow(file.id)).status).toBe('deleted');
  });

  it('scheduleFileDeletion is a no-op while any job is active', async () => {
    const file = await newFile();
    await orderOn(file.id);
    await scheduleFileDeletion(file.id);
    expect((await fileRow(file.id)).deletionScheduledAt).toBeNull();
  });

  describe('double submit (D4)', () => {
    it('a second active order for the same student+file+shop is refused with a friendly 409', async () => {
      const file = await newFile();
      const first = await orderOn(file.id);
      expect(first.res.status).toBe(201);
      const second = await orderOn(file.id);
      expect(second.res.status).toBe(409);
      expect(second.body.error).toMatch(/already have an active order/i);
      expect(await prisma.job.count({ where: { fileId: file.id } })).toBe(1);
    });

    it('parallel double submit creates exactly one job', async () => {
      const file = await newFile();
      const results = await Promise.all([orderOn(file.id), orderOn(file.id), orderOn(file.id)]);
      expect(results.filter((r) => r.res.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.res.status === 409)).toHaveLength(2);
      expect(await prisma.job.count({ where: { fileId: file.id } })).toBe(1);
    });

    it('an Idempotency-Key replays the first result instead of creating another job', async () => {
      const file = await newFile();
      const key = randomUUID();
      const post = () =>
        fetch(`${base}/api/jobs`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'idempotency-key': key },
          body: JSON.stringify({ fileId: file.id, specs, mode: 'instant' }),
        });
      const a = await post();
      const b = await post();
      expect(a.status).toBe(201);
      expect(b.status).toBe(200);
      expect(((await b.json()) as { job: { id: string } }).job.id).toBe(((await a.json()) as { job: { id: string } }).job.id);
      expect(await prisma.job.count({ where: { fileId: file.id } })).toBe(1);
    });
  });

  describe('receipts', () => {
    it('are refused (409) until the shop confirms payment, then served as a PDF', async () => {
      const file = await newFile();
      const order = await orderOn(file.id);
      const id = order.body.job!.id;

      const unpaid = await call(`/api/jobs/${id}/receipt`);
      expect(unpaid.status).toBe(409);
      expect(unpaid.headers.get('content-type')).not.toMatch(/pdf/);

      await prisma.job.update({ where: { id }, data: { paymentStatus: 'paid' } });
      const paid = await call(`/api/jobs/${id}/receipt`);
      expect(paid.status).toBe(200);
      expect(paid.headers.get('content-type')).toMatch(/application\/pdf/);
      expect(Buffer.from(await paid.arrayBuffer()).subarray(0, 4).toString()).toBe('%PDF');
    });

    it('stay 404 for someone else\'s job', async () => {
      const file = await newFile();
      const order = await orderOn(file.id);
      const other = await fetch(`${base}/api/jobs/${order.body.job!.id}/receipt`, {
        headers: { authorization: `Bearer ${signStudentToken(randomUUID())}` },
      });
      expect(other.status).toBe(404);
    });
  });
});
