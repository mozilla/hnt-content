import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockClient, captured } = vi.hoisted(() => ({
  mockClient: {
    increment: vi.fn(),
    timing: vi.fn(),
    close: vi.fn((cb: () => void) => cb()),
  },
  captured: { opts: undefined as unknown },
}));

vi.mock('hot-shots', () => ({
  StatsD: vi.fn(function (opts: unknown) {
    captured.opts = opts;
    return mockClient;
  }),
}));

// Mutable config so tests can toggle the host (enabled/disabled).
vi.mock('./config.js', () => ({
  default: { host: 'gateway', port: 8125, environment: 'dev', workerRole: '' },
}));

import config from './config.js';
import {
  count,
  incr,
  initMetrics,
  shutdownMetrics,
  time,
  timing,
} from './client.js';

describe('metrics client', () => {
  beforeEach(() => {
    config.host = 'gateway';
    config.environment = 'dev';
    config.workerRole = '';
  });

  afterEach(async () => {
    await shutdownMetrics();
    vi.clearAllMocks();
    captured.opts = undefined;
  });

  it('builds the client with static service, env, and worker_role tags', () => {
    config.workerRole = 'article';
    initMetrics({ service: 'crawl-worker' });

    expect(captured.opts).toMatchObject({
      host: 'gateway',
      port: 8125,
      globalTags: {
        service: 'crawl-worker',
        env: 'dev',
        worker_role: 'article',
      },
    });
  });

  it('omits worker_role when unset (e.g. the agent)', () => {
    initMetrics({ service: 'crawl-agent' });

    expect(
      (captured.opts as { globalTags: Record<string, string> }).globalTags,
    ).toEqual({ service: 'crawl-agent', env: 'dev' });
  });

  it('emits counters and timings with per-call tags', () => {
    initMetrics({ service: 'crawl-worker' });

    incr('crawl.message.processed', { outcome: 'success' });
    count('crawl.tick.enqueued', 3, { kind: 'page' });
    timing('crawl.message.duration_ms', 42, { outcome: 'success' });

    expect(mockClient.increment).toHaveBeenCalledWith(
      'crawl.message.processed',
      1,
      { outcome: 'success' },
    );
    expect(mockClient.increment).toHaveBeenCalledWith(
      'crawl.tick.enqueued',
      3,
      {
        kind: 'page',
      },
    );
    expect(mockClient.timing).toHaveBeenCalledWith(
      'crawl.message.duration_ms',
      42,
      { outcome: 'success' },
    );
  });

  it('records timing when the wrapped fn resolves and when it rejects', async () => {
    initMetrics({ service: 'crawl-worker' });

    const value = await time(
      'crawl.zyte.duration_ms',
      () => Promise.resolve(7),
      {
        extraction: 'article',
      },
    );
    expect(value).toBe(7);

    await expect(
      time('crawl.zyte.duration_ms', () => Promise.reject(new Error('boom')), {
        extraction: 'article',
      }),
    ).rejects.toThrow('boom');

    // The reject path is the regression guard: a timing() moved out of the
    // finally would stop recording latency for failed Zyte calls.
    expect(mockClient.timing).toHaveBeenCalledTimes(2);
    expect(mockClient.timing).toHaveBeenCalledWith(
      'crawl.zyte.duration_ms',
      expect.any(Number),
      { extraction: 'article' },
    );
  });

  it('is a no-op when STATSD_HOST is empty', () => {
    config.host = '';
    initMetrics({ service: 'crawl-worker' });

    incr('crawl.message.processed', { outcome: 'success' });
    timing('crawl.message.duration_ms', 5);

    expect(mockClient.increment).not.toHaveBeenCalled();
    expect(mockClient.timing).not.toHaveBeenCalled();
  });

  it('closes the client on shutdown', async () => {
    initMetrics({ service: 'crawl-worker' });
    await shutdownMetrics();
    expect(mockClient.close).toHaveBeenCalledOnce();
  });
});
