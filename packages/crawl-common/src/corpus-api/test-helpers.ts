/**
 * Shared test fixtures for corpus-api unit and integration
 * tests. Uses a generated 2048-bit RSA JWK (the real private
 * key is a secret loaded at runtime).
 */
import type { UpdateApprovedCorpusItemInput } from './types.js';

export const TEST_JWK = JSON.stringify({
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

export const CLIENT_OPTS = {
  endpoint: 'https://admin-api.test/',
  jwkJson: TEST_JWK,
  issuer: 'https://getpocket.com',
  audience: 'https://admin-api.test/',
};

export const UPDATE_APPROVED_CORPUS_ITEM_INPUT: UpdateApprovedCorpusItemInput =
  {
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

export const UPDATE_APPROVED_CORPUS_ITEM_SUCCESS_BODY = {
  data: {
    updateApprovedCorpusItem: {
      externalId: 'abc-123',
      url: 'https://example.com/article',
      title: 'Test Title',
      excerpt: 'Test Excerpt',
    },
  },
};

export function mockResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export const SCHEDULED_SURFACE_GUID = 'NEW_TAB_EN_US';

const LIVE_1 = {
  externalId: 'ext-1',
  url: 'https://example.com/live-1',
  title: 'Live One',
  excerpt: 'Excerpt one.',
  authors: [{ name: 'Jane Doe' }],
  status: 'CORPUS',
  language: 'EN',
  publisher: 'Example News',
  imageUrl: 'https://s3.amazonaws.com/live-1.jpg',
  topic: 'TECHNOLOGY',
  isTimeSensitive: false,
};

/**
 * getSectionsWithSectionItems response with two LIVE sections (the
 * second repeats LIVE_1 to exercise URL de-duplication) plus a DISABLED
 * and a SCHEDULED (not-yet-live) section whose items must be skipped.
 */
export const SECTION_ITEMS_SUCCESS_BODY = {
  data: {
    getSectionsWithSectionItems: [
      {
        status: 'LIVE',
        sectionItems: [
          { approvedItem: LIVE_1 },
          {
            approvedItem: {
              externalId: 'ext-2',
              url: 'https://example.com/live-2',
              title: 'Live Two',
              excerpt: 'Excerpt two.',
              authors: [{ name: 'John Roe' }, { name: 'Amy Lee' }],
              status: 'CORPUS',
              language: 'DE',
              publisher: 'Example DE',
              imageUrl: 'https://s3.amazonaws.com/live-2.jpg',
              topic: 'SCIENCE',
              isTimeSensitive: true,
            },
          },
        ],
      },
      {
        status: 'LIVE',
        sectionItems: [
          { approvedItem: LIVE_1 },
          {
            approvedItem: {
              externalId: 'ext-3',
              url: 'https://example.com/live-3',
              title: 'Live Three',
              excerpt: 'Excerpt three.',
              authors: [],
              status: 'RECOMMENDATION',
              language: 'FR',
              publisher: 'Example FR',
              imageUrl: 'https://s3.amazonaws.com/live-3.jpg',
              topic: 'BUSINESS',
              isTimeSensitive: false,
            },
          },
        ],
      },
      {
        status: 'DISABLED',
        sectionItems: [
          {
            approvedItem: {
              externalId: 'ext-4',
              url: 'https://example.com/disabled',
              title: 'Disabled',
              excerpt: 'Skip me.',
              authors: [{ name: 'Nobody' }],
              status: 'CORPUS',
              language: 'EN',
              publisher: 'Example',
              imageUrl: 'https://s3.amazonaws.com/x.jpg',
              topic: 'NEWS',
              isTimeSensitive: false,
            },
          },
        ],
      },
      {
        status: 'SCHEDULED',
        sectionItems: [
          {
            approvedItem: {
              externalId: 'ext-5',
              url: 'https://example.com/scheduled',
              title: 'Scheduled',
              excerpt: 'Not live yet.',
              authors: [{ name: 'Future' }],
              status: 'CORPUS',
              language: 'EN',
              publisher: 'Example',
              imageUrl: 'https://s3.amazonaws.com/s.jpg',
              topic: 'NEWS',
              isTimeSensitive: false,
            },
          },
        ],
      },
    ],
  },
};
