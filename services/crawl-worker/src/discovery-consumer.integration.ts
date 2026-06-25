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

// Pinned for reproducibility; matches the crawl-common integration test.
const EMULATOR_IMAGE =
  'gcr.io/google.com/cloudsdktool/google-cloud-cli:568.0.0-emulators';
const CONTAINER_START_TIMEOUT_MS = 120_000;
const CONSUME_TIMEOUT_MS = 10_000;

/**
 * Integration test for the discovery consumer. Runs the real handler
 * and Pub/Sub client against an emulator, with Zyte stubbed at the
 * fetch boundary, to verify a discovery job produces both
 * article-discoveries events and crawl-article jobs.
 */
describe('discovery consumer integration', () => {
  let container: StartedPubSubEmulatorContainer;
  let endpoint: string;
  let adminClient: PubSub;
  let startDiscoveryConsumer: () => void;

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
    await container?.stop();
  });

  beforeEach(() => {
    initZyteClient({ apiKey: ZYTE_API_KEY, maxRetries: 0 });
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

  it('publishes discovery events and crawl-article jobs from a page job', async () => {
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

    const events: ArticleDiscoveryEvent[] = [];
    adminClient
      .subscription(DISCOVERIES_VERIFY_SUB)
      .on('message', (m: Message) => {
        events.push(JSON.parse(m.data.toString()) as ArticleDiscoveryEvent);
        m.ack();
      });
    const jobs: CrawlArticleMessage[] = [];
    adminClient
      .subscription(CRAWL_ARTICLE_VERIFY_SUB)
      .on('message', (m: Message) => {
        jobs.push(JSON.parse(m.data.toString()) as CrawlArticleMessage);
        m.ack();
      });

    startDiscoveryConsumer();
    await publishMessage(DISCOVERY_TOPIC, DISCOVERY_MESSAGE);
    await flushTopics();

    // Two contexts on one article yields two events and one job.
    await waitFor(
      () => events.length === 2 && jobs.length === 1,
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
});
