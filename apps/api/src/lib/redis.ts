import { Redis } from 'ioredis';
import { env } from '../config/env.js';

/** Shared connection for rate limiting and pub/sub publishing. */
export const redis = new Redis(env.REDIS_URL);
