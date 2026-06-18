import {
  publishMessage,
  sentryPubSubErrorHandler,
  startSubscriber,
  type ArticleEvent,
  type CrawlArticleMessage,
} from 'crawl-common';
import { withSentryHandler } from 'sentry';
import config from './config.js';
import { handleArticleExtraction } from './handlers/extract-article.js';

/**
 * Extract an article and publish the result to the articles topic.
 * Publishing lives inside the handler so a failure to extract or
 * publish throws, which nacks the message for redelivery. A message
 * is acked only after its event reaches the topic.
 */
async function extractAndPublishArticle(
  message: CrawlArticleMessage,
): Promise<void> {
  const event = await handleArticleExtraction(message);
  await publishMessage<ArticleEvent>(config.articlesTopic, event);
}

/**
 * Wrap extractAndPublishArticle so any error it throws reaches Sentry
 * with the job's identifying fields attached. worker_role distinguishes
 * this worker from the discovery worker added in Task 6.2.
 */
const handleMessage = withSentryHandler<CrawlArticleMessage>(
  (message) => ({
    tags: {
      worker_role: config.workerRole,
      has_corpus_item: String(message.corpus_item != null),
      // The editorial category, present only for live articles. Named
      // corpus_topic so it is not mistaken for the Pub/Sub topic.
      corpus_topic: message.corpus_item?.topic,
    },
    context: {
      url: message.url,
      crawl_id: message.crawl_id,
      source_url: message.source_url,
      enqueued_at: message.enqueued_at,
    },
  }),
  extractAndPublishArticle,
);

/** Start consuming jobs from the crawl-article subscription. */
export function startArticleConsumer(): void {
  startSubscriber<CrawlArticleMessage>({
    subscriptionName: config.crawlArticleSubscription,
    maxExtensionSeconds: config.maxExtensionSeconds,
    handler: handleMessage,
    onError: sentryPubSubErrorHandler(config.crawlArticleSubscription),
  });
}
