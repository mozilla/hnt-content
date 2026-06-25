import { createHash } from 'node:crypto';

/**
 * Hash a URL into the stable token used in Redis keys. The URL is
 * trimmed first so that incidental surrounding whitespace cannot
 * produce two keys for the same article; this is the normalization
 * deferred from the message-validation boundary, kept here so the
 * single place that derives keys also owns it. SHA-256 keeps keys a
 * fixed length regardless of URL length.
 */
export function hashUrl(url: string): string {
  return createHash('sha256').update(url.trim()).digest('hex');
}

/** Last time a page was fetched (crawled) by the discovery worker. */
export function pageFetchKey(url: string): string {
  return `page:fetch:${hashUrl(url)}`;
}

/** Guard against concurrent fetches of the same page. */
export function pageLockKey(url: string): string {
  return `page:lock:${hashUrl(url)}`;
}

/** Last time the agent enqueued a discovery job for a page. */
export function pageEnqueuedKey(url: string): string {
  return `page:enqueued:${hashUrl(url)}`;
}

/** Last time an article was fetched (extracted) by the article worker. */
export function articleFetchKey(url: string): string {
  return `article:fetch:${hashUrl(url)}`;
}

/** Guard against concurrent fetches of the same article. */
export function articleLockKey(url: string): string {
  return `article:lock:${hashUrl(url)}`;
}

/** Content hash of an article, for change detection across crawls. */
export function articleContentKey(url: string): string {
  return `article:content:${hashUrl(url)}`;
}
