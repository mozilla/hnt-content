import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMockMessage,
  createMockMessageRaw,
  createMockPubSub,
  type MockPubSub,
  PROJECT_ID,
  startStalled,
  SUBSCRIPTION_NAME,
  TEST_PAYLOAD,
  TOPIC_NAME,
  type TestPayload,
} from './test-helpers.js';

const holder = vi.hoisted(() => ({
  instance: null as unknown,
  ctorArgs: undefined as unknown,
}));

// vi.mock must run before any import of @google-cloud/pubsub.
vi.mock('@google-cloud/pubsub', () => ({
  PubSub: vi.fn(function MockPubSub(opts: unknown) {
    holder.ctorArgs = opts;
    return holder.instance;
  }),
  Duration: { from: (d: { seconds?: number }) => d },
  SubscriptionCloseBehaviors: {
    NackImmediately: 'NACK',
    WaitForProcessing: 'WAIT',
  },
}));

import { SubscriptionCloseBehaviors } from '@google-cloud/pubsub';
import {
  DEFAULT_CONSUMER_MAX_EXTENSION_SECONDS,
  flushTopics,
  initPubsubClient,
  publishMessage,
  SHUTDOWN_TIMEOUT_SECONDS,
  shutdownPubsub,
  startConsumer,
} from './client.js';

let mock: MockPubSub;

beforeEach(() => {
  holder.ctorArgs = undefined;
  mock = createMockPubSub();
  holder.instance = mock;
  initPubsubClient({ projectId: PROJECT_ID });
});

afterEach(async () => {
  await shutdownPubsub();
  vi.restoreAllMocks();
});

/** Swap the holder to a fresh mock and re-init with the given opts. */
async function reinit(
  opts: Parameters<typeof initPubsubClient>[0] = { projectId: PROJECT_ID },
): Promise<void> {
  await shutdownPubsub();
  mock = createMockPubSub();
  holder.instance = mock;
  initPubsubClient(opts);
}

describe('initPubsubClient', () => {
  it('omits apiEndpoint and emulatorMode when not provided', async () => {
    await reinit({ projectId: PROJECT_ID });
    expect(holder.ctorArgs).toEqual({ projectId: PROJECT_ID });
  });

  it('passes apiEndpoint and emulatorMode through to the SDK', async () => {
    await reinit({
      projectId: PROJECT_ID,
      apiEndpoint: 'localhost:8085',
      useEmulator: true,
    });
    expect(holder.ctorArgs).toEqual({
      projectId: PROJECT_ID,
      apiEndpoint: 'localhost:8085',
      emulatorMode: true,
    });
  });

  it('throws when called while already initialized', () => {
    expect(() => initPubsubClient({ projectId: PROJECT_ID })).toThrow(
      /already initialized/,
    );
  });

  it('throws when publishMessage is called before init', async () => {
    await shutdownPubsub();
    await expect(publishMessage(TOPIC_NAME, TEST_PAYLOAD)).rejects.toThrow(
      /not initialized/,
    );
  });
});

describe('publishMessage', () => {
  it('JSON-encodes the payload and publishes to the named topic', async () => {
    await publishMessage(TOPIC_NAME, TEST_PAYLOAD);

    const topic = mock.topics.get(TOPIC_NAME);
    expect(topic).toBeDefined();
    expect(topic!.publishMessage).toHaveBeenCalledOnce();
    const [arg] = topic!.publishMessage.mock.calls[0] as [{ data: Buffer }];
    expect(JSON.parse(arg.data.toString())).toEqual(TEST_PAYLOAD);
  });

  it('reuses a cached Topic for subsequent publishes', async () => {
    await publishMessage(TOPIC_NAME, TEST_PAYLOAD);
    await publishMessage(TOPIC_NAME, TEST_PAYLOAD);

    // pubsub.topic() is the factory; calling it once means the
    // second publish reused the cached Topic.
    expect(mock.topic).toHaveBeenCalledTimes(1);
    expect(mock.topics.get(TOPIC_NAME)!.publishMessage).toHaveBeenCalledTimes(
      2,
    );
  });
});

