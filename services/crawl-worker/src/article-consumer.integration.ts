import {
  buildRedisArticleContentKey,
  buildRedisArticleExtractedKey,
  buildRedisArticleLockKey,
  type ArticleEvent,
  type CrawlArticleMessage,
} from 'crawl-common';
import { publishMessage, startSubscriber } from 'pubsub';
import {
  acquireRedisKeyLockToken,
  DEFAULT_TTL_SECONDS,
  initRedisClient,
  shutdownRedis,
} from 'redis-state';
import {
  RedisContainer,
  type StartedRedisContainer,
} from '@testcontainers/redis';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { startArticleConsumer } from './article-consumer.js';
import config from './config.js';
import { handleArticleExtraction } from './handlers/extract-article.js';
import { BASE_MESSAGE } from './handlers/test-helpers.js';

vi.mock('pubsub', () => ({
  publishMessage: vi.fn(),
  sentryPubSubErrorHandler: vi.fn(() => vi.fn()),
  startSubscriber: vi.fn(),
}));
vi.mock('./handlers/extract-article.js', () => ({
  handleArticleExtraction: vi.fn(),
}));

// RedisContainer requires an image. This is the tag the redis-state
// integration test pins.
const REDIS_IMAGE = 'redis:7.4.1-alpine';
// The hook must outlast RedisContainer's 120s startup timeout so
// testcontainers owns the deadline and reports a clear error.
const HOOK_TIMEOUT_MS = 150_000;
// A TTL counts down from the moment the key is written, so by the time
// a test reads it a few seconds may have passed.
const TTL_SLACK_SECONDS = 5;

const EVENT: ArticleEvent = {
  url: BASE_MESSAGE.url,
  canonical_url: BASE_MESSAGE.url,
  extracted_at: '2026-01-01T00:00:00.000Z',
  headline: 'Test Headline',
};

const EXTRACTED_KEY = buildRedisArticleExtractedKey(BASE_MESSAGE.url);
const LOCK_KEY = buildRedisArticleLockKey(BASE_MESSAGE.url);
const CONTENT_KEY = buildRedisArticleContentKey(BASE_MESSAGE.url);

/** Start the consumer and return the handler it registered. */
function registeredHandler(): (message: CrawlArticleMessage) => Promise<void> {
  startArticleConsumer();
  return vi.mocked(startSubscriber).mock.calls[0]![0].handler;
}

/**
 * Integration test for the article consumer's Redis guard. Runs the
 * real redis-state client against Redis via testcontainers, with Zyte
 * and Pub/Sub mocked.
 */
