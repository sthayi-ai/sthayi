import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runTempDir } from '../../../../tests/helpers/run-temp.js';
import { FileCheckpoint, manualCheckpointLockRemoval } from './checkpoint-file.js';

/**
 * The external journal checkpoint file is a TRUST ANCHOR: its driver must fail
 * CLOSED. Reads and writes lstat-validate the path first — absent or a regular file owned by
 * us, never a symlink, never group/world-writable — and any violation (or any read error other
 * than absence) THROWS instead of degrading to "no checkpoint", so JournalService.verify()
 * fails instead of treating erased-or-hidden evidence as a pristine state.
 */
describe('FileCheckpoint (fail-closed external checkpoint driver)', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    // realpath: on macOS os.tmpdir() is /var/folders/… and /var is a symlink to /private/var, so a
    // raw mkdtemp path is NON-canonical. The checkpoint driver validates the whole ancestor chain
    // and correctly refuses a symlinked ancestor, so the fixture must name its directory
    // canonically — exactly as a user is told to do for STHAYI_HOME.
    dir = runTempDir('sthayi-cpfile-');
    file = path.join(dir, 'journal.checkpoint');
  });
  afterEach(() => {
    try {
      fs.chmodSync(file, 0o600); // undo chmod 000 so cleanup can rm
    } catch {
      // absent — fine
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips: write then read returns the exact value; absent reads as undefined', () => {
    const cp = new FileCheckpoint(file);
    expect(cp.read()).toBeUndefined();
    cp.write('{"v":1,"count":3}');
    expect(cp.read()).toBe('{"v":1,"count":3}');
    cp.write('{"v":1,"count":4}');
    expect(cp.read()).toBe('{"v":1,"count":4}');
  });

  it('writes atomically: mode 0600, and no tmp files are left behind', () => {
    const cp = new FileCheckpoint(file);
    cp.write('payload');
    if (process.platform !== 'win32') {
      expect(fs.lstatSync(file).mode & 0o777).toBe(0o600);
    }
    expect(fs.readdirSync(dir)).toEqual(['journal.checkpoint']);
  });

  it('REFUSES a symlinked path on read AND write; the link target is never touched', () => {
    const target = path.join(dir, 'attacker-target');
    fs.writeFileSync(target, 'attacker bytes');
    try {
      fs.symlinkSync(target, file);
    } catch {
      return; // platform without symlink privilege — POSIX runners cover this row
    }
    const cp = new FileCheckpoint(file);
    expect(() => cp.read()).toThrow(/symlink — refusing/);
    expect(() => cp.write('overwrite-attempt')).toThrow(/symlink — refusing/);
    // fail closed means fail UNTOUCHED: link still a link, target bytes intact
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('attacker bytes');
  });

  it('REFUSES a path occupied by a non-regular file (directory)', () => {
    fs.mkdirSync(file);
    const cp = new FileCheckpoint(file);
    expect(() => cp.read()).toThrow(/not a regular file/);
    expect(() => cp.write('x')).toThrow(/not a regular file/);
  });

  it.skipIf(process.platform === 'win32')(
    'REFUSES a group- or world-writable checkpoint file',
    () => {
      const cp = new FileCheckpoint(file);
      cp.write('legit');
      fs.chmodSync(file, 0o666);
      expect(() => cp.read()).toThrow(/group- or world-writable/);
      expect(() => cp.write('y')).toThrow(/group- or world-writable/);
      // and the guidance names the fix
      expect(() => cp.read()).toThrow(/chmod 600/);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'an UNREADABLE file (chmod 000) throws on read — unreadable is NOT absent',
    () => {
      const cp = new FileCheckpoint(file);
      cp.write('legit');
      fs.chmodSync(file, 0o000);
      // mode 000 passes the writability check (nobody can write it) but the read itself must
      // surface EACCES rather than return undefined
      expect(() => cp.read()).toThrow(/EACCES|EPERM/);
    },
  );

  // -----------------------------------------------------------------------------------------
  // replace(): compare-and-swap. Callers read the file, validate the bytes, and only then
  // replace them — so the destination can change in between. A blind write in that window
  // destroys tamper evidence and turns a red verification green, which is what these pin.
  // -----------------------------------------------------------------------------------------

  it('replaces when the destination still holds the EXPECTED bytes', () => {
    const cp = new FileCheckpoint(file);
    cp.write('v1');
    expect(cp.replace('v1', 'v2')).toBe(true);
    expect(cp.read()).toBe('v2');
  });

  it('REFUSES and leaves the file BYTE-IDENTICAL when the destination changed under us', () => {
    const cp = new FileCheckpoint(file);
    cp.write('v1');
    // another writer (or an attacker) got there first
    fs.writeFileSync(file, 'swapped-in-evidence', { mode: 0o600 });
    expect(cp.replace('v1', 'v2')).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe('swapped-in-evidence');
  });

  it('expected===undefined means "expect absent": creates when absent, refuses when present', () => {
    const cp = new FileCheckpoint(file);
    expect(cp.replace(undefined, 'created')).toBe(true);
    expect(cp.read()).toBe('created');
    expect(cp.replace(undefined, 'clobber')).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe('created');
  });

  it('a destination that ALREADY holds the desired bytes succeeds without rewriting', () => {
    const cp = new FileCheckpoint(file);
    cp.write('same');
    // stale expectation, but nothing would be destroyed: the bytes are already what we want
    expect(cp.replace('stale-expectation', 'same')).toBe(true);
    expect(cp.read()).toBe('same');
  });

  it('force replaces regardless of the expectation — the explicit reseal trust decision', () => {
    const cp = new FileCheckpoint(file);
    cp.write('v1');
    fs.writeFileSync(file, 'unauthentic', { mode: 0o600 });
    expect(cp.replace('v1', 'resealed', { force: true })).toBe(true);
    expect(cp.read()).toBe('resealed');
  });

  it('every replacement takes the lock and releases it — no lock or tmp debris survives', () => {
    const cp = new FileCheckpoint(file);
    cp.write('v1');
    expect(cp.replace('v1', 'v2')).toBe(true);
    expect(cp.replace('stale', 'v3')).toBe(false);
    cp.write('v4');
    expect(fs.readdirSync(dir)).toEqual(['journal.checkpoint']);
  });

  it('a lock held by a LIVE writer fails closed rather than writing anyway', () => {
    const cp = new FileCheckpoint(file, { lockWaitMs: 25 });
    cp.write('v1');
    fs.writeFileSync(`${file}.lock`, '99999\n', { mode: 0o600 });
    expect(() => cp.replace('v1', 'v2')).toThrow(/held by another writer/);
    expect(fs.readFileSync(file, 'utf8')).toBe('v1'); // untouched — no blind write on refusal
    fs.rmSync(`${file}.lock`);
  });

  it('a lock is NEVER reclaimed by age — an ancient one still fails closed, and survives', () => {
    // Reclaiming "abandoned" locks is what lets one writer delete a live peer's lock: the age is
    // read from an inode that can stop occupying the path before the unlink lands. Nothing is
    // reclaimed on a timer, so a lock of ANY age is still a lock.
    const cp = new FileCheckpoint(file, { lockWaitMs: 25 });
    cp.write('v1');
    const lock = `${file}.lock`;
    fs.writeFileSync(lock, '99999\n', { mode: 0o600 });
    const ancient = new Date(Date.now() - 24 * 60 * 60 * 1000);
    fs.utimesSync(lock, ancient, ancient);
    expect(() => cp.replace('v1', 'v2')).toThrow(/held by another writer/);
    expect(fs.existsSync(lock)).toBe(true); // left for the human, never removed for them
    expect(fs.readFileSync(file, 'utf8')).toBe('v1');
    fs.rmSync(lock);
  });

  it('the fail-closed message carries the pid and a safely quoted manual recovery command', () => {
    // Nothing clears the lock automatically, so the error IS the recovery procedure.
    const cp = new FileCheckpoint(file, { lockWaitMs: 25 });
    cp.write('v1');
    const lock = `${file}.lock`;
    fs.writeFileSync(lock, '99999\n', { mode: 0o600 });
    expect(() => cp.replace('v1', 'v2')).toThrow(/recorded holder pid 99999/);
    expect(() => cp.replace('v1', 'v2')).toThrow(/NEVER reclaimed automatically/);
    expect(() => cp.replace('v1', 'v2')).toThrow(manualCheckpointLockRemoval(lock));
    fs.rmSync(lock);
  });

  it('manual recovery quotes hostile-looking paths for POSIX and Windows shells', () => {
    expect(manualCheckpointLockRemoval("/tmp/a b/it's.lock", 'linux')).toBe(
      `rm -- '/tmp/a b/it'"'"'s.lock'`,
    );
    expect(manualCheckpointLockRemoval("C:\\Users\\A B\\it's.lock", 'win32')).toBe(
      "PowerShell: Remove-Item -LiteralPath 'C:\\Users\\A B\\it''s.lock'",
    );
  });

  it('a garbage lock body degrades to a still-actionable message, never a crash', () => {
    const cp = new FileCheckpoint(file, { lockWaitMs: 25 });
    cp.write('v1');
    const lock = `${file}.lock`;
    fs.writeFileSync(lock, 'x'.repeat(4096), { mode: 0o600 }); // not a pid, and oversized
    expect(() => cp.replace('v1', 'v2')).toThrow(/held by another writer — refusing/);
    expect(() => cp.replace('v1', 'v2')).not.toThrow(/recorded holder/);
    fs.rmSync(lock);
  });

  it('REFUSES a symlink planted at the LOCK path (it is never followed)', () => {
    const cp = new FileCheckpoint(file);
    cp.write('v1');
    const outside = path.join(dir, 'outside-lock-target');
    fs.writeFileSync(outside, 'attacker bytes');
    try {
      fs.symlinkSync(outside, `${file}.lock`);
    } catch {
      return; // platform without symlink privilege — POSIX runners cover this row
    }
    expect(() => cp.replace('v1', 'v2')).toThrow(/lock .* is a symlink|held by another writer/);
    expect(fs.readFileSync(outside, 'utf8')).toBe('attacker bytes');
    expect(fs.readFileSync(file, 'utf8')).toBe('v1');
    fs.unlinkSync(`${file}.lock`);
  });

  it('the read is byte-capped at the descriptor, so a hostile oversize file is refused', () => {
    const cp = new FileCheckpoint(file);
    fs.writeFileSync(file, 'x'.repeat(64 * 1024 + 1), { mode: 0o600 });
    expect(() => cp.read()).toThrow(/over the \d+-byte cap/);
    expect(() => cp.replace(undefined, 'v1')).toThrow(/over the \d+-byte cap/);
    expect(fs.readFileSync(file, 'utf8')).toHaveLength(64 * 1024 + 1);
  });

  it('stale tmp-looking debris from other writers never blocks or corrupts a write', () => {
    // tmp names embed pid + random bytes, so real collisions cannot be arranged — the driver
    // still validates the tmp path and creates it with 'wx' (collision = refusal, not reuse).
    fs.writeFileSync(path.join(dir, 'journal.checkpoint.99999.deadbeef.tmp'), 'stale');
    const cp = new FileCheckpoint(file);
    cp.write('legit');
    expect(cp.read()).toBe('legit');
    // the debris was neither renamed into place nor deleted
    expect(fs.readFileSync(path.join(dir, 'journal.checkpoint.99999.deadbeef.tmp'), 'utf8')).toBe(
      'stale',
    );
  });
});
