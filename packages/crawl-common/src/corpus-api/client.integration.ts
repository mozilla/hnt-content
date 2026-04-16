import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  initCorpusApiClient,
  updateApprovedCorpusItem,
  CorpusApiError,
  RETRY_MAX_TIMEOUT_MS,
} from './client.js';
import type { UpdateApprovedCorpusItemInput } from './types.js';

// 2048-bit RSA JWK for testing, generated with jose.
const TEST_JWK = JSON.stringify({
  kty: 'RSA',
  kid: 'test-kid',
  n: 'tlGRF0xXZdfLwe6wLslVERpJS5oH7ZL2UD33DDkx_S__GaHYx2VesvKn5qQ3j1SWgO3VBJV8i2YXpj6xPpZ8Kj34TbuAFO4klTZ1oy8FxyH-yUC56OJi2FlmqIz9zOWVMpkvwWweZcXms1QaPHxCjPix8LaAd1y0_urXnMvbZvgFtgqV3Gv1-rO2hM_VNIgCzZCFQ8Iz1viHAAgdIoOm6Bs7i6skzw0XTC_gv-ZDQmVSsKb6RNQL3Lyto2rbnOmMWt5zxndwZ-AP7UzZuJbR77OphFnUsN0hyL3-ShKMbo8pIQPrJs-B3GAplMCWkxpvyKBqDvYVXt9vrrou_YrITw',
  e: 'AQAB',
  d: 'WIEEE_FFQ_UbvormD_BAUUsXZZHiY1vCInXSJabmM2hHR-QfXbxB2lCdXQM-zV9cqD3L-Kuwh-MJe_RXCnD22XK3xNROetqX-68yMAM1pNNF4eB_3yN2pFvRz-SRmBOi96sRWa3om7MUKN2c1tvjWpenmZieiFMCsfTCsiTr3vGYrnydPGTB5AJlG_lAKLCX8ta9bDwQK5kJLcc8JyP0Tivwv6Dh0u_wCpc7Iiiq_SmQKLrAvFeJZaF2evh3OY_0zIYREGBKOwooTTnRy0QURTwaiWl7P4PwDDERd0og1Lcar2dj5JHGtcUw0qgbTGz4Du6jzy6-ieWRLoXqeumU0Q',
  p: '8IML8lVMrnMDQqylf2fAO0iU6ge80zDvL8dIVWpTfJsBkvL6_eNZkeqC72f3xxH_xSQbdOGKYNDacCQcR2ChMQAn4LKsKE7s7NPmQnE6p36l-GsvwhUWQUXR7Z_A9cTF3k77qyDjK7E9EQ_u_jKsgv2YGl7CRTz_7VByQbf7lks',
  q: 'wg8tFkRFCFcydpfqw7xDKdbo1tZMQA_XgkPuSoI5wu5rgMCWQw29s0rL4HM-cdeeyXqgJCRPwOybaWGCm59H1sWZew_rtIqI7M34JhmnxuiX444ySoqo7jCcW0WoJ5xpv-3XXRKC0Si1MC10m2oAvhMHhEiONnMtQ7tCuHZOY40',
  dp: '6-nfIgkBemxeWlw2yc3fBUegqh6E3TM2qsry7LWqxqLU3GtyPu9uwG4jmOmGZcIF_D36oJ9KuMSkPzNseacS9ZmNhB4-OBuS0orXZXzjZ8AW1KFu6xT8C3KNBGSbRXeKDxGyUp2jtwvXNpFGgBj8llBhjhw8uuWmtAUgzc3F_hk',
  dq: 'kQnyss-3oLI7PzPv_Pc6Y40CXX-xYbf1ZKEM-pc2QKEdrA9Evz0H6XcfxdOcek2jmgaSpjCVgyXUSgDdMx7q_HSXb8jIbBmWmRagPymxohK5YxQmNlxIQi4GzpjTQze-OfqzmhZ5u4XnVejDXFzvzSA_3_iygbO3wwW0qlWR5Qk',
  qi: '1l7lV0YqJuRptrOKwbhna6O2OavR7xxmSI2HUzkM45tEjmaZ-w9VcQ_XkTNUZEbkk-qioNMmUVGYwW30sWkMiVI2RC_ybsaFmJ61VvfUp_0j7jg_6KsFJ6UXoDDOL1kB2bWoI0DyLe3tLcVxfjTehmNAVr51w9I9JzCT6Y4DS4o',
});

