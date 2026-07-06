import { describe, expect, it } from 'vitest';
import { resolveExtractFrom } from './zyte-extraction-mode.js';
import {
  CHEAP_ARTICLE_DOMAINS,
  CHEAP_ARTICLE_LIST_DOMAINS,
} from './zyte-cheap-domains.js';

describe('resolveExtractFrom', () => {
  it('uses httpResponseBody for a cheap-listed domain, per product', () => {
    expect(
      resolveExtractFrom(`https://${CHEAP_ARTICLE_DOMAINS[0]}/a/b`, 'article'),
    ).toBe('httpResponseBody');
    expect(
      resolveExtractFrom(
        `https://${CHEAP_ARTICLE_LIST_DOMAINS[0]}/section`,
        'articleList',
      ),
    ).toBe('httpResponseBody');
  });

  it('defaults to browserHtml for an unlisted domain', () => {
    expect(
      resolveExtractFrom('https://unlisted-publisher.example/story', 'article'),
    ).toBe('browserHtml');
    expect(
      resolveExtractFrom(
        'https://unlisted-publisher.example/news',
        'articleList',
      ),
    ).toBe('browserHtml');
  });

  it('decides per product: a domain cleared for one product is not the other', () => {
    const articleOnly = CHEAP_ARTICLE_DOMAINS.find(
      (d) => !CHEAP_ARTICLE_LIST_DOMAINS.includes(d),
    );
    expect(articleOnly).toBeDefined();
    expect(resolveExtractFrom(`https://${articleOnly}/x`, 'article')).toBe(
      'httpResponseBody',
    );
    expect(resolveExtractFrom(`https://${articleOnly}/x`, 'articleList')).toBe(
      'browserHtml',
    );
  });

  it('matches on the registrable domain, so subdomains collapse', () => {
    expect(
      resolveExtractFrom(
        `https://www.${CHEAP_ARTICLE_DOMAINS[0]}/a`,
        'article',
      ),
    ).toBe('httpResponseBody');
  });

  it('always uses httpResponseBody for theguardian.com (clears its 451)', () => {
    expect(
      resolveExtractFrom(
        'https://www.theguardian.com/world/article',
        'article',
      ),
    ).toBe('httpResponseBody');
    expect(
      resolveExtractFrom('https://www.theguardian.com/world', 'articleList'),
    ).toBe('httpResponseBody');
  });

  it('falls back to browserHtml for an unparseable URL', () => {
    expect(resolveExtractFrom('not a url', 'article')).toBe('browserHtml');
  });
});
