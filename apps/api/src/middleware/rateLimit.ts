import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { redis } from '../lib/redis.js';

/**
 * Redis-backed tiered rate limits. Auth/OTP endpoints get tight per-IP limits
 * (brute-force protection); general API gets a generous ceiling.
 */
function makeLimiter(prefix: string, windowMs: number, max: number) {
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    store: new RedisStore({
      prefix: `rl:${prefix}:`,
      sendCommand: (...args: string[]) => redis.call(...(args as [string, ...string[]])) as never,
    }),
    message: { error: 'Too many requests, slow down' },
  });
}

export const generalLimiter = makeLimiter('gen', 60_000, 300);
export const otpRequestLimiter = makeLimiter('otpreq', 60_000, 5);
export const otpVerifyLimiter = makeLimiter('otpver', 60_000, 10);
// Firebase has already verified the phone credential before this exchange.
// Keep enough headroom for many students sharing one campus Wi-Fi NAT and for
// silent trusted-device renewal; the global limiter still provides a ceiling.
export const firebaseSessionLimiter = makeLimiter('firebase-session', 60_000, 120);
export const loginLimiter = makeLimiter('login', 60_000, 5);
export const uploadLimiter = makeLimiter('upload', 60_000, 10);
