import {
  getRegistrableDomain,
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
    tags: {
      worker_role: config.workerRole,
      // url and domain are searchable tags so failures can be filtered
      // by publisher. Sentry truncates tag values at 200 characters,
      // which is acceptable for a URL.
      url: message.url,
      domain: getRegistrableDomain(message.url),
      // A discovery job carries one topic per context. Join the
      // distinct topics in sorted order so the tag stays stable and
      // searchable.
      topic: [...new Set(message.contexts.map((c) => c.topic))]
        .sort()
        .join(','),
    },
    context: {
      interval_minutes: message.interval_minutes,
      context_count: message.contexts.length,
      // A discovery job carries one surface per context, so report the
      // distinct surfaces.
      surface_ids: [...new Set(message.contexts.map((c) => c.surface_id))],
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
