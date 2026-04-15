import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  initZyteClient,
  extractArticle,
  extractArticleList,
  isRetryable,
} from './client.js';
import { ZyteError } from './errors.js';

const fetchMock = vi.fn<typeof fetch>();

/** Realistic Zyte article extraction response. */
const ARTICLE_RESPONSE = {
  url: 'https://example.com/article',
  statusCode: 200,
  article: {
    url: 'https://example.com/article',
    headline: 'Breaking News',
    articleBody: 'Full article text here.',
    authors: [{ name: 'Jane Doe', nameRaw: 'Jane Doe' }],
    mainImage: { url: 'https://example.com/img.jpg' },
    inLanguage: 'en',
    metadata: { probability: 0.95, dateDownloaded: '2026-04-14T12:00:00Z' },
  },
};

/** Realistic Zyte article list extraction response. */
const ARTICLE_LIST_RESPONSE = {
  url: 'https://example.com/news',
  statusCode: 200,
  articleList: {
    url: 'https://example.com/news',
    articles: [
      {
        url: 'https://example.com/a1',
        headline: 'Article 1',
        metadata: { probability: 0.9, url: 'https://example.com/news' },
      },
      {
        url: 'https://example.com/a2',
        headline: 'Article 2',
        metadata: { probability: 0.85, url: 'https://example.com/news' },
      },
    ],
    metadata: { dateDownloaded: '2026-04-14T12:00:00Z' },
  },
};

/** Create a mock fetch Response with a JSON body. */
function mockResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Return the parsed JSON body from the most recent fetch call. */
function lastRequestBody(): Record<string, unknown> {
  const opts = fetchMock.mock.calls.at(-1)![1]!;
  return JSON.parse(opts.body as string);
}

