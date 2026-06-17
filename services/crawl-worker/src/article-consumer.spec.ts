import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArticleEvent } from 'crawl-common';
import { BASE_MESSAGE } from './handlers/test-helpers.js';

vi.mock('crawl-common', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crawl-common')>();
  return {
    ...actual,
    startSubscriber: vi.fn(),
    publishMessage: vi.fn(),
    sentryPubSubErrorHandler: vi.fn(() => vi.fn()),
  };
});

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
    expect(opts.maxExtensionSeconds).toBe(180);
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
});
