import { logger } from './lib/logger.js';
import { startWorkers } from './workers/index.js';

// Standalone worker entrypoint (conversion + timers + maintenance only).
startWorkers().catch((err) => {
  logger.error({ err }, 'worker_boot_failed');
  process.exit(1);
});
