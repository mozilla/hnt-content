/** Options for configuring the Pub/Sub client. */
export interface PubSubClientOptions {
  /** GCP project id (e.g. 'moz-fx-hnt-prod'). */
  projectId: string;
  /**
   * Override the Pub/Sub API endpoint as 'host:port' (e.g.
   * 'localhost:8085' for the emulator). Set alongside useEmulator
   * in tests and local development to point the SDK at a local
   * Pub/Sub emulator. Leave unset in production.
   */
  apiEndpoint?: string;
  /**
   * Connect with no credentials and skip the GCE metadata-
   * server auth probe. Must be true when apiEndpoint points
   * at a local emulator; otherwise the SDK burns ~5s per
   * client on the no-route-to-host timeout looking for prod
   * auth. Leave unset in production.
   */
  useEmulator?: boolean;
}

/**
 * Handler invoked per received message. Resolve acks the
 * message (Pub/Sub treats it as delivered); reject nacks it,
 * so Pub/Sub redelivers within the subscription's ack
 * deadline, up to the subscription's max-delivery-attempts.
 */
export type MessageHandler<T> = (message: T) => Promise<void>;

/**
 * Extra context passed to `onError` describing which internal failure
 * mode produced the error. `messageId` is only populated for
 * parse-error. The SDK error doesn't contain these fields.
 */
export type SubscriberErrorContext = {
  kind: 'stream-error' | 'close-error' | 'parse-error';
  messageId?: string;
};

/** Options for starting a subscriber. */
export interface SubscriberOptions<T> {
  /** Short subscription name (not fully qualified). */
  subscriptionName: string;
  handler: MessageHandler<T>;
  /**
   * Cap on how long the SDK will keep extending a message's ack
   * deadline while the handler runs. Effectively the maximum
   * time a single message can be processed before being
   * redelivered. Independent of the subscription's
   * ack_deadline_seconds, which only sets the initial deadline.
   * The SDK default of 1 hour is far longer than article
   * extraction needs (well under 2 min even on slow sites).
   * Setting this too high means a stuck handler keeps its
   * message for the full window before another worker can retry.
   * Must match the TTL of any per-message lock the handler
   * takes, so the lock can't outlive the SDK's lease extensions.
   * Will be sourced from a shared config module so this and the
   * Redis lock TTL stay linked; for now each caller passes the
   * value explicitly, e.g. 180 for a 3-minute budget per message.
   */
  maxExtensionSeconds: number;
  /**
   * Cap on messages the SDK holds in flight at once. The handler
   * runs per message, so this bounds handler concurrency, e.g. the
   * number of Zyte calls in progress. The SDK default is 1000; set a
   * lower value when each message does heavy external work. Leave
   * unset to keep the SDK default.
   */
  maxConcurrentMessages?: number;
  /**
   * Called on the Pub/Sub library's own internal errors
   * (stream-error, close-error, parse-error). Defaults to
   * console.error. Callers should pass `sentryPubSubErrorHandler(name)`
   * from `crawl-common` to report them to Sentry, optionally composed
   * with metrics or healthz hooks.
   */
  onError?: (err: Error, ctx: SubscriberErrorContext) => void;
}

/** Controller returned by startSubscriber for lifecycle management. */
export interface SubscriberController {
  /**
   * Called during shutdown to let in-flight handlers settle
   * before the subscription closes. Any handler that doesn't
   * finish in time has its message redelivered by Pub/Sub.
   * Always resolves; close errors are logged with the prefix
   * `pubsub:close-error` rather than propagated.
   */
  stop(): Promise<void>;
}
