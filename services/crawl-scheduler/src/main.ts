// Initialize Sentry first to capture errors from other modules.
import './sentry-init.js';

import { setTimeout as delay } from 'node:timers/promises';
import { initCorpusApiClient } from 'crawl-common';
import { initPubSubClient, shutdownPubSub } from 'pubsub';
import { shutdownSentry, withSentryHandler } from 'sentry';
import { app, isRunning, setLastTickAt, stopRunning } from './app.js';
import config from './config.js';
import { enqueueLiveArticles } from './live-articles.js';
import { enqueuePages } from './pages.js';

const server = app.listen(config.port, () => {
  console.log(`crawl-scheduler listening on port ${config.port}`);
});

// Cancels the wait between ticks during shutdown.
const ac = new AbortController();
const SHUTDOWN_TIMEOUT_MS = 10_000;

let shuttingDown = false;
/**
 * Initiate graceful shutdown: stop the tick loop, close the server,
 * drain Pub/Sub, flush Sentry, and force-exit after a timeout.
 */
function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log('Shutting down');
  stopRunning();
  ac.abort();
  server.close(async () => {
    // Draining Pub/Sub first flushes a batch the last tick published.
    await shutdownPubSub();
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

const MINUTE_MS = 60_000;

/**
 * Wait for the next epoch minute to begin and return it, or return null
 * if shutdown cut the wait short.
 */
async function waitForNextMinute(): Promise<number | null> {
  const nextMinute = Math.floor(Date.now() / MINUTE_MS) + 1;
  const msUntilNextMinute = nextMinute * MINUTE_MS - Date.now();
  try {
    await delay(msUntilNextMinute, undefined, { signal: ac.signal });
    return nextMinute;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return null;
    }
    throw err;
  }
}

/** Enqueue the publisher pages due in the given epoch minute. */
async function tickPages(epochMinute: number) {
  setLastTickAt(Date.now());
  const pages = await enqueuePages(epochMinute);
  console.log('tick', new Date().toISOString(), `pages=${pages}`);
}

/** Enqueue a batch of live articles. */
async function tickLiveArticles() {
  const liveArticles = await enqueueLiveArticles();
  console.log(
    'tick',
    new Date().toISOString(),
    `live_articles=${liveArticles}`,
  );
}

/** Call tick at the start of every minute until shutdown. */
async function runEveryMinute(tick: (epochMinute: number) => Promise<void>) {
  const tickWithSentry = withSentryHandler<{
    epochMinute: number;
    startedAt: string;
  }>(
    (context) => ({ context }),
    ({ epochMinute }) => tick(epochMinute),
  );

  while (isRunning()) {
    const epochMinute = await waitForNextMinute();
    if (epochMinute === null) {
      break;
    }
    try {
      await tickWithSentry({
        epochMinute,
        startedAt: new Date().toISOString(),
      });
    } catch (err) {
      // Sentry already has the error, so log it and move on to the next tick.
      console.error('tick failed:', err);
    }
  }
}

/**
 * Run the page and live article loops until the process is signalled
 * to stop. They run separately so a slow Corpus API, which only live
 * articles call, cannot delay page crawls.
 */
async function run() {
  await initCorpusApiClient();
  initPubSubClient();
  await Promise.all([
    runEveryMinute(tickPages),
    runEveryMinute(tickLiveArticles),
  ]);
}

run().catch((err) => {
  console.error('run loop crashed:', err);
  process.exit(1);
});
