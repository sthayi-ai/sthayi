import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runTempDir } from '../../../../tests/helpers/run-temp.js';
import { atomicWrite, createBackup, unsafeConfigPathReason } from './adapter.js';

describe('atomicWrite — preserves target permissions (client-config secret-exposure fix)', () => {
  it('keeps a restrictive 0600 target 0600 after overwrite', () => {
    if (process.platform === 'win32') {
      return; // POSIX modes are meaningless on Windows
    }
    const dir = runTempDir('sthayi-aw-');
    try {
      const target = path.join(dir, 'mcp.json');
      // simulate a client config the user locked down because it holds other servers' API keys
      fs.writeFileSync(target, '{"mcpServers":{}}');
      fs.chmodSync(target, 0o600);

      atomicWrite(target, '{"mcpServers":{"sthayi":{}}}');

      expect(fs.statSync(target).mode & 0o777).toBe(0o600); // not relaxed to 0644
      expect(fs.readFileSync(target, 'utf8')).toContain('sthayi');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('atomicWrite / createBackup — trust-boundary write discipline', () => {
  function withDir(fn: (dir: string) => void): void {
    const dir = runTempDir('sthayi-aw-');
    try {
      fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('REFUSES a symlinked target; the link and its external target are untouched', () => {
    withDir((dir) => {
      const victim = path.join(dir, 'victim.json');
      fs.writeFileSync(victim, 'victim bytes');
      const target = path.join(dir, 'config.json');
      try {
        fs.symlinkSync(victim, target);
      } catch {
        return; // platform without symlink privilege — POSIX runners cover this row
      }
      expect(() => atomicWrite(target, 'attack')).toThrow(/symlink/);
      expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(victim, 'utf8')).toBe('victim bytes');
      // no temp debris either
      expect(fs.readdirSync(dir).filter((f) => f.includes('.sthayi-tmp'))).toEqual([]);
    });
  });

  it('REFUSES a symlinked parent directory', () => {
    withDir((dir) => {
      const real = path.join(dir, 'real');
      fs.mkdirSync(real);
      const linked = path.join(dir, 'linked');
      try {
        fs.symlinkSync(real, linked, 'dir');
      } catch {
        return;
      }
      expect(() => atomicWrite(path.join(linked, 'config.json'), 'x')).toThrow(
        /config directory .* is a symlink/,
      );
      expect(fs.readdirSync(real)).toEqual([]);
    });
  });

  it('REFUSES a target occupied by a non-regular file (directory)', () => {
    withDir((dir) => {
      const target = path.join(dir, 'config.json');
      fs.mkdirSync(target);
      expect(() => atomicWrite(target, 'x')).toThrow(/not a regular file/);
      expect(fs.lstatSync(target).isDirectory()).toBe(true);
    });
  });

  it('unsafeConfigPathReason: absent target in a real dir is safe; absent parent is safe', () => {
    withDir((dir) => {
      expect(unsafeConfigPathReason(path.join(dir, 'fresh.json'))).toBeUndefined();
      expect(unsafeConfigPathReason(path.join(dir, 'not-yet', 'fresh.json'))).toBeUndefined();
    });
  });

  it('createBackup never overwrites or follows an existing path — regenerates instead', () => {
    withDir((dir) => {
      const src = path.join(dir, 'config.json');
      fs.writeFileSync(src, 'the config');
      const now = 1_700_000_000_000;
      const first = createBackup(src, now);
      expect(fs.readFileSync(first, 'utf8')).toBe('the config');
      // same timestamp again: the predictable name is taken, so a random suffix is drawn
      fs.writeFileSync(src, 'the config v2');
      const second = createBackup(src, now);
      expect(second).not.toBe(first);
      expect(fs.readFileSync(first, 'utf8')).toBe('the config'); // untouched
      expect(fs.readFileSync(second, 'utf8')).toBe('the config v2');
    });
  });
});
