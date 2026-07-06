/** Author in an article event published to BigQuery. */
export interface ArticleAuthor {
  name: string;
}

/** Breadcrumb in an article event published to BigQuery. */
export interface ArticleBreadcrumb {
  name?: string;
  url?: string;
}

/**
 * Event published to the articles Pub/Sub topic and written
 * to the crawl.articles BigQuery table via a BigQuery
 * subscription.
 */
export interface ArticleEvent {
  url: string;
  extracted_at: string;
  headline?: string;
  description?: string;
  authors?: ArticleAuthor[];
  main_image_url?: string;
  body_truncated?: string;
  published_at?: string;
  breadcrumbs?: ArticleBreadcrumb[];
  language?: string;
}

/**
 * Event published to the article-discoveries Pub/Sub topic and
 * written to the crawl.article_discoveries BigQuery table via a
 * BigQuery subscription. One event per discovered article and
 * context, so topic and surface_id come from the context the
 * page was crawled for, while source_url is that page.
 */
export interface ArticleDiscoveryEvent {
  url: string;
  source_url: string;
  crawled_at: string;
  published_at?: string;
  headline?: string;
  authors?: ArticleAuthor[];
  summary?: string;
  language?: string;
  topic?: string;
  page_position?: number;
  surface_id: string;
}
