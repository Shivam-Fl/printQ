import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
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
import { env } from '../../config/env.js';

export const filesRouter = Router();

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 15;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES },
});

type AllowedKind = {
  ext: 'pdf' | 'docx' | 'jpg' | 'png';
  mime: string;
  filenameExtensions: readonly string[];
  declaredMimeTypes: readonly string[];
};

const ALLOWED_KINDS: Record<AllowedKind['ext'], AllowedKind> = {
  pdf: {
    ext: 'pdf',
    mime: 'application/pdf',
    filenameExtensions: ['.pdf'],
    declaredMimeTypes: ['application/pdf', 'application/x-pdf', 'application/octet-stream'],
  },
  docx: {
    ext: 'docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    filenameExtensions: ['.docx'],
    declaredMimeTypes: [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-word.document.12',
      'application/zip',
      'application/x-zip-compressed',
      'application/octet-stream',
    ],
  },
  jpg: {
    ext: 'jpg',
    mime: 'image/jpeg',
    filenameExtensions: ['.jpg', '.jpeg'],
    declaredMimeTypes: ['image/jpeg', 'image/pjpeg', 'application/octet-stream'],
  },
  png: {
    ext: 'png',
    mime: 'image/png',
    filenameExtensions: ['.png'],
    declaredMimeTypes: ['image/png', 'image/x-png', 'application/octet-stream'],
  },
};

/**
 * A file is accepted only when filename extension, browser-declared MIME and
 * its magic bytes agree. The browser may fall back to application/octet-stream,
 * but only after the other two independent checks have identified the same
 * allowlisted type. DOCX is a ZIP container, so its package marker is also
 * checked when file-type reports a generic ZIP archive.
 */
async function detectAllowedType(buffer: Buffer): Promise<AllowedKind | null> {
  const detected = await fileTypeFromBuffer(buffer);
  if (!detected) return null;
  if (detected.ext === 'pdf') return ALLOWED_KINDS.pdf;
  if (detected.ext === 'png') return ALLOWED_KINDS.png;
  if (detected.ext === 'jpg') return ALLOWED_KINDS.jpg;
  if (detected.ext === 'docx') {
    return ALLOWED_KINDS.docx;
  }
  if (detected.ext === 'zip' && buffer.includes(Buffer.from('word/document.xml'))) {
    return ALLOWED_KINDS.docx;
  }
  return null;
}

function hasCoherentUploadType(kind: AllowedKind, originalName: string, declaredMimeType: string): boolean {
  const extension = extname(originalName).toLowerCase();
  const mime = declaredMimeType.toLowerCase().split(';', 1)[0]?.trim() ?? '';
  return kind.filenameExtensions.includes(extension) && kind.declaredMimeTypes.includes(mime);
}

/** Exposed for regression coverage; the route remains the only caller in production. */
export async function validateUploadFileType(
  buffer: Buffer,
  originalName: string,
  declaredMimeType: string,
): Promise<AllowedKind | null> {
  const kind = await detectAllowedType(buffer);
  return kind && hasCoherentUploadType(kind, originalName, declaredMimeType) ? kind : null;
}

function trustedFrameAncestors(origins: readonly string[]): string[] {
  return origins.flatMap((origin) => {
    // CORS may be permissive in local development, but a preview must never
    // become frameable by every site. Only concrete HTTP(S) origins qualify.
    if (origin === '*') return [];
    try {
      const parsed = new URL(origin);
      return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.origin === origin
        ? [parsed.origin]
        : [];
    } catch {
      return [];
    }
  });
}

/**
 * Overrides Helmet only for an authenticated, ready local preview response.
 * CORS continues to allow reads only for env.CORS_ORIGINS; CSP separately
 * restricts embedding to those concrete configured frontend origins.
 */
export function setPreviewSecurityHeaders(
  res: Pick<import('express').Response, 'removeHeader' | 'setHeader'>,
  origins: readonly string[] = env.CORS_ORIGINS,
): void {
  const frameAncestors = trustedFrameAncestors(origins);
  res.removeHeader('X-Frame-Options');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader(
    'Content-Security-Policy',
    `sandbox; default-src 'none'; frame-ancestors ${frameAncestors.length > 0 ? frameAncestors.join(' ') : "'none'"}`,
  );
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
      const kind = await validateUploadFileType(f.buffer, f.originalname, f.mimetype);
      if (!kind) {
        throw badRequest('Each file must be a matching PDF, DOCX, JPG, JPEG or PNG');
      }
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
    // Applied after a file is found, ready and authorized; global Helmet stays
    // strict for every other endpoint.
    setPreviewSecurityHeaders(res);
    res.setHeader('Content-Disposition', 'inline; filename="preview.pdf"');
    res.send(bytes);
  }),
);
