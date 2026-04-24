import {
  Duration,
  PubSub,
  SubscriptionCloseBehaviors,
  type Message,
  type Topic,
} from '@google-cloud/pubsub';
import type {
  ConsumerController,
  ConsumerOptions,
  MessageHandler,
  PublisherBatching,
  PubsubClientOptions,
} from './types.js';

// Defaults tuned for a per-pod article worker that is
// Zyte-bound: small in-memory queue, ack extension set 30s
// below the 600s Pub/Sub ack deadline so downstream lock TTLs
// (ack_deadline - 30s) outlive any single lease extension.
const DEFAULT_FLOW_MAX_MESSAGES = 10;
const DEFAULT_MAX_EXTENSION_SECONDS = 570;

// Shutdown budget applied as a single absolute deadline
// across SDK close and the subsequent in-flight wait. Must
// fit within a typical Kubernetes
// terminationGracePeriodSeconds.
const DEFAULT_SHUTDOWN_TIMEOUT_SECONDS = 90;

// Publisher batching defaults match the SDK's documented
// defaults for small payloads (~100 messages / 100ms / 1MB).
const DEFAULT_BATCH_MAX_MESSAGES = 100;
const DEFAULT_BATCH_MAX_MILLISECONDS = 100;
const DEFAULT_BATCH_MAX_BYTES = 1_000_000;

// Module-level state.
let pubsub: PubSub | undefined;
let publisherBatching: PublisherBatching | undefined;
let shutdownTimeoutSeconds = DEFAULT_SHUTDOWN_TIMEOUT_SECONDS;
let shutdownPromise: Promise<void> | undefined;
const topicCache = new Map<string, Topic>();
const consumerControllers = new Set<ConsumerController>();

/** Reset all module state to its post-initialization defaults. */
function resetModuleState(): void {
  pubsub = undefined;
  publisherBatching = undefined;
  shutdownTimeoutSeconds = DEFAULT_SHUTDOWN_TIMEOUT_SECONDS;
  shutdownPromise = undefined;
  topicCache.clear();
  consumerControllers.clear();
}

/**
 * Initialize the Pub/Sub client. Throws if already
 * initialized or if a shutdown is in progress; await
 * shutdownPubsub first to re-initialize. Unlike the sibling
 * HTTP clients, an open subscription owns a gRPC stream and
 * in-flight messages; silent replacement would leak both.
 */
export function initPubsubClient(opts: PubsubClientOptions): void {
  if (shutdownPromise) {
    throw new Error(
      'Pub/Sub shutdown in progress. Await shutdownPubsub() first.',
    );
  }
  if (pubsub) {
    throw new Error(
      'Pub/Sub client already initialized. Call shutdownPubsub() first.',
    );
  }
  const sdkOpts: {
    projectId: string;
    apiEndpoint?: string;
    emulatorMode?: boolean;
  } = { projectId: opts.projectId };
  if (opts.emulatorHost) {
    sdkOpts.apiEndpoint = opts.emulatorHost;
    sdkOpts.emulatorMode = true;
  }
  pubsub = new PubSub(sdkOpts);
  publisherBatching = opts.publisherBatching;
  shutdownTimeoutSeconds =
    opts.shutdownTimeoutSeconds ?? DEFAULT_SHUTDOWN_TIMEOUT_SECONDS;
  topicCache.clear();
  consumerControllers.clear();
}

/** Return the initialized PubSub client or throw. */
function requireClient(): PubSub {
  if (!pubsub) {
    throw new Error(
      'Pub/Sub client not initialized. Call initPubsubClient() first.',
    );
  }
  return pubsub;
}

/** Lazily create and cache a Topic with configured batching. */
function getTopic(topicName: string): Topic {
  const client = requireClient();
  let topic = topicCache.get(topicName);
  if (!topic) {
    topic = client.topic(topicName, {
      batching: {
        maxMessages:
          publisherBatching?.maxMessages ?? DEFAULT_BATCH_MAX_MESSAGES,
        maxMilliseconds:
          publisherBatching?.maxMilliseconds ?? DEFAULT_BATCH_MAX_MILLISECONDS,
        maxBytes: publisherBatching?.maxBytes ?? DEFAULT_BATCH_MAX_BYTES,
      },
    });
    topicCache.set(topicName, topic);
  }
  return topic;
}

/**
 * Publish a JSON-serialized payload to a topic. Returns the
 * Pub/Sub messageId once the publish is confirmed.
 */
export async function publishMessage<T>(
  topicName: string,
  payload: T,
): Promise<string> {
  const topic = getTopic(topicName);
  const data = Buffer.from(JSON.stringify(payload));
  return topic.publishMessage({ data });
}

/** Flush all in-memory batches for every cached topic. */
export async function flushPublisher(): Promise<void> {
  await Promise.all(Array.from(topicCache.values()).map((t) => t.flush()));
}

/**
 * Start consuming messages from a subscription. The handler
 * receives the JSON-parsed payload; resolving acks, rejecting
 * nacks so the message is redelivered.
 */
