import { z } from 'zod';

/**
 * Curated corpus item metadata, present on crawl-article
 * messages for live articles managed by editors.
 */
export const CorpusItemSchema = z.object({
  external_id: z.string(),
  title: z.string(),
  excerpt: z.string(),
  authors: z.array(z.object({ name: z.string() })),
  status: z.enum(['CORPUS', 'RECOMMENDATION']),
  language: z.enum(['EN', 'DE', 'ES', 'FR', 'IT']),
  publisher: z.string(),
  image_url: z.string(),
  topic: z.string(),
  is_time_sensitive: z.boolean(),
});

export type CorpusItem = z.infer<typeof CorpusItemSchema>;

/**
 * Pub/Sub message consumed from the crawl-article
 * subscription. corpus_item is present only for live
 * articles published by the crawl agent.
 */
export const CrawlArticleMessageSchema = z.object({
  url: z.string().url(),
  source_url: z.string().url(),
  crawl_id: z.string(),
  enqueued_at: z.string().datetime(),
  corpus_item: CorpusItemSchema.optional(),
});

export type CrawlArticleMessage = z.infer<typeof CrawlArticleMessageSchema>;
