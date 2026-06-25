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
  type ArticleDiscoveryEvent,
  type CrawlArticleMessage,
} from 'crawl-common';
import {
  DISCOVERY_MESSAGE,
  waitFor,
  ZYTE_LIST_ITEM,
} from './handlers/test-helpers.js';

// Set before importing config so the consumer reads these names.
const PROJECT_ID = 'test-project';
const DISCOVERY_SUB = 'discovery-sub';
const ARTICLE_DISCOVERIES_TOPIC = 'article-discoveries-topic';
const CRAWL_ARTICLE_TOPIC = 'crawl-article-topic';
const ZYTE_API_KEY = 'test-zyte-key';
process.env.PROJECT_ID = PROJECT_ID;
process.env.CRAWL_ARTICLE_DISCOVERY_SUBSCRIPTION = DISCOVERY_SUB;
process.env.ARTICLE_DISCOVERIES_TOPIC = ARTICLE_DISCOVERIES_TOPIC;
process.env.CRAWL_ARTICLE_TOPIC = CRAWL_ARTICLE_TOPIC;
process.env.ZYTE_API_KEY = ZYTE_API_KEY;

const DISCOVERY_TOPIC = 'crawl-article-discovery-topic';
const DISCOVERIES_VERIFY_SUB = 'article-discoveries-verify-sub';
const CRAWL_ARTICLE_VERIFY_SUB = 'crawl-article-verify-sub';

// Pinned for reproducibility; matches the crawl-common integration tests.
const EMULATOR_IMAGE =
  'gcr.io/google.com/cloudsdktool/google-cloud-cli:568.0.0-emulators';
const REDIS_IMAGE = 'redis:7.4.1-alpine';
const CONTAINER_START_TIMEOUT_MS = 120_000;
const CONSUME_TIMEOUT_MS = 10_000;

/**
 * Integration test for the discovery consumer. Runs the real handler,
 * Pub/Sub client, and Redis dedup against emulators, with Zyte stubbed
 * at the fetch boundary, to verify a discovery job produces
 * article-discoveries events and crawl-article jobs, and that a
 * re-crawled page is deduplicated.
 */
describe('discovery consumer integration', () => {
  let pubsubContainer: StartedPubSubEmulatorContainer;
  let redisContainer: StartedTestContainer;
  let endpoint: string;
  let redisHost: string;
  let redisPort: number;
  let adminClient: PubSub;
  let startDiscoveryConsumer: () => void;
  let verifySubs: Subscription[] = [];
  let testNum = 0;

  beforeAll(async () => {
    [pubsubContainer, redisContainer] = await Promise.all([
      new PubSubEmulatorContainer(EMULATOR_IMAGE)
        .withProjectId(PROJECT_ID)
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
    await adminClient.createTopic(DISCOVERY_TOPIC);
    await adminClient.topic(DISCOVERY_TOPIC).createSubscription(DISCOVERY_SUB);
    await adminClient.createTopic(ARTICLE_DISCOVERIES_TOPIC);
    await adminClient
      .topic(ARTICLE_DISCOVERIES_TOPIC)
      .createSubscription(DISCOVERIES_VERIFY_SUB);
    await adminClient.createTopic(CRAWL_ARTICLE_TOPIC);
    await adminClient
      .topic(CRAWL_ARTICLE_TOPIC)
      .createSubscription(CRAWL_ARTICLE_VERIFY_SUB);

    ({ startDiscoveryConsumer } = await import('./discovery-consumer.js'));
  }, CONTAINER_START_TIMEOUT_MS);

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
    // A per-test key prefix so page:fetch state from one test cannot
    // skip the next test's first crawl.
    initRedisClient({
      host: redisHost,
      port: redisPort,
      keyPrefix: `it-${++testNum}:`,
    });
  });

  afterEach(async () => {
    // Close verify subscriptions so their streaming pulls do not linger
    // and steal the next test's events.
    await Promise.all(verifySubs.map((s) => s.close()));
    verifySubs = [];
    await shutdownPubSub();
    await shutdownRedis();
    vi.unstubAllGlobals();
  });

  function stubZyte(): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          articleList: { articles: [ZYTE_LIST_ITEM] },
          url: DISCOVERY_MESSAGE.url,
          statusCode: 200,
        }),
      ),
    );
  }

  /** Collect messages from a verify subscription into the given array. */
  function collect<T>(subName: string, into: T[]): void {
    const sub = adminClient.subscription(subName);
    sub.on('message', (m: Message) => {
      into.push(JSON.parse(m.data.toString()) as T);
      m.ack();
    });
    verifySubs.push(sub);
  }

  it('publishes discovery events and crawl-article jobs from a page job', async () => {
    stubZyte();
    const events: ArticleDiscoveryEvent[] = [];
    const jobs: CrawlArticleMessage[] = [];
    collect(DISCOVERIES_VERIFY_SUB, events);
    collect(CRAWL_ARTICLE_VERIFY_SUB, jobs);

    startDiscoveryConsumer();
    await publishMessage(DISCOVERY_TOPIC, DISCOVERY_MESSAGE);
    await flushTopics();

    // Two contexts on one article yields two events and one job.
    await waitFor(
      () => events.length >= 2 && jobs.length >= 1,
      CONSUME_TIMEOUT_MS,
    );
    expect(events.map((e) => e.surface_id).sort()).toEqual([
      'NEW_TAB_DE_DE',
      'NEW_TAB_EN_US',
    ]);
    expect(events.every((e) => e.url === ZYTE_LIST_ITEM.url)).toBe(true);
    expect(jobs[0]!.url).toBe(ZYTE_LIST_ITEM.url);
    expect(jobs[0]!.source_url).toBe(DISCOVERY_MESSAGE.url);
    expect(jobs[0]!.crawl_id).toBeTruthy();
  });

  it('deduplicates a re-crawled page via the Redis page:fetch marker', async () => {
    stubZyte();
    const events: ArticleDiscoveryEvent[] = [];
    collect(DISCOVERIES_VERIFY_SUB, events);

    startDiscoveryConsumer();
    await publishMessage(DISCOVERY_TOPIC, DISCOVERY_MESSAGE);
    await flushTopics();
    await waitFor(() => events.length >= 2, CONSUME_TIMEOUT_MS);

    // Re-publish the same page within its interval: page:fetch suppresses
    // a second crawl, so no further events appear.
    await publishMessage(DISCOVERY_TOPIC, DISCOVERY_MESSAGE);
    await flushTopics();
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(events).toHaveLength(2);
  });
});
