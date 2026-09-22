import { afterEach, describe, expect, it, vi } from 'vitest';
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
vi.mock('./handlers/extract-discovery.js', () => ({
  handleArticleDiscovery: vi.fn(),
}));

import { publishMessage, startSubscriber } from 'pubsub';
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

/** Start the consumer and return the handler it registered. */
function registeredHandler(): (
  message: CrawlArticleDiscoveryMessage,
) => Promise<void> {
  startDiscoveryConsumer();
  return vi.mocked(startSubscriber).mock.calls[0]![0].handler;
}

describe('discovery consumer', () => {
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
    vi.mocked(handleArticleDiscovery).mockResolvedValue({
      events: EVENTS,
      articleUrls: [ARTICLE_URL],
    });

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
  });

  it('rethrows a discovery error and publishes nothing', async () => {
    vi.mocked(handleArticleDiscovery).mockRejectedValue(new Error('zyte'));

    await expect(registeredHandler()(DISCOVERY_MESSAGE)).rejects.toThrow(
      'zyte',
    );
    expect(publishMessage).not.toHaveBeenCalled();
  });
});
