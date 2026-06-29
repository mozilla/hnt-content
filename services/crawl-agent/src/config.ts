import { fileURLToPath } from 'node:url';
import { deployedProjectId, deployedRedisHost } from 'crawl-common';

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

// Corpus live-article source. The JWK gates the source; when it is set,
// at least one surface and a positive refresh interval are required, so
// a typo fails fast rather than silently crawling zero live articles.
const corpusApiJwkJson = process.env.CORPUS_API_JWK_JSON ?? '';
const scheduledSurfaceGuids = (
  process.env.CORPUS_SCHEDULED_SURFACE_GUIDS ?? 'NEW_TAB_EN_US'
)
  .split(',')
  .map((guid) => guid.trim())
  .filter(Boolean);
const corpusRefreshMinutes = numberEnv(process.env.CORPUS_REFRESH_MINUTES, 15);
if (corpusApiJwkJson !== '') {
  if (scheduledSurfaceGuids.length === 0) {
    throw new Error(
      'CORPUS_SCHEDULED_SURFACE_GUIDS must list at least one surface ' +
        'when CORPUS_API_JWK_JSON is set',
    );
  }
  if (corpusRefreshMinutes <= 0) {
    throw new Error(
      `CORPUS_REFRESH_MINUTES must be positive, got ${corpusRefreshMinutes}`,
    );
  }
}

export default {
  service: 'crawl-agent',
  port: numberEnv(process.env.PORT, 8080),
  tickIntervalMs: numberEnv(process.env.TICK_INTERVAL_MS, 60000),
  staleTickThresholdMinutes: numberEnv(
    process.env.STALE_TICK_THRESHOLD_MINUTES,
    10,
  ),
  // TEMPORARY (HNT-2086): PROJECT_ID and REDIS_HOST fall back to
  // per-environment defaults (keyed on ENVIRONMENT) until the chart
  // injects them; see crawl-common deployed-defaults. The env var always
  // wins when set. Drop the fallback (back to '') once the chart sets
  // both, here and on redisHost below.
  projectId: process.env.PROJECT_ID ?? deployedProjectId(environment),
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
  // The committed publisher list, resolved relative to this module so it
  // loads regardless of the working directory (the container runs from /app
  // while the file ships next to the package). One list serves every
  // environment, so the path is fixed rather than env-configurable.
  publisherListPath: fileURLToPath(
    new URL('../publishers.json', import.meta.url),
  ),
  // Corpus Admin API source for live (curated) articles, mirroring the
  // crawl-worker client. The endpoint, issuer, and audience have app
  // defaults (nonprod admin-api outside prod); only the JWK is a secret.
  // Leave the JWK unset to source live_articles from the file instead.
  corpusApi: {
    endpoint:
      process.env.CORPUS_API_ENDPOINT ??
      (environment === 'prod'
        ? 'https://admin-api.getpocket.com'
        : 'https://admin-api.getpocket.dev'),
    jwkJson: corpusApiJwkJson,
    issuer: process.env.CORPUS_API_ISSUER ?? 'https://getpocket.com',
    audience:
      process.env.CORPUS_API_AUDIENCE ?? 'https://admin-api.getpocket.com/',
  },
  // New Tab surfaces whose currently scheduled section items become live
  // articles. Comma-separated; defaults to en-US to match today's reality.
  scheduledSurfaceGuids,
  // How often to re-read the live-article list from the Corpus API, so
  // editorial changes propagate without a restart.
  corpusRefreshMinutes,
  // How often the agent re-enqueues a live article, so curated metadata
  // stays fresh without flooding the queue every tick.
  liveArticleIntervalMinutes: numberEnv(
    process.env.LIVE_ARTICLE_INTERVAL_MINUTES,
    20,
  ),
  // TEMPORARY (HNT-2086): see the PROJECT_ID note above.
  redisHost: process.env.REDIS_HOST ?? deployedRedisHost(environment),
  redisPort: numberEnv(process.env.REDIS_PORT, 6379),
};
