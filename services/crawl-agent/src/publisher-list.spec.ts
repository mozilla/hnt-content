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
    publisherPageLimit: 0,
  },
}));

import { readFile } from 'node:fs/promises';
import { getScheduledSectionItems } from 'crawl-common';
import config from './config.js';
import {
  corpusSourceEnabled,
  fetchLiveArticles,
  limitPages,
  loadPublisherList,
} from './publisher-list.js';

/** Build a publisher list with n pages on distinct URLs. */
function listOf(n: number) {
  return {
    pages: Array.from({ length: n }, (_, i) => ({
      url: `https://example.com/p${i}`,
      interval_minutes: 20,
      contexts: [{ surface_id: 'NEW_TAB_EN_US', topic: 'tech' }],
    })),
    live_articles: [],
  };
}

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

describe('limitPages', () => {
  it('returns the list unchanged when no limit or it already fits', () => {
    const list = listOf(5);
    expect(limitPages(list, 0)).toBe(list);
    expect(limitPages(list, 5)).toBe(list);
    expect(limitPages(list, 10)).toBe(list);
  });

  it('samples down to the limit with an even stride across the list', () => {
    // 10 pages to 3: stride ceil(10/3)=4, picks indices 0,4,8.
    const result = limitPages(listOf(10), 3);

    expect(result.pages.map((p) => p.url)).toEqual([
      'https://example.com/p0',
      'https://example.com/p4',
      'https://example.com/p8',
    ]);
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

  it('keeps blank-publisher items but skips truly malformed ones', async () => {
    const good = live('https://x/1', 'e1');
    const blankPublisher = live('https://x/2', 'e2');
    blankPublisher.corpus_item.publisher = '';
    const blankTitle = live('https://x/3', 'e3');
    blankTitle.corpus_item.title = '';
    vi.mocked(getScheduledSectionItems).mockResolvedValue([
      good,
      blankPublisher,
      blankTitle,
    ]);

    const result = await fetchLiveArticles();

    // A blank publisher is legitimate (the Corpus DB stores empty
    // publishers), so that item is kept; only the item missing a truly
    // required field (title) is dropped, and it must not crash the agent.
    expect(result.map((a) => a.url)).toEqual(['https://x/1', 'https://x/2']);
  });

  it('propagates a Corpus client error so startup fails fast', async () => {
    vi.mocked(getScheduledSectionItems).mockRejectedValue(
      new Error('Corpus API error: 503'),
    );

    await expect(fetchLiveArticles()).rejects.toThrow(/503/);
  });
});
