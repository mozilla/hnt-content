// Initialize Sentry first to capture errors from other modules.
import './sentry-init.js';

import { initCorpusApiClient } from 'crawl-common';
import { initPubSubClient, shutdownPubSub } from 'pubsub';
import { shutdownSentry } from 'sentry';
import { app, setLastTickAt } from './app.js';
import config from './config.js';
import { enqueueLiveArticles } from './live-articles.js';
import { enqueuePages } from './pages.js';
import { runEveryMinute } from './run-every-minute.js';

const server = app.listen(config.port, () => {
  console.log(`crawl-scheduler listening on port ${config.port}`);
});

// Aborting it during shutdown stops both tick loops.
const ac = new AbortController();
const SHUTDOWN_TIMEOUT_MS = 10_000;

let shuttingDown = false;
/**
 * Initiate graceful shutdown: stop the tick loops, close the server,
 * drain Pub/Sub, flush Sentry, and force-exit after a timeout.
 */
function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log('Shutting down');
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

/**
 * Run the page and live article loops until the process is signalled
 * to stop. They run separately so a slow Corpus API, which only live
 * articles call, cannot delay page crawls.
 */
async function run() {
  await initCorpusApiClient();
  initPubSubClient();
  await Promise.all([
    runEveryMinute(tickPages, ac.signal),
    runEveryMinute(tickLiveArticles, ac.signal),
  ]);
}

run().catch((err) => {
  console.error('run loop crashed:', err);
  process.exit(1);
});
