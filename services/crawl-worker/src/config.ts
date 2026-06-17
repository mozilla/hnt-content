export default {
  service: 'crawl-worker',
  port: Number(process.env.PORT ?? '8080'),
  projectId: process.env.PROJECT_ID ?? '',
  // Set to 'host:port' to point the Pub/Sub SDK at a local emulator.
  // Unset in production, where the SDK uses the real endpoint.
  pubsubEmulatorHost: process.env.PUBSUB_EMULATOR_HOST,
  // Short names; the fully qualified, env-prefixed values (e.g.
  // dev-crawl-article) come from the per-environment Helm values.
  crawlArticleSubscription:
    process.env.CRAWL_ARTICLE_SUBSCRIPTION ?? 'crawl-article',
  articlesTopic: process.env.ARTICLES_TOPIC ?? 'articles',
  // Longest a single message may be processed before Pub/Sub
  // redelivers it. Article extraction stays well under three minutes.
  maxExtensionSeconds: Number(process.env.MAX_EXTENSION_SECONDS ?? '180'),
  zyteApiKey: process.env.ZYTE_API_KEY ?? '',
  // Only needed to sync live articles. When unset, the worker still
  // processes discovered articles and skips Corpus API updates.
  corpusApi: {
    endpoint: process.env.CORPUS_API_ENDPOINT ?? '',
    jwkJson: process.env.CORPUS_API_JWK_JSON ?? '',
    issuer: process.env.CORPUS_API_ISSUER ?? '',
    audience: process.env.CORPUS_API_AUDIENCE ?? '',
  },
};
