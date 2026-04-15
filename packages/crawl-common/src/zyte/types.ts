/** Options for configuring the Zyte API client. */
export interface ZyteClientOptions {
  /** Zyte API key for authentication. */
  apiKey: string;
  /** Base URL for the Zyte extract endpoint. */
  apiUrl?: string;
  /**
   * Per-request timeout in milliseconds, applied to both
   * connection and response. Defaults to 90000.
   */
  timeout?: number;
  /** Max retry attempts for transient errors. Defaults to 3. */
  maxRetries?: number;
}

/** Per-request extraction options. */
export interface ExtractionOptions {
  /**
   * Source for article/articleList extraction.
   * - 'httpResponseBody': extract from the raw HTTP response
   *   (cheaper, no browser rendering).
   * - 'browserHtml': extract from browser-rendered HTML
   *   (handles JS-rendered content).
   * - 'browserHtmlOnly': extract only from browser-rendered
   *   HTML, not from screenshots. Can improve extraction on
   *   pages with overlays or popups.
   *
   * Defaults to browser rendering when omitted.
   */
  extractFrom?: 'httpResponseBody' | 'browserHtml' | 'browserHtmlOnly';
  /**
   * HTTP headers Zyte sends when fetching the target URL.
   * Each header is a name/value pair. Overrides Zyte's
   * defaults for the specified header names.
   */
  customHttpRequestHeaders?: Array<{
    name: string;
    value: string;
  }>;
  /**
   * Tags attached to the request for filtering and
   * categorization in the Zyte dashboard and API logs.
   */
  tags?: string[];
}

/** Author in a Zyte extraction response. */
export interface ZyteAuthor {
  nameRaw?: string;
  name?: string;
}

/** Image in a Zyte extraction response. */
export interface ZyteImage {
  url: string;
}

/** Breadcrumb in a Zyte article response. */
export interface ZyteBreadcrumb {
  name?: string;
  url?: string;
}

/** Extraction metadata on a Zyte article response. */
export interface ZyteArticleMetadata {
  /** Confidence score from 0 to 1. */
  probability: number;
  /** ISO 8601 UTC timestamp of when Zyte downloaded the page. */
  dateDownloaded: string;
}

/**
 * Extraction metadata on a single item within a Zyte
 * articleList response.
 */
export interface ZyteArticleListItemMetadata {
  /** Confidence score from 0 to 1. */
  probability: number;
  /** URL of the page where this article list was extracted. */
  url: string;
}

/**
 * Response envelope returned by Zyte extract API. Both
 * extractArticle and extractArticleList return this shape
 * so callers can access the redirect URL and status code.
 */
export interface ZyteResponse<T> {
  /** Extraction result. */
  data: T;
  /** URL after redirects (may differ from the input URL). */
  url: string;
  /** HTTP status code of the target page. */
  statusCode: number;
}

/** Article data returned by Zyte's article extraction. */
export interface ZyteArticle {
  url: string;
  headline?: string;
  description?: string;
  authors?: ZyteAuthor[];
  mainImage?: ZyteImage;
  images?: ZyteImage[];
  videos?: ZyteImage[];
  audios?: ZyteImage[];
  articleBody?: string;
  articleBodyHtml?: string;
  datePublished?: string;
  datePublishedRaw?: string;
  dateModified?: string;
  dateModifiedRaw?: string;
  canonicalUrl?: string;
  breadcrumbs?: ZyteBreadcrumb[];
  inLanguage?: string;
  metadata: ZyteArticleMetadata;
}

/** Single article from a Zyte article list response. */
export interface ZyteArticleListItem {
  url?: string;
  headline?: string;
  authors?: ZyteAuthor[];
  datePublished?: string;
  datePublishedRaw?: string;
  description?: string;
  mainImage?: ZyteImage;
  images?: ZyteImage[];
  articleBody?: string;
  inLanguage?: string;
  metadata: ZyteArticleListItemMetadata;
}
