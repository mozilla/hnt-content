/**
 * Normalize text for comparison only (not for storage).
 * Detects meaningful changes between Zyte-extracted and
 * Corpus API-stored metadata while ignoring cosmetic
 * differences in case, whitespace, and quote style.
 *
 * The Corpus API stores title/excerpt as-is with no
 * normalization. Steps ported from the existing Python
 * crawler in content-ml-services diff.py:normalize_text().
 */
export function normalizeText(
  text: string | null | undefined,
  maxLength?: number,
): string {
  if (text == null) return '';

  // Unicode NFC canonical composition.
  let result = text.normalize('NFC');

  result = result.trim();

  if (maxLength != null) {
    result = result.slice(0, maxLength);
  }

  // Strip trailing periods (inconsistent between sources).
  result = result.replace(/\.+$/, '');

  // Collapse whitespace to a single space.
  result = result.replace(/\s+/g, ' ');

  result = result.toLowerCase();

  // Normalize smart quotes to straight quotes.
  result = result
    .replaceAll('\u2018', "'")
    .replaceAll('\u2019', "'")
    .replaceAll('\u201c', '"')
    .replaceAll('\u201d', '"');

  return result;
}
