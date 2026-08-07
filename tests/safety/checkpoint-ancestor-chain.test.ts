import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileCheckpoint } from '../../packages/cli/src/drivers/checkpoint-file.js';
import { removeOwned } from '../helpers/owned-fs.js';
import { runTempDir } from '../helpers/run-temp.js';

/**
 * SAFETY: `FileCheckpoint` — the journal's OUT-OF-DATABASE trust anchor — must validate the WHOLE
 * ancestor chain of the checkpoint path on both the read and the write side, not merely the file
 * itself.
 *
 * The threat: a symlinked directory ANYWHERE above the checkpoint. `O_NOFOLLOW` refuses a symlink
 * at the FINAL component only, and a recursive `mkdir` resolves the entire chain inside the kernel
 * — so `hop -> outside` is enough to have the anchor read from, or materialized in, a tree nothing
 * ever validated. Both directions matter: a read through such a chain lets an attacker CHOOSE the
 * checkpoint Sthayi authenticates against (laundering a truncated or swapped database), and a write
 * plants Sthayi's own anchor, plus the lock file guarding it, inside the attacker's tree.
 *
 * The containing directory is therefore validated one level at a time before anything is created,
 * and observationally (creating nothing) before anything is read.
 */

const posixOnly = describe.skipIf(process.platform === 'win32');

const homes: string[] = [];
function tmpBase(): string {
  // realpath: on macOS os.tmpdir() is itself a symlink (/var -> private/var), and a non-canonical
  // base would trip the very chain check under test for the wrong reason.
  const d = runTempDir('sthayi-ckpt-chain-');
  homes.push(d);
  return d;
}
afterEach(() => {
  for (const h of homes.splice(0)) {
    removeOwned(h);
  }
});

/** Recursive {relative path -> mode} snapshot, for byte/mode-exact "nothing happened" assertions. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (cur: string): void => {
    for (const e of fs
      .readdirSync(cur, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(cur, e.name);
      const rel = path.relative(dir, full);
      const st = fs.lstatSync(full);
      out[rel] = st.isDirectory()
        ? `dir:${(st.mode & 0o777).toString(8)}`
        : `${fs.readFileSync(full, 'utf8')}:${(st.mode & 0o777).toString(8)}`;
      if (st.isDirectory()) {
        walk(full);
      }
    }
  };
  walk(dir);
  return out;
}

const VALID = '{"v":1,"count":1,"tipId":1,"tipHash":"abc","mac":"def"}';

posixOnly('safety: FileCheckpoint refuses a symlinked ancestor at any depth', () => {
  for (const [label, tail] of [
    ['shallow (hop/journal.checkpoint)', [] as string[]],
    ['deep (hop/sub/journal.checkpoint)', ['sub']],
    ['deeper (hop/a/b/journal.checkpoint)', ['a', 'b']],
  ] as const) {
    for (const planted of [true, false]) {
      it(`${label}, checkpoint ${planted ? 'PRESENT' : 'ABSENT'}: read and replace refuse, outside untouched`, () => {
        const base = tmpBase();
        const outside = path.join(base, 'outside');
        const inner = path.join(outside, ...tail);
        fs.mkdirSync(inner, { recursive: true });
        if (planted) {
          fs.writeFileSync(path.join(inner, 'journal.checkpoint'), 'OUTSIDE_CANARY', {
            mode: 0o600,
          });
        }
        fs.symlinkSync(outside, path.join(base, 'hop'));
        const before = snapshot(outside);

        const cp = new FileCheckpoint(path.join(base, 'hop', ...tail, 'journal.checkpoint'));

        // READ: refused, and the planted bytes are never disclosed.
        let readErr = '';
        expect(() => {
          try {
            cp.read();
          } catch (e) {
            readErr = e instanceof Error ? e.message : String(e);
            throw e;
          }
        }).toThrow();
        expect(readErr).not.toContain('OUTSIDE_CANARY');

        // WRITE: refused, and nothing (not even an intermediate dir or a .lock) is created outside.
        expect(() => cp.replace(undefined, VALID)).toThrow();

        expect(snapshot(outside)).toEqual(before);
        expect(fs.existsSync(path.join(inner, 'journal.checkpoint.lock'))).toBe(false);
      });
    }
  }
});

describe('safety: FileCheckpoint healthy canonical path is unchanged', () => {
  it('creates nested directories, round-trips byte-exact, and compare-and-swap still holds', () => {
    const base = tmpBase();
    const cp = new FileCheckpoint(path.join(base, 'nested', 'journal.checkpoint'));

    expect(cp.read()).toBeUndefined(); // absent containing dir is "no external copy", not a throw
    expect(cp.replace(undefined, VALID)).toBe(true);
    expect(cp.read()).toBe(VALID);

    // CAS still refuses a stale expectation, leaving the bytes alone.
    const next = VALID.replace('"count":1', '"count":2');
    expect(cp.replace('WRONG-EXPECTATION', next)).toBe(false);
    expect(cp.read()).toBe(VALID);
    expect(cp.replace(VALID, next)).toBe(true);
    expect(cp.read()).toBe(next);

    if (process.platform !== 'win32') {
      expect(fs.lstatSync(path.join(base, 'nested')).mode & 0o777).toBe(0o700);
      expect(fs.lstatSync(path.join(base, 'nested', 'journal.checkpoint')).mode & 0o777).toBe(
        0o600,
      );
    }
  });
});
