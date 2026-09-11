import {
  ArticleDiscoveryEvent,
  CrawlArticleDiscoveryMessage,
  DiscoveryContext,
  getRegistrableDomain,
} from 'crawl-common';
import { extractArticleList, ZyteArticleListItem } from 'zyte';
import { toEventAuthors, toEventTimestamp } from './event-fields.js';
import { resolveExtractFrom } from '../zyte-extraction/extraction-mode.js';

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
  const { data: items } = await extractArticleList(message.url, {
    extractFrom: resolveExtractFrom(message.url, 'articleList'),
  });

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
export function selectArticles(
  items: ZyteArticleListItem[],
  pageUrl: string,
): SelectedArticle[] {
  // get the domain of the given page
  const pageDomain = getRegistrableDomain(pageUrl);

  // the articles in the list that we will enqueue to be crawled.
  const selected: SelectedArticle[] = [];

  // if pageDomain cannot be determined, we exit early, as we will not be able
  // to determine which articles in the list belong to the publisher.
  if (pageDomain === undefined) {
    // return an empty array
    return selected;
  }

  // create a set to store URLs already seen in the list (as the list may
  // have duplicates). this set is only used for de-duplication within
  // the list, and is a convenience instead of looking up an object by URL in
  // `selected`.
  const seen = new Set<string>();

  for (let i = 0; i < items.length; i++) {
    const url = items[i].url;

    // if there's no URL, or the URL was already found in this list, or the URL
    // points to a different publisher, move to the next iteration of the loop.
    if (!url || seen.has(url) || getRegistrableDomain(url) !== pageDomain) {
      continue;
    }

    seen.add(url);

    selected.push({ url, item: items[i], position: i + 1 });
  }

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
    authors: toEventAuthors(item.authors),
    crawled_at: crawledAt,
    headline: item.headline ?? undefined,
    language: item.inLanguage ?? undefined,
    page_position: article.position,
    published_at: toEventTimestamp(item.datePublished),
    source_url: sourceUrl,
    // The list-page description (dek), not articleBody: Zyte's articleList
    // product reliably returns description but rarely a full body, so it
    // is the better summary source for discovery rows.
    summary: item.description ?? undefined,
    surface_id: context.surface_id,
    topic: context.topic,
    url: article.url,
  };
}
