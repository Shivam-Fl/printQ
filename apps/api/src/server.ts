import { createServer } from 'node:http';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { createApp } from './app.js';
import { setupRealtime } from './realtime/io.js';
import { startWorkers } from './workers/index.js';
import { ensureBootstrapAdmin } from './modules/admin/bootstrap.js';

async function boot(): Promise<void> {
  await ensureBootstrapAdmin();
  const app = createApp();
  const httpServer = createServer(app);
  setupRealtime(httpServer);

  // Pilot deployment runs API + workers in one process. Set RUN_WORKERS=false
  // and run dist/worker.js separately when scaling out.
  if (process.env.RUN_WORKERS !== 'false') await startWorkers();

  httpServer.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'printq_api_listening');
  });
}

boot().catch((err) => {
  logger.error({ err }, 'api_boot_failed');
  process.exit(1);
});
