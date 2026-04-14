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
  extractFrom?: 'httpResponseBody' | 'browserHtml';
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
  link?: string;
}

/** Article data returned by Zyte's article extraction. */
export interface ZyteArticle {
  headline?: string;
  description?: string;
  authors?: ZyteAuthor[];
  mainImage?: ZyteImage;
  articleBody?: string;
  articleBodyHtml?: string;
  datePublished?: string;
  datePublishedRaw?: string;
  dateModified?: string;
  canonicalUrl?: string;
  url?: string;
  breadcrumbs?: ZyteBreadcrumb[];
  inLanguage?: string;
  metadata?: Record<string, unknown>;
}

/** Single article from a Zyte article list response. */
export interface ZyteArticleListItem {
  url?: string;
  headline?: string;
  authors?: ZyteAuthor[];
  datePublished?: string;
  description?: string;
  mainImage?: ZyteImage;
  articleBody?: string;
  inLanguage?: string;
  metadata?: Record<string, unknown>;
}
