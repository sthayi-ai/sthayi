import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInit } from '../../packages/cli/src/clients/commands.js';
import { EXIT_COMMITTED_UNANCHORED } from '../../packages/cli/src/store.js';
import { type FakeHome, createFakeHome } from '../helpers/fake-home.js';
import { removeOwned } from '../helpers/owned-fs.js';
import { runTempDir } from '../helpers/run-temp.js';

/**
 * SAFETY: `sthayi init` HAS TWO GATES, AND BOTH RUN BEFORE THE WRITE THEY GUARD.
 *
 * THE TWO, and why the order between them is the whole property:
 *
 *  1. DURABILITY — a CLI entry inside an npm/npx cache or a temp dir cannot be pinned into a
 *     launcher, because the launcher breaks the moment that cache is pruned. This is settled by
 *     PURE READS (`renderLauncher` is the plan half of the launcher write), so it can be settled
 *     before anything at all exists, and it therefore goes FIRST. Settled after the store was
 *     opened, its refusal — which tells the user to install somewhere durable and re-run, i.e.
 *     that this run achieved nothing — arrived over a home holding `sthayi.db`, the vault `key`
 *     and `journal.checkpoint`: a sealed store and a vault key created for an installation the
 *     same breath called uninitialized.
 *
 *  2. THE STARTUP-OUTCOME GATE — opening the store runs the first-run seal, which can COMMIT into
 *     the database while the off-database anchor does not advance. That blocks every further
 *     write, so `init` must not go on to write a launcher, seed skills, rewrite client configs, or
 *     print "Sthayi initialized". It cannot move any earlier than it is: it reports what OPENING
 *     the store committed, so the store has to be opened for it to have an answer.
 *
 * Both orderings are asserted here TOGETHER, because each is easy to restore by breaking the
 * other: hoisting the durability check by folding it into the store open would put a filesystem
 * write in front of it again, and moving the launcher write ahead of the gate would un-fix the
 * blocked-store case. Real SQLite, a real FileCheckpoint, the real `runInit`; the degraded state
 * is forced honestly with a DIRECTORY at `journal.checkpoint.lock`, which no O_CREAT|O_EXCL lock
 * can ever take.
 */

let home: FakeHome;
let clientHome: string;
let previousArgv1: string | undefined;

/** Jam every checkpoint replacement in the home, permanently and deterministically. */
function jam(): void {
  fs.mkdirSync(home.path('journal.checkpoint.lock'), { recursive: true });
}

/** The CLI entry an `npx sthayi` run carries: an `_npx` cache path. It never has to exist — an
 *  entry that cannot be realpathed is judged as the literal path `argv[1]` holds. */
function pinEphemeralEntry(): void {
  process.argv[1] = path.join(
    home.fixture,
    'cache',
    '_npx',
    'deadbeef01',
    'node_modules',
    'sthayi',
    'dist',
    'index.js',
  );
}

/** A durable entry: this checked-out file. Not under the system temp dir, no `_npx`/`_cacache`
 *  segment, not under `npm_config_cache` — the three shapes, and the only three, that are
 *  ephemeral. A fixture under the run's temp root would be refused for a real reason. */
function pinDurableEntry(): void {
  process.argv[1] = fileURLToPath(import.meta.url);
}

/** Capture stdout without leaking the report into the vitest reporter. */
function captureStdout(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  return { text: () => chunks.join(''), restore: () => spy.mockRestore() };
}

