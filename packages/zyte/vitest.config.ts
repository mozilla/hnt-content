import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.spec.ts', 'src/**/*.integration.ts'],
    // The retry integration test drives fake timers; keep the same
    // headroom the other packages use for parallel runs.
    testTimeout: 30_000,
  },
});
