import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runTempDir } from '../../../../tests/helpers/run-temp.js';
import { NodeCrypto } from './crypto.js';

/**
 * The vault key file is a TRUST ANCHOR (same family as checkpoint-file): open/loadExisting
 * lstat-validate the path before ANY use — absent or a regular file owned by us with NO
 * group/world access, never a symlink — and violations THROW without modifying anything.
 * The atomic 'wx' first-run creation and its EEXIST race handling stay intact.
 */
describe('NodeCrypto key-file trust validation (fail closed)', () => {
  let dir: string;
  let keyFile: string;

  beforeEach(() => {
    // realpath: os.tmpdir() is itself reached through a symlink on macOS (/var -> private/var),
    // and the key path's WHOLE ancestor chain is validated before any read or create. A canonical
    // fixture is the honest baseline; the hostile rows below plant their own links explicitly.
    dir = runTempDir('sthayi-crypto-');
    keyFile = path.join(dir, 'key');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('healthy path unchanged: open creates a 0600 32-byte key; reopen + loadExisting share it', () => {
    const a = NodeCrypto.open(keyFile);
    expect(fs.lstatSync(keyFile).isFile()).toBe(true);
    expect(fs.readFileSync(keyFile).length).toBe(32);
    if (process.platform !== 'win32') {
      expect(fs.lstatSync(keyFile).mode & 0o777).toBe(0o600);
    }
    const blob = a.encrypt('the canonical entity');
    expect(NodeCrypto.open(keyFile).decrypt(blob)).toBe('the canonical entity');
    expect(NodeCrypto.loadExisting(keyFile).decrypt(blob)).toBe('the canonical entity');
    expect(a.mac('x')).toBe(NodeCrypto.loadExisting(keyFile).mac('x'));
  });

  it('REFUSES a symlinked key on open AND loadExisting; link and target are never touched', () => {
    const target = path.join(dir, 'attacker-key');
    const targetBytes = Buffer.alloc(32, 7);
    fs.writeFileSync(target, targetBytes);
    try {
      fs.symlinkSync(target, keyFile);
    } catch {
      return; // platform without symlink privilege — POSIX runners cover this row
    }
    expect(() => NodeCrypto.open(keyFile)).toThrow(/symlink — refusing to use it/);
    expect(() => NodeCrypto.open(keyFile)).toThrow(/restore the real key file/);
    expect(() => NodeCrypto.loadExisting(keyFile)).toThrow(/symlink — refusing to use it/);
    // fail closed means fail UNTOUCHED: still a symlink, target bytes intact, no new key minted
    expect(fs.lstatSync(keyFile).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target).equals(targetBytes)).toBe(true);
    expect(fs.readdirSync(dir).sort()).toEqual(['attacker-key', 'key']);
  });

  it.skipIf(process.platform === 'win32')('REFUSES a group-readable key (chmod 0640)', () => {
    NodeCrypto.open(keyFile); // create a healthy key first
    const before = fs.readFileSync(keyFile);
    fs.chmodSync(keyFile, 0o640);
    expect(() => NodeCrypto.open(keyFile)).toThrow(/group- or world-accessible/);
    expect(() => NodeCrypto.loadExisting(keyFile)).toThrow(/group- or world-accessible/);
    expect(() => NodeCrypto.open(keyFile)).toThrow(new RegExp(`chmod 600 ${keyFile}`));
    // nothing was rewritten or re-keyed
    expect(fs.readFileSync(keyFile).equals(before)).toBe(true);
    expect(fs.lstatSync(keyFile).mode & 0o777).toBe(0o640);
  });

  it.skipIf(process.platform === 'win32')('REFUSES a world-readable key (chmod 0644)', () => {
    NodeCrypto.open(keyFile);
    fs.chmodSync(keyFile, 0o644);
    expect(() => NodeCrypto.open(keyFile)).toThrow(/group- or world-accessible/);
    expect(() => NodeCrypto.loadExisting(keyFile)).toThrow(/refusing to use it/);
  });

  it('REFUSES a path occupied by a non-regular file (directory), modifying nothing', () => {
    fs.mkdirSync(keyFile);
    fs.writeFileSync(path.join(keyFile, 'inner'), 'x');
    expect(() => NodeCrypto.open(keyFile)).toThrow(/not a regular file/);
    expect(() => NodeCrypto.loadExisting(keyFile)).toThrow(/not a regular file/);
    expect(fs.lstatSync(keyFile).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(keyFile, 'inner'), 'utf8')).toBe('x');
  });

  it('EEXIST race handling intact: a pre-existing healthy key is loaded, never replaced', () => {
    const key = Buffer.alloc(32, 3);
    fs.writeFileSync(keyFile, key, { mode: 0o600 });
    const c = NodeCrypto.open(keyFile);
    expect(fs.readFileSync(keyFile).equals(key)).toBe(true);
    expect(c.decrypt(c.encrypt('roundtrip'))).toBe('roundtrip');
  });

  it('malformed length still throws the actionable byte-count error', () => {
    fs.writeFileSync(keyFile, Buffer.alloc(8), { mode: 0o600 });
    expect(() => NodeCrypto.open(keyFile)).toThrow(/32-byte key \(found 8 bytes\)/);
    expect(() => NodeCrypto.loadExisting(keyFile)).toThrow(/32-byte key/);
  });

  it('loadExisting on an ABSENT key still throws the restore-from-backup error, creating nothing', () => {
    expect(() => NodeCrypto.loadExisting(keyFile)).toThrow(/restore it from backup/);
    expect(fs.existsSync(keyFile)).toBe(false);
  });
});
