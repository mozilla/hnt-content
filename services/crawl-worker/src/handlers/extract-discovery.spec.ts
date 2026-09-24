import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import type { ZyteArticleListItem, ZyteResponse } from 'zyte';

vi.mock('zyte', async (importOriginal) => {
  const actual = await importOriginal<typeof import('zyte')>();
  return {
    ...actual,
    extractArticleList: vi.fn(),
  };
});

import { extractArticleList } from 'zyte';
import { handleArticleDiscovery, selectArticles } from './extract-discovery.js';
import { DISCOVERY_MESSAGE, ZYTE_LIST_ITEM } from './test-helpers.js';
import { resolveExtractFrom } from '../zyte-extraction/extraction-mode.js';

const extractListMock = vi.mocked(extractArticleList);

/** Wrap article list items in the Zyte response envelope. */
function listResponse(
  items: ZyteArticleListItem[],
  resolvedUrl: string = DISCOVERY_MESSAGE.url,
): ZyteResponse<ZyteArticleListItem[]> {
  return { data: items, url: resolvedUrl, statusCode: 200 };
}

describe('handleArticleDiscovery', () => {
  let warnSpy: MockInstance<typeof console.warn>;

  beforeEach(() => {
    extractListMock.mockResolvedValue(listResponse([ZYTE_LIST_ITEM]));
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('correctly calls resolveExtractFrom to determine Zyte extraction method', async () => {
    const items = [ZYTE_LIST_ITEM];

    extractListMock.mockResolvedValueOnce(listResponse(items));

    await handleArticleDiscovery(DISCOVERY_MESSAGE);

    // make sure resolveExtractFrom was called with the expected args
    expect(extractListMock).toHaveBeenCalledExactlyOnceWith(
      DISCOVERY_MESSAGE.url,
      {
        extractFrom: resolveExtractFrom(DISCOVERY_MESSAGE.url, 'articleList'),
      },
    );
  });

  it('passes both the message URL and the resolvedUrl to selectArticles', async () => {
    const resolvedUrl = 'https://example-news.com/news-moved';

    extractListMock.mockResolvedValueOnce(
      listResponse(
        [
          ZYTE_LIST_ITEM,
          { ...ZYTE_LIST_ITEM, url: 'https://example-news.com/story' },
        ],
        resolvedUrl,
      ),
    );

    const result = await handleArticleDiscovery(DISCOVERY_MESSAGE);

    // results containing items from both the DISCOVERY_MESSAGE domain and the
    // resolvedUrl domain verify the resolvedUrl was passed to selectArticles.
    expect(result.articleUrls).toEqual([
      ZYTE_LIST_ITEM.url,
      'https://example-news.com/story',
    ]);
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
      topic: DISCOVERY_MESSAGE.contexts[0].topic,
      surface_id: DISCOVERY_MESSAGE.contexts[0].surface_id,
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

  it('warns when a page yields no articles', async () => {
    const resolvedUrl = 'https://example.com/news-moved';
    extractListMock.mockResolvedValueOnce(
      listResponse(
        [{ ...ZYTE_LIST_ITEM, url: 'https://other-site.com/story' }],
        resolvedUrl,
      ),
    );

    const { events, articleUrls } =
      await handleArticleDiscovery(DISCOVERY_MESSAGE);

    expect(events).toEqual([]);
    expect(articleUrls).toEqual([]);

    expect(warnSpy).toHaveBeenCalledWith(
      `discovery: no articles selected for ${DISCOVERY_MESSAGE.url} ` +
        `(final url ${resolvedUrl}, 1 raw items)`,
    );
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

describe('selectArticles', () => {
  let warnSpy: MockInstance<typeof console.warn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns matching items with their 1-based position', () => {
    expect(selectArticles([ZYTE_LIST_ITEM], ['example.com/latest'])).toEqual([
      {
        url: ZYTE_LIST_ITEM.url,
        item: ZYTE_LIST_ITEM,
        position: 1,
      },
    ]);
  });

  it('keeps nothing and warns when no page URL yields a domain', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(selectArticles([ZYTE_LIST_ITEM], ['notadomain'])).toEqual([]);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('no registrable domain for notadomain'),
    );
  });

  it.each(['https://example.com/news/a', 'https://blog.example.com/post'])(
    'keeps articles with a parseable domain or subdomain',
    async (url) => {
      const res = selectArticles(
        [{ ...ZYTE_LIST_ITEM, url }],
        ['https://example.com/news'],
      );

      expect(res).toEqual([
        {
          url: url,
          item: { ...ZYTE_LIST_ITEM, url },
          position: 1,
        },
      ]);
    },
  );

  it('drops articles with non-parseable domains and warns', async () => {
    const res = selectArticles(
      [
        ZYTE_LIST_ITEM,
        { ...ZYTE_LIST_ITEM, url: 'javascript:alert(false);' },
        { ...ZYTE_LIST_ITEM, url: '192.168.0.1' },
        { ...ZYTE_LIST_ITEM, url: '#anchor' },
      ],
      ['https://example.com/news'],
    );

    expect(res).toEqual([
      {
        url: ZYTE_LIST_ITEM.url,
        item: ZYTE_LIST_ITEM,
        position: 1,
      },
    ]);

    expect(warnSpy).toHaveBeenCalledWith(
      'discovery: dropped 3 off-publisher articles for ' +
        `${DISCOVERY_MESSAGE.url}: (unparseable)=3`,
    );
  });

  it('drops off-publisher articles and warns with their domain', async () => {
    const res = selectArticles(
      [
        ZYTE_LIST_ITEM,
        { ...ZYTE_LIST_ITEM, url: 'https://other-site.com/story' },
        { ...ZYTE_LIST_ITEM, url: 'https://other-site.com/story-2' },
      ],
      ['https://example.com/news'],
    );

    expect(res).toEqual([
      {
        url: ZYTE_LIST_ITEM.url,
        item: ZYTE_LIST_ITEM,
        position: 1,
      },
    ]);

    expect(warnSpy).toHaveBeenCalledWith(
      'discovery: dropped 2 off-publisher articles for ' +
        `${DISCOVERY_MESSAGE.url}: other-site.com=2`,
    );
  });

  it('keeps articles on the domain the page redirects to', async () => {
    const redirectedUrl = 'https://example-news.com/story';

    const itemWithRedirectedUrl = { ...ZYTE_LIST_ITEM, url: redirectedUrl };

    const res = selectArticles(
      [ZYTE_LIST_ITEM, itemWithRedirectedUrl],
      // the first URL was provided by the pubsub message, the second the
      // result of zyte following a publisher redirect.
      ['https://example.com/news', 'https://example-news.com'],
    );

    expect(res).toEqual([
      {
        url: ZYTE_LIST_ITEM.url,
        item: ZYTE_LIST_ITEM,
        position: 1,
      },
      {
        url: redirectedUrl,
        item: itemWithRedirectedUrl,
        position: 2,
      },
    ]);
  });

  it('deduplicates repeated article URLs, keeping the first position', async () => {
    const itemOne = { ...ZYTE_LIST_ITEM, url: 'https://example.com/news/a' };
    const itemThree = { ...ZYTE_LIST_ITEM, url: 'https://example.com/news/b' };

    const res = selectArticles(
      // itemOne is repeated twice on the crawled page
      [itemOne, itemOne, itemThree],
      ['https://example.com/news'],
    );

    expect(res).toEqual([
      {
        url: itemOne.url,
        item: itemOne,
        position: 1,
      },
      {
        url: itemThree.url,
        item: itemThree,
        position: 3,
      },
    ]);
  });

  it('skips list items without a URL', async () => {
    // note - this will not warn when the item has no url - it just skips
    const res = selectArticles(
      [{ ...ZYTE_LIST_ITEM, url: undefined }, ZYTE_LIST_ITEM],
      ['https://example.com/news'],
    );

    expect(res).toEqual([
      {
        url: ZYTE_LIST_ITEM.url,
        item: ZYTE_LIST_ITEM,
        position: 2,
      },
    ]);
  });
});
