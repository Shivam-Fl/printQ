import { pino, type DestinationStream } from 'pino';
import { env } from '../config/env.js';

/**
 * Query-string credentials (short-lived preview tokens, legacy ?token=) must
 * never reach the logs, even though they expire in minutes.
 */
export function redactUrl(url: string | undefined): string | undefined {
  return url?.replace(/([?&](?:pt|token|idToken|access_token)=)[^&#]*/gi, '$1[redacted]');
}

/** Structured JSON logs — searchable/aggregatable, per scalability pillar 4. */
export function createLogger(destination?: DestinationStream) {
  const options = {
    level: env.LOG_LEVEL,
    base: { service: 'printq-api' },
    redact: {
      // Request/response headers can contain agent tokens, App Check tokens,
      // webhook signatures and future credentials. Never serialize any of them.
      paths: [
        'req.headers',
        'res.headers',
        '*.authorization',
        '*.password',
        '*.passwordHash',
        '*.otp',
        '*.resetCode',
        '*.token',
        '*.idToken',
        '*.apiKey',
      ],
      censor: '[redacted]',
    },
  };
  return destination ? pino(options, destination) : pino(options);
}

export const logger = createLogger();
