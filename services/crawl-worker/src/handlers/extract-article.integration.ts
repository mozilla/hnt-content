import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  initCorpusApiClient,
  initZyteClient,
  type CrawlArticleMessage,
} from 'crawl-common';
import { handleArticleExtraction } from './extract-article.js';
import {
  BASE_MESSAGE,
  CORPUS_ITEM,
  TEST_JWK,
  TEST_URL,
  ZYTE_ARTICLE,
} from './test-helpers.js';

const ZYTE_URL = 'https://api.zyte.com/v1/extract';
const CORPUS_API_URL = 'https://admin-api.test/';

/**
 * Integration test: exercises the handler against real Zyte
 * and Corpus API clients, with fetch stubbed at the network
 * boundary. Catches regressions in client wiring (JWT signing,
 * request construction, response parsing) that module-mocked
 * unit tests cannot.
 */
describe('extract-article integration', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    initZyteClient({ apiKey: 'test-zyte-key', maxRetries: 0 });
    await initCorpusApiClient({
      endpoint: CORPUS_API_URL,
      jwkJson: TEST_JWK,
      issuer: 'https://getpocket.com',
      audience: CORPUS_API_URL,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('triggers a Corpus API update and returns the mapped event when a live article has a changed title', async () => {
    const updatedHeadline = 'Updated Headline From Zyte';
    const zyteArticle = {
      ...ZYTE_ARTICLE,
      headline: updatedHeadline,
      authors: [{ name: 'Author A' }, { name: 'Author B' }],
    };

    fetchMock.mockImplementation(async (url: string) => {
      if (url === ZYTE_URL) {
        return new Response(
          JSON.stringify({
            article: zyteArticle,
            url: zyteArticle.url,
            statusCode: 200,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === CORPUS_API_URL) {
        return new Response(
          JSON.stringify({
            data: {
              updateApprovedCorpusItem: {
                externalId: CORPUS_ITEM.external_id,
                url: zyteArticle.url,
                title: updatedHeadline,
                excerpt: zyteArticle.description,
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const message: CrawlArticleMessage = {
      ...BASE_MESSAGE,
      corpus_item: CORPUS_ITEM,
    };
    const event = await handleArticleExtraction(message);

    // Both clients hit the network.
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Corpus API request carries a Bearer JWT and the
    // expected GraphQL mutation variables.
    const corpusCall = fetchMock.mock.calls.find(([u]) => u === CORPUS_API_URL);
    expect(corpusCall).toBeDefined();
    const corpusInit = corpusCall![1] as RequestInit;
    const headers = corpusInit.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^Bearer /);
    expect(headers['apollographql-client-name']).toBe('hnt-content');

    const corpusBody = JSON.parse(corpusInit.body as string) as {
      variables: { data: Record<string, unknown> };
    };
    expect(corpusBody.variables.data).toMatchObject({
      externalId: CORPUS_ITEM.external_id,
      title: updatedHeadline,
      // Excerpt unchanged: extracted matches corpus_item.
      excerpt: CORPUS_ITEM.excerpt,
      authors: [
        { name: 'Author A', sortOrder: 0 },
        { name: 'Author B', sortOrder: 1 },
      ],
      status: CORPUS_ITEM.status,
      language: CORPUS_ITEM.language,
      publisher: CORPUS_ITEM.publisher,
      imageUrl: CORPUS_ITEM.image_url,
      topic: CORPUS_ITEM.topic,
      isTimeSensitive: CORPUS_ITEM.is_time_sensitive,
    });

    // Handler returned the expected ArticleEvent.
    expect(event).toMatchObject({
      url: TEST_URL,
      headline: updatedHeadline,
      description: ZYTE_ARTICLE.description,
      authors: [{ name: 'Author A' }, { name: 'Author B' }],
      main_image_url: ZYTE_ARTICLE.mainImage?.url,
      body_truncated: ZYTE_ARTICLE.articleBody,
      published_at: ZYTE_ARTICLE.datePublished,
      language: ZYTE_ARTICLE.inLanguage,
    });
    expect(event.extracted_at).toBeDefined();
  });
});
