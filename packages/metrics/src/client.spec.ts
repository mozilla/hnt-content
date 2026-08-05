import type { ClientOptions } from 'hot-shots';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockClient, captured } = vi.hoisted(() => ({
  mockClient: {
    increment: vi.fn(),
    timing: vi.fn(),
    // close() is also called without a callback, on re-init.
    close: vi.fn((cb?: () => void) => cb?.()),
  },
  captured: {} as { opts: ClientOptions },
}));

vi.mock('hot-shots', () => ({
  StatsD: vi.fn(function (opts: ClientOptions) {
    captured.opts = opts;
    return mockClient;
  }),
}));

// Mutable config so tests can toggle the host (enabled/disabled).
vi.mock('./config.js', () => ({
  default: { host: 'gateway', port: 8125, environment: 'dev' },
}));

import config from './config.js';
import {
  OUTCOME,
  count,
  initMetrics,
  shutdownMetrics,
  time,
  timing,
} from './client.js';

describe('metrics client', () => {
  beforeEach(() => {
    config.host = 'gateway';
    config.environment = 'dev';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    await shutdownMetrics();
    vi.useRealTimers();
    // clearAllMocks resets the plain vi.fn history, which restoreAllMocks
    // leaves alone; restoreAllMocks un-spies console.
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('builds the client with gateway options and identity tags', () => {
    initMetrics({ service: 'crawl-worker', workerRole: 'article' });

    // Asserted as configuration: hot-shots is trusted to cache DNS, batch,
    // and stay out of Datadog mode as documented, so what needs guarding is
    // that we still ask it to. datadog/includeDataDogTags matter most, since
    // any of eleven DD_* env vars in the pod flips them on, changing the wire.
    expect(captured.opts).toMatchObject({
      host: 'gateway',
      port: 8125,
      cacheDns: true,
      maxBufferSize: 1432,
      datadog: false,
      includeDataDogTags: false,
      globalTags: {
        service: 'crawl-worker',
        env: 'dev',
        worker_role: 'article',
      },
    });
  });

  it('omits env and worker_role when neither is supplied', () => {
    config.environment = undefined;
    initMetrics({ service: 'crawl-agent' });

    expect(captured.opts.globalTags).toEqual({ service: 'crawl-agent' });
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('ENVIRONMENT empty'),
    );
  });

  it('emits counters and timings with per-call tags', () => {
    initMetrics({ service: 'crawl-worker' });

    count('crawl.tick.enqueued', 3, { kind: 'page' });
    count('crawl.tick.ran');
    timing('crawl.message.duration_ms', 42, { outcome: OUTCOME.success });

    expect(mockClient.increment).toHaveBeenCalledWith(
      'crawl.tick.enqueued',
      3,
      {
        kind: 'page',
      },
    );
    expect(mockClient.increment).toHaveBeenCalledWith(
      'crawl.tick.ran',
      1,
      undefined,
    );
    expect(mockClient.timing).toHaveBeenCalledWith(
      'crawl.message.duration_ms',
      42,
      { outcome: 'success' },
    );
  });

  it('drops tags left undefined so callers need no branching', () => {
    initMetrics({ service: 'crawl-worker' });

    count('crawl.message.processed', 1, {
      outcome: OUTCOME.success,
      kind: undefined,
    });

    expect(mockClient.increment).toHaveBeenCalledWith(
      'crawl.message.processed',
      1,
      { outcome: 'success' },
    );
  });

  it('records timing tagged by outcome when the fn resolves and rejects', async () => {
    initMetrics({ service: 'crawl-worker' });

    const value = await time(
      'crawl.zyte.duration_ms',
      () => Promise.resolve(7),
      { extraction: 'article' },
    );
    expect(value).toBe(7);

    await expect(
      time('crawl.zyte.duration_ms', () => Promise.reject(new Error('boom')), {
        extraction: 'article',
      }),
    ).rejects.toThrow('boom');

    // The reject path is the regression guard: a timing() moved out of the
    // finally would stop recording latency for failed Zyte calls, and a
    // shared outcome tag would hide fast failures inside the success p95.
    expect(mockClient.timing).toHaveBeenCalledTimes(2);
    expect(mockClient.timing).toHaveBeenNthCalledWith(
      1,
      'crawl.zyte.duration_ms',
      expect.any(Number),
      { extraction: 'article', outcome: 'success' },
    );
    expect(mockClient.timing).toHaveBeenNthCalledWith(
      2,
      'crawl.zyte.duration_ms',
      expect.any(Number),
      { extraction: 'article', outcome: 'failure' },
    );
  });

  it('overwrites an outcome tag supplied by the caller', async () => {
    initMetrics({ service: 'crawl-worker' });

    await time('crawl.zyte.duration_ms', () => Promise.resolve(1), {
      outcome: OUTCOME.failure,
    });

    expect(mockClient.timing).toHaveBeenCalledWith(
      'crawl.zyte.duration_ms',
      expect.any(Number),
      { outcome: 'success' },
    );
  });

  it('logs one send error per window and counts the rest', () => {
    vi.useFakeTimers();
    initMetrics({ service: 'crawl-worker' });
    const errorHandler = captured.opts.errorHandler!;

    errorHandler(new Error('getaddrinfo ENOTFOUND'));
    errorHandler(new Error('getaddrinfo ENOTFOUND'));
    errorHandler(new Error('getaddrinfo ENOTFOUND'));
    expect(console.error).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_000);
    errorHandler(new Error('getaddrinfo ENOTFOUND'));

    expect(console.error).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenLastCalledWith(
      expect.stringContaining('2 similar suppressed'),
    );
  });

  it('is a no-op when STATSD_HOST is empty', () => {
    config.host = '';
    initMetrics({ service: 'crawl-worker' });

    count('crawl.message.processed', 1, { outcome: OUTCOME.success });
    timing('crawl.message.duration_ms', 5);

    expect(mockClient.increment).not.toHaveBeenCalled();
    expect(mockClient.timing).not.toHaveBeenCalled();
  });

  it('closes the previous client and builds a new one on re-init', () => {
    initMetrics({ service: 'crawl-agent' });
    initMetrics({ service: 'crawl-worker' });

    expect(mockClient.close).toHaveBeenCalledOnce();
    expect(captured.opts.globalTags).toEqual({
      service: 'crawl-worker',
      env: 'dev',
    });
  });

  it('stops emitting when re-initialized with an empty host', () => {
    initMetrics({ service: 'crawl-worker' });
    config.host = '';
    initMetrics({ service: 'crawl-worker' });

    count('crawl.message.processed');

    expect(mockClient.increment).not.toHaveBeenCalled();
  });

  it('closes the client on shutdown', async () => {
    initMetrics({ service: 'crawl-worker' });
    await shutdownMetrics();
    expect(mockClient.close).toHaveBeenCalledOnce();
  });
});
