import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VERSION } from './version.js';

// Version-identity gate: version.ts is the single source of truth consumed by the
// CLI (`--version`) and the MCP server (serverInfo.version). This test pins it to the npm
// manifest so any drift fails `pnpm test` — and therefore `pnpm verify` and the release gate.
describe('version single source of truth', () => {
  it('matches packages/cli/package.json "version"', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(VERSION).toBe(pkg.version);
  });

  it('is a plain X.Y.Z semver (release tags are vX.Y.Z)', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
