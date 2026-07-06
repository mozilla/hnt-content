import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DISCOVERY_MESSAGE } from './handlers/test-helpers.js';

vi.mock('pubsub', async (importOriginal) => {
  const actual = await importOriginal<typeof import('pubsub')>();
  return {
    ...actual,
    startSubscriber: vi.fn(),
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

vi.mock('./process-discovery.js', () => ({
  processDiscovery: vi.fn(async () => ({ outcome: 'processed' })),
}));

import { validateCrawlArticleDiscoveryMessage } from 'crawl-common';
import { sentryPubSubErrorHandler, startSubscriber } from 'pubsub';
import { processDiscovery } from './process-discovery.js';
import { startDiscoveryConsumer } from './discovery-consumer.js';

/** Invoke the message handler registered with startSubscriber. */
function registeredHandler() {
  return vi.mocked(startSubscriber).mock.calls[0]![0].handler;
}

describe('discovery consumer', () => {
  beforeEach(() => {
    startDiscoveryConsumer();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('subscribes to crawl-article-discovery with validation and a Sentry error handler', () => {
    expect(startSubscriber).toHaveBeenCalledTimes(1);
    const opts = vi.mocked(startSubscriber).mock.calls[0]![0];
    expect(opts.subscriptionName).toBe('test-crawl-article-discovery');
    expect(opts.maxExtensionSeconds).toBe(270);
    // Flow-control cap that bounds concurrent Zyte fetches and memory.
    expect(opts.maxMessages).toBe(64);
    expect(opts.validate).toBe(validateCrawlArticleDiscoveryMessage);
    expect(sentryPubSubErrorHandler).toHaveBeenCalledWith(
      'test-crawl-article-discovery',
    );
  });

  it('delegates each message to processDiscovery', async () => {
    await registeredHandler()(DISCOVERY_MESSAGE);

    expect(processDiscovery).toHaveBeenCalledWith(DISCOVERY_MESSAGE);
  });

  it('reports the page url, context count, surfaces, and topics to Sentry', () => {
    const metadata = captured.extractMetadata!(DISCOVERY_MESSAGE);
    expect(metadata).toEqual({
      // worker_role is 'article' here because vitest.config sets
      // WORKER_ROLE=article; the tag is read from config, not hardcoded.
      tags: { worker_role: 'article' },
      context: {
        url: DISCOVERY_MESSAGE.url,
        interval_minutes: DISCOVERY_MESSAGE.interval_minutes,
        context_count: DISCOVERY_MESSAGE.contexts.length,
        surface_ids: ['NEW_TAB_EN_US', 'NEW_TAB_DE_DE'],
        topics: ['technology', 'technologie'],
      },
    });
  });
});
