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

/** Handler invoked per received message; ack on resolve, nack on reject. */
export type MessageHandler<T> = (message: T) => Promise<void>;

/** Options for starting a consumer. */
export interface ConsumerOptions<T> {
  /** Short subscription name (not fully qualified). */
  subscriptionName: string;
  handler: MessageHandler<T>;
  flowControl?: ConsumerFlowControl;
}

/** Controller returned by startConsumer for lifecycle management. */
export interface ConsumerController {
  /**
   * Stop receiving new messages and wait for in-flight
   * handlers to finish. Idempotent.
   */
  stop(): Promise<void>;
}
