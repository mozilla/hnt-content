import { z } from 'zod';

/** Author in an article event published to BigQuery. */
export const ArticleAuthorSchema = z.object({
  name: z.string(),
});

export type ArticleAuthor = z.infer<typeof ArticleAuthorSchema>;

/** Breadcrumb in an article event published to BigQuery. */
export const ArticleBreadcrumbSchema = z.object({
  name: z.string().optional(),
  url: z.string().optional(),
});

export type ArticleBreadcrumb = z.infer<typeof ArticleBreadcrumbSchema>;

/**
 * Event published to the articles Pub/Sub topic and written
 * to the crawl.articles BigQuery table via a BigQuery
 * subscription.
 */
export const ArticleEventSchema = z.object({
  url: z.string(),
  extracted_at: z.string().datetime(),
  headline: z.string().optional(),
  description: z.string().optional(),
  authors: z.array(ArticleAuthorSchema).optional(),
  main_image_url: z.string().optional(),
  body_truncated: z.string().optional(),
  published_at: z.string().optional(),
  breadcrumbs: z.array(ArticleBreadcrumbSchema).optional(),
  language: z.string().optional(),
});

export type ArticleEvent = z.infer<typeof ArticleEventSchema>;
