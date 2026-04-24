import { execSync } from 'node:child_process';
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
 * end-to-end against real SDK paths. Auto-skips when Docker
 * is unavailable (e.g. local runs without Docker Desktop);
 * CI runs on ubuntu-latest, which ships with Docker.
 */
const hasDocker = detectDocker();

describe.skipIf(!hasDocker)('Pub/Sub client integration', () => {
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

  it('publishes and consumes a typed message end-to-end', async () => {
    // Exercises shutdownPubsub's consumer-stop path: the
    // test does not call controller.stop() manually, so the
    // real SDK shutdown is driven entirely via afterEach's
    // shutdownPubsub().
    const received: TestPayload[] = [];
    startConsumer<TestPayload>({
      subscriptionName,
      handler: async (message) => {
        received.push(message);
      },
    });

    const messageId = await publishMessage(topicName, TEST_PAYLOAD);
    await flushPublisher();
    expect(messageId).toBeTruthy();

    await waitFor(() => received.length === 1, CONSUME_TIMEOUT_MS);

    expect(received).toEqual([TEST_PAYLOAD]);
  });

  it('delivers multiple messages without loss', async () => {
    const received: TestPayload[] = [];
    const controller = startConsumer<TestPayload>({
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
      await publishMessage(topicName, payload);
    }
    await flushPublisher();

    await waitFor(
      () => received.length === payloads.length,
      CONSUME_TIMEOUT_MS,
    );
    await controller.stop();

    // Order is not strictly guaranteed by Pub/Sub without
    // ordering keys, but with a single publisher and empty
    // backlog the emulator delivers in publish order.
    expect(received.map((r) => r.crawl_id).sort()).toEqual(
      payloads.map((p) => p.crawl_id).sort(),
    );
  });
});

/** Return whether a reachable Docker daemon is available. */
function detectDocker(): boolean {
  try {
    execSync('docker version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

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
