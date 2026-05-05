/** Options for configuring the Pub/Sub client. */
export interface PubsubClientOptions {
  /** GCP project id (e.g. 'moz-fx-hnt-prod'). */
  projectId: string;
  /**
   * Emulator endpoint as 'host:port'. When set, the Pub/Sub
   * SDK connects to a local emulator instead of GCP. Usually
   * unset in production.
   */
  emulatorHost?: string;
  /** Overrides publisher batching defaults. */
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
