import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ZyteArticleListItem, ZyteResponse } from 'crawl-common';

vi.mock('crawl-common', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crawl-common')>();
  return {
    ...actual,
    extractArticleList: vi.fn(),
  };
});

import { extractArticleList } from 'crawl-common';
import { handleArticleDiscovery } from './extract-discovery.js';
import { DISCOVERY_MESSAGE, ZYTE_LIST_ITEM } from './test-helpers.js';

const extractListMock = vi.mocked(extractArticleList);

/** Wrap article list items in the Zyte response envelope. */
function listResponse(
  items: ZyteArticleListItem[],
): ZyteResponse<ZyteArticleListItem[]> {
  return { data: items, url: DISCOVERY_MESSAGE.url, statusCode: 200 };
}

describe('handleArticleDiscovery', () => {
  beforeEach(() => {
    extractListMock.mockResolvedValue(listResponse([ZYTE_LIST_ITEM]));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('calls extractArticleList with the page URL and httpResponseBody', async () => {
    await handleArticleDiscovery(DISCOVERY_MESSAGE);

    expect(extractListMock).toHaveBeenCalledWith(DISCOVERY_MESSAGE.url, {
      extractFrom: 'httpResponseBody',
    });
  });

  it('maps a list item to the discovery event schema', async () => {
    const { events } = await handleArticleDiscovery({
      ...DISCOVERY_MESSAGE,
      contexts: [DISCOVERY_MESSAGE.contexts[0]!],
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      url: ZYTE_LIST_ITEM.url,
      source_url: DISCOVERY_MESSAGE.url,
      headline: ZYTE_LIST_ITEM.headline,
      summary: ZYTE_LIST_ITEM.description,
      authors: ZYTE_LIST_ITEM.authors,
      published_at: ZYTE_LIST_ITEM.datePublished,
      language: ZYTE_LIST_ITEM.inLanguage,
      topic: 'technology',
      surface_id: 'NEW_TAB_EN_US',
      page_position: 1,
    });
    expect(events[0]!.crawled_at).toBeDefined();
  });

  it('emits one event per context for each article', async () => {
    const { events, articleUrls } =
      await handleArticleDiscovery(DISCOVERY_MESSAGE);

    // One article x two contexts.
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.surface_id)).toEqual([
      'NEW_TAB_EN_US',
      'NEW_TAB_DE_DE',
    ]);
    // One crawl-article job per unique article URL, not per context.
    expect(articleUrls).toEqual([ZYTE_LIST_ITEM.url]);
  });

  it('drops cross-domain articles', async () => {
    extractListMock.mockResolvedValueOnce(
      listResponse([
        ZYTE_LIST_ITEM,
        { ...ZYTE_LIST_ITEM, url: 'https://other-site.com/story' },
      ]),
    );

    const { articleUrls } = await handleArticleDiscovery(DISCOVERY_MESSAGE);

    expect(articleUrls).toEqual([ZYTE_LIST_ITEM.url]);
  });

  it('keeps subdomain articles of the same registrable domain', async () => {
    const subdomainUrl = 'https://blog.example.com/post';
    extractListMock.mockResolvedValueOnce(
      listResponse([{ ...ZYTE_LIST_ITEM, url: subdomainUrl }]),
    );

    const { articleUrls } = await handleArticleDiscovery(DISCOVERY_MESSAGE);

    expect(articleUrls).toEqual([subdomainUrl]);
  });

  it('deduplicates repeated article URLs, keeping the first position', async () => {
    extractListMock.mockResolvedValueOnce(
      listResponse([
        { ...ZYTE_LIST_ITEM, url: 'https://example.com/news/a' },
        { ...ZYTE_LIST_ITEM, url: 'https://example.com/news/a' },
        { ...ZYTE_LIST_ITEM, url: 'https://example.com/news/b' },
      ]),
    );

    const { events, articleUrls } = await handleArticleDiscovery({
      ...DISCOVERY_MESSAGE,
      contexts: [DISCOVERY_MESSAGE.contexts[0]!],
    });

    expect(articleUrls).toEqual([
      'https://example.com/news/a',
      'https://example.com/news/b',
    ]);
    expect(events.map((e) => e.page_position)).toEqual([1, 3]);
  });

  it('skips list items without a URL', async () => {
    extractListMock.mockResolvedValueOnce(
      listResponse([{ ...ZYTE_LIST_ITEM, url: undefined }, ZYTE_LIST_ITEM]),
    );

    const { articleUrls } = await handleArticleDiscovery(DISCOVERY_MESSAGE);

    expect(articleUrls).toEqual([ZYTE_LIST_ITEM.url]);
  });

  it('returns no events for an empty list', async () => {
    extractListMock.mockResolvedValueOnce(listResponse([]));

    const result = await handleArticleDiscovery(DISCOVERY_MESSAGE);

    expect(result.events).toEqual([]);
    expect(result.articleUrls).toEqual([]);
  });

  it('propagates extraction errors so the message is redelivered', async () => {
    extractListMock.mockRejectedValueOnce(new Error('zyte down'));

    await expect(handleArticleDiscovery(DISCOVERY_MESSAGE)).rejects.toThrow(
      'zyte down',
    );
  });
});
