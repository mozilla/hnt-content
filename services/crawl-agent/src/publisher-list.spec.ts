import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LiveArticle } from 'crawl-common';

vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }));

// Keep the real validators; only stub the Corpus read.
vi.mock('crawl-common', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crawl-common')>();
  return { ...actual, getScheduledSectionItems: vi.fn() };
});

// Mutable config so tests can toggle the JWK and the surfaces.
vi.mock('./config.js', () => ({
  default: {
    corpusApi: { jwkJson: '', endpoint: '', issuer: '', audience: '' },
    scheduledSurfaceGuids: ['NEW_TAB_EN_US'],
    corpusRefreshMinutes: 15,
  },
}));

import { readFile } from 'node:fs/promises';
import { getScheduledSectionItems } from 'crawl-common';
import config from './config.js';
import {
  corpusSourceEnabled,
  fetchLiveArticles,
  loadPublisherList,
} from './publisher-list.js';

const EMPTY_LIST = { pages: [], live_articles: [] };

/** Build a valid live article with the given URL and external id. */
function live(url: string, externalId: string): LiveArticle {
  return {
    url,
    corpus_item: {
      external_id: externalId,
      title: 'Title',
      excerpt: 'Excerpt',
      authors: [{ name: 'Author' }],
      status: 'CORPUS',
      language: 'EN',
      publisher: 'Publisher',
      image_url: 'https://example.com/img.jpg',
      topic: 'TECHNOLOGY',
      is_time_sensitive: false,
    },
  };
}

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

describe('corpusSourceEnabled', () => {
  afterEach(() => {
    config.corpusApi.jwkJson = '';
  });

  it('is false without a JWK', () => {
    config.corpusApi.jwkJson = '';
    expect(corpusSourceEnabled()).toBe(false);
  });

  it('is true with a JWK', () => {
    config.corpusApi.jwkJson = '{"kid":"x"}';
    expect(corpusSourceEnabled()).toBe(true);
  });
});

describe('fetchLiveArticles', () => {
  afterEach(() => {
    vi.clearAllMocks();
    config.scheduledSurfaceGuids = ['NEW_TAB_EN_US'];
  });

  it('reads every surface and de-duplicates by URL across surfaces', async () => {
    config.scheduledSurfaceGuids = ['NEW_TAB_EN_US', 'NEW_TAB_DE_DE'];
    vi.mocked(getScheduledSectionItems)
      .mockResolvedValueOnce([
        live('https://x/1', 'e1'),
        live('https://x/2', 'e2'),
      ])
      // Second surface repeats /1 (deduped) and adds /3.
      .mockResolvedValueOnce([
        live('https://x/1', 'e1'),
        live('https://x/3', 'e3'),
      ]);

    const result = await fetchLiveArticles();

    expect(getScheduledSectionItems).toHaveBeenCalledTimes(2);
    expect(result.map((a) => a.url)).toEqual([
      'https://x/1',
      'https://x/2',
      'https://x/3',
    ]);
  });

  it('validates the assembled list and throws on a malformed corpus item', async () => {
    const bad = live('https://x/1', 'e1');
    bad.corpus_item.title = '';
    vi.mocked(getScheduledSectionItems).mockResolvedValue([bad]);

    await expect(fetchLiveArticles()).rejects.toThrow(/corpus_item\.title/);
  });
});
