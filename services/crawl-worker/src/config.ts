import { deployedProjectId, deployedRedisHost } from 'crawl-common';

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

// Cap on how long the SDK keeps extending a healthy message's lease
// while the handler runs: the per-message processing budget. 570s leaves
// room for Zyte retries on a slow site.
const maxExtensionSeconds = numberEnv(process.env.MAX_EXTENSION_SECONDS, 570);
if (maxExtensionSeconds <= 0) {
  throw new Error(
    `MAX_EXTENSION_SECONDS must be > 0, got ${maxExtensionSeconds}`,
  );
}

// The subscription's ack deadline in seconds. Must match the Terraform
// subscription setting: it is the lease granularity, so a crashed
// worker's message redelivers within about this long. The lock TTL is
// derived from it. Must exceed 30 so that derived TTL stays positive.
const ackDeadlineSeconds = numberEnv(process.env.ACK_DEADLINE_SECONDS, 300);
if (ackDeadlineSeconds <= 30) {
  throw new Error(
    `ACK_DEADLINE_SECONDS must be > 30, got ${ackDeadlineSeconds}`,
  );
}

// Cap on outstanding Pub/Sub messages: see pubsubMaxMessages below.
const pubsubMaxMessages = numberEnv(process.env.PUBSUB_MAX_MESSAGES, 16);
if (pubsubMaxMessages <= 0) {
  throw new Error(`PUBSUB_MAX_MESSAGES must be > 0, got ${pubsubMaxMessages}`);
}

export default {
  service: 'crawl-worker',
  // Which worker this pod runs as, set per deployment by the Helm
  // chart (required, no default). Tags errors in Sentry; a later task
  // uses it to pick which consumer to start (article vs discovery).
  workerRole: process.env.WORKER_ROLE ?? '',
  port: numberEnv(process.env.PORT, 8080),
  // TEMPORARY (HNT-2086): PROJECT_ID and REDIS_HOST fall back to
  // per-environment defaults (keyed on ENVIRONMENT) until the chart
  // injects them; see crawl-common deployed-defaults. The env var always
  // wins when set. Drop the fallback (back to '') once the chart sets
  // both, here and on redisHost below.
  projectId: process.env.PROJECT_ID ?? deployedProjectId(environment),
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
  ackDeadlineSeconds,
  // Cap on outstanding (leased but unacked) Pub/Sub messages, mapped
  // to the SDK's flowControl.maxMessages. Bounds concurrent handlers,
  // and so the concurrent Zyte fetches and response bodies held in
  // memory. The SDK default of 1000 OOM-kills the worker under a
  // backlog, so we cap it low. Raise once the pod has more memory or
  // an in-process Zyte cap exists.
  pubsubMaxMessages,
  // Distributed-lock TTL for a per-article or per-page fetch: the ack
  // deadline minus 30s (not the max extension), so the lock clears
  // just before redelivery. A healthy worker that runs past it still
  // holds the message via lease extension, so nothing races the lock.
  lockTtlSeconds: ackDeadlineSeconds - 30,
  // How long a discovered article's last fetch suppresses a re-fetch.
  // Should stay below the agent's live-article interval so live articles
  // (which bypass this check) keep resyncing on their own cadence.
  articleFetchTtlMinutes: numberEnv(process.env.ARTICLE_FETCH_TTL_MINUTES, 60),
  // Redis (Memorystore) for fetch/lock/content dedup state.
  // TEMPORARY (HNT-2086): see the PROJECT_ID note above.
  redisHost: process.env.REDIS_HOST ?? deployedRedisHost(environment),
  redisPort: numberEnv(process.env.REDIS_PORT, 6379),
  zyteApiKey: process.env.ZYTE_API_KEY ?? '',
  // Distributed Zyte rate limit shared across replicas via Redis. 0
  // disables it (local/test default); deployed envs set the Zyte
  // plan's RPM. Burst defaults to one minute of tokens; the wait caps
  // how long a handler blocks for a token before nacking to shed load.
  zyteRateLimitPerMinute: numberEnv(process.env.ZYTE_RATE_LIMIT_PER_MINUTE, 0),
  zyteRateLimitBurst: numberEnv(process.env.ZYTE_RATE_LIMIT_BURST, 0),
  zyteRateLimitMaxWaitMs: numberEnv(
    process.env.ZYTE_RATE_LIMIT_MAX_WAIT_MS,
    30_000,
  ),
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
