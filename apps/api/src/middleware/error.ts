import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { InvalidTransitionError, PricingError } from '@printq/shared';
import { HttpError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

/**
 * Global error handler: intentional errors pass their message through;
 * everything else logs full detail server-side and returns a generic message
 * (no stack traces, ORM errors or file paths to the client).
 */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
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
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  logger.error({ err, method: req.method, path: req.path }, 'unhandled_error');
  res.status(500).json({ error: 'Something went wrong' });
}
