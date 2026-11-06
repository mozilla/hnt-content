// The following config is read by both the scheduler and the worker.
// Settings that belong to one client come from that client's package.

// Terraform prefixes every Pub/Sub name with the deploy environment.
// Each service checks that this value is set before using it.
const environment: string = process.env.ENVIRONMENT ?? '';

// ENABLE/DISABLE ENVIRONMENTS
//
// for our purposes here, "disabled" means the service is running in infra, but
// is not processing any data. when disabled, the environment is essentially
// idle.
//
// the key names below match the environment values injected by infrastructure.
// enabling an environment enables both crawling publisher pages and updating
// live corpus articles.
//
// currently used only in the crawl scheduler to stop sending messages to
// pubsub. if changed to false with pre-existing pubsub messages, crawl workers
// will continue to process remaining pubsub messages
const environmentEnabled: { [key: string]: boolean } = {
  dev: true,
  stage: false,
  prod: false,
  // outlier - not set in infra, but in individual vitest.config.ts files
  test: true,
};

// ids for both pubsub topics and subscriptions
// the ids are identical by convention - see the pubsub module in infra:
// https://github.com/mozilla/webservices-infra/blob/ed77e0f7aa2cef30b9af3ce21c0c91924ad78b94/hnt/tf/modules/pubsub/main.tf#L13
const crawlArticlePubSubId = `${environment}-crawl-article`;
const crawlArticleDiscoveryPubSubId = `${environment}-crawl-article-discovery`;

export default {
  environment,
  environmentEnabled: environmentEnabled[environment],
  // Subscription and topic are given matching names in Terraform. Configure
  // distinct config values to make it clear there are 2 underlying resources.
  crawlArticlePubSub: {
    topic: crawlArticlePubSubId,
    subscription: crawlArticlePubSubId,
  },
  crawlArticleDiscoveryPubSub: {
    topic: crawlArticleDiscoveryPubSubId,
    subscription: crawlArticleDiscoveryPubSubId,
  },
  // Each of these topics has a subscription that writes to BigQuery.
  articlesTopic: `${environment}-articles`,
  articleDiscoveriesTopic: `${environment}-article-discoveries`,
  // pageRefreshMinutes is the time between two crawls of a publisher
  // page. We kept the legacy pipeline's 20 minutes. The scheduler
  // staggers pages across this time.
  pageRefreshMinutes: 20,
  corpusApi: {
    // Only a production deploy may reach the production corpus. A local
    // run can override the endpoint.
    endpoint:
      process.env.CORPUS_API_ENDPOINT ??
      (environment === 'prod'
        ? 'https://admin-api.getpocket.com'
        : 'https://admin-api.getpocket.dev'),
    // The issuer and audience match content-monorepo and are fixed.
    issuer: 'https://getpocket.com',
    audience: 'https://admin-api.getpocket.com/',
    // For deployed pods, the key comes from Secret Manager through the chart.
    jwkJson: process.env.CORPUS_API_JWK_JSON,
  },
};
