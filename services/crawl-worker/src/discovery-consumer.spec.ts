import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArticleDiscoveryEvent } from 'crawl-common';
import { DISCOVERY_MESSAGE } from './handlers/test-helpers.js';

vi.mock('crawl-common', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crawl-common')>();
  return {
    ...actual,
    startSubscriber: vi.fn(),
    publishMessage: vi.fn(),
    sentryPubSubErrorHandler: vi.fn(() => vi.fn()),
  };
});

// Pass the handler through unchanged but capture the metadata
// extractor so the tags and context it builds can be asserted.
const { captured } = vi.hoisted(() => ({
  captured: {
    extractMetadata: undefined as ((m: unknown) => unknown) | undefined,
  },
}));
vi.mock('sentry', () => ({
  withSentryHandler: (
    extractMetadata: (m: unknown) => unknown,
    handler: unknown,
  ) => {
    captured.extractMetadata = extractMetadata;
    return handler;
  },
}));

vi.mock('./handlers/extract-discovery.js', () => ({
  handleArticleDiscovery: vi.fn(),
}));

import {
  publishMessage,
  sentryPubSubErrorHandler,
  startSubscriber,
  validateCrawlArticleDiscoveryMessage,
} from 'crawl-common';
import { handleArticleDiscovery } from './handlers/extract-discovery.js';
import { startDiscoveryConsumer } from './discovery-consumer.js';

const EVENT: ArticleDiscoveryEvent = {
  url: 'https://example.com/news/article-1',
  source_url: DISCOVERY_MESSAGE.url,
  crawled_at: '2025-06-01T12:00:00Z',
  surface_id: 'NEW_TAB_EN_US',
};

/** Invoke the message handler registered with startSubscriber. */
function registeredHandler() {
  return vi.mocked(startSubscriber).mock.calls[0]![0].handler;
}

describe('discovery consumer', () => {
  beforeEach(() => {
    vi.mocked(handleArticleDiscovery).mockResolvedValue({
      events: [EVENT],
      articleUrls: [EVENT.url],
    });
    startDiscoveryConsumer();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('subscribes to crawl-article-discovery with validation and a Sentry error handler', () => {
    expect(startSubscriber).toHaveBeenCalledTimes(1);
    const opts = vi.mocked(startSubscriber).mock.calls[0]![0];
    expect(opts.subscriptionName).toBe('test-crawl-article-discovery');
    expect(opts.maxExtensionSeconds).toBe(570);
    expect(opts.validate).toBe(validateCrawlArticleDiscoveryMessage);
    expect(sentryPubSubErrorHandler).toHaveBeenCalledWith(
      'test-crawl-article-discovery',
    );
  });

  it('publishes each discovery event and one crawl-article job per article', async () => {
    await registeredHandler()(DISCOVERY_MESSAGE);

    expect(handleArticleDiscovery).toHaveBeenCalledWith(DISCOVERY_MESSAGE);
    expect(publishMessage).toHaveBeenCalledWith(
      'test-article-discoveries',
      EVENT,
    );
    expect(publishMessage).toHaveBeenCalledWith(
      'test-crawl-article',
      expect.objectContaining({
        url: EVENT.url,
        source_url: DISCOVERY_MESSAGE.url,
        crawl_id: expect.any(String),
        enqueued_at: expect.any(String),
      }),
    );
  });

  // The handler owns dedup (selectArticles); the consumer publishes
  // one job per URL the handler returns, in order.
  it('publishes a crawl-article job for each article URL the handler returns', async () => {
    const urls = ['https://example.com/a', 'https://example.com/b'];
    vi.mocked(handleArticleDiscovery).mockResolvedValueOnce({
      events: [EVENT, { ...EVENT, surface_id: 'NEW_TAB_DE_DE' }],
      articleUrls: urls,
    });

    await registeredHandler()(DISCOVERY_MESSAGE);

    const jobUrls = vi
      .mocked(publishMessage)
      .mock.calls.filter(([topic]) => topic === 'test-crawl-article')
      .map(([, job]) => (job as { url: string }).url);
    expect(jobUrls).toEqual(urls);
  });

  it('gives each crawl-article job a distinct crawl_id', async () => {
    vi.mocked(handleArticleDiscovery).mockResolvedValueOnce({
      events: [],
      articleUrls: ['https://example.com/a', 'https://example.com/b'],
    });

    await registeredHandler()(DISCOVERY_MESSAGE);

    const crawlIds = vi
      .mocked(publishMessage)
      .mock.calls.filter(([topic]) => topic === 'test-crawl-article')
      .map(([, job]) => (job as { crawl_id: string }).crawl_id);
    expect(new Set(crawlIds).size).toBe(2);
  });

  it('propagates extraction errors without publishing', async () => {
    const err = new Error('zyte down');
    vi.mocked(handleArticleDiscovery).mockRejectedValueOnce(err);

    await expect(registeredHandler()(DISCOVERY_MESSAGE)).rejects.toThrow(err);
    expect(publishMessage).not.toHaveBeenCalled();
  });

  it('propagates publish errors so the message is redelivered', async () => {
    const err = new Error('publish failed');
    vi.mocked(publishMessage).mockRejectedValue(err);

    await expect(registeredHandler()(DISCOVERY_MESSAGE)).rejects.toThrow(err);
  });

  it('reports the page url and context count to Sentry', () => {
    const metadata = captured.extractMetadata!(DISCOVERY_MESSAGE);
    expect(metadata).toEqual({
      // worker_role is 'article' here because vitest.config sets
      // WORKER_ROLE=article; the tag is read from config, not hardcoded.
      tags: { worker_role: 'article' },
      context: {
        url: DISCOVERY_MESSAGE.url,
        interval_minutes: DISCOVERY_MESSAGE.interval_minutes,
        context_count: DISCOVERY_MESSAGE.contexts.length,
      },
    });
  });
});
