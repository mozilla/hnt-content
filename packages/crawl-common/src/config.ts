// The following config is read by both the scheduler and the worker.
// Settings that belong to one client come from that client's package.

// Terraform prefixes every Pub/Sub name with the deploy environment.
// Each service checks that this value is set before using it.
const environment = process.env.ENVIRONMENT ?? '';

export default {
  environment,
  // Subscription and topic are given matching names in Terraform.
  crawlArticleTopic: `${environment}-crawl-article`,
  crawlArticleSubscription: `${environment}-crawl-article`,
  crawlArticleDiscoveryTopic: `${environment}-crawl-article-discovery`,
  crawlArticleDiscoverySubscription: `${environment}-crawl-article-discovery`,
  // Each of these topics has a subscription that writes to BigQuery.
  articlesTopic: `${environment}-articles`,
  articleDiscoveriesTopic: `${environment}-article-discoveries`,
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
