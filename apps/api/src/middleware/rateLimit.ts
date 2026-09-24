import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { env } from '../config/env.js';
import { redis } from '../lib/redis.js';

/**
 * Redis-backed tiered rate limits. Auth/OTP endpoints get tight per-IP limits
 * (brute-force protection); general API gets a generous ceiling.
 */
function makeLimiter(prefix: string, windowMs: number, max: number, skipSuccessfulRequests = false) {
  return rateLimit({
    windowMs,
    limit: max,
    skipSuccessfulRequests,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
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

export const generalLimiter = makeLimiter('gen', 60_000, 300);
export const otpRequestLimiter = makeLimiter('otpreq', 60_000, 5);
export const otpVerifyLimiter = makeLimiter('otpver', 60_000, 10);
// A valid counter code can require queue, printer and payment confirmation
// requests before printing. Count failed attempts, not those valid prompts;
// otherwise a busy shop can lock itself out after just a few orders.
export const counterReleaseLimiter = makeLimiter('counter-release', 60_000, 10, true);
// Firebase has already verified the phone credential before this exchange.
// Keep enough headroom for many students sharing one campus Wi-Fi NAT and for
// silent trusted-device renewal; the global limiter still provides a ceiling.
export const firebaseSessionLimiter = makeLimiter('firebase-session', 60_000, 120);
export const loginLimiter = makeLimiter('login', 60_000, 5);
export const uploadLimiter = makeLimiter('upload', 60_000, 10);
