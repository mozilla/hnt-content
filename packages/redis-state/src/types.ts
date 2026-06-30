/** Options for configuring the Redis client. */
export interface RedisClientOptions {
  /** Redis host (e.g. a Memorystore IP). */
  host: string;
  /** Redis port. Defaults to 6379. */
  port?: number;
  /**
   * Default TTL in seconds for fetch timestamps and content hashes.
   * Defaults to 30 days, per the tech spec's retention for the
   * crawl state store. Locks pass their own short TTL.
   */
  defaultTtlSeconds?: number;
  /**
   * Optional prefix applied to every key. The Redis instance is
   * per-environment, so keys are not env-prefixed in production;
   * tests use this to isolate keyspaces.
   */
  keyPrefix?: string;
}
