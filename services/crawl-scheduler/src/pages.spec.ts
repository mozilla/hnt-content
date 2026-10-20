import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CrawlArticleDiscoveryMessage, crawlConfig } from 'crawl-common';

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
import publishers from './data/publishers.json' with { type: 'json' };

beforeEach(() => {
  // Stand in for Pub/Sub accepting a job and handing back its id.
  mocks.publishMessage.mockResolvedValue('message-id');
});

const originalPagesPerTick = config.pagesPerTick;

afterEach(() => {
  config.pagesPerTick = originalPagesPerTick;
  vi.clearAllMocks();
});

// Copy the pages so we can verify enqueuePages publishes them unaltered.
const pages = structuredClone(publishers.pages);

/** Enqueue the pages due in an epoch minute and return what was published. */
async function enqueuePagesAndCaptureMessages(
  epochMinute: number,
): Promise<CrawlArticleDiscoveryMessage[]> {
  mocks.publishMessage.mockClear();
  await enqueuePages(epochMinute);
  return mocks.publishMessage.mock.calls.map(([, page]) => page);
}

/** Return the pages published in each minute of the first interval. */
async function enqueueIntervalAndCaptureMessages(): Promise<
  CrawlArticleDiscoveryMessage[][]
> {
  const perMinute = [];
  for (let minute = 0; minute < crawlConfig.pageRefreshMinutes; minute++) {
    perMinute.push(await enqueuePagesAndCaptureMessages(minute));
  }
  return perMinute;
}

describe('enqueuePages', () => {
  beforeEach(() => {
    config.pagesPerTick = null;
  });

  it('publishes a due page unchanged to the discovery topic', async () => {
    await enqueuePages(0);

    const [topic, page] = mocks.publishMessage.mock.calls[0];
    expect(topic).toBe(crawlConfig.crawlArticleDiscoveryTopic);
    expect(pages).toContainEqual(page);
  });

  it('publishes every page once per interval', async () => {
    const messagesPerMinute = await enqueueIntervalAndCaptureMessages();

    const urls = messagesPerMinute.flat().map((page) => page.url);
    expect(urls.sort()).toEqual(pages.map((page) => page.url).sort());
  });

  it('spreads pages across the minutes of the interval', async () => {
    const messagesPerMinute = await enqueueIntervalAndCaptureMessages();

    const counts = messagesPerMinute.map((messages) => messages.length);
    const average = pages.length / crawlConfig.pageRefreshMinutes;
    // A hash spreads the list within about 10% of the average per minute.
    expect(Math.max(...counts)).toBeLessThan(1.5 * average);
  });

  it('publishes a page at the same minute every interval', async () => {
    const minute = 7;
    const laterMinute = minute + crawlConfig.pageRefreshMinutes;

    const messages = await enqueuePagesAndCaptureMessages(minute);
    const laterMessages = await enqueuePagesAndCaptureMessages(laterMinute);

    expect(laterMessages).toEqual(messages);
  });

  it.each([0, 1, 2])(
    'publishes pagesPerTick pages a tick when it is %i',
    async (pagesPerTick) => {
      config.pagesPerTick = pagesPerTick;

      const messages = await enqueuePagesAndCaptureMessages(0);

      expect(messages).toHaveLength(pagesPerTick);
    },
  );
});
