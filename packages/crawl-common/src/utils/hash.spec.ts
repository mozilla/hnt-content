import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { urlHash } from './hash.js';

describe('urlHash', () => {
  it('returns a 64-character hex string', () => {
    const hash = urlHash('https://example.com');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    const url = 'https://example.com/article';
    expect(urlHash(url)).toBe(urlHash(url));
  });

  it('matches node:crypto SHA-256 directly', () => {
    const url = 'https://example.com/article';
    const expected = createHash('sha256').update(url).digest('hex');
    expect(urlHash(url)).toBe(expected);
  });

  it('produces different hashes for different URLs', () => {
    expect(urlHash('https://a.com')).not.toBe(urlHash('https://b.com'));
  });
});
