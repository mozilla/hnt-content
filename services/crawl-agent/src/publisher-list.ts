import { readFile } from 'node:fs/promises';
import { validatePublisherList, type PublisherList } from 'crawl-common';

/**
 * Load and validate the publisher list from a JSON file. Throws if
 * the file is missing, not valid JSON, or fails validation, so the
 * agent fails fast at startup on a bad config rather than enqueuing
 * malformed jobs. Phase 5 replaces this with the Corpus API.
 */
export async function loadPublisherList(path: string): Promise<PublisherList> {
  const contents = await readFile(path, 'utf8');
  return validatePublisherList(JSON.parse(contents));
}
