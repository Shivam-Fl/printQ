import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { env } from '../config/env.js';
import { storage } from '../providers/storage/index.js';
import { publishEvent } from '../realtime/events.js';

const execFileAsync = promisify(execFile);

/** A4 in PDF points (72 dpi): 210mm × 297mm. */
const A4 = { width: 595.28, height: 841.89 } as const;

async function pdfToNormalized(buffer: Buffer): Promise<{ pdf: Buffer; pages: number }> {
  // load + re-save normalizes structure and rejects corrupt/encrypted files early
  const doc = await PDFDocument.load(buffer, { ignoreEncryption: false });
  const bytes = await doc.save();
  return { pdf: Buffer.from(bytes), pages: doc.getPageCount() };
}

async function imageToPdf(buffer: Buffer): Promise<{ pdf: Buffer; pages: number }> {
  // respect EXIF orientation, flatten to JPEG for predictable embedding
  const jpeg = await sharp(buffer).rotate().jpeg({ quality: 90 }).toBuffer();
  const doc = await PDFDocument.create();
  const image = await doc.embedJpg(jpeg);

  const page = doc.addPage([A4.width, A4.height]);
  const margin = 24;
  const maxW = A4.width - margin * 2;
  const maxH = A4.height - margin * 2;
  const scale = Math.min(maxW / image.width, maxH / image.height, 1);
  const w = image.width * scale;
  const h = image.height * scale;
  page.drawImage(image, {
    x: (A4.width - w) / 2,
    y: (A4.height - h) / 2,
    width: w,
    height: h,
  });
  const bytes = await doc.save();
  return { pdf: Buffer.from(bytes), pages: 1 };
}

async function docxToPdf(buffer: Buffer): Promise<{ pdf: Buffer; pages: number }> {
  if (!env.SOFFICE_PATH) {
    throw new Error(
      'DOCX conversion is not available on this server (SOFFICE_PATH not configured)',
    );
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'printq-conv-'));
  try {
    const inputPath = path.join(dir, `${randomUUID()}.docx`);
    await writeFile(inputPath, buffer);
    // Concurrent conversions (BullMQ worker concurrency > 1) must not share a
    // LibreOffice profile — soffice takes a lock on it, so two jobs converting
    // at once can collide and fail with a generic "source file could not be
    // loaded" error. A per-job profile directory keeps each invocation isolated.
    await execFileAsync(
      env.SOFFICE_PATH,
      [
        '--headless',
        '--norestore',
        `-env:UserInstallation=file://${path.join(dir, 'loprofile')}`,
        '--convert-to',
        'pdf',
        '--outdir',
        dir,
        inputPath,
      ],
      { timeout: 120_000 },
    );
    const outPath = inputPath.replace(/\.docx$/, '.pdf');
    const pdfBuffer = await readFile(outPath);
    return pdfToNormalized(pdfBuffer);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function sourceToPdf(buffer: Buffer, mime: string): Promise<{ pdf: Buffer; pages: number }> {
  if (mime === 'application/pdf') return pdfToNormalized(buffer);
  if (mime === 'image/jpeg' || mime === 'image/png') return imageToPdf(buffer);
  return docxToPdf(buffer);
}

type Source = { key: string; mime: string; name: string };

/** BullMQ 'convert' handler: upload(s) → one normalized print-ready PDF. */
export async function convertFile(fileId: string): Promise<void> {
  const file = await prisma.uploadedFile.findUnique({ where: { id: fileId } });
  if (!file || file.status === 'deleted') return;

  await prisma.uploadedFile.update({ where: { id: fileId }, data: { status: 'converting' } });
  try {
    const sources: Source[] = Array.isArray(file.sources)
      ? (file.sources as unknown as Source[])
      : [{ key: file.originalKey, mime: file.mimeType, name: file.originalName }];

    let result: { pdf: Buffer; pages: number };
    if (sources.length === 1) {
      const buf = await storage.get(sources[0]!.key);
      result = await sourceToPdf(buf, sources[0]!.mime);
    } else {
      // convert each source, then concatenate into one document (order preserved)
      const merged = await PDFDocument.create();
      for (const src of sources) {
        const buf = await storage.get(src.key);
        const { pdf } = await sourceToPdf(buf, src.mime);
        const doc = await PDFDocument.load(pdf);
        const pages = await merged.copyPages(doc, doc.getPageIndices());
        for (const p of pages) merged.addPage(p);
      }
      const bytes = await merged.save();
      result = { pdf: Buffer.from(bytes), pages: merged.getPageCount() };
    }
    if (result.pages < 1) throw new Error('Converted document has no pages');

    const convertedKey = `conv/${randomUUID()}.pdf`;
    await storage.put(convertedKey, result.pdf, 'application/pdf');

    await prisma.uploadedFile.update({
      where: { id: fileId },
      data: { convertedKey, previewKey: convertedKey, pages: result.pages, status: 'ready', error: null },
    });
    publishEvent(`student:${file.studentId}`, 'file:ready', { fileId, pages: result.pages });
    logger.info({ fileId, pages: result.pages }, 'file_converted');
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Conversion failed';
    await prisma.uploadedFile.update({
      where: { id: fileId },
      // sanitized, human-readable reason only — no stack traces to the client
      data: { status: 'failed', error: message.slice(0, 300) },
    });
    publishEvent(`student:${file.studentId}`, 'file:failed', { fileId, error: message.slice(0, 300) });
    logger.error({ err, fileId }, 'file_conversion_failed');
    throw err; // let BullMQ retry transient failures
  }
}

/** Hourly maintenance: delete stored files past their retention window (privacy, §14). */
export async function cleanupExpiredFiles(): Promise<void> {
  const expired = await prisma.uploadedFile.findMany({
    where: { status: { not: 'deleted' }, deleteAfter: { lt: new Date() } },
    take: 200,
  });
  for (const file of expired) {
    try {
      const activeJobs = await prisma.job.count({
        where: {
          fileId: file.id,
          status: {
            in: [
              'pending_payment',
              'awaiting_arrival',
              'queued',
              'notified',
              'otp_verified',
              'printing',
              'ready_for_pickup',
              'no_show',
              'requeued',
            ],
          },
        },
      });
      if (activeJobs > 0) continue;

      const keys = Array.isArray(file.sources)
        ? (file.sources as unknown as Source[]).map((s) => s.key)
        : [file.originalKey];
      for (const key of keys) await storage.delete(key);
      if (file.convertedKey) await storage.delete(file.convertedKey);
      await prisma.uploadedFile.update({
        where: { id: file.id },
        data: { status: 'deleted', convertedKey: null, previewKey: null },
      });
    } catch (err) {
      logger.error({ err, fileId: file.id }, 'file_cleanup_failed');
    }
  }
  if (expired.length > 0) logger.info({ count: expired.length }, 'files_cleaned');
}
