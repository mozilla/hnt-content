import { getRegistrableDomain } from 'crawl-common';
import {
  NO_JS_ARTICLE_DOMAINS,
  NO_JS_ARTICLE_LIST_DOMAINS,
} from './no-js-domains.js';

/** Which Zyte extraction product a request targets. */
export type ZyteProduct = 'article' | 'articleList';

// Build the lookup sets once at module load for O(1) per-request checks.
const NO_JS_DOMAINS: Record<ZyteProduct, ReadonlySet<string>> = {
  article: new Set(NO_JS_ARTICLE_DOMAINS),
  articleList: new Set(NO_JS_ARTICLE_LIST_DOMAINS),
};

/**
 * Choose the Zyte extraction source for a URL and product. Domains the
 * legacy quality gates cleared use the cheaper httpResponseBody; every
 * other domain uses browserHtml so a JavaScript-heavy publisher still
 * yields a full article. Matches on the registrable domain, so
 * subdomains collapse to the same decision; an unparseable URL falls
 * back to browserHtml.
 */
export function resolveExtractFrom(
  url: string,
  product: ZyteProduct,
): 'httpResponseBody' | 'browserHtml' {
  const domain = getRegistrableDomain(url);

  return domain && NO_JS_DOMAINS[product].has(domain)
    ? 'httpResponseBody'
    : 'browserHtml';
}
