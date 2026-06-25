import { describe, expect, it } from 'vitest';
import { getRegistrableDomain } from './domain.js';

describe('getRegistrableDomain', () => {
  it.each([
    ['https://news.example.com/a', 'example.com'],
    ['https://example.com/b', 'example.com'],
    ['https://www.bbc.co.uk/news', 'bbc.co.uk'],
    ['https://sub.example.com.au/z', 'example.com.au'],
    // Platform suffixes count as the boundary, so two blogs on the
    // same platform resolve to distinct registrable domains.
    ['https://a.blogspot.com/post', 'a.blogspot.com'],
  ])('extracts the eTLD+1 of %s', (url, expected) => {
    expect(getRegistrableDomain(url)).toBe(expected);
  });

  it.each(['not a url', 'https://127.0.0.1/x', ''])(
    'returns undefined for %s',
    (url) => {
      expect(getRegistrableDomain(url)).toBeUndefined();
    },
  );
});
