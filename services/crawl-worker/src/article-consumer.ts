import { crawlConfig, type CrawlArticleMessage } from 'crawl-common';
import {
  publishMessage,
  sentryPubSubErrorHandler,
  startSubscriber,
} from 'pubsub';
import { withSentryHandler } from 'sentry';
import config from './config.js';
import { handleArticleExtraction } from './handlers/extract-article.js';

/** Extract one article and publish it as an `articles` event. */
async function handleMessage(message: CrawlArticleMessage): Promise<void> {
  const event = await handleArticleExtraction(message);
  await publishMessage(crawlConfig.articlesTopic, event);
}

// A thrown error is captured with the job's identifying fields, then
// rethrown so the subscriber nacks the message for redelivery.
const handleWithSentry = withSentryHandler<CrawlArticleMessage>(
  (message) => ({
    tags: {
      worker_role: 'article',
      has_corpus_item: String(message.corpus_item != null),
    },
    context: {
      url: message.url,
      crawl_id: message.crawl_id,
      source_url: message.source_url,
    },
  }),
  handleMessage,
);

/**
 * Start consuming `crawl-article` jobs. `shutdownPubSub()` drains and
 * stops the subscriber, so no controller is kept here.
 */
export function startArticleConsumer(): void {
  startSubscriber<CrawlArticleMessage>({
    subscriptionName: crawlConfig.crawlArticleSubscription,
    maxExtensionSeconds: config.maxExtensionSeconds,
    maxMessages: config.maxMessages,
    handler: handleWithSentry,
    onError: sentryPubSubErrorHandler(crawlConfig.crawlArticleSubscription),
  });
}
