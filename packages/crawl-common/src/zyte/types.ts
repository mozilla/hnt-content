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
   * Extraction source. When set to 'httpResponseBody', the
   * cheaper HTTP-only fetch is used instead of a full browser
   * render.
   */
  extractFrom?: 'httpResponseBody' | 'browserHtml' | 'browserHtmlOnly';
  /** Custom HTTP request headers sent by Zyte's fetcher. */
  customHttpRequestHeaders?: Array<{
    name: string;
    value: string;
  }>;
  /** Tags for request categorization in Zyte dashboard. */
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