/** Return the headers from the most recent fetch call. */
function lastRequestHeaders(): Record<string, string> {
  const opts = fetchMock.mock.calls.at(-1)![1]!;
  return opts.headers as Record<string, string>;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  initZyteClient({ apiKey: 'test-key', maxRetries: 0 });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('initZyteClient', () => {
  it('throws on empty API key', () => {
    expect(() => initZyteClient({ apiKey: '' })).toThrow(
      'Zyte API key is required',
    );
  });
});

describe('extractArticle', () => {
  describe('request', () => {
    it('sends correct request body', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(ARTICLE_RESPONSE));

      await extractArticle('https://example.com/article');

      const body = lastRequestBody();
      expect(body.url).toBe('https://example.com/article');
      expect(body.article).toBe(true);
      expect(body.articleList).toBeUndefined();
    });

    it('sends Basic auth header with API key', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(ARTICLE_RESPONSE));

      await extractArticle('https://example.com/article');

      const headers = lastRequestHeaders();
      const expected = `Basic ${btoa('test-key:')}`;
      expect(headers['authorization']).toBe(expected);
      expect(headers['content-type']).toBe('application/json');
    });

    it('posts to the configured API URL', async () => {
      initZyteClient({
        apiKey: 'k',
        apiUrl: 'https://custom.zyte.com/extract',
        maxRetries: 0,
      });
      fetchMock.mockResolvedValueOnce(mockResponse(ARTICLE_RESPONSE));

      await extractArticle('https://example.com/article');

      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://custom.zyte.com/extract',
      );
    });

    it('includes extractFrom with httpResponseBody', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(ARTICLE_RESPONSE));

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
      fetchMock.mockResolvedValueOnce(mockResponse(ARTICLE_RESPONSE));

      await extractArticle('https://example.com/a', {
        extractFrom: 'browserHtml',
      });

      const body = lastRequestBody();
      expect(body.articleOptions).toEqual({
        extractFrom: 'browserHtml',
      });
      expect(body.httpResponseBody).toBeUndefined();
    });

    it('includes extractFrom with browserHtmlOnly', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(ARTICLE_RESPONSE));

      await extractArticle('https://example.com/a', {
        extractFrom: 'browserHtmlOnly',
      });

      const body = lastRequestBody();
      expect(body.articleOptions).toEqual({
        extractFrom: 'browserHtmlOnly',
      });
      expect(body.httpResponseBody).toBeUndefined();
    });

    it('includes all options when combined', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(ARTICLE_RESPONSE));

      await extractArticle('https://example.com/a', {
        extractFrom: 'httpResponseBody',
        customHttpRequestHeaders: [
          { name: 'User-Agent', value: 'MozBot/1.0' },
        ],
        tags: ['hnt'],
      });

      const body = lastRequestBody();
      expect(body.articleOptions).toEqual({
        extractFrom: 'httpResponseBody',
      });
      expect(body.httpResponseBody).toBe(true);
      expect(body.customHttpRequestHeaders).toEqual([
        { name: 'User-Agent', value: 'MozBot/1.0' },
      ]);
      expect(body.tags).toEqual(['hnt']);
    });

    it('includes customHttpRequestHeaders', async () => {
      const headers = [
        { name: 'User-Agent', value: 'MozBot/1.0' },
        { name: 'Zyte-Override-Headers', value: 'User-Agent' },
      ];
      fetchMock.mockResolvedValueOnce(mockResponse(ARTICLE_RESPONSE));

      await extractArticle('https://example.com/a', {
        customHttpRequestHeaders: headers,
      });

      expect(lastRequestBody().customHttpRequestHeaders).toEqual(headers);
    });

    it('includes tags', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(ARTICLE_RESPONSE));

      await extractArticle('https://example.com/a', {
        tags: ['hnt', 'crawl'],
      });

      expect(lastRequestBody().tags).toEqual(['hnt', 'crawl']);
    });
  });

  describe('response', () => {
    it('returns article data with envelope fields', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(ARTICLE_RESPONSE));

      const result = await extractArticle('https://example.com/article');

      expect(result.data.headline).toBe('Breaking News');
      expect(result.data.metadata.probability).toBe(0.95);
      expect(result.url).toBe('https://example.com/article');
      expect(result.statusCode).toBe(200);
    });

    it('returns redirect URL from envelope', async () => {
      const redirected = {
        ...ARTICLE_RESPONSE,
        url: 'https://example.com/redirected-article',
      };
      fetchMock.mockResolvedValueOnce(mockResponse(redirected));

      const result = await extractArticle('https://example.com/old-url');

      expect(result.url).toBe('https://example.com/redirected-article');
    });

    it('throws ZyteError on non-ok response', async () => {
      const errorBody = {
        type: '/auth/key-not-found',
        title: 'Authentication Key Not Found',
        status: 401,
      };
      fetchMock.mockResolvedValueOnce(mockResponse(errorBody, 401));

      const err = await extractArticle('https://example.com/a').catch(
        (e) => e,
      );

      expect(err).toBeInstanceOf(ZyteError);
      expect(err.status).toBe(401);
      expect(err.responseBody).toEqual(errorBody);
      expect(err.message).toContain('401');
      expect(err.message).toContain('https://example.com/a');
    });

    it('throws ZyteError when article is null', async () => {
      fetchMock.mockResolvedValueOnce(
        mockResponse({
          url: 'https://example.com/a',
          statusCode: 200,
          article: null,
        }),
      );

      const err = await extractArticle('https://example.com/a').catch(
        (e) => e,
      );

      expect(err).toBeInstanceOf(ZyteError);
      expect(err.message).toContain('no article data');
    });

    it('throws ZyteError when response lacks article data', async () => {
      fetchMock.mockResolvedValueOnce(
        mockResponse({
          url: 'https://example.com/a',
          statusCode: 200,
        }),
      );

      const err = await extractArticle('https://example.com/a').catch(
        (e) => e,
      );

      expect(err).toBeInstanceOf(ZyteError);
      expect(err.status).toBe(200);
      expect(err.message).toContain('no article data');
    });

    it('propagates network errors from fetch', async () => {
      fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));

      await expect(extractArticle('https://example.com/a')).rejects.toThrow(
        'fetch failed',
      );
    });

    it('throws ZyteError when error response body is not JSON', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response('Internal Server Error', { status: 500 }),
      );

      const err = await extractArticle('https://example.com/a').catch(
        (e) => e,
      );

      expect(err).toBeInstanceOf(ZyteError);
      expect(err.status).toBe(500);
      expect(err.responseBody).toBeUndefined();
    });

    it('throws ZyteError when 200 response body is not JSON', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response('<html>Gateway Timeout</html>', { status: 200 }),
      );

      const err = await extractArticle('https://example.com/a').catch(
        (e) => e,
      );

      expect(err).toBeInstanceOf(ZyteError);
      expect(err.status).toBe(200);
      expect(err.message).toContain('unparseable body');
    });
  });
});

