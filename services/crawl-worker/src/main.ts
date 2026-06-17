// Initialize Sentry first to capture errors from other modules.
import './sentry-init.js';

import {
  initCorpusApiClient,
  initPubSubClient,
  initZyteClient,
  shutdownPubSub,
} from 'crawl-common';
import { shutdownSentry } from 'sentry';
import { startArticleConsumer } from './article-consumer.js';
import { app } from './app.js';
import config from './config.js';

const server = app.listen(config.port, () => {
  console.log(`crawl-worker listening on port ${config.port}`);
});

/**
 * Initialize the API clients, then start consuming crawl-article
 * jobs. Zyte and Pub/Sub are always required; the Corpus API client
 * is only needed for live articles (see the initCorpusApi helper).
 */
async function start() {
  initZyteClient({ apiKey: config.zyteApiKey });
  await initCorpusApi();

  initPubSubClient({
    projectId: config.projectId,
    apiEndpoint: config.pubsubEmulatorHost,
    useEmulator: Boolean(config.pubsubEmulatorHost),
  });

  startArticleConsumer();
  console.log(
    `crawl-worker consuming ${config.crawlArticleSubscription}, ` +
      `publishing to ${config.articlesTopic}`,
  );
}

/**
 * Initialize the Corpus API client, which syncs live articles. Its
 * four settings are required together, so a partial set fails fast.
 * When none are set, skip it so local runs can still process
 * articles without a corpus_item.
 */
async function initCorpusApi() {
  const { endpoint, jwkJson, issuer, audience } = config.corpusApi;
  const values = [endpoint, jwkJson, issuer, audience];
  if (values.every((v) => v === '')) {
    console.warn('Corpus API not configured; live-article sync disabled');
    return;
  }
  if (values.some((v) => v === '')) {
    throw new Error(
      'Corpus API is partially configured; set all CORPUS_API_* vars or none',
    );
  }
  await initCorpusApiClient({ endpoint, jwkJson, issuer, audience });
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
  // Stop accepting connections, then force-close any that remain (this
  // server only handles health probes) so close() resolves promptly
  // instead of waiting on a keep-alive socket.
  const serverClosed = new Promise<void>((resolve) =>
    server.close(() => resolve()),
  );
  server.closeAllConnections();
  await serverClosed;
  await shutdownSentry();
  process.exit(exitCode);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
