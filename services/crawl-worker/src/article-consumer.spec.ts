import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ArticleEvent, CrawlArticleMessage } from 'crawl-common';

vi.mock('pubsub', () => ({
  publishMessage: vi.fn(),
  sentryPubSubErrorHandler: vi.fn(() => vi.fn()),
  startSubscriber: vi.fn(),
}));
vi.mock('./handlers/extract-article.js', () => ({
  handleArticleExtraction: vi.fn(),
}));

import { publishMessage, startSubscriber } from 'pubsub';
import { startArticleConsumer } from './article-consumer.js';
import config from './config/index.js';
import { handleArticleExtraction } from './handlers/extract-article.js';
import { BASE_MESSAGE } from './handlers/test-helpers.js';

const EVENT: ArticleEvent = {
  url: BASE_MESSAGE.url,
  extracted_at: '2026-01-01T00:00:00.000Z',
};

/** Start the consumer and return the handler it registered. */
function registeredHandler(): (message: CrawlArticleMessage) => Promise<void> {
  startArticleConsumer();
  return vi.mocked(startSubscriber).mock.calls[0]![0].handler;
}

describe('article consumer', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('subscribes to the configured crawl-article subscription', () => {
    startArticleConsumer();
    expect(startSubscriber).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionName: config.crawlArticleSubscription,
        maxMessages: config.pubsubMaxMessages,
      }),
    );
  });

  it('publishes the extracted article to the articles topic', async () => {
    vi.mocked(handleArticleExtraction).mockResolvedValue(EVENT);
    await registeredHandler()(BASE_MESSAGE);
    expect(handleArticleExtraction).toHaveBeenCalledWith(BASE_MESSAGE);
    expect(publishMessage).toHaveBeenCalledWith(config.articlesTopic, EVENT);
  });

  it('rethrows an extraction error and publishes nothing', async () => {
    vi.mocked(handleArticleExtraction).mockRejectedValue(new Error('zyte'));
    await expect(registeredHandler()(BASE_MESSAGE)).rejects.toThrow('zyte');
    expect(publishMessage).not.toHaveBeenCalled();
  });
});
