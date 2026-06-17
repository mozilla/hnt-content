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
  // Cap on how long the SDK keeps extending a message's lease while
  // the handler runs: the per-message budget before Pub/Sub
  // redelivers. 570s leaves room for Zyte retries on a slow site.
  maxExtensionSeconds: Number(process.env.MAX_EXTENSION_SECONDS ?? '570'),
  zyteApiKey: process.env.ZYTE_API_KEY ?? '',
  // Only needed to sync live articles. When unset, the worker still
  // processes articles without a corpus_item and skips Corpus updates.
  corpusApi: {
    endpoint: process.env.CORPUS_API_ENDPOINT ?? '',
    jwkJson: process.env.CORPUS_API_JWK_JSON ?? '',
    issuer: process.env.CORPUS_API_ISSUER ?? '',
    audience: process.env.CORPUS_API_AUDIENCE ?? '',
  },
};
