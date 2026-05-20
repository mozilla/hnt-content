/**
 * Shared fixtures and mock builders for Pub/Sub unit tests.
 * The mock-module wiring (vi.mock('@google-cloud/pubsub')) and
 * lifecycle hooks stay in the spec file; everything reusable
 * lives here.
 */

import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import type { ConsumerOptions } from './types.js';

export const PROJECT_ID = 'test-project';
export const SUBSCRIPTION_NAME = 'test-subscription';
export const TOPIC_NAME = 'test-topic';
// Placeholder used by tests. The SDK is mocked, so the value
// does not drive real timing. Production callers will source
// it from a shared config module linked to the Redis lock TTL.
export const TEST_MAX_EXTENSION_SECONDS = 180;

export interface TestPayload {
  url: string;
  crawl_id: string;
}

export const TEST_PAYLOAD: TestPayload = {
  url: 'https://example.com/article',
  crawl_id: 'test-crawl-id',
};

/**
 * Default options for tests that call startConsumer. Spread it
 * and override only the fields the test actually cares about.
 */
export const TEST_CONSUMER_OPTIONS: ConsumerOptions<TestPayload> = {
  subscriptionName: SUBSCRIPTION_NAME,
  maxExtensionSeconds: TEST_MAX_EXTENSION_SECONDS,
  handler: async () => {},
};

export interface MockTopic {
  publishMessage: ReturnType<typeof vi.fn>;
  flush: ReturnType<typeof vi.fn>;
}

export type MockSubscription = EventEmitter & {
  close: ReturnType<typeof vi.fn>;
};

export interface MockPubSub {
  topic: ReturnType<typeof vi.fn>;
  subscription: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  topics: Map<string, MockTopic>;
  subscriptions: Map<string, MockSubscription>;
}

/** Build a fresh mock PubSub that caches topic and subscription instances by name. */
export function createMockPubSub(): MockPubSub {
  const topics = new Map<string, MockTopic>();
  const subscriptions = new Map<string, MockSubscription>();

  const topic = vi.fn((name: string) => {
    let t = topics.get(name);
    if (!t) {
      t = {
        publishMessage: vi.fn(async () => `msg-${name}`),
        flush: vi.fn(async () => {}),
      };
      topics.set(name, t);
    }
    return t;
  });

  const subscription = vi.fn((name: string) => {
    let s = subscriptions.get(name);
    if (!s) {
      const emitter = new EventEmitter() as MockSubscription;
      emitter.close = vi.fn(async () => {});
      s = emitter;
      subscriptions.set(name, s);
    }
    return s;
  });

  return {
    topic,
    subscription,
    close: vi.fn(async () => {}),
    topics,
    subscriptions,
  };
}

export interface MockMessage {
  data: Buffer;
  id: string;
  ack: ReturnType<typeof vi.fn>;
  nack: ReturnType<typeof vi.fn>;
  /** Resolves with 'ack' or 'nack' once the consumer settles the message. */
  settled: Promise<'ack' | 'nack'>;
}

/** Build a mock Pub/Sub Message that JSON-encodes the payload. */
export function createMockMessage(
  payload: unknown,
  id = 'test-message-id',
): MockMessage {
  return createMockMessageRaw(Buffer.from(JSON.stringify(payload)), id);
}

/** Build a mock Pub/Sub Message with raw data; useful for malformed payloads. */
export function createMockMessageRaw(
  data: Buffer,
  id = 'test-message-id',
): MockMessage {
  let resolve!: (kind: 'ack' | 'nack') => void;
  const settled = new Promise<'ack' | 'nack'>((r) => {
    resolve = r;
  });
  return {
    data,
    id,
    ack: vi.fn(() => resolve('ack')),
    nack: vi.fn(() => resolve('nack')),
    settled,
  };
}

/**
 * Stall a vi.fn() to a pending Promise, start the operation that
 * will call it, and yield one microtask so callers can observe
 * state set by the first await inside the operation. Returns a
 * resolver to release the mock and the still-pending operation.
 */
export async function startStalled<T>(
  target: ReturnType<typeof vi.fn>,
  start: () => Promise<T>,
): Promise<{ release: () => void; pending: Promise<T> }> {
  const { promise, resolve: release } = Promise.withResolvers<void>();
  target.mockImplementation(() => promise);
  const pending = start();
  // Yield so the operation advances past its first await;
  // otherwise callers can't observe state set after it.
  await Promise.resolve();
  return { release, pending };
}