describe('safety: init settles durability first, then the startup gate, then writes', () => {
  beforeEach(() => {
    home = createFakeHome();
    // client configs resolve from os.homedir(): isolate so the dev machine's real wiring is
    // neither read nor rewritten by an init that gets as far as detection
    clientHome = runTempDir('sthayi-init-order-');
    vi.spyOn(os, 'homedir').mockReturnValue(clientHome);
    previousArgv1 = process.argv[1];
  });

  afterEach(() => {
    if (previousArgv1 === undefined) {
      process.argv.splice(1, 1);
    } else {
      process.argv[1] = previousArgv1;
    }
    // The gate sets the process exit code; leaving it set would fail the whole run.
    process.exitCode = undefined;
    vi.restoreAllMocks();
    // removeOwned, never a recursive removal primitive: `clientHome` is a runTempDir allocation,
    // so its device/inode is on record and teardown descends only while that record still holds.
    removeOwned(clientHome);
    removeOwned(home.path('journal.checkpoint.lock'));
    home.cleanup();
  });

  it('ORDER 1 — an EPHEMERAL entry is refused before the store is opened at all', async () => {
    // Jammed too, so the two gates are genuinely competing for which one settles this run: the
    // durability refusal is the honest answer, because a store must not be created for a machine
    // that is about to be told nothing was set up.
    jam();
    pinEphemeralEntry();

    const cap = captureStdout();
    let err: unknown;
    try {
      await runInit({ yes: true }).catch((e: unknown) => {
        err = e;
      });
    } finally {
      cap.restore();
    }

    // The DURABILITY gate is the one that spoke, and it says so in three ways: it names the entry
    // it refused, it hands back an install that survives a cache prune, and it never sends the
    // reader back through the cache that caused this.
    const message = (err as Error | undefined)?.message ?? '';
    expect(message).toMatch(/refusing to write a launcher pinned to/);
    expect(message).toMatch(/npm install -g[^\n]*\bsthayi\b/);
    expect(message).not.toMatch(/npx\s+sthayi\s+init/);
    // ONLY the jam this test planted: no database, no vault key, no checkpoint, no bin, no skills
    expect(fs.readdirSync(home.home).sort()).toEqual(['journal.checkpoint.lock']);
    // and the startup gate had nothing to report, because no store was ever opened
    expect(process.exitCode).toBeUndefined();
    expect(cap.text()).not.toMatch(/DEGRADED/);
    expect(cap.text()).not.toMatch(/Sthayi initialized/);
  });

  it('ORDER 2 — a DURABLE entry passes the preflight and still meets the startup gate', async () => {
    jam();
    pinDurableEntry();

    const cap = captureStdout();
    await runInit({ yes: true });
    cap.restore();

    // The seal COMMITTED while the anchor did not advance, so the command did not run, said so,
    // and exited with the committed-unanchored code rather than reporting success.
    expect(process.exitCode).toBe(EXIT_COMMITTED_UNANCHORED);
    expect(cap.text()).toMatch(/DEGRADED/);
    expect(cap.text()).toMatch(/first-run initialization COMMITTED the journal seal/);
    expect(cap.text()).toMatch(/DO NOT RETRY/);
    expect(cap.text()).toMatch(/This command did NOT run/);
    expect(cap.text()).not.toMatch(/Sthayi initialized/);

    // …and nothing downstream of the gate ran
    expect(fs.existsSync(home.path('bin'))).toBe(false);
    expect(fs.existsSync(home.path('skills'))).toBe(false);
    expect(fs.existsSync(home.path('journal.checkpoint'))).toBe(false);

    // The COMMITTED half is real — the report is a reading, not a guess.
    const db = new Database(home.path('sthayi.db'), { readonly: true });
    try {
      const seals = db
        .prepare("SELECT count(*) AS c FROM journal WHERE op = 'journal_seal'")
        .get() as { c: number };
      expect(seals.c).toBe(1);
    } finally {
      db.close();
    }
  });

  it('ORDER 3 — a DURABLE entry on a healthy home initializes: gate clean, then the writes', async () => {
    pinDurableEntry();

    const cap = captureStdout();
    try {
      // no `yes`, and stdin is not a TTY under vitest, so confirm() declines: detection runs
      // against the isolated client home and no config is rewritten
      await runInit({});
    } finally {
      cap.restore();
    }

    expect(process.exitCode).toBeUndefined();
    expect(cap.text()).toMatch(/Sthayi initialized/);
    expect(cap.text()).not.toMatch(/DEGRADED/);
    expect(fs.existsSync(home.path('sthayi.db'))).toBe(true);
    const launcherSuffix = process.platform === 'win32' ? '.cmd' : '';
    expect(fs.existsSync(home.path('bin', `sthayi-mcp${launcherSuffix}`))).toBe(true);
    expect(fs.existsSync(home.path('bin', `sthayi${launcherSuffix}`))).toBe(true);
    expect(fs.existsSync(home.path('skills'))).toBe(true);
    expect(fs.readFileSync(home.path('journal.checkpoint'), 'utf8').length).toBeGreaterThan(0);
  });
});
