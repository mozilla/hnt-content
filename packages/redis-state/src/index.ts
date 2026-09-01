export {
  initRedisClient,
  shutdownRedis,
  setTimestamp,
  getTimestamp,
  setString,
  getString,
  acquireLock,
  releaseLock,
  acquireRateLimitToken,
  DEFAULT_TTL_SECONDS,
} from './client.js';
export type { RateLimitResult } from './client.js';
export type { RedisClientOptions } from './types.js';
