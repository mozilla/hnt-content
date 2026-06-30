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

// Lock TTL must clear just before redelivery, so it tracks the ack
// deadline rather than the longer max extension.
const lockTtlSeconds = ackDeadlineSeconds - 30;

// Cap on how long the SDK keeps extending a healthy message's lease
// while the handler runs: the per-message processing budget. Defaults to
// the lock TTL so the lease cannot outlive the lock: a handler that ran
// past the lock TTL would lose its lock to a redelivery while still
// holding the lease, letting two workers process the same URL at once.
const maxExtensionSeconds = numberEnv(
  process.env.MAX_EXTENSION_SECONDS,
  lockTtlSeconds,
);
if (maxExtensionSeconds <= 0) {
  throw new Error(
    `MAX_EXTENSION_SECONDS must be > 0, got ${maxExtensionSeconds}`,
  );
}
// Keep the lease from outliving the lock (see above).
if (maxExtensionSeconds > lockTtlSeconds) {
  throw new Error(
    `MAX_EXTENSION_SECONDS (${maxExtensionSeconds}) must be <= lock TTL ` +
      `(${lockTtlSeconds} = ACK_DEADLINE_SECONDS - 30)`,
  );
}

// Cap on outstanding Pub/Sub messages: see pubsubMaxMessages below.
const pubsubMaxMessages = numberEnv(process.env.PUBSUB_MAX_MESSAGES, 64);
if (pubsubMaxMessages <= 0) {
  throw new Error(`PUBSUB_MAX_MESSAGES must be > 0, got ${pubsubMaxMessages}`);
}

const workerRole = process.env.WORKER_ROLE ?? '';

// Split the per-account Zyte rate limit between the two worker roles in
// proportion to their measured request mix (about 7.6 to 1 article vs
// articleList, HNT-2086): the article worker fetches one article per job
// while the discovery worker lists many articles per page, so article
// dominates. Each role runs its own Redis bucket and the two rates sum to
// the account limit, so the roles neither contend on one bucket nor
// starve each other. ZYTE_RATE_LIMIT_PER_MINUTE overrides per env; 0
// disables the limiter (e.g. local/test).
const zyteRateLimitPerMinute = numberEnv(
  process.env.ZYTE_RATE_LIMIT_PER_MINUTE,
  workerRole === 'discovery' ? 300 : 2200,
);

export default {
  service: 'crawl-worker',
  // Which worker this pod runs as, set per deployment by the Helm
  // chart (required, no default). Tags errors in Sentry; a later task
  // uses it to pick which consumer to start (article vs discovery).
  workerRole,
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
  // deadline minus 30s, so the lock clears just before redelivery. The
  // max extension is capped to this value (above) so the lease never
  // outlives the lock.
  lockTtlSeconds,
  // Default re-fetch window for an article, used when a crawl-article
  // message carries no refresh_interval_minutes (e.g. an older message
  // mid-deploy). Discovered articles use this value; live articles carry
  // the agent's live-article interval on the message instead.
  articleFetchTtlMinutes: numberEnv(process.env.ARTICLE_FETCH_TTL_MINUTES, 60),
  // Redis (Memorystore) for fetch/lock/content dedup state.
  // TEMPORARY (HNT-2086): see the PROJECT_ID note above.
  redisHost: process.env.REDIS_HOST ?? deployedRedisHost(environment),
  redisPort: numberEnv(process.env.REDIS_PORT, 6379),
  zyteApiKey: process.env.ZYTE_API_KEY ?? '',
  // Per-role share of the distributed Zyte rate limit (see the split
  // above). Burst defaults to one minute of tokens; the wait caps how
  // long a handler blocks for a token before nacking to shed load.
  zyteRateLimitPerMinute,
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
