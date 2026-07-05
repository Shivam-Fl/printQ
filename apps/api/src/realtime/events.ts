import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';

/**
 * All realtime emissions go through Redis pub/sub so that BullMQ workers
 * (which may run in a separate process) can push socket events through the
 * API server(s). Also makes multi-instance API deployment safe later.
 */
const CHANNEL = 'printq:events';

export interface RealtimeEvent {
  /** socket.io room, e.g. `student:<id>`, `shop:<id>`, `printer-agents:<printerId>` */
  room: string;
  event: string;
  payload: unknown;
}

export function publishEvent(room: string, event: string, payload: unknown): void {
  redis.publish(CHANNEL, JSON.stringify({ room, event, payload })).catch((err) => {
    logger.error({ err, room, event }, 'event_publish_failed');
  });
}

export function subscribeEvents(handler: (evt: RealtimeEvent) => void): void {
  const sub = new Redis(env.REDIS_URL);
  sub.subscribe(CHANNEL).catch((err) => logger.error({ err }, 'event_subscribe_failed'));
  sub.on('message', (_channel, message) => {
    try {
      handler(JSON.parse(message) as RealtimeEvent);
    } catch (err) {
      logger.error({ err }, 'event_parse_failed');
    }
  });
}
