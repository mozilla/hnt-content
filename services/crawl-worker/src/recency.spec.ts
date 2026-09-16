import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('redis-state', () => ({ getTimestamp: vi.fn() }));

import { getTimestamp } from 'redis-state';
import { withinMinutes } from './recency.js';

describe('withinMinutes', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    { marker: Date.now() - 5 * 60_000, expected: true, label: 'inside' },
    { marker: Date.now() - 15 * 60_000, expected: false, label: 'outside' },
    { marker: null, expected: false, label: 'missing' },
  ])(
    'is $expected for a marker $label the window',
    async ({ marker, expected }) => {
      vi.mocked(getTimestamp).mockResolvedValue(marker);

      expect(await withinMinutes('page:fetch:abc', 10)).toBe(expected);
    },
  );
});
