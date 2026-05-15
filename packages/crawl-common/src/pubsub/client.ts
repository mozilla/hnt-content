/**
 * Pub/Sub client for the crawler. Wraps `@google-cloud/pubsub`
 * as a module-level singleton: one client per process.
 *
 * Terminology:
 * - Client: the single `PubSub` SDK instance per process; owns
 *   the underlying gRPC connection. This module wraps it.
 * - Topic: a named destination messages are published to; fans
 *   every message out to attached subscriptions.
 * - Subscription: a named queue attached to a topic; holds each
 *   message until a consumer acks it, independently per sub.
 * - Consumer: any code that calls `startConsumer({ ... })` and
 *   processes messages in the supplied handler.
 *
 * Lifecycle:
 * - `initPubsubClient` once at startup (after env is loaded).
 * - `startConsumer` per subscription; the handler receives a
 *   JSON-parsed payload, resolves to ack, throws to nack.
 * - `publishMessage` to publish; payload is JSON-encoded and
 *   sent through a cached `Topic` (SDK handles batching).
 * - `shutdownPubsub` once on SIGTERM; stops consumers (with
 *   in-flight drain), flushes topics, and closes the client.
 *
 * Tests and local dev point at a Pub/Sub emulator by passing
 * `apiEndpoint` and `useEmulator: true` to `initPubsubClient`.
 */
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
  PubsubClientOptions,
} from './types.js';

// Default = Pub/Sub's 600s max ack deadline minus a 30s buffer.
export const DEFAULT_CONSUMER_MAX_EXTENSION_SECONDS = 570;

// Upper bound on how long subscription.close() waits for
// in-flight handlers to ack or nack. Must fit within the pod's
// Kubernetes terminationGracePeriodSeconds.
export const SHUTDOWN_TIMEOUT_SECONDS = 90;

// Module-level state.
let pubsub: PubSub | undefined;
let shutdownPromise: Promise<void> | undefined;
// Cache topics so the SDK can batch messages across calls.
const topicCache = new Map<string, Topic>();
const consumerControllers = new Set<ConsumerController>();

/**
 * Reset module state so the next initPubsubClient() starts
 * clean. Called from shutdownPubsub(); mostly matters for
 * tests, since in production the pod usually exits right
 * after shutdown.
 */
function resetModuleState(): void {
  pubsub = undefined;
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
  pubsub = new PubSub({
    projectId: opts.projectId,
    ...(opts.apiEndpoint ? { apiEndpoint: opts.apiEndpoint } : {}),
    ...(opts.useEmulator ? { emulatorMode: true } : {}),
  });
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

/** Lazily create and cache a Topic. */
function getTopic(topicName: string): Topic {
  const client = requireClient();
  let topic = topicCache.get(topicName);
  if (!topic) {
    topic = client.topic(topicName);
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
export async function flushTopics(): Promise<void> {
  await Promise.all(Array.from(topicCache.values()).map((t) => t.flush()));
}

/**
 * Start consuming messages from a subscription. Pub/Sub
 * delivery is pull-based, so the SDK initiates the
 * connection and no inbound HTTPS endpoint or ingress is
 * needed. The handler receives the JSON-parsed payload.
 * The library acks the message when the handler resolves,
 * and nacks it when the handler rejects so Pub/Sub
 * redelivers.
 */
export function startConsumer<T>(opts: ConsumerOptions<T>): ConsumerController {
  if (shutdownPromise) {
    throw new Error(
      'Pub/Sub shutdown in progress. Cannot start a new consumer.',
    );
  }
  const client = requireClient();

  const subscription = client.subscription(opts.subscriptionName, {
    maxExtensionTime: Duration.from({
      seconds:
        opts.maxExtensionSeconds ?? DEFAULT_CONSUMER_MAX_EXTENSION_SECONDS,
    }),
    // WaitForProcessing lets in-flight handlers finish on
    // close() rather than immediately nacking them. The
    // timeout is an upper bound; close() resolves earlier
    // once every in-flight message has been ack'd or nack'd.
    closeOptions: {
      behavior: SubscriptionCloseBehaviors.WaitForProcessing,
      timeout: Duration.from({ seconds: SHUTDOWN_TIMEOUT_SECONDS }),
    },
  });

  const handleError =
    opts.onError ??
    ((err: Error) => {
      console.error(
        `pubsub:stream-error subscription=${opts.subscriptionName}`,
        err,
      );
    });

  const onMessage = (message: Message) => {
    void processMessage(opts.subscriptionName, opts.handler, message);
  };

  subscription.on('message', onMessage);
  subscription.on('error', handleError);

  const controller: ConsumerController = {
    async stop(): Promise<void> {
      // Call close() before removing the 'message' listener so
      // our WaitForProcessing drain runs. If we removed the
      // listener first, the SDK would see no one is listening
      // and shut down without waiting for in-flight handlers.
      // Catch errors from close() so stop() never rejects; any
      // handlers still running when the SDK gives up will have
      // their messages redelivered after the ack deadline
      // expires.
      //
      // stop() is implicitly idempotent: subscription.close()
      // no-ops once the SDK marks the subscriber closed, and
      // removeListener and Set.delete no-op on missing elements.
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
        consumerControllers.delete(controller);
      }
    },
  };
  consumerControllers.add(controller);
  return controller;
}

/**
 * Parse, dispatch, and ack/nack a single message. Both
 * parse and handler failures nack; distinct log prefixes
 * (pubsub:parse-error / pubsub:handler-error) let us tell
 * a poison payload from a transient handler failure.
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
      await flushTopics();
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
