import { randomUUID } from 'node:crypto';
import {
  articleFetchKey,
  pageFetchKey,
  pageLockKey,
  type ArticleDiscoveryEvent,
  type CrawlArticleDiscoveryMessage,
  type CrawlArticleMessage,
} from 'crawl-common';
import { publishMessage } from 'pubsub';
import { acquireLock, releaseLock, setTimestamp } from 'redis-state';
import config from './config.js';
import { handleArticleDiscovery } from './handlers/extract-discovery.js';
import type { HandlerResult } from './message-metrics.js';
import { withinMinutes } from './recency.js';

/**
 * Discover a page's articles and publish the results, guarded by Redis:
 * - Skip the page if it was crawled within its interval.
 * - A per-page lock prevents two workers crawling the same page at
 *   once; a held lock means another worker has it, so we skip.
 * - The page marker is written as a claim, before the Zyte call and the
 *   publish fan-out, so a partial failure (a failed publish, ack-deadline
 *   expiry, crash mid-handler) redelivers into a skip instead of
 *   re-paying for Zyte and re-emitting the events and jobs. A publish
 *   failure still nacks, but the redelivery now skips: that interval's
 *   missing rows self-heal on the next crawl, the accepted 99.9%
 *   tradeoff.
 * - Publish a discovery event for every article and context, but
 *   enqueue a crawl-article job only for articles not fetched recently.
 *
 * Skips ack the message; only a thrown error nacks for redelivery.
 */
export async function processDiscovery(
  message: CrawlArticleDiscoveryMessage,
): Promise<HandlerResult> {
  const fetchKey = pageFetchKey(message.url);
  if (await withinMinutes(fetchKey, message.interval_minutes)) {
    return { outcome: 'skipped', reason: 'recent' };
  }

  const lockKey = pageLockKey(message.url);
  const token = await acquireLock(lockKey, config.lockTtlSeconds);
  if (token === null) return { outcome: 'skipped', reason: 'lock_busy' };
  try {
    // Re-check page:fetch inside the lock. Concurrent duplicate jobs all
    // pass the pre-lock freshness check, then serialize through the lock;
    // without re-reading the marker here each would re-crawl the page. The
    // first crawl claims page:fetch, so the rest now skip.
    if (await withinMinutes(fetchKey, message.interval_minutes)) {
      return { outcome: 'skipped', reason: 'recent' };
    }
    // Claim the interval before the Zyte call and publish fan-out so a
    // partial failure redelivers into a skip (see the doc block).
    await setTimestamp(fetchKey);
    const { events, articleUrls } = await handleArticleDiscovery(message);
    // Discovery events and crawl-article jobs are independent, so
    // publish them together to keep the page lock held briefly.
    await Promise.all([
      ...events.map((event) =>
        publishMessage<ArticleDiscoveryEvent>(
          config.articleDiscoveriesTopic,
          event,
        ),
      ),
      enqueueUnfetchedArticles(articleUrls, message.url),
    ]);
    return { outcome: 'processed' };
  } finally {
    // Best-effort: the lock self-expires on its TTL, so a release
    // failure must not propagate out of finally and mask the handler's
    // outcome, which would nack a successful message and redeliver it.
    await releaseLock(lockKey, token).catch((err) =>
      console.error('failed to release lock', lockKey, err),
    );
  }
}

/**
 * Publish a crawl-article job for each article URL not fetched within
 * the re-fetch window, skipping ones already crawled recently.
 */
async function enqueueUnfetchedArticles(
  urls: string[],
  sourceUrl: string,
): Promise<void> {
  await Promise.all(
    urls.map(async (url) => {
      if (
        await withinMinutes(articleFetchKey(url), config.articleFetchTtlMinutes)
      ) {
        return;
      }
      await publishMessage<CrawlArticleMessage>(
        config.crawlArticleTopic,
        buildCrawlArticleJob(url, sourceUrl),
      );
    }),
  );
}

/**
 * Build a crawl-article job for a discovered article. Discovered
 * articles carry no corpus_item; each job gets a fresh crawl_id so the
 * extraction can be traced back to this discovery, and the default fetch
 * TTL as its refresh window so the worker dedups on the same cadence.
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
    refresh_interval_minutes: config.articleFetchTtlMinutes,
  };
}
