import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { env } from '../config/env.js';
import { storage } from '../providers/storage/index.js';
import { publishEvent } from '../realtime/events.js';
import {
  ensureFileDeletionJob,
  scheduleFileDeletion,
  scheduleVerifiedPrintFileDeletion,
} from '../lib/fileRetention.js';

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

const RECOVERABLE_CONTENT_STATUSES = new Set([
  'pending_payment',
  'awaiting_arrival',
  'queued',
  'notified',
  'otp_verified',
  'printing',
]);

export function keysForDeletion(file: {
  id: string;
  originalKey: string;
  sources: unknown;
  convertedKey: string | null;
  previewKey: string | null;
}): string[] {
  const sourceKeys = Array.isArray(file.sources)
    ? (file.sources as unknown as Source[]).map((source) => source.key)
    : [file.originalKey];
  // A converted document is commonly also the preview. Delete once, but make
  // sure every distinct source/derivative key is included.
  return [...new Set([...sourceKeys, file.convertedKey, file.previewKey].filter((key): key is string => Boolean(key)))];
}

type DueFile = {
  id: string;
  originalKey: string;
  sources: unknown;
  convertedKey: string | null;
  previewKey: string | null;
  jobs: { status: string }[];
};

/**
 * Delete one due file. It deliberately throws on an object-store error so the
 * delayed BullMQ job can back off and land in the dead-letter queue. The
 * minute sweeper also retries from PostgreSQL until the content is gone.
 */
async function deleteDueFile(file: DueFile, now: Date): Promise<'deleted' | 'deferred'> {
  if (file.jobs.some((job) => RECOVERABLE_CONTENT_STATUSES.has(job.status))) {
    // A hard upload deadline met an unexpectedly active/recoverable job. Do
    // not silently move the deadline: keep the overdue state auditable.
    await prisma.uploadedFile.update({
      where: { id: file.id },
      data: {
        deletionAttempts: { increment: 1 },
        lastDeletionError: 'Deletion overdue while a recoverable print job remains active',
      },
    });
    logger.error({ fileId: file.id }, 'file_deletion_overdue_active_job');
    return 'deferred';
  }

  try {
    for (const key of keysForDeletion(file)) await storage.delete(key);
    await prisma.uploadedFile.update({
      where: { id: file.id },
      data: {
        status: 'deleted',
        convertedKey: null,
        previewKey: null,
        // Metadata for orders/audit remains, but neither original content nor
        // filename/source key survives the strict retention window.
        originalKey: `deleted/${file.id}`,
        originalName: 'Document deleted',
        sources: Prisma.DbNull,
        contentDeletedAt: now,
        deletionAttempts: { increment: 1 },
        lastDeletionError: null,
      },
    });
    return 'deleted';
  } catch (error) {
    await prisma.uploadedFile.update({
      where: { id: file.id },
      data: {
        deletionAttempts: { increment: 1 },
        lastDeletionError: error instanceof Error ? error.message.slice(0, 300) : 'Object deletion failed',
      },
    }).catch((updateError) => logger.error({ updateError, fileId: file.id }, 'file_deletion_failure_record_failed'));
    throw error;
  }
}

/** Process an exact delayed deletion job. A clock-skew "not due" result is a
 * harmless no-op; an active recoverable job is the only retryable deferral. */
export async function deleteExpiredFileById(
  fileId: string,
  now = new Date(),
): Promise<'deleted' | 'deferred' | 'not_due'> {
  const file = await prisma.uploadedFile.findUnique({
    where: { id: fileId },
    include: { jobs: { select: { status: true } } },
  });
  if (!file || file.status === 'deleted' || !file.deleteAfter || file.deleteAfter > now) return 'not_due';
  return deleteDueFile(file, now);
}

/**
 * Minute-level, database-backed deletion sweep. It is deliberately idempotent:
 * object-store deletes may have partly succeeded before an outage, and the next
 * run removes the remaining objects without extending the recorded deadline.
 */
export async function cleanupExpiredFiles(): Promise<void> {
  const now = new Date();
  const expired = await prisma.uploadedFile.findMany({
    where: { status: { not: 'deleted' }, deleteAfter: { lte: now } },
    orderBy: { deleteAfter: 'asc' },
    take: 200,
    include: { jobs: { select: { status: true } } },
  });
  for (const file of expired) {
    try {
      await deleteDueFile(file, now);
    } catch (error) {
      logger.error({ error, fileId: file.id }, 'file_cleanup_failed');
    }
  }
  if (expired.length > 0) logger.info({ count: expired.length }, 'files_cleaned');
}

/**
 * Repair a rare post-transition scheduling failure without relying on a Redis
 * delayed job. PostgreSQL remains the source of truth for the deadline.
 */
export async function reconcileFileDeletionSchedules(): Promise<void> {
  const files = await prisma.uploadedFile.findMany({
    where: {
      status: { not: 'deleted' },
      OR: [
        { jobs: { some: { printConfirmedAt: { not: null } } } },
        { jobs: { some: { status: { in: ['cancelled', 'expired'] } } } },
      ],
    },
    select: {
      id: true,
      deleteAfter: true,
      jobs: {
        select: { status: true, printConfirmedAt: true, updatedAt: true },
      },
    },
    take: 200,
  });

  for (const file of files) {
    const confirmedAt = file.jobs
      .map((job) => job.printConfirmedAt)
      .filter((value): value is Date => value !== null)
      .sort((a, b) => a.getTime() - b.getTime())[0];
    if (confirmedAt) {
      await scheduleVerifiedPrintFileDeletion(file.id, confirmedAt);
    } else {
      const terminalAt = file.jobs
        .filter((job) => job.status === 'cancelled' || job.status === 'expired')
        .map((job) => job.updatedAt)
        .sort((a, b) => a.getTime() - b.getTime())[0];
      await scheduleFileDeletion(file.id, terminalAt ?? new Date());
    }
    if (file.deleteAfter) await ensureFileDeletionJob(file.id, file.deleteAfter);
  }
}
