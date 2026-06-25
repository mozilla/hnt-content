import { getDomain } from 'tldts';

/**
 * Return the registrable domain (eTLD+1) of a URL, or undefined if
 * one cannot be determined (e.g. an unparseable URL or an IP). The
 * Public Suffix List backs this so multi-part suffixes like .co.uk
 * resolve correctly, which matters for non-US publishers.
 * allowPrivateDomains treats platform suffixes (e.g. blogspot.com)
 * as the boundary, so two publishers on one platform are distinct.
 */
export function getRegistrableDomain(url: string): string | undefined {
  return getDomain(url, { allowPrivateDomains: true }) ?? undefined;
}
