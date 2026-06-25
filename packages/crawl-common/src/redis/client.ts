/**
 * Redis state client for the crawler. Wraps `ioredis` as a
 * module-level singleton: one client per process, mirroring the
 * Zyte and Pub/Sub clients.
 *
 * The crawler uses Redis for three things: fetch/enqueue
 * timestamps (skip work done recently), distributed locks (guard
 * against concurrent fetches of the same page or article), and
 * article content hashes (skip publishing unchanged content). Key
 * builders live in `keys.ts`; this module owns the operations and
 * the connection lifecycle.
 *
 * Lifecycle:
 * - `initRedisClient` once at startup (after env is loaded).
 * - `shutdownRedis` once on SIGTERM; quits the connection.
 */
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import type { RedisClientOptions } from './types.js';

// 30 days, the tech spec's retention for fetch timestamps and
// content hashes. ~300 MB at 2x scale, within the 1 GB tier.
export const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60;

// Releases a lock only if the caller still owns it. Comparing the
// token before deleting stops a worker from releasing a lock that
// already expired and was re-acquired by another worker. Runs
// atomically in Redis so the get and delete cannot interleave.
const RELEASE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

// Token-bucket rate limiter shared across worker replicas. Refills
// continuously at refillPerSec up to capacity, then tries to take one
// token. Uses the Redis server clock (TIME) so all replicas agree on
// elapsed time without depending on synchronized client clocks. Runs
// atomically, so concurrent callers cannot over-draw the bucket.
// ARGV: capacity, refillPerSec, ttlSeconds. Returns {allowed, retryMs}.
const TOKEN_BUCKET_SCRIPT = `
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
local t = redis.call("TIME")
local now = tonumber(t[1]) + tonumber(t[2]) / 1000000
local state = redis.call("HMGET", KEYS[1], "tokens", "ts")
local tokens = tonumber(state[1])
local ts = tonumber(state[2])
if tokens == nil then
  tokens = capacity
  ts = now
end
tokens = math.min(capacity, tokens + math.max(0, now - ts) * refill)
local allowed = 0
local retryMs = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  retryMs = math.ceil((1 - tokens) / refill * 1000)
end
redis.call("HSET", KEYS[1], "tokens", tokens, "ts", now)
redis.call("EXPIRE", KEYS[1], ttl)
return {allowed, retryMs}`;

// Module-level state.
let client: Redis | undefined;
let defaultTtl = DEFAULT_TTL_SECONDS;

/**
 * Initialize the Redis client. Throws if already initialized;
 * call shutdownRedis first to re-initialize. ioredis connects
 * lazily on the first command and reconnects on its own, so no
 * connect step is needed here.
 */
export function initRedisClient(opts: RedisClientOptions): void {
  if (client) {
    throw new Error(
      'Redis client already initialized. Call shutdownRedis() first.',
    );
  }
  defaultTtl = opts.defaultTtlSeconds ?? DEFAULT_TTL_SECONDS;
  client = new Redis({
    host: opts.host,
    port: opts.port ?? 6379,
    ...(opts.keyPrefix && { keyPrefix: opts.keyPrefix }),
  });
  // Surface background connection errors. ioredis reconnects on its
  // own, so these are logged rather than thrown; operation errors
  // reject their promise and reach Sentry via the caller's handler.
  client.on('error', (err) => console.error('redis:error', err));
}

/** Return the initialized client or throw. */
function requireClient(): Redis {
  if (!client) {
    throw new Error(
      'Redis client not initialized. Call initRedisClient() first.',
    );
  }
  return client;
}

/** Reject a non-positive TTL, which Redis EX rejects with an opaque error. */
function assertPositiveTtl(ttlSeconds: number): void {
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error(`TTL must be a positive number of seconds: ${ttlSeconds}`);
  }
}

/**
 * Store the current time (epoch milliseconds) at a key with a TTL
 * (default 30 days). Used for fetch and enqueue timestamps that
 * callers compare against a freshness window.
 */
export async function setTimestamp(
  key: string,
  ttlSeconds = defaultTtl,
): Promise<void> {
  assertPositiveTtl(ttlSeconds);
  await requireClient().set(key, Date.now(), 'EX', ttlSeconds);
}

/**
 * Read a timestamp (epoch milliseconds) written by setTimestamp.
 * Returns null if absent, expired, or not a number, so a corrupt
 * value fails open to "not recent" rather than a silent NaN.
 */
export async function getTimestamp(key: string): Promise<number | null> {
  const value = await requireClient().get(key);
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Store a string value at a key with a TTL (default 30 days). */
export async function setString(
  key: string,
  value: string,
  ttlSeconds = defaultTtl,
): Promise<void> {
  assertPositiveTtl(ttlSeconds);
  await requireClient().set(key, value, 'EX', ttlSeconds);
}

/** Read a string value, or null if absent or expired. */
export async function getString(key: string): Promise<string | null> {
  return requireClient().get(key);
}

/**
 * Try to acquire a lock at a key for ttlSeconds. Returns an opaque
 * token to pass to releaseLock on success, or null if another
 * holder has the lock. The TTL bounds how long a crashed holder can
 * block others, so set it to the Pub/Sub ack deadline minus a
 * margin, so the lock clears just before the message redelivers and
 * the retry is not blocked by a stale lock.
 */
export async function acquireLock(
  key: string,
  ttlSeconds: number,
): Promise<string | null> {
  assertPositiveTtl(ttlSeconds);
  const token = randomUUID();
  const result = await requireClient().set(key, token, 'EX', ttlSeconds, 'NX');
  return result === 'OK' ? token : null;
}

/**
 * Release a lock, but only if this caller still owns it (the stored
 * token matches). A token from an expired-and-reacquired lock will
 * not match, so this never releases another holder's lock.
 */
export async function releaseLock(key: string, token: string): Promise<void> {
  await requireClient().eval(RELEASE_LOCK_SCRIPT, 1, key, token);
}

/** Outcome of a rate-limit token request. */
export interface RateLimitResult {
  /** Whether a token was available and consumed. */
  allowed: boolean;
  /** When not allowed, milliseconds until the next token refills. */
  retryAfterMs: number;
}

/**
 * Take one token from a shared token bucket at key, refilling at
 * ratePerMinute up to a burst capacity. Distributes a global rate
 * limit (e.g. Zyte API calls) across worker replicas. Atomic, so
 * concurrent callers cannot exceed the rate.
 */
export async function acquireRateLimitToken(
  key: string,
  ratePerMinute: number,
  burst: number,
): Promise<RateLimitResult> {
  if (ratePerMinute <= 0) {
    throw new Error(`ratePerMinute must be positive, got ${ratePerMinute}`);
  }
  if (burst < 1) {
    throw new Error(`burst must be at least 1, got ${burst}`);
  }
  const refillPerSec = ratePerMinute / 60;
  // Keep the bucket alive a little past a full refill from empty.
  const ttlSeconds = Math.ceil(burst / refillPerSec) + 10;
  const [allowed, retryAfterMs] = (await requireClient().eval(
    TOKEN_BUCKET_SCRIPT,
    1,
    key,
    burst,
    refillPerSec,
    ttlSeconds,
  )) as [number, number];
  return { allowed: allowed === 1, retryAfterMs };
}

/**
 * Quit the Redis connection and reset module state. Idempotent;
 * safe to call when uninitialized. quit() waits for pending replies
 * before closing, unlike disconnect().
 */
export async function shutdownRedis(): Promise<void> {
  if (!client) return;
  const current = client;
  client = undefined;
  await current.quit();
}
