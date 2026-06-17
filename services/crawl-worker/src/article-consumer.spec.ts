import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArticleEvent } from 'crawl-common';
import { BASE_MESSAGE, CORPUS_ITEM } from './handlers/test-helpers.js';

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

vi.mock('./handlers/extract-article.js', () => ({
  handleArticleExtraction: vi.fn(),
}));

import {
  publishMessage,
  sentryPubSubErrorHandler,
  startSubscriber,
} from 'crawl-common';
import { handleArticleExtraction } from './handlers/extract-article.js';
import { startArticleConsumer } from './article-consumer.js';

const EVENT: ArticleEvent = {
  url: BASE_MESSAGE.url,
  extracted_at: '2025-06-01T12:01:00Z',
  headline: 'Test Headline',
};

/** Invoke the message handler registered with startSubscriber. */
function registeredHandler() {
  return vi.mocked(startSubscriber).mock.calls[0]![0].handler;
}

describe('article consumer', () => {
  beforeEach(() => {
    vi.mocked(handleArticleExtraction).mockResolvedValue(EVENT);
    startArticleConsumer();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('subscribes to crawl-article with a Sentry error handler', () => {
    expect(startSubscriber).toHaveBeenCalledTimes(1);
    const opts = vi.mocked(startSubscriber).mock.calls[0]![0];
    expect(opts.subscriptionName).toBe('crawl-article');
    expect(opts.maxExtensionSeconds).toBe(570);
    expect(sentryPubSubErrorHandler).toHaveBeenCalledWith('crawl-article');
  });

  it('extracts the article then publishes the event to the articles topic', async () => {
    await registeredHandler()(BASE_MESSAGE);

    expect(handleArticleExtraction).toHaveBeenCalledWith(BASE_MESSAGE);
    expect(publishMessage).toHaveBeenCalledWith('articles', EVENT);
  });

  it('propagates extraction errors without publishing', async () => {
    const err = new Error('extraction failed');
    vi.mocked(handleArticleExtraction).mockRejectedValue(err);

    await expect(registeredHandler()(BASE_MESSAGE)).rejects.toThrow(err);
    expect(publishMessage).not.toHaveBeenCalled();
  });

  it('propagates publish errors so the message is redelivered', async () => {
    const err = new Error('publish failed');
    vi.mocked(publishMessage).mockRejectedValue(err);

    await expect(registeredHandler()(BASE_MESSAGE)).rejects.toThrow(err);
  });

  it('reports the url and crawl_id to Sentry, tagged by article type', () => {
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
