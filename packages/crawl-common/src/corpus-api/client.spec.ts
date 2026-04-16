import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  initCorpusApiClient,
  updateApprovedCorpusItem,
  CorpusApiError,
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

const SUCCESS_RESPONSE = {
  data: {
    updateApprovedCorpusItem: {
      externalId: 'abc-123',
      url: 'https://example.com/article',
      title: 'Test Title',
      excerpt: 'Test Excerpt',
    },
  },
};

let fetchMock: ReturnType<typeof vi.fn>;

function mockResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('corpus-api client', () => {
  beforeEach(async () => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await initCorpusApiClient({
      endpoint: 'https://admin-api.test/',
      jwkJson: TEST_JWK,
      issuer: 'https://getpocket.com',
      audience: 'https://admin-api.test/',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('request', () => {
    it('sends a GraphQL mutation with JWT auth', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(SUCCESS_RESPONSE));

      await updateApprovedCorpusItem(SAMPLE_INPUT);

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
      fetchMock.mockResolvedValueOnce(mockResponse(SUCCESS_RESPONSE));

      await updateApprovedCorpusItem(SAMPLE_INPUT);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body.variables.data.externalId).toBe('abc-123');
      expect(body.variables.data.title).toBe('Test Title');
      expect(body.query).toContain('updateApprovedCorpusItem');
    });
  });

  describe('response', () => {
    it('returns the mutation result on success', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(SUCCESS_RESPONSE));

      const result = await updateApprovedCorpusItem(SAMPLE_INPUT);

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
          updateApprovedCorpusItem(SAMPLE_INPUT),
        ).rejects.toThrow(CorpusApiError);
        expect(fetchMock).toHaveBeenCalledOnce();
      },
    );
  });

  describe('jwt', () => {
    it('caches the JWT token across calls', async () => {
      fetchMock
        .mockResolvedValueOnce(mockResponse(SUCCESS_RESPONSE))
        .mockResolvedValueOnce(mockResponse(SUCCESS_RESPONSE));

      await updateApprovedCorpusItem(SAMPLE_INPUT);
      await updateApprovedCorpusItem(SAMPLE_INPUT);

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
        endpoint: 'https://admin-api.test/',
        jwkJson: wrapped,
        issuer: 'https://getpocket.com',
        audience: 'https://admin-api.test/',
      });
      fetchMock.mockResolvedValueOnce(mockResponse(SUCCESS_RESPONSE));

      const result = await updateApprovedCorpusItem(SAMPLE_INPUT);

      expect(result.externalId).toBe('abc-123');
    });

    it('includes kid in the JWT header', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(SUCCESS_RESPONSE));

      await updateApprovedCorpusItem(SAMPLE_INPUT);

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
