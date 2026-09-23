import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  crawlConfig,
  type ArticleDiscoveryEvent,
  type CrawlArticleDiscoveryMessage,
} from 'crawl-common';

vi.mock('pubsub', () => ({
  publishMessage: vi.fn(),
  sentryPubSubErrorHandler: vi.fn(() => vi.fn()),
  startSubscriber: vi.fn(),
}));
vi.mock('redis-state', () => ({
  acquireLock: vi.fn(),
  getTimestamp: vi.fn(),
  releaseLock: vi.fn(),
  setTimestamp: vi.fn(),
}));
vi.mock('./handlers/extract-discovery.js', () => ({
  handleArticleDiscovery: vi.fn(),
}));

import { publishMessage, startSubscriber } from 'pubsub';
import {
  acquireLock,
  getTimestamp,
  releaseLock,
  setTimestamp,
} from 'redis-state';
import config from './config.js';
import { startDiscoveryConsumer } from './discovery-consumer.js';
import { handleArticleDiscovery } from './handlers/extract-discovery.js';
import { DISCOVERY_MESSAGE, TEST_SOURCE_URL } from './handlers/test-helpers.js';

const ARTICLE_URL = 'https://example.com/news/article-1';

/** One discovery event, as the handler returns it per context. */
function discoveryEvent(surfaceId: string): ArticleDiscoveryEvent {
  return {
    url: ARTICLE_URL,
    source_url: TEST_SOURCE_URL,
    crawled_at: '2026-01-01T00:00:00.000Z',
    surface_id: surfaceId,
  };
}

const EVENTS = [
  discoveryEvent('NEW_TAB_EN_US'),
  discoveryEvent('NEW_TAB_DE_DE'),
];

/** Return the payloads published to a topic. */
function publishesTo(topic: string): unknown[] {
  return vi
    .mocked(publishMessage)
    .mock.calls.filter(([t]) => t === topic)
    .map(([, payload]) => payload);
}

/** Start the consumer and return the handler it registered. */
function registeredHandler(): (
  message: CrawlArticleDiscoveryMessage,
) => Promise<void> {
  startDiscoveryConsumer();
  return vi.mocked(startSubscriber).mock.calls[0]![0].handler;
}

