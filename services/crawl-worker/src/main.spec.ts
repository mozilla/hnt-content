import { beforeEach, describe, expect, it, vi } from 'vitest';

// Importing main.ts starts the health server and the article role, so
// every dependency it touches during startup is replaced here.
vi.mock('crawl-common', () => ({
  crawlConfig: {
    environment: 'test',
    corpusApi: {
      endpoint: 'https://admin-api.example.test',
      issuer: 'https://example.test',
      audience: 'https://example.test/',
      jwkJson: '{"kid":"TEST"}',
    },
  },
  initCorpusApiClient: vi.fn(),
}));
vi.mock('pubsub', () => ({
  initPubSubClient: vi.fn(),
  shutdownPubSub: vi.fn(),
}));
vi.mock('sentry', () => ({ initSentry: vi.fn(), shutdownSentry: vi.fn() }));
vi.mock('zyte', () => ({ initZyteClient: vi.fn() }));
vi.mock('./app.js', () => ({
  app: { listen: vi.fn(() => ({ close: vi.fn() })) },
}));
vi.mock('./article-consumer.js', () => ({ startArticleConsumer: vi.fn() }));

import { initCorpusApiClient } from 'crawl-common';
import { startArticleConsumer } from './article-consumer.js';
import { startArticleRole } from './main.js';

describe('startArticleRole', () => {
  beforeEach(() => {
    // Discard the calls made while importing main.ts above.
    vi.clearAllMocks();
  });

  it('starts consuming only after the Corpus API client is ready', async () => {
    let finishInit = () => {};
    vi.mocked(initCorpusApiClient).mockReturnValue(
      new Promise<void>((resolve) => {
        finishInit = resolve;
      }),
    );

    const starting = startArticleRole();
    // A synchronous role branch would consume here, and the first live
    // article would throw on an uninitialized Corpus API client.
    expect(startArticleConsumer).not.toHaveBeenCalled();

    finishInit();
    await starting;
    expect(startArticleConsumer).toHaveBeenCalled();
  });
});
