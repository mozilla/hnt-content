import { describe, expect, it } from 'vitest';
import { isWithinMinutes } from './is-within-minutes.js';

describe('isWithinMinutes', () => {
  it('is true when the marker is within the window', () => {
    expect(isWithinMinutes(Date.now() - 5 * 60_000, 10)).toBe(true);
  });

  it('is false when the marker is older than the window', () => {
    expect(isWithinMinutes(Date.now() - 11 * 60_000, 10)).toBe(false);
  });

  it('is false when there is no marker', () => {
    expect(isWithinMinutes(null, 10)).toBe(false);
  });
});
