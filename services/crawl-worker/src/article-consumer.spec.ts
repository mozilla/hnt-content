import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BASE_MESSAGE, CORPUS_ITEM } from './handlers/test-helpers.js';

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

vi.mock('./process-article.js', () => ({
  processArticle: vi.fn(async () => ({ outcome: 'processed' })),
}));

import { validateCrawlArticleMessage } from 'crawl-common';
import { sentryPubSubErrorHandler, startSubscriber } from 'pubsub';
import { processArticle } from './process-article.js';
import { startArticleConsumer } from './article-consumer.js';

/** Invoke the message handler registered with startSubscriber. */
function registeredHandler() {
  return vi.mocked(startSubscriber).mock.calls[0]![0].handler;
}

describe('article consumer', () => {
  beforeEach(() => {
    startArticleConsumer();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('subscribes to crawl-article with validation and a Sentry error handler', () => {
    expect(startSubscriber).toHaveBeenCalledTimes(1);
    const opts = vi.mocked(startSubscriber).mock.calls[0]![0];
    expect(opts.subscriptionName).toBe('test-crawl-article');
    expect(opts.maxExtensionSeconds).toBe(270);
    // Flow-control cap that bounds concurrent Zyte fetches and memory.
    expect(opts.maxMessages).toBe(64);
    expect(opts.validate).toBe(validateCrawlArticleMessage);
    expect(sentryPubSubErrorHandler).toHaveBeenCalledWith('test-crawl-article');
  });

  it('delegates each message to processArticle', async () => {
    await registeredHandler()(BASE_MESSAGE);

    expect(processArticle).toHaveBeenCalledWith(BASE_MESSAGE);
  });

  it('reports the url and crawl_id to Sentry, tagged by corpus_item presence', () => {
    const discovered = captured.extractMetadata!(BASE_MESSAGE);
    expect(discovered).toEqual({
      tags: {
        worker_role: 'article',
        has_corpus_item: 'false',
        corpus_topic: undefined,
      },
      context: {
        url: BASE_MESSAGE.url,
        crawl_id: BASE_MESSAGE.crawl_id,
        source_url: BASE_MESSAGE.source_url,
        enqueued_at: BASE_MESSAGE.enqueued_at,
      },
    });

    const live = captured.extractMetadata!({
      ...BASE_MESSAGE,
      corpus_item: CORPUS_ITEM,
    }) as { tags: Record<string, unknown> };
    expect(live.tags.has_corpus_item).toBe('true');
    expect(live.tags.corpus_topic).toBe(CORPUS_ITEM.topic);
  });
});
