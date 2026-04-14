import { Agent, RetryAgent } from 'undici';
import type {
  ZyteClientOptions,
  ExtractionOptions,
  ZyteArticle,
  ZyteArticleListItem,
} from './types.js';
import { ZyteError } from './errors.js';

const DEFAULT_API_URL = 'https://api.zyte.com/v1/extract';
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_RETRIES = 3;

/** Status codes that trigger automatic retry via RetryAgent. */
export const RETRYABLE_STATUS_CODES = [429, 500, 503, 520, 521];

let dispatcher: RetryAgent | undefined;
let apiKey: string;
let apiUrl: string;

/**
 * Initialize the Zyte API client. Must be called once before
 * extractArticle or extractArticleList.
 */
export function initZyteClient(opts: ZyteClientOptions): void {
  apiKey = opts.apiKey;
  apiUrl = opts.apiUrl ?? DEFAULT_API_URL;

  const requestTimeout = opts.timeout ?? DEFAULT_TIMEOUT_MS;
  const agent = new Agent({
    headersTimeout: requestTimeout,
    bodyTimeout: requestTimeout,
  });

  dispatcher = new RetryAgent(agent, {
    maxRetries: opts.maxRetries ?? DEFAULT_MAX_RETRIES,
    minTimeout: 2_000,
    maxTimeout: 30_000,
    timeoutFactor: 2,
    retryAfter: true,
    throwOnError: false,
    methods: ['POST'],
    statusCodes: RETRYABLE_STATUS_CODES,
  });
}

/**
 * Extract article data from a URL via Zyte's article
 * extraction API.
 */
export async function extractArticle(
  url: string,
  opts?: ExtractionOptions,
): Promise<ZyteArticle> {
  const body = buildRequestBody(url, 'article', opts);
  const data = await zyteRequest(body);
  return data.article as ZyteArticle;
}

/**
 * Extract a list of articles from a page URL via Zyte's
 * article list extraction API.
 */
export async function extractArticleList(
  url: string,
  opts?: ExtractionOptions,
): Promise<ZyteArticleListItem[]> {
  const body = buildRequestBody(url, 'articleList', opts);
  const data = await zyteRequest(body);
  const list = data.articleList as
    | { articles?: ZyteArticleListItem[] }
    | undefined;
  return list?.articles ?? [];
}

type ExtractionType = 'article' | 'articleList';

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

async function zyteRequest(
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!dispatcher) {
    throw new Error(
      'Zyte client not initialized. Call initZyteClient() first.',
    );
  }

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${btoa(apiKey + ':')}`,
    },
    body: JSON.stringify(body),
    dispatcher,
  } as RequestInit);

  if (!response.ok) {
    let responseBody: unknown;
    try {
      responseBody = await response.json();
    } catch {
      // Response body may not be valid JSON.
    }
    throw new ZyteError(
      response.status,
      `Zyte API error: ${response.status} ${response.statusText}`,
      responseBody,
    );
  }

  return (await response.json()) as Record<string, unknown>;
}
