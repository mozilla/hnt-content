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
  // enqueued_at is a datetime string as required by BigQuery.
  enqueued_at: string;
  // How often this article should be re-extracted, in minutes, set
  // by the producer: discovery uses the global article refresh
  // setting, the agent uses its live-article interval. Required, so
  // a job always carries the window it was scheduled under.
  article_refresh_minutes: number;
  corpus_item?: CorpusItem;
}

/**
 * Surface and topic a discovered page is crawled for, e.g.
 * surface_id 'NEW_TAB_EN_US' and topic 'BUSINESS'. A page can be
 * crawled for several surfaces, so each discovery job carries one
 * context per (surface, topic) pair.
 */
export interface DiscoveryContext {
  surface_id: string;
  topic: string;
}

/**
 * Pub/Sub message consumed from the crawl-article-discovery
 * subscription. Tells the discovery worker which page to crawl and
 * the contexts to attribute discovered articles to. The page crawl
 * cadence is a global setting, not a per-page field, so a queued
 * job is evaluated against the worker's setting at handling time.
 */
export interface CrawlArticleDiscoveryMessage {
  url: string;
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
