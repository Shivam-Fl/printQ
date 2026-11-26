/**
 * Database-backed tests for different settings per file: pricing and storing
 * the per-part plan, offering it only when every online shop PC can print it,
 * keeping such an order away from an older shop app, and serving each part.
 * Skipped when the migrated PostgreSQL is not reachable.
 */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const blobs = vi.hoisted(() => new Map<string, Buffer>());

vi.mock('../../providers/notification/index.js', () => ({ notifyStudent: vi.fn(async () => undefined) }));
vi.mock('../../realtime/events.js', () => ({ publishEvent: vi.fn(), subscribeEvents: vi.fn() }));
vi.mock('../../providers/storage/index.js', () => ({
  storage: {
    put: vi.fn(async (key: string, bytes: Buffer) => { blobs.set(key, Buffer.from(bytes)); }),
    get: vi.fn(async (key: string) => blobs.get(key)!),
    delete: vi.fn(async () => undefined),
    getSignedUrl: vi.fn(async () => null),
  },
}));

import { prisma } from '../../lib/prisma.js';
import { fileRetentionQueue, timersQueue } from '../../lib/queues.js';
import { drainBackground } from '../../lib/background.js';
import { generateAgentToken } from '../../lib/otp.js';
import { signStudentToken } from '../../lib/tokens.js';
import { errorHandler } from '../../middleware/error.js';
import { agentRouter } from '../agents/routes.js';
import { jobsRouter } from './routes.js';

const dbReady = await (async () => {
  try {
    await prisma.agent.findFirst({ select: { features: true } });
    return true;
  } catch (error) {
    console.warn('printParts.db.test skipped: database not ready -', String(error).slice(0, 200));
    return false;
  }
})();

vi.setConfig({ testTimeout: 60_000 });

/** notes.pdf (pages 1-4, B/W x2, both sides) + cover (page 5, colour x1). */
const perFile = {
  copies: 1, paperSize: 'A4', color: false, duplex: false, binding: null, pageRange: null,
  parts: [
    { pages: '1-4', copies: 2, color: false, duplex: true },
    { pages: '5', copies: 1, color: true, duplex: false },
  ],
};

