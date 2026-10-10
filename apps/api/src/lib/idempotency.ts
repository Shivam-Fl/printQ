import { redis } from './redis.js';
import { logger } from './logger.js';

const IDEM_TTL_S = 600;
const LOCK_TTL_S = 30;

/** Accepts a UUID-ish token only; anything else is ignored rather than trusted. */
export function parseIdempotencyKey(header: unknown): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(value) ? value : null;
}

export type IdempotencyClaim =
  | { state: 'claimed' }
  | { state: 'replay'; resultId: string }
  | { state: 'in_flight' };

/**
 * Claim `key` for one logical request. A repeat with the same key either
 * replays the stored result id or reports that the first attempt is still
 * running. Redis trouble never blocks the order (the DB-level duplicate guard
 * still applies).
 */
export async function claimIdempotency(scope: string, key: string): Promise<IdempotencyClaim> {
  const k = `idem:${scope}:${key}`;
  try {
    if (await redis.set(k, 'pending', 'EX', IDEM_TTL_S, 'NX')) return { state: 'claimed' };
    const existing = await redis.get(k);
    return existing && existing !== 'pending' ? { state: 'replay', resultId: existing } : { state: 'in_flight' };
  } catch (err) {
    logger.warn({ err }, 'idempotency_unavailable');
    return { state: 'claimed' };
  }
}

export async function completeIdempotency(scope: string, key: string, resultId: string): Promise<void> {
  await redis.set(`idem:${scope}:${key}`, resultId, 'EX', IDEM_TTL_S).catch(() => undefined);
}

export async function releaseIdempotency(scope: string, key: string): Promise<void> {
  await redis.del(`idem:${scope}:${key}`).catch(() => undefined);
}

/** Short mutual-exclusion lock; returns false when someone else holds it. Fails open if Redis is down. */
export async function tryLock(name: string): Promise<boolean> {
  try {
    return (await redis.set(`lock:${name}`, '1', 'EX', LOCK_TTL_S, 'NX')) === 'OK';
  } catch (err) {
    logger.warn({ err }, 'lock_unavailable');
    return true;
  }
}

export async function unlock(name: string): Promise<void> {
  await redis.del(`lock:${name}`).catch(() => undefined);
}
