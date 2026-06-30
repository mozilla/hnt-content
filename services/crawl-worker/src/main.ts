// Initialize Sentry and metrics first to capture from other modules.
import './sentry-init.js';
import './metrics-init.js';
import { initCorpusApiClient } from 'crawl-common';
import { initPubSubClient, shutdownPubSub } from 'pubsub';
import { initRedisClient, shutdownRedis } from 'redis-state';
import { initZyteClient } from 'zyte';
import { incr, shutdownMetrics } from 'metrics';
import { shutdownSentry } from 'sentry';
import { startArticleConsumer } from './article-consumer.js';
import { startDiscoveryConsumer } from './discovery-consumer.js';
import { awaitZyteToken } from './zyte-rate-limit.js';
import { app } from './app.js';
import config from './config.js';

const server = app.listen(config.port, () => {
  console.log(`crawl-worker listening on port ${config.port}`);
});

/**
 * Initialize the API clients, then start the consumer for this
 * pod's worker role. Zyte and Pub/Sub are needed by both roles; the
 * Corpus API client is only used by the article worker for
 * live-article sync (see the initCorpusApi helper).
 */
async function start() {
  const role = config.workerRole;
  // Fail fast rather than run as an unset or unsupported role.
  if (role !== 'article' && role !== 'discovery') {
    throw new Error(
      `WORKER_ROLE must be 'article' or 'discovery' (got '${role}')`,
    );
  }

  initZyteClient({
    apiKey: config.zyteApiKey,
    // Gate Zyte calls through the shared Redis rate limiter when one
    // is configured; awaitZyteToken no-ops when it is disabled.
    ...(config.zyteRateLimitPerMinute > 0 && { beforeRequest: awaitZyteToken }),
    onRetry: () => incr('crawl.zyte.retries'),
  });
  initPubSubClient({
    projectId: config.projectId,
    apiEndpoint: config.pubsubEmulatorHost,
    useEmulator: Boolean(config.pubsubEmulatorHost),
  });
  // Both roles use Redis for fetch/lock/content dedup state.
  initRedisClient({ host: config.redisHost, port: config.redisPort });

  if (role === 'article') {
    await initCorpusApi();
    startArticleConsumer();
    console.log(
      `crawl-worker consuming ${config.crawlArticleSubscription}, ` +
        `publishing to ${config.articlesTopic}`,
    );
  } else {
    startDiscoveryConsumer();
    console.log(
      `crawl-worker consuming ${config.crawlArticleDiscoverySubscription}, ` +
        `publishing to ${config.articleDiscoveriesTopic} and ` +
        `${config.crawlArticleTopic}`,
    );
  }
}

/**
 * Initialize the Corpus API client, which syncs live articles. The
 * endpoint, issuer, and audience have app defaults, so the JWK key is
 * the only required input and the thing that gates the sync. When it
 * is absent, skip the client so local runs that only process
 * articles without a corpus_item still work.
 */
async function initCorpusApi() {
  if (!config.corpusApi.jwkJson) {
    console.warn('Corpus API key not set; live-article sync disabled');
    return;
  }
  await initCorpusApiClient(config.corpusApi);
}

start().catch((err) => {
  console.error('worker startup failed:', err);
  process.exit(1);
});

// Allows the Pub/Sub drain (crawl-common's 25s SHUTDOWN_TIMEOUT_SECONDS)
// plus topic flush, client close, and Sentry flush to finish within
// K8s's 30s grace period. Keep this above that drain timeout.
const SHUTDOWN_TIMEOUT_MS = 28_000;

let shuttingDown = false;
/**
 * Initiate graceful shutdown: drain in-flight Pub/Sub messages and
 * flush pending publishes, close the server, flush Sentry, and
 * force-exit after a timeout. K8s sends SIGTERM before pod
 * termination; draining first prevents duplicate message processing
 * and lost article events.
 */
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  process.removeListener('SIGTERM', shutdown);
  process.removeListener('SIGINT', shutdown);
  console.log('Shutting down');

  const forceExit = setTimeout(() => {
    console.error(`Forced exit after ${SHUTDOWN_TIMEOUT_MS}ms timeout`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  // Drain Pub/Sub first so errors captured while handlers finish are
  // sent when Sentry is flushed below. Log a drain failure but keep
  // going, so the flush always runs.
  let exitCode = 0;
  try {
    await shutdownPubSub();
  } catch (err) {
    console.error('Error draining Pub/Sub:', err);
    exitCode = 1;
  }
  // Close Redis after the Pub/Sub drain, since in-flight handlers use it.
  try {
    await shutdownRedis();
  } catch (err) {
    console.error('Error closing Redis:', err);
    exitCode = 1;
  }
  // Stop accepting connections, then force-close any that remain (this
  // server only handles health probes) so close() resolves promptly
  // instead of waiting on a keep-alive socket.
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