export function startConsumer<T>(opts: ConsumerOptions<T>): ConsumerController {
  if (shutdownPromise) {
    throw new Error(
      'Pub/Sub shutdown in progress. Cannot start a new consumer.',
    );
  }
  const client = requireClient();
  const maxExtensionSeconds =
    opts.flowControl?.maxExtensionSeconds ?? DEFAULT_MAX_EXTENSION_SECONDS;
  const budgetSeconds = shutdownTimeoutSeconds;

  const subscription = client.subscription(opts.subscriptionName, {
    flowControl: {
      maxMessages: opts.flowControl?.maxMessages ?? DEFAULT_FLOW_MAX_MESSAGES,
    },
    maxExtensionTime: Duration.from({ seconds: maxExtensionSeconds }),
    // WaitForProcessing lets in-flight handlers finish on
    // close() rather than immediately nacking them. The
    // timeout is the shutdown budget, not the ack-extension
    // ceiling, so it fits within a pod's grace period.
    closeOptions: {
      behavior: SubscriptionCloseBehaviors.WaitForProcessing,
      timeout: Duration.from({ seconds: budgetSeconds }),
    },
  });

  const inFlight = new Set<Promise<void>>();
  const handleError =
    opts.onError ??
    ((err: Error) => {
      console.error(
        `pubsub:stream-error subscription=${opts.subscriptionName}`,
        err,
      );
    });

  const onMessage = (message: Message) => {
    const task = processMessage(opts.subscriptionName, opts.handler, message);
    inFlight.add(task);
    void task.finally(() => inFlight.delete(task));
  };

  subscription.on('message', onMessage);
  subscription.on('error', handleError);

  let stopPromise: Promise<void> | undefined;
  const controller: ConsumerController = {
    stop(): Promise<void> {
      if (!stopPromise) {
        const deadline = Date.now() + budgetSeconds * 1000;
        stopPromise = (async () => {
          // Close first, then detach listeners. Removing the
          // last 'message' listener triggers the SDK's
          // internal auto-close, which races the configured
          // WaitForProcessing drain. Catch close errors so a
          // transient gRPC failure does not skip the
          // in-flight drain and leave handlers running into
          // the client's close().
          try {
            await subscription.close();
          } catch (err) {
            console.error(
              `pubsub:close-error subscription=${opts.subscriptionName}`,
              err,
            );
          } finally {
            subscription.removeListener('message', onMessage);
            subscription.removeListener('error', handleError);
          }
          const remainingMs = Math.max(0, deadline - Date.now());
          await waitForInFlight(inFlight, opts.subscriptionName, remainingMs);
        })().finally(() => {
          consumerControllers.delete(controller);
        });
      }
      return stopPromise;
    },
  };
  consumerControllers.add(controller);
  return controller;
}

/**
 * Wait for in-flight handlers for up to timeoutMs. Warns and
 * returns if the deadline fires before they settle, so
 * shutdown stays bounded even with a hung handler.
 */
async function waitForInFlight(
  inFlight: Set<Promise<void>>,
  subscriptionName: string,
  timeoutMs: number,
): Promise<void> {
  if (inFlight.size === 0) return;
  if (timeoutMs <= 0) {
    console.warn(
      `pubsub:stop-timeout subscription=${subscriptionName} ` +
        `inFlight=${inFlight.size}`,
    );
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const settled = Promise.allSettled(inFlight).then(() => 'done' as const);
  try {
    const result = await Promise.race([settled, timeout]);
    if (result === 'timeout') {
      console.warn(
        `pubsub:stop-timeout subscription=${subscriptionName} ` +
          `inFlight=${inFlight.size}`,
      );
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Parse, dispatch, and ack/nack a single message. Parse and
 * handler failures share the nack path but log with distinct
 * prefixes (pubsub:parse-error / pubsub:handler-error) so
 * operators can tell a poison payload from a transient
 * handler failure.
 */
async function processMessage<T>(
  subscriptionName: string,
  handler: MessageHandler<T>,
  message: Message,
): Promise<void> {
  let parsed: T;
  try {
    parsed = JSON.parse(message.data.toString()) as T;
  } catch (err) {
    message.nack();
    console.error(
      `pubsub:parse-error subscription=${subscriptionName} ` +
        `messageId=${message.id}`,
      err,
    );
    return;
  }
  try {
    await handler(parsed);
    message.ack();
  } catch (err) {
    message.nack();
    console.error(
      `pubsub:handler-error subscription=${subscriptionName} ` +
        `messageId=${message.id}`,
      err,
    );
  }
}

/**
 * Gracefully stop all registered consumers, flush pending
 * publishes, and close the underlying client. Idempotent;
 * safe to call when uninitialized.
 */
export async function shutdownPubsub(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  if (!pubsub) return;
  const client = pubsub;
  shutdownPromise = (async () => {
    try {
      // Stop consumers first so in-flight handlers (which
      // may still publish downstream) complete while the
      // client is live.
      const controllers = Array.from(consumerControllers);
      await Promise.allSettled(controllers.map((c) => c.stop()));
      // Handlers have drained. Null pubsub so any concurrent
      // publishMessage from non-handler code sees the
      // library's own "not initialized" error rather than a
      // post-close SDK failure.
      pubsub = undefined;
      await flushPublisher();
    } finally {
      try {
        await client.close();
      } finally {
        resetModuleState();
      }
    }
  })();
  return shutdownPromise;
}
