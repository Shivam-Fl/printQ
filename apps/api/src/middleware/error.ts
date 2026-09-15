import type { NextFunction, Request, Response } from 'express';
import { MulterError } from 'multer';
import { ZodError } from 'zod';
import { InvalidTransitionError, PageRangeError, PricingError } from '@printq/shared';
import { HttpError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

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
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  logger.error({ err, method: req.method, path: req.path }, 'unhandled_error');
  res.status(500).json({ error: 'Something went wrong' });
}
