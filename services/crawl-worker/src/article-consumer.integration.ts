import { PubSub, type Message, type Subscription } from '@google-cloud/pubsub';
import {
  PubSubEmulatorContainer,
  type StartedPubSubEmulatorContainer,
} from '@testcontainers/gcloud';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
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
  initRedisClient,
  initZyteClient,
  publishMessage,
  shutdownPubSub,
  shutdownRedis,
  type ArticleEvent,
} from 'crawl-common';
import {
  BASE_MESSAGE,
  waitFor,
  ZYTE_ARTICLE,
} from './handlers/test-helpers.js';

// Set before importing config so the consumer reads these names.
const PROJECT_ID = 'test-project';
const CRAWL_ARTICLE_SUB = 'crawl-article-sub';
const ARTICLES_TOPIC = 'articles-topic';
const ZYTE_API_KEY = 'test-zyte-key';
process.env.PROJECT_ID = PROJECT_ID;
process.env.CRAWL_ARTICLE_SUBSCRIPTION = CRAWL_ARTICLE_SUB;
process.env.ARTICLES_TOPIC = ARTICLES_TOPIC;
process.env.ZYTE_API_KEY = ZYTE_API_KEY;

const CRAWL_ARTICLE_TOPIC = 'crawl-article-topic';
const ARTICLES_VERIFY_SUB = 'articles-verify-sub';

// Pinned for reproducibility; matches the crawl-common integration tests.
const EMULATOR_IMAGE =
  'gcr.io/google.com/cloudsdktool/google-cloud-cli:568.0.0-emulators';
const REDIS_IMAGE = 'redis:7.4.1-alpine';
// The Pub/Sub emulator boots slowly (JVM startup near two minutes
// here), so the container startup budget must be generous. See the
// wait-strategy note in beforeAll.
const CONTAINER_START_TIMEOUT_MS = 180_000;
// The hook must outlast the container startup timeout so
// testcontainers owns the deadline and reports a clear error,
// rather than vitest killing the hook first.
const HOOK_TIMEOUT_MS = CONTAINER_START_TIMEOUT_MS + 30_000;
const CONSUME_TIMEOUT_MS = 10_000;

/**
 * Integration test for the article consumer. Runs the real handler,
 * Pub/Sub client, and Redis dedup against emulators, with Zyte stubbed
 * at the fetch boundary, to verify a crawl-article job produces an
 * event on the articles topic and that a duplicate is deduplicated.
 */
describe('article consumer integration', () => {
  let pubsubContainer: StartedPubSubEmulatorContainer;
  let redisContainer: StartedTestContainer;
  let endpoint: string;
  let redisHost: string;
  let redisPort: number;
  let adminClient: PubSub;
  let startArticleConsumer: () => void;
  let verifySub: Subscription | undefined;
  let testNum = 0;

  beforeAll(async () => {
    // Wait on the emulator's listening port rather than the package
    // default log message: this image stays silent until the very
    // end of its slow boot, so the default log wait races the
    // startup timeout and hangs the hook.
    [pubsubContainer, redisContainer] = await Promise.all([
      new PubSubEmulatorContainer(EMULATOR_IMAGE)
        .withProjectId(PROJECT_ID)
        .withWaitStrategy(Wait.forListeningPorts())
        .withStartupTimeout(CONTAINER_START_TIMEOUT_MS)
        .start(),
      new GenericContainer(REDIS_IMAGE)
        .withExposedPorts(6379)
        .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
        .start(),
    ]);
    endpoint = pubsubContainer.getEmulatorEndpoint();
    redisHost = redisContainer.getHost();
    redisPort = redisContainer.getMappedPort(6379);
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
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await adminClient?.close();
    await Promise.all([pubsubContainer?.stop(), redisContainer?.stop()]);
  });

  beforeEach(() => {
    initZyteClient({ apiKey: ZYTE_API_KEY, maxRetries: 0 });
    initPubSubClient({
      projectId: PROJECT_ID,
      apiEndpoint: endpoint,
      useEmulator: true,
    });
    // A per-test key prefix so dedup state from one test cannot leak
    // into the next through the shared Redis keyspace.
    initRedisClient({
      host: redisHost,
      port: redisPort,
      keyPrefix: `it-${++testNum}:`,
    });
  });

  afterEach(async () => {
    // Close the verify subscription so its streaming pull does not
    // linger and steal the next test's events.
    await verifySub?.close();
    verifySub = undefined;
    await shutdownPubSub();
    await shutdownRedis();
    vi.unstubAllGlobals();
  });

  function stubZyte(): void {
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
  }

  function collectArticleEvents(): ArticleEvent[] {
    const events: ArticleEvent[] = [];
    verifySub = adminClient.subscription(ARTICLES_VERIFY_SUB);
    verifySub.on('message', (m: Message) => {
      events.push(JSON.parse(m.data.toString()) as ArticleEvent);
      m.ack();
    });
    return events;
  }

  it('extracts a published job and publishes the article event', async () => {
    stubZyte();
    const events = collectArticleEvents();

    startArticleConsumer();
    await publishMessage(CRAWL_ARTICLE_TOPIC, BASE_MESSAGE);
    await flushTopics();

    await waitFor(() => events.length >= 1, CONSUME_TIMEOUT_MS);
    expect(events[0]!.url).toBe(BASE_MESSAGE.url);
    expect(events[0]!.headline).toBe(ZYTE_ARTICLE.headline);
  });

  it('deduplicates a re-published job via the Redis fetch marker', async () => {
    stubZyte();
    const events = collectArticleEvents();

    startArticleConsumer();
    await publishMessage(CRAWL_ARTICLE_TOPIC, BASE_MESSAGE);
    await flushTopics();
    await waitFor(() => events.length >= 1, CONSUME_TIMEOUT_MS);

    // Re-publish the same job: the fetch marker suppresses a 2nd event.
    // Asserting an absence is time-bounded; wait comfortably longer than
    // a real round-trip would take so a broken dedup would surface.
    await publishMessage(CRAWL_ARTICLE_TOPIC, BASE_MESSAGE);
    await flushTopics();
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(events).toHaveLength(1);
  });
});
