import type { ZyteAuthor } from 'crawl-common';

/**
 * Map Zyte authors to the BigQuery event author shape, dropping any
 * without a non-empty name. The authors.name subfield is REQUIRED in
 * BigQuery, so an author Zyte returns with only nameRaw (name absent)
 * would serialize to an empty struct and fail the BigQuery subscription
 * write, which has no dead-letter queue and would wedge the message.
 * Returns undefined when the source is absent so the field is omitted.
 */
export function toEventAuthors(
  authors: ZyteAuthor[] | undefined,
): { name: string }[] | undefined {
  if (!authors) return undefined;
  return authors
    .filter((a) => typeof a.name === 'string' && a.name.trim() !== '')
    .map((a) => ({ name: a.name }));
}

/**
 * Pass a Zyte timestamp through only when it is a non-empty, parseable
 * date string. Zyte normally returns ISO-8601 in datePublished, but an
 * empty or malformed value would fail the BigQuery TIMESTAMP parse and,
 * with no dead-letter queue, wedge the message. Returns undefined
 * otherwise so the nullable column is simply left unset.
 */
export function toEventTimestamp(
  value: string | undefined,
): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  return Number.isNaN(Date.parse(value)) ? undefined : value;
}
