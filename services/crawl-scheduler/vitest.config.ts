import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // ENVIRONMENT names the Pub/Sub topic the tick publishes to.
    env: {
      ENVIRONMENT: 'test',
    },
    include: ['src/**/*.spec.ts'],
  },
});
