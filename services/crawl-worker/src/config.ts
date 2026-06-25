// Deploy environment (dev/stage/prod). Drives the Pub/Sub names and
// the Corpus endpoint below, mirroring how Terraform names resources.
const environment = process.env.ENVIRONMENT;

/** Parse a numeric env var, failing fast at load on a non-finite value. */
function numberEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected a numeric env value, got: ${value}`);
  }
  return parsed;
}

// Cap on how long the SDK keeps extending a message's lease while the
// handler runs: the per-message budget before Pub/Sub redelivers. 570s
// leaves room for Zyte retries on a slow site. Must exceed 30 so the
// derived lock TTL below stays positive.
const maxExtensionSeconds = numberEnv(process.env.MAX_EXTENSION_SECONDS, 570);
if (maxExtensionSeconds <= 30) {
  throw new Error(
    `MAX_EXTENSION_SECONDS must be > 30, got ${maxExtensionSeconds}`,
  );
}

export default {
  service: 'crawl-worker',
  // Which worker this pod runs as, set per deployment by the Helm
  // chart (required, no default). Tags errors in Sentry; a later task
  // uses it to pick which consumer to start (article vs discovery).
  workerRole: process.env.WORKER_ROLE ?? '',
  port: numberEnv(process.env.PORT, 8080),
  projectId: process.env.PROJECT_ID ?? '',
  // Set to 'host:port' to point the Pub/Sub SDK at a local emulator.
  // Unset in production, where the SDK uses the real endpoint.
  pubsubEmulatorHost: process.env.PUBSUB_EMULATOR_HOST,
  // Pub/Sub names are env-prefixed (e.g. dev-crawl-article). Derived
  // from ENVIRONMENT so the Helm chart doesn't set them; the explicit
  // env var overrides, e.g. to point at an emulator topic.
  crawlArticleSubscription:
    process.env.CRAWL_ARTICLE_SUBSCRIPTION ?? `${environment}-crawl-article`,
  articlesTopic: process.env.ARTICLES_TOPIC ?? `${environment}-articles`,
  // Discovery worker: consumes page jobs, publishes discovery events
  // and one crawl-article job per discovered article.
  crawlArticleDiscoverySubscription:
    process.env.CRAWL_ARTICLE_DISCOVERY_SUBSCRIPTION ??
    `${environment}-crawl-article-discovery`,
  articleDiscoveriesTopic:
    process.env.ARTICLE_DISCOVERIES_TOPIC ??
    `${environment}-article-discoveries`,
  crawlArticleTopic:
    process.env.CRAWL_ARTICLE_TOPIC ?? `${environment}-crawl-article`,
  maxExtensionSeconds,
  // Distributed-lock TTL for a per-article fetch. Kept just below the
  // max message lease so a crashed worker's lock clears around when the
  // message redelivers, never while this worker still holds the message.
  lockTtlSeconds: maxExtensionSeconds - 30,
  // How long a discovered article's last fetch suppresses a re-fetch.
  // Should stay below the agent's live-article interval so live articles
  // (which bypass this check) keep resyncing on their own cadence.
  articleFetchTtlMinutes: numberEnv(process.env.ARTICLE_FETCH_TTL_MINUTES, 60),
  // Redis (Memorystore) for fetch/lock/content dedup state.
  redisHost: process.env.REDIS_HOST ?? '',
  redisPort: numberEnv(process.env.REDIS_PORT, 6379),
  zyteApiKey: process.env.ZYTE_API_KEY ?? '',
  // Corpus Admin API config. Endpoint, issuer, and audience are
  // app-level constants (matching content-monorepo); the endpoint
  // uses the nonprod admin-api outside prod. Only the JWK is a secret,
  // sourced from GSM. Each is env-overridable.
  corpusApi: {
    endpoint:
      process.env.CORPUS_API_ENDPOINT ??
      (environment === 'prod'
        ? 'https://admin-api.getpocket.com'
        : 'https://admin-api.getpocket.dev'),
    jwkJson: process.env.CORPUS_API_JWK_JSON ?? '',
    issuer: process.env.CORPUS_API_ISSUER ?? 'https://getpocket.com',
    audience:
      process.env.CORPUS_API_AUDIENCE ?? 'https://admin-api.getpocket.com/',
  },
};
