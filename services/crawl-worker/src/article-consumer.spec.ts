import {
  buildRedisArticleContentKey,
  buildRedisArticleExtractedKey,
  buildRedisArticleLockKey,
  crawlConfig,
  type ArticleEvent,
  type CrawlArticleMessage,
} from 'crawl-common';
import { publishMessage, startSubscriber } from 'pubsub';
import { withSentryHandler } from 'sentry';
import {
  acquireRedisKeyLockToken,
  getRedisKeyTimestampValue,
  getRedisKeyStringValue,
  releaseRedisKeyLock,
  setRedisKeyTimestampWithTTL,
  setRedisKeyStringValue,
} from 'redis-state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startArticleConsumer } from './article-consumer.js';
import config from './config.js';
import { handleArticleExtraction } from './handlers/extract-article.js';
import { BASE_MESSAGE } from './handlers/test-helpers.js';

vi.mock('pubsub', () => ({
  publishMessage: vi.fn(),
  sentryPubSubErrorHandler: vi.fn(() => vi.fn()),
  startSubscriber: vi.fn(),
}));
vi.mock('redis-state', () => ({
  acquireRedisKeyLockToken: vi.fn(),
  getRedisKeyTimestampValue: vi.fn(),
  getRedisKeyStringValue: vi.fn(),
  releaseRedisKeyLock: vi.fn(),
  setRedisKeyTimestampWithTTL: vi.fn(),
  setRedisKeyStringValue: vi.fn(),
}));
// Pass handlers through unwrapped, keeping each Sentry metadata function.
vi.mock('sentry', () => ({
  withSentryHandler: vi.fn((_, handler) => handler),
}));
vi.mock('./handlers/extract-article.js', () => ({
  handleArticleExtraction: vi.fn(),
}));

const EVENT: ArticleEvent = {
  url: BASE_MESSAGE.url,
  canonical_url: BASE_MESSAGE.url,
  extracted_at: '2026-01-01T00:00:00.000Z',
  headline: 'Test Headline',
};

const CLAIM_TTL_SECONDS = config.articleAttemptTtlMinutes * 60;
const REFRESH_TTL_SECONDS = BASE_MESSAGE.article_refresh_minutes * 60;

/** Start the consumer and return the handler it registered. */
function registeredHandler(): (message: CrawlArticleMessage) => Promise<void> {
  startArticleConsumer();
  return vi.mocked(startSubscriber).mock.calls[0]![0].handler;
}

/** Return the TTLs passed to each `article:extracted` write, in order. */
function markerTtls(): unknown[] {
  return vi
    .mocked(setRedisKeyTimestampWithTTL)
    .mock.calls.map(([, ttl]) => ttl);
}

// Read at import, before the tests clear the mock's calls.
const [sentryMetadata] = vi.mocked(withSentryHandler).mock.calls[0]!;

describe('article consumer Sentry metadata', () => {
  it('tags Sentry errors with the role and the article domain', () => {
    expect(sentryMetadata(BASE_MESSAGE).tags).toMatchObject({
      worker_role: config.workerRole,
      domain: 'example.com',
    });
  });
});

