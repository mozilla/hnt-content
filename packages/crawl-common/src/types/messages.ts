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
  // Refresh window for this article, set by the producer: discovery uses
  // the article fetch TTL, the agent uses the live-article interval. The
  // worker gates re-fetch and writes its fetch claim against this value.
  // Optional so a rolling deploy does not reject messages enqueued before
  // the field existed; the worker falls back to the configured fetch TTL.
  refresh_interval_minutes?: number;
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

/**
 * A live (curated) article in the agent's publisher list. The agent
 * enqueues a crawl-article job carrying this corpus_item so the
 * worker can re-extract and sync editorial metadata.
 */
export interface LiveArticle {
  url: string;
  corpus_item: CorpusItem;
}

/**
 * The agent's publisher list, loaded from JSON. pages drive
 * discovery crawls; live_articles are re-crawled directly to keep
 * curated metadata fresh. Phase 5 replaces this with the Corpus API.
 */
export interface PublisherList {
  pages: CrawlArticleDiscoveryMessage[];
  live_articles: LiveArticle[];
}