describe.runIf(dbReady)('different settings per file (database)', () => {
  let shopId = '';
  let studentId = '';
  let printerId = '';
  let agentId = '';
  let agentToken = '';
  let studentToken = '';
  let server: Server;
  let base = '';
  const spies = [
    vi.spyOn(timersQueue, 'add').mockResolvedValue(undefined as never),
    vi.spyOn(fileRetentionQueue, 'add').mockResolvedValue(undefined as never),
  ];

  const student = (path: string, body: unknown) =>
    fetch(`${base}/api/jobs${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${studentToken}` },
      body: JSON.stringify(body),
    });
  const agent = (path: string, features: string | null, method = 'POST') =>
    fetch(`${base}/api/agent${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-agent-token': agentToken,
        ...(features ? { 'x-agent-features': features } : {}),
      },
      body: method === 'GET' ? undefined : '{}',
    });
  const setFeatures = (features: string[]) => prisma.agent.update({ where: { id: agentId }, data: { features } });

  async function readyFile() {
    const doc = await PDFDocument.create();
    for (let i = 1; i <= 5; i++) doc.addPage([100 * i, 400]); // page widths identify pages
    const key = `conv/${randomUUID()}.pdf`;
    blobs.set(key, Buffer.from(await doc.save()));
    return prisma.uploadedFile.create({
      data: {
        studentId, shopId, originalName: 'notes.pdf +1 more', originalKey: `composed/${randomUUID()}`,
        convertedKey: key, mimeType: 'application/pdf', sizeBytes: 10, pages: 5, status: 'ready',
        deleteAfter: new Date(Date.now() + 24 * 3_600_000),
      },
    });
  }

  beforeAll(async () => {
    const shop = await prisma.shop.create({
      data: {
        slug: `parts-${randomUUID().slice(0, 8)}`, name: 'Parts shop', address: 'Test lane',
        latitude: 28.6, longitude: 77.2, rateCard: { bw: 100, color: 500 },
      },
    });
    shopId = shop.id;
    printerId = (await prisma.printer.create({
      data: { shopId, label: 'P1', paperSizesLoaded: ['A4'], colorSupport: true, status: 'online', osPrinterName: 'Front desk' },
    })).id;
    const { token, tokenHash } = generateAgentToken();
    agentToken = token;
    agentId = (await prisma.agent.create({
      data: { shopId, machineLabel: 'PC', tokenHash, status: 'online', connectedPrinterIds: [printerId], lastHeartbeatAt: new Date() },
    })).id;
    studentId = (await prisma.student.create({
      data: { phone: `+91${Math.floor(1_000_000_000 + Math.random() * 8_999_999_999)}`, name: 'Parts' },
    })).id;
    studentToken = signStudentToken(studentId);
    const app = express();
    app.use(express.json());
    app.use('/api/jobs', jobsRouter);
    app.use('/api/agent', agentRouter);
    app.use(errorHandler);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await drainBackground();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const ids = (await prisma.job.findMany({ where: { shopId }, select: { id: true } })).map((j) => j.id);
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

  it('records what each shop PC app can do from its heartbeat', async () => {
    expect((await agent('/heartbeat', 'print-parts, junk feature!, PRINT-PARTS')).status).toBe(200);
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).features).toEqual(['print-parts']);
    expect((await agent('/heartbeat', null)).status).toBe(200); // an older app says nothing
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).features).toEqual([]);
  });

  it('tells the student before ordering when the shop PC app cannot print per-file settings', async () => {
    await setFeatures([]);
    const file = await readyFile();
    const quote = await student('/quote', { fileId: file.id, specs: perFile });
    expect(quote.status).toBe(200);
    expect(((await quote.json()) as { unsupported?: { code: string }[] }).unsupported?.map((u) => u.code)).toEqual(['per_file']);
    const order = await student('', { fileId: file.id, specs: perFile, mode: 'instant' });
    expect(order.status).toBe(409);
  });

  it('prices each file with its own settings and stores the normalized plan', async () => {
    await setFeatures(['print-parts']);
    const file = await readyFile();
    const quote = await student('/quote', { fileId: file.id, specs: perFile });
    const body = (await quote.json()) as { quote: { pagesPerCopy: number; totalPaise: number }; unsupported?: unknown };
    expect(body.unsupported).toBeUndefined();
    // default rates A4 ₹2 B/W, ₹10 colour, +25% markup: 4 x 2 x ₹2.50 + 1 x ₹12.50
    expect(body.quote).toEqual({ pagesPerCopy: 9, totalPaise: 3250 });

    const order = await student('', { fileId: file.id, specs: perFile, mode: 'instant' });
    expect(order.status).toBe(201);
    const { job } = (await order.json()) as { job: { id: string } };
    const row = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.specs).toMatchObject({ copies: 1, color: true, duplex: true, pageRange: null, parts: perFile.parts });
    expect(row.pagesPerCopy).toBe(9);
    expect(row.totalPaise).toBe(3250);
    expect(row.shopBasePaise).toBe(2600);
  });

  it('keeps a per-file order away from an older app and serves each part to a new one', async () => {
    const file = await readyFile();
    const job = await prisma.job.create({
      data: {
        shopId, studentId, fileId: file.id, specs: { ...perFile, copies: 1, color: true, duplex: true }, pagesPerCopy: 9,
        priceBreakdown: {}, totalPaise: 3250, paymentProvider: 'pay_at_shop', status: 'otp_verified', assignedPrinterId: printerId,
      },
    });
    const old = await agent(`/jobs/${job.id}/claim`, null);
    expect(old.status).toBe(409);
    expect(((await old.json()) as { error: string }).error).toMatch(/Update PrintQs Shop/);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).claimedByAgentId).toBeNull();

    const claim = await agent(`/jobs/${job.id}/claim`, 'print-parts');
    expect(claim.status).toBe(200);
    const claimed = (await claim.json()) as { job: { specs: typeof perFile } };
    expect(claimed.job.specs.parts).toEqual(perFile.parts);

    const widths = async (query: string) => {
      const res = await agent(`/jobs/${job.id}/file${query}`, 'print-parts', 'GET');
      if (res.status !== 200) return res.status;
      const pdf = await PDFDocument.load(Buffer.from(await res.arrayBuffer()));
      return pdf.getPages().map((p) => p.getWidth());
    };
    expect(await widths('?part=0')).toEqual([100, 200, 300, 400]);
    expect(await widths('?part=1')).toEqual([500]);
    expect(await widths('?part=2')).toBe(404);
  });
});
