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
import { duePages, enqueuePages, pageOffset } from './pages.js';
import publishers from './data/publishers.json' with { type: 'json' };

const { pages } = publishers;

beforeEach(() => {
  // Stand in for Pub/Sub accepting a job and handing back its id.
  mocks.publishMessage.mockResolvedValue('message-id');
  config.maxPagesPerTick = null;
});

const originalMaxPagesPerTick = config.maxPagesPerTick;

afterEach(() => {
  config.maxPagesPerTick = originalMaxPagesPerTick;
  vi.clearAllMocks();
});

describe('pageOffset', () => {
  it.each([
    ['https://apnews.com/world-news', 3],
    ['https://www.bbc.com/news', 9],
    ['https://www.theguardian.com/world', 12],
  ])('crawls %s at minute %i of each interval', (url, offset) => {
    expect(pageOffset(url)).toBe(offset);
  });
});

describe('duePages', () => {
  it('returns every page once per interval', () => {
    const minutes = [...Array(crawlConfig.pageRefreshMinutes).keys()];

    const urls = minutes
      .flatMap((minute) => duePages(minute))
      .map((page) => page.url);

    expect(urls.sort()).toEqual(pages.map((page) => page.url).sort());
  });

  it('spreads pages across the minutes of the interval', () => {
    const minutes = [...Array(crawlConfig.pageRefreshMinutes).keys()];

    const counts = minutes.map((minute) => duePages(minute).length);

    const average = pages.length / crawlConfig.pageRefreshMinutes;
    // A hash keeps each minute within about 10% of the average; the 1.5x
    // bound leaves room for list changes.
    expect(Math.max(...counts)).toBeLessThan(1.5 * average);
  });

  it('returns the same pages every interval', () => {
    const minute = 7;
    const laterMinute = minute + crawlConfig.pageRefreshMinutes;

    expect(duePages(laterMinute)).toEqual(duePages(minute));
  });

  it.each([0, 1, 2, null])(
    'returns at most maxPagesPerTick pages when it is %s',
    (max) => {
      config.maxPagesPerTick = max;
      const dueAtZero = pages.filter((page) => pageOffset(page.url) === 0);

      expect(duePages(0)).toHaveLength(max ?? dueAtZero.length);
    },
  );
});

describe('enqueuePages', () => {
  it('publishes every due page to the discovery topic', async () => {
    const due = duePages(0);

    await enqueuePages(0);

    expect(mocks.publishMessage.mock.calls).toEqual(
      due.map((page) => [crawlConfig.crawlArticleDiscoveryPubSub.topic, page]),
    );
  });

  it('leaves the page list unmodified', async () => {
    const original = structuredClone(publishers.pages);

    await enqueuePages(0);

    // enqueuePages must not modify the page list. It is one module-level
    // object shared by every tick, so a change would carry into the next.
    expect(publishers.pages).toEqual(original);
  });
});
