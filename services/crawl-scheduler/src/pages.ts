import { crawlConfig, type PublisherList } from 'crawl-common';
import { publishMessage } from 'pubsub';
import config from './config.js';
import publishers from './publishers.json' with { type: 'json' };
import { randomBatch } from './random-batch.js';

const { pages }: PublisherList = publishers;

/**
 * Enqueue a capped batch of the publisher pages for discovery, and
 * return how many jobs went out.
 */
export async function enqueuePages(): Promise<number> {
  if (!config.pagesPerTick) {
    return 0;
  }

  // An entry of the publisher list is already a discovery job, so it
  // goes out as it stands and the file is the message contract.
  const batch = randomBatch(pages, config.pagesPerTick);
  await Promise.all(
    batch.map((page) =>
      publishMessage(crawlConfig.crawlArticleDiscoveryTopic, page),
    ),
  );

  return batch.length;
}
