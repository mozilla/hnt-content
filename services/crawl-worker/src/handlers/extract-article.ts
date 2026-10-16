import {
  ArticleEvent,
  CorpusItem,
  CrawlArticleMessage,
  getRegistrableDomain,
  normalizeText,
  updateApprovedCorpusItem,
  UpdateApprovedCorpusItemInput,
} from 'crawl-common';
import { extractArticle, ZyteArticle } from 'zyte';
import { toEventAuthors, toEventTimestamp } from './event-fields.js';

import { resolveExtractFrom } from '../zyte-extraction/extraction-mode.js';

const BODY_TRUNCATE_LENGTH = 2_000;
const EXCERPT_COMPARE_LENGTH = 255;

/**
 * Extract an article via Zyte, map it to the articles event
 * schema, and update the Curated Corpus API when a live
 * article's title or excerpt has changed. Returns undefined for
 * an article that could never be recommended, so only eligible
 * articles reach BigQuery.
 */
export async function handleArticleExtraction(
  message: CrawlArticleMessage,
): Promise<ArticleEvent | undefined> {
  const {
    data: article,
    url: resolvedUrl,
    statusCode,
  } = await extractArticle(message.url, {
    extractFrom: resolveExtractFrom(message.url, 'article'),
  });

  const canonicalUrl = toCanonicalUrl(
    article.canonicalUrl,
    message.url,
    resolvedUrl,
  );
  const event =
    statusCode === 200 && canonicalUrl
      ? mapToArticleEvent(article, message.url, canonicalUrl)
      : undefined;
  if (!event) {
    console.warn(
      `article: not publishing ineligible ${message.url} ` +
        `(status ${statusCode}, final url ${resolvedUrl}, ` +
        `canonical ${article.canonicalUrl ?? 'none'})`,
    );
  }

  if (message.corpus_item) {
    await detectAndSyncChanges(article, message.corpus_item);
  }

  return event;
}

/**
 * Map a Zyte article response to the BigQuery event schema. url is
 * the requested URL, so it joins to article_discoveries.url even
 * when the publisher redirects.
 */
function mapToArticleEvent(
  article: ZyteArticle,
  url: string,
  canonicalUrl: string,
): ArticleEvent {
  return {
    url,
    canonical_url: canonicalUrl,
    extracted_at: new Date().toISOString(),
    headline: article.headline ?? undefined,
    description: article.description ?? undefined,
    authors: toEventAuthors(article.authors),
    main_image_url: article.mainImage?.url ?? undefined,
    body_truncated: article.articleBody?.slice(0, BODY_TRUNCATE_LENGTH),
    published_at: toEventTimestamp(article.datePublished),
    breadcrumbs: article.breadcrumbs?.map((b) => ({
      name: b.name,
      url: b.url,
    })),
    language: article.inLanguage ?? undefined,
  };
}

/**
 * Return the URL to use as the article's identity, applying the
 * legacy crawler's cross-domain rules (HNT-1377).
 * @param declaredCanonicalUrl - Canonical URL the page declares, as
 *   extracted by Zyte.
 * @param requestedUrl - URL we asked Zyte to extract.
 * @param resolvedUrl - URL Zyte landed on after following redirects.
 * @returns undefined after a redirect to another domain, because the
 *   page is not the article we asked for; requestedUrl when the
 *   declared canonical is on another domain (e.g. syndication), so the
 *   article keeps its publisher; otherwise declaredCanonicalUrl.
 */
export function toCanonicalUrl(
  declaredCanonicalUrl: string | undefined,
  requestedUrl: string,
  resolvedUrl: string,
): string | undefined {
  const requestedDomain = getRegistrableDomain(requestedUrl);
  const resolvedDomain = getRegistrableDomain(resolvedUrl);
  if (requestedDomain && resolvedDomain && requestedDomain !== resolvedDomain) {
    return undefined;
  }
  if (!declaredCanonicalUrl) {
    return undefined;
  }
  const canonicalDomain = getRegistrableDomain(declaredCanonicalUrl);
  if (
    requestedDomain &&
    canonicalDomain &&
    requestedDomain !== canonicalDomain
  ) {
    return requestedUrl;
  }
  return declaredCanonicalUrl;
}

/**
 * Compare extracted metadata against the corpus item and
 * call the Corpus Admin API if title or excerpt changed.
 * Throws on API failure so Pub/Sub redelivers the message.
 */
async function detectAndSyncChanges(
  article: ZyteArticle,
  corpusItem: CorpusItem,
): Promise<void> {
  const extractedTitle = article.headline;
  const extractedExcerpt = article.description;

  if (!extractedTitle && !extractedExcerpt) {
    console.warn(
      'Empty title and excerpt from Zyte for live article ' +
        `${corpusItem.external_id}; skipping comparison`,
    );
    return;
  }

  const titleChanged =
    extractedTitle != null &&
    extractedTitle.trim() !== '' &&
    normalizeText(extractedTitle) !== normalizeText(corpusItem.title);

  const excerptChanged =
    extractedExcerpt != null &&
    extractedExcerpt.trim() !== '' &&
    normalizeText(extractedExcerpt, EXCERPT_COMPARE_LENGTH) !==
      normalizeText(corpusItem.excerpt, EXCERPT_COMPARE_LENGTH);

  if (!titleChanged && !excerptChanged) {
    return;
  }

  const changedFields = [
    ...(titleChanged ? ['title'] : []),
    ...(excerptChanged ? ['excerpt'] : []),
  ];
  console.log(
    `Detected changes in [${changedFields.join(', ')}] ` +
      `for corpus item ${corpusItem.external_id}`,
  );

  const input = buildUpdateInput(corpusItem, {
    title: titleChanged ? extractedTitle : undefined,
    excerpt: excerptChanged ? extractedExcerpt : undefined,
  });
  await updateApprovedCorpusItem(input);
}

/**
 * Build the GraphQL mutation input. Only overrides title or
 * excerpt when the corresponding field actually changed;
 * unchanged fields use the corpus item value to avoid
 * overwriting curator edits with cosmetic differences.
 */
function buildUpdateInput(
  corpusItem: CorpusItem,
  changed: { title?: string; excerpt?: string },
): UpdateApprovedCorpusItemInput {
  return {
    externalId: corpusItem.external_id,
    title: changed.title?.trim() ?? corpusItem.title,
    excerpt: changed.excerpt?.trim() ?? corpusItem.excerpt,
    // The mutation replaces the whole byline, and Zyte's authors are too
    // unreliable to overwrite what a curator entered.
    authors: corpusItem.authors.map((a, i) => ({
      name: a.name,
      sortOrder: i,
    })),
    status: corpusItem.status,
    language: corpusItem.language,
    publisher: corpusItem.publisher,
    imageUrl: corpusItem.image_url,
    topic: corpusItem.topic,
    isTimeSensitive: corpusItem.is_time_sensitive,
  };
}
