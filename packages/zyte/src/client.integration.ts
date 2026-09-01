import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  initZyteClient,
  extractArticle,
  RETRY_MAX_TIMEOUT_MS,
} from './client.js';
import { ZyteError } from './errors.js';

/** Minimal article response for retry verification. */
const ARTICLE_RESPONSE = {
  url: 'https://example.com',
  statusCode: 200,
  article: {
    url: 'https://example.com',
    headline: 'Recovered',
    metadata: { probability: 0.95, dateDownloaded: '2026-04-14T00:00:00Z' },
  },
};

/**
 * Verify that p-retry actually retries transient errors
 * through the client's public API. Uses fake timers to
 * avoid real retry delays.
 */
describe('Retry integration', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', fetchMock);
    initZyteClient({ apiKey: 'test-key', maxRetries: 3 });
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('retries on transient 500 and succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'transient' }), { status: 500 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(ARTICLE_RESPONSE), { status: 200 }),
      );

    const promise = extractArticle('https://example.com');
    await vi.advanceTimersByTimeAsync(RETRY_MAX_TIMEOUT_MS);
    const result = await promise;

    expect(result.data.headline).toBe('Recovered');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries on network error and succeeds', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(ARTICLE_RESPONSE), { status: 200 }),
      );

    const promise = extractArticle('https://example.com');
    await vi.advanceTimersByTimeAsync(RETRY_MAX_TIMEOUT_MS);
    const result = await promise;

    expect(result.data.headline).toBe('Recovered');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops after maxRetries attempts', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'down' }), { status: 500 }),
    );

    const promise = extractArticle('https://example.com').catch((e) => e);
    await vi.advanceTimersByTimeAsync(RETRY_MAX_TIMEOUT_MS * 4);
    const err = await promise;

    expect(err).toBeInstanceOf(ZyteError);
    expect(err.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
  });

  it('does not retry permanent 401 errors', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ type: '/auth/key-not-found' }), {
        status: 401,
      }),
    );

    const err = await extractArticle('https://example.com').catch((e) => e);

    expect(err).toBeInstanceOf(ZyteError);
    expect(err.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
