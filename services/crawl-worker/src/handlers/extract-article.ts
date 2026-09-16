import {
  ArticleEvent,
  CorpusItem,
  CrawlArticleMessage,
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
 * article's title or excerpt has changed.
 */
export async function handleArticleExtraction(
  message: CrawlArticleMessage,
): Promise<ArticleEvent> {
  const { data: article, url } = await extractArticle(message.url, {
    extractFrom: resolveExtractFrom(message.url, 'article'),
  });

  const event = mapToArticleEvent(article, url);

  if (message.corpus_item) {
    await detectAndSyncChanges(article, message.corpus_item);
  }

  return event;
}

/** Map a Zyte article response to the BigQuery event schema. */
function mapToArticleEvent(article: ZyteArticle, url: string): ArticleEvent {
  return {
    url,
    // Zyte's own download time is when the page was really fetched,
    // which is what the column means; falling back to now only when
    // Zyte returns an empty or unparseable value.
    extracted_at:
      toEventTimestamp(article.metadata.dateDownloaded) ??
      new Date().toISOString(),
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

  const input = buildUpdateInput(article, corpusItem, {
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
  article: ZyteArticle,
  corpusItem: CorpusItem,
  changed: { title?: string; excerpt?: string },
): UpdateApprovedCorpusItemInput {
  // Prefer the extracted authors, minus the ones Zyte returns without a
  // name: the mutation overwrites the byline, so a blank name would
  // replace a curator's. Fall back to the corpus item when none remain.
  const extracted = toEventAuthors(article.authors) ?? [];
  const authors = extracted.length > 0 ? extracted : corpusItem.authors;

  return {
    externalId: corpusItem.external_id,
    title: changed.title?.trim() ?? corpusItem.title,
    excerpt: changed.excerpt?.trim() ?? corpusItem.excerpt,
    authors: authors.map((a, i) => ({ name: a.name, sortOrder: i })),
    status: corpusItem.status,
    language: corpusItem.language,
    publisher: corpusItem.publisher,
    imageUrl: corpusItem.image_url,
    topic: corpusItem.topic,
    isTimeSensitive: corpusItem.is_time_sensitive,
  };
}