describe('article consumer', () => {
  beforeEach(() => {
    // Happy path: not extracted recently, lock free, no prior content.
    vi.mocked(getRedisKeyTimestampValue).mockResolvedValue(null);
    vi.mocked(acquireRedisKeyLockToken).mockResolvedValue('lock-token');
    vi.mocked(getRedisKeyStringValue).mockResolvedValue(null);
    vi.mocked(handleArticleExtraction).mockResolvedValue(EVENT);
    vi.mocked(publishMessage).mockResolvedValue('message-id');
    vi.mocked(releaseRedisKeyLock).mockResolvedValue();
    vi.mocked(setRedisKeyTimestampWithTTL).mockResolvedValue();
    vi.mocked(setRedisKeyStringValue).mockResolvedValue();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('subscribes to the configured crawl-article subscription', () => {
    startArticleConsumer();
    expect(startSubscriber).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionName: crawlConfig.crawlArticlePubSub.subscription,
        maxMessages: config.maxMessages,
      }),
    );
  });

  it('extracts, publishes, and stores the content hash for a new article', async () => {
    await registeredHandler()(BASE_MESSAGE);

    expect(handleArticleExtraction).toHaveBeenCalledWith(BASE_MESSAGE);
    expect(publishMessage).toHaveBeenCalledWith(
      crawlConfig.articlesTopic,
      EVENT,
    );
    expect(setRedisKeyStringValue).toHaveBeenCalledOnce();
    expect(releaseRedisKeyLock).toHaveBeenCalledWith(
      expect.any(String),
      'lock-token',
    );
  });

  it('keys the marker, lock, and content hash on the message URL', async () => {
    await registeredHandler()(BASE_MESSAGE);

    const extractedKey = buildRedisArticleExtractedKey(BASE_MESSAGE.url);
    const lockKey = buildRedisArticleLockKey(BASE_MESSAGE.url);
    const contentKey = buildRedisArticleContentKey(BASE_MESSAGE.url);
    expect(getRedisKeyTimestampValue).toHaveBeenCalledWith(extractedKey);
    expect(acquireRedisKeyLockToken).toHaveBeenCalledWith(
      lockKey,
      config.lockTtlSeconds,
    );
    expect(
      vi.mocked(setRedisKeyTimestampWithTTL).mock.calls.map(([key]) => key),
    ).toEqual([extractedKey, extractedKey]);
    expect(getRedisKeyStringValue).toHaveBeenCalledWith(contentKey);
    expect(setRedisKeyStringValue).toHaveBeenCalledWith(
      contentKey,
      expect.any(String),
    );
    expect(releaseRedisKeyLock).toHaveBeenCalledWith(lockKey, 'lock-token');
  });

  it('claims the marker before extracting, then confirms it for the refresh window', async () => {
    await registeredHandler()(BASE_MESSAGE);

    expect(markerTtls()).toEqual([CLAIM_TTL_SECONDS, REFRESH_TTL_SECONDS]);
    const [claimOrder, confirmOrder] = vi.mocked(setRedisKeyTimestampWithTTL)
      .mock.invocationCallOrder;
    const extractOrder = vi.mocked(handleArticleExtraction).mock
      .invocationCallOrder[0]!;
    const publishOrder = vi.mocked(publishMessage).mock.invocationCallOrder[0]!;
    expect(claimOrder).toBeLessThan(extractOrder);
    expect(confirmOrder).toBeGreaterThan(publishOrder);
  });

  it('skips an article extracted within its refresh window', async () => {
    vi.mocked(getRedisKeyTimestampValue).mockResolvedValue(Date.now());

    await registeredHandler()(BASE_MESSAGE);

    expect(acquireRedisKeyLockToken).not.toHaveBeenCalled();
    expect(handleArticleExtraction).not.toHaveBeenCalled();
    expect(publishMessage).not.toHaveBeenCalled();
  });

  it('honors the per-message refresh window', async () => {
    vi.mocked(getRedisKeyTimestampValue).mockResolvedValue(
      Date.now() - 10 * 60_000,
    );

    // A 10-minute-old marker is stale for a 5-minute window.
    await registeredHandler()({ ...BASE_MESSAGE, article_refresh_minutes: 5 });
    expect(handleArticleExtraction).toHaveBeenCalledOnce();

    // The same marker is fresh for a 60-minute window.
    vi.mocked(handleArticleExtraction).mockClear();
    await registeredHandler()({ ...BASE_MESSAGE, article_refresh_minutes: 60 });
    expect(handleArticleExtraction).not.toHaveBeenCalled();
  });

  it('re-checks the marker under the lock and skips a concurrent duplicate', async () => {
    // A concurrent job claimed the marker between the first check and
    // this worker getting the lock.
    vi.mocked(getRedisKeyTimestampValue)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(Date.now());

    await registeredHandler()(BASE_MESSAGE);

    expect(acquireRedisKeyLockToken).toHaveBeenCalled();
    expect(handleArticleExtraction).not.toHaveBeenCalled();
    expect(releaseRedisKeyLock).toHaveBeenCalled();
  });

  it('skips when another worker holds the lock', async () => {
    vi.mocked(acquireRedisKeyLockToken).mockResolvedValue(null);

    await registeredHandler()(BASE_MESSAGE);

    expect(handleArticleExtraction).not.toHaveBeenCalled();
    expect(publishMessage).not.toHaveBeenCalled();
    expect(releaseRedisKeyLock).not.toHaveBeenCalled();
  });

  it('skips publishing unchanged content but still stores the hash', async () => {
    await registeredHandler()(BASE_MESSAGE);
    const storedHash = vi.mocked(setRedisKeyStringValue).mock.calls[0]![1];
    vi.clearAllMocks();

    vi.mocked(getRedisKeyStringValue).mockResolvedValue(storedHash);
    await registeredHandler()(BASE_MESSAGE);

    expect(publishMessage).not.toHaveBeenCalled();
    expect(setRedisKeyStringValue).toHaveBeenCalledOnce();
  });

  it('republishes changed content and stores the new hash', async () => {
    await registeredHandler()(BASE_MESSAGE);
    const storedHash = vi.mocked(setRedisKeyStringValue).mock.calls[0]![1];
    vi.clearAllMocks();

    const changed = { ...EVENT, headline: 'Revised Headline' };
    vi.mocked(getRedisKeyStringValue).mockResolvedValue(storedHash);
    vi.mocked(handleArticleExtraction).mockResolvedValue(changed);
    await registeredHandler()(BASE_MESSAGE);

    expect(publishMessage).toHaveBeenCalledWith(
      crawlConfig.articlesTopic,
      changed,
    );
    const newHash = vi.mocked(setRedisKeyStringValue).mock.calls[0]![1];
    expect(newHash).not.toBe(storedHash);
  });

  it('ignores extracted_at when detecting content changes', async () => {
    await registeredHandler()(BASE_MESSAGE);
    const storedHash = vi.mocked(setRedisKeyStringValue).mock.calls[0]![1];
    vi.mocked(publishMessage).mockClear();

    vi.mocked(getRedisKeyStringValue).mockResolvedValue(storedHash);
    vi.mocked(handleArticleExtraction).mockResolvedValue({
      ...EVENT,
      extracted_at: '2026-02-01T00:00:00.000Z',
    });
    await registeredHandler()(BASE_MESSAGE);

    expect(publishMessage).not.toHaveBeenCalled();
  });

  it('publishes nothing for an ineligible article but confirms the marker', async () => {
    vi.mocked(handleArticleExtraction).mockResolvedValue(undefined);

    await registeredHandler()(BASE_MESSAGE);

    expect(publishMessage).not.toHaveBeenCalled();
    expect(setRedisKeyStringValue).not.toHaveBeenCalled();
    expect(markerTtls()).toEqual([CLAIM_TTL_SECONDS, REFRESH_TTL_SECONDS]);
  });

  it('keeps only the claim and releases the lock when extraction throws', async () => {
    vi.mocked(handleArticleExtraction).mockRejectedValue(new Error('zyte'));

    await expect(registeredHandler()(BASE_MESSAGE)).rejects.toThrow('zyte');

    expect(markerTtls()).toEqual([CLAIM_TTL_SECONDS]);
    expect(publishMessage).not.toHaveBeenCalled();
    expect(releaseRedisKeyLock).toHaveBeenCalledWith(
      expect.any(String),
      'lock-token',
    );
  });

  it('keeps only the claim when publishing throws', async () => {
    vi.mocked(publishMessage).mockRejectedValue(new Error('publish failed'));

    await expect(registeredHandler()(BASE_MESSAGE)).rejects.toThrow(
      'publish failed',
    );

    expect(markerTtls()).toEqual([CLAIM_TTL_SECONDS]);
    expect(setRedisKeyStringValue).not.toHaveBeenCalled();
  });

  it('keeps only the claim when storing the hash throws after a publish', async () => {
    // The redelivery finds no stored hash and publishes again, so the
    // event is duplicated rather than lost.
    vi.mocked(setRedisKeyStringValue).mockRejectedValue(
      new Error('redis blip'),
    );

    await expect(registeredHandler()(BASE_MESSAGE)).rejects.toThrow(
      'redis blip',
    );

    expect(publishMessage).toHaveBeenCalledOnce();
    expect(markerTtls()).toEqual([CLAIM_TTL_SECONDS]);
    expect(releaseRedisKeyLock).toHaveBeenCalled();
  });

  it('extracts nothing and releases the lock when the claim fails', async () => {
    vi.mocked(setRedisKeyTimestampWithTTL).mockRejectedValue(
      new Error('redis blip'),
    );

    await expect(registeredHandler()(BASE_MESSAGE)).rejects.toThrow(
      'redis blip',
    );

    expect(handleArticleExtraction).not.toHaveBeenCalled();
    expect(publishMessage).not.toHaveBeenCalled();
    expect(releaseRedisKeyLock).toHaveBeenCalledWith(
      expect.any(String),
      'lock-token',
    );
  });

  it('still succeeds when releasing the lock fails', async () => {
    vi.mocked(releaseRedisKeyLock).mockRejectedValue(new Error('redis blip'));

    await expect(registeredHandler()(BASE_MESSAGE)).resolves.toBeUndefined();
    expect(publishMessage).toHaveBeenCalledOnce();
  });
});
