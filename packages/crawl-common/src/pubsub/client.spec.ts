import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMockMessage,
  createMockMessageRaw,
  createMockPubSub,
  type MockPubSub,
  PROJECT_ID,
  startStalled,
  SUBSCRIPTION_NAME,
  TEST_SUBSCRIBER_OPTIONS,
  TEST_MAX_EXTENSION_SECONDS,
  TEST_PAYLOAD,
  TOPIC_NAME,
  type TestPayload,
} from './test-helpers.js';

// We replace @google-cloud/pubsub before client.ts imports it.
// The vi.mock factory and the tests below both depend on these
// bindings, so vi.hoisted lifts them to the same pre-import level
// as the vi.mock call.
// https://vitest.dev/api/vi.html#vi-hoisted

// After vi.mock mocks the SDK below, `new PubSub(...)` returns
// mockPubSub. beforeEach() assigns a fresh mock before each test;
// a few tests additionally call reinit() to re-initialize with
// different options. Typed as MockPubSub since the initial null
// is replaced before any test reads it.
let mockPubSub = vi.hoisted(() => null as unknown as MockPubSub);

// On every `new PubSub(...)` call, the mocked constructor writes its
// options argument here. Tests read it to assert how
// initPubSubClient initialized the SDK.
let mockPubSubConstructorArgs = vi.hoisted(() => undefined as unknown);

