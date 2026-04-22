import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  initCorpusApiClient,
  updateApprovedCorpusItem,
  CorpusApiError,
} from './client.js';
import {
  TEST_JWK,
  CLIENT_OPTS,
  UPDATE_APPROVED_CORPUS_ITEM_INPUT,
  UPDATE_APPROVED_CORPUS_ITEM_SUCCESS_BODY,
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
      expect(url).toBe('https://admin-api.test/');
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
      expect(body.variables.data.externalId).toBe('abc-123');
      expect(body.variables.data.title).toBe('Test Title');
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

      expect(result.externalId).toBe('abc-123');
      expect(result.title).toBe('Test Title');
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

      expect(result.externalId).toBe('abc-123');
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
