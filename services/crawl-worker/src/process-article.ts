import { createHash } from 'node:crypto';
import {
  acquireLock,
  articleContentKey,
  articleFetchKey,
  articleLockKey,
  getString,
  publishMessage,
  releaseLock,
  setString,
  setTimestamp,
  type ArticleEvent,
  type CrawlArticleMessage,
} from 'crawl-common';
import config from './config.js';
import { handleArticleExtraction } from './handlers/extract-article.js';
import { withinMinutes } from './recency.js';

/**
 * Extract an article and publish it, guarded by Redis so the same
 * article is not fetched or published redundantly:
 * - Discovered articles skip extraction if fetched recently. Live
 *   articles bypass that check so they resync on the agent's cadence.
 * - A per-article lock prevents two workers fetching the same URL at
 *   once; a held lock means another worker has it, so we skip.
 * - The article is published only when its content changed since the
 *   last fetch. The Corpus sync for live articles runs inside the
 *   handler regardless, so curated metadata stays in sync even when
 *   the body is unchanged.
 *
 * Skips ack the message (the work is done or owned elsewhere); only a
 * thrown error nacks for redelivery.
 */
export async function processArticle(
  message: CrawlArticleMessage,
): Promise<void> {
  const { url } = message;
  const fetchKey = articleFetchKey(url);
  const isLive = message.corpus_item != null;
  if (
    !isLive &&
    (await withinMinutes(fetchKey, config.articleFetchTtlMinutes))
  ) {
    return;
  }

  const lockKey = articleLockKey(url);
  const token = await acquireLock(lockKey, config.lockTtlSeconds);
  if (token === null) return;
  try {
    const event = await handleArticleExtraction(message);
    await publishIfChanged(url, event);
    await setTimestamp(fetchKey);
  } finally {
    await releaseLock(lockKey, token);
  }
}

/** Publish the event only if its content changed since the last fetch. */
async function publishIfChanged(
  url: string,
  event: ArticleEvent,
): Promise<void> {
  const key = articleContentKey(url);
  const hash = contentHash(event);
  const changed = (await getString(key)) !== hash;
  // Publish before storing the hash: if the store then fails, the
  // message redelivers and republishes rather than dropping the event
  // (at-least-once prefers a duplicate over a lost event).
  if (changed) await publishMessage<ArticleEvent>(config.articlesTopic, event);
  // Refresh the content key every fetch so its TTL tracks the fetch
  // marker; otherwise an unchanged article's key expires and the next
  // fetch republishes it.
  await setString(key, hash);
}

/**
 * Hash the content fields that define a meaningful change. url is
 * constant per key and extracted_at changes every fetch, so both are
 * excluded; otherwise the hash would never match and every fetch would
 * republish.
 */
function contentHash(event: ArticleEvent): string {
  const content = {
    headline: event.headline,
    description: event.description,
    authors: event.authors,
    main_image_url: event.main_image_url,
    body_truncated: event.body_truncated,
    published_at: event.published_at,
    breadcrumbs: event.breadcrumbs,
    language: event.language,
  };
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}
