import { describe, expect, it } from 'vitest';
import { normalizeText } from './normalize.js';

describe('normalizeText', () => {
  it.each([
    ['returns empty string for null', null, undefined, ''],
    ['returns empty string for undefined', undefined, undefined, ''],
    ['returns empty string for empty string', '', undefined, ''],
    [
      'strips leading and trailing whitespace',
      '  hello world  ',
      undefined,
      'hello world',
    ],
    ['lowercases text', 'Hello World', undefined, 'hello world'],
    ['normalizes unicode to NFC', '\u0065\u0301', undefined, '\u00e9'],
    [
      'normalizes smart single quotes',
      '\u2018hello\u2019',
      undefined,
      "'hello'",
    ],
    [
      'normalizes smart double quotes',
      '\u201chello\u201d',
      undefined,
      '"hello"',
    ],
    [
      'normalizes mixed quotes',
      'it\u2019s a \u201ctest\u201d with \u2018quotes\u2019',
      undefined,
      "it's a \"test\" with 'quotes'",
    ],
    ['strips trailing period', 'Hello world.', undefined, 'hello world'],
    [
      'strips multiple trailing periods',
      'Multiple periods...',
      undefined,
      'multiple periods',
    ],
    ['collapses multiple spaces', 'hello   world', undefined, 'hello world'],
    [
      'collapses tabs and newlines',
      'hello\t\n  world',
      undefined,
      'hello world',
    ],
    ['truncates to maxLength', 'A'.repeat(300), 255, 'a'.repeat(255)],
    [
      'truncates before stripping periods',
      'A'.repeat(254) + '..',
      255,
      'a'.repeat(254),
    ],
  ])(
    '%s',
    (
      _name: string,
      input: string | null | undefined,
      maxLength: number | undefined,
      expected: string,
    ) => {
      expect(normalizeText(input, maxLength)).toBe(expected);
    },
  );
});
