import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMockMessage,
  createMockPubSub,
  type MockPubSub,
  PROJECT_ID,
  SUBSCRIPTION_NAME,
  TEST_PAYLOAD,
  TOPIC_NAME,
  type TestPayload,
} from './test-helpers.js';

const holder = vi.hoisted(() => ({ instance: null as unknown }));

vi.mock('@google-cloud/pubsub', () => ({
  PubSub: vi.fn(function MockPubSub() {
    return holder.instance;
  }),
  Duration: { from: (d: { seconds?: number }) => d },
  SubscriptionCloseBehaviors: {
    NackImmediately: 'NACK',
    WaitForProcessing: 'WAIT',
  },
}));

import {
  flushPublisher,
  initPubsubClient,
  publishMessage,
  shutdownPubsub,
  startConsumer,
} from './client.js';

let mock: MockPubSub;

beforeEach(() => {
  mock = createMockPubSub();
  holder.instance = mock;
  initPubsubClient({ projectId: PROJECT_ID });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.PUBSUB_EMULATOR_HOST;
});

describe('initPubsubClient', () => {
  it('throws when publishMessage is called before init', async () => {
    // Re-import a fresh client state by re-initing with
    // an instance that fails, then clearing via shutdown.
    await shutdownPubsub();
    await expect(publishMessage(TOPIC_NAME, TEST_PAYLOAD)).rejects.toThrow(
      /not initialized/,
    );
  });

  it('sets PUBSUB_EMULATOR_HOST when emulatorHost is provided', () => {
    initPubsubClient({
      projectId: PROJECT_ID,
      emulatorHost: 'localhost:8085',
    });
    expect(process.env.PUBSUB_EMULATOR_HOST).toBe('localhost:8085');
  });

  it('leaves PUBSUB_EMULATOR_HOST untouched when omitted', () => {
    delete process.env.PUBSUB_EMULATOR_HOST;
    initPubsubClient({ projectId: PROJECT_ID });
    expect(process.env.PUBSUB_EMULATOR_HOST).toBeUndefined();
  });
});

describe('publishMessage', () => {
  it('JSON-encodes the payload and publishes to the named topic', async () => {
    const id = await publishMessage(TOPIC_NAME, TEST_PAYLOAD);

    expect(id).toBe(`msg-${TOPIC_NAME}`);
    const topic = mock.topics.get(TOPIC_NAME);
    expect(topic).toBeDefined();
    expect(topic!.publishMessage).toHaveBeenCalledOnce();
    const [arg] = topic!.publishMessage.mock.calls[0] as [{ data: Buffer }];
    expect(JSON.parse(arg.data.toString())).toEqual(TEST_PAYLOAD);
  });

  it('reuses a cached Topic for subsequent publishes', async () => {
    await publishMessage(TOPIC_NAME, TEST_PAYLOAD);
    await publishMessage(TOPIC_NAME, TEST_PAYLOAD);

    expect(mock.topic).toHaveBeenCalledTimes(1);
    expect(mock.topics.get(TOPIC_NAME)!.publishMessage).toHaveBeenCalledTimes(
      2,
    );
  });

  it('passes default batching config to the Topic', async () => {
    await publishMessage(TOPIC_NAME, TEST_PAYLOAD);

    const [, opts] = mock.topic.mock.calls[0] as [
      string,
      {
        batching: {
          maxMessages: number;
          maxMilliseconds: number;
          maxBytes: number;
        };
      },
    ];
    expect(opts.batching.maxMessages).toBe(100);
    expect(opts.batching.maxMilliseconds).toBe(100);
    expect(opts.batching.maxBytes).toBe(1_000_000);
  });

  it('forwards overridden batching config to the Topic', async () => {
    initPubsubClient({
      projectId: PROJECT_ID,
      publisherBatching: {
        maxMessages: 5,
        maxMilliseconds: 50,
        maxBytes: 2_048,
      },
    });
    // Re-create mock because init cleared the cache.
    mock = createMockPubSub();
    holder.instance = mock;
    initPubsubClient({
      projectId: PROJECT_ID,
      publisherBatching: {
        maxMessages: 5,
        maxMilliseconds: 50,
        maxBytes: 2_048,
      },
    });
    await publishMessage(TOPIC_NAME, TEST_PAYLOAD);

    const [, opts] = mock.topic.mock.calls[0] as [
      string,
      {
        batching: {
          maxMessages: number;
          maxMilliseconds: number;
          maxBytes: number;
        };
      },
    ];
    expect(opts.batching.maxMessages).toBe(5);
    expect(opts.batching.maxMilliseconds).toBe(50);
    expect(opts.batching.maxBytes).toBe(2_048);
  });
});

describe('flushPublisher', () => {
  it('flushes every cached Topic', async () => {
    await publishMessage('topic-a', TEST_PAYLOAD);
    await publishMessage('topic-b', TEST_PAYLOAD);

    await flushPublisher();

    expect(mock.topics.get('topic-a')!.flush).toHaveBeenCalledOnce();
    expect(mock.topics.get('topic-b')!.flush).toHaveBeenCalledOnce();
  });

  it('is a no-op when no topics are cached', async () => {
    await expect(flushPublisher()).resolves.toBeUndefined();
  });
});

