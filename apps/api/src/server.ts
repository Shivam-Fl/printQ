import { createServer } from 'node:http';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { createApp } from './app.js';
import { setupRealtime } from './realtime/io.js';
import { startWorkers } from './workers/index.js';

const app = createApp();
const httpServer = createServer(app);
setupRealtime(httpServer);

// Pilot deployment runs API + workers in one process. Set RUN_WORKERS=false
// and run dist/worker.js separately when scaling out.
if (process.env.RUN_WORKERS !== 'false') {
  startWorkers().catch((err) => {
    logger.error({ err }, 'workers_failed_to_start');
    process.exit(1);
  });
}

httpServer.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'printq_api_listening');
});
