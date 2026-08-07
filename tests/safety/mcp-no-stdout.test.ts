import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * SAFETY (mcp-server-ts skill): a stdio MCP server must NEVER write to stdout — `console.log` /
 * `process.stdout.write` corrupt the JSON-RPC stream and show up as "client failed to connect".
 * Diagnostics must go to the file logger. This guards every file under packages/cli/src/mcp/.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mcpDir = path.join(repoRoot, 'packages', 'cli', 'src', 'mcp');

describe('safety: MCP server writes nothing to stdout', () => {
  const files = fs
    .readdirSync(mcpDir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => path.join(mcpDir, f));

  it('scans the mcp source files', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('contains no console.log or process.stdout writes', () => {
    const violations: string[] = [];
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      if (/console\.log\s*\(/.test(src) || /process\.stdout/.test(src)) {
        violations.push(path.relative(repoRoot, file));
      }
    }
    expect(violations).toEqual([]);
  });
});
