import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublisherList } from 'crawl-common';

vi.mock('pubsub', async (importOriginal) => {
  const actual = await importOriginal<typeof import('pubsub')>();
  return {
    ...actual,
    publishMessage: vi.fn(),
  };
});
vi.mock('redis-state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('redis-state')>();
  return {
    ...actual,
    getTimestamp: vi.fn(),
    setTimestamp: vi.fn(),
  };
});

import { publishMessage } from 'pubsub';
import { getTimestamp, setTimestamp } from 'redis-state';
import config from './config.js';
import { runTick } from './tick.js';

const PAGE = {
  url: 'https://example.com/news',
  interval_minutes: 20,
  contexts: [{ surface_id: 'NEW_TAB_EN_US', topic: 'technology' }],
};

const LIVE_ARTICLE = {
  url: 'https://example.com/live-1',
  corpus_item: {
    external_id: 'ext-1',
    title: 'Headline',
    excerpt: 'Excerpt',
    authors: [{ name: 'Jane Doe' }],
    status: 'CORPUS' as const,
    language: 'EN' as const,
    publisher: 'Example News',
    image_url: 'https://s3.amazonaws.com/image.jpg',
    topic: 'TECHNOLOGY',
    is_time_sensitive: false,
  },
};

const LIST: PublisherList = { pages: [PAGE], live_articles: [LIVE_ARTICLE] };

describe('runTick', () => {
  beforeEach(() => {
    // Nothing recently enqueued by default; publishes succeed.
    vi.mocked(getTimestamp).mockResolvedValue(null);
    vi.mocked(publishMessage).mockResolvedValue('message-id');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('enqueues a due page to the discovery topic and marks it', async () => {
    const counts = await runTick({ ...LIST, live_articles: [] });

    expect(counts.pages).toBe(1);
    expect(publishMessage).toHaveBeenCalledWith(
      config.crawlArticleDiscoveryTopic,
      PAGE,
    );
    // Marker stored with the default TTL; the interval is enforced by
    // comparing the stored timestamp, not by the TTL.
    expect(setTimestamp).toHaveBeenCalledWith(expect.any(String));
  });

  it('skips a page enqueued within its interval', async () => {
    vi.mocked(getTimestamp).mockResolvedValue(Date.now());

    const counts = await runTick({ ...LIST, live_articles: [] });

    expect(counts.pages).toBe(0);
    expect(publishMessage).not.toHaveBeenCalled();
    expect(setTimestamp).not.toHaveBeenCalled();
  });

  it('re-enqueues a page whose interval has elapsed', async () => {
    // Enqueued just over the 20-minute interval ago.
    vi.mocked(getTimestamp).mockResolvedValue(Date.now() - 21 * 60_000);

    const counts = await runTick({ ...LIST, live_articles: [] });

    expect(counts.pages).toBe(1);
    expect(publishMessage).toHaveBeenCalledOnce();
  });

  it('enqueues a due live article with corpus_item, source_url, and a crawl_id', async () => {
    const counts = await runTick({ ...LIST, pages: [] });

    expect(counts.liveArticles).toBe(1);
    expect(publishMessage).toHaveBeenCalledWith(
      config.crawlArticleTopic,
      expect.objectContaining({
        url: LIVE_ARTICLE.url,
        source_url: LIVE_ARTICLE.url,
        corpus_item: LIVE_ARTICLE.corpus_item,
        crawl_id: expect.any(String),
        enqueued_at: expect.any(String),
      }),
    );
    expect(setTimestamp).toHaveBeenCalledWith(expect.any(String));
  });

  it('skips a live article enqueued within the interval', async () => {
    vi.mocked(getTimestamp).mockResolvedValue(Date.now());

    const counts = await runTick({ ...LIST, pages: [] });

    expect(counts.liveArticles).toBe(0);
    expect(publishMessage).not.toHaveBeenCalled();
  });

  it('propagates a publish failure without marking enqueued', async () => {
    vi.mocked(publishMessage).mockRejectedValue(new Error('pubsub down'));

    await expect(runTick({ ...LIST, live_articles: [] })).rejects.toThrow(
      'pubsub down',
    );
    expect(setTimestamp).not.toHaveBeenCalled();
  });

  it('counts both pages and live articles', async () => {
    expect(await runTick(LIST)).toEqual({ pages: 1, liveArticles: 1 });
  });
});