describe('flushTopics', () => {
  it('flushes every cached Topic', async () => {
    await publishMessage('topic-a', TEST_PAYLOAD);
    await publishMessage('topic-b', TEST_PAYLOAD);

    await flushTopics();

    expect(mock.topics.get('topic-a')!.flush).toHaveBeenCalledOnce();
    expect(mock.topics.get('topic-b')!.flush).toHaveBeenCalledOnce();
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
    sub.emit('message', message);
    await message.settled;

    expect(handler).toHaveBeenCalledWith(TEST_PAYLOAD);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.nack).not.toHaveBeenCalled();
  });

  it('nacks and logs pubsub:handler-error when the handler rejects', async () => {
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
    sub.emit('message', message);
    await message.settled;

    expect(message.nack).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls[0][0]).toMatch(/pubsub:handler-error/);
  });

  it('nacks when the handler throws synchronously', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = vi.fn(() => {
      throw new Error('sync boom');
    }) as unknown as (m: TestPayload) => Promise<void>;
    startConsumer<TestPayload>({
      subscriptionName: SUBSCRIPTION_NAME,
      handler,
    });

    const sub = mock.subscriptions.get(SUBSCRIPTION_NAME)!;
    const message = createMockMessage(TEST_PAYLOAD);
    sub.emit('message', message);
    await message.settled;

    expect(message.nack).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls[0][0]).toMatch(/pubsub:handler-error/);
  });

  it('nacks and logs pubsub:parse-error on invalid JSON', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = vi.fn(async () => {});
    startConsumer<TestPayload>({
      subscriptionName: SUBSCRIPTION_NAME,
      handler,
    });

    const sub = mock.subscriptions.get(SUBSCRIPTION_NAME)!;
    const bad = createMockMessageRaw(Buffer.from('not json'), 'bad-1');
    sub.emit('message', bad);
    await bad.settled;

    expect(handler).not.toHaveBeenCalled();
    expect(bad.nack).toHaveBeenCalledOnce();
    expect(errorSpy.mock.calls[0][0]).toMatch(/pubsub:parse-error/);
  });

  it("logs subscription 'error' events without stopping the consumer", async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    startConsumer<TestPayload>({
      subscriptionName: SUBSCRIPTION_NAME,
      handler: async () => {},
    });

    const sub = mock.subscriptions.get(SUBSCRIPTION_NAME)!;
    sub.emit('error', new Error('transient stream error'));

    expect(errorSpy.mock.calls[0][0]).toMatch(/pubsub:stream-error/);
    // Subsequent message still acks; consumer survived the error.
    const message = createMockMessage(TEST_PAYLOAD);
    sub.emit('message', message);
    await message.settled;
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it('routes subscription errors to onError when provided', () => {
    const onError = vi.fn();
    startConsumer<TestPayload>({
      subscriptionName: SUBSCRIPTION_NAME,
      handler: async () => {},
      onError,
    });

    const sub = mock.subscriptions.get(SUBSCRIPTION_NAME)!;
    const err = new Error('transient stream error');
    sub.emit('error', err);

    expect(onError).toHaveBeenCalledWith(err);
  });

  it('wires constants for ack deadline and close behavior to the subscription', () => {
    startConsumer<TestPayload>({
      subscriptionName: SUBSCRIPTION_NAME,
      handler: async () => {},
    });

    const [name, opts] = mock.subscription.mock.calls[0] as [
      string,
      {
        maxExtensionTime: { seconds: number };
        closeOptions: { behavior: string; timeout: { seconds: number } };
      },
    ];
    expect(name).toBe(SUBSCRIPTION_NAME);
    expect(opts.maxExtensionTime.seconds).toBe(
      DEFAULT_CONSUMER_MAX_EXTENSION_SECONDS,
    );
    expect(opts.closeOptions.behavior).toBe(
      SubscriptionCloseBehaviors.WaitForProcessing,
    );
    expect(opts.closeOptions.timeout.seconds).toBe(SHUTDOWN_TIMEOUT_SECONDS);
  });

  it('applies caller-supplied maxExtensionSeconds', () => {
    startConsumer<TestPayload>({
      subscriptionName: SUBSCRIPTION_NAME,
      handler: async () => {},
      maxExtensionSeconds: 120,
    });

    const [, opts] = mock.subscription.mock.calls[0] as [
      string,
      { maxExtensionTime: { seconds: number } },
    ];
    expect(opts.maxExtensionTime.seconds).toBe(120);
  });

  it('stop() calls subscription.close()', async () => {
    const controller = startConsumer<TestPayload>({
      subscriptionName: SUBSCRIPTION_NAME,
      handler: async () => {},
    });
    const sub = mock.subscriptions.get(SUBSCRIPTION_NAME)!;

    await controller.stop();

    expect(sub.close).toHaveBeenCalledOnce();
  });

  it('stop() does not reject when subscription.close() throws', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const controller = startConsumer<TestPayload>({
      subscriptionName: SUBSCRIPTION_NAME,
      handler: async () => {},
    });
    const sub = mock.subscriptions.get(SUBSCRIPTION_NAME)!;
    sub.close.mockImplementation(async () => {
      throw new Error('gRPC close failed');
    });

    await controller.stop();
    expect(
      errorSpy.mock.calls.some((c) => /pubsub:close-error/.test(c[0])),
    ).toBe(true);
  });

  it('throws when called before initPubsubClient', async () => {
    await shutdownPubsub();
    expect(() =>
      startConsumer<TestPayload>({
        subscriptionName: SUBSCRIPTION_NAME,
        handler: async () => {},
      }),
    ).toThrow(/not initialized/);
  });

  it('throws when called while shutdown is in flight', async () => {
    const { release, pending: shutdownP } = await startStalled(
      mock.close,
      shutdownPubsub,
    );
    expect(() =>
      startConsumer<TestPayload>({
        subscriptionName: SUBSCRIPTION_NAME,
        handler: async () => {},
      }),
    ).toThrow(/shutdown in progress/);

    release();
    await shutdownP;
  });
});

