import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CrawlArticleMessage,
  ZyteArticle,
  ZyteResponse,
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

const extractArticleMock = vi.mocked(extractArticle);
const updateCorpusMock = vi.mocked(updateApprovedCorpusItem);

/**
 * Integration test: verify the full handler flow for a
 * live article with a changed title, from message input
 * through Zyte extraction to Corpus API update and
 * ArticleEvent output.
 */
describe('extract-article integration', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('live article with changed title triggers Corpus API update and returns correct event', async () => {
    const zyteArticle: ZyteArticle = {
      url: 'https://example.com/article',
      headline: 'Updated Headline From Zyte',
      description: 'Original description.',
      authors: [{ name: 'Author A' }, { name: 'Author B' }],
      mainImage: { url: 'https://example.com/img.jpg' },
      articleBody: 'Article body content.',
      datePublished: '2025-06-01T10:00:00Z',
      breadcrumbs: [{ name: 'Tech', url: 'https://example.com/tech' }],
      inLanguage: 'en',
      metadata: {
        probability: 0.98,
        dateDownloaded: '2025-06-01T12:00:00Z',
      },
    };

    extractArticleMock.mockResolvedValue({
      data: zyteArticle,
      url: 'https://example.com/article',
      statusCode: 200,
    });

    updateCorpusMock.mockResolvedValue({
      externalId: 'ext-456',
      url: 'https://example.com/article',
      title: 'Updated Headline From Zyte',
      excerpt: 'Original description.',
    });

    const message: CrawlArticleMessage = {
      url: 'https://example.com/article',
      source_url: 'https://example.com/news',
      crawl_id: 'crawl-integration-001',
      enqueued_at: '2025-06-01T11:00:00Z',
      corpus_item: {
        external_id: 'ext-456',
        title: 'Old Headline',
        excerpt: 'Original description.',
        authors: [{ name: 'Author A' }],
        status: 'CORPUS',
        language: 'EN',
        publisher: 'Example News',
        image_url: 'https://s3.amazonaws.com/img.jpg',
        topic: 'TECHNOLOGY',
        is_time_sensitive: false,
      },
    };

    // Execute handler.
    const event = await handleArticleExtraction(message);

    // Verify Zyte was called with httpResponseBody.
    expect(extractArticleMock).toHaveBeenCalledWith(
      'https://example.com/article',
      { extractFrom: 'httpResponseBody' },
    );

    // Verify Corpus API was called with correct input.
    expect(updateCorpusMock).toHaveBeenCalledOnce();
    const updateInput = updateCorpusMock.mock.calls[0][0];

    // Title from Zyte (raw, not normalized).
    expect(updateInput.title).toBe('Updated Headline From Zyte');
    // Excerpt unchanged (from corpus_item fallback since
    // extracted matches).
    expect(updateInput.excerpt).toBe('Original description.');
    // Authors from Zyte (preferred over corpus_item).
    expect(updateInput.authors).toEqual([
      { name: 'Author A', sortOrder: 0 },
      { name: 'Author B', sortOrder: 1 },
    ]);
    // Passthrough fields from corpus_item.
    expect(updateInput.externalId).toBe('ext-456');
    expect(updateInput.status).toBe('CORPUS');
    expect(updateInput.language).toBe('EN');
    expect(updateInput.publisher).toBe('Example News');
    expect(updateInput.imageUrl).toBe('https://s3.amazonaws.com/img.jpg');
    expect(updateInput.topic).toBe('TECHNOLOGY');
    expect(updateInput.isTimeSensitive).toBe(false);

    // Verify returned ArticleEvent.
    expect(event.url).toBe('https://example.com/article');
    expect(event.headline).toBe('Updated Headline From Zyte');
    expect(event.description).toBe('Original description.');
    expect(event.authors).toEqual([{ name: 'Author A' }, { name: 'Author B' }]);
    expect(event.main_image_url).toBe('https://example.com/img.jpg');
    expect(event.body_truncated).toBe('Article body content.');
    expect(event.published_at).toBe('2025-06-01T10:00:00Z');
    expect(event.language).toBe('en');
    expect(event.extracted_at).toBeDefined();
  });
});
