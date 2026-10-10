import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { env } from '../config/env.js';
import type { NextFunction, Request, Response } from 'express';
import { redis } from '../lib/redis.js';
import { tooMany } from '../lib/errors.js';

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
// Firebase has already verified the phone credential before this exchange.
// Keep enough headroom for many students sharing one campus Wi-Fi NAT and for
// silent trusted-device renewal; the global limiter still provides a ceiling.
export const firebaseSessionLimiter = makeLimiter('firebase-session', 60_000, 120);
export const loginLimiter = makeLimiter('login', 60_000, 5);
export const uploadLimiter = makeLimiter('upload', 60_000, 10);

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

export function makeFailureLimiter(prefix: string, windowMs: number, perShopIp: number, perShop: number) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const shopId = req.shopUser?.shopId ?? 'anon';
      const keys = [
        { key: `rl:${prefix}:ip:${shopId}:${req.ip ?? 'unknown'}`, max: perShopIp },
        { key: `rl:${prefix}:shop:${shopId}`, max: perShop },
      ];
      const counts = await Promise.all(keys.map((k) => takeSlot(k.key, windowMs)));
      const blocked = counts.some((count, i) => count > keys[i]!.max);
      if (blocked) return next(tooMany('Too many requests, slow down'));
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

// Fee Checkout order creation / verification calls the payment provider.
export const feeActionLimiter = makeLimiter('fee-action', 60_000, 20);
