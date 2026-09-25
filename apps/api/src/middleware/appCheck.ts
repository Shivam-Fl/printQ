import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';
import { unauthorized } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { verifyFirebaseAppCheckToken } from '../providers/firebaseAdmin/index.js';

type AppCheckMode = 'disabled' | 'monitor' | 'enforce';
type VerifyAppCheck = (token: string) => Promise<{ appId: string }>;

export type AppCheckAssessment =
  | { accepted: true; appId?: string }
  | { accepted: false; reason: 'missing' | 'invalid' };

/** Pure policy seam: monitor records bad traffic, enforce rejects it. */
export async function assessAppCheck(
  mode: AppCheckMode,
  token: string | undefined,
  verify: VerifyAppCheck = verifyFirebaseAppCheckToken,
): Promise<AppCheckAssessment> {
  if (mode === 'disabled') return { accepted: true };
  if (!token) return mode === 'monitor' ? { accepted: true } : { accepted: false, reason: 'missing' };
  try {
    const claims = await verify(token);
    return { accepted: true, appId: claims.appId };
  } catch {
    return mode === 'monitor' ? { accepted: true } : { accepted: false, reason: 'invalid' };
  }
}

function isExcluded(req: Request): boolean {
  // Agents authenticate with their own opaque machine token and cannot obtain
  // a browser App Check assertion. Payment webhooks are mounted before this
  // middleware; CORS preflight has no credentials by design.
  return req.method === 'OPTIONS' || req.path.startsWith('/agent');
}

export function createAppCheckMiddleware(
  mode: AppCheckMode = env.FIREBASE_APP_CHECK_MODE,
  verify: VerifyAppCheck = verifyFirebaseAppCheckToken,
) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (isExcluded(req) || mode === 'disabled') return next();
    const header = req.header('X-Firebase-AppCheck') ?? undefined;
    void assessAppCheck(mode, header, verify).then((assessment) => {
      if (!assessment.accepted) return next(unauthorized('App attestation failed'));
      if (assessment.appId) req.firebaseAppCheck = { appId: assessment.appId };
      // Do not log a token or app identifier. Monitor metrics are only route,
      // method and whether an assertion was missing/invalid.
      if (!header) logger.warn({ route: req.path, method: req.method, reason: 'missing' }, 'app_check_monitor');
      else if (!assessment.appId) logger.warn({ route: req.path, method: req.method, reason: 'invalid' }, 'app_check_monitor');
      next();
    }).catch(next);
  };
}
