import { getRegistrableDomain, type ExtractionOptions } from 'crawl-common';

/**
 * Mozilla's New Tab crawler User-Agent. Some publishers allow our
 * crawler by this exact string, so it must be sent byte for byte.
 * Carried over from the legacy crawler (ml-services zyte_config.py).
 */
const FIREFOX_CRAWLER_USER_AGENT =
  'Mozilla/5.0 (compatible; FirefoxNewTabCrawler/1.0; ' +
  '+https://support.mozilla.org/en-US/kb/about-new-tab-page; ' +
  'contact=publishers@mozilla.com; via=Zyte)';

/**
 * Registrable domains that serve our crawler only when it presents the
 * Mozilla crawler User-Agent. theguardian.com returns HTTP 451 (legal
 * block) without it. Extend as more publishers allowlist us by UA.
 */
const CUSTOM_USER_AGENT_DOMAINS = new Set(['theguardian.com']);

/**
 * Build the Zyte extraction options for a crawl URL. Both crawl paths
 * extract from the raw HTTP response body, which is also the only mode
 * where a custom User-Agent applies: Zyte honors customHttpRequestHeaders
 * (paired with Zyte-Override-Headers) for HTTP fetches, not browser
 * rendering. For allowlisted domains we send Mozilla's crawler
 * User-Agent so their UA allowlist lets the request through.
 */
export function zyteOptionsForUrl(url: string): ExtractionOptions {
  const options: ExtractionOptions = { extractFrom: 'httpResponseBody' };
  if (CUSTOM_USER_AGENT_DOMAINS.has(getRegistrableDomain(url) ?? '')) {
    options.customHttpRequestHeaders = [
      { name: 'User-Agent', value: FIREFOX_CRAWLER_USER_AGENT },
      { name: 'Zyte-Override-Headers', value: 'User-Agent' },
    ];
  }
  return options;
}
