/**
 * Database-backed tests for multi-file orders: separate part uploads, joining
 * them into one order document, and retention passing from the order document
 * to its parts. Skipped when the migrated PostgreSQL is not reachable.
 */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const blobs = vi.hoisted(() => new Map<string, Buffer>());

vi.mock('../../realtime/events.js', () => ({ publishEvent: vi.fn(), subscribeEvents: vi.fn() }));
vi.mock('../../providers/storage/index.js', () => ({
  storage: {
    put: vi.fn(async (key: string, bytes: Buffer) => { blobs.set(key, Buffer.from(bytes)); }),
    get: vi.fn(async (key: string) => {
      const bytes = blobs.get(key);
      if (!bytes) throw new Error(`missing ${key}`);
      return bytes;
    }),
    delete: vi.fn(async (key: string) => { blobs.delete(key); }),
    getSignedUrl: vi.fn(async () => null),
  },
}));

import { prisma } from '../../lib/prisma.js';
import { convertQueue, fileRetentionQueue } from '../../lib/queues.js';
import { signStudentToken } from '../../lib/tokens.js';
import { scheduleFileDeletion } from '../../lib/fileRetention.js';
import { errorHandler } from '../../middleware/error.js';
import { convertFile } from '../../workers/conversion.js';
import { filesRouter } from './routes.js';

const dbReady = await (async () => {
  try {
    await prisma.uploadedFile.findFirst({ select: { parts: true } });
    return true;
  } catch (error) {
    console.warn('compose.db.test skipped: database not ready -', String(error).slice(0, 200));
    return false;
  }
})();

vi.setConfig({ testTimeout: 60_000 });

/** A PDF whose pages are `width` points wide, so the merged order is checkable. */
async function pdf(pages: number, width: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([width, 400]);
  return Buffer.from(await doc.save());
}

