import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * SAFETY: enforce spec §1 invariant 6 — `packages/core` is browser-clean. It must import no
 * Node-only builtins or native modules; all I/O flows through injected ports. This is the
 * discipline that keeps a possible future browser/PWA build (using SQLite-WASM) a build target,
 * not a rewrite.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const coreSrc = path.join(repoRoot, 'packages', 'core', 'src');

const BANNED = [
  'node:',
  'fs',
  'path',
  'os',
  'net',
  'crypto',
  'child_process',
  'worker_threads',
  'http',
  'https',
  'stream',
  'zlib',
  'dns',
  'tls',
  'better-sqlite3',
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('safety: browser-clean core', () => {
  const files = walk(coreSrc);

  it('scans a non-trivial number of core source files', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('imports no Node-only builtins or native modules', () => {
    const importRe = /(?:import[^'"]*from\s*|require\(\s*|import\(\s*)['"]([^'"]+)['"]/g;
    const violations: string[] = [];
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(importRe)) {
        const spec = match[1] ?? '';
        const bare = spec.startsWith('node:') ? spec : spec.split('/')[0];
        if (BANNED.includes(spec) || BANNED.includes(bare ?? '') || spec.startsWith('node:')) {
          violations.push(`${path.relative(repoRoot, file)} imports "${spec}"`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
