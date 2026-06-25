import { randomUUID } from 'node:crypto';
import {
  publishMessage,
  sentryPubSubErrorHandler,
  startSubscriber,
  validateCrawlArticleDiscoveryMessage,
  type ArticleDiscoveryEvent,
  type CrawlArticleDiscoveryMessage,
  type CrawlArticleMessage,
} from 'crawl-common';
import { withSentryHandler } from 'sentry';
import config from './config.js';
import { handleArticleDiscovery } from './handlers/extract-discovery.js';

/**
 * Discover a page's articles and publish the results: one event to
 * the article-discoveries topic per discovered article and context,
 * and one crawl-article job per unique article URL. Publishing lives
 * inside the handler so a failure to extract or publish throws, which
 * nacks the message for redelivery. Delivery is at-least-once, so
 * duplicates from a redelivery are tolerated downstream.
 */
async function discoverAndPublish(
  message: CrawlArticleDiscoveryMessage,
): Promise<void> {
  const { events, articleUrls } = await handleArticleDiscovery(message);
  await Promise.all([
    ...events.map((event) =>
      publishMessage<ArticleDiscoveryEvent>(
        config.articleDiscoveriesTopic,
        event,
      ),
    ),
    ...articleUrls.map((url) =>
      publishMessage<CrawlArticleMessage>(
        config.crawlArticleTopic,
        buildCrawlArticleJob(url, message.url),
      ),
    ),
  ]);
}

/**
 * Build a crawl-article job for a discovered article. Discovered
 * articles carry no corpus_item; that is present only on live
 * articles the agent enqueues. Each job gets a fresh crawl_id so
 * the extraction can be traced back to this discovery.
 */
function buildCrawlArticleJob(
  url: string,
  sourceUrl: string,
): CrawlArticleMessage {
  return {
    url,
    source_url: sourceUrl,
    crawl_id: randomUUID(),
    enqueued_at: new Date().toISOString(),
  };
}

/**
 * Wrap discoverAndPublish so any error it throws reaches Sentry with
 * the page job's identifying fields attached. worker_role
 * distinguishes this worker from the article worker.
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
  discoverAndPublish,
);

/** Start consuming jobs from the crawl-article-discovery subscription. */
export function startDiscoveryConsumer(): void {
  startSubscriber<CrawlArticleDiscoveryMessage>({
    subscriptionName: config.crawlArticleDiscoverySubscription,
    maxExtensionSeconds: config.maxExtensionSeconds,
    validate: validateCrawlArticleDiscoveryMessage,
    handler: handleMessage,
    onError: sentryPubSubErrorHandler(config.crawlArticleDiscoverySubscription),
  });
}
