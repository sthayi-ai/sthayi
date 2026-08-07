import { defineConfig } from 'tsup';

// Core is browser-clean: platform 'neutral' so nothing Node-specific is assumed.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'neutral',
  clean: true,
  dts: true,
  sourcemap: true,
});
