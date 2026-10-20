import { randomUUID } from 'node:crypto';
import {
  crawlConfig,
  buildRedisPageFetchKey,
  buildRedisPageLockKey,
  type CrawlArticleDiscoveryMessage,
  type CrawlArticleMessage,
} from 'crawl-common';
import {
  publishMessage,
  sentryPubSubErrorHandler,
  startSubscriber,
} from 'pubsub';
import {
  acquireRedisKeyLockToken,
  releaseRedisKeyLock,
  setRedisKeyTimestampWithTTL,
  getRedisKeyTimestampValue,
} from 'redis-state';
import { withSentryHandler } from 'sentry';
import config from './config.js';
import { handleArticleDiscovery } from './handlers/extract-discovery.js';

const MINUTES_PER_DAY = 1440;
const MIN_PAGE_REFRESH_MINUTES =
  crawlConfig.pageRefreshMinutes * config.minPageRefreshFraction;

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
 * Return whether the fetch/crawl marker at key was set within the last
 * `minutes`, so the worker can skip a page or article it processed
 * recently.
 */
export function isWithinMinutes(
  timeStampValue: number | null,
  refreshMinutesLimit: number,
): boolean {
  return (
    timeStampValue !== null &&
    Date.now() - timeStampValue < refreshMinutesLimit * 60_000
  );
}

/**
 * Discover a page's articles, publish one `article-discoveries` event
 * per article and context, and enqueue a `crawl-article` job for each
 * unique article URL not extracted recently. A page crawled within its
 * duplicate window or locked by another worker is skipped and acked.
 *
 * The `page:fetch` marker is claimed before the Zyte call, so a partial
 * failure (a failed publish, a crash) redelivers into a skip rather than
 * a second paid crawl. The missing rows return on the next crawl.
 */
async function handleMessage(
  message: CrawlArticleDiscoveryMessage,
): Promise<void> {
  const pageFetchKey = buildRedisPageFetchKey(message.url);

  if (
    isWithinMinutes(
      await getRedisKeyTimestampValue(pageFetchKey),
      MIN_PAGE_REFRESH_MINUTES,
    )
  ) {
    return;
  }

  const pageLockKey = buildRedisPageLockKey(message.url);
  const lockToken = await acquireRedisKeyLockToken(
    pageLockKey,
    config.lockTtlSeconds,
  );

  // A null token means another worker has the lock.
  if (lockToken === null) {
    return;
  }

  try {
    // Duplicate requests can pass the check above and wait for the lock.
    // Check the marker again in case the first request already claimed it.
    if (
      isWithinMinutes(
        await getRedisKeyTimestampValue(pageFetchKey),
        MIN_PAGE_REFRESH_MINUTES,
      )
    ) {
      return;
    }

    // Set the current time stamp as a value for this redis key.
    // Also sets a TTL for this which is the default (30 days) if not provided as an argument.
    await setRedisKeyTimestampWithTTL(pageFetchKey);

    const { events, articleUrls } = await handleArticleDiscovery(message);

    // Events and jobs go to different topics and neither depends on the
    // other, so publish them together to hold the lock briefly.
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
  } finally {
    // The lock expires automatically, so a release failure should not
    // cause an already handled message to be nacked.
    await releaseRedisKeyLock(pageLockKey, lockToken).catch((err) =>
      console.error('failed to release lock', pageLockKey, err),
    );
  }
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
