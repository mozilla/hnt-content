export {
  initRedisClient,
  shutdownRedis,
  setRedisKeyTimestampWithTTL,
  getRedisKeyTimestampValue,
  setString,
  getString,
  acquireRedisKeyLockToken,
  releaseRedisKeyLock,
  acquireRateLimitToken,
  DEFAULT_TTL_SECONDS,
} from './client.js';
export type { RateLimitResult } from './client.js';
export type { RedisClientOptions } from './types.js';
