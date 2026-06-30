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
import type { HandlerResult } from './message-metrics.js';
import { withinMinutes } from './recency.js';

/**
 * Extract an article and publish it, guarded by Redis so the same
 * article is not fetched or published redundantly:
 * - Skip extraction if the article was fetched within its refresh
 *   window. Live articles carry their own interval on the message and
 *   so dedup on the agent's cadence; discovered articles use the
 *   default fetch TTL.
 * - A per-article lock prevents two workers fetching the same URL at
 *   once; a held lock means another worker has it, so we skip.
 * - The fetch marker is written as a claim, before the Zyte call and
 *   publish, so a partial failure (failed publish, ack-deadline expiry,
 *   crash mid-handler) redelivers into a skip instead of re-paying for
 *   Zyte and re-publishing. A publish failure still nacks, but the
 *   redelivery now skips: that interval's update is dropped and
 *   self-heals on the next crawl, the accepted 99.9% tradeoff.
 * - The article is published only when its content changed since the
 *   last fetch. The Corpus sync for live articles runs inside the
 *   handler, so curated metadata stays in sync whenever the article is
 *   actually fetched.
 *
 * Skips ack the message (the work is done or owned elsewhere); only a
 * thrown error nacks for redelivery.
 */
export async function processArticle(
  message: CrawlArticleMessage,
): Promise<HandlerResult> {
  const { url } = message;
  const fetchKey = articleFetchKey(url);
  const intervalMinutes =
    message.refresh_interval_minutes ?? config.articleFetchTtlMinutes;
  if (await withinMinutes(fetchKey, intervalMinutes)) {
    return { outcome: 'skipped', reason: 'recent' };
  }

  const lockKey = articleLockKey(url);
  const token = await acquireLock(lockKey, config.lockTtlSeconds);
  if (token === null) return { outcome: 'skipped', reason: 'lock_busy' };
  try {
    // Re-check article:fetch inside the lock. Concurrent duplicate jobs all
    // pass the pre-lock freshness check, then serialize through the lock;
    // without re-reading the marker here each would re-extract. The first
    // claims article:fetch, so the rest skip.
    if (await withinMinutes(fetchKey, intervalMinutes)) {
      return { outcome: 'skipped', reason: 'recent' };
    }
    // Claim the interval before the Zyte call and publish so a partial
    // failure redelivers into a skip (see the doc block).
    await setTimestamp(fetchKey);
    const event = await handleArticleExtraction(message);
    await publishIfChanged(url, event);
    return { outcome: 'processed' };
  } finally {
    // Best-effort: the lock self-expires on its TTL, so a release
    // failure must not propagate out of finally and mask the handler's
    // outcome, which would nack a successful message and redeliver it.
    await releaseLock(lockKey, token).catch((err) =>
      console.error('failed to release lock', lockKey, err),
    );
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
