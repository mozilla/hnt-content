import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CrawlArticleMessage,
  UpdateApprovedCorpusItemInput,
} from 'crawl-common';

vi.mock('crawl-common', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crawl-common')>();
  return {
    ...actual,
    extractArticle: vi.fn(),
    updateApprovedCorpusItem: vi.fn(),
  };
});

import { extractArticle, updateApprovedCorpusItem } from 'crawl-common';
import { handleArticleExtraction } from './extract-article.js';
import {
  BASE_MESSAGE,
  CORPUS_ITEM,
  ZYTE_ARTICLE,
  ZYTE_RESPONSE,
} from './test-helpers.js';

const extractArticleMock = vi.mocked(extractArticle);
const updateCorpusMock = vi.mocked(updateApprovedCorpusItem);

describe('handleArticleExtraction', () => {
  beforeEach(() => {
    extractArticleMock.mockResolvedValue(ZYTE_RESPONSE);
    updateCorpusMock.mockResolvedValue({
      externalId: 'ext-123',
      url: 'https://example.com/article',
      title: 'Test Headline',
      excerpt: 'Test description',
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('discovered article (no corpus_item)', () => {
    it('returns an ArticleEvent with mapped fields', async () => {
      const event = await handleArticleExtraction(BASE_MESSAGE);

      expect(event.url).toBe('https://example.com/article');
      expect(event.headline).toBe('Test Headline');
      expect(event.description).toBe('Test description of the article.');
      expect(event.authors).toEqual([{ name: 'Jane Doe' }]);
      expect(event.main_image_url).toBe('https://example.com/image.jpg');
      expect(event.body_truncated).toBe('Full article body text here.');
      expect(event.published_at).toBe('2025-06-01T12:00:00Z');
      expect(event.breadcrumbs).toEqual([
        { name: 'News', url: 'https://example.com/news' },
      ]);
      expect(event.language).toBe('en');
      expect(event.extracted_at).toBeDefined();
    });

    it('calls extractArticle with httpResponseBody', async () => {
      await handleArticleExtraction(BASE_MESSAGE);

      expect(extractArticleMock).toHaveBeenCalledWith(
        'https://example.com/article',
        { extractFrom: 'httpResponseBody' },
      );
    });

    it('does not call updateApprovedCorpusItem', async () => {
      await handleArticleExtraction(BASE_MESSAGE);

      expect(updateCorpusMock).not.toHaveBeenCalled();
    });

    it('truncates articleBody to 2000 characters', async () => {
      extractArticleMock.mockResolvedValueOnce({
        ...ZYTE_RESPONSE,
        data: {
          ...ZYTE_ARTICLE,
          articleBody: 'x'.repeat(5000),
        },
      });

      const event = await handleArticleExtraction(BASE_MESSAGE);

      expect(event.body_truncated).toHaveLength(2000);
    });
  });

  describe('live article (with corpus_item)', () => {
    const liveMessage: CrawlArticleMessage = {
      ...BASE_MESSAGE,
      corpus_item: CORPUS_ITEM,
    };

    it('does not update when title and excerpt match', async () => {
      await handleArticleExtraction(liveMessage);

      expect(updateCorpusMock).not.toHaveBeenCalled();
    });

    it('updates when title changed and passes through corpus fields', async () => {
      extractArticleMock.mockResolvedValueOnce({
        ...ZYTE_RESPONSE,
        data: {
          ...ZYTE_ARTICLE,
          headline: 'New Headline',
        },
      });

      await handleArticleExtraction(liveMessage);

      expect(updateCorpusMock).toHaveBeenCalledOnce();
      const input = updateCorpusMock.mock
        .calls[0][0] as UpdateApprovedCorpusItemInput;
      expect(input.title).toBe('New Headline');
      // Unchanged excerpt uses corpus item value.
      expect(input.excerpt).toBe('Test description of the article.');
      // Passthrough fields from corpus_item.
      expect(input.externalId).toBe('ext-123');
      expect(input.status).toBe('CORPUS');
      expect(input.language).toBe('EN');
      expect(input.publisher).toBe('Example News');
      expect(input.imageUrl).toBe('https://s3.amazonaws.com/image.jpg');
      expect(input.topic).toBe('TECHNOLOGY');
      expect(input.isTimeSensitive).toBe(false);
    });

    it('updates when excerpt changed', async () => {
      extractArticleMock.mockResolvedValueOnce({
        ...ZYTE_RESPONSE,
        data: {
          ...ZYTE_ARTICLE,
          description: 'Completely different excerpt.',
        },
      });

      await handleArticleExtraction(liveMessage);

      expect(updateCorpusMock).toHaveBeenCalledOnce();
      const input = updateCorpusMock.mock
        .calls[0][0] as UpdateApprovedCorpusItemInput;
      expect(input.excerpt).toBe('Completely different excerpt.');
    });

    it.each([
      {
        scenario: 'case differences',
        corpusTitle: 'Test Headline',
        zyteHeadline: 'test headline',
      },
      {
        scenario: 'smart quote differences',
        corpusTitle: "It's a 'test'",
        zyteHeadline: 'It\u2019s a \u2018test\u2019',
      },
    ])(
      'ignores $scenario in comparison',
      async ({ corpusTitle, zyteHeadline }) => {
        const msg: CrawlArticleMessage = {
          ...BASE_MESSAGE,
          corpus_item: { ...CORPUS_ITEM, title: corpusTitle },
        };
        extractArticleMock.mockResolvedValueOnce({
          ...ZYTE_RESPONSE,
          data: { ...ZYTE_ARTICLE, headline: zyteHeadline },
        });

        await handleArticleExtraction(msg);

        expect(updateCorpusMock).not.toHaveBeenCalled();
      },
    );

    it('truncates excerpt to 255 chars for comparison', async () => {
      const baseExcerpt = 'a'.repeat(255);
      const msg: CrawlArticleMessage = {
        ...BASE_MESSAGE,
        corpus_item: {
          ...CORPUS_ITEM,
          excerpt: baseExcerpt,
        },
      };
      extractArticleMock.mockResolvedValueOnce({
        ...ZYTE_RESPONSE,
        data: {
          ...ZYTE_ARTICLE,
          // Same first 255 chars, different after.
          description: baseExcerpt + ' extra text',
        },
      });

      await handleArticleExtraction(msg);

      expect(updateCorpusMock).not.toHaveBeenCalled();
    });

    it('skips comparison when extracted fields are empty', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      extractArticleMock.mockResolvedValueOnce({
        ...ZYTE_RESPONSE,
        data: {
          ...ZYTE_ARTICLE,
          headline: undefined,
          description: undefined,
        },
      });

      await handleArticleExtraction(liveMessage);

      expect(updateCorpusMock).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Empty title and excerpt'),
      );
    });

    it('skips title comparison when only title is empty', async () => {
      extractArticleMock.mockResolvedValueOnce({
        ...ZYTE_RESPONSE,
        data: {
          ...ZYTE_ARTICLE,
          headline: '',
          description: 'Completely different excerpt.',
        },
      });

      await handleArticleExtraction(liveMessage);

      expect(updateCorpusMock).toHaveBeenCalledOnce();
      const input = updateCorpusMock.mock
        .calls[0][0] as UpdateApprovedCorpusItemInput;
      // Falls back to corpus_item title since extracted is empty.
      expect(input.title).toBe('Test Headline');
      expect(input.excerpt).toBe('Completely different excerpt.');
    });

    it('prefers extracted authors over corpus_item', async () => {
      extractArticleMock.mockResolvedValueOnce({
        ...ZYTE_RESPONSE,
        data: {
          ...ZYTE_ARTICLE,
          headline: 'New Headline',
          authors: [{ name: 'New Author One' }, { name: 'New Author Two' }],
        },
      });

      await handleArticleExtraction(liveMessage);

      const input = updateCorpusMock.mock
        .calls[0][0] as UpdateApprovedCorpusItemInput;
      expect(input.authors).toEqual([
        { name: 'New Author One', sortOrder: 0 },
        { name: 'New Author Two', sortOrder: 1 },
      ]);
    });

    it('falls back to corpus_item authors when extracted is empty', async () => {
      extractArticleMock.mockResolvedValueOnce({
        ...ZYTE_RESPONSE,
        data: {
          ...ZYTE_ARTICLE,
          headline: 'New Headline',
          authors: [],
        },
      });

      await handleArticleExtraction(liveMessage);

      const input = updateCorpusMock.mock
        .calls[0][0] as UpdateApprovedCorpusItemInput;
      expect(input.authors).toEqual([{ name: 'Jane Doe', sortOrder: 0 }]);
    });

    it('throws when Corpus API update fails', async () => {
      extractArticleMock.mockResolvedValueOnce({
        ...ZYTE_RESPONSE,
        data: {
          ...ZYTE_ARTICLE,
          headline: 'New Headline',
        },
      });
      updateCorpusMock.mockRejectedValueOnce(new Error('Corpus API down'));

      await expect(handleArticleExtraction(liveMessage)).rejects.toThrow(
        'Corpus API down',
      );
    });
  });
});
