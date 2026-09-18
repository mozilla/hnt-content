import { randomUUID } from 'node:crypto';
import {
  crawlConfig,
  getScheduledSectionItems,
  type CrawlArticleMessage,
  type LiveArticle,
} from 'crawl-common';
import { publishMessage } from 'pubsub';
import config from './config.js';

/**
 * Enqueue a capped batch of the live articles scheduled on New Tab for
 * re-extraction, and return how many jobs went out.
 */
export async function enqueueLiveArticles(): Promise<number> {
  if (!config.liveArticlesPerTick) {
    return 0;
  }

  // We refresh only the en-US surface, as the legacy pipeline did. We
  // do not know whether that is still what editorial wants; HNT-2426
  // tracks the question.
  const liveArticles = await getScheduledSectionItems('NEW_TAB_EN_US');
  const batch = randomBatch(liveArticles);
  await Promise.all(batch.map(publishCrawlJob));

  return batch.length;
}

/**
 * Pick at most `liveArticlesPerTick` of the articles at random. This
 * runs in non-prod environments for now, where a random subset is the
 * simplest way to limit how many Zyte requests we make.
 */
function randomBatch(liveArticles: LiveArticle[]): LiveArticle[] {
  return liveArticles
    .map((article) => ({ article, order: Math.random() }))
    .sort((a, b) => a.order - b.order)
    .slice(0, config.liveArticlesPerTick)
    .map(({ article }) => article);
}

/**
 * Publish one crawl-article job for a live article. `source_url` is the
 * article itself because no publisher page led the crawler here, and
 * `corpus_item` rides along so the worker can correct a curated
 * headline or excerpt that the publisher has since revised.
 */
async function publishCrawlJob(article: LiveArticle): Promise<void> {
  const message: CrawlArticleMessage = {
    url: article.url,
    source_url: article.url,
    crawl_id: randomUUID(),
    enqueued_at: new Date().toISOString(),
    article_refresh_minutes: config.liveArticleRefreshMinutes,
    corpus_item: article.corpus_item,
  };
  await publishMessage(crawlConfig.crawlArticleTopic, message);
}
