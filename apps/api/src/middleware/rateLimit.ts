import { createHash } from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { env } from '../config/env.js';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { redis } from '../lib/redis.js';
import { tooMany } from '../lib/errors.js';
import { hashAgentToken } from '../lib/otp.js';
import { verifyToken } from '../lib/tokens.js';

/**
 * Redis-backed tiered rate limits. Auth/OTP endpoints get tight per-IP limits
 * (brute-force protection); general API gets a generous ceiling.
 */
function makeLimiter(
  prefix: string,
  windowMs: number,
  max: number,
  skipSuccessfulRequests = false,
  keyGenerator?: (req: Request) => string,
) {
  return rateLimit({
    windowMs,
    limit: max,
    skipSuccessfulRequests,
    // standardHeaders also makes express-rate-limit send Retry-After on every 429
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    ...(keyGenerator ? { keyGenerator: (req: Request) => keyGenerator(req) } : {}),
    // Unit suites exercise route behavior without a networked limiter. CI's
    // simulator and every non-test process still use the shared Redis store.
    ...(env.NODE_ENV === 'test'
      ? {}
      : {
          store: new RedisStore({
            prefix: `rl:${prefix}:`,
            sendCommand: (...args: string[]) => redis.call(...(args as [string, ...string[]])) as never,
          }),
        }),
    message: { error: 'Too many requests, slow down' },
  });
}

/**
 * Who is making this request, for rate limiting only (never for authorization):
 * a validly SIGNED student/shop/admin session token, or an agent token hash.
 * A forged or missing credential yields null and is limited per IP instead, so
 * it cannot be used to dodge the limit or to spend someone else's budget.
 */
export function principalOf(req: Request): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const claims = verifyToken(auth.slice('Bearer '.length));
    if (claims) return `${claims.typ}:${claims.sub}`;
  }
  const agentToken = req.headers['x-agent-token'];
  if (typeof agentToken === 'string' && agentToken.length >= 32) return `agent:${hashAgentToken(agentToken).slice(0, 24)}`;
  return null;
}

const ipOf = (req: Request) => `ip:${req.ip ?? 'unknown'}`;
const chain = (...handlers: RequestHandler[]): RequestHandler => (req, res, next) => {
  const run = (index: number): void => {
    const handler = handlers[index];
    if (!handler) return next();
    handler(req, res, (err?: unknown) => (err ? next(err) : run(index + 1)));
  };
  run(0);
};

/**
 * General API limits: a generous per-IP flood ceiling (a whole campus can sit
 * behind one NAT address) AND a per-principal budget for signed-in traffic.
 * Unauthenticated requests only have the IP, so they get the per-user number
 * keyed by IP (strict).
 */
export function makeGeneralLimiter(prefix: string, perPrincipal: number, perIp: number, windowMs = 60_000): RequestHandler {
  const ceiling = makeLimiter(`${prefix}-ip`, windowMs, perIp, false, ipOf);
  const principal = makeLimiter(`${prefix}-user`, windowMs, perPrincipal, false, (req) => principalOf(req) ?? ipOf(req));
  return chain(ceiling, principal);
}

export const generalLimiter = makeGeneralLimiter('gen', env.RATE_LIMIT_GENERAL_PER_USER, env.RATE_LIMIT_GENERAL_PER_IP);
export const otpRequestLimiter = makeLimiter('otpreq', 60_000, 5);
export const otpVerifyLimiter = makeLimiter('otpver', 60_000, 10);
// Firebase has already verified the phone credential before this exchange.
// Keep enough headroom for many students sharing one campus Wi-Fi NAT and for
// silent trusted-device renewal; the global limiter still provides a ceiling.
export const firebaseSessionLimiter = makeLimiter('firebase-session', 60_000, 120);
// Successful sign-ins hand their slot back: a shop's normal logins (or several
// owners behind one NAT) never lock anyone out; wrong passwords still count.
export const loginLimiter = makeLimiter('login', 60_000, 5, true);
// Sign-up has its own bucket (it used to share rl:login:). Every request counts,
// so one address can't mass-create shops: 10 per 15 minutes per IP.
export const registerLimiter = makeLimiter('register', 15 * 60_000, 10);
/** Uploads: per signed-in student (route runs requireStudent first) plus a higher per-IP ceiling. */
export const uploadLimiter: RequestHandler = chain(
  makeLimiter('upload-ip', 60_000, env.RATE_LIMIT_UPLOAD_PER_IP, false, ipOf),
  makeLimiter('upload-user', 60_000, env.RATE_LIMIT_UPLOAD_PER_USER, false, (req) =>
    req.student ? `student:${req.student.id}` : ipOf(req)),
);

