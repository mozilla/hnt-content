import { PubSub, type Message } from '@google-cloud/pubsub';
import {
  PubSubEmulatorContainer,
  type StartedPubSubEmulatorContainer,
} from '@testcontainers/gcloud';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  flushTopics,
  initPubSubClient,
  initZyteClient,
  publishMessage,
  shutdownPubSub,
  type ArticleEvent,
} from 'crawl-common';
import { BASE_MESSAGE, ZYTE_ARTICLE } from './handlers/test-helpers.js';

// Set before importing config so the consumer reads these names.
const PROJECT_ID = 'test-project';
const CRAWL_ARTICLE_SUB = 'crawl-article-sub';
const ARTICLES_TOPIC = 'articles-topic';
process.env.PROJECT_ID = PROJECT_ID;
process.env.CRAWL_ARTICLE_SUBSCRIPTION = CRAWL_ARTICLE_SUB;
process.env.ARTICLES_TOPIC = ARTICLES_TOPIC;
process.env.ZYTE_API_KEY = 'test-zyte-key';

const CRAWL_ARTICLE_TOPIC = 'crawl-article-topic';
const ARTICLES_VERIFY_SUB = 'articles-verify-sub';

// Pinned for reproducibility; matches the crawl-common integration test.
const EMULATOR_IMAGE =
  'gcr.io/google.com/cloudsdktool/google-cloud-cli:568.0.0-emulators';
const CONTAINER_START_TIMEOUT_MS = 120_000;
const CONSUME_TIMEOUT_MS = 10_000;

/**
 * Integration test for the article consumer. Runs the real handler
 * and Pub/Sub client against an emulator, with Zyte stubbed at the
 * fetch boundary, to verify a crawl-article job produces an event
 * on the articles topic.
 */
describe('article consumer integration', () => {
  let container: StartedPubSubEmulatorContainer;
  let endpoint: string;
  let adminClient: PubSub;
  let startArticleConsumer: () => void;

  beforeAll(async () => {
    container = await new PubSubEmulatorContainer(EMULATOR_IMAGE)
      .withProjectId(PROJECT_ID)
      .start();
    endpoint = container.getEmulatorEndpoint();
    adminClient = new PubSub({
      projectId: PROJECT_ID,
      apiEndpoint: endpoint,
      emulatorMode: true,
    });
    await adminClient.createTopic(CRAWL_ARTICLE_TOPIC);
    await adminClient
      .topic(CRAWL_ARTICLE_TOPIC)
      .createSubscription(CRAWL_ARTICLE_SUB);
    await adminClient.createTopic(ARTICLES_TOPIC);
    await adminClient
      .topic(ARTICLES_TOPIC)
      .createSubscription(ARTICLES_VERIFY_SUB);

    ({ startArticleConsumer } = await import('./article-consumer.js'));
  }, CONTAINER_START_TIMEOUT_MS);

  afterAll(async () => {
    await adminClient?.close();
    await container?.stop();
  });

  beforeEach(() => {
    initZyteClient({ apiKey: 'test-zyte-key', maxRetries: 0 });
    initPubSubClient({
      projectId: PROJECT_ID,
      apiEndpoint: endpoint,
      useEmulator: true,
    });
  });

  afterEach(async () => {
    await shutdownPubSub();
    vi.unstubAllGlobals();
  });

  it('extracts a published job and publishes the article event', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          article: ZYTE_ARTICLE,
          url: ZYTE_ARTICLE.url,
          statusCode: 200,
        }),
      ),
    );

    const events: ArticleEvent[] = [];
    adminClient
      .subscription(ARTICLES_VERIFY_SUB)
      .on('message', (m: Message) => {
        events.push(JSON.parse(m.data.toString()) as ArticleEvent);
        m.ack();
      });

    startArticleConsumer();
    await publishMessage(CRAWL_ARTICLE_TOPIC, BASE_MESSAGE);
    await flushTopics();

    await waitFor(() => events.length === 1, CONSUME_TIMEOUT_MS);
    expect(events[0]!.url).toBe(BASE_MESSAGE.url);
    expect(events[0]!.headline).toBe(ZYTE_ARTICLE.headline);
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