const CLIENT_OPTS = {
  endpoint: 'https://admin-api.test/',
  jwkJson: TEST_JWK,
  issuer: 'https://getpocket.com',
  audience: 'https://admin-api.test/',
};

const SAMPLE_INPUT: UpdateApprovedCorpusItemInput = {
  externalId: 'abc-123',
  title: 'Test Title',
  excerpt: 'Test Excerpt',
  authors: [{ name: 'Jane Doe', sortOrder: 0 }],
  status: 'CORPUS',
  language: 'EN',
  publisher: 'Test Publisher',
  imageUrl: 'https://s3.amazonaws.com/image.jpg',
  topic: 'TECHNOLOGY',
  isTimeSensitive: false,
};

const SUCCESS_BODY = {
  data: {
    updateApprovedCorpusItem: {
      externalId: 'abc-123',
      url: 'https://example.com/article',
      title: 'Test Title',
      excerpt: 'Test Excerpt',
    },
  },
};

function mockResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

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
      fetchMock.mockResolvedValueOnce(mockResponse(SUCCESS_BODY));
      await updateApprovedCorpusItem(SAMPLE_INPUT);
      fetchMock.mockReset();
      vi.useFakeTimers();
    });

    it('retries on 5xx and succeeds', async () => {
      fetchMock
        .mockResolvedValueOnce(mockResponse({ error: 'server' }, 503))
        .mockResolvedValueOnce(mockResponse(SUCCESS_BODY));

      const promise = updateApprovedCorpusItem(SAMPLE_INPUT);
      await vi.advanceTimersByTimeAsync(RETRY_MAX_TIMEOUT_MS);
      const result = await promise;

      expect(result.externalId).toBe('abc-123');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('retries on network error and succeeds', async () => {
      fetchMock
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(mockResponse(SUCCESS_BODY));

      const promise = updateApprovedCorpusItem(SAMPLE_INPUT);
      await vi.advanceTimersByTimeAsync(RETRY_MAX_TIMEOUT_MS);
      const result = await promise;

      expect(result.externalId).toBe('abc-123');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('stops after max retries', async () => {
      fetchMock.mockResolvedValue(
        mockResponse({ error: 'down' }, 500),
      );

      const promise = updateApprovedCorpusItem(SAMPLE_INPUT).catch(
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
      fetchMock.mockResolvedValueOnce(mockResponse(SUCCESS_BODY));
      const promise1 = updateApprovedCorpusItem(SAMPLE_INPUT);
      await vi.advanceTimersByTimeAsync(0);
      await promise1;

      const token1 = extractToken(fetchMock, 0);

      // Advance past the refresh window (300s * 0.95 = 285s).
      await vi.advanceTimersByTimeAsync(286_000);

      // Second call should issue a new token.
      fetchMock.mockResolvedValueOnce(mockResponse(SUCCESS_BODY));
      const promise2 = updateApprovedCorpusItem(SAMPLE_INPUT);
      await vi.advanceTimersByTimeAsync(0);
      await promise2;

      const token2 = extractToken(fetchMock, 1);
      expect(token2).not.toBe(token1);
    });

    it('reuses token within the refresh window', async () => {
      fetchMock
        .mockResolvedValueOnce(mockResponse(SUCCESS_BODY))
        .mockResolvedValueOnce(mockResponse(SUCCESS_BODY));

      // First call primes the cache.
      const promise1 = updateApprovedCorpusItem(SAMPLE_INPUT);
      await vi.advanceTimersByTimeAsync(0);
      await promise1;

      // Advance 60s (well within 285s window).
      await vi.advanceTimersByTimeAsync(60_000);

      const promise2 = updateApprovedCorpusItem(SAMPLE_INPUT);
      await vi.advanceTimersByTimeAsync(0);
      await promise2;

      const token1 = extractToken(fetchMock, 0);
      const token2 = extractToken(fetchMock, 1);
      expect(token1).toBe(token2);
    });
  });
});
