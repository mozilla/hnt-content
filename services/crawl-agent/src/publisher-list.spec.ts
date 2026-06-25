import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }));

import { readFile } from 'node:fs/promises';
import { loadPublisherList } from './publisher-list.js';

const EMPTY_LIST = { pages: [], live_articles: [] };

describe('loadPublisherList', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('loads and validates a well-formed list', async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(EMPTY_LIST));

    expect(await loadPublisherList('publishers.json')).toEqual(EMPTY_LIST);
  });

  it('throws on invalid JSON', async () => {
    vi.mocked(readFile).mockResolvedValue('not json');

    await expect(loadPublisherList('publishers.json')).rejects.toThrow();
  });

  it('throws on a structurally invalid list', async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({ pages: 'nope', live_articles: [] }),
    );

    await expect(loadPublisherList('publishers.json')).rejects.toThrow(
      /pages must be an array/,
    );
  });

  it('propagates a missing-file error', async () => {
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'));

    await expect(loadPublisherList('missing.json')).rejects.toThrow('ENOENT');
  });
});
