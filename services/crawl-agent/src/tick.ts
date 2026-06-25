import { randomUUID } from 'node:crypto';
import {
  articleEnqueuedKey,
  getTimestamp,
  pageEnqueuedKey,
  publishMessage,
  setTimestamp,
  type CrawlArticleDiscoveryMessage,
  type CrawlArticleMessage,
  type LiveArticle,
  type PublisherList,
} from 'crawl-common';
import config from './config.js';

/** Number of jobs enqueued in a tick, for logging. */
export interface TickCounts {
  pages: number;
  liveArticles: number;
}

/**
 * Enqueue crawl jobs for every page and live article whose crawl
 * interval has elapsed since it was last enqueued. The agent is
 * single-replica, so a plain check-then-set on the Redis enqueue
 * marker is enough to avoid re-enqueuing the same item too soon.
 */
export async function runTick(list: PublisherList): Promise<TickCounts> {
  const [pageResults, articleResults] = await Promise.all([
    Promise.all(list.pages.map(enqueuePageIfDue)),
    Promise.all(list.live_articles.map(enqueueLiveArticleIfDue)),
  ]);
  return {
    pages: pageResults.filter(Boolean).length,
    liveArticles: articleResults.filter(Boolean).length,
  };
}

/**
 * Publish a discovery job for a page unless it was enqueued within
 * its interval. Publishes before marking so a failed publish retries
 * next tick rather than being suppressed by the marker.
 */
async function enqueuePageIfDue(
  page: CrawlArticleDiscoveryMessage,
): Promise<boolean> {
  const key = pageEnqueuedKey(page.url);
  if (await enqueuedWithin(key, page.interval_minutes)) return false;
  await publishMessage<CrawlArticleDiscoveryMessage>(
    config.crawlArticleDiscoveryTopic,
    page,
  );
  await setTimestamp(key);
  return true;
}

/**
 * Publish a crawl-article job for a live article unless it was
 * enqueued within the live-article interval. The job carries the
 * corpus_item so the worker can sync curated metadata; source_url is
 * the article itself, since there is no discovery page.
 */
async function enqueueLiveArticleIfDue(article: LiveArticle): Promise<boolean> {
  const key = articleEnqueuedKey(article.url);
  if (await enqueuedWithin(key, config.liveArticleIntervalMinutes)) {
    return false;
  }
  const message: CrawlArticleMessage = {
    url: article.url,
    source_url: article.url,
    crawl_id: randomUUID(),
    enqueued_at: new Date().toISOString(),
    corpus_item: article.corpus_item,
  };
  await publishMessage<CrawlArticleMessage>(config.crawlArticleTopic, message);
  await setTimestamp(key);
  return true;
}

/**
 * Return whether the enqueue marker at key was set within the last
 * intervalMinutes. Comparing the stored timestamp rather than encoding
 * the window in a TTL keeps the cadence exact and independent of the
 * tick interval, even for short intervals.
 */
async function enqueuedWithin(
  key: string,
  intervalMinutes: number,
): Promise<boolean> {
  const lastEnqueuedAt = await getTimestamp(key);
  return (
    lastEnqueuedAt !== null &&
    Date.now() - lastEnqueuedAt < intervalMinutes * 60_000
  );
}
