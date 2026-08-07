import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runTempDir } from '../../../../tests/helpers/run-temp.js';
import { loadFixtures, loadPrompt, resolvePromptsDir } from './prompts.js';

/** Make a throwaway dir, optionally containing a minimal valid prompt pack. */
function tempDir(withPack: boolean): string {
  const dir = runTempDir('sthayi-prompts-');
  if (withPack) {
    fs.writeFileSync(path.join(dir, 'consolidate@v1.md'), '# a pack\n');
  }
  return dir;
}

const madeDirs: string[] = [];
function make(withPack: boolean): string {
  const dir = tempDir(withPack);
  madeDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of madeDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolvePromptsDir — hardened resolution order', () => {
  it('finds the pack shipped inside the sthayi package by default', () => {
    const dir = resolvePromptsDir();
    expect(dir.split(path.sep).slice(-2).join('/')).toBe('cli/prompts');
    expect(fs.existsSync(path.join(dir, 'consolidate@v1.md'))).toBe(true);
    expect(loadPrompt('consolidate')).toContain('JSON');
    expect(loadFixtures('consolidate').length).toBeGreaterThan(0);
  });

  it('loadPrompt rejects a non-allowlisted op (path-traversal guard)', () => {
    expect(() => loadPrompt('../../../etc/passwd')).toThrow(/unknown oracle prompt/);
    expect(() => loadPrompt('distill/../../secret')).toThrow(/unknown oracle prompt/);
  });

  it('STHAYI_PROMPTS_DIR wins over the packaged pack', () => {
    const explicit = make(true);
    expect(resolvePromptsDir({ explicitDir: explicit })).toBe(path.resolve(explicit));
  });

  it('a set-but-invalid STHAYI_PROMPTS_DIR is a hard error, never a fallback', () => {
    const empty = make(false);
    expect(() => resolvePromptsDir({ explicitDir: empty })).toThrow(/STHAYI_PROMPTS_DIR/);
  });

  // The canary content is detectable: if ANY code path ever reads the planted ./prompts, the
  // returned prompt text would contain it. It never does — the cwd is not a resolution source.
  const CANARY = '# CANARY: planted cwd pack — must never be read\n';

  function plantCwdPack(): string {
    const cwd = make(false);
    fs.mkdirSync(path.join(cwd, 'prompts'));
    fs.writeFileSync(path.join(cwd, 'prompts', 'consolidate@v1.md'), CANARY);
    return cwd;
  }

  /** Run `fn` with process.cwd() moved into `dir` — proves the cwd is never consulted at all. */
  function inCwd<T>(dir: string, fn: () => T): T {
    const prev = process.cwd();
    process.chdir(dir);
    try {
      return fn();
    } finally {
      process.chdir(prev);
    }
  }

  it('a planted malicious ./prompts in the cwd NEVER wins while the packaged pack exists', () => {
    const cwd = plantCwdPack();
    inCwd(cwd, () => {
      const dir = resolvePromptsDir();
      expect(dir.split(path.sep).slice(-2).join('/')).toBe('cli/prompts');
      expect(loadPrompt('consolidate')).not.toContain('CANARY');
    });
  });

  it('packaged pack absent: FAILS CLOSED — actionable error, planted ./prompts is never read', () => {
    const cwd = plantCwdPack();
    inCwd(cwd, () => {
      expect(() => resolvePromptsDir({ packagedDir: undefined })).toThrow(
        /oracle prompt pack missing from this installation/,
      );
      expect(() => resolvePromptsDir({ packagedDir: undefined })).toThrow(/reinstall sthayi/);
    });
  });

  it('packaged dir present but without the pack marker: same fail-closed error', () => {
    const cwd = plantCwdPack();
    const emptyPackaged = make(false);
    inCwd(cwd, () => {
      expect(() => resolvePromptsDir({ packagedDir: emptyPackaged })).toThrow(
        /oracle prompt pack missing from this installation/,
      );
    });
  });
});