// vi.mock must run before any import of @google-cloud/pubsub.
vi.mock('@google-cloud/pubsub', () => ({
  PubSub: vi.fn(function MockPubSub(opts: unknown) {
    mockPubSubConstructorArgs = opts;
    return mockPubSub;
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
  initPubSubClient,
  publishMessage,
  SHUTDOWN_TIMEOUT_SECONDS,
  shutdownPubSub,
  startSubscriber,
} from './client.js';

beforeEach(() => {
  mockPubSub = createMockPubSub();
  initPubSubClient({ projectId: PROJECT_ID });
});

afterEach(async () => {
  await shutdownPubSub();
  vi.restoreAllMocks();
});

/** Swap in a fresh mock instance and re-init with the given opts. */
async function reinit(
  opts: Parameters<typeof initPubSubClient>[0] = { projectId: PROJECT_ID },
): Promise<void> {
  await shutdownPubSub();
  mockPubSub = createMockPubSub();
  initPubSubClient(opts);
}

describe('initPubSubClient', () => {
  it('omits apiEndpoint and emulatorMode when not provided', async () => {
    await reinit({ projectId: PROJECT_ID });
    expect(mockPubSubConstructorArgs).toEqual({ projectId: PROJECT_ID });
  });

  it('throws when called while already initialized', () => {
    expect(() => initPubSubClient({ projectId: PROJECT_ID })).toThrow(
      /already initialized/,
    );
  });

  it('throws when publishMessage is called before init', async () => {
    await shutdownPubSub();
    await expect(publishMessage(TOPIC_NAME, TEST_PAYLOAD)).rejects.toThrow(
      /not initialized/,
    );
  });
});

describe('publishMessage', () => {
  it('JSON-encodes the payload and publishes to the named topic', async () => {
    await publishMessage(TOPIC_NAME, TEST_PAYLOAD);

    const topic = mockPubSub.topics.get(TOPIC_NAME);
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
    expect(mockPubSub.topic).toHaveBeenCalledTimes(1);
    expect(
      mockPubSub.topics.get(TOPIC_NAME)!.publishMessage,
    ).toHaveBeenCalledTimes(2);
  });
});

describe('flushTopics', () => {
  it('flushes every cached Topic', async () => {
    await publishMessage('topic-a', TEST_PAYLOAD);
    await publishMessage('topic-b', TEST_PAYLOAD);

    await flushTopics();

    expect(mockPubSub.topics.get('topic-a')!.flush).toHaveBeenCalledOnce();
    expect(mockPubSub.topics.get('topic-b')!.flush).toHaveBeenCalledOnce();
  });
});

describe('startSubscriber', () => {
  it('parses JSON data, invokes the handler, and acks on success', async () => {
    const handler = vi.fn(async () => {});
    startSubscriber({ ...TEST_SUBSCRIBER_OPTIONS, handler });

    const sub = mockPubSub.subscriptions.get(SUBSCRIPTION_NAME)!;
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
    startSubscriber({ ...TEST_SUBSCRIBER_OPTIONS, handler });

    const sub = mockPubSub.subscriptions.get(SUBSCRIPTION_NAME)!;
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
    startSubscriber({ ...TEST_SUBSCRIBER_OPTIONS, handler });

    const sub = mockPubSub.subscriptions.get(SUBSCRIPTION_NAME)!;
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
    startSubscriber({ ...TEST_SUBSCRIBER_OPTIONS, handler });

    const sub = mockPubSub.subscriptions.get(SUBSCRIPTION_NAME)!;
    const bad = createMockMessageRaw(Buffer.from('not json'), 'bad-1');
    sub.emit('message', bad);
    await bad.settled;

    expect(handler).not.toHaveBeenCalled();
    expect(bad.nack).toHaveBeenCalledOnce();
    expect(errorSpy.mock.calls[0][0]).toMatch(/pubsub:parse-error/);
  });

  it("logs subscription 'error' events without stopping the subscriber", async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    startSubscriber({ ...TEST_SUBSCRIBER_OPTIONS });

    const sub = mockPubSub.subscriptions.get(SUBSCRIPTION_NAME)!;
    sub.emit('error', new Error('transient stream error'));

    expect(errorSpy.mock.calls[0][0]).toMatch(/pubsub:stream-error/);
    // Subsequent message still acks; subscriber survived the error.
    const message = createMockMessage(TEST_PAYLOAD);
    sub.emit('message', message);
    await message.settled;
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it('routes stream errors to onError when provided', () => {
    const onError = vi.fn();
    startSubscriber({ ...TEST_SUBSCRIBER_OPTIONS, onError });

    const sub = mockPubSub.subscriptions.get(SUBSCRIPTION_NAME)!;
    const err = new Error('transient stream error');
    sub.emit('error', err);

    expect(onError).toHaveBeenCalledWith(err, { kind: 'stream-error' });
  });

  it('routes close errors to onError when provided', async () => {
    const onError = vi.fn();
    const controller = startSubscriber({
      ...TEST_SUBSCRIBER_OPTIONS,
      onError,
    });
    const sub = mockPubSub.subscriptions.get(SUBSCRIPTION_NAME)!;
    const err = new Error('gRPC close failed');
    sub.close.mockImplementation(async () => {
      throw err;
    });

    await controller.stop();

    expect(onError).toHaveBeenCalledWith(err, { kind: 'close-error' });
  });

  it('routes parse errors to onError with messageId', async () => {
    const onError = vi.fn();
    startSubscriber({ ...TEST_SUBSCRIBER_OPTIONS, onError });
    const sub = mockPubSub.subscriptions.get(SUBSCRIPTION_NAME)!;
    const bad = createMockMessageRaw(Buffer.from('not json'), 'bad-1');
    sub.emit('message', bad);
    await bad.settled;

    expect(onError).toHaveBeenCalledWith(expect.any(Error), {
      kind: 'parse-error',
      messageId: 'bad-1',
    });
  });

  it('wires caller-supplied options to the subscription', () => {
    startSubscriber({ ...TEST_SUBSCRIBER_OPTIONS });

    const [name, opts] = mockPubSub.subscription.mock.calls[0] as [
      string,
      {
        maxExtensionTime: { seconds: number };
        flowControl?: { maxMessages: number };
        closeOptions: { behavior: string; timeout: { seconds: number } };
      },
    ];
    expect(name).toBe(SUBSCRIPTION_NAME);
    expect(opts.maxExtensionTime.seconds).toBe(TEST_MAX_EXTENSION_SECONDS);
    expect(opts.closeOptions.behavior).toBe(
      SubscriptionCloseBehaviors.WaitForProcessing,
    );
    expect(opts.closeOptions.timeout.seconds).toBe(SHUTDOWN_TIMEOUT_SECONDS);
    // Omitted so the SDK default applies when no limit is given.
    expect(opts.flowControl).toBeUndefined();
  });

  it('sets flowControl.maxMessages when maxConcurrentMessages is given', () => {
    startSubscriber({ ...TEST_SUBSCRIBER_OPTIONS, maxConcurrentMessages: 20 });

    const [, opts] = mockPubSub.subscription.mock.calls[0] as [
      string,
      { flowControl?: { maxMessages: number } },
    ];
    expect(opts.flowControl).toEqual({
      maxMessages: 20,
      allowExcessMessages: false,
    });
  });

  it('stop() calls subscription.close()', async () => {
    const controller = startSubscriber({ ...TEST_SUBSCRIBER_OPTIONS });
    const sub = mockPubSub.subscriptions.get(SUBSCRIPTION_NAME)!;

    await controller.stop();

    expect(sub.close).toHaveBeenCalledOnce();
  });

  it('stop() does not reject when subscription.close() throws', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const controller = startSubscriber({ ...TEST_SUBSCRIBER_OPTIONS });
    const sub = mockPubSub.subscriptions.get(SUBSCRIPTION_NAME)!;
    sub.close.mockImplementation(async () => {
      throw new Error('gRPC close failed');
    });

    await controller.stop();
    expect(
      errorSpy.mock.calls.some((c) => /pubsub:close-error/.test(c[0])),
    ).toBe(true);
  });

  it('does not call onError for handler-error (wrapper owns capture)', async () => {
    // The caller owns the handler, so it owns handler errors: it has
    // the per-message context (url, crawl_id) that pubsub lacks here.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onError = vi.fn();
    const handler = vi.fn(async () => {
      throw new Error('boom');
    });
    startSubscriber({ ...TEST_SUBSCRIBER_OPTIONS, handler, onError });

    const sub = mockPubSub.subscriptions.get(SUBSCRIPTION_NAME)!;
    const message = createMockMessage(TEST_PAYLOAD);
    sub.emit('message', message);
    await message.settled;

    expect(onError).not.toHaveBeenCalled();
  });

  it('throws when called before initPubSubClient', async () => {
    await shutdownPubSub();
    expect(() => startSubscriber({ ...TEST_SUBSCRIBER_OPTIONS })).toThrow(
      /not initialized/,
    );
  });

  it('throws when called while shutdown is in flight', async () => {
    const { release, pending: shutdownP } = await startStalled(
      mockPubSub.close,
      shutdownPubSub,
    );
    expect(() => startSubscriber({ ...TEST_SUBSCRIBER_OPTIONS })).toThrow(
      /shutdown in progress/,
    );

    release();
    await shutdownP;
  });
});

describe('shutdownPubSub', () => {
  it('flushes topics and closes the underlying client', async () => {
    await publishMessage(TOPIC_NAME, TEST_PAYLOAD);
    const topic = mockPubSub.topics.get(TOPIC_NAME)!;

    await shutdownPubSub();

    expect(topic.flush).toHaveBeenCalledOnce();
    expect(mockPubSub.close).toHaveBeenCalledOnce();
  });

  it('drains subscribers fully before closing the client', async () => {
    // Stall sub.close so we can verify mockPubSub.close is awaiting
    // it, not fire-and-forget. Handlers must be able to ack or
    // nack via the gRPC stream before the client tears it down.
    const controller = startSubscriber({ ...TEST_SUBSCRIBER_OPTIONS });
    const sub = mockPubSub.subscriptions.get(SUBSCRIPTION_NAME)!;
    const stopSpy = vi.spyOn(controller, 'stop');

    const { release, pending: shutdownP } = await startStalled(
      sub.close,
      shutdownPubSub,
    );
    expect(stopSpy).toHaveBeenCalled();
    expect(sub.close).toHaveBeenCalledOnce();
    expect(mockPubSub.close).not.toHaveBeenCalled();

    release();
    await shutdownP;
    expect(mockPubSub.close).toHaveBeenCalledOnce();
  });

  it('rejects initPubSubClient while shutdown is in flight', async () => {
    const { release, pending: shutdownP } = await startStalled(
      mockPubSub.close,
      shutdownPubSub,
    );
    expect(() => initPubSubClient({ projectId: PROJECT_ID })).toThrow(
      /shutdown in progress/,
    );

    release();
    await shutdownP;
  });

  it('resets state so subsequent calls require re-init', async () => {
    await shutdownPubSub();
    await expect(publishMessage(TOPIC_NAME, TEST_PAYLOAD)).rejects.toThrow(
      /not initialized/,
    );
  });

  it('is idempotent and safe to call twice', async () => {
    await shutdownPubSub();
    await shutdownPubSub();
    expect(mockPubSub.close).toHaveBeenCalledOnce();
  });

  it('is a no-op when the client is uninitialized', async () => {
    await shutdownPubSub();
    mockPubSub.close.mockClear();
    await shutdownPubSub();
    expect(mockPubSub.close).not.toHaveBeenCalled();
  });
});