describe('article consumer integration', () => {
  let container: StartedRedisContainer;

  /** Run a redis-cli command in the container and return its output. */
  async function redisCli(cmd: string, ...args: string[]): Promise<string> {
    return (await container.executeCliCmd(cmd, args)).trim();
  }

  /** Return the remaining TTL of a key in seconds (-2 if missing). */
  async function getRedisTTL(key: string): Promise<number> {
    return Number(await redisCli('TTL', key));
  }

  /**
   * Assert the key was written with a TTL of `seconds`: at most that,
   * and at most TTL_SLACK_SECONDS less.
   */
  async function expectTtlSetTo(key: string, seconds: number): Promise<void> {
    const ttl = await getRedisTTL(key);
    expect(ttl).toBeLessThanOrEqual(seconds);
    expect(ttl).toBeGreaterThan(seconds - TTL_SLACK_SECONDS);
  }

  beforeAll(async () => {
    container = await new RedisContainer(REDIS_IMAGE).start();
    initRedisClient({ host: container.getHost(), port: container.getPort() });
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await shutdownRedis();
    await container?.stop();
  });

  beforeEach(async () => {
    // Every test uses the same article keys, so start from empty.
    await redisCli('FLUSHALL');
    vi.mocked(handleArticleExtraction).mockResolvedValue(EVENT);
    vi.mocked(publishMessage).mockResolvedValue('message-id');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('extracts once across concurrent duplicate deliveries', async () => {
    // A slow extraction keeps the first delivery inside the lock while
    // the others run.
    vi.mocked(handleArticleExtraction).mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return EVENT;
    });
    const handler = registeredHandler();

    await Promise.all(Array.from({ length: 5 }, () => handler(BASE_MESSAGE)));

    // The lock and re-check let only one delivery reach Zyte.
    expect(handleArticleExtraction).toHaveBeenCalledOnce();
    // So the article is published once, not once per delivery.
    expect(publishMessage).toHaveBeenCalledOnce();
  });

  it('sets the marker for the refresh window and skips a redelivery', async () => {
    const handler = registeredHandler();
    await handler(BASE_MESSAGE);

    // Success replaces the short claim with the message's refresh window.
    await expectTtlSetTo(
      EXTRACTED_KEY,
      BASE_MESSAGE.article_refresh_minutes * 60,
    );
    // The hash keeps the 30-day default so it outlives the marker.
    await expectTtlSetTo(CONTENT_KEY, DEFAULT_TTL_SECONDS);
    // The lock is released once the job is done.
    expect(await redisCli('EXISTS', LOCK_KEY)).toBe('0');

    await handler(BASE_MESSAGE);
    // The fresh marker makes the redelivery skip without calling Zyte.
    expect(handleArticleExtraction).toHaveBeenCalledOnce();
  });

  it('keeps the attempt claim after a failed extraction and skips a redelivery', async () => {
    vi.mocked(handleArticleExtraction).mockRejectedValueOnce(new Error('zyte'));
    const handler = registeredHandler();

    // The error propagates so Pub/Sub nacks and redelivers the message.
    await expect(handler(BASE_MESSAGE)).rejects.toThrow('zyte');

    // Only the claim remains, so the URL is retried once it expires.
    await expectTtlSetTo(EXTRACTED_KEY, config.articleAttemptTtlMinutes * 60);
    // The lock is released even though the job failed.
    expect(await redisCli('EXISTS', LOCK_KEY)).toBe('0');

    await handler(BASE_MESSAGE);
    // The claim makes the redelivery skip instead of repeating the failure.
    expect(handleArticleExtraction).toHaveBeenCalledOnce();
  });

  it('sets the marker for the refresh window after a permanent failure', async () => {
    vi.mocked(handleArticleExtraction).mockResolvedValue(undefined);

    await registeredHandler()(BASE_MESSAGE);

    // A permanent failure is confirmed like a success, so it isn't retried.
    await expectTtlSetTo(
      EXTRACTED_KEY,
      BASE_MESSAGE.article_refresh_minutes * 60,
    );
    // No event means there is no content to hash.
    expect(await redisCli('EXISTS', CONTENT_KEY)).toBe('0');
    // An ineligible article never reaches the articles topic.
    expect(publishMessage).not.toHaveBeenCalled();
  });

  it('skips an article locked by another worker', async () => {
    await acquireRedisKeyLockToken(LOCK_KEY, config.lockTtlSeconds);

    await registeredHandler()(BASE_MESSAGE);

    // The worker holding the lock does the extraction, not this one.
    expect(handleArticleExtraction).not.toHaveBeenCalled();
    // Skipping leaves the marker alone for the lock holder to write.
    expect(await redisCli('EXISTS', EXTRACTED_KEY)).toBe('0');
  });

  it('publishes again only when the content changed', async () => {
    const handler = registeredHandler();
    await handler(BASE_MESSAGE);

    // Deleting the marker stands in for the refresh window expiring.
    await redisCli('DEL', EXTRACTED_KEY);
    vi.mocked(handleArticleExtraction).mockResolvedValue({
      ...EVENT,
      extracted_at: '2026-02-01T00:00:00.000Z',
    });
    await handler(BASE_MESSAGE);
    // Only extracted_at changed, which the hash ignores, so no republish.
    expect(publishMessage).toHaveBeenCalledOnce();

    await redisCli('DEL', EXTRACTED_KEY);
    vi.mocked(handleArticleExtraction).mockResolvedValue({
      ...EVENT,
      headline: 'Revised Headline',
    });
    await handler(BASE_MESSAGE);
    // A changed headline changes the hash, so the article is republished.
    expect(publishMessage).toHaveBeenCalledTimes(2);
  });
});
