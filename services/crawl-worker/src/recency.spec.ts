import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('redis-state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('redis-state')>();
  return {
    ...actual,
    getTimestamp: vi.fn(),
  };
});

import { getTimestamp } from 'redis-state';
import { isWithinMinutes } from './recency.js';

describe('withinMinutes', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('is true when the marker is within the window', async () => {
    vi.mocked(getTimestamp).mockResolvedValue(Date.now() - 5 * 60_000);
    expect(await isWithinMinutes('k', 10)).toBe(true);
  });

  it('is false when the marker is older than the window', async () => {
    vi.mocked(getTimestamp).mockResolvedValue(Date.now() - 15 * 60_000);
    expect(await isWithinMinutes('k', 10)).toBe(false);
  });

  it('is false when there is no marker', async () => {
    vi.mocked(getTimestamp).mockResolvedValue(null);
    expect(await isWithinMinutes('k', 10)).toBe(false);
  });
});
