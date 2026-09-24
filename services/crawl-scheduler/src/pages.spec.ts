import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { crawlConfig } from 'crawl-common';
import type { CrawlArticleDiscoveryMessage } from 'crawl-common';

const mocks = vi.hoisted(() => ({
  publishMessage:
    vi.fn<
      (topic: string, message: CrawlArticleDiscoveryMessage) => Promise<string>
    >(),
}));

// Never let a test reach the real Pub/Sub. The non-prod topics are
// shared, so a page job published from here would be delivered and
// crawled for real.
vi.mock('pubsub', () => ({ publishMessage: mocks.publishMessage }));

import config from './config.js';
import { enqueuePages } from './pages.js';
import publishers from './publishers.json' with { type: 'json' };

/** Return the message of every job published so far, in publish order. */
function published(): CrawlArticleDiscoveryMessage[] {
  return mocks.publishMessage.mock.calls.map(([, message]) => message);
}

beforeEach(() => {
  // Stand in for Pub/Sub accepting a job and handing back its id.
  mocks.publishMessage.mockResolvedValue('message-id');
});

const CONFIGURED_CAP = config.pagesPerTick;

afterEach(() => {
  config.pagesPerTick = CONFIGURED_CAP;
  vi.clearAllMocks();
});

describe('enqueuePages', () => {
  it('publishes a page from the publisher list unchanged', async () => {
    config.pagesPerTick = 1;

    expect(await enqueuePages()).toBe(1);
    expect(mocks.publishMessage).toHaveBeenCalledOnce();
    const [topic] = mocks.publishMessage.mock.calls[0];
    expect(topic).toBe(crawlConfig.crawlArticleDiscoveryTopic);
    // A deep match against the list holds the scheduler to publishing
    // an entry with its url and contexts intact and nothing added.
    expect(publishers.pages).toContainEqual(published()[0]);
  });

  it('publishes up to the cap and never the same page twice', async () => {
    config.pagesPerTick = 5;

    expect(await enqueuePages()).toBe(5);
    expect(new Set(published().map((page) => page.url)).size).toBe(5);
  });

  it('enqueues nothing when the cap is zero, as in production', async () => {
    config.pagesPerTick = 0;

    expect(await enqueuePages()).toBe(0);
    expect(mocks.publishMessage).not.toHaveBeenCalled();
  });
});
