/**
 * Pub/Sub client for the crawler. Wraps `@google-cloud/pubsub`
 * as a module-level singleton: one client per process.
 *
 * Terminology:
 * - Client: the single `PubSub` SDK instance per process; owns
 *   the underlying gRPC connection. This module wraps it.
 * - gRPC: HTTP/2-based RPC protocol the SDK uses to talk to
 *   Pub/Sub. Lets subscriptions pull over a long-lived stream
 *   without any inbound HTTPS endpoint or ingress.
 * - Topic: a named destination messages are published to; fans
 *   every message out to attached subscriptions.
 * - Subscription: a named queue attached to a topic; holds each
 *   message until a subscriber acks it, independently per sub.
 * - Subscriber: any code that calls `startSubscriber({ ... })`,
 *   e.g. the article worker or discovery worker in
 *   `services/crawl-worker`.
 *
 * Lifecycle:
 * - `initPubSubClient` once at startup (after env is loaded).
 * - `startSubscriber` per subscription; the handler receives a
 *   JSON-parsed payload, resolves to ack, throws to nack.
 * - `publishMessage` to publish; payload is JSON-encoded and
 *   sent through a cached `Topic` (SDK handles batching).
 * - `shutdownPubSub` once on SIGTERM; stops subscribers (with
 *   in-flight drain), flushes topics, and closes the client.
 *
 * Tests and local dev point at a Pub/Sub emulator by passing
 * `apiEndpoint` and `useEmulator: true` to `initPubSubClient`.
 */
import {
  Duration,
  PubSub,
  SubscriptionCloseBehaviors,
  type Message,
  type Topic,
} from '@google-cloud/pubsub';
import type {
  SubscriberController,
  SubscriberOptions,
  MessageHandler,
  PubSubClientOptions,
} from './types.js';

// Upper bound on how long subscription.close() waits for
// in-flight handlers to ack or nack. Must fit within the pod's
// Kubernetes terminationGracePeriodSeconds. Our Helm chart does
// not set this, so K8s defaults to 30s. 25s leaves ~5s after
// the drain for flushTopics and client.close before SIGKILL.
// Helm chart: https://github.com/mozilla/webservices-infra/blob/main/hnt/k8s/hnt/Chart.yaml
// K8s docs: https://kubernetes.io/docs/reference/kubernetes-api/workload-resources/pod-v1/#lifecycle
export const SHUTDOWN_TIMEOUT_SECONDS = 25;

// Module-level state.
let pubsub: PubSub | undefined;
let shutdownPromise: Promise<void> | undefined;
// Cache topics so the SDK can batch messages across calls.
const topicCache = new Map<string, Topic>();
// Holds one controller per subscriber. Today each pod registers a
// single subscriber (article or discovery worker).
const subscriberControllers = new Set<SubscriberController>();

/**
 * Reset module state so the next initPubSubClient() starts
 * clean. Called from shutdownPubSub(); mostly matters for
 * tests, since in production the pod usually exits right
 * after shutdown.
 */
function resetModuleState(): void {
  pubsub = undefined;
  shutdownPromise = undefined;
  topicCache.clear();
  subscriberControllers.clear();
}

/**
 * Initialize the Pub/Sub client. Throws if already
 * initialized or if a shutdown is in progress; await
 * shutdownPubSub first to re-initialize. Unlike sibling
 * clients (e.g. the Zyte HTTP client), an open subscription
 * owns a gRPC stream and in-flight messages; silent
 * replacement would leak both.
 */
export function initPubSubClient(opts: PubSubClientOptions): void {
  if (shutdownPromise) {
    throw new Error(
      'Pub/Sub shutdown in progress. Await shutdownPubSub() first.',
    );
  }
  if (pubsub) {
    throw new Error(
      'Pub/Sub client already initialized. Call shutdownPubSub() first.',
    );
  }
  pubsub = new PubSub({
    projectId: opts.projectId,
    ...(opts.apiEndpoint && { apiEndpoint: opts.apiEndpoint }),
    ...(opts.useEmulator && { emulatorMode: true }),
  });
}

