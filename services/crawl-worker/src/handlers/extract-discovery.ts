import {
  ArticleDiscoveryEvent,
  CrawlArticleDiscoveryMessage,
  DiscoveryContext,
  getRegistrableDomain,
} from 'crawl-common';
import { extractArticleList, ZyteArticleListItem } from 'zyte';
import { toEventAuthors, toEventTimestamp } from './event-fields.js';
import { resolveExtractFrom } from '../zyte-extraction/extraction-mode.js';
import { timeZyteCall } from '../zyte-extraction/timed-call.js';

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
  // NOTE - we are implicitly trusting a publisher domain's behavior here.
  const { data: items, url: resolvedUrl } = await timeZyteCall(
    'article_list',
    () =>
      extractArticleList(message.url, {
        extractFrom: resolveExtractFrom(message.url, 'articleList'),
      }),
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
 * registrable domain matches one of the given pageUrls. Logs a
 * summary of dropped articles grouped by domain.
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

  // the articles that pass selection criteria will be returned
  const selected: SelectedArticle[] = [];
  // convenience set to de-duplicate URLs in the loop below
  const seenUrls = new Set<string>();
  // keep track of how many articles were dropped per non-allowed domain
  const droppedPerDomain = new Map<string, number>();

  for (let i = 0; i < items.length; i++) {
    const rawUrl = items[i].url;

    if (!rawUrl) {
      continue;
    }

    const url = normalizeArticleUrl(rawUrl);

    if (seenUrls.has(url)) {
      continue;
    }

    // track that we've seen the URL so we don't process it again
    seenUrls.add(url);

    // domain will either be a string or, in the case of an unparseable url
    // (e.g. an IP address, inline javascript, anchor link), undefined.
    const domain = getRegistrableDomain(url);

    // if the domain is undefined or not in the set of allowed domains, log
    // the failure for reporting.
    if (domain === undefined || !pageDomains.has(domain)) {
      const key = domain ?? '(unparseable)';

      droppedPerDomain.set(key, (droppedPerDomain.get(key) ?? 0) + 1);

      continue;
    }

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

/** Query parameters that only track where a link was clicked. */
const TRACKING_PARAMS = new Set([
  'bitPosition', // ilpost.it
  'homepagePosition', // ilpost.it
  'intcmp',
  'referrerPost', // ilpost.it
  'srnd', // bloomberg.com
]);

/**
 * Drop the #fragment and tracking query parameters from an article URL.
 * Some publishers (e.g. gazeta.pl) add a fragment that changes on every
 * page load, and others (e.g. ilpost.it) tag a link with its position
 * on the page, so each variant would otherwise be extracted again.
 */
export function normalizeArticleUrl(url: string): string {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  // The fragment is never sent to the server, so it can't change the page.
  parsed.hash = '';

  // Delete query parameters starting with utm_ or in TRACKING_PARAMS.
  [...parsed.searchParams.keys()]
    .filter((name) => TRACKING_PARAMS.has(name) || name.startsWith('utm_'))
    .forEach((name) => parsed.searchParams.delete(name));

  return parsed.href;
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
