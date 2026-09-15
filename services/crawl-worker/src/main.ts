// Initialize Sentry first to capture errors from other modules.
import './sentry-init.js';

import { initPubSubClient, shutdownPubSub } from 'pubsub';
import { shutdownSentry } from 'sentry';
import { initZyteClient } from 'zyte';
import { app } from './app.js';
import { startArticleConsumer } from './article-consumer.js';
import config from './config/index.js';

const server = app.listen(config.port, () => {
  console.log(`crawl-worker listening on port ${config.port}`);
});

// The discovery role has no consumer yet (HNT-2112) and only serves
// /healthz.
if (config.workerRole === 'article') {
  initZyteClient({ apiKey: config.zyteApiKey });
  initPubSubClient({ projectId: config.projectId });
  startArticleConsumer();
}

// Shorter than the 25s Pub/Sub drain, so a slow in-flight extraction is
// cut off and redelivered. HNT-2896 aligns this with the pod grace period.
const SHUTDOWN_TIMEOUT_MS = 10_000;

let shuttingDown = false;
/**
 * Initiate graceful shutdown: close the server, drain Pub/Sub, flush
 * Sentry, and force-exit after a timeout. K8s sends SIGTERM before pod
 * termination; a clean shutdown prevents duplicate Pub/Sub message
 * processing and ensures captured errors reach Sentry.
 */
function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log('Shutting down');
  server.close(async () => {
    await shutdownPubSub();
    await shutdownSentry();
    process.exit(0);
  });
  // The close callback above can stall on a lingering connection or a
  // slow drain, so force an exit. Unref'd so this timer alone does not
  // hold the event loop open and delay a clean exit.
  setTimeout(() => {
    console.error(`Forced exit after ${SHUTDOWN_TIMEOUT_MS}ms timeout`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
  process.removeListener('SIGTERM', shutdown);
  process.removeListener('SIGINT', shutdown);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