describe('discovery consumer', () => {
  beforeEach(() => {
    // Page not crawled recently, lock free, articles not extracted.
    vi.mocked(getTimestamp).mockResolvedValue(null);
    vi.mocked(acquireLock).mockResolvedValue('lock-token');
    vi.mocked(releaseLock).mockResolvedValue();
    vi.mocked(publishMessage).mockResolvedValue('message-id');
    vi.mocked(handleArticleDiscovery).mockResolvedValue({
      events: EVENTS,
      articleUrls: [ARTICLE_URL],
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('subscribes to the configured crawl-article-discovery subscription', () => {
    startDiscoveryConsumer();
    expect(startSubscriber).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionName: crawlConfig.crawlArticleDiscoverySubscription,
        maxMessages: config.maxMessages,
      }),
    );
  });

  it('publishes an event per context and one job per unique article', async () => {
    await registeredHandler()(DISCOVERY_MESSAGE);

    expect(handleArticleDiscovery).toHaveBeenCalledWith(DISCOVERY_MESSAGE);
    for (const event of EVENTS) {
      expect(publishMessage).toHaveBeenCalledWith(
        crawlConfig.articleDiscoveriesTopic,
        event,
      );
    }
    expect(publishMessage).toHaveBeenCalledWith(crawlConfig.crawlArticleTopic, {
      url: ARTICLE_URL,
      source_url: DISCOVERY_MESSAGE.url,
      crawl_id: expect.any(String),
      enqueued_at: expect.any(String),
      // A discovered article has no cadence of its own, so the job
      // carries the worker's window for discovered articles.
      article_refresh_minutes: config.discoveredArticleRefreshDays * 24 * 60,
    });
    expect(publishMessage).toHaveBeenCalledTimes(3);
    expect(setTimestamp).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledWith(expect.any(String), 'lock-token');
  });

  it('skips a page crawled within its interval', async () => {
    vi.mocked(getTimestamp).mockResolvedValue(Date.now());

    await registeredHandler()(DISCOVERY_MESSAGE);

    expect(acquireLock).not.toHaveBeenCalled();
    expect(handleArticleDiscovery).not.toHaveBeenCalled();
    expect(publishMessage).not.toHaveBeenCalled();
  });

  it('crawls a page whose last crawl is older than its interval', async () => {
    const stale = Date.now() - (config.pageRefreshMinutes + 1) * 60_000;
    vi.mocked(getTimestamp).mockResolvedValue(stale);

    await registeredHandler()(DISCOVERY_MESSAGE);

    expect(handleArticleDiscovery).toHaveBeenCalledOnce();
  });

  it('skips when another worker holds the page lock', async () => {
    vi.mocked(acquireLock).mockResolvedValue(null);

    await registeredHandler()(DISCOVERY_MESSAGE);

    expect(handleArticleDiscovery).not.toHaveBeenCalled();
    expect(publishMessage).not.toHaveBeenCalled();
    expect(setTimestamp).not.toHaveBeenCalled();
    expect(releaseLock).not.toHaveBeenCalled();
  });

  it('re-checks page:fetch under the lock and skips a concurrent duplicate', async () => {
    // The pre-lock check sees no marker, but the job that won the lock
    // first has since claimed page:fetch.
    vi.mocked(getTimestamp)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(Date.now());

    await registeredHandler()(DISCOVERY_MESSAGE);

    expect(acquireLock).toHaveBeenCalled();
    expect(handleArticleDiscovery).not.toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalledWith(expect.any(String), 'lock-token');
  });

  it('claims the page marker before the Zyte call and publish fan-out', async () => {
    await registeredHandler()(DISCOVERY_MESSAGE);

    const claimOrder = vi.mocked(setTimestamp).mock.invocationCallOrder[0]!;
    const extractOrder = vi.mocked(handleArticleDiscovery).mock
      .invocationCallOrder[0]!;
    const publishOrder = vi.mocked(publishMessage).mock.invocationCallOrder[0]!;
    expect(claimOrder).toBeLessThan(extractOrder);
    expect(claimOrder).toBeLessThan(publishOrder);
  });

  it('publishes discovery events but skips the job for a recently extracted article', async () => {
    vi.mocked(getTimestamp).mockImplementation(async (key: string) =>
      key.startsWith('article:extracted') ? Date.now() : null,
    );

    await registeredHandler()(DISCOVERY_MESSAGE);

    expect(publishesTo(crawlConfig.articleDiscoveriesTopic)).toHaveLength(2);
    expect(publishesTo(crawlConfig.crawlArticleTopic)).toHaveLength(0);
  });

  it('enqueues one job per article URL with a distinct crawl_id', async () => {
    const urls = ['https://example.com/a', 'https://example.com/b'];
    vi.mocked(handleArticleDiscovery).mockResolvedValue({
      events: [],
      articleUrls: urls,
    });

    await registeredHandler()(DISCOVERY_MESSAGE);

    const jobs = publishesTo(crawlConfig.crawlArticleTopic) as {
      url: string;
      crawl_id: string;
    }[];
    expect(jobs.map((j) => j.url)).toEqual(urls);
    expect(new Set(jobs.map((j) => j.crawl_id)).size).toBe(2);
  });

  it('keeps the page claim across a failed publish, so a redelivery skips', async () => {
    vi.mocked(publishMessage).mockRejectedValueOnce(new Error('pubsub down'));
    const handler = registeredHandler();

    await expect(handler(DISCOVERY_MESSAGE)).rejects.toThrow('pubsub down');
    expect(setTimestamp).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledWith(expect.any(String), 'lock-token');

    // The redelivery sees the claim and does not call Zyte again.
    vi.mocked(getTimestamp).mockResolvedValue(Date.now());
    await handler(DISCOVERY_MESSAGE);
    expect(handleArticleDiscovery).toHaveBeenCalledOnce();
  });

  it('does not nack a handled message when the lock release fails', async () => {
    vi.mocked(releaseLock).mockRejectedValue(new Error('redis down'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      registeredHandler()(DISCOVERY_MESSAGE),
    ).resolves.toBeUndefined();
    errorSpy.mockRestore();
  });

  it('rethrows a discovery error, publishes nothing, and releases the lock', async () => {
    vi.mocked(handleArticleDiscovery).mockRejectedValue(new Error('zyte'));

    await expect(registeredHandler()(DISCOVERY_MESSAGE)).rejects.toThrow(
      'zyte',
    );
    expect(publishMessage).not.toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalledWith(expect.any(String), 'lock-token');
  });
});
