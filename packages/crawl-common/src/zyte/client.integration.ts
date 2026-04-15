import { describe, it, expect, afterEach } from 'vitest';
import { MockAgent, RetryAgent } from 'undici';

/**
 * Verify that RetryAgent actually retries POST requests with
 * undici.request(). This is the integration test for the
 * critical fetch->request migration: fetch() converts bodies
 * to streams that break on retry; request() does not.
 */
describe('RetryAgent integration', () => {
  let mockAgent: MockAgent;

  afterEach(() => mockAgent.close());

  it('retries POST on transient 500 and succeeds', async () => {
    mockAgent = new MockAgent();
    const pool = mockAgent.get('https://api.zyte.com');

    pool
      .intercept({ path: '/v1/extract', method: 'POST' })
      .reply(500, { error: 'transient' });
    pool
      .intercept({ path: '/v1/extract', method: 'POST' })
      .reply(200, { article: { headline: 'Recovered' } });

    const dispatcher = new RetryAgent(mockAgent, {
      maxRetries: 3,
      minTimeout: 10,
      maxTimeout: 50,
      timeoutFactor: 1,
      methods: ['POST'],
      statusCodes: [500],
      throwOnError: false,
    });

    const { request } = await import('undici');
    const { statusCode, body } = await request(
      'https://api.zyte.com/v1/extract',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com', article: true }),
        dispatcher,
      },
    );

    expect(statusCode).toBe(200);
    const data = await body.json();
    expect((data as any).article.headline).toBe('Recovered');
  });

  it('does not retry permanent 401 errors', async () => {
    mockAgent = new MockAgent();
    const pool = mockAgent.get('https://api.zyte.com');

    pool
      .intercept({ path: '/v1/extract', method: 'POST' })
      .reply(401, { type: '/auth/key-not-found' });

    const dispatcher = new RetryAgent(mockAgent, {
      maxRetries: 3,
      minTimeout: 10,
      maxTimeout: 50,
      timeoutFactor: 1,
      methods: ['POST'],
      statusCodes: [500],
      throwOnError: false,
    });

    const { request } = await import('undici');
    const { statusCode } = await request('https://api.zyte.com/v1/extract', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com', article: true }),
      dispatcher,
    });

    expect(statusCode).toBe(401);
  });
});