describe.runIf(dbReady)('multi-file orders (database)', () => {
  let shopId = '';
  let slug = '';
  let studentId = '';
  let otherStudentId = '';
  let token = '';
  let server: Server;
  let base = '';
  const queued: string[] = [];
  const spies = [
    vi.spyOn(convertQueue, 'add').mockImplementation((async (_name: string, data: { fileId: string }) => {
      queued.push(data.fileId);
      return undefined;
    }) as never),
    vi.spyOn(fileRetentionQueue, 'add').mockResolvedValue(undefined as never),
  ];

  const json = (path: string, body: unknown, auth = token) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${auth}` },
      body: JSON.stringify(body),
    });

  async function uploadParts(files: { name: string; bytes: Buffer; type?: string }[]) {
    const form = new FormData();
    form.append('shopSlug', slug);
    for (const f of files) form.append('files', new Blob([new Uint8Array(f.bytes)], { type: f.type ?? 'application/pdf' }), f.name);
    const res = await fetch(`${base}/api/files/parts`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
    return { res, body: (await res.json()) as { files: { id: string; name: string }[]; rejected: { name: string }[]; error?: string } };
  }

  /** Upload and convert; returns the ready part ids in order. */
  async function readyParts(specs: { name: string; pages: number; width: number }[]) {
    const { body } = await uploadParts(await Promise.all(specs.map(async (s) => ({ name: s.name, bytes: await pdf(s.pages, s.width) }))));
    for (const f of body.files) await convertFile(f.id);
    return body.files.map((f) => f.id);
  }

  beforeAll(async () => {
    slug = `compose-${randomUUID().slice(0, 8)}`;
    const shop = await prisma.shop.create({
      data: { slug, name: 'Compose shop', address: 'Test lane', latitude: 28.6, longitude: 77.2, rateCard: { bw: 100, color: 500 } },
    });
    shopId = shop.id;
    const phone = () => `+91${Math.floor(1_000_000_000 + Math.random() * 8_999_999_999)}`;
    studentId = (await prisma.student.create({ data: { phone: phone(), name: 'Composer' } })).id;
    otherStudentId = (await prisma.student.create({ data: { phone: phone(), name: 'Other' } })).id;
    token = signStudentToken(studentId);
    const app = express();
    app.use(express.json());
    app.use('/api/files', filesRouter);
    app.use(errorHandler);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.job.deleteMany({ where: { shopId } });
    await prisma.uploadedFile.deleteMany({ where: { shopId } });
    await prisma.shop.delete({ where: { id: shopId } });
    await prisma.student.deleteMany({ where: { id: { in: [studentId, otherStudentId] } } });
    spies.forEach((s) => s.mockRestore());
  });

  it('uploads each file as its own record and conversion, and reports a mismatched file without failing the batch', async () => {
    const { res, body } = await uploadParts([
      { name: 'notes.pdf', bytes: await pdf(2, 100) },
      { name: 'fake.pdf', bytes: Buffer.from('not a pdf at all') },
      { name: 'cover.pdf', bytes: await pdf(1, 200) },
    ]);
    expect(res.status).toBe(201);
    expect(body.files.map((f) => f.name)).toEqual(['notes.pdf', 'cover.pdf']);
    expect(body.rejected.map((f) => f.name)).toEqual(['fake.pdf']);
    expect(queued).toEqual(expect.arrayContaining(body.files.map((f) => f.id)));
    const rows = await prisma.uploadedFile.findMany({ where: { id: { in: body.files.map((f) => f.id) } } });
    expect(rows.every((r) => r.studentId === studentId && r.parts === null && r.deleteAfter !== null)).toBe(true);
  });

  it('joins ready files in the order given into one order document', async () => {
    const [a, b, c] = await readyParts([
      { name: 'a.pdf', pages: 2, width: 100 },
      { name: 'b.pdf', pages: 3, width: 200 },
      { name: 'c.pdf', pages: 1, width: 300 },
    ]);
    const res = await json('/api/files/compose', { fileIds: [c, a, b] });
    expect(res.status).toBe(201);
    const { file } = (await res.json()) as { file: { id: string; name: string } };
    expect(file.name).toBe('c.pdf +2 more');

    await convertFile(file.id);
    const row = await prisma.uploadedFile.findUniqueOrThrow({ where: { id: file.id } });
    expect(row.status).toBe('ready');
    expect(row.pages).toBe(6);
    const merged = await PDFDocument.load(blobs.get(row.convertedKey!)!);
    expect(merged.getPages().map((p) => p.getWidth())).toEqual([300, 100, 100, 200, 200, 200]);

    const got = await fetch(`${base}/api/files/${file.id}`, { headers: { authorization: `Bearer ${token}` } });
    const body = (await got.json()) as { file: { parts: { fileId: string; name: string; pages: number }[] } };
    expect(body.file.parts).toEqual([
      { fileId: c, name: 'c.pdf', pages: 1 },
      { fileId: a, name: 'a.pdf', pages: 2 },
      { fileId: b, name: 'b.pdf', pages: 3 },
    ]);
  });

  it('refuses another student’s file as 404 and a file still converting as 409', async () => {
    const [mine] = await readyParts([{ name: 'mine.pdf', pages: 1, width: 100 }]);
    const foreign = await prisma.uploadedFile.create({
      data: {
        studentId: otherStudentId, shopId, originalName: 'theirs.pdf', originalKey: `orig/${randomUUID()}.pdf`,
        convertedKey: `conv/${randomUUID()}.pdf`, mimeType: 'application/pdf', sizeBytes: 1, pages: 1, status: 'ready',
      },
    });
    expect((await json('/api/files/compose', { fileIds: [mine, foreign.id] })).status).toBe(404);

    const { body } = await uploadParts([{ name: 'slow.pdf', bytes: await pdf(1, 100) }]);
    expect((await json('/api/files/compose', { fileIds: [mine, body.files[0]!.id] })).status).toBe(409);
    expect((await json('/api/files/compose', { fileIds: [mine, mine] })).status).toBe(400);
    expect((await json('/api/files/compose', { fileIds: [mine] })).status).toBe(400);
  });

  it('fails clearly when a part disappeared before the merge', async () => {
    const [a, b] = await readyParts([
      { name: 'a.pdf', pages: 1, width: 100 },
      { name: 'b.pdf', pages: 1, width: 100 },
    ]);
    const res = await json('/api/files/compose', { fileIds: [a, b] });
    const { file } = (await res.json()) as { file: { id: string } };
    await prisma.uploadedFile.update({ where: { id: b }, data: { status: 'deleted', contentDeletedAt: new Date() } });
    await convertFile(file.id);
    expect(await prisma.uploadedFile.findUniqueOrThrow({ where: { id: file.id } })).toMatchObject({ status: 'failed', error: 'PARTS_UNAVAILABLE' });
  });

  it('passes the order document’s deletion deadline to its parts, except a part another job still needs', async () => {
    const [a, b] = await readyParts([
      { name: 'a.pdf', pages: 1, width: 100 },
      { name: 'b.pdf', pages: 1, width: 100 },
    ]);
    const res = await json('/api/files/compose', { fileIds: [a, b] });
    const { file } = (await res.json()) as { file: { id: string } };
    await convertFile(file.id);
    // b also backs an order of its own that is still waiting
    await prisma.job.create({
      data: { shopId, studentId, fileId: b!, specs: {}, pagesPerCopy: 1, priceBreakdown: {}, totalPaise: 100, status: 'awaiting_arrival' },
    });

    const now = new Date();
    await scheduleFileDeletion(file.id, now);
    const [composed, partA, partB] = await Promise.all([file.id, a!, b!].map((id) => prisma.uploadedFile.findUniqueOrThrow({ where: { id } })));
    expect(composed.deletionScheduledAt).not.toBeNull();
    expect(partA.deleteAfter!.getTime()).toBe(composed.deleteAfter!.getTime());
    expect(partA.deletionScheduledAt).not.toBeNull();
    expect(partB.deletionScheduledAt).toBeNull();
  });
});
