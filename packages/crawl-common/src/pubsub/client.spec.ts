import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMockMessage,
  createMockMessageRaw,
  createMockPubSub,
  type MockPubSub,
  PROJECT_ID,
  startStalled,
  SUBSCRIPTION_NAME,
  TEST_CONSUMER_OPTIONS,
  TEST_MAX_EXTENSION_SECONDS,
  TEST_PAYLOAD,
  TOPIC_NAME,
  type TestPayload,
} from './test-helpers.js';

// Imports in ES are hoisted to the top. vi.mock is also hoisted
// so the SDK is mocked before it is imported, and vi.hoisted
// makes holder available to MockPubSub.
// https://vitest.dev/api/vi.html#vi-hoisted
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
    startConsumer({ ...TEST_CONSUMER_OPTIONS, handler });

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
    startConsumer({ ...TEST_CONSUMER_OPTIONS, handler });

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
    startConsumer({ ...TEST_CONSUMER_OPTIONS, handler });

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
    startConsumer({ ...TEST_CONSUMER_OPTIONS, handler });

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
    startConsumer({ ...TEST_CONSUMER_OPTIONS });

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
    startConsumer({ ...TEST_CONSUMER_OPTIONS, onError });

    const sub = mock.subscriptions.get(SUBSCRIPTION_NAME)!;
    const err = new Error('transient stream error');
    sub.emit('error', err);

    expect(onError).toHaveBeenCalledWith(err);
  });

  it('wires caller-supplied options to the subscription', () => {
    startConsumer({ ...TEST_CONSUMER_OPTIONS });

    const [name, opts] = mock.subscription.mock.calls[0] as [
      string,
      {
        maxExtensionTime: { seconds: number };
        closeOptions: { behavior: string; timeout: { seconds: number } };
      },
    ];
    expect(name).toBe(SUBSCRIPTION_NAME);
    expect(opts.maxExtensionTime.seconds).toBe(TEST_MAX_EXTENSION_SECONDS);
    expect(opts.closeOptions.behavior).toBe(
      SubscriptionCloseBehaviors.WaitForProcessing,
    );
    expect(opts.closeOptions.timeout.seconds).toBe(SHUTDOWN_TIMEOUT_SECONDS);
  });

  it('stop() calls subscription.close()', async () => {
    const controller = startConsumer({ ...TEST_CONSUMER_OPTIONS });
    const sub = mock.subscriptions.get(SUBSCRIPTION_NAME)!;

    await controller.stop();

    expect(sub.close).toHaveBeenCalledOnce();
  });

  it('stop() does not reject when subscription.close() throws', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const controller = startConsumer({ ...TEST_CONSUMER_OPTIONS });
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
    expect(() => startConsumer({ ...TEST_CONSUMER_OPTIONS })).toThrow(
      /not initialized/,
    );
  });

  it('throws when called while shutdown is in flight', async () => {
    const { release, pending: shutdownP } = await startStalled(
      mock.close,
      shutdownPubsub,
    );
    expect(() => startConsumer({ ...TEST_CONSUMER_OPTIONS })).toThrow(
      /shutdown in progress/,
    );

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

  it('drains consumers fully before closing the client', async () => {
    // Stall sub.close so we can verify mock.close is awaiting
    // it, not fire-and-forget. Handlers must be able to ack or
    // nack via the gRPC stream before the client tears it down.
    const controller = startConsumer({ ...TEST_CONSUMER_OPTIONS });
    const sub = mock.subscriptions.get(SUBSCRIPTION_NAME)!;
    const stopSpy = vi.spyOn(controller, 'stop');

    const { release, pending: shutdownP } = await startStalled(
      sub.close,
      shutdownPubsub,
    );
    expect(stopSpy).toHaveBeenCalled();
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
