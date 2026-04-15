import { Agent, RetryAgent, request } from 'undici';
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

/** Status codes that trigger automatic retry via RetryAgent. */
export const RETRYABLE_STATUS_CODES = [429, 500, 503, 520, 521] as const;

let dispatcher: RetryAgent | undefined;
let apiKey: string | undefined;
let apiUrl: string;

/**
 * Initialize the Zyte API client. Must be called once before
 * extractArticle or extractArticleList.
 */
export function initZyteClient(opts: ZyteClientOptions): void {
  if (!opts.apiKey) {
    throw new Error('Zyte API key is required');
  }

  const requestTimeout = opts.timeout ?? DEFAULT_TIMEOUT_MS;
  const agent = new Agent({
    headersTimeout: requestTimeout,
    bodyTimeout: requestTimeout,
  });
  const newDispatcher = new RetryAgent(agent, {
    maxRetries: opts.maxRetries ?? DEFAULT_MAX_RETRIES,
    minTimeout: 2_000,
    maxTimeout: 30_000,
    timeoutFactor: 2,
    retryAfter: true,
    throwOnError: false,
    methods: ['POST'],
    statusCodes: [...RETRYABLE_STATUS_CODES],
  });

  dispatcher?.close();
  apiKey = opts.apiKey;
  apiUrl = opts.apiUrl ?? DEFAULT_API_URL;
  dispatcher = newDispatcher;
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
  const article = data.article as ZyteArticle | undefined;
  if (!article) {
    throw new ZyteError(
      200,
      `Zyte API returned 200 but no article data for ${url}`,
    );
  }
  return {
    data: article,
    url: data.url as string,
    statusCode: data.statusCode as number,
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
  const list = data.articleList as
    | { articles?: ZyteArticleListItem[] }
    | undefined;
  if (!list) {
    throw new ZyteError(
      200,
      `Zyte API returned 200 but no articleList data for ${url}`,
    );
  }
  return {
    data: list.articles ?? [],
    url: data.url as string,
    statusCode: data.statusCode as number,
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
 * Send a request to the Zyte extract API and return the
 * parsed JSON response. Uses undici.request() instead of
 * fetch() because fetch converts the body to a stream that
 * cannot be replayed on retry.
 */
async function zyteRequest(
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!dispatcher) {
    throw new Error(
      'Zyte client not initialized. Call initZyteClient() first.',
    );
  }

  const { statusCode, body: responseBody } = await request(apiUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Basic ${btoa(apiKey + ':')}`,
    },
    body: JSON.stringify(body),
    dispatcher,
  });

  if (statusCode >= 400) {
    let parsed: unknown;
    try {
      parsed = await responseBody.json();
    } catch {
      // Response body may not be valid JSON.
    }
    throw new ZyteError(statusCode, `Zyte API error: ${statusCode}`, parsed);
  }

  try {
    return (await responseBody.json()) as Record<string, unknown>;
  } catch {
    throw new ZyteError(
      statusCode,
      `Zyte API returned ${statusCode} with unparseable body`,
    );
  }
}
