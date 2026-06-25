import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArticleDiscoveryEvent } from 'crawl-common';
import { DISCOVERY_MESSAGE } from './handlers/test-helpers.js';

vi.mock('crawl-common', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crawl-common')>();
  return {
    ...actual,
    acquireLock: vi.fn(),
    releaseLock: vi.fn(),
    getTimestamp: vi.fn(),
    setTimestamp: vi.fn(),
    publishMessage: vi.fn(),
  };
});

vi.mock('./handlers/extract-discovery.js', () => ({
  handleArticleDiscovery: vi.fn(),
}));

import {
  acquireLock,
  getTimestamp,
  publishMessage,
  releaseLock,
  setTimestamp,
} from 'crawl-common';
import { handleArticleDiscovery } from './handlers/extract-discovery.js';
import { processDiscovery } from './process-discovery.js';

const EVENT: ArticleDiscoveryEvent = {
  url: 'https://example.com/news/article-1',
  source_url: DISCOVERY_MESSAGE.url,
  crawled_at: '2025-06-01T12:00:00Z',
  surface_id: 'NEW_TAB_EN_US',
};

/** Count publishes to a given topic. */
function publishesTo(topic: string): unknown[] {
  return vi
    .mocked(publishMessage)
    .mock.calls.filter(([t]) => t === topic)
    .map(([, payload]) => payload);
}

describe('processDiscovery', () => {
  beforeEach(() => {
    // Page not crawled recently; lock free; articles not fetched.
    vi.mocked(getTimestamp).mockResolvedValue(null);
    vi.mocked(acquireLock).mockResolvedValue('lock-token');
    vi.mocked(publishMessage).mockResolvedValue('message-id');
    vi.mocked(handleArticleDiscovery).mockResolvedValue({
      events: [EVENT, { ...EVENT, surface_id: 'NEW_TAB_DE_DE' }],
      articleUrls: [EVENT.url],
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('skips a page crawled within its interval', async () => {
    vi.mocked(getTimestamp).mockResolvedValue(Date.now());

    await processDiscovery(DISCOVERY_MESSAGE);

    expect(acquireLock).not.toHaveBeenCalled();
    expect(handleArticleDiscovery).not.toHaveBeenCalled();
    expect(publishMessage).not.toHaveBeenCalled();
  });

  it('skips when another worker holds the page lock', async () => {
    vi.mocked(acquireLock).mockResolvedValue(null);

    await processDiscovery(DISCOVERY_MESSAGE);

    expect(handleArticleDiscovery).not.toHaveBeenCalled();
    expect(publishMessage).not.toHaveBeenCalled();
    expect(setTimestamp).not.toHaveBeenCalled();
    expect(releaseLock).not.toHaveBeenCalled();
  });

  it('publishes every discovery event and enqueues unfetched articles, then marks the page', async () => {
    await processDiscovery(DISCOVERY_MESSAGE);

    expect(publishesTo('test-article-discoveries')).toHaveLength(2);
    const jobs = publishesTo('test-crawl-article');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      url: EVENT.url,
      source_url: DISCOVERY_MESSAGE.url,
    });
    expect(setTimestamp).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledWith(expect.any(String), 'lock-token');
  });

  it('publishes discovery events but skips the job for a recently fetched article', async () => {
    // Page not crawled recently, but the discovered article was fetched.
    vi.mocked(getTimestamp).mockImplementation(async (key: string) =>
      key.startsWith('page:fetch') ? null : Date.now(),
    );

    await processDiscovery(DISCOVERY_MESSAGE);

    expect(publishesTo('test-article-discoveries')).toHaveLength(2);
    expect(publishesTo('test-crawl-article')).toHaveLength(0);
  });

  it('enqueues one job per unique article URL with a distinct crawl_id', async () => {
    const urls = ['https://example.com/a', 'https://example.com/b'];
    vi.mocked(handleArticleDiscovery).mockResolvedValueOnce({
      events: [],
      articleUrls: urls,
    });

    await processDiscovery(DISCOVERY_MESSAGE);

    const jobs = publishesTo('test-crawl-article') as {
      url: string;
      crawl_id: string;
    }[];
    expect(jobs.map((j) => j.url)).toEqual(urls);
    expect(new Set(jobs.map((j) => j.crawl_id)).size).toBe(2);
  });

  it('releases the lock and does not mark the page when extraction throws', async () => {
    const err = new Error('zyte failed');
    vi.mocked(handleArticleDiscovery).mockRejectedValue(err);

    await expect(processDiscovery(DISCOVERY_MESSAGE)).rejects.toThrow(err);
    expect(setTimestamp).not.toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalledWith(expect.any(String), 'lock-token');
  });

  it('propagates a publish failure without marking the page', async () => {
    vi.mocked(publishMessage).mockRejectedValue(new Error('pubsub down'));

    await expect(processDiscovery(DISCOVERY_MESSAGE)).rejects.toThrow(
      'pubsub down',
    );
    expect(setTimestamp).not.toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalledWith(expect.any(String), 'lock-token');
  });
});
