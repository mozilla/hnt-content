import {
  validateCrawlArticleDiscoveryMessage,
  type CrawlArticleDiscoveryMessage,
} from 'crawl-common';
import { sentryPubSubErrorHandler, startSubscriber } from 'pubsub';
import { withSentryHandler } from 'sentry';
import config from './config.js';
import { withMessageMetrics } from './message-metrics.js';
import { processDiscovery } from './process-discovery.js';

/**
 * Wrap processDiscovery so any error it throws reaches Sentry with the
 * page job's identifying fields attached. worker_role distinguishes
 * this worker from the article worker.
 */
const handleMessage = withSentryHandler<CrawlArticleDiscoveryMessage>(
  (message) => ({
    tags: { worker_role: config.workerRole },
    context: {
      url: message.url,
      interval_minutes: message.interval_minutes,
      context_count: message.contexts.length,
    },
  }),
  withMessageMetrics(processDiscovery),
);

/** Start consuming jobs from the crawl-article-discovery subscription. */
export function startDiscoveryConsumer(): void {
  startSubscriber<CrawlArticleDiscoveryMessage>({
    subscriptionName: config.crawlArticleDiscoverySubscription,
    maxExtensionSeconds: config.maxExtensionSeconds,
    maxMessages: config.pubsubMaxMessages,
    validate: validateCrawlArticleDiscoveryMessage,
    handler: handleMessage,
    onError: sentryPubSubErrorHandler(config.crawlArticleDiscoverySubscription),
  });
}
