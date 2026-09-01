import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.spec.ts', 'src/**/*.integration.ts'],
    // Emulator/container integration tests need headroom over the 5s
    // default, especially when packages run in parallel.
    testTimeout: 30_000,
  },
});
