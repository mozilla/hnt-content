import { readFile } from 'node:fs/promises';
import {
  getScheduledSectionItems,
  validateLiveArticle,
  validatePublisherList,
  type LiveArticle,
  type PublisherList,
} from 'crawl-common';
import config from './config.js';

/**
 * Load and validate the publisher list from a JSON file. Throws if
 * the file is missing, not valid JSON, or fails validation, so the
 * agent fails fast at startup on a bad config rather than enqueuing
 * malformed jobs. pages always come from this file; live_articles come
 * from here only when the Corpus API source is disabled.
 */
export async function loadPublisherList(path: string): Promise<PublisherList> {
  const contents = await readFile(path, 'utf8');
  const list = validatePublisherList(JSON.parse(contents));
  return limitPages(list, config.publisherPageLimit);
}

/**
 * Sample the pages down to the configured limit with an even stride, so
 * a dev deployment can run a representative subset at lower load without
 * collapsing to one corner of the alphabetically sorted list. Returns
 * the list unchanged when no limit is set or it already fits.
 */
export function limitPages(list: PublisherList, limit: number): PublisherList {
  if (limit <= 0 || list.pages.length <= limit) return list;
  const stride = Math.ceil(list.pages.length / limit);
  const pages = list.pages.filter((_, i) => i % stride === 0).slice(0, limit);
  return { ...list, pages };
}

/** Whether the agent sources live articles from the Corpus API. */
export function corpusSourceEnabled(): boolean {
  return config.corpusApi.jwkJson !== '';
}

/**
 * Fetch live articles from the Corpus API for every configured surface
 * (the currently scheduled section items), de-duplicated by URL across
 * surfaces since one article can be scheduled on more than one surface.
 * Validates each item on its own and skips the malformed ones. Unlike
 * the static file, the Corpus API is external input that can carry a
 * blank required field (e.g. a curated item with no publisher), so a
 * single bad item degrades freshness for that item rather than crash
 * looping the whole agent. Client and transport errors still propagate
 * so a misconfigured or unreachable Corpus aborts startup.
 */
export async function fetchLiveArticles(): Promise<LiveArticle[]> {
  const seen = new Set<string>();
  const liveArticles: LiveArticle[] = [];
  let skipped = 0;
  // Fetch every surface concurrently; Promise.all preserves order so the
  // cross-surface dedup below still keeps the first occurrence of a URL.
  const perSurface = await Promise.all(
    config.scheduledSurfaceGuids.map((guid) => getScheduledSectionItems(guid)),
  );
  for (const article of perSurface.flat()) {
    if (seen.has(article.url)) continue;
    seen.add(article.url);
    try {
      liveArticles.push(validateLiveArticle(article));
    } catch (err) {
      skipped++;
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`Skipping live article ${article.url}: ${reason}`);
    }
  }
  if (skipped > 0) {
    console.warn(
      `Skipped ${skipped} malformed live articles from the Corpus API`,
    );
  }
  return liveArticles;
}
