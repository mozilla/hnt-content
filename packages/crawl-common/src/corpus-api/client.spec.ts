import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  initCorpusApiClient,
  updateApprovedCorpusItem,
  getScheduledSectionItems,
  CorpusApiError,
} from './client.js';
import {
  TEST_JWK,
  CLIENT_OPTS,
  UPDATE_APPROVED_CORPUS_ITEM_INPUT,
  UPDATE_APPROVED_CORPUS_ITEM_SUCCESS_BODY,
  SCHEDULED_SURFACE_GUID,
  SECTION_ITEMS_SUCCESS_BODY,
  mockResponse,
} from './test-helpers.js';

let fetchMock: ReturnType<typeof vi.fn>;

describe('corpus-api client', () => {
  beforeEach(async () => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await initCorpusApiClient(CLIENT_OPTS);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('request', () => {
    it('sends a GraphQL mutation with JWT auth', async () => {
      fetchMock.mockResolvedValueOnce(
        mockResponse(UPDATE_APPROVED_CORPUS_ITEM_SUCCESS_BODY),
      );

      await updateApprovedCorpusItem(UPDATE_APPROVED_CORPUS_ITEM_INPUT);

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(CLIENT_OPTS.endpoint);
      expect(init.method).toBe('POST');

      const headers = init.headers as Record<string, string>;
      expect(headers['content-type']).toBe('application/json');
      expect(headers.authorization).toMatch(/^Bearer eyJ/);
      expect(headers['apollographql-client-name']).toBe('hnt-content');
    });

    it('sends the mutation variables', async () => {
      fetchMock.mockResolvedValueOnce(
        mockResponse(UPDATE_APPROVED_CORPUS_ITEM_SUCCESS_BODY),
      );

      await updateApprovedCorpusItem(UPDATE_APPROVED_CORPUS_ITEM_INPUT);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body.variables.data.externalId).toBe(
        UPDATE_APPROVED_CORPUS_ITEM_INPUT.externalId,
      );
      expect(body.variables.data.title).toBe(
        UPDATE_APPROVED_CORPUS_ITEM_INPUT.title,
      );
      expect(body.query).toContain('updateApprovedCorpusItem');
    });
  });

  describe('response', () => {
    it('returns the mutation result on success', async () => {
      fetchMock.mockResolvedValueOnce(
        mockResponse(UPDATE_APPROVED_CORPUS_ITEM_SUCCESS_BODY),
      );

      const result = await updateApprovedCorpusItem(
        UPDATE_APPROVED_CORPUS_ITEM_INPUT,
      );

      const expected =
        UPDATE_APPROVED_CORPUS_ITEM_SUCCESS_BODY.data.updateApprovedCorpusItem;
      expect(result.externalId).toBe(expected.externalId);
      expect(result.title).toBe(expected.title);
    });

    it.each([
      {
        scenario: 'GraphQL errors',
        body: { errors: [{ message: 'Item not found' }] },
        status: 200,
      },
      { scenario: 'null data', body: { data: null }, status: 200 },
      { scenario: '4xx', body: { error: 'bad request' }, status: 400 },
    ])(
      'throws CorpusApiError on $scenario without retrying',
      async ({ body, status }) => {
        fetchMock.mockResolvedValueOnce(mockResponse(body, status));

        await expect(
          updateApprovedCorpusItem(UPDATE_APPROVED_CORPUS_ITEM_INPUT),
        ).rejects.toThrow(CorpusApiError);
        expect(fetchMock).toHaveBeenCalledOnce();
      },
    );
  });

  describe('getScheduledSectionItems', () => {
    it('sends the sections query with the surface variable and JWT auth', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(SECTION_ITEMS_SUCCESS_BODY));

      await getScheduledSectionItems(SCHEDULED_SURFACE_GUID);

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(CLIENT_OPTS.endpoint);
      const body = JSON.parse(init.body as string);
      expect(body.query).toContain('getSectionsWithSectionItems');
      expect(body.variables.scheduledSurfaceGuid).toBe(SCHEDULED_SURFACE_GUID);
      const headers = init.headers as Record<string, string>;
      expect(headers.authorization).toMatch(/^Bearer eyJ/);
    });

    it('maps items to LiveArticle, de-duplicates by URL, and skips non-live sections', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(SECTION_ITEMS_SUCCESS_BODY));

      const result = await getScheduledSectionItems(SCHEDULED_SURFACE_GUID);

      // live-1 appears in two LIVE sections (deduped); the DISABLED and
      // SCHEDULED sections are skipped; so three unique live articles
      // remain.
      expect(result.map((a) => a.url)).toEqual([
        'https://example.com/live-1',
        'https://example.com/live-2',
        'https://example.com/live-3',
      ]);
      expect(result[0].corpus_item).toMatchObject({
        external_id: 'ext-1',
        title: 'Live One',
        excerpt: 'Excerpt one.',
        authors: [{ name: 'Jane Doe' }],
        status: 'CORPUS',
        language: 'EN',
        publisher: 'Example News',
        image_url: 'https://s3.amazonaws.com/live-1.jpg',
        topic: 'TECHNOLOGY',
        is_time_sensitive: false,
      });
    });

    it('returns an empty list when no sections are scheduled', async () => {
      fetchMock.mockResolvedValueOnce(
        mockResponse({ data: { getSectionsWithSectionItems: [] } }),
      );

      expect(await getScheduledSectionItems(SCHEDULED_SURFACE_GUID)).toEqual(
        [],
      );
    });

    it('throws CorpusApiError on a GraphQL error without retrying', async () => {
      fetchMock.mockResolvedValueOnce(
        mockResponse({ errors: [{ message: 'forbidden' }] }),
      );

      await expect(
        getScheduledSectionItems(SCHEDULED_SURFACE_GUID),
      ).rejects.toThrow(CorpusApiError);
      expect(fetchMock).toHaveBeenCalledOnce();
    });
  });

  describe('jwt', () => {
    it('caches the JWT token across calls', async () => {
      fetchMock
        .mockResolvedValueOnce(
          mockResponse(UPDATE_APPROVED_CORPUS_ITEM_SUCCESS_BODY),
        )
        .mockResolvedValueOnce(
          mockResponse(UPDATE_APPROVED_CORPUS_ITEM_SUCCESS_BODY),
        );

      await updateApprovedCorpusItem(UPDATE_APPROVED_CORPUS_ITEM_INPUT);
      await updateApprovedCorpusItem(UPDATE_APPROVED_CORPUS_ITEM_INPUT);

      // Both calls should use the same token.
      const token1 = (
        fetchMock.mock.calls[0][1].headers as Record<string, string>
      ).authorization;
      const token2 = (
        fetchMock.mock.calls[1][1].headers as Record<string, string>
      ).authorization;
      expect(token1).toBe(token2);
    });

    it('handles the {"keys": [...]} wrapper format', async () => {
      const wrapped = JSON.stringify({
        keys: [JSON.parse(TEST_JWK)],
      });
      await initCorpusApiClient({
        ...CLIENT_OPTS,
        jwkJson: wrapped,
      });
      fetchMock.mockResolvedValueOnce(
        mockResponse(UPDATE_APPROVED_CORPUS_ITEM_SUCCESS_BODY),
      );

      const result = await updateApprovedCorpusItem(
        UPDATE_APPROVED_CORPUS_ITEM_INPUT,
      );

      expect(result.externalId).toBe(
        UPDATE_APPROVED_CORPUS_ITEM_SUCCESS_BODY.data.updateApprovedCorpusItem
          .externalId,
      );
    });

    it('includes kid in the JWT header', async () => {
      fetchMock.mockResolvedValueOnce(
        mockResponse(UPDATE_APPROVED_CORPUS_ITEM_SUCCESS_BODY),
      );

      await updateApprovedCorpusItem(UPDATE_APPROVED_CORPUS_ITEM_INPUT);

      const authHeader = (
        fetchMock.mock.calls[0][1].headers as Record<string, string>
      ).authorization;
      const token = authHeader.replace('Bearer ', '');
      // Decode the JWT header (first segment, base64url).
      const header = JSON.parse(
        Buffer.from(token.split('.')[0], 'base64url').toString(),
      );
      expect(header.alg).toBe('RS256');
      expect(header.kid).toBe('test-kid');
    });
  });
});
