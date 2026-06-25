import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('crawl-common', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crawl-common')>();
  return { ...actual, getTimestamp: vi.fn() };
});

import { getTimestamp } from 'crawl-common';
import { withinMinutes } from './recency.js';

describe('withinMinutes', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('is true when the marker is within the window', async () => {
    vi.mocked(getTimestamp).mockResolvedValue(Date.now() - 5 * 60_000);
    expect(await withinMinutes('k', 10)).toBe(true);
  });

  it('is false when the marker is older than the window', async () => {
    vi.mocked(getTimestamp).mockResolvedValue(Date.now() - 15 * 60_000);
    expect(await withinMinutes('k', 10)).toBe(false);
  });

  it('is false when there is no marker', async () => {
    vi.mocked(getTimestamp).mockResolvedValue(null);
    expect(await withinMinutes('k', 10)).toBe(false);
  });
});
