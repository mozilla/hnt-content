import { describe, expect, it } from 'vitest';
import { zyteOptionsForUrl } from './zyte-request-options.js';

const GUARDIAN_UA =
  'Mozilla/5.0 (compatible; FirefoxNewTabCrawler/1.0; ' +
  '+https://support.mozilla.org/en-US/kb/about-new-tab-page; ' +
  'contact=publishers@mozilla.com; via=Zyte)';

describe('zyteOptionsForUrl', () => {
  it('always extracts from the raw HTTP response body', () => {
    expect(zyteOptionsForUrl('https://example.com/news').extractFrom).toBe(
      'httpResponseBody',
    );
    expect(
      zyteOptionsForUrl('https://www.theguardian.com/us/film').extractFrom,
    ).toBe('httpResponseBody');
  });

  it('sends the Mozilla crawler User-Agent for allowlisted domains', () => {
    const options = zyteOptionsForUrl('https://www.theguardian.com/us/film');
    expect(options.customHttpRequestHeaders).toEqual([
      { name: 'User-Agent', value: GUARDIAN_UA },
      { name: 'Zyte-Override-Headers', value: 'User-Agent' },
    ]);
  });

  it('matches the allowlist on registrable domain, ignoring subdomains', () => {
    // Bare apex and a deep subdomain both resolve to theguardian.com.
    for (const url of [
      'https://theguardian.com/uk/travel',
      'https://www.theguardian.com/uk',
      'https://amp.theguardian.com/world',
    ]) {
      expect(zyteOptionsForUrl(url).customHttpRequestHeaders).toBeDefined();
    }
  });

  it('sends no custom headers for non-allowlisted domains', () => {
    expect(
      zyteOptionsForUrl('https://www.nytimes.com/section/world')
        .customHttpRequestHeaders,
    ).toBeUndefined();
    // A lookalike that is not the registrable domain must not match.
    expect(
      zyteOptionsForUrl('https://theguardian.com.evil.example/x')
        .customHttpRequestHeaders,
    ).toBeUndefined();
  });

  it('sends no custom headers for an unparseable URL', () => {
    const options = zyteOptionsForUrl('not a url');
    expect(options.extractFrom).toBe('httpResponseBody');
    expect(options.customHttpRequestHeaders).toBeUndefined();
  });
});
