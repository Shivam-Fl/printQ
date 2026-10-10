import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** Errors safe to expose to clients: message is intentional, status is set. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
    /** Extra response headers (e.g. Retry-After on a 429). */
    public readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (msg: string, code?: string) => new HttpError(400, msg, code);
export const unauthorized = (msg = 'Unauthorized') => new HttpError(401, msg);
export const forbidden = (msg = 'Forbidden') => new HttpError(403, msg);
// 404 for missing AND not-owned resources — never confirm existence (IDOR hygiene)
export const notFound = (msg = 'Not found') => new HttpError(404, msg);
export const conflict = (msg: string) => new HttpError(409, msg);
/** 429 — always carries Retry-After (seconds) so clients and proxies back off correctly. */
export const tooMany = (msg = 'Too many requests', retryAfterSeconds = 60) =>
  new HttpError(429, msg, undefined, { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterSeconds))) });

/** Wrap async route handlers so rejections reach the global error handler. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
