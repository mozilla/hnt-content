// Initialize Sentry and metrics first to capture from other modules.
import './sentry-init.js';
import './metrics-init.js';
import { setTimeout as delay } from 'node:timers/promises';
import { initCorpusApiClient, type PublisherList } from 'crawl-common';
import { initPubSubClient, shutdownPubSub } from 'pubsub';
import { initRedisClient, shutdownRedis } from 'redis-state';
import { count, shutdownMetrics, timing } from 'metrics';
import { shutdownSentry, withSentryHandler } from 'sentry';
import { app, isRunning, setLastTickAt, stopRunning } from './app.js';
import config from './config.js';
import {
  corpusSourceEnabled,
  fetchLiveArticles,
  loadPublisherList,
} from './publisher-list.js';
import { runTick } from './tick.js';

const server = app.listen(config.port, () => {
  console.log(`crawl-agent listening on port ${config.port}`);
});

// Cancels the inter-tick delay in run() during shutdown.
const ac = new AbortController();
const SHUTDOWN_TIMEOUT_MS = 10_000;

// pages are loaded once at startup; live_articles are refreshed from
// the Corpus API on an interval when that source is configured.
let publisherList: PublisherList;
let lastCorpusRefreshAt = 0;

let shuttingDown = false;
/**
 * Initiate graceful shutdown: stop the tick loop, drain Pub/Sub and
 * Redis, close the server, flush Sentry, and force-exit after a
 * timeout. K8s sends SIGTERM before pod termination; draining first
 * flushes pending publishes and reports errors to Sentry.
 */
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('Shutting down');
  stopRunning();
  ac.abort();
  process.removeListener('SIGTERM', shutdown);
  process.removeListener('SIGINT', shutdown);

  const forceExit = setTimeout(() => {
    console.error(`Forced exit after ${SHUTDOWN_TIMEOUT_MS}ms timeout`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  let exitCode = 0;
  // Flush pending publishes, then close Redis. Log failures but keep
  // going so the server close and Sentry flush always run.
  try {
    await shutdownPubSub();
  } catch (err) {
    console.error('Error draining Pub/Sub:', err);
    exitCode = 1;
  }
  try {
    await shutdownRedis();
  } catch (err) {
    console.error('Error closing Redis:', err);
    exitCode = 1;
  }
  const serverClosed = new Promise<void>((resolve) =>
    server.close(() => resolve()),
  );
  server.closeAllConnections();
  await serverClosed;
  await Promise.all([shutdownMetrics(), shutdownSentry()]);
  process.exit(exitCode);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

/**
 * Execute a single crawl cycle: enqueue due pages and live articles.
 * The loop records the tick time separately, so /healthz tracks loop
 * liveness rather than whether a tick succeeded.
 */
async function tick() {
  const counts = await runTick(publisherList);
  count('crawl.tick.enqueued', counts.pages, { kind: 'page' });
  count('crawl.tick.enqueued', counts.liveArticles, { kind: 'live_article' });
  console.log(
    `tick enqueued ${counts.pages} pages, ` +
      `${counts.liveArticles} live articles`,
  );
}

// tick() wrapped to report its errors to Sentry with startedAt context.
const tickWithSentry = withSentryHandler<{ startedAt: string }>(
  ({ startedAt }) => ({ context: { startedAt } }),
  tick,
);

/**
 * Re-read live articles from the Corpus API and swap them into the
 * publisher list. Throws on failure so the caller keeps the last good
 * list rather than dropping live articles; a transient Corpus outage
 * degrades freshness, not availability.
 */
async function refreshLiveArticles() {
  publisherList.live_articles = await fetchLiveArticles();
  lastCorpusRefreshAt = Date.now();
  console.log(
    `Refreshed ${publisherList.live_articles.length} live articles from Corpus`,
  );
}

const refreshWithSentry = withSentryHandler<{ startedAt: string }>(
  ({ startedAt }) => ({ context: { startedAt, kind: 'corpus-refresh' } }),
  refreshLiveArticles,
);

/**
 * Run the tick loop at the configured interval until the process is
 * signalled to stop.
 */
async function run() {
  while (isRunning()) {
    const start = Date.now();
    const startedAt = new Date(start).toISOString();
    if (
      corpusSourceEnabled() &&
      start - lastCorpusRefreshAt >= config.corpusRefreshMinutes * 60_000
    ) {
      try {
        await refreshWithSentry({ startedAt });
      } catch (err) {
        // Keep the last good list and retry next tick; the wrapper
        // already reported the failure to Sentry.
        console.error('Corpus refresh failed; keeping last list:', err);
      }
    }
    try {
      await tickWithSentry({ startedAt });
    } catch (err) {
      // tickWithSentry already captured the error and rethrew so the
      // loop sees it; swallowing here keeps a single failed tick from
      // killing the agent.
      console.error('tick failed:', err);
    }
    // Mark the loop alive even on a failed tick: /healthz should detect
    // a wedged loop, not a transient Pub/Sub or Redis outage that a
    // restart would not fix and that Sentry already surfaces.
    setLastTickAt(Date.now());
    const elapsed = Date.now() - start;
    timing('crawl.tick.duration_ms', elapsed);
    const remainingMs = Math.max(0, config.tickIntervalMs - elapsed);
    try {
      await delay(remainingMs, undefined, { signal: ac.signal });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') break;
      throw err;
    }
  }
}

/**
 * Initialize the Pub/Sub and Redis clients, load the publisher list,
 * then start the tick loop. Any failure here aborts startup. When
 * crawling is disabled (the dev sandbox) it serves health checks only.
 */
async function start() {
  // The agent is the sole origin of crawl jobs, so skipping the tick
  // loop here stops the whole pipeline at the source without touching
  // the workers (they idle with nothing to consume).
  if (!config.crawlEnabled) {
    console.log(
      'crawl-agent: scheduled crawling disabled, serving health only',
    );
    return;
  }
  initPubSubClient({
    projectId: config.projectId,
    apiEndpoint: config.pubsubEmulatorHost,
    useEmulator: Boolean(config.pubsubEmulatorHost),
  });
  initRedisClient({ host: config.redisHost, port: config.redisPort });
  publisherList = await loadPublisherList(config.publisherListPath);
  const useCorpus = corpusSourceEnabled();
  if (useCorpus) {
    await initCorpusApiClient({
      ...config.corpusApi,
      clientName: config.service,
    });
    // First load fails fast: a misconfigured or unauthorized Corpus
    // client should abort startup, not run a degraded agent.
    await refreshLiveArticles();
  }
  const liveSource = useCorpus
    ? `Corpus: ${config.scheduledSurfaceGuids.join(', ')}`
    : 'from file';
  console.log(
    `Loaded ${publisherList.pages.length} pages, ` +
      `${publisherList.live_articles.length} live articles (${liveSource})`,
  );
  await run();
}

start().catch((err) => {
  console.error('agent startup failed:', err);
  process.exit(1);
});
