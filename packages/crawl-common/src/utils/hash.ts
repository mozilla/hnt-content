import { createHash } from 'node:crypto';

/** Return the SHA-256 hex digest of a URL. */
export function urlHash(url: string): string {
  return createHash('sha256').update(url).digest('hex');
}
