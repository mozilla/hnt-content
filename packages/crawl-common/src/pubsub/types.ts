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
  /**
   * Overrides publisher batching defaults. Batching groups
   * outgoing messages and flushes on the first of N messages,
   * N ms elapsed, or N bytes — trading a bit of latency for
   * fewer RPCs to Pub/Sub.
   */
  publisherBatching?: PublisherBatching;
  /**
   * Pod-wide shutdown budget in seconds, used as a single
   * absolute deadline across consumer close and in-flight
   * wait during stop()/shutdownPubsub(). Keep below the
   * pod's terminationGracePeriodSeconds. Defaults to 90.
   */
  shutdownTimeoutSeconds?: number;
}

/** Publisher batching thresholds; any one triggers a flush. */
export interface PublisherBatching {
  /** Max messages per batch before flush. */
  maxMessages?: number;
  /** Max time in ms a batch may linger before flush. */
  maxMilliseconds?: number;
  /** Max payload bytes per batch before flush. */
  maxBytes?: number;
}

/** Per-consumer flow-control thresholds. */
export interface ConsumerFlowControl {
  /** Max concurrent messages held by this consumer. */
  maxMessages?: number;
  /**
   * Max total time the ack deadline may be extended for a
   * single message before the SDK gives up and lets it
   * redeliver.
   */
  maxExtensionSeconds?: number;
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
  flowControl?: ConsumerFlowControl;
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
   * Stop receiving new messages and wait for in-flight
   * handlers to finish, bounded by the pod-wide shutdown
   * budget. Returns once the SDK close resolves and either
   * every handler has settled or the budget elapsed;
   * handlers still running after the budget log a warning
   * and are left to complete on their own. Never rejects:
   * subscription close errors are logged with prefix
   * `pubsub:close-error` and the in-flight drain still
   * runs. Idempotent.
   */
  stop(): Promise<void>;
}