/**
 * Failure-only throttle for the counter-code release (guessing protection).
 * Every request takes a slot up front (so a parallel burst cannot slip past a
 * check-then-increment race); a successful request gives back ONLY its own slot,
 * so one staff member's valid releases can never refund slots burned by wrong
 * codes from someone else. Keyed twice: per (shop, client IP) and, with a higher
 * ceiling, per shop overall. The IP is Express's req.ip, i.e. the wave-2
 * trusted-proxy resolver, never a raw forwarded header.
 */
const memoryHits = new Map<string, { count: number; resetAt: number }>();

async function takeSlot(key: string, windowMs: number): Promise<number> {
  if (env.NODE_ENV === 'test') {
    const now = Date.now();
    const entry = memoryHits.get(key);
    if (!entry || entry.resetAt <= now) {
      memoryHits.set(key, { count: 1, resetAt: now + windowMs });
      return 1;
    }
    entry.count += 1;
    return entry.count;
  }
  const results = await redis.multi().incr(key).pexpire(key, windowMs, 'NX').exec();
  return Number(results?.[0]?.[1] ?? 1);
}

async function giveBackSlot(key: string): Promise<void> {
  if (env.NODE_ENV === 'test') {
    const entry = memoryHits.get(key);
    if (entry && entry.count > 0) entry.count -= 1;
    return;
  }
  await redis.decr(key);
}

type FailureLimiterOptions = {
  /** Whose budget a request spends. Default: the signed-in user's shop. */
  scopeOf?: (req: Request) => string;
  /** The 429 text. Default: the generic limiter text the web app rewrites with the wait time. */
  message?: string;
};

export function makeFailureLimiter(
  prefix: string,
  windowMs: number,
  perShopIp: number,
  perShop: number,
  options: FailureLimiterOptions = {},
) {
  const scopeOf = options.scopeOf ?? ((req: Request) => req.shopUser?.shopId ?? 'anon');
  const message = options.message ?? 'Too many requests, slow down';
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const scope = scopeOf(req);
      const keys = [
        { key: `rl:${prefix}:ip:${scope}:${req.ip ?? 'unknown'}`, max: perShopIp },
        { key: `rl:${prefix}:shop:${scope}`, max: perShop },
      ];
      const counts = await Promise.all(keys.map((k) => takeSlot(k.key, windowMs)));
      const blocked = counts.some((count, i) => count > keys[i]!.max);
      // the window is fixed from its first hit; retrying after one full window is always safe
      if (blocked) return next(tooMany(message, windowMs / 1000));
      _res.once('finish', () => {
        if (_res.statusCode < 400) void Promise.all(keys.map((k) => giveBackSlot(k.key))).catch(() => undefined);
      });
      next();
    } catch (err) {
      next(err);
    }
  };
}

// A valid counter code can require queue, printer and payment confirmation
// requests before printing: those succeed (2xx) and return their own slot.
// Only failures stay counted: 10/min per (shop, IP), 40/min per shop.
export const counterReleaseLimiter = makeFailureLimiter('counter-release', 60_000, 10, 40);

/**
 * Per-account brake on wrong staff PINs (S3/AUTH-9). A 4-6 digit PIN is only
 * 10,000-1,000,000 guesses, so the per-IP loginLimiter alone falls to an
 * attacker rotating addresses. Only PIN-shaped attempts are counted and
 * blocked: on /shop/staff-login always, and on /shop/login when the password
 * typed is 4-6 digits (a PIN works there too). A full owner password is never
 * blocked by this, so nobody can lock an owner out by spamming their email.
 * 10 wrong PINs per account per 15 minutes; a correct PIN hands its slot back.
 * Mount AFTER validateBody so the email is already normalised.
 */
const accountScope = (req: Request) => {
  const email = typeof req.body?.email === 'string' ? req.body.email : '';
  return `acct:${createHash('sha256').update(email).digest('hex').slice(0, 32)}`;
};
const pinFailures = makeFailureLimiter('pin-login-fail', 15 * 60_000, 10, 10, {
  scopeOf: accountScope,
  message: 'Too many wrong PINs for this account. Please wait 15 minutes and try again.',
});
export const pinLoginFailureLimiter: RequestHandler = (req, res, next) => {
  const secret: unknown = req.body?.pin ?? req.body?.password;
  if (typeof secret === 'string' && /^\d{4,6}$/.test(secret)) {
    void pinFailures(req, res, next);
    return;
  }
  next();
};

// Fee Checkout order creation / verification calls the payment provider.
export const feeActionLimiter = makeLimiter('fee-action', 60_000, 20);
