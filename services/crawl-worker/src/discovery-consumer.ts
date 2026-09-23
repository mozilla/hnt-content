import { randomUUID } from 'node:crypto';
import {
  articleExtractedKey,
  crawlConfig,
  pageFetchKey,
  pageLockKey,
  type CrawlArticleDiscoveryMessage,
  type CrawlArticleMessage,
} from 'crawl-common';
import {
  publishMessage,
  sentryPubSubErrorHandler,
  startSubscriber,
} from 'pubsub';
import { acquireLock, releaseLock, setTimestamp } from 'redis-state';
import { withSentryHandler } from 'sentry';
import config from './config.js';
import { handleArticleDiscovery } from './handlers/extract-discovery.js';
import { withinMinutes } from './recency.js';

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
 * per article and context, and enqueue a `crawl-article` job for each
 * unique article URL not extracted recently. A page crawled within
 * `pageRefreshMinutes` or locked by another worker is skipped and acked.
 *
 * The `page:fetch` marker is claimed before the Zyte call, so a partial
 * failure (a failed publish, a crash) redelivers into a skip rather than
 * a second paid crawl. The missing rows return on the next crawl.
 */
async function handleMessage(
  message: CrawlArticleDiscoveryMessage,
): Promise<void> {
  const fetchKey = pageFetchKey(message.url);
  if (await withinMinutes(fetchKey, config.pageRefreshMinutes)) {
    return;
  }

  const lockKey = pageLockKey(message.url);
  const token = await acquireLock(lockKey, config.lockTtlSeconds);
  if (token === null) {
    return;
  }

  try {
    // Concurrent duplicates all pass the check above and then queue on
    // the lock, so re-read the marker the first holder claimed.
    if (await withinMinutes(fetchKey, config.pageRefreshMinutes)) {
      return;
    }
    await setTimestamp(fetchKey);

    const { events, articleUrls } = await handleArticleDiscovery(message);

    // Events and jobs go to different topics and neither depends on the
    // other, so publish them together to hold the lock briefly.
    await Promise.all([
      ...events.map((event) =>
        publishMessage(crawlConfig.articleDiscoveriesTopic, event),
      ),
      ...articleUrls.map((url) => enqueueUnlessExtracted(url, message.url)),
    ]);
  } finally {
    // The lock expires on its own, so a failed release must not mask
    // the outcome and nack a message that was handled.
    await releaseLock(lockKey, token).catch((err) =>
      console.error('failed to release lock', lockKey, err),
    );
  }
}

/** Enqueue a discovered article unless it was extracted recently. */
async function enqueueUnlessExtracted(
  url: string,
  sourceUrl: string,
): Promise<void> {
  const refreshMinutes = config.discoveredArticleRefreshDays * MINUTES_PER_DAY;
  if (await withinMinutes(articleExtractedKey(url), refreshMinutes)) {
    return;
  }
  await publishMessage(
    crawlConfig.crawlArticleTopic,
    buildCrawlArticleJob(url, sourceUrl),
  );
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
