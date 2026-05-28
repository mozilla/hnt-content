import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/sentry/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
});
