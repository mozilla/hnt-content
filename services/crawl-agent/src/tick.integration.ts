import { PubSub, type Message } from '@google-cloud/pubsub';
import {
  PubSubEmulatorContainer,
  type StartedPubSubEmulatorContainer,
} from '@testcontainers/gcloud';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  flushTopics,
  initPubSubClient,
  initRedisClient,
  shutdownPubSub,
  shutdownRedis,
  type CrawlArticleDiscoveryMessage,
  type CrawlArticleMessage,
  type PublisherList,
} from 'crawl-common';

// Topic names the agent publishes to; set before importing config.
const PROJECT_ID = 'test-project';
const DISCOVERY_TOPIC = 'discovery-topic';
const CRAWL_ARTICLE_TOPIC = 'crawl-article-topic';
process.env.PROJECT_ID = PROJECT_ID;
process.env.CRAWL_ARTICLE_DISCOVERY_TOPIC = DISCOVERY_TOPIC;
process.env.CRAWL_ARTICLE_TOPIC = CRAWL_ARTICLE_TOPIC;

const DISCOVERY_VERIFY_SUB = 'discovery-verify-sub';
const CRAWL_ARTICLE_VERIFY_SUB = 'crawl-article-verify-sub';

const PUBSUB_IMAGE =
  'gcr.io/google.com/cloudsdktool/google-cloud-cli:568.0.0-emulators';
const REDIS_IMAGE = 'redis:7.4.1-alpine';
const CONTAINER_START_TIMEOUT_MS = 120_000;
const CONSUME_TIMEOUT_MS = 10_000;

const LIST: PublisherList = {
  pages: [
    {
      url: 'https://example.com/news',
      interval_minutes: 20,
      contexts: [{ surface_id: 'NEW_TAB_EN_US', topic: 'technology' }],
    },
  ],
  live_articles: [
    {
      url: 'https://example.com/live-1',
      corpus_item: {
        external_id: 'ext-1',
        title: 'Headline',
        excerpt: 'Excerpt',
        authors: [{ name: 'Jane Doe' }],
        status: 'CORPUS',
        language: 'EN',
        publisher: 'Example News',
        image_url: 'https://s3.amazonaws.com/image.jpg',
        topic: 'TECHNOLOGY',
        is_time_sensitive: false,
      },
    },
  ],
};

/**
 * Integration test for the agent tick. Runs runTick against a real
 * Pub/Sub emulator and Redis, verifying that a tick enqueues to both
 * topics and that a second tick is deduplicated by the Redis markers.
 */
describe('agent tick integration', () => {
  let pubsubContainer: StartedPubSubEmulatorContainer;
  let redisContainer: StartedTestContainer;
  let adminClient: PubSub;
  let runTick: (list: PublisherList) => Promise<unknown>;

  beforeAll(async () => {
    [pubsubContainer, redisContainer] = await Promise.all([
      new PubSubEmulatorContainer(PUBSUB_IMAGE)
        .withProjectId(PROJECT_ID)
        .start(),
      new GenericContainer(REDIS_IMAGE)
        .withExposedPorts(6379)
        .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
        .start(),
    ]);

    const endpoint = pubsubContainer.getEmulatorEndpoint();
    adminClient = new PubSub({
      projectId: PROJECT_ID,
      apiEndpoint: endpoint,
      emulatorMode: true,
    });
    await adminClient.createTopic(DISCOVERY_TOPIC);
    await adminClient
      .topic(DISCOVERY_TOPIC)
      .createSubscription(DISCOVERY_VERIFY_SUB);
    await adminClient.createTopic(CRAWL_ARTICLE_TOPIC);
    await adminClient
      .topic(CRAWL_ARTICLE_TOPIC)
      .createSubscription(CRAWL_ARTICLE_VERIFY_SUB);

    initPubSubClient({
      projectId: PROJECT_ID,
      apiEndpoint: endpoint,
      useEmulator: true,
    });
    initRedisClient({
      host: redisContainer.getHost(),
      port: redisContainer.getMappedPort(6379),
    });

    ({ runTick } = await import('./tick.js'));
  }, CONTAINER_START_TIMEOUT_MS);

  afterAll(async () => {
    await shutdownPubSub();
    await shutdownRedis();
    await adminClient?.close();
    await Promise.all([pubsubContainer?.stop(), redisContainer?.stop()]);
  });

  it('enqueues to both topics, then deduplicates on the next tick', async () => {
    const discoveries: CrawlArticleDiscoveryMessage[] = [];
    adminClient
      .subscription(DISCOVERY_VERIFY_SUB)
      .on('message', (m: Message) => {
        discoveries.push(JSON.parse(m.data.toString()));
        m.ack();
      });
    const jobs: CrawlArticleMessage[] = [];
    adminClient
      .subscription(CRAWL_ARTICLE_VERIFY_SUB)
      .on('message', (m: Message) => {
        jobs.push(JSON.parse(m.data.toString()));
        m.ack();
      });

    const first = await runTick(LIST);
    await flushTopics();
    expect(first).toEqual({ pages: 1, liveArticles: 1 });

    // At-least-once delivery, so wait for the first of each.
    await waitFor(
      () => discoveries.length >= 1 && jobs.length >= 1,
      CONSUME_TIMEOUT_MS,
    );
    expect(discoveries[0]!.url).toBe(LIST.pages[0]!.url);
    expect(jobs[0]!.url).toBe(LIST.live_articles[0]!.url);
    expect(jobs[0]!.corpus_item?.external_id).toBe('ext-1');

    // The Redis markers from the first tick suppress the second.
    const second = await runTick(LIST);
    expect(second).toEqual({ pages: 0, liveArticles: 0 });
  });
});

/** Poll until the predicate returns true, or reject on timeout. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
