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
 * Extract a page's article list via Zyte, drop off-publisher and
 * duplicate articles, and fan each remaining article out into one
 * article-discoveries event per context. Returns those events and
 * the unique article URLs for the worker to enqueue for extraction.
 */
export async function handleArticleDiscovery(
  message: CrawlArticleDiscoveryMessage,
): Promise<DiscoveryResult> {
  // items are the articles returned from zyte's parsing.
  // resolvedUrl is the url zyte actually scraped - which, due to redirects
  // on the publisher side, may differ from the url contained in the message.
  const { data: items, url: resolvedUrl } = await extractArticleList(
    message.url,
    {
      extractFrom: resolveExtractFrom(message.url, 'articleList'),
    },
  );

  const crawledAt = new Date().toISOString();

  // A publisher that redirects to a new domain still serves its own
  // articles, so the post-redirect URL counts as the publisher too.
  const articles = selectArticles(items, [message.url, resolvedUrl]);

  if (articles.length === 0) {
    console.warn(
      `discovery: no articles selected for ${message.url} ` +
        `(final url ${resolvedUrl}, ${items.length} raw items)`,
    );
  }

  // if articles is empty, this will just give an empty array
  const events = articles.flatMap((article) =>
    message.contexts.map((context) =>
      mapToDiscoveryEvent(article, message.url, context, crawledAt),
    ),
  );

  return { events, articleUrls: articles.map((a) => a.url) };
}

/**
 * Keep the publisher's own articles, deduplicated by URL (first
 * occurrence wins) and tagged with their 1-based position in the
 * original list. An article belongs to the publisher when its
 * registrable domain matches one of the given page URLs, or when its
 * URL yields no domain at all. Logs a summary of what it dropped.
 */
export function selectArticles(
  items: ZyteArticleListItem[],
  pageUrls: string[],
): SelectedArticle[] {
  const pageDomains = new Set(
    pageUrls.flatMap((url) => getRegistrableDomain(url) ?? []),
  );

  if (pageDomains.size === 0) {
    console.warn(
      `discovery: no registrable domain for ${pageUrls.join(', ')}; ` +
        'keeping no articles',
    );

    return [];
  }

  // the articles that pass selection criteria wil be returned
  const selected: SelectedArticle[] = [];
  // convenience set to de-deplicate URLs in the loop below
  const seenUrls = new Set<string>();
  // keep track of how many articles were dropped per non-allowed domain
  const droppedPerDomain = new Map<string, number>();

  for (let i = 0; i < items.length; i++) {
    const url = items[i].url;

    if (!url || seenUrls.has(url)) {
      continue;
    }

    // An unparseable URL keeps its article: Zyte still resolved it, and
    // dropping it loses a story the publisher may well have written.
    const domain = getRegistrableDomain(url);

    // if the article has no domain or it's domain is not in the set of
    // allowed domains, log the failure and skip.
    if (domain !== undefined && !pageDomains.has(domain)) {
      droppedPerDomain.set(domain, (droppedPerDomain.get(domain) ?? 0) + 1);

      continue;
    }

    seenUrls.add(url);

    selected.push({ url, item: items[i], position: i + 1 });
  }

  if (droppedPerDomain.size > 0) {
    const counts = [...droppedPerDomain];
    const total = counts.reduce((sum, [, count]) => sum + count, 0);
    const summary = counts.map(([domain, count]) => `${domain}=${count}`);

    console.warn(
      `discovery: dropped ${total} off-publisher articles for ` +
        `${pageUrls[0]}: ${summary.join(', ')}`,
    );
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
