import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // The worker config requires these two variables at startup.
    env: {
      ENVIRONMENT: 'test',
      WORKER_ROLE: 'article',
    },
    include: ['src/**/*.spec.ts', 'src/**/*.integration.ts'],
  },
});
