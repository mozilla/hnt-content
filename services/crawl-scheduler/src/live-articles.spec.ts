import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { crawlConfig } from 'crawl-common';
import type { CrawlArticleMessage, LiveArticle } from 'crawl-common';

// Declared out here, and typed, so the assertions below can read the
// fields of a published job.
const mocks = vi.hoisted(() => ({
  getScheduledSectionItems: vi.fn<() => Promise<LiveArticle[]>>(),
  publishMessage:
    vi.fn<(topic: string, message: CrawlArticleMessage) => Promise<string>>(),
}));

// Never let a test reach the real Corpus API or the real Pub/Sub. Both
// non-prod endpoints hold shared data, so a job published from here
// would be delivered and extracted for real.
vi.mock('crawl-common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('crawl-common')>()),
  getScheduledSectionItems: mocks.getScheduledSectionItems,
}));
vi.mock('pubsub', () => ({ publishMessage: mocks.publishMessage }));

import config from './config.js';
import { enqueueLiveArticles } from './live-articles.js';

const CORPUS_ITEM = {
  external_id: 'ext-1',
  title: 'Original Headline',
  excerpt: 'Original excerpt text.',
  authors: [{ name: 'Jane Doe' }],
  status: 'CORPUS' as const,
  language: 'EN' as const,
  publisher: 'Example News',
  image_url: 'https://s3.amazonaws.com/image.jpg',
  topic: 'TECHNOLOGY',
  is_time_sensitive: false,
};

const LIVE_ARTICLE: LiveArticle = {
  url: 'https://example.com/live-1',
  corpus_item: CORPUS_ITEM,
};

/** Build a list of distinct live articles for the batching tests. */
function liveArticles(count: number): LiveArticle[] {
  return Array.from({ length: count }, (_, i) => ({
    url: `https://example.com/live-${i}`,
    corpus_item: { ...CORPUS_ITEM, external_id: `ext-${i}` },
  }));
}

/** Return the URL of every job published so far, in publish order. */
function publishedUrls(): string[] {
  return mocks.publishMessage.mock.calls.map(([, message]) => message.url);
}

beforeEach(() => {
  // Stand in for Pub/Sub accepting a job and handing back its id.
  mocks.publishMessage.mockResolvedValue('message-id');
});

const CONFIGURED_CAP = config.liveArticlesPerTick;

afterEach(() => {
  config.liveArticlesPerTick = CONFIGURED_CAP;
  vi.clearAllMocks();
});

describe('enqueueLiveArticles', () => {
  it('publishes one crawl-article job per live article', async () => {
    mocks.getScheduledSectionItems.mockResolvedValue([LIVE_ARTICLE]);

    expect(await enqueueLiveArticles()).toBe(1);
    expect(mocks.getScheduledSectionItems).toHaveBeenCalledWith(
      'NEW_TAB_EN_US',
    );
    expect(mocks.publishMessage).toHaveBeenCalledOnce();
    expect(mocks.publishMessage).toHaveBeenCalledWith(
      crawlConfig.crawlArticleTopic,
      {
        url: LIVE_ARTICLE.url,
        // A live article has no publisher page, so it is its own source.
        source_url: LIVE_ARTICLE.url,
        crawl_id: expect.any(String),
        enqueued_at: expect.any(String),
        article_refresh_minutes: 15,
        corpus_item: LIVE_ARTICLE.corpus_item,
      },
    );
  });

  it('publishes up to the cap and never the same article twice', async () => {
    mocks.getScheduledSectionItems.mockResolvedValue(liveArticles(10));

    expect(await enqueueLiveArticles()).toBe(3);
    expect(new Set(publishedUrls()).size).toBe(3);
  });

  it('reaches articles beyond the first few over successive runs', async () => {
    mocks.getScheduledSectionItems.mockResolvedValue(liveArticles(10));

    for (let i = 0; i < 20; i++) {
      await enqueueLiveArticles();
    }

    // Every one of the twenty runs would have to draw the same three of
    // ten articles for this to fail, so it asserts the spread without
    // being flaky.
    expect(new Set(publishedUrls()).size).toBeGreaterThan(3);
  });

  it('enqueues nothing when the cap is zero', async () => {
    config.liveArticlesPerTick = 0;

    expect(await enqueueLiveArticles()).toBe(0);
    expect(mocks.getScheduledSectionItems).not.toHaveBeenCalled();
    expect(mocks.publishMessage).not.toHaveBeenCalled();
  });

  it('publishes nothing for an empty list', async () => {
    mocks.getScheduledSectionItems.mockResolvedValue([]);

    expect(await enqueueLiveArticles()).toBe(0);
    expect(mocks.publishMessage).not.toHaveBeenCalled();
  });

  it('lets a Corpus API failure through and keeps ticking after it', async () => {
    mocks.getScheduledSectionItems.mockRejectedValueOnce(
      new Error('Corpus API error: 503'),
    );

    // The error reaches the caller so that Sentry records it; main.ts
    // logs it and waits for the next tick rather than exiting.
    await expect(enqueueLiveArticles()).rejects.toThrow(
      'Corpus API error: 503',
    );
    expect(mocks.publishMessage).not.toHaveBeenCalled();

    mocks.getScheduledSectionItems.mockResolvedValue([LIVE_ARTICLE]);
    expect(await enqueueLiveArticles()).toBe(1);
  });
});
