import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import { fileTypeFromBuffer } from 'file-type';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, badRequest, notFound } from '../../lib/errors.js';
import { param } from '../../lib/http.js';
import { requireStudent, requireStudentAllowQueryToken } from '../../middleware/auth.js';
import { uploadLimiter } from '../../middleware/rateLimit.js';
import { storage } from '../../providers/storage/index.js';
import { fileRetentionDeadline } from '../../lib/fileRetention.js';
import { convertQueue } from '../../lib/queues.js';

export const filesRouter = Router();

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 15;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES },
});

type AllowedKind = { ext: string; mime: string };

/**
 * Content-based (magic bytes) file validation — client filename and MIME type
 * are never trusted. DOCX is a zip container, so file-type may report it as
 * either 'docx' or plain 'zip'; the zip case is accepted only when the
 * declared name ends in .docx and conversion will fail safely if it isn't.
 */
async function detectAllowedType(buffer: Buffer, originalName: string): Promise<AllowedKind | null> {
  const detected = await fileTypeFromBuffer(buffer);
  if (!detected) return null;
  if (detected.ext === 'pdf') return { ext: 'pdf', mime: 'application/pdf' };
  if (detected.ext === 'png') return { ext: 'png', mime: 'image/png' };
  if (detected.ext === 'jpg') return { ext: 'jpg', mime: 'image/jpeg' };
  if (detected.ext === 'docx') {
    return { ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  }
  if (detected.ext === 'zip' && originalName.toLowerCase().endsWith('.docx')) {
    return { ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  }
  return null;
}

/**
 * Upload one or more documents for a shop. Multiple files are merged, in the
 * order sent, into a single print-ready PDF = one job (one preview, one price,
 * one OTP). Conversion runs async in the worker. Accepts `files` (multi) and
 * falls back to `file` (single) for older clients.
 */
filesRouter.post(
  '/',
  requireStudent,
  uploadLimiter,
  upload.fields([{ name: 'files', maxCount: MAX_FILES }, { name: 'file', maxCount: 1 }]),
  asyncHandler(async (req, res) => {
    const fields = req.files as Record<string, Express.Multer.File[]> | undefined;
    const files = [...(fields?.files ?? []), ...(fields?.file ?? [])];
    if (files.length === 0) throw badRequest('No file uploaded');

    const shopSlug = typeof req.body?.shopSlug === 'string' ? req.body.shopSlug : '';
    const shop = await prisma.shop.findUnique({ where: { slug: shopSlug } });
    if (!shop) throw badRequest('Unknown shop');

    // validate + store each source; keep order for the merge
    const sources: { key: string; mime: string; name: string }[] = [];
    let totalBytes = 0;
    for (const f of files) {
      const kind = await detectAllowedType(f.buffer, f.originalname);
      if (!kind) throw badRequest(`"${f.originalname}" isn't a PDF, DOCX, JPG or PNG`);
      const key = `orig/${randomUUID()}.${kind.ext}`;
      await storage.put(key, f.buffer, kind.mime);
      sources.push({ key, mime: kind.mime, name: f.originalname.slice(0, 120) });
      totalBytes += f.buffer.length;
    }

    const first = files[0]!.originalname.slice(0, 120);
    const displayName = files.length === 1 ? first : `${first} +${files.length - 1} more`;

    const record = await prisma.uploadedFile.create({
      data: {
        studentId: req.student!.id,
        shopId: shop.id,
        originalName: displayName,
        originalKey: sources[0]!.key,
        sources: files.length > 1 ? sources : undefined,
        mimeType: sources[0]!.mime,
        sizeBytes: totalBytes,
        status: 'uploaded',
        // Covers abandoned previews and incomplete checkouts; active jobs are
        // protected by cleanupExpiredFiles and terminal states restart this clock.
        deleteAfter: fileRetentionDeadline(),
      },
    });
    await convertQueue.add('convert', { fileId: record.id });

    res.status(201).json({ file: { id: record.id, status: record.status, name: displayName } });
  }),
);

/** Poll conversion status (also pushed via socket 'file:ready'). */
filesRouter.get(
  '/:id',
  requireStudent,
  asyncHandler(async (req, res) => {
    const file = await prisma.uploadedFile.findFirst({
      // ownership in the WHERE clause — students can only see their own files
      where: { id: param(req, 'id'), studentId: req.student!.id },
      select: { id: true, status: true, pages: true, error: true, originalName: true },
    });
    if (!file) throw notFound();
    res.json({ file });
  }),
);

/**
 * Print-ready PDF preview ("what you see is what prints"). Local driver
 * streams through the API; s3 driver redirects to a short-lived signed URL.
 */
filesRouter.get(
  '/:id/preview',
  requireStudentAllowQueryToken,
  asyncHandler(async (req, res) => {
    const file = await prisma.uploadedFile.findFirst({
      where: { id: param(req, 'id'), studentId: req.student!.id },
    });
    if (!file || !file.convertedKey || file.status !== 'ready') throw notFound();

    const signed = await storage.getSignedUrl(file.convertedKey, 300);
    if (signed) {
      res.redirect(302, signed);
      return;
    }
    const bytes = await storage.get(file.convertedKey);
    res.setHeader('Content-Type', 'application/pdf');
    // sandbox neutralizes any active content should a hostile PDF slip through
    res.setHeader('Content-Security-Policy', 'sandbox');
    res.setHeader('Content-Disposition', 'inline; filename="preview.pdf"');
    res.send(bytes);
  }),
);
