import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

/** Import a fresh config module with the given environment applied. */
async function loadConfig(environment: string | undefined) {
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV, ENVIRONMENT: environment };
  return (await import('./config.js')).default;
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe('crawl-common config', () => {
  it('prefixes Pub/Sub names with the environment', async () => {
    const config = await loadConfig('dev');
    expect(config.crawlArticleSubscription).toBe('dev-crawl-article');
    expect(config.articlesTopic).toBe('dev-articles');
  });

  // A nonprod deploy should not reach the production corpus.
  it('only points at the prod Corpus API in prod', async () => {
    const prod = await loadConfig('prod');
    const stage = await loadConfig('stage');
    expect(prod.corpusApi.endpoint).toContain('getpocket.com');
    expect(stage.corpusApi.endpoint).toContain('getpocket.dev');
  });
});
