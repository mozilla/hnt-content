import { createHash } from 'node:crypto';
import {
  crawlConfig,
  buildRedisArticleContentKey,
  buildRedisArticleExtractedKey,
  buildRedisArticleLockKey,
  type ArticleEvent,
  type CrawlArticleMessage,
} from 'crawl-common';
import {
  publishMessage,
  sentryPubSubErrorHandler,
  startSubscriber,
} from 'pubsub';
import {
  acquireRedisKeyLockToken,
  getRedisKeyTimestampValue,
  getString,
  releaseRedisKeyLock,
  setRedisKeyTimestampWithTTL,
  setString,
} from 'redis-state';
import { withSentryHandler } from 'sentry';
import config from './config.js';
import { isWithinMinutes } from './discovery-consumer.js';
import { handleArticleExtraction } from './handlers/extract-article.js';

/**
 * Extract one article and publish it as an `articles` event if eligible
 * and changed. An article extracted within `article_refresh_minutes` or
 * locked by another worker is skipped and acked.
 *
 * The `article:extracted` marker is claimed for `articleAttemptTtlMinutes`
 * before the Zyte call, then rewritten for the full refresh window once
 * the work is done. A recoverable failure throws and leaves only the
 * claim, so redeliveries skip until it expires; see DEDUPLICATION.md.
 */
async function handleMessage(message: CrawlArticleMessage): Promise<void> {
  const extractedKey = buildRedisArticleExtractedKey(message.url);
  const refreshMinutes = message.article_refresh_minutes;

  if (
    isWithinMinutes(
      await getRedisKeyTimestampValue(extractedKey),
      refreshMinutes,
    )
  ) {
    return;
  }

  const lockKey = buildRedisArticleLockKey(message.url);
  const lockToken = await acquireRedisKeyLockToken(
    lockKey,
    config.lockTtlSeconds,
  );

  // A null token means another worker has the lock.
  if (lockToken === null) {
    return;
  }

  try {
    // Duplicate jobs can pass the check above and wait for the lock.
    // Check the marker again in case the first job already claimed it.
    if (
      isWithinMinutes(
        await getRedisKeyTimestampValue(extractedKey),
        refreshMinutes,
      )
    ) {
      return;
    }

    await setRedisKeyTimestampWithTTL(
      extractedKey,
      config.articleAttemptTtlMinutes * 60,
    );

    // An undefined event is a permanent failure (e.g. a 404), so it is
    // confirmed below like a success rather than retried.
    const event = await handleArticleExtraction(message);
    if (event) {
      await publishIfChanged(event);
    }

    await setRedisKeyTimestampWithTTL(extractedKey, refreshMinutes * 60);
  } finally {
    // The lock expires automatically, so a release failure should not
    // cause an already handled message to be nacked.
    await releaseRedisKeyLock(lockKey, lockToken).catch((err) =>
      console.error('failed to release lock', lockKey, err),
    );
  }
}

/**
 * Publish the event only if its content changed since the last
 * extraction. Publishing before storing the hash means a failed store
 * redelivers into a duplicate rather than a lost event.
 */
async function publishIfChanged(event: ArticleEvent): Promise<void> {
  const contentKey = buildRedisArticleContentKey(event.url);
  const hash = contentHash(event);

  if ((await getString(contentKey)) !== hash) {
    await publishMessage(crawlConfig.articlesTopic, event);
  }

  // Store the hash on every extraction so its TTL keeps pace with the
  // marker; otherwise an unchanged article's hash expires and the next
  // extraction republishes it.
  await setString(contentKey, hash);
}

/**
 * Hash the content columns of `crawl.articles`. url is constant per key
 * and extracted_at changes on every extraction, so both are excluded.
 */
function contentHash(event: ArticleEvent): string {
  const content = {
    canonical_url: event.canonical_url,
    headline: event.headline,
    description: event.description,
    authors: event.authors,
    main_image_url: event.main_image_url,
    body_truncated: event.body_truncated,
    published_at: event.published_at,
    breadcrumbs: event.breadcrumbs,
    language: event.language,
  };
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

// A thrown error is captured with the job's identifying fields, then
// rethrown so the subscriber nacks the message for redelivery.
const handleWithSentry = withSentryHandler<CrawlArticleMessage>(
  (message) => ({
    tags: {
      worker_role: 'article',
      has_corpus_item: String(message.corpus_item != null),
    },
    context: {
      url: message.url,
      crawl_id: message.crawl_id,
      source_url: message.source_url,
    },
  }),
  handleMessage,
);

/**
 * Start consuming `crawl-article` jobs. `shutdownPubSub()` drains and
 * stops the subscriber, so no controller is kept here.
 */
export function startArticleConsumer(): void {
  startSubscriber<CrawlArticleMessage>({
    subscriptionName: crawlConfig.crawlArticleSubscription,
    maxExtensionSeconds: config.maxExtensionSeconds,
    maxMessages: config.maxMessages,
    handler: handleWithSentry,
    onError: sentryPubSubErrorHandler(crawlConfig.crawlArticleSubscription),
  });
}
