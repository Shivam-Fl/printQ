import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { generalLimiter } from './middleware/rateLimit.js';
import { createAppCheckMiddleware } from './middleware/appCheck.js';
import { errorHandler } from './middleware/error.js';
import { HttpError } from './lib/errors.js';
import { authRouter } from './modules/auth/routes.js';
import { filesRouter } from './modules/files/routes.js';
import { jobsRouter } from './modules/jobs/routes.js';
import { paymentsRouter, webhookRouter } from './modules/payments/routes.js';
import { shopRouter } from './modules/shops/routes.js';
import { agentRouter } from './modules/agents/routes.js';
import { publicRouter } from './modules/public/routes.js';
import { pushRouter } from './modules/push/routes.js';

export function createApp(): express.Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1); // real client IPs behind the TLS-terminating proxy
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          baseUri: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'self'"],
          scriptSrc: ["'self'", 'https://checkout.razorpay.com'],
          scriptSrcAttr: ["'none'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'https://cdn.razorpay.com', 'https://*.razorpay.com', 'https://*.tile.openstreetmap.org'],
          connectSrc: ["'self'", 'https://api.razorpay.com', 'https://*.razorpay.com'],
          frameSrc: ["'self'", 'https://api.razorpay.com', 'https://checkout.razorpay.com', 'https://*.razorpay.com'],
          fontSrc: ["'self'", 'data:'],
          manifestSrc: ["'self'"],
          workerSrc: ["'self'"],
        },
      },
    }),
  );
  app.use(
    cors({
      origin: (origin, callback) => {
        // allow same-origin/CLI requests (no Origin header) and the allowlist
        if (!origin || env.CORS_ORIGINS.includes(origin)) callback(null, true);
        else callback(new HttpError(403, 'Origin is not allowed', 'CORS_ORIGIN_DENIED'));
      },
    }),
  );
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/healthz' } }));

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // webhook needs the raw body — mounted before the JSON parser
  app.use('/api/payments/webhook', webhookRouter);

  app.use(express.json({ limit: '1mb' }));
  app.use('/api', generalLimiter);
  app.use('/api', createAppCheckMiddleware());

  app.use('/api/auth', authRouter);
  app.use('/api/public', publicRouter);
  app.use('/api/files', filesRouter);
  app.use('/api/jobs', jobsRouter);
  app.use('/api/payments', paymentsRouter);
  app.use('/api/push', pushRouter);
  app.use('/api/shop', shopRouter);
  app.use('/api/agent', agentRouter);

  // Single-domain production deploy: serve the built web app from the API so
  // the PWA, push notifications and API share one origin. Dev uses Vite.
  const webDist = path.resolve(fileURLToPath(import.meta.url), '../../../web/dist');
  if (env.NODE_ENV === 'production' && existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
    logger.info({ webDist }, 'serving_web_app');
  }

  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(errorHandler);

  return app;
}
