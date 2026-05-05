import { PubSub } from '@google-cloud/pubsub';
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
} from 'vitest';
import {
  flushPublisher,
  initPubsubClient,
  publishMessage,
  shutdownPubsub,
  startConsumer,
} from './client.js';
import { PROJECT_ID, TEST_PAYLOAD, type TestPayload } from './test-helpers.js';

const EMULATOR_IMAGE = 'gcr.io/google.com/cloudsdktool/cloud-sdk:emulators';
const EMULATOR_STARTUP_MS = 120_000;
const CONSUME_TIMEOUT_MS = 10_000;

/**
 * Integration test for the Pub/Sub client library. Boots a
 * cloud-sdk emulator in Docker and exercises publish/consume
 * end-to-end against real SDK paths.
 */
describe('Pub/Sub client integration', () => {
  let container: StartedPubSubEmulatorContainer;
  let adminClient: PubSub;

  beforeAll(async () => {
    container = await new PubSubEmulatorContainer(EMULATOR_IMAGE)
      .withProjectId(PROJECT_ID)
      .start();
    process.env.PUBSUB_EMULATOR_HOST = container.getEmulatorEndpoint();
    adminClient = new PubSub({ projectId: PROJECT_ID });
  }, EMULATOR_STARTUP_MS);

  afterAll(async () => {
    await adminClient?.close();
    await container?.stop();
    delete process.env.PUBSUB_EMULATOR_HOST;
  });

  let topicName: string;
  let subscriptionName: string;

  beforeEach(async () => {
    const id = Math.random().toString(36).slice(2, 10);
    topicName = `topic-${id}`;
    subscriptionName = `sub-${id}`;
    await adminClient.createTopic(topicName);
    await adminClient.topic(topicName).createSubscription(subscriptionName);
    initPubsubClient({ projectId: PROJECT_ID });
  });

  afterEach(async () => {
    await shutdownPubsub();
    await adminClient.subscription(subscriptionName).delete();
    await adminClient.topic(topicName).delete();
  });

  it('publishes and consumes typed messages end-to-end', async () => {
    // Exercises shutdownPubsub's consumer-stop path: the
    // test does not call controller.stop() manually, so the
    // real SDK shutdown is driven entirely via afterEach's
    // shutdownPubsub(). Three payloads with distinct crawl_ids
    // also verify no loss across a small batch.
    const received: TestPayload[] = [];
    startConsumer<TestPayload>({
      subscriptionName,
      handler: async (message) => {
        received.push(message);
      },
    });

    const payloads: TestPayload[] = [
      { ...TEST_PAYLOAD, crawl_id: 'crawl-1' },
      { ...TEST_PAYLOAD, crawl_id: 'crawl-2' },
      { ...TEST_PAYLOAD, crawl_id: 'crawl-3' },
    ];
    for (const payload of payloads) {
      const messageId = await publishMessage(topicName, payload);
      expect(messageId).toBeTruthy();
    }
    await flushPublisher();

    await waitFor(
      () => received.length === payloads.length,
      CONSUME_TIMEOUT_MS,
    );

    expect(received.map((r) => r.crawl_id).sort()).toEqual(
      payloads.map((p) => p.crawl_id).sort(),
    );
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