describe('startConsumer', () => {
  it('parses JSON data, invokes the handler, and acks on success', async () => {
    const handler = vi.fn(async () => {});
    startConsumer<TestPayload>({
      subscriptionName: SUBSCRIPTION_NAME,
      handler,
    });

    const sub = mock.subscriptions.get(SUBSCRIPTION_NAME)!;
    const message = createMockMessage(TEST_PAYLOAD);
    await emitAndSettle(sub, 'message', message);

    expect(handler).toHaveBeenCalledWith(TEST_PAYLOAD);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.nack).not.toHaveBeenCalled();
  });

  it('nacks the message when the handler rejects', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = vi.fn(async () => {
      throw new Error('boom');
    });
    startConsumer<TestPayload>({
      subscriptionName: SUBSCRIPTION_NAME,
      handler,
    });

    const sub = mock.subscriptions.get(SUBSCRIPTION_NAME)!;
    const message = createMockMessage(TEST_PAYLOAD);
    await emitAndSettle(sub, 'message', message);

    expect(message.nack).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  it('nacks the message when the payload is not valid JSON', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = vi.fn(async () => {});
    startConsumer<TestPayload>({
      subscriptionName: SUBSCRIPTION_NAME,
      handler,
    });

    const sub = mock.subscriptions.get(SUBSCRIPTION_NAME)!;
    const bad = {
      data: Buffer.from('not json'),
      id: 'bad-1',
      ack: vi.fn(),
      nack: vi.fn(),
    };
    await emitAndSettle(sub, 'message', bad);

    expect(handler).not.toHaveBeenCalled();
    expect(bad.nack).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalled();
  });

  it('passes flow-control defaults and ack deadline to the subscription', () => {
    startConsumer<TestPayload>({
      subscriptionName: SUBSCRIPTION_NAME,
      handler: async () => {},
    });

    const [name, opts] = mock.subscription.mock.calls[0] as [
      string,
      {
        flowControl: { maxMessages: number };
        maxExtensionTime: { seconds: number };
        closeOptions: { behavior: string; timeout: { seconds: number } };
      },
    ];
    expect(name).toBe(SUBSCRIPTION_NAME);
    expect(opts.flowControl.maxMessages).toBe(10);
    expect(opts.maxExtensionTime.seconds).toBe(600);
    expect(opts.closeOptions.behavior).toBe('WAIT');
    expect(opts.closeOptions.timeout.seconds).toBe(600);
  });

  it('applies caller-supplied flow-control overrides', () => {
    startConsumer<TestPayload>({
      subscriptionName: SUBSCRIPTION_NAME,
      handler: async () => {},
      flowControl: { maxMessages: 3, maxExtensionSeconds: 120 },
    });

    const [, opts] = mock.subscription.mock.calls[0] as [
      string,
      {
        flowControl: { maxMessages: number };
        maxExtensionTime: { seconds: number };
        closeOptions: { timeout: { seconds: number } };
      },
    ];
    expect(opts.flowControl.maxMessages).toBe(3);
    expect(opts.maxExtensionTime.seconds).toBe(120);
    expect(opts.closeOptions.timeout.seconds).toBe(120);
  });

  it('stop() closes the subscription and awaits in-flight handlers', async () => {
    let resolveHandler!: () => void;
    const handler = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolveHandler = r;
        }),
    );
    const controller = startConsumer<TestPayload>({
      subscriptionName: SUBSCRIPTION_NAME,
      handler,
    });

    const sub = mock.subscriptions.get(SUBSCRIPTION_NAME)!;
    const message = createMockMessage(TEST_PAYLOAD);
    sub.emit('message', message);
    // Handler is pending.
    expect(message.ack).not.toHaveBeenCalled();

    const stopPromise = controller.stop();
    expect(sub.close).toHaveBeenCalledOnce();

    // The in-flight handler must still complete before stop()
    // resolves.
    let stopped = false;
    void stopPromise.then(() => {
      stopped = true;
    });
    await flushMicrotasks();
    expect(stopped).toBe(false);

    resolveHandler();
    await stopPromise;
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it('stop() is idempotent', async () => {
    const controller = startConsumer<TestPayload>({
      subscriptionName: SUBSCRIPTION_NAME,
      handler: async () => {},
    });
    const sub = mock.subscriptions.get(SUBSCRIPTION_NAME)!;

    await Promise.all([controller.stop(), controller.stop()]);

    expect(sub.close).toHaveBeenCalledOnce();
  });
});

describe('shutdownPubsub', () => {
  it('flushes publishers and closes the underlying client', async () => {
    await publishMessage(TOPIC_NAME, TEST_PAYLOAD);
    const topic = mock.topics.get(TOPIC_NAME)!;

    await shutdownPubsub();

    expect(topic.flush).toHaveBeenCalledOnce();
    expect(mock.close).toHaveBeenCalledOnce();
  });

  it('resets state so subsequent calls require re-init', async () => {
    await shutdownPubsub();
    await expect(publishMessage(TOPIC_NAME, TEST_PAYLOAD)).rejects.toThrow(
      /not initialized/,
    );
  });
});

/** Emit a Pub/Sub event and wait for all handlers to settle. */
async function emitAndSettle(
  emitter: { emit: (event: string, arg: unknown) => boolean },
  event: string,
  arg: unknown,
): Promise<void> {
  emitter.emit(event, arg);
  await flushMicrotasks();
}

/** Yield enough times to let queued microtasks run. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}
