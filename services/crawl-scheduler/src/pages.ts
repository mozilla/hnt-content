import { createHash } from 'node:crypto';
import { crawlConfig, type PublisherList } from 'crawl-common';
import { publishMessage } from 'pubsub';
import config from './config.js';
import publishers from './data/publishers.json' with { type: 'json' };

const { pages }: PublisherList = publishers;

/**
 * Return the page's offset in minutes into the crawl interval, from a
 * hash of its URL. Offsets spread pages evenly across the interval, so
 * crawls do not reach Zyte all at once.
 */
function pageOffset(url: string): number {
  const digest = createHash('sha256').update(url).digest();
  return digest.readUInt32BE(0) % crawlConfig.pageRefreshMinutes;
}

/**
 * Enqueue the pages whose offset matches the given epoch minute, up to
 * `pagesPerTick`, and return how many jobs went out. Called once a
 * minute, this crawls every page once per interval, staggered by
 * offset. A cap keeps the first due pages in list order, so the same
 * pages recur each interval.
 */
export async function enqueuePages(epochMinute: number): Promise<number> {
  // An entry of the publisher list is already a discovery job, so it
  // goes out as it stands and the file is the message contract.
  const due = pages
    .filter(
      (page) =>
        pageOffset(page.url) === epochMinute % crawlConfig.pageRefreshMinutes,
    )
    .slice(0, config.pagesPerTick ?? undefined);

  await Promise.all(
    due.map((page) =>
      publishMessage(crawlConfig.crawlArticleDiscoveryTopic, page),
    ),
  );

  return due.length;
}
