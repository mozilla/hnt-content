/**
 * Curated corpus item metadata, present on crawl-article
 * messages for live articles managed by editors.
 */
export interface CorpusItem {
  external_id: string;
  title: string;
  excerpt: string;
  authors: { name: string }[];
  status: 'CORPUS' | 'RECOMMENDATION';
  // Sync with CorpusLanguage in content-monorepo
  // packages/content-common/src/types.ts.
  language: 'EN' | 'DE' | 'ES' | 'FR' | 'IT';
  publisher: string;
  image_url: string;
  topic: string;
  is_time_sensitive: boolean;
}

/**
 * Pub/Sub message consumed from the crawl-article
 * subscription. corpus_item is present only for live
 * articles published by the crawl agent.
 */
export interface CrawlArticleMessage {
  url: string;
  source_url: string;
  crawl_id: string;
  enqueued_at: string;
  corpus_item?: CorpusItem;
}

/**
 * Surface and topic a discovered page is crawled for. A page
 * can be crawled for several surfaces, so each discovery job
 * carries one context per (surface, topic) pair.
 */
export interface DiscoveryContext {
  surface_id: string;
  topic: string;
}

/**
 * Pub/Sub message consumed from the crawl-article-discovery
 * subscription. Tells the discovery worker which page to crawl,
 * how recently it may have been crawled, and the contexts to
 * attribute discovered articles to.
 */
export interface CrawlArticleDiscoveryMessage {
  url: string;
  interval_minutes: number;
  contexts: DiscoveryContext[];
}
