import { extractArticleList, getRegistrableDomain } from 'crawl-common';
import { time } from 'metrics';
import { toEventAuthors, toEventTimestamp } from './event-fields.js';
import type {
  ArticleDiscoveryEvent,
  CrawlArticleDiscoveryMessage,
  DiscoveryContext,
  ZyteArticleListItem,
} from 'crawl-common';

/**
 * Output of the discovery handler: one article-discoveries event
 * per discovered article and context, plus the unique article URLs
 * the worker enqueues for extraction.
 */
export interface DiscoveryResult {
  events: ArticleDiscoveryEvent[];
  articleUrls: string[];
}

/** A discovered article kept for publishing, with its page position. */
interface SelectedArticle {
  url: string;
  item: ZyteArticleListItem;
  // 1-based position in the page's article list.
  position: number;
}

/**
 * Extract a page's article list via Zyte, drop cross-domain and
 * duplicate articles, and fan each remaining article out into one
 * article-discoveries event per context. Returns those events and
 * the unique article URLs for the worker to enqueue for extraction.
 */
export async function handleArticleDiscovery(
  message: CrawlArticleDiscoveryMessage,
): Promise<DiscoveryResult> {
  const { data: items } = await time(
    'crawl.zyte.duration_ms',
    () => extractArticleList(message.url, { extractFrom: 'httpResponseBody' }),
    { extraction: 'articleList' },
  );

  const crawledAt = new Date().toISOString();
  const articles = selectArticles(items, message.url);

  const events = articles.flatMap((article) =>
    message.contexts.map((context) =>
      mapToDiscoveryEvent(article, message.url, context, crawledAt),
    ),
  );

  return { events, articleUrls: articles.map((a) => a.url) };
}

/**
 * Keep only same-domain articles that have a URL, deduplicated by
 * URL (first occurrence wins), preserving each article's 1-based
 * position in the original list. Cross-domain links (a different
 * registrable domain than the page) are off-publisher and dropped;
 * the page domain is resolved once and reused across the list.
 */
function selectArticles(
  items: ZyteArticleListItem[],
  pageUrl: string,
): SelectedArticle[] {
  const pageDomain = getRegistrableDomain(pageUrl);
  const seen = new Set<string>();
  const selected: SelectedArticle[] = [];
  items.forEach((item, i) => {
    const url = item.url;
    if (!url || seen.has(url)) return;
    if (pageDomain === undefined || getRegistrableDomain(url) !== pageDomain) {
      return;
    }
    seen.add(url);
    selected.push({ url, item, position: i + 1 });
  });
  return selected;
}

/** Map a discovered article and context to the discovery event schema. */
function mapToDiscoveryEvent(
  article: SelectedArticle,
  sourceUrl: string,
  context: DiscoveryContext,
  crawledAt: string,
): ArticleDiscoveryEvent {
  const { item } = article;
  return {
    url: article.url,
    source_url: sourceUrl,
    crawled_at: crawledAt,
    published_at: toEventTimestamp(item.datePublished),
    headline: item.headline ?? undefined,
    authors: toEventAuthors(item.authors),
    summary: item.description ?? undefined,
    language: item.inLanguage ?? undefined,
    topic: context.topic,
    page_position: article.position,
    surface_id: context.surface_id,
  };
}
