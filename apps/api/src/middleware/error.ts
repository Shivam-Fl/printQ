import type { NextFunction, Request, Response } from 'express';
import { MulterError } from 'multer';
import { ZodError } from 'zod';
import { InvalidTransitionError, PageRangeError, PricingError } from '@printq/shared';
import { HttpError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

const BODY_PARSER_TYPES = new Set([
  'entity.too.large',
  'entity.parse.failed',
  'entity.verify.failed',
  'encoding.unsupported',
  'charset.unsupported',
  'request.aborted',
  'request.size.invalid',
  'stream.encoding.set',
  'parameters.too.many',
]);

function asBodyParserError(err: unknown): { type: string; status: number } | null {
  if (typeof err !== 'object' || err === null) return null;
  const { type, status } = err as { type?: unknown; status?: unknown };
  if (typeof type !== 'string' || !BODY_PARSER_TYPES.has(type)) return null;
  const code = typeof status === 'number' && status >= 400 && status < 500 ? status : 400;
  return { type, status: code };
}

/**
 * Global error handler: intentional errors pass their message through;
 * everything else logs full detail server-side and returns a generic message
 * (no stack traces, ORM errors or file paths to the client).
 */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof MulterError) {
    const uploadErrors: Record<string, { status: number; error: string; code: string }> = {
      LIMIT_FILE_SIZE: { status: 413, error: 'Each file must be 25 MB or smaller', code: 'FILE_TOO_LARGE' },
      LIMIT_FILE_COUNT: { status: 400, error: 'Upload up to 15 files at a time', code: 'TOO_MANY_FILES' },
      LIMIT_UNEXPECTED_FILE: { status: 400, error: 'Invalid upload field', code: 'INVALID_UPLOAD_FIELD' },
    };
    const mapped = uploadErrors[err.code] ?? { status: 400, error: 'Invalid file upload', code: 'INVALID_UPLOAD' };
    res.status(mapped.status).json({ error: mapped.error, code: mapped.code });
    return;
  }
  // body-parser / raw-body errors (malformed JSON, over-size body, bad encoding).
  // They carry a 4xx status and a `type`; never echo their message (it can quote
  // the offending input and parser internals).
  const bodyError = asBodyParserError(err);
  if (bodyError) {
    if (bodyError.type === 'entity.too.large') {
      res.status(413).json({ error: 'Request body is too large', code: 'BODY_TOO_LARGE' });
    } else if (bodyError.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Request body is not valid JSON', code: 'INVALID_JSON' });
    } else {
      res.status(bodyError.status).json({ error: 'Invalid request body', code: 'INVALID_BODY' });
    }
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({
      error: 'Validation failed',
      details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
    return;
  }
  if (err instanceof InvalidTransitionError) {
    res.status(409).json({ error: 'This action is not possible in the job’s current state' });
    return;
  }
  if (err instanceof PricingError) {
    res.status(400).json({ error: err.message });
    return;
  }
  if (err instanceof PageRangeError) {
    res.status(400).json({ error: err.message, code: 'INVALID_PAGE_RANGE' });
    return;
  }
  if (err instanceof HttpError) {
    if (err.headers) for (const [name, value] of Object.entries(err.headers)) res.setHeader(name, value);
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  logger.error({ err, method: req.method, path: req.path }, 'unhandled_error');
  res.status(500).json({ error: 'Something went wrong' });
}