/** Return the initialized PubSub client or throw. */
function requireClient(): PubSub {
  if (!pubsub) {
    throw new Error(
      'Pub/Sub client not initialized. Call initPubSubClient() first.',
    );
  }
  return pubsub;
}

/** Lazily create and cache a Topic. */
function getTopic(topicName: string): Topic {
  let topic = topicCache.get(topicName);
  if (!topic) {
    topic = requireClient().topic(topicName);
    topicCache.set(topicName, topic);
  }
  return topic;
}

/**
 * Publish a JSON-serialized payload to a topic (e.g. `articles`
 * or `article-discoveries`). Returns the Pub/Sub messageId once
 * the publish is confirmed.
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
 * Start consuming messages from a subscription (e.g.
 * `crawl-article` for the article worker). Pub/Sub delivery is
 * pull-based, so the SDK initiates the connection and no inbound
 * HTTPS endpoint or ingress is needed. The handler receives the
 * JSON-parsed payload. The library acks the message when the
 * handler resolves, and nacks it when the handler rejects so
 * Pub/Sub redelivers.
 */
export function startSubscriber<T>(
  opts: SubscriberOptions<T>,
): SubscriberController {
  if (shutdownPromise) {
    throw new Error(
      'Pub/Sub shutdown in progress. Cannot start a new subscriber.',
    );
  }
  const client = requireClient();

  const subscription = client.subscription(opts.subscriptionName, {
    maxExtensionTime: Duration.from({
      seconds: opts.maxExtensionSeconds,
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
      // TODO(HNT-2589): also report to Sentry.
      console.error(
        `pubsub:stream-error subscription=${opts.subscriptionName}`,
        err,
      );
    });

  const onMessage = (message: Message) => {
    // We prefix the call with `void` because the SDK's Subscription
    // class extends Node's EventEmitter, which calls message
    // listeners synchronously and discards their return values. We
    // cannot make the SDK wait, so this call is fire-and-forget. It
    // is safe because processMessage catches every error path and
    // signals completion through ack or nack on the message rather
    // than through this promise.
    void processMessage(opts.subscriptionName, opts.handler, message);
  };

  subscription.on('message', onMessage);
  subscription.on('error', handleError);

  const controller: SubscriberController = {
    async stop(): Promise<void> {
      // Errors from close() are caught so stop() never rejects;
      // any handlers still running when the SDK gives up will
      // have their messages redelivered after the ack deadline
      // expires.
      //
      // stop() is implicitly idempotent: subscription.close()
      // no-ops once the SDK marks the subscriber closed, and
      // removeListener and Set.delete no-op on missing elements.
      try {
        await subscription.close();
      } catch (err) {
        // TODO(HNT-2589): also report to Sentry.
        console.error(
          `pubsub:close-error subscription=${opts.subscriptionName}`,
          err,
        );
      } finally {
        subscription.removeListener('message', onMessage);
        subscription.removeListener('error', handleError);
        subscriberControllers.delete(controller);
      }
    },
  };
  subscriberControllers.add(controller);
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
    // TODO(HNT-2589): also report to Sentry.
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
    // TODO(HNT-2589): also report to Sentry.
    console.error(
      `pubsub:handler-error subscription=${subscriptionName} ` +
        `messageId=${message.id}`,
      err,
    );
  }
}

/**
 * Gracefully stop all registered subscribers, flush pending
 * publishes, and close the underlying client. Idempotent;
 * safe to call when uninitialized.
 */
export async function shutdownPubSub(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  if (!pubsub) return;
  const client = pubsub;
  shutdownPromise = (async () => {
    // The nested try/finally below ensures client.close() and
    // resetModuleState() always run. We let errors propagate so
    // the SIGTERM handler can report them to Sentry.
    try {
      // Stop subscribers first so in-flight handlers (which
      // may still publish downstream) complete while the
      // client is live.
      const controllers = Array.from(subscriberControllers);
      await Promise.allSettled(controllers.map((c) => c.stop()));
      // Handlers have drained. Null pubsub so cache-miss
      // publishes fail fast with the library's "not
      // initialized" error; cache hits still pass through to
      // the SDK and may reject with a gRPC error.
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
