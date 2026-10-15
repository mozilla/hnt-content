import { describe, expect, it } from 'vitest';

import { randomBatch } from './random-batch.js';

describe('randomBatch', () => {
  it('returns only the requested number of items', () => {
    const items = [1, 2, 3, 4];

    const result = randomBatch(items, 2);

    expect(result.length).toEqual(2);

    expect(typeof result[0]).toBe('number');
  });

  it('returns an array of the same type as the given array', () => {
    const items = [1, 2, 3, 4];

    const result = randomBatch(items, 2);

    expect(typeof result[0]).toBe('number');
    expect(typeof result[1]).toBe('number');
  });

  it('returns fewer than the limit if the array size is less than the limit', () => {
    const items = [1, 2, 3];

    expect(randomBatch(items, 5).length).toEqual(items.length);
  });
});
