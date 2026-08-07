import { defineConfig } from 'tsup';

// The CLI ships as the `sthayi` npm package. Bundle @sthayi/core into it (self-contained npx
// tool); keep the native better-sqlite3 external so its prebuilt binary is resolved at runtime.
export default defineConfig({
  // dist/index.js is intentionally a tiny runtime bootstrap. It rejects unsupported Node majors
  // before dynamically importing the native-dependent CLI implementation.
  entry: { index: 'src/bootstrap.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  noExternal: ['@sthayi/core'],
  external: ['better-sqlite3'],
  banner: { js: '#!/usr/bin/env node' },
  clean: true,
  dts: false,
  sourcemap: true,
});
