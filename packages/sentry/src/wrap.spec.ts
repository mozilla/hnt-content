import * as Sentry from '@sentry/node';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withSentryHandler } from './wrap.js';

// ESM namespace bindings are non-configurable, so vi.spyOn fails.
// Mock just the functions wrap.ts uses. withIsolationScope invokes
// its callback directly so the wrapped handler runs.
vi.mock('@sentry/node', () => ({
  withIsolationScope: vi.fn(async (cb: () => Promise<void>) => cb()),
  setTag: vi.fn(),
  setContext: vi.fn(),
  captureException: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(Sentry.withIsolationScope).mockClear();
  vi.mocked(Sentry.setTag).mockClear();
  vi.mocked(Sentry.setContext).mockClear();
  vi.mocked(Sentry.captureException).mockClear();
});

describe('withSentryHandler', () => {
  it('captures and rethrows when the handler throws', async () => {
    const err = new Error('boom');
    const wrapped = withSentryHandler(
      () => ({}),
      async () => {
        throw err;
      },
    );

    await expect(wrapped({})).rejects.toBe(err);
    expect(Sentry.captureException).toHaveBeenCalledOnce();
    expect(Sentry.captureException).toHaveBeenCalledWith(err);
  });

  it('does not capture when the handler resolves', async () => {
    const wrapped = withSentryHandler(
      () => ({}),
      async () => {},
    );
    await wrapped({});
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('wraps the handler body in an isolation scope', async () => {
    const wrapped = withSentryHandler(
      () => ({}),
      async () => {},
    );
    await wrapped({});
    expect(Sentry.withIsolationScope).toHaveBeenCalledOnce();
  });

  it('sets each tag from extractMetadata', async () => {
    const wrapped = withSentryHandler<{ url: string }>(
      (msg) => ({ tags: { url: msg.url, topic: 'tech' } }),
      async () => {},
    );
    await wrapped({ url: 'https://example.com' });
    expect(Sentry.setTag).toHaveBeenCalledWith('url', 'https://example.com');
    expect(Sentry.setTag).toHaveBeenCalledWith('topic', 'tech');
  });

  it('skips undefined tag values', async () => {
    const wrapped = withSentryHandler<{ topic?: string }>(
      (msg) => ({ tags: { topic: msg.topic, subscription: 'sub-a' } }),
      async () => {},
    );
    await wrapped({});
    expect(Sentry.setTag).toHaveBeenCalledOnce();
    expect(Sentry.setTag).toHaveBeenCalledWith('subscription', 'sub-a');
  });

  it('sets the handler context block when provided', async () => {
    const wrapped = withSentryHandler<{ url: string }>(
      (msg) => ({ context: { url: msg.url, crawl_id: 'abc' } }),
      async () => {},
    );
    await wrapped({ url: 'https://example.com' });
    expect(Sentry.setContext).toHaveBeenCalledOnce();
    expect(Sentry.setContext).toHaveBeenCalledWith('handler', {
      url: 'https://example.com',
      crawl_id: 'abc',
    });
  });

  it('skips setContext when context is empty', async () => {
    const wrapped = withSentryHandler(
      () => ({ context: {} }),
      async () => {},
    );
    await wrapped({});
    expect(Sentry.setContext).not.toHaveBeenCalled();
  });

  it('skips both setTag and setContext when metadata is empty', async () => {
    const wrapped = withSentryHandler(
      () => ({}),
      async () => {},
    );
    await wrapped({});
    expect(Sentry.setTag).not.toHaveBeenCalled();
    expect(Sentry.setContext).not.toHaveBeenCalled();
  });

  // Order matters: if the handler throws, captureException must
  // see the tags already on the isolation scope.
  it('attaches tags before invoking the handler', async () => {
    const order: string[] = [];
    vi.mocked(Sentry.setTag).mockImplementation(() => {
      order.push('setTag');
      return undefined as unknown as ReturnType<typeof Sentry.setTag>;
    });
    const wrapped = withSentryHandler<{ url: string }>(
      (msg) => ({ tags: { url: msg.url } }),
      async () => {
        order.push('handler');
      },
    );
    await wrapped({ url: 'https://example.com' });
    expect(order).toEqual(['setTag', 'handler']);
  });
});
