import { pino } from 'pino';
import { env } from '../config/env.js';

/** Structured JSON logs — searchable/aggregatable, per scalability pillar 4. */
export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'printq-api' },
  redact: {
    // never log credentials, tokens or OTPs even accidentally
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      "req.headers['set-cookie']",
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
});
