import { Redis } from 'ioredis';
import { env } from '../config/env.js';

/** Shared connection for rate limiting and pub/sub publishing. */
export const redis = new Redis(env.REDIS_URL, { lazyConnect: true });

/** Explicit lifecycle hook for tests and graceful process shutdown. */
export async function closeRedis(): Promise<void> {
  if (redis.status === 'wait' || redis.status === 'end') {
    redis.disconnect();
    return;
  }
  try {
    await redis.quit();
  } catch {
    redis.disconnect();
  }
}
