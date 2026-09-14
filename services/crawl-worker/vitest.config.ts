import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // minimum ENV values necessary for config to validate
    env: {
      CORPUS_API_JWK_JSON: 'someJson',
      ZYTE_API_KEY: 'zyteApiKey',
      WORKER_ROLE: 'article',
      ENVIRONMENT: 'test',
    },
    include: ['src/**/*.spec.ts', 'src/**/*.integration.ts'],
  },
});
