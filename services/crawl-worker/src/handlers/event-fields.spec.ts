import { describe, expect, it } from 'vitest';
import type { ZyteAuthor } from 'zyte';
import { toEventAuthors, toEventTimestamp } from './event-fields.js';

describe('toEventAuthors', () => {
  it('returns undefined when authors is absent', () => {
    expect(toEventAuthors(undefined)).toBeUndefined();
  });

  it('keeps authors with a non-empty name', () => {
    const authors: ZyteAuthor[] = [{ name: 'Jane Doe' }, { name: 'John Roe' }];
    expect(toEventAuthors(authors)).toEqual([
      { name: 'Jane Doe' },
      { name: 'John Roe' },
    ]);
  });

  it('drops authors missing a name (only nameRaw), which would violate the REQUIRED BigQuery subfield', () => {
    // Zyte can return an author with only nameRaw; name is undefined at
    // runtime despite the optimistic ZyteAuthor type.
    const authors = [
      { nameRaw: 'By Jane Doe' },
      { name: 'John Roe' },
      { name: '   ' },
      { name: '' },
    ] as ZyteAuthor[];
    expect(toEventAuthors(authors)).toEqual([{ name: 'John Roe' }]);
  });

  it('returns an empty array when every author is nameless', () => {
    const authors = [{ nameRaw: 'x' }] as ZyteAuthor[];
    expect(toEventAuthors(authors)).toEqual([]);
  });
});

describe('toEventTimestamp', () => {
  it('passes a valid ISO-8601 timestamp through', () => {
    expect(toEventTimestamp('2026-01-06T12:00:00Z')).toBe(
      '2026-01-06T12:00:00Z',
    );
  });

  it.each(['', '   ', undefined, 'not-a-date'])(
    'returns undefined for an empty or unparseable value: %s',
    (value) => {
      expect(toEventTimestamp(value)).toBeUndefined();
    },
  );
});
