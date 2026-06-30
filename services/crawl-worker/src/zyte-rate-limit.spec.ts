import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('crawl-common', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crawl-common')>();
  return { ...actual, acquireRateLimitToken: vi.fn() };
});

// Mutable config so each test can toggle the rate limit.
vi.mock('./config.js', () => ({
  default: {
    workerRole: 'article',
    zyteRateLimitPerMinute: 0,
    zyteRateLimitBurst: 0,
    zyteRateLimitMaxWaitMs: 200,
  },
}));

import { acquireRateLimitToken } from 'crawl-common';
import config from './config.js';
import { awaitZyteToken } from './zyte-rate-limit.js';

const acquire = vi.mocked(acquireRateLimitToken);

describe('awaitZyteToken', () => {
  beforeEach(() => {
    config.zyteRateLimitPerMinute = 600;
    config.zyteRateLimitBurst = 0;
    config.zyteRateLimitMaxWaitMs = 200;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns without touching Redis when rate limiting is disabled', async () => {
    config.zyteRateLimitPerMinute = 0;

    await awaitZyteToken();

    expect(acquire).not.toHaveBeenCalled();
  });

  it('returns once a token is granted, defaulting burst to the per-minute rate', async () => {
    acquire.mockResolvedValue({ allowed: true, retryAfterMs: 0 });

    await awaitZyteToken();

    expect(acquire).toHaveBeenCalledWith('zyte:rate-limit:article', 600, 600);
  });

  it('waits for a refill, then proceeds', async () => {
    acquire
      .mockResolvedValueOnce({ allowed: false, retryAfterMs: 5 })
      .mockResolvedValue({ allowed: true, retryAfterMs: 0 });

    await awaitZyteToken();

    expect(acquire).toHaveBeenCalledTimes(2);
  });

  it('throws when no token becomes available within the max wait', async () => {
    config.zyteRateLimitMaxWaitMs = 30;
    acquire.mockResolvedValue({ allowed: false, retryAfterMs: 5 });

    await expect(awaitZyteToken()).rejects.toThrow(/rate limit exceeded/);
  });
});
