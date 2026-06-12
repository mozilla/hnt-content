// Must be first: initializes Sentry before any other module's
// top-level code runs.
import './sentry-init.js';

import { setTimeout as delay } from 'node:timers/promises';
import { shutdownSentry, withSentryHandler } from 'crawl-common';
import { app, isRunning, setLastTickAt, stopRunning } from './app.js';
import config from './config.js';

const server = app.listen(config.port, () => {
  console.log(`crawl-agent listening on port ${config.port}`);
});

// Cancels the inter-tick delay in run() during shutdown.
const ac = new AbortController();
const SHUTDOWN_TIMEOUT_MS = 10_000;

let shuttingDown = false;
/**
 * Initiate graceful shutdown: stop the tick loop, close the server,
 * flush Sentry, and force-exit after a timeout. K8s sends SIGTERM
 * before pod termination; a clean shutdown prevents duplicate
 * Pub/Sub message processing and ensures captured errors reach
 * Sentry.
 */
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('Shutting down');
  stopRunning();
  ac.abort();
  server.close(async () => {
    await shutdownSentry();
    process.exit(0);
  });
  setTimeout(() => {
    console.error(`Forced exit after ${SHUTDOWN_TIMEOUT_MS}ms timeout`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
  process.removeListener('SIGTERM', shutdown);
  process.removeListener('SIGINT', shutdown);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

/**
 * Execute a single crawl cycle. Currently only logs the time.
 * Eventually, each tick will check publisher pages and live
 * articles against Redis timestamps, then publish due items
 * to the crawl Pub/Sub queues for worker processing.
 */
async function tick() {
  console.log('tick', new Date().toISOString());
  setLastTickAt(Date.now());
}

// Wrap tick in a fresh Sentry isolation scope per invocation so
// tags don't leak between ticks.
const tickWithSentry = withSentryHandler<{ startedAt: string }>(
  ({ startedAt }) => ({ context: { startedAt } }),
  tick,
);

/**
 * Run the tick loop at the configured interval until the
 * process is signalled to stop.
 */
async function run() {
  while (isRunning()) {
    const start = Date.now();
    const startedAt = new Date(start).toISOString();
    try {
      // Wrap tick(), not run(): the catch below swallows tick errors,
      // so tick() is the outermost frame that still bubbles them up.
      await tickWithSentry({ startedAt });
    } catch (err) {
      // tickWithSentry already captured the error and rethrew so
      // the loop sees it; swallowing here keeps a single failed
      // tick from killing the agent.
      console.error('tick failed:', err);
    }
    const elapsed = Date.now() - start;
    const remainingMs = Math.max(0, config.tickIntervalMs - elapsed);
    try {
      await delay(remainingMs, undefined, { signal: ac.signal });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') break;
      throw err;
    }
  }
}

run().catch((err) => {
  console.error('run loop crashed:', err);
  process.exit(1);
});
