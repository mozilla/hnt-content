import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // The worker reads WORKER_ROLE and ENVIRONMENT; provide them for
    // the test run (ENVIRONMENT also drives the derived Pub/Sub names).
    env: { WORKER_ROLE: 'article', ENVIRONMENT: 'test' },
    include: ['src/**/*.spec.ts', 'src/**/*.integration.ts'],
  },
});
