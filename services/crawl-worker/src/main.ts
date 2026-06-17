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
 * jobs. Zyte and Pub/Sub are always required. The Corpus API client
 * is only used to sync live articles, so it is skipped when its
 * credentials are absent, e.g. local runs that only process
 * discovered articles.
 */
async function start() {
  initZyteClient({ apiKey: config.zyteApiKey });

  if (config.corpusApi.jwkJson) {
    await initCorpusApiClient({
      endpoint: config.corpusApi.endpoint,
      jwkJson: config.corpusApi.jwkJson,
      issuer: config.corpusApi.issuer,
      audience: config.corpusApi.audience,
    });
  } else {
    console.warn('Corpus API not configured; live-article sync disabled');
  }

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

start().catch((err) => {
  console.error('worker startup failed:', err);
  process.exit(1);
});

// Allows the Pub/Sub drain (up to 25s) plus topic flush, client
// close, and Sentry flush to finish within K8s's 30s grace period.
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

  try {
    await shutdownPubSub();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await shutdownSentry();
    process.exit(0);
  } catch (err) {
    console.error('Error during shutdown:', err);
    process.exit(1);
  }
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
