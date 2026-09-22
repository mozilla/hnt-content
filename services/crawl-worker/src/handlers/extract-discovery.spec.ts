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

  it('calls extractArticleList with the page URL and per-domain mode', async () => {
    await handleArticleDiscovery(DISCOVERY_MESSAGE);

    // example.com is not on the cheap list, so it uses browserHtml.
    expect(extractListMock).toHaveBeenCalledWith(DISCOVERY_MESSAGE.url, {
      extractFrom: 'browserHtml',
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

  it.each([
    ['the page domain', 'https://example.com/news/a'],
    ['a subdomain of the page domain', 'https://blog.example.com/post'],
    ['no parseable domain', 'not a url'],
  ])('keeps an article with %s', async (_case, url) => {
    extractListMock.mockResolvedValueOnce(
      listResponse([{ ...ZYTE_LIST_ITEM, url }]),
    );

    const { articleUrls } = await handleArticleDiscovery(DISCOVERY_MESSAGE);

    expect(articleUrls).toEqual([url]);
  });

  it('keeps articles on the domain the page redirects to', async () => {
    const redirectedUrl = 'https://example-news.com/story';
    extractListMock.mockResolvedValueOnce(
      listResponse(
        [{ ...ZYTE_LIST_ITEM, url: redirectedUrl }],
        'https://example-news.com/news',
      ),
    );

    const { articleUrls } = await handleArticleDiscovery(DISCOVERY_MESSAGE);

    expect(articleUrls).toEqual([redirectedUrl]);
  });

  it('drops off-publisher articles and warns with their domain', async () => {
    extractListMock.mockResolvedValueOnce(
      listResponse([
        ZYTE_LIST_ITEM,
        { ...ZYTE_LIST_ITEM, url: 'https://other-site.com/story' },
        { ...ZYTE_LIST_ITEM, url: 'https://other-site.com/story-2' },
      ]),
    );

    const { articleUrls } = await handleArticleDiscovery(DISCOVERY_MESSAGE);

    expect(articleUrls).toEqual([ZYTE_LIST_ITEM.url]);

    expect(warnSpy).toHaveBeenCalledWith(
      'discovery: dropped 2 off-publisher articles for ' +
        `${DISCOVERY_MESSAGE.url}: other-site.com=2`,
    );
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

describe('selectArticles', () => {
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
});
