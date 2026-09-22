import { randomUUID } from 'node:crypto';
import {
  crawlConfig,
  type CrawlArticleDiscoveryMessage,
  type CrawlArticleMessage,
} from 'crawl-common';
import {
  publishMessage,
  sentryPubSubErrorHandler,
  startSubscriber,
} from 'pubsub';
import { withSentryHandler } from 'sentry';
import config from './config.js';
import { handleArticleDiscovery } from './handlers/extract-discovery.js';

const MINUTES_PER_DAY = 24 * 60;

/**
 * Build the crawl-article job for a discovered article. Unlike live items,
 * the refresh period is a long window measured in days, and newly
 * discovered articles don't have a corpus item. A
 * fresh crawl_id ties the extraction back to this page crawl.
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
    article_refresh_minutes:
      config.discoveredArticleRefreshDays * MINUTES_PER_DAY,
  };
}

/**
 * Discover a page's articles, publish one `article-discoveries` event
 * per article and context, and enqueue one `crawl-article` job per
 * unique article URL.
 */
async function handleMessage(
  message: CrawlArticleDiscoveryMessage,
): Promise<void> {
  const { events, articleUrls } = await handleArticleDiscovery(message);

  // Events and jobs go to different topics and neither depends on the
  // other, so publish them together.
  await Promise.all([
    ...events.map((event) =>
      publishMessage(crawlConfig.articleDiscoveriesTopic, event),
    ),
    ...articleUrls.map((url) =>
      publishMessage(
        crawlConfig.crawlArticleTopic,
        buildCrawlArticleJob(url, message.url),
      ),
    ),
  ]);
}

// A thrown error is captured with the page job's identifying fields,
// then rethrown so the subscriber nacks the message for redelivery.
const handleWithSentry = withSentryHandler<CrawlArticleDiscoveryMessage>(
  (message) => ({
    tags: { worker_role: 'discovery' },
    context: {
      url: message.url,
      // A page is crawled for one or more (surface, topic) pairs, and
      // they decide the events this job emits, so report all of them.
      contexts: message.contexts,
    },
  }),
  handleMessage,
);

/**
 * Start consuming `crawl-article-discovery` jobs. `shutdownPubSub()`
 * drains and stops the subscriber, so no controller is kept here.
 */
export function startDiscoveryConsumer(): void {
  startSubscriber<CrawlArticleDiscoveryMessage>({
    subscriptionName: crawlConfig.crawlArticleDiscoverySubscription,
    maxExtensionSeconds: config.maxExtensionSeconds,
    maxMessages: config.maxMessages,
    handler: handleWithSentry,
    onError: sentryPubSubErrorHandler(
      crawlConfig.crawlArticleDiscoverySubscription,
    ),
  });
}
