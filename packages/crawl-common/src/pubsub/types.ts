/** Options for configuring the Pub/Sub client. */
export interface PubsubClientOptions {
  /** GCP project id (e.g. 'moz-fx-hnt-prod'). */
  projectId: string;
  /**
   * Override the Pub/Sub API endpoint as 'host:port'. Set
   * alongside useEmulator in tests and local development to
   * point the SDK at a local Pub/Sub emulator. Leave unset
   * in production.
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

/** Options for starting a consumer. */
export interface ConsumerOptions<T> {
  /** Short subscription name (not fully qualified). */
  subscriptionName: string;
  handler: MessageHandler<T>;
  /**
   * Cap on how long the SDK will keep extending a message's
   * ack deadline while the handler runs. Must match the TTL of
   * any per-message lock the handler takes, so the lock can't
   * outlive the SDK's lease extensions. Defaults to 570s.
   */
  maxExtensionSeconds?: number;
  /**
   * Called on subscription-level errors (auth, network,
   * subscription deletion). Defaults to console.error so
   * silent failures stay visible in logs; override to route
   * to metrics or a health probe.
   */
  onError?: (err: Error) => void;
}

/** Controller returned by startConsumer for lifecycle management. */
export interface ConsumerController {
  /**
   * Called during shutdown to let in-flight handlers settle
   * before the subscription closes. Any handler that doesn't
   * finish in time has its message redelivered by Pub/Sub.
   * Always resolves; close errors are logged with the prefix
   * `pubsub:close-error` rather than propagated.
   */
  stop(): Promise<void>;
}
