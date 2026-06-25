// Deploy environment (dev/stage/prod). Drives the Pub/Sub topic names
// below, mirroring how Terraform names resources.
const environment = process.env.ENVIRONMENT;

/** Parse a numeric env var, failing fast at load on a non-finite value. */
function numberEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected a numeric env value, got: ${value}`);
  }
  return parsed;
}

export default {
  service: 'crawl-agent',
  port: numberEnv(process.env.PORT, 8080),
  tickIntervalMs: numberEnv(process.env.TICK_INTERVAL_MS, 60000),
  staleTickThresholdMinutes: numberEnv(
    process.env.STALE_TICK_THRESHOLD_MINUTES,
    10,
  ),
  projectId: process.env.PROJECT_ID ?? '',
  // Set to 'host:port' to point the Pub/Sub SDK at a local emulator.
  pubsubEmulatorHost: process.env.PUBSUB_EMULATOR_HOST,
  // Topics the agent publishes to. Env-prefixed names are derived from
  // ENVIRONMENT (matching Terraform); explicit env vars override, e.g.
  // for emulator topics.
  crawlArticleDiscoveryTopic:
    process.env.CRAWL_ARTICLE_DISCOVERY_TOPIC ??
    `${environment}-crawl-article-discovery`,
  crawlArticleTopic:
    process.env.CRAWL_ARTICLE_TOPIC ?? `${environment}-crawl-article`,
  // Path to the publisher list JSON loaded at startup. Phase 5 replaces
  // this file with the Corpus API.
  publisherListPath: process.env.PUBLISHER_LIST_PATH ?? 'publishers.json',
  // How often the agent re-enqueues a live article, so curated metadata
  // stays fresh without flooding the queue every tick.
  liveArticleIntervalMinutes: numberEnv(
    process.env.LIVE_ARTICLE_INTERVAL_MINUTES,
    20,
  ),
  redisHost: process.env.REDIS_HOST ?? '',
  redisPort: numberEnv(process.env.REDIS_PORT, 6379),
};
