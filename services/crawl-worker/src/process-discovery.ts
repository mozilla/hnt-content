import { randomUUID } from 'node:crypto';
import {
  acquireLock,
  articleFetchKey,
  pageFetchKey,
  pageLockKey,
  publishMessage,
  releaseLock,
  setTimestamp,
  type ArticleDiscoveryEvent,
  type CrawlArticleDiscoveryMessage,
  type CrawlArticleMessage,
} from 'crawl-common';
import config from './config.js';
import { handleArticleDiscovery } from './handlers/extract-discovery.js';
import type { MessageOutcome } from './message-metrics.js';
import { withinMinutes } from './recency.js';

/**
 * Discover a page's articles and publish the results, guarded by Redis:
 * - Skip the page if it was crawled within its interval.
 * - A per-page lock prevents two workers crawling the same page at
 *   once; a held lock means another worker has it, so we skip.
 * - Publish a discovery event for every article and context, but
 *   enqueue a crawl-article job only for articles not fetched recently.
 *
 * Skips ack the message; only a thrown error nacks for redelivery.
 */
export async function processDiscovery(
  message: CrawlArticleDiscoveryMessage,
): Promise<MessageOutcome> {
  const fetchKey = pageFetchKey(message.url);
  if (await withinMinutes(fetchKey, message.interval_minutes)) return 'skipped';

  const lockKey = pageLockKey(message.url);
  const token = await acquireLock(lockKey, config.lockTtlSeconds);
  if (token === null) return 'skipped';
  try {
    const { events, articleUrls } = await handleArticleDiscovery(message);
    // Discovery events and crawl-article jobs are independent, so
    // publish them together to keep the page lock held briefly. The
    // page marker is set only after both succeed, so a failed publish
    // retries rather than being suppressed.
    await Promise.all([
      ...events.map((event) =>
        publishMessage<ArticleDiscoveryEvent>(
          config.articleDiscoveriesTopic,
          event,
        ),
      ),
      enqueueUnfetchedArticles(articleUrls, message.url),
    ]);
    await setTimestamp(fetchKey);
    return 'processed';
  } finally {
    await releaseLock(lockKey, token);
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
 * extraction can be traced back to this discovery.
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
