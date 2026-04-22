import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  initCorpusApiClient,
  updateApprovedCorpusItem,
  CorpusApiError,
  RETRY_MAX_TIMEOUT_MS,
} from './client.js';
import {
  CLIENT_OPTS,
  UPDATE_APPROVED_CORPUS_ITEM_INPUT,
  UPDATE_APPROVED_CORPUS_ITEM_SUCCESS_BODY,
  mockResponse,
} from './test-helpers.js';

/** Extract the Bearer token from a fetch mock call. */
function extractToken(
  fetchMock: ReturnType<typeof vi.fn>,
  callIndex: number,
): string {
  const headers = fetchMock.mock.calls[callIndex][1].headers as Record<
    string,
    string
  >;
  return headers.authorization.replace('Bearer ', '');
}

/**
 * Integration tests for retry and JWT refresh behavior.
 * Uses fake timers to avoid real retry delays and to
 * control token expiry.
 */
describe('Corpus API integration', () => {
  const fetchMock = vi.fn<typeof fetch>();

  afterEach(() => {
    fetchMock.mockReset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('retry', () => {
    beforeEach(async () => {
      vi.stubGlobal('fetch', fetchMock);
      await initCorpusApiClient(CLIENT_OPTS);
      // Prime the token cache with real timers so jose's
      // async Web Crypto signing completes. Retry tests
      // then use the cached token under fake timers.
      fetchMock.mockResolvedValueOnce(mockResponse(UPDATE_APPROVED_CORPUS_ITEM_SUCCESS_BODY));
      await updateApprovedCorpusItem(UPDATE_APPROVED_CORPUS_ITEM_INPUT);
      fetchMock.mockReset();
      vi.useFakeTimers();
    });

    it('retries on 5xx and succeeds', async () => {
      fetchMock
        .mockResolvedValueOnce(mockResponse({ error: 'server' }, 503))
        .mockResolvedValueOnce(mockResponse(UPDATE_APPROVED_CORPUS_ITEM_SUCCESS_BODY));

      const promise = updateApprovedCorpusItem(UPDATE_APPROVED_CORPUS_ITEM_INPUT);
      await vi.advanceTimersByTimeAsync(RETRY_MAX_TIMEOUT_MS);
      const result = await promise;

      expect(result.externalId).toBe('abc-123');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('retries on network error and succeeds', async () => {
      fetchMock
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(mockResponse(UPDATE_APPROVED_CORPUS_ITEM_SUCCESS_BODY));

      const promise = updateApprovedCorpusItem(UPDATE_APPROVED_CORPUS_ITEM_INPUT);
      await vi.advanceTimersByTimeAsync(RETRY_MAX_TIMEOUT_MS);
      const result = await promise;

      expect(result.externalId).toBe('abc-123');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('stops after max retries', async () => {
      fetchMock.mockResolvedValue(
        mockResponse({ error: 'down' }, 500),
      );

      const promise = updateApprovedCorpusItem(UPDATE_APPROVED_CORPUS_ITEM_INPUT).catch(
        (e) => e,
      );
      await vi.advanceTimersByTimeAsync(RETRY_MAX_TIMEOUT_MS * 5);
      const err = await promise;

      expect(err).toBeInstanceOf(CorpusApiError);
      // 1 initial + 4 retries = 5 total.
      expect(fetchMock).toHaveBeenCalledTimes(5);
    });
  });

  describe('token refresh', () => {
    beforeEach(async () => {
      vi.stubGlobal('fetch', fetchMock);
      await initCorpusApiClient(CLIENT_OPTS);
      vi.useFakeTimers();
    });

    it('issues a new token after the refresh window', async () => {
      // First call primes the token cache.
      fetchMock.mockResolvedValueOnce(mockResponse(UPDATE_APPROVED_CORPUS_ITEM_SUCCESS_BODY));
      const promise1 = updateApprovedCorpusItem(UPDATE_APPROVED_CORPUS_ITEM_INPUT);
      await vi.advanceTimersByTimeAsync(0);
      await promise1;

      const token1 = extractToken(fetchMock, 0);

      // Advance past the refresh window (300s * 0.95 = 285s).
      await vi.advanceTimersByTimeAsync(286_000);

      // Second call should issue a new token.
      fetchMock.mockResolvedValueOnce(mockResponse(UPDATE_APPROVED_CORPUS_ITEM_SUCCESS_BODY));
      const promise2 = updateApprovedCorpusItem(UPDATE_APPROVED_CORPUS_ITEM_INPUT);
      await vi.advanceTimersByTimeAsync(0);
      await promise2;

      const token2 = extractToken(fetchMock, 1);
      expect(token2).not.toBe(token1);
    });

    it('reuses token within the refresh window', async () => {
      fetchMock
        .mockResolvedValueOnce(mockResponse(UPDATE_APPROVED_CORPUS_ITEM_SUCCESS_BODY))
        .mockResolvedValueOnce(mockResponse(UPDATE_APPROVED_CORPUS_ITEM_SUCCESS_BODY));

      // First call primes the cache.
      const promise1 = updateApprovedCorpusItem(UPDATE_APPROVED_CORPUS_ITEM_INPUT);
      await vi.advanceTimersByTimeAsync(0);
      await promise1;

      // Advance 60s (well within 285s window).
      await vi.advanceTimersByTimeAsync(60_000);

      const promise2 = updateApprovedCorpusItem(UPDATE_APPROVED_CORPUS_ITEM_INPUT);
      await vi.advanceTimersByTimeAsync(0);
      await promise2;

      const token1 = extractToken(fetchMock, 0);
      const token2 = extractToken(fetchMock, 1);
      expect(token1).toBe(token2);
    });
  });
});
