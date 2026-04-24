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
  PublisherBatching,
  PubsubClientOptions,
} from './types.js';

// Defaults tuned for a per-pod article worker that is
// Zyte-bound: small in-memory queue, ack extension aligned
// with the 600s Pub/Sub ack deadline so stuck handlers
// surface rather than holding leases indefinitely.
const DEFAULT_FLOW_MAX_MESSAGES = 10;
const DEFAULT_MAX_EXTENSION_SECONDS = 600;

// Publisher batching defaults match the SDK's documented
// defaults for small payloads (~100 messages / 100ms / 1MB).
const DEFAULT_BATCH_MAX_MESSAGES = 100;
const DEFAULT_BATCH_MAX_MILLISECONDS = 100;
const DEFAULT_BATCH_MAX_BYTES = 1_000_000;

// Module-level state.
let pubsub: PubSub | undefined;
let publisherBatching: PublisherBatching | undefined;
const topicCache = new Map<string, Topic>();

/**
 * Initialize the Pub/Sub client. Must be called once before
 * startConsumer or publishMessage. Re-initialization resets
 * the topic cache and replaces the underlying client.
 */
export function initPubsubClient(opts: PubsubClientOptions): void {
  if (opts.emulatorHost) {
    process.env.PUBSUB_EMULATOR_HOST = opts.emulatorHost;
  }
  pubsub = new PubSub({ projectId: opts.projectId });
  publisherBatching = opts.publisherBatching;
  topicCache.clear();
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
  const client = requireClient();
  const maxExtensionSeconds =
    opts.flowControl?.maxExtensionSeconds ?? DEFAULT_MAX_EXTENSION_SECONDS;

  const subscription = client.subscription(opts.subscriptionName, {
    flowControl: {
      maxMessages: opts.flowControl?.maxMessages ?? DEFAULT_FLOW_MAX_MESSAGES,
    },
    maxExtensionTime: Duration.from({ seconds: maxExtensionSeconds }),
    // WaitForProcessing lets in-flight handlers finish on
    // close() rather than immediately nacking them.
    closeOptions: {
      behavior: SubscriptionCloseBehaviors.WaitForProcessing,
      timeout: Duration.from({ seconds: maxExtensionSeconds }),
    },
  });

  const inFlight = new Set<Promise<void>>();

  const onMessage = (message: Message) => {
    const task = processMessage(opts, message);
    inFlight.add(task);
    void task.finally(() => inFlight.delete(task));
  };

  const onError = (err: Error) => {
    console.error(
      `Pub/Sub subscription error on ${opts.subscriptionName}:`,
      err,
    );
  };

  subscription.on('message', onMessage);
  subscription.on('error', onError);

  let stopPromise: Promise<void> | undefined;
  return {
    stop(): Promise<void> {
      if (!stopPromise) {
        stopPromise = (async () => {
          subscription.removeListener('message', onMessage);
          subscription.removeListener('error', onError);
          await subscription.close();
          await Promise.allSettled(Array.from(inFlight));
        })();
      }
      return stopPromise;
    },
  };
}

/**
 * Parse, dispatch, and ack/nack a single message. Errors from
 * JSON parsing or the handler nack and log; they are never
 * re-thrown so a single bad message does not stop the consumer.
 */
async function processMessage<T>(
  opts: ConsumerOptions<T>,
  message: Message,
): Promise<void> {
  try {
    const parsed = JSON.parse(message.data.toString()) as T;
    await opts.handler(parsed);
    message.ack();
  } catch (err) {
    message.nack();
    console.error(
      `Pub/Sub handler failed on ${opts.subscriptionName} ` +
        `message ${message.id}:`,
      err,
    );
  }
}

/**
 * Flush pending publishes and close the underlying client.
 * Call after stopping all consumers during graceful shutdown.
 */
export async function shutdownPubsub(): Promise<void> {
  await flushPublisher();
  if (pubsub) {
    await pubsub.close();
    pubsub = undefined;
    topicCache.clear();
  }
}
