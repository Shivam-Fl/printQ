import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';

/** Validate and replace req.body with the parsed (typed, defaulted) value. */
export function validateBody(schema: ZodType): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) return next(result.error);
    req.body = result.data;
    next();
  };
}
