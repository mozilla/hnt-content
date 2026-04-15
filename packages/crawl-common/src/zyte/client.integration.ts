import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initZyteClient, extractArticle } from './client.js';
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
 * through the client's public API. Uses real timers, so the
 * retry test includes a ~2s delay per attempt.
 */
describe('Retry integration', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    initZyteClient({ apiKey: 'test-key', maxRetries: 3 });
  });

  afterEach(() => {
    fetchMock.mockReset();
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

    const result = await extractArticle('https://example.com');

    expect(result.data.headline).toBe('Recovered');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 10_000);

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