describe('shutdownPubsub', () => {
  it('flushes topics and closes the underlying client', async () => {
    await publishMessage(TOPIC_NAME, TEST_PAYLOAD);
    const topic = mock.topics.get(TOPIC_NAME)!;

    await shutdownPubsub();

    expect(topic.flush).toHaveBeenCalledOnce();
    expect(mock.close).toHaveBeenCalledOnce();
  });

  it('stops registered consumers before closing the client', async () => {
    const controller = startConsumer<TestPayload>({
      subscriptionName: SUBSCRIPTION_NAME,
      handler: async () => {},
    });
    const sub = mock.subscriptions.get(SUBSCRIPTION_NAME)!;
    const stopSpy = vi.spyOn(controller, 'stop');

    await shutdownPubsub();

    expect(stopSpy).toHaveBeenCalled();
    expect(sub.close).toHaveBeenCalled();
    expect(mock.close).toHaveBeenCalled();
    // controller.stop() must resolve before pubsub client
    // close so handlers can ack/nack before the stream dies.
    expect(sub.close.mock.invocationCallOrder[0]).toBeLessThan(
      mock.close.mock.invocationCallOrder[0],
    );
  });

  it('awaits consumer.stop() to resolve before closing the client', async () => {
    // Prior invocation-order assertion only proves sub.close
    // was called before mock.close; a fire-and-forget stop
    // would still pass. Gate sub.close so it resolves only
    // when we release it and verify mock.close does not run
    // in the meantime.
    startConsumer<TestPayload>({
      subscriptionName: SUBSCRIPTION_NAME,
      handler: async () => {},
    });
    const sub = mock.subscriptions.get(SUBSCRIPTION_NAME)!;
    const { release, pending: shutdownP } = await startStalled(
      sub.close,
      shutdownPubsub,
    );
    expect(sub.close).toHaveBeenCalledOnce();
    expect(mock.close).not.toHaveBeenCalled();

    release();
    await shutdownP;
    expect(mock.close).toHaveBeenCalledOnce();
  });

  it('rejects initPubsubClient while shutdown is in flight', async () => {
    const { release, pending: shutdownP } = await startStalled(
      mock.close,
      shutdownPubsub,
    );
    expect(() => initPubsubClient({ projectId: PROJECT_ID })).toThrow(
      /shutdown in progress/,
    );

    release();
    await shutdownP;
  });

  it('rejects external publishMessage once consumers have drained', async () => {
    // After consumer-stop completes, pubsub is nulled so new
    // publishes outside of handler callbacks fail with the
    // library's own error rather than a post-close SDK one.
    await publishMessage(TOPIC_NAME, TEST_PAYLOAD);
    const { release, pending: shutdownP } = await startStalled(
      mock.close,
      shutdownPubsub,
    );
    await expect(publishMessage(TOPIC_NAME, TEST_PAYLOAD)).rejects.toThrow(
      /not initialized/,
    );

    release();
    await shutdownP;
  });

  it('resets state so subsequent calls require re-init', async () => {
    await shutdownPubsub();
    await expect(publishMessage(TOPIC_NAME, TEST_PAYLOAD)).rejects.toThrow(
      /not initialized/,
    );
  });

  it('is idempotent and safe to call twice', async () => {
    await shutdownPubsub();
    await shutdownPubsub();
    expect(mock.close).toHaveBeenCalledOnce();
  });

  it('is a no-op when the client is uninitialized', async () => {
    await shutdownPubsub();
    mock.close.mockClear();
    await shutdownPubsub();
    expect(mock.close).not.toHaveBeenCalled();
  });
});
