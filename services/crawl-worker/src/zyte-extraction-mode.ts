import { getRegistrableDomain } from 'crawl-common';
import {
  CHEAP_ARTICLE_DOMAINS,
  CHEAP_ARTICLE_LIST_DOMAINS,
} from './zyte-cheap-domains.js';

/** Which Zyte extraction product a request targets. */
export type ZyteProduct = 'article' | 'articleList';

type ExtractFrom = 'httpResponseBody' | 'browserHtml';

// Build the lookup sets once at module load for O(1) per-request checks.
const CHEAP_DOMAINS: Record<ZyteProduct, ReadonlySet<string>> = {
  article: new Set(CHEAP_ARTICLE_DOMAINS),
  articleList: new Set(CHEAP_ARTICLE_LIST_DOMAINS),
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
): ExtractFrom {
  const domain = getRegistrableDomain(url);
  return domain && CHEAP_DOMAINS[product].has(domain)
    ? 'httpResponseBody'
    : 'browserHtml';
}
