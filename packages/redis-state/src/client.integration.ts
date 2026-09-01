import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireLock,
  acquireRateLimitToken,
  getString,
  getTimestamp,
  initRedisClient,
  releaseLock,
  setString,
  setTimestamp,
  shutdownRedis,
} from './client.js';

// Pinned for reproducibility. Bump deliberately.
const REDIS_IMAGE = 'redis:7.4.1-alpine';
// Generous so a cold image pull on a slow Docker VM (e.g. macOS) does
// not trip the testcontainers default before Redis is ready.
const CONTAINER_START_TIMEOUT_MS = 180_000;
// The hook must outlast the container startup timeout so testcontainers
// owns the deadline and reports a clear error, rather than vitest
// killing the hook first.
const HOOK_TIMEOUT_MS = CONTAINER_START_TIMEOUT_MS + 30_000;

/**
 * Integration test for the Redis state client. Runs against a real
 * Redis via testcontainers, exercising the timestamp, string,
 * and lock operations end-to-end through ioredis.
 */
describe('redis state client integration', () => {
  let container: StartedTestContainer;
  let host: string;
  let port: number;

  beforeAll(async () => {
    container = await new GenericContainer(REDIS_IMAGE)
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
      .withStartupTimeout(CONTAINER_START_TIMEOUT_MS)
      .start();
    host = container.getHost();
    port = container.getMappedPort(6379);
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await shutdownRedis();
    await container?.stop();
  });

  beforeEach(async () => {
    // A fresh client per test. Tests use distinct keys, so they do
    // not collide in the container's shared keyspace.
    await shutdownRedis();
    initRedisClient({
      host,
      port,
      keyPrefix: `${expect.getState().testPath}:`,
    });
  });

  it('round-trips a timestamp', async () => {
    const before = Date.now();
    await setTimestamp('page:fetch:x', 60);
    const stored = await getTimestamp('page:fetch:x');
    expect(stored).not.toBeNull();
    expect(stored!).toBeGreaterThanOrEqual(before);
  });

  it('returns null for a missing timestamp', async () => {
    expect(await getTimestamp('page:fetch:missing')).toBeNull();
  });

  it('treats a non-numeric stored value as no timestamp', async () => {
    await setString('page:fetch:corrupt', 'not-a-number', 60);
    expect(await getTimestamp('page:fetch:corrupt')).toBeNull();
  });

  it('rejects a non-positive lock TTL', async () => {
    await expect(acquireLock('article:lock:bad', 0)).rejects.toThrow(
      /positive/,
    );
  });

  it('expires a timestamp after its TTL', async () => {
    await setTimestamp('page:fetch:ttl', 1);
    await new Promise((r) => setTimeout(r, 1_500));
    expect(await getTimestamp('page:fetch:ttl')).toBeNull();
  });

  it('round-trips a string', async () => {
    await setString('article:content:x', 'deadbeef', 60);
    expect(await getString('article:content:x')).toBe('deadbeef');
  });

  it('acquires a lock once and blocks a second acquirer', async () => {
    const token = await acquireLock('article:lock:x', 60);
    expect(token).not.toBeNull();
    expect(await acquireLock('article:lock:x', 60)).toBeNull();
  });

  it('allows re-acquisition after release', async () => {
    const token = await acquireLock('article:lock:y', 60);
    await releaseLock('article:lock:y', token!);
    expect(await acquireLock('article:lock:y', 60)).not.toBeNull();
  });

  it('does not release a lock held with a different token', async () => {
    const token = await acquireLock('article:lock:z', 60);
    await releaseLock('article:lock:z', 'someone-elses-token');
    // The real holder still owns it, so a new acquire fails.
    expect(await acquireLock('article:lock:z', 60)).toBeNull();
    await releaseLock('article:lock:z', token!);
  });

  it('expires a lock after its TTL so it can be re-acquired', async () => {
    await acquireLock('article:lock:ttl', 1);
    await new Promise((r) => setTimeout(r, 1_500));
    expect(await acquireLock('article:lock:ttl', 60)).not.toBeNull();
  });

  it('grants up to the burst, then throttles the token bucket', async () => {
    // 60/min = 1/sec, burst 2: two immediate tokens, then empty.
    const first = await acquireRateLimitToken('zyte:rate:a', 60, 2);
    const second = await acquireRateLimitToken('zyte:rate:a', 60, 2);
    const third = await acquireRateLimitToken('zyte:rate:a', 60, 2);
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(third.allowed).toBe(false);
    expect(third.retryAfterMs).toBeGreaterThan(0);
  });

  it('refills the bucket over time', async () => {
    // 600/min = 10/sec, burst 1: take the token, wait for one refill.
    await acquireRateLimitToken('zyte:rate:b', 600, 1);
    const blocked = await acquireRateLimitToken('zyte:rate:b', 600, 1);
    expect(blocked.allowed).toBe(false);

    // Poll for the refill rather than sleeping a fixed span: the bucket
    // refills on the Redis server clock, so a fixed Node setTimeout can
    // fall short under scheduler coarseness or load and flake. A blocked
    // call does not consume a token, so polling is side-effect free.
    const deadline = Date.now() + blocked.retryAfterMs + 1_000;
    let refilled = await acquireRateLimitToken('zyte:rate:b', 600, 1);
    while (!refilled.allowed && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
      refilled = await acquireRateLimitToken('zyte:rate:b', 600, 1);
    }
    expect(refilled.allowed).toBe(true);
  });

  it('rejects a non-positive rate or a sub-one burst', async () => {
    await expect(acquireRateLimitToken('zyte:rate:c', 0, 5)).rejects.toThrow(
      /ratePerMinute must be positive/,
    );
    await expect(acquireRateLimitToken('zyte:rate:c', 60, 0)).rejects.toThrow(
      /burst must be at least 1/,
    );
  });
});
