import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { startWorkers } from './workers/index.js';

async function boot(): Promise<void> {
  const runtime = await startWorkers(env.WORKER_ROLE);
  let stopping = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    logger.info({ role: env.WORKER_ROLE, signal }, 'worker_shutdown_requested');
    runtime.close()
      .then(() => process.exit(0))
      .catch((err) => {
        logger.error({ err, role: env.WORKER_ROLE }, 'worker_shutdown_failed');
        process.exit(1);
      });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

// Standalone entrypoint for a Cloud Run conversion or maintenance worker pool.
boot().catch((err) => {
  logger.error({ err }, 'worker_boot_failed');
  process.exit(1);
});
