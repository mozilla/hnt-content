import { describe, expect, it } from 'vitest';
import {
  buildRedisArticleContentKey,
  buildRedisArticleEnqueuedKey,
  buildRedisArticleExtractedKey,
  buildRedisArticleLockKey,
  hashUrl,
  buildRedisPageEnqueuedKey,
  buildRedisPageFetchKey,
  buildRedisPageLockKey,
} from './keys.js';

const URL = 'https://example.com/news/article-1';

describe('hashUrl', () => {
  it('produces a 64-char hex SHA-256 digest', () => {
    expect(hashUrl(URL)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable for the same URL', () => {
    expect(hashUrl(URL)).toBe(hashUrl(URL));
  });

  it('ignores surrounding whitespace', () => {
    expect(hashUrl(`  ${URL}\n`)).toBe(hashUrl(URL));
  });

  it('differs for different URLs', () => {
    expect(hashUrl(URL)).not.toBe(hashUrl(`${URL}-2`));
  });
});

describe('key builders', () => {
  const hash = hashUrl(URL);

  it.each([
    [buildRedisPageFetchKey, 'page:fetch'],
    [buildRedisPageLockKey, 'page:lock'],
    [buildRedisPageEnqueuedKey, 'page:enqueued'],
    [buildRedisArticleEnqueuedKey, 'article:enqueued'],
    [buildRedisArticleExtractedKey, 'article:extracted'],
    [buildRedisArticleLockKey, 'article:lock'],
    [buildRedisArticleContentKey, 'article:content'],
  ])('%o builds the %s namespace', (build, prefix) => {
    expect(build(URL)).toBe(`${prefix}:${hash}`);
  });
});
