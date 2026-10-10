import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { logger, redactUrl } from './lib/logger.js';
import { trustProxySetting } from './lib/clientIpConfig.js';
import { generalLimiter } from './middleware/rateLimit.js';
import { createAppCheckMiddleware } from './middleware/appCheck.js';
import { errorHandler } from './middleware/error.js';
import { HttpError } from './lib/errors.js';
import { authRouter } from './modules/auth/routes.js';
import { filesRouter } from './modules/files/routes.js';
import { jobsRouter } from './modules/jobs/routes.js';
import { paymentsRouter, webhookRouter } from './modules/payments/routes.js';
import { shopRouter } from './modules/shops/routes.js';
import { feesRouter } from './modules/fees/routes.js';
import { agentRouter } from './modules/agents/routes.js';
import { publicRouter } from './modules/public/routes.js';
import { pushRouter } from './modules/push/routes.js';
import { adminRouter } from './modules/admin/routes.js';
import { mountWebApp } from './webApp.js';

export function createApp(): express.Express {
  const app = express();

  app.disable('x-powered-by');
  // Real client IPs behind Cloudflare/Render: trust by address, never by client-supplied headers.
  app.set('trust proxy', trustProxySetting);
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
  app.use(
    pinoHttp({
      logger,
      customProps: (req) => ({ clientIp: req.ip }),
      autoLogging: { ignore: (req) => req.url === '/healthz' },
      serializers: {
        // never log query-string credentials (e.g. the file-preview token)
        req: (req: { id?: unknown; method?: string; url?: string }) => ({
          id: req.id,
          method: req.method,
          url: redactUrl(req.url),
        }),
      },
    }),
  );

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
  app.use('/api/shop/fees', feesRouter);
  app.use('/api/shop', shopRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/agent', agentRouter);

  // Single-domain production deploy: serve the built web app from the API so
  // the PWA, push notifications and API share one origin. Dev uses Vite.
  const webDist = path.resolve(fileURLToPath(import.meta.url), '../../../web/dist');
  if (env.NODE_ENV === 'production' && existsSync(webDist)) {
    mountWebApp(app, webDist);
    logger.info({ webDist }, 'serving_web_app');
  }

  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(errorHandler);

  return app;
}
