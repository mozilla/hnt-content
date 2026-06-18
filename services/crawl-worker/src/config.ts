// Deploy environment (dev/stage/prod). Drives the Pub/Sub names and
// the Corpus endpoint below, mirroring how Terraform names resources.
const environment = process.env.ENVIRONMENT;

export default {
  service: 'crawl-worker',
  // Which worker this pod runs as, set per deployment by the Helm
  // chart (required, no default). Tags errors in Sentry; a later task
  // uses it to pick which consumer to start (article vs discovery).
  workerRole: process.env.WORKER_ROLE ?? '',
  port: Number(process.env.PORT ?? '8080'),
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
  // Cap on how long the SDK keeps extending a message's lease while
  // the handler runs: the per-message budget before Pub/Sub
  // redelivers. 570s leaves room for Zyte retries on a slow site.
  maxExtensionSeconds: Number(process.env.MAX_EXTENSION_SECONDS ?? '570'),
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
