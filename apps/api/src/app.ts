import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { generalLimiter } from './middleware/rateLimit.js';
import { errorHandler } from './middleware/error.js';
import { authRouter } from './modules/auth/routes.js';
import { filesRouter } from './modules/files/routes.js';
import { jobsRouter } from './modules/jobs/routes.js';
import { paymentsRouter, webhookRouter } from './modules/payments/routes.js';
import { shopRouter } from './modules/shops/routes.js';
import { agentRouter } from './modules/agents/routes.js';
import { publicRouter } from './modules/public/routes.js';

export function createApp(): express.Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1); // real client IPs behind the TLS-terminating proxy
  app.use(helmet());
  app.use(
    cors({
      origin: (origin, callback) => {
        // allow same-origin/CLI requests (no Origin header) and the allowlist
        if (!origin || env.CORS_ORIGINS.includes(origin)) callback(null, true);
        else callback(new Error('Not allowed by CORS'));
      },
    }),
  );
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/healthz' } }));

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // webhook needs the raw body — mounted before the JSON parser
  app.use('/api/payments/webhook', webhookRouter);

  app.use(express.json({ limit: '1mb' }));
  app.use('/api', generalLimiter);

  app.use('/api/auth', authRouter);
  app.use('/api/public', publicRouter);
  app.use('/api/files', filesRouter);
  app.use('/api/jobs', jobsRouter);
  app.use('/api/payments', paymentsRouter);
  app.use('/api/shop', shopRouter);
  app.use('/api/agent', agentRouter);

  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(errorHandler);

  return app;
}