describe('extractArticleList', () => {
  describe('request', () => {
    it('sends correct request body', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(ARTICLE_LIST_RESPONSE));

      await extractArticleList('https://example.com/news');

      const body = lastRequestBody();
      expect(body.url).toBe('https://example.com/news');
      expect(body.articleList).toBe(true);
      expect(body.article).toBeUndefined();
    });

    it('uses articleListOptions for extractFrom', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(ARTICLE_LIST_RESPONSE));

      await extractArticleList('https://example.com/news', {
        extractFrom: 'httpResponseBody',
      });

      const body = lastRequestBody();
      expect(body.articleListOptions).toEqual({
        extractFrom: 'httpResponseBody',
      });
      expect(body.httpResponseBody).toBe(true);
    });
  });

  describe('response', () => {
    it('returns articles with envelope fields', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(ARTICLE_LIST_RESPONSE));

      const result = await extractArticleList('https://example.com/news');

      expect(result.data).toHaveLength(2);
      expect(result.data[0].headline).toBe('Article 1');
      expect(result.url).toBe('https://example.com/news');
      expect(result.statusCode).toBe(200);
    });

    it('returns empty array when articles list is empty', async () => {
      fetchMock.mockResolvedValueOnce(
        mockResponse({
          url: 'https://example.com/news',
          statusCode: 200,
          articleList: {
            articles: [],
            url: 'https://example.com/news',
            metadata: { dateDownloaded: '2026-04-14T12:00:00Z' },
          },
        }),
      );

      const result = await extractArticleList('https://example.com/news');

      expect(result.data).toEqual([]);
    });

    it('throws ZyteError when articleList is missing', async () => {
      fetchMock.mockResolvedValueOnce(
        mockResponse({
          url: 'https://example.com/news',
          statusCode: 200,
        }),
      );

      const err = await extractArticleList('https://example.com/news').catch(
        (e) => e,
      );

      expect(err).toBeInstanceOf(ZyteError);
      expect(err.status).toBe(200);
      expect(err.message).toContain('no articleList data');
    });

    it('throws ZyteError on non-ok response', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse({}, 403));

      const err = await extractArticleList('https://example.com/news').catch(
        (e) => e,
      );

      expect(err).toBeInstanceOf(ZyteError);
      expect(err.status).toBe(403);
    });
  });
});

describe('isRetryable', () => {
  it('returns true for transient Zyte status codes', () => {
    for (const code of [429, 500, 503, 520, 521]) {
      expect(isRetryable(new ZyteError(code, 'test'))).toBe(true);
    }
  });

  it('returns false for permanent Zyte status codes', () => {
    for (const code of [400, 401, 403, 422, 451]) {
      expect(isRetryable(new ZyteError(code, 'test'))).toBe(false);
    }
  });

  it('returns true for network errors', () => {
    expect(isRetryable(new TypeError('fetch failed'))).toBe(true);
  });

  it('returns false for non-network TypeErrors', () => {
    expect(isRetryable(new TypeError('Cannot read properties'))).toBe(
      false,
    );
  });

  it('returns false for generic errors', () => {
    expect(isRetryable(new Error('something broke'))).toBe(false);
  });
});
