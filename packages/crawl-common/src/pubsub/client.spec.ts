import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PROJECT_ID,
  SUBSCRIPTION_NAME,
  TEST_PAYLOAD,
  TOPIC_NAME,
  type TestPayload,
} from './test-helpers.js';

const holder = vi.hoisted(() => ({
  instance: null as unknown,
  ctorArgs: undefined as unknown,
}));

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

import {
  flushPublisher,
  initPubsubClient,
  publishMessage,
  shutdownPubsub,
  startConsumer,
} from './client.js';

interface MockTopic {
  publishMessage: ReturnType<typeof vi.fn>;
  flush: ReturnType<typeof vi.fn>;
}

type MockSubscription = EventEmitter & {
  close: ReturnType<typeof vi.fn>;
};

interface MockPubSub {
  topic: ReturnType<typeof vi.fn>;
  subscription: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  topics: Map<string, MockTopic>;
  subscriptions: Map<string, MockSubscription>;
}

/** Build a fresh mock PubSub that caches topic and subscription instances by name. */
function createMockPubSub(): MockPubSub {
  const topics = new Map<string, MockTopic>();
  const subscriptions = new Map<string, MockSubscription>();

  const topic = vi.fn((name: string) => {
    let t = topics.get(name);
    if (!t) {
      t = {
        publishMessage: vi.fn(async () => `msg-${name}`),
        flush: vi.fn(async () => {}),
      };
      topics.set(name, t);
    }
    return t;
  });

  const subscription = vi.fn((name: string) => {
    let s = subscriptions.get(name);
    if (!s) {
      const emitter = new EventEmitter() as MockSubscription;
      emitter.close = vi.fn(async () => {});
      s = emitter;
      subscriptions.set(name, s);
    }
    return s;
  });

  return {
    topic,
    subscription,
    close: vi.fn(async () => {}),
    topics,
    subscriptions,
  };
}

