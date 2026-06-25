import { readFile } from 'node:fs/promises';
import {
  getScheduledSectionItems,
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
  return validatePublisherList(JSON.parse(contents));
}

/** Whether the agent sources live articles from the Corpus API. */
export function corpusSourceEnabled(): boolean {
  return config.corpusApi.jwkJson !== '';
}

/**
 * Fetch live articles from the Corpus API for every configured surface
 * (the currently scheduled section items), de-duplicated by URL across
 * surfaces since one article can be scheduled on more than one surface.
 * Validates each corpus item and the live-URL uniqueness the same way
 * the file path does, failing fast on a malformed item.
 */
export async function fetchLiveArticles(): Promise<LiveArticle[]> {
  const seen = new Set<string>();
  const liveArticles: LiveArticle[] = [];
  for (const guid of config.scheduledSurfaceGuids) {
    for (const article of await getScheduledSectionItems(guid)) {
      if (seen.has(article.url)) continue;
      seen.add(article.url);
      liveArticles.push(article);
    }
  }
  return validatePublisherList({ pages: [], live_articles: liveArticles })
    .live_articles;
}
