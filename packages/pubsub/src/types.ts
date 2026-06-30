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
 * mode produced the error. `messageId` is populated for the per-message
 * kinds (parse-error, validation-error). The SDK error doesn't contain
 * these fields.
 */
export type SubscriberErrorContext = {
  kind: 'stream-error' | 'close-error' | 'parse-error' | 'validation-error';
  messageId?: string;
};

/** Options for starting a subscriber. */
export interface SubscriberOptions<T> {
  /** Short subscription name (not fully qualified). */
  subscriptionName: string;
  handler: MessageHandler<T>;
  /**
   * Validate the JSON-parsed payload at the consumer boundary
   * before the handler runs. Return the typed message or throw
   * to reject a malformed payload; the subscriber nacks it and
   * reports a `validation-error`. Omit to pass the parsed JSON
   * through unchecked (an unchecked cast to T).
   */
  validate?: (raw: unknown) => T;
  /**
   * Cap on how long the SDK will keep extending a healthy
   * message's ack deadline while the handler runs. Effectively
   * the maximum time a single message can be processed before
   * being redelivered. Independent of the subscription's
   * ack_deadline_seconds, which sets the lease granularity and
   * is what a crashed worker's message redelivers around. The
   * SDK default of 1 hour is far longer than article extraction
   * needs (well under 2 min even on slow sites). Setting this too
   * high means a stuck handler keeps its message for the full
   * window before another worker can retry. The handler's
   * per-message lock TTL is derived from the ack deadline, not
   * this value, so the lock clears around redelivery time.
   */
  maxExtensionSeconds: number;
  /**
   * Cap on outstanding (leased but unacked) messages, mapped to
   * the SDK's flowControl.maxMessages. This bounds how many
   * handlers run at once, which for the article worker bounds the
   * concurrent Zyte fetches and the response bodies held in
   * memory. The workers have no in-process concurrency cap by
   * design, so this is the intended bound. The SDK default of 1000
   * is far too high for the worker's memory limit: under a backlog
   * it leases ~1000 messages and OOM-kills the pod. Omit to fall
   * back to DEFAULT_MAX_MESSAGES.
   */
  maxMessages?: number;
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
