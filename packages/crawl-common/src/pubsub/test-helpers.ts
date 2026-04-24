/**
 * Shared test fixtures and mock factory for Pub/Sub unit
 * and integration tests.
 */
import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import type { PubsubClientOptions } from './types.js';

export const PROJECT_ID = 'test-project';
export const SUBSCRIPTION_NAME = 'test-subscription';
export const TOPIC_NAME = 'test-topic';

export const CLIENT_OPTS: PubsubClientOptions = {
  projectId: PROJECT_ID,
};

export interface TestPayload {
  url: string;
  crawl_id: string;
}

export const TEST_PAYLOAD: TestPayload = {
  url: 'https://example.com/article',
  crawl_id: 'test-crawl-id',
};

/** Mock Topic with vi-instrumented publishMessage and flush. */
export interface MockTopic {
  publishMessage: ReturnType<typeof vi.fn>;
  flush: ReturnType<typeof vi.fn>;
}

/** Mock Subscription: a real EventEmitter with a mocked close. */
export type MockSubscription = EventEmitter & {
  close: ReturnType<typeof vi.fn>;
};

/**
 * Fake PubSub exposing topic() and subscription() factories.
 * Instances are cached per name so tests can look them up
 * after invoking the client under test.
 */
export interface MockPubSub {
  topic: ReturnType<typeof vi.fn>;
  subscription: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  topics: Map<string, MockTopic>;
  subscriptions: Map<string, MockSubscription>;
}

/**
 * Build a fresh MockPubSub. Per-name Topic and Subscription
 * instances are cached the same way the real SDK caches them.
 */
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

/**
 * Construct a mock Pub/Sub Message with enough shape to
 * satisfy the consumer. Only the fields the library touches
 * (data, id, ack, nack) are populated.
 */
export function createMockMessage(
  payload: unknown,
  id = 'test-message-id',
): {
  data: Buffer;
  id: string;
  ack: ReturnType<typeof vi.fn>;
  nack: ReturnType<typeof vi.fn>;
} {
  return {
    data: Buffer.from(JSON.stringify(payload)),
    id,
    ack: vi.fn(),
    nack: vi.fn(),
  };
}
