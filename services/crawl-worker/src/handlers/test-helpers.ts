import type {
  CorpusItem,
  CrawlArticleMessage,
  ZyteArticle,
  ZyteResponse,
} from 'crawl-common';

export const TEST_URL = 'https://example.com/article';
export const TEST_SOURCE_URL = 'https://example.com/news';

/** Base ZyteArticle. Tests spread and override specific fields. */
export const ZYTE_ARTICLE: ZyteArticle = {
  url: TEST_URL,
  headline: 'Test Headline',
  description: 'Test description of the article.',
  authors: [{ name: 'Jane Doe' }],
  mainImage: { url: 'https://example.com/image.jpg' },
  articleBody: 'Full article body text here.',
  datePublished: '2025-06-01T12:00:00Z',
  breadcrumbs: [{ name: 'News', url: TEST_SOURCE_URL }],
  inLanguage: 'en',
  metadata: {
    probability: 0.95,
    dateDownloaded: '2025-06-01T12:01:00Z',
  },
};

/** Base ZyteResponse envelope wrapping ZYTE_ARTICLE. */
export const ZYTE_RESPONSE: ZyteResponse<ZyteArticle> = {
  data: ZYTE_ARTICLE,
  url: TEST_URL,
  statusCode: 200,
};

/** Base CrawlArticleMessage for a discovered article. */
export const BASE_MESSAGE: CrawlArticleMessage = {
  url: TEST_URL,
  source_url: TEST_SOURCE_URL,
  crawl_id: 'crawl-001',
  enqueued_at: '2025-06-01T12:00:00Z',
};

/** Base CorpusItem whose title/excerpt match ZYTE_ARTICLE. */
export const CORPUS_ITEM: CorpusItem = {
  external_id: 'ext-123',
  title: 'Test Headline',
  excerpt: 'Test description of the article.',
  authors: [{ name: 'Jane Doe' }],
  status: 'CORPUS',
  language: 'EN',
  publisher: 'Example News',
  image_url: 'https://s3.amazonaws.com/image.jpg',
  topic: 'TECHNOLOGY',
  is_time_sensitive: false,
};

/**
 * Generated 2048-bit RSA JWK used by integration tests that
 * need to sign real JWTs against the Corpus API client. The
 * production key is a runtime secret.
 */
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
