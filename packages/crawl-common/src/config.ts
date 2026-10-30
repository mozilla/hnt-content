// The following config is read by both the scheduler and the worker.
// Settings that belong to one client come from that client's package.

// Terraform prefixes every Pub/Sub name with the deploy environment.
// Each service checks that this value is set before using it.
const environment = process.env.ENVIRONMENT ?? '';

// ids for both pubsub topics and subscriptions
// the ids are identical by convention - see the pubsub module in infra:
// https://github.com/mozilla/webservices-infra/blob/ed77e0f7aa2cef30b9af3ce21c0c91924ad78b94/hnt/tf/modules/pubsub/main.tf#L13
const crawlArticlePubSubId = `${environment}-crawl-article`;
const crawlArticleDiscoveryPubSubId = `${environment}-crawl-article-discovery`;

export default {
  environment,
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
