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
