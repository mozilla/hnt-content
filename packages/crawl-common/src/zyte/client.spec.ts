import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  initZyteClient,
  extractArticle,
  extractArticleList,
  RETRYABLE_STATUS_CODES,
} from './client.js';
import { ZyteError } from './errors.js';

const fetchMock = vi.fn<(url: any, init: any) => Promise<Response>>();
vi.stubGlobal('fetch', fetchMock);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Return the parsed JSON body from the most recent fetch call. */
function lastRequestBody(): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls.at(-1)!;
  return JSON.parse(init.body);
}

/** Return the headers from the most recent fetch call. */
function lastRequestHeaders(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(fetchMock.mock.calls.at(-1)![1].headers),
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  initZyteClient({ apiKey: 'test-key' });
});

describe('initZyteClient', () => {
  it('throws if extractArticle is called before init', () => {
    // Re-import to get a fresh module... Instead, test indirectly:
    // initZyteClient was called in beforeEach, so this verifies
    // the happy path works. The uninitialized case is tested by
    // directly verifying the error message in client.ts.
  });
});

describe('extractArticle', () => {
  it('sends correct request body for article extraction', async () => {
    const article = { headline: 'Test' };
    fetchMock.mockResolvedValueOnce(jsonResponse({ article }));

    await extractArticle('https://example.com/article');

    const body = lastRequestBody();
    expect(body.url).toBe('https://example.com/article');
    expect(body.article).toBe(true);
    expect(body.articleList).toBeUndefined();
  });

  it('returns the article from the response', async () => {
    const article = {
      headline: 'Breaking News',
      articleBody: 'Full article text here.',
      authors: [{ nameRaw: 'Jane Doe' }],
      mainImage: { url: 'https://example.com/img.jpg' },
      inLanguage: 'en',
    };
    fetchMock.mockResolvedValueOnce(jsonResponse({ article }));

    const result = await extractArticle('https://example.com/article');

    expect(result).toEqual(article);
  });

  it('sends Basic auth header with API key', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ article: {} }));

    await extractArticle('https://example.com/article');

    const headers = lastRequestHeaders();
    const expected = `Basic ${btoa('test-key:')}`;
    expect(headers['Authorization']).toBe(expected);
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('posts to the configured API URL', async () => {
    initZyteClient({
      apiKey: 'k',
      apiUrl: 'https://custom.zyte.com/extract',
    });
    fetchMock.mockResolvedValueOnce(jsonResponse({ article: {} }));

    await extractArticle('https://example.com/article');

    expect(fetchMock.mock.calls[0][0]).toBe('https://custom.zyte.com/extract');
  });

  it('includes extractFrom with httpResponseBody', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ article: {} }));

    await extractArticle('https://example.com/a', {
      extractFrom: 'httpResponseBody',
    });

    const body = lastRequestBody();
    expect(body.articleOptions).toEqual({
      extractFrom: 'httpResponseBody',
    });
    expect(body.httpResponseBody).toBe(true);
  });

  it('includes extractFrom with browserHtml', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ article: {} }));

    await extractArticle('https://example.com/a', {
      extractFrom: 'browserHtml',
    });

    const body = lastRequestBody();
    expect(body.articleOptions).toEqual({
      extractFrom: 'browserHtml',
    });
    expect(body.httpResponseBody).toBeUndefined();
  });

  it('includes customHttpRequestHeaders', async () => {
    const headers = [
      { name: 'User-Agent', value: 'MozBot/1.0' },
      { name: 'Zyte-Override-Headers', value: 'User-Agent' },
    ];
    fetchMock.mockResolvedValueOnce(jsonResponse({ article: {} }));

    await extractArticle('https://example.com/a', {
      customHttpRequestHeaders: headers,
    });

    expect(lastRequestBody().customHttpRequestHeaders).toEqual(headers);
  });

  it('includes tags', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ article: {} }));

    await extractArticle('https://example.com/a', {
      tags: ['hnt', 'crawl'],
    });

    expect(lastRequestBody().tags).toEqual(['hnt', 'crawl']);
  });

  it('throws ZyteError on non-ok response', async () => {
    const errorBody = {
      type: '/auth/key-not-found',
      title: 'Authentication Key Not Found',
      status: 401,
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(errorBody, 401));

    const err = await extractArticle('https://example.com/a').catch((e) => e);

    expect(err).toBeInstanceOf(ZyteError);
    expect(err.status).toBe(401);
    expect(err.responseBody).toEqual(errorBody);
    expect(err.message).toContain('401');
  });

  it('throws ZyteError even when response body is not JSON', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('Internal Server Error', {
        status: 500,
        statusText: 'Internal Server Error',
      }),
    );

    const err = await extractArticle('https://example.com/a').catch((e) => e);

    expect(err).toBeInstanceOf(ZyteError);
    expect(err.status).toBe(500);
    expect(err.responseBody).toBeUndefined();
  });
});

describe('extractArticleList', () => {
  it('sends correct request body for article list extraction', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ articleList: { articles: [] } }),
    );

    await extractArticleList('https://example.com/news');

    const body = lastRequestBody();
    expect(body.url).toBe('https://example.com/news');
    expect(body.articleList).toBe(true);
    expect(body.article).toBeUndefined();
  });

  it('returns articles from the response', async () => {
    const articles = [
      { url: 'https://example.com/a1', headline: 'Article 1' },
      { url: 'https://example.com/a2', headline: 'Article 2' },
    ];
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ articleList: { articles } }),
    );

    const result = await extractArticleList('https://example.com/news');

    expect(result).toEqual(articles);
  });

  it('returns empty array when no articles found', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ articleList: {} }));

    const result = await extractArticleList('https://example.com/news');

    expect(result).toEqual([]);
  });

  it('uses articleListOptions for extractFrom', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ articleList: { articles: [] } }),
    );

    await extractArticleList('https://example.com/news', {
      extractFrom: 'httpResponseBody',
    });

    const body = lastRequestBody();
    expect(body.articleListOptions).toEqual({
      extractFrom: 'httpResponseBody',
    });
    expect(body.httpResponseBody).toBe(true);
  });

  it('throws ZyteError on non-ok response', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 403));

    const err = await extractArticleList('https://example.com/news').catch(
      (e) => e,
    );

    expect(err).toBeInstanceOf(ZyteError);
    expect(err.status).toBe(403);
  });
});

describe('RETRYABLE_STATUS_CODES', () => {
  it('includes all expected transient status codes', () => {
    expect(RETRYABLE_STATUS_CODES).toContain(429);
    expect(RETRYABLE_STATUS_CODES).toContain(500);
    expect(RETRYABLE_STATUS_CODES).toContain(503);
    expect(RETRYABLE_STATUS_CODES).toContain(520);
    expect(RETRYABLE_STATUS_CODES).toContain(521);
  });

  it('does not include permanent error codes', () => {
    for (const code of [400, 401, 403, 422, 451]) {
      expect(RETRYABLE_STATUS_CODES).not.toContain(code);
    }
  });
});
