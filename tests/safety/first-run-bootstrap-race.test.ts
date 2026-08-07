import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JOURNAL_CHECKPOINT_KEY } from '@sthayi/core';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NodeCrypto } from '../../packages/cli/src/drivers/crypto.js';
import { SqliteDriver } from '../../packages/cli/src/drivers/sqlite.js';
import {
  INSTALL_BOOTSTRAP_ABANDONED,
  INSTALL_BOOTSTRAP_META_KEY,
  INSTALL_BOOTSTRAP_SETTLED,
  INSTALL_BOOTSTRAP_UNSETTLED,
} from '../../packages/cli/src/store.js';
import { ensureBuiltCli } from '../helpers/build-cli.js';
import { removeOwned } from '../helpers/owned-fs.js';
import { runTempDir } from '../helpers/run-temp.js';

/**
 * SAFETY: a first run in flight is not erased history, and erased history is not a first run.
 *
 * THE TWO STATES THAT LOOK IDENTICAL ON DISK. Opening a store mints the vault key before it seals,
 * so on a shared store a process can arrive to find a key file standing over an empty journal with
 * no checkpoint anywhere. That is either (1) a PEER MID-BOOTSTRAP whose key exists because it is
 * initializing this installation right now, or (2) an INITIALIZED INSTALLATION WHOSE HISTORY IS
 * GONE — wiped, truncated, or replaced. The filesystem cannot tell them apart: both show the same
 * three markers over the same empty store. Reading (1) as (2) refuses ordinary concurrent writes on
 * a healthy new store; reading (2) as (1) auto-seals over destroyed history, which is the exact
 * laundering the erased-history refusal exists to prevent. Both directions are unacceptable, so the
 * difference is RECORDED — in the database, where erasing the store erases the record with it.
 *
 * These tests FORCE each interleaving by constructing the state a racing process would observe,
 * rather than by racing processes and hoping: every row below is deterministic.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const distEntry = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');

interface RunResult {
  status: number | null;
  out: string;
}

function runCli(home: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [distEntry, ...args], {
      env: { ...process.env, STHAYI_HOME: home },
      cwd: os.tmpdir(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.on('close', (status) => resolve({ status, out }));
  });
}

describe('safety: first-run bootstrap vs erased history', () => {
  let home: string;

  beforeAll(() => {
    ensureBuiltCli();
  }, 300_000);

  beforeEach(() => {
    // realpath: a STHAYI_HOME reached through any symlink is refused — homes are named by their
    // canonical real path.
    home = runTempDir('sthayi-fr-');
  });

  afterEach(() => {
    removeOwned(home);
  });

  const dbFile = (): string => path.join(home, 'sthayi.db');
  const keyFile = (): string => path.join(home, 'key');
  const cpFile = (): string => path.join(home, 'journal.checkpoint');

  /** Read a meta cell without disturbing anything else. */
  function meta(key: string): string | undefined {
    const driver = SqliteDriver.open(dbFile());
    try {
      return driver.getMeta(key);
    } finally {
      driver.close();
    }
  }

  /**
   * The exact state a process sees when it arrives in the middle of a PEER'S FIRST RUN: the store
   * exists and is migrated, the peer has recorded that it is bootstrapping, and the key it minted
   * is on disk — but nothing has been sealed yet.
   *
   * `claim: false` builds the OTHER state, byte-for-byte identical except for the record: a key
   * file over an empty store with no bootstrap in flight, which is an installation whose journal
   * history was erased.
   */
  function peerMidBootstrap(opts: { claim: boolean }): void {
    const driver = SqliteDriver.open(dbFile());
    try {
      driver.migrate();
      if (opts.claim) {
        driver.writeTransaction(() =>
          driver.setMeta(INSTALL_BOOTSTRAP_META_KEY, INSTALL_BOOTSTRAP_UNSETTLED),
        );
      }
    } finally {
      driver.close();
    }
    NodeCrypto.open(keyFile()); // the key a bootstrapping peer mints before it seals
  }

  it('a peer mid-bootstrap: the key it minted does not refuse the next writer', async () => {
    peerMidBootstrap({ claim: true });

    const added = await runCli(home, ['add', 'a note written while the peer was bootstrapping']);
    expect(added.status, added.out).toBe(0);

    const verified = await runCli(home, ['journal', '--verify']);
    expect(verified.status, verified.out).toBe(0);

    // the bootstrap finished, and the record says so — from here the markers mean what they
    // have always meant
    expect(meta(INSTALL_BOOTSTRAP_META_KEY)).toBe(INSTALL_BOOTSTRAP_SETTLED);
    expect(meta(JOURNAL_CHECKPOINT_KEY)).toBeDefined();
    const driver = SqliteDriver.open(dbFile());
    try {
      expect(driver.countMemories()).toBe(1);
    } finally {
      driver.close();
    }
  }, 60_000);

  it('the same disk state WITHOUT a bootstrap in flight is erased history, and is refused', async () => {
    peerMidBootstrap({ claim: false });

    const added = await runCli(home, ['add', 'a note over an erased installation']);
    expect(added.status).not.toBe(0);
    expect(added.out).toMatch(/erased journal history/);

    // and the refusal wrote nothing: no seal entry, no checkpoint, no memory
    expect(meta(JOURNAL_CHECKPOINT_KEY)).toBeUndefined();
    expect(fs.existsSync(cpFile())).toBe(false);
    const driver = SqliteDriver.open(dbFile());
    try {
      expect(driver.allJournal()).toHaveLength(0);
      expect(driver.countMemories()).toBe(0);
    } finally {
      driver.close();
    }
  }, 60_000);

  it('erasing the store erases the record: a settled installation, wiped, is refused again', async () => {
    // 1. a real, complete first run
    const first = await runCli(home, ['add', 'the history that will be erased']);
    expect(first.status, first.out).toBe(0);
    expect(meta(INSTALL_BOOTSTRAP_META_KEY)).toBe(INSTALL_BOOTSTRAP_SETTLED);

    // 2. erase the installation out of band — the database (and its sidecars) and the anchor,
    //    keeping the key. The bootstrap record lived INSIDE the database, so it goes with it.
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(`${dbFile()}${suffix}`, { force: true });
    }
    fs.rmSync(cpFile(), { force: true });

    // 3. the surviving key is prior-install evidence again, and the refusal is back
    const after = await runCli(home, ['add', 'a note over the wipe']);
    expect(after.status).not.toBe(0);
    expect(after.out).toMatch(/erased journal history/);
    expect(meta(JOURNAL_CHECKPOINT_KEY)).toBeUndefined();
  }, 60_000);

  it('a bootstrap in flight does not license auto-sealing over a surviving anchor', async () => {
    // A complete installation, then the database alone is replaced with an empty one that claims
    // to be bootstrapping — the shape of a whole-database swap dressed up as a first run. The
    // checkpoint file that survives outside the database is the evidence, and it is not this
    // record's to override.
    const first = await runCli(home, ['add', 'the history the anchor still vouches for']);
    expect(first.status, first.out).toBe(0);
    const survivingAnchor = fs.readFileSync(cpFile(), 'utf8');
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(`${dbFile()}${suffix}`, { force: true });
    }
    peerMidBootstrap({ claim: true });

    const added = await runCli(home, ['add', 'a note over the swapped store']);
    expect(added.status).not.toBe(0);
    expect(added.out).toMatch(/checkpoint file/);
    // nothing was sealed, and the surviving anchor was left exactly as it was
    expect(meta(JOURNAL_CHECKPOINT_KEY)).toBeUndefined();
    expect(fs.readFileSync(cpFile(), 'utf8')).toBe(survivingAnchor);
  }, 60_000);

  it("a peer's committed seal whose anchor is still in flight is waited for, not refused", async () => {
    // Reach the exact gap: the seal's database half is committed and durable, and the mirror that
    // puts those bytes OUTSIDE the database has not run yet. A process taking the writer lock in
    // that gap sees an authenticated checkpoint with no file beside it — a state it may never
    // repair itself, because creating the anchor asserts that this history is the real one.
    const first = await runCli(home, ['add', 'the entry whose anchor is in flight']);
    expect(first.status, first.out).toBe(0);
    const anchor = fs.readFileSync(cpFile(), 'utf8');
    fs.rmSync(cpFile());
    const driver = SqliteDriver.open(dbFile());
    try {
      driver.writeTransaction(() =>
        driver.setMeta(INSTALL_BOOTSTRAP_META_KEY, INSTALL_BOOTSTRAP_UNSETTLED),
      );
    } finally {
      driver.close();
    }

    // the peer's mirror lands while the next writer is waiting for it
    const mirrored = new Promise<void>((resolve) => {
      setTimeout(() => {
        fs.writeFileSync(cpFile(), anchor, { mode: 0o600 });
        resolve();
      }, 250);
    });
    const [added] = await Promise.all([runCli(home, ['add', 'the write that waited']), mirrored]);

    expect(added.status, added.out).toBe(0);
    expect(meta(INSTALL_BOOTSTRAP_META_KEY)).toBe(INSTALL_BOOTSTRAP_SETTLED);
    const verified = await runCli(home, ['journal', '--verify']);
    expect(verified.status, verified.out).toBe(0);
  }, 60_000);

  it('an anchor that never arrives is still refused — the wait defers the verdict, never softens it', async () => {
    const first = await runCli(home, ['add', 'the entry whose anchor never arrives']);
    expect(first.status, first.out).toBe(0);
    fs.rmSync(cpFile());
    const driver = SqliteDriver.open(dbFile());
    try {
      driver.writeTransaction(() =>
        driver.setMeta(INSTALL_BOOTSTRAP_META_KEY, INSTALL_BOOTSTRAP_UNSETTLED),
      );
    } finally {
      driver.close();
    }

    const added = await runCli(home, ['add', 'the write nothing outside the database vouches for']);
    expect(added.status).not.toBe(0);
    expect(added.out).toMatch(/NO checkpoint file outside it/);
    // the wait is bounded and its expiry is recorded, so the next process does not spend it again
    expect(meta(INSTALL_BOOTSTRAP_META_KEY)).toBe(INSTALL_BOOTSTRAP_ABANDONED);
    expect(fs.existsSync(cpFile())).toBe(false);
  }, 60_000);

  it('a first run that cannot publish its anchor retires the record instead of stranding it', async () => {
    // A directory at the lock path blocks every write of the checkpoint file, permanently and with
    // no privilege beyond writing the home — the first run's database half commits and its anchor
    // cannot follow.
    fs.mkdirSync(`${cpFile()}.lock`, { recursive: true });

    const added = await runCli(home, ['add', 'a first run that cannot anchor']);
    expect(added.status).not.toBe(0);
    expect(meta(INSTALL_BOOTSTRAP_META_KEY)).toBe(INSTALL_BOOTSTRAP_ABANDONED);

    // abandoned claims nothing: the markers are evidence again, so the store keeps refusing for
    // its own reason rather than being auto-blessed by a record nobody retired
    const again = await runCli(home, ['add', 'a second attempt']);
    expect(again.status).not.toBe(0);
    expect(again.out).toMatch(/checkpoint file|reseal/);
  }, 60_000);
});
