import isNetworkError from 'is-network-error';
import pRetry from 'p-retry';
import type {
  ZyteClientOptions,
  ExtractionOptions,
  ZyteArticle,
  ZyteArticleListItem,
  ZyteResponse,
} from './types.js';
import { ZyteError } from './errors.js';

const DEFAULT_API_URL = 'https://api.zyte.com/v1/extract';
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_RETRIES = 3;

/** Status codes that trigger automatic retry. */
export const RETRYABLE_STATUS_CODES = [429, 500, 503, 520, 521] as const;

/** Lower bound on retry delay. */
export const RETRY_MIN_TIMEOUT_MS = 2_000;

/** Upper bound on retry delay. */
export const RETRY_MAX_TIMEOUT_MS = 30_000;

/**
 * Return whether a failed request should be retried. Retries
 * network errors and Zyte API responses with transient status
 * codes.
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof ZyteError) {
    return (RETRYABLE_STATUS_CODES as readonly number[]).includes(
      error.status,
    );
  }
  return isNetworkError(error);
}

let apiKey: string | undefined;
let apiUrl = DEFAULT_API_URL;
let timeout = DEFAULT_TIMEOUT_MS;
let maxRetries = DEFAULT_MAX_RETRIES;

/**
 * Initialize the Zyte API client. Must be called once before
 * extractArticle or extractArticleList.
 */
export function initZyteClient(opts: ZyteClientOptions): void {
  if (!opts.apiKey) {
    throw new Error('Zyte API key is required');
  }
  apiKey = opts.apiKey;
  apiUrl = opts.apiUrl ?? DEFAULT_API_URL;
  timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS;
  maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
}

/**
 * Extract article data from a URL via Zyte's article
 * extraction API.
 */
export async function extractArticle(
  url: string,
  opts?: ExtractionOptions,
): Promise<ZyteResponse<ZyteArticle>> {
  const body = buildRequestBody(url, 'article', opts);
  const data = await zyteRequest(body);
  const statusCode = data.statusCode as number;
  const article = data.article as ZyteArticle | undefined;
  if (!article) {
    throw new ZyteError(
      statusCode,
      `Zyte API returned ${statusCode} but no article data for ${url}`,
    );
  }
  return {
    data: article,
    url: data.url as string,
    statusCode,
  };
}

/**
 * Extract a list of articles from a page URL via Zyte's
 * article list extraction API.
 */
export async function extractArticleList(
  url: string,
  opts?: ExtractionOptions,
): Promise<ZyteResponse<ZyteArticleListItem[]>> {
  const body = buildRequestBody(url, 'articleList', opts);
  const data = await zyteRequest(body);
  const statusCode = data.statusCode as number;
  const list = data.articleList as
    | { articles?: ZyteArticleListItem[] }
    | undefined;
  if (!list) {
    throw new ZyteError(
      statusCode,
      `Zyte API returned ${statusCode} but no articleList data for ${url}`,
    );
  }
  return {
    data: list.articles ?? [],
    url: data.url as string,
    statusCode,
  };
}

type ExtractionType = 'article' | 'articleList';

/** Build the Zyte extract API request body for the given URL. */
function buildRequestBody(
  url: string,
  type: ExtractionType,
  opts?: ExtractionOptions,
): Record<string, unknown> {
  const body: Record<string, unknown> = { url, [type]: true };

  if (opts?.extractFrom) {
    const optionsKey =
      type === 'article' ? 'articleOptions' : 'articleListOptions';
    body[optionsKey] = { extractFrom: opts.extractFrom };
    // Explicitly request the raw HTTP response body so Zyte
    // uses HTTP fetching instead of browser rendering.
    if (opts.extractFrom === 'httpResponseBody') {
      body.httpResponseBody = true;
    }
  }

  if (opts?.customHttpRequestHeaders) {
    body.customHttpRequestHeaders = opts.customHttpRequestHeaders;
  }

  if (opts?.tags) {
    body.tags = opts.tags;
  }

  return body;
}

/**
 * Send a request to the Zyte extract API with automatic
 * retry on transient errors via p-retry.
 */
async function zyteRequest(
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const key = apiKey;
  if (!key) {
    throw new Error(
      'Zyte client not initialized. Call initZyteClient() first.',
    );
  }

  return pRetry(
    async () => {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Basic ${btoa(key + ':')}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });

      if (response.status >= 400) {
        let parsed: unknown;
        try {
          parsed = await response.json();
        } catch {
          // Response body may not be valid JSON.
        }
        throw new ZyteError(
          response.status,
          `Zyte API error: ${response.status} for ${body.url}`,
          parsed,
        );
      }

      try {
        return (await response.json()) as Record<string, unknown>;
      } catch {
        throw new ZyteError(
          response.status,
          `Zyte API returned ${response.status} with unparseable body for ${body.url}`,
        );
      }
    },
    {
      retries: maxRetries,
      minTimeout: RETRY_MIN_TIMEOUT_MS,
      maxTimeout: RETRY_MAX_TIMEOUT_MS,
      factor: 2,
      shouldRetry({ error }) {
        return isRetryable(error);
      },
    },
  );
}
