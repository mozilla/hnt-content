import { createHash } from 'node:crypto';

/**
 * Hash a URL into the stable token used in Redis keys. Trimming
 * first keeps incidental surrounding whitespace from producing two
 * keys for the same URL, and SHA-256 keeps keys a fixed length
 * however long the URL is.
 */
export function hashUrl(url: string): string {
  return createHash('sha256').update(url.trim()).digest('hex');
}

// Each builder below returns one key name, and its doc block
// describes the value stored there. The `redis-state` package owns
// the reads, writes, and TTLs.

/** Return the key for a page's last fetch by the discovery worker. */
export function pageFetchKey(url: string): string {
  return `page:fetch:${hashUrl(url)}`;
}

/** Return the key for the lock held while a page is fetched. */
export function pageLockKey(url: string): string {
  return `page:lock:${hashUrl(url)}`;
}

/** Return the key for a page's last enqueue by the scheduler. */
export function pageEnqueuedKey(url: string): string {
  return `page:enqueued:${hashUrl(url)}`;
}

/** Return the key for an article's last enqueue for extraction. */
export function articleEnqueuedKey(url: string): string {
  return `article:enqueued:${hashUrl(url)}`;
}

/** Return the key for an article's last fetch by the article worker. */
export function articleFetchKey(url: string): string {
  return `article:fetch:${hashUrl(url)}`;
}

/** Return the key for the lock held while an article is fetched. */
export function articleLockKey(url: string): string {
  return `article:lock:${hashUrl(url)}`;
}

/**
 * Return the key for an article's content hash, which lets the
 * article worker skip publishing unchanged content.
 */
export function articleContentKey(url: string): string {
  return `article:content:${hashUrl(url)}`;
}
