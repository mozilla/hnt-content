import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ACK_DEADLINE_SECONDS_DEFAULT,
  ACK_DEADLINE_SECONDS_MIN,
  APP_PORT_DEFAULT,
  ARTICLE_FETCH_TTL_MINUTES_DEFAULT,
  LOCK_TTL_ACK_SECONDS_DELTA,
  PUBSUB_MAX_MESSAGES_DEFAULT,
  REDIS_PORT_DEFAULT,
  ZYTE_RATE_LIMIT_PER_MINUTE_ARTICLE,
  ZYTE_RATE_LIMIT_PER_MINUTE_DISCOVERY,
} from './constants.js';

const ORIGINAL_ENV = { ...process.env };

/** Import a fresh config module with the given env overrides applied. */
async function loadConfig(
  overrides: Record<string, string | undefined>,
): Promise<(typeof import('./index.js'))['default']> {
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV, ...overrides };
  return (await import('./index.js')).default;
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe('config validation', () => {
  it('returns a config object with minimal env config provided', async () => {
    // loading the config module with minimal env should not throw
    await loadConfig({});
  });

  it('throws when minimal env config values are not present', async () => {
    await expect(loadConfig({ ZYTE_API_KEY: undefined })).rejects.toThrow(
      expect.objectContaining({
        message: 'crawl worker config validation failed',
      }),
    );
  });
});

describe('worker config lock TTL', () => {
  it('derives the lock TTL from the ack deadline and caps the max extension to it', async () => {
    const config = await loadConfig({});

    expect(config.ackDeadlineSeconds).toBe(ACK_DEADLINE_SECONDS_DEFAULT);
    expect(config.lockTtlSeconds).toBe(
      ACK_DEADLINE_SECONDS_DEFAULT - LOCK_TTL_ACK_SECONDS_DELTA,
    );
    // The max extension defaults to the lock TTL so the lease can never
    // outlive the lock.
    expect(config.maxExtensionSeconds).toBe(config.lockTtlSeconds);
  });

  it('tracks ACK_DEADLINE_SECONDS for the lock TTL and default max extension', async () => {
    const ack_deadline_sec = 120;

    const config = await loadConfig({
      ACK_DEADLINE_SECONDS: `${ack_deadline_sec}`,
    });

    expect(config.lockTtlSeconds).toBe(
      ack_deadline_sec - LOCK_TTL_ACK_SECONDS_DELTA,
    );

    // When MAX_EXTENSION_SECONDS is not provided, it should fall back to lockTtlSeconds
    expect(config.maxExtensionSeconds).toBe(config.lockTtlSeconds);

    // The lock must clear before a crashed worker's message redelivers
    // around the ack deadline, so the retry re-fetches.
    expect(config.lockTtlSeconds).toBeLessThan(config.ackDeadlineSeconds);
  });

  it('honors a MAX_EXTENSION_SECONDS at or below the lock TTL', async () => {
    const max_ext_secs = 120;

    const config = await loadConfig({
      MAX_EXTENSION_SECONDS: `${max_ext_secs}`,
    });

    expect(config.maxExtensionSeconds).toBe(max_ext_secs);
    expect(config.maxExtensionSeconds).toBeLessThanOrEqual(
      config.lockTtlSeconds,
    );
  });

  it('throws when MAX_EXTENSION_SECONDS exceeds the lock TTL', async () => {
    // A lease longer than the lock lets a slow handler keep the message
    // after its lock expired, so two workers could process the same URL.
    await expect(
      loadConfig({ ACK_DEADLINE_SECONDS: '300', MAX_EXTENSION_SECONDS: '600' }),
    ).rejects.toThrow('MAX_EXTENSION_SECONDS');
  });

  it('throws when the ack deadline is too small for a positive lock TTL', async () => {
    await expect(
      loadConfig({ ACK_DEADLINE_SECONDS: `${ACK_DEADLINE_SECONDS_MIN}` }),
    ).rejects.toThrow('ACK_DEADLINE_SECONDS');
  });
});

describe('worker config Pub/Sub flow control', () => {
  it('defaults the outstanding-message cap to PUBSUB_MAX_MESSAGES_DEFAULT', async () => {
    const config = await loadConfig({});

    expect(config.pubsubMaxMessages).toBe(PUBSUB_MAX_MESSAGES_DEFAULT);
  });

  it('reads PUBSUB_MAX_MESSAGES when set', async () => {
    const config = await loadConfig({
      PUBSUB_MAX_MESSAGES: '4',
    });

    expect(config.pubsubMaxMessages).toBe(4);
  });

  it('throws on a non-positive cap', async () => {
    await expect(loadConfig({ PUBSUB_MAX_MESSAGES: '0' })).rejects.toThrow(
      'PUBSUB_MAX_MESSAGES',
    );
  });
});

describe('worker config Zyte rate limit', () => {
  it('defaults to the article share of the account limit', async () => {
    const config = await loadConfig({
      WORKER_ROLE: 'article',
    });

    expect(config.zyteRateLimitPerMinute).toBe(
      ZYTE_RATE_LIMIT_PER_MINUTE_ARTICLE,
    );
  });

  it('defaults to the smaller discovery share', async () => {
    const discoveryConfig = await loadConfig({
      WORKER_ROLE: 'discovery',
    });

    expect(discoveryConfig.zyteRateLimitPerMinute).toBe(
      ZYTE_RATE_LIMIT_PER_MINUTE_DISCOVERY,
    );

    // The two role shares sum to the per-account limit.
    const articleConfig = await loadConfig({
      WORKER_ROLE: 'article',
    });
    expect(
      discoveryConfig.zyteRateLimitPerMinute +
        articleConfig.zyteRateLimitPerMinute,
    ).toBe(
      ZYTE_RATE_LIMIT_PER_MINUTE_ARTICLE + ZYTE_RATE_LIMIT_PER_MINUTE_DISCOVERY,
    );
  });

  it('reads ZYTE_RATE_LIMIT_PER_MINUTE when set, including 0 to disable', async () => {
    expect(
      (
        await loadConfig({
          WORKER_ROLE: 'discovery',
          ZYTE_RATE_LIMIT_PER_MINUTE: '600',
        })
      ).zyteRateLimitPerMinute,
    ).toBe(600);

    expect(
      (
        await loadConfig({
          ZYTE_RATE_LIMIT_PER_MINUTE: '0',
        })
      ).zyteRateLimitPerMinute,
    ).toBe(0);
  });
});

describe('worker config blank numeric env vars', () => {
  it('treats a blank numeric env var as unset and uses the fallback', async () => {
    const config = await loadConfig({
      PORT: '',
      ARTICLE_FETCH_TTL_MINUTES: '  ',
      REDIS_PORT: '',
    });

    expect(config.port).toBe(APP_PORT_DEFAULT);
    expect(config.articleFetchTtlMinutes).toBe(
      ARTICLE_FETCH_TTL_MINUTES_DEFAULT,
    );
    expect(config.redisPort).toBe(REDIS_PORT_DEFAULT);
  });

  it('uses the fallback for a blank guarded var instead of crashing', async () => {
    const config = await loadConfig({
      PUBSUB_MAX_MESSAGES: '',
    });

    expect(config.pubsubMaxMessages).toBe(PUBSUB_MAX_MESSAGES_DEFAULT);
  });
});
