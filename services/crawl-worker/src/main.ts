import { app } from './app.js';
import config from './config.js';

const server = app.listen(config.port, () => {
  console.log(`crawl-worker listening on port ${config.port}`);
});

const SHUTDOWN_TIMEOUT_MS = 10_000;

let shuttingDown = false;
/**
 * Initiate graceful shutdown: close the server and force-exit after a
 * timeout. K8s sends SIGTERM before pod termination; a clean shutdown
 * prevents duplicate Pub/Sub message processing.
 */
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('Shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => {
    console.error(`Forced exit after ${SHUTDOWN_TIMEOUT_MS}ms timeout`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
  process.removeListener('SIGTERM', shutdown);
  process.removeListener('SIGINT', shutdown);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
