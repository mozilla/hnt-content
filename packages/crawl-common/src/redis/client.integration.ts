import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireLock,
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
const CONTAINER_START_TIMEOUT_MS = 120_000;

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
      .start();
    host = container.getHost();
    port = container.getMappedPort(6379);
  }, CONTAINER_START_TIMEOUT_MS);

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
});
