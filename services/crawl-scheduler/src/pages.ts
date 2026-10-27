import { createHash } from 'node:crypto';
import {
  crawlConfig,
  type CrawlArticleDiscoveryMessage,
  type PublisherList,
} from 'crawl-common';
import { publishMessage } from 'pubsub';
import config from './config.js';
import publishers from './data/publishers.json' with { type: 'json' };

const { pages }: PublisherList = publishers;

/**
 * Return the page's offset in minutes into the crawl interval, from a
 * hash of its URL. Offsets spread pages evenly across the interval, so
 * crawls do not reach Zyte all at once.
 */
export function pageOffset(url: string): number {
  const digest = createHash('sha256').update(url).digest();
  return digest.readUInt32BE(0) % crawlConfig.pageRefreshMinutes;
}

/**
 * Return the pages whose offset matches the given epoch minute, up to
 * `maxPagesPerTick`. A limit keeps the first due pages in list order, so
 * the same pages recur each interval.
 */
export function duePages(epochMinute: number): CrawlArticleDiscoveryMessage[] {
  return pages
    .filter(
      (page) =>
        pageOffset(page.url) === epochMinute % crawlConfig.pageRefreshMinutes,
    )
    .slice(0, config.maxPagesPerTick ?? undefined);
}

/**
 * Enqueue the pages due in the given epoch minute, and return how many
 * jobs went out. Called once a minute, this crawls every page once per
 * interval, staggered by offset.
 */
export async function enqueuePages(epochMinute: number): Promise<number> {
  // An entry of the publisher list is already a discovery job, so it
  // goes out as it stands and the file is the message contract.
  const due = duePages(epochMinute);

  await Promise.all(
    due.map((page) =>
      publishMessage(crawlConfig.crawlArticleDiscoveryTopic, page),
    ),
  );

  return due.length;
}