/** Build a mock Pub/Sub Message with only the fields the consumer touches. */
function createMockMessage(
  payload: unknown,
  id = 'test-message-id',
): {
  data: Buffer;
  id: string;
  ack: ReturnType<typeof vi.fn>;
  nack: ReturnType<typeof vi.fn>;
} {
  return {
    data: Buffer.from(JSON.stringify(payload)),
    id,
    ack: vi.fn(),
    nack: vi.fn(),
  };
}

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
  it('throws when publishMessage is called before init', async () => {
    await shutdownPubsub();
    await expect(publishMessage(TOPIC_NAME, TEST_PAYLOAD)).rejects.toThrow(
      /not initialized/,
    );
  });

  it('throws when called while already initialized', () => {
    expect(() => initPubsubClient({ projectId: PROJECT_ID })).toThrow(
      /already initialized/,
    );
  });

  it('passes apiEndpoint + emulatorMode when emulatorHost is provided', async () => {
    await reinit({ projectId: PROJECT_ID, emulatorHost: 'localhost:8085' });
    expect(holder.ctorArgs).toEqual({
      projectId: PROJECT_ID,
      apiEndpoint: 'localhost:8085',
      emulatorMode: true,
    });
  });

  it('omits apiEndpoint/emulatorMode when emulatorHost is absent', async () => {
    await reinit({ projectId: PROJECT_ID });
    expect(holder.ctorArgs).toEqual({ projectId: PROJECT_ID });
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
    await reinit({
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

  it('clears publisherBatching across init -> shutdown -> init', async () => {
    // First init with custom batching
    await reinit({
      projectId: PROJECT_ID,
      publisherBatching: { maxMessages: 5 },
    });
    await publishMessage(TOPIC_NAME, TEST_PAYLOAD);
    // Now re-init without any batching override
    await reinit({ projectId: PROJECT_ID });
    await publishMessage(TOPIC_NAME, TEST_PAYLOAD);

    const [, opts] = mock.topic.mock.calls[0] as [
      string,
      { batching: { maxMessages: number } },
    ];
    expect(opts.batching.maxMessages).toBe(100);
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
    let releaseClose!: () => void;
    mock.close.mockImplementation(
      () =>
        new Promise<void>((r) => {
          releaseClose = r;
        }),
    );

    const shutdownP = shutdownPubsub();
    await flushMicrotasks();
    expect(() =>
      startConsumer<TestPayload>({
        subscriptionName: SUBSCRIPTION_NAME,
        handler: async () => {},
      }),
    ).toThrow(/shutdown in progress/);

    releaseClose();
    await shutdownP;
  });

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
    await emitAndSettle(sub, 'message', message);

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
    await emitAndSettle(sub, 'message', message);

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
    const bad = {
      data: Buffer.from('not json'),
      id: 'bad-1',
      ack: vi.fn(),
      nack: vi.fn(),
    };
    await emitAndSettle(sub, 'message', bad);

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
    sub.emit('error', new Error('stream died'));

    expect(errorSpy.mock.calls[0][0]).toMatch(/pubsub:stream-error/);
    const message = createMockMessage(TEST_PAYLOAD);
    await emitAndSettle(sub, 'message', message);
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
    const err = new Error('stream died');
    sub.emit('error', err);

    expect(onError).toHaveBeenCalledWith(err);
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
    expect(opts.maxExtensionTime.seconds).toBe(570);
    expect(opts.closeOptions.behavior).toBe('WAIT');
    expect(opts.closeOptions.timeout.seconds).toBe(90);
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
      },
    ];
    expect(opts.flowControl.maxMessages).toBe(3);
    expect(opts.maxExtensionTime.seconds).toBe(120);
  });

  it('applies pod-wide shutdownTimeoutSeconds to closeOptions', async () => {
    await reinit({ projectId: PROJECT_ID, shutdownTimeoutSeconds: 15 });
    startConsumer<TestPayload>({
      subscriptionName: SUBSCRIPTION_NAME,
      handler: async () => {},
    });

    const [, opts] = mock.subscription.mock.calls[0] as [
      string,
      { closeOptions: { timeout: { seconds: number } } },
    ];
    expect(opts.closeOptions.timeout.seconds).toBe(15);
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
    expect(message.ack).not.toHaveBeenCalled();

    const stopPromise = controller.stop();
    await flushMicrotasks();
    expect(sub.close).toHaveBeenCalledOnce();

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

  it('stop() times out and warns when a handler never resolves', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await reinit({ projectId: PROJECT_ID, shutdownTimeoutSeconds: 5 });
      const handler = vi.fn(() => new Promise<void>(() => {}));
      const controller = startConsumer<TestPayload>({
        subscriptionName: SUBSCRIPTION_NAME,
        handler,
      });

      const sub = mock.subscriptions.get(SUBSCRIPTION_NAME)!;
      sub.emit('message', createMockMessage(TEST_PAYLOAD));
      await vi.advanceTimersByTimeAsync(0);

      const stopPromise = controller.stop();
      await vi.advanceTimersByTimeAsync(5_000);
      await stopPromise;

      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy.mock.calls[0][0]).toMatch(/pubsub:stop-timeout/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shares the shutdown deadline across subscription.close and in-flight wait', async () => {
    // With a 5s budget, a close() that consumes 3s should
    // leave only ~2s for in-flight wait. A regression that
    // gave each phase its own 5s budget would take ~8s
    // total; the test fails if that happens.
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await reinit({ projectId: PROJECT_ID, shutdownTimeoutSeconds: 5 });
      const handler = vi.fn(() => new Promise<void>(() => {}));
      const controller = startConsumer<TestPayload>({
        subscriptionName: SUBSCRIPTION_NAME,
        handler,
      });

      const sub = mock.subscriptions.get(SUBSCRIPTION_NAME)!;
      sub.close.mockImplementation(
        () => new Promise<void>((r) => setTimeout(r, 3_000)),
      );
      sub.emit('message', createMockMessage(TEST_PAYLOAD));
      await vi.advanceTimersByTimeAsync(0);

      const stopPromise = controller.stop();
      // Advance to the absolute deadline: 3s close + 2s wait.
      await vi.advanceTimersByTimeAsync(5_000);
      await stopPromise;

      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy.mock.calls[0][0]).toMatch(/pubsub:stop-timeout/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() still drains in-flight handlers when subscription.close rejects', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
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
    sub.close.mockImplementation(async () => {
      throw new Error('gRPC close failed');
    });
    const message = createMockMessage(TEST_PAYLOAD);
    sub.emit('message', message);
    await flushMicrotasks();

    const stopPromise = controller.stop();
    await flushMicrotasks();

    // stop() must still be awaiting the in-flight handler,
    // not resolved and swallowing the close error.
    let stopped = false;
    void stopPromise.then(() => {
      stopped = true;
    });
    await flushMicrotasks();
    expect(stopped).toBe(false);

    resolveHandler();
    await stopPromise;
    expect(message.ack).toHaveBeenCalledOnce();
    expect(
      errorSpy.mock.calls.some((c) => /pubsub:close-error/.test(c[0])),
    ).toBe(true);
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
    let releaseClose!: () => void;
    sub.close.mockImplementation(
      () =>
        new Promise<void>((r) => {
          releaseClose = r;
        }),
    );

    const shutdownP = shutdownPubsub();
    await flushMicrotasks();
    expect(sub.close).toHaveBeenCalledOnce();
    expect(mock.close).not.toHaveBeenCalled();

    releaseClose();
    await shutdownP;
    expect(mock.close).toHaveBeenCalledOnce();
  });

  it('lets an in-flight handler publishMessage during consumer drain', async () => {
    let resolveHandler!: () => void;
    const handler = vi.fn(async () => {
      await new Promise<void>((r) => {
        resolveHandler = r;
      });
      await publishMessage('result-topic', { ok: true });
    });
    startConsumer<TestPayload>({
      subscriptionName: SUBSCRIPTION_NAME,
      handler,
    });

    const sub = mock.subscriptions.get(SUBSCRIPTION_NAME)!;
    sub.emit('message', createMockMessage(TEST_PAYLOAD));
    await flushMicrotasks();

    const shutdownP = shutdownPubsub();
    await flushMicrotasks();
    // Shutdown is waiting on consumer.stop which is waiting
    // on the handler. Release the handler so it can publish.
    resolveHandler();
    await shutdownP;

    // The handler's downstream publish must have succeeded
    // rather than hitting "not initialized".
    const resultTopic = mock.topics.get('result-topic');
    expect(resultTopic).toBeDefined();
    expect(resultTopic!.publishMessage).toHaveBeenCalledOnce();
  });

  it('rejects initPubsubClient while shutdown is in flight', async () => {
    let releaseClose!: () => void;
    mock.close.mockImplementation(
      () =>
        new Promise<void>((r) => {
          releaseClose = r;
        }),
    );

    const shutdownP = shutdownPubsub();
    await flushMicrotasks();
    expect(() => initPubsubClient({ projectId: PROJECT_ID })).toThrow(
      /shutdown in progress/,
    );

    releaseClose();
    await shutdownP;
  });

  it('rejects external publishMessage once consumers have drained', async () => {
    // After consumer-stop completes, pubsub is nulled so new
    // publishes outside of handler callbacks fail with the
    // library's own error rather than a post-close SDK one.
    await publishMessage(TOPIC_NAME, TEST_PAYLOAD);
    let releaseClose!: () => void;
    mock.close.mockImplementation(
      () =>
        new Promise<void>((r) => {
          releaseClose = r;
        }),
    );

    const shutdownP = shutdownPubsub();
    await flushMicrotasks();
    await expect(publishMessage(TOPIC_NAME, TEST_PAYLOAD)).rejects.toThrow(
      /not initialized/,
    );

    releaseClose();
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
    await expect(shutdownPubsub()).resolves.toBeUndefined();
    expect(mock.close).toHaveBeenCalledOnce();
  });

  it('is a no-op when the client is uninitialized', async () => {
    await shutdownPubsub();
    mock.close.mockClear();
    await expect(shutdownPubsub()).resolves.toBeUndefined();
    expect(mock.close).not.toHaveBeenCalled();
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

/**
 * Yield a fixed number of times so queued microtasks drain.
 * Five covers the internal await depth of stop() / process-
 * Message with slack; bump if new awaits are added and a
 * dependent test starts observing mid-state.
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}
