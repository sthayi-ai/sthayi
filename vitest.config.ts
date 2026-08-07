import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@sthayi/core': path.resolve(__dirname, 'packages/core/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['packages/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Backstop against leaked scratch homes: a temp home is created per CALL, so a helper used in
    // a loop (or a test that throws before its teardown) leaves a directory no afterEach reaches.
    // A leaked home can hold a vault key, a database and a journal in a shared temp root, so the
    // suite removes anything sthayi-* it created. Per-suite teardown is still the primary mechanism.
    globalSetup: [path.resolve(__dirname, 'tests/helpers/temp-sweep.ts')],
  },
});
