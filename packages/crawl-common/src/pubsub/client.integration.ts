import { PubSub } from '@google-cloud/pubsub';
import {
  PubSubEmulatorContainer,
  type StartedPubSubEmulatorContainer,
} from '@testcontainers/gcloud';
import { Wait } from 'testcontainers';
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
  initPubSubClient,
  publishMessage,
  shutdownPubSub,
  startSubscriber,
} from './client.js';
import {
  PROJECT_ID,
  TEST_MAX_EXTENSION_SECONDS,
  TEST_PAYLOAD,
  type TestPayload,
} from './test-helpers.js';

// Pinned for reproducibility. Bump when the gcloud emulators ship
// a fix or feature we need. See
// https://gcr.io/google.com/cloudsdktool/google-cloud-cli for tags.
const EMULATOR_IMAGE =
  'gcr.io/google.com/cloudsdktool/google-cloud-cli:568.0.0-emulators';
// The emulator boots slowly (JVM startup near two minutes here) and
// the image is large, so the container startup budget must be
// generous. See the wait-strategy note in beforeAll.
const CONTAINER_START_TIMEOUT_MS = 180_000;
// The hook must outlast the container startup timeout so
// testcontainers owns the deadline and reports a clear error,
// rather than vitest killing the hook first.
const HOOK_TIMEOUT_MS = CONTAINER_START_TIMEOUT_MS + 30_000;
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
    // The package default waits for a "Server started" log line, but
    // this emulator image stays silent until the very end of its
    // slow boot and then emits that line, so the default races the
    // startup timeout and hangs the hook. Wait on the listening port
    // instead: it opens exactly when the emulator is ready, and the
    // createTopic call below fails fast if it is not.
    container = await new PubSubEmulatorContainer(EMULATOR_IMAGE)
      .withProjectId(PROJECT_ID)
      .withWaitStrategy(Wait.forListeningPorts())
      .withStartupTimeout(CONTAINER_START_TIMEOUT_MS)
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
  }, HOOK_TIMEOUT_MS);

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
    initPubSubClient({
      projectId: PROJECT_ID,
      apiEndpoint: endpoint,
      useEmulator: true,
    });
  });

  afterEach(async () => {
    await shutdownPubSub();
    await adminClient.subscription(subscriptionName).delete();
    await adminClient.topic(topicName).delete();
  });

  it('publishes and consumes typed messages end-to-end', async () => {
    // Exercises shutdownPubSub's subscriber-stop path: the
    // test does not call controller.stop() manually, so the
    // real SDK shutdown is driven entirely via afterEach's
    // shutdownPubSub(). Three payloads with distinct crawl_ids
    // also verify no loss across a small batch.
    const received: TestPayload[] = [];
    startSubscriber<TestPayload>({
      subscriptionName,
      maxExtensionSeconds: TEST_MAX_EXTENSION_SECONDS,
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
