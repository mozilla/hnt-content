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
  flushTopics,
  initPubsubClient,
  publishMessage,
  shutdownPubsub,
  startConsumer,
} from './client.js';
import { PROJECT_ID, TEST_PAYLOAD, type TestPayload } from './test-helpers.js';

const EMULATOR_IMAGE = 'gcr.io/google.com/cloudsdktool/cloud-sdk:emulators';
const CONTAINER_START_TIMEOUT_MS = 120_000;
const CONSUME_TIMEOUT_MS = 10_000;

/**
 * Integration test for the Pub/Sub client library. Starts a real
 * Pub/Sub emulator via testcontainers and exercises
 * publish/consume end-to-end against real SDK paths.
 */
describe('Pub/Sub client integration', () => {
  let container: StartedPubSubEmulatorContainer;
  let endpoint: string;
  let adminClient: PubSub;
  let topicName: string;
  let subscriptionName: string;

  beforeAll(async () => {
    container = await new PubSubEmulatorContainer(EMULATOR_IMAGE)
      .withProjectId(PROJECT_ID)
      .start();
    endpoint = container.getEmulatorEndpoint();
    // Pass apiEndpoint + emulatorMode explicitly. Without
    // emulatorMode, google-auth-library still probes the GCE
    // metadata server and burns ~5s per client on the
    // no-route-to-host timeout in CI.
    adminClient = new PubSub({
      projectId: PROJECT_ID,
      apiEndpoint: endpoint,
      emulatorMode: true,
    });
  }, CONTAINER_START_TIMEOUT_MS);

  afterAll(async () => {
    await adminClient?.close();
    await container?.stop();
  });

  beforeEach(async () => {
    const id = Math.random().toString(36).slice(2, 10);
    topicName = `topic-${id}`;
    subscriptionName = `sub-${id}`;
    await adminClient.createTopic(topicName);
    await adminClient.topic(topicName).createSubscription(subscriptionName);
    initPubsubClient({
      projectId: PROJECT_ID,
      apiEndpoint: endpoint,
      useEmulator: true,
    });
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
    await flushTopics();

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
