import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  planInit,
  runInit,
  runStatus,
  runUnwire,
  runWire,
} from '../../packages/cli/src/clients/commands.js';
import { launcherHealth, writeLauncher } from '../../packages/cli/src/clients/launcher.js';
import {
  clearClientState,
  getClientState,
  readState,
  setClientState,
} from '../../packages/cli/src/clients/state.js';
import { runDoctor } from '../../packages/cli/src/doctor.js';
import { fileLog } from '../../packages/cli/src/mcp/logger.js';
import {
  assertReadOnlySthayiHome,
  ensureSthayiHome,
  sthayiHomeRoot,
} from '../../packages/cli/src/paths.js';
import { openStore, openStoreReadOnly } from '../../packages/cli/src/store.js';
import { distEntry, ensureBuiltCli } from '../helpers/build-cli.js';
import { type FakeHome, createFakeHome } from '../helpers/fake-home.js';
import { removeOwned } from '../helpers/owned-fs.js';
import { runTempDir } from '../helpers/run-temp.js';

/**
 * SAFETY: the STHAYI_HOME trust boundary is the WHOLE PATH, not just the final component and not
 * just its immediate parent. A storage location reached through a symlink at ANY depth is REFUSED
 * — before any chmod, mkdir, read or write — because a link in the chain is a handle the attacker
 * keeps: they can repoint it after validation and move the store, the vault key, the journal
 * checkpoint, the launcher and the wiring ledger into a tree Sthayi never checked. A user who
 * wants their state on another volume names that volume's CANONICAL REAL PATH.
 *
 * Shapes covered here:
 *  - a symlink as the IMMEDIATE parent (`hop/home`) and at INTERMEDIATE depth (`hop/sub/home`,
 *    `hop/a/b/c/home`), for an EXISTING home and a MISSING one;
 *  - the WRITABLE command paths (openStore, wire, init, pack, ledger set/clear, writeLauncher)
 *    and the OBSERVATIONAL ones (openStoreReadOnly, doctor, status, unwire, every dry-run,
 *    launcherHealth, ledger read);
 *  - the ESTABLISHED home DELETED AND RECREATED at the same path mid-process — a different
 *    directory wearing the validated name — refused by every writable and observational caller;
 *  - an npx-shaped `writeLauncher()` flow: nothing lands outside the home, no partial runtime copy
 *    survives, and both launchers stay ABSENT on refusal;
 *  - an OUTSIDE CANARY that must be neither READ nor CHANGED: its bytes and mode stay identical
 *    and its content never appears in any command's output.
 *
 * Every refusal assertion compares a full recursive snapshot of the outside tree — bytes AND
 * permission bits AND the set of paths — taken before and after.
 */

const posixOnly = describe.skipIf(process.platform === 'win32');

const CANARY = 'OUTSIDE CANARY — sthayi must neither read nor change this\n';

/** Recursive snapshot: relative path → kind + permission bits + (file) bytes / (link) target.
 *  Byte-identical AND mode-identical AND path-set-identical in one comparison. */
type Snapshot = Record<string, string>;

function snapshotDeep(dir: string): Snapshot {
  const out: Snapshot = {};
  const describeEntry = (full: string): string => {
    const st = fs.lstatSync(full);
    const mode = (st.mode & 0o777).toString(8);
    if (st.isSymbolicLink()) {
      return `link:${mode}:${fs.readlinkSync(full)}`;
    }
    if (st.isDirectory()) {
      return `dir:${mode}`;
    }
    return `file:${mode}:${fs.readFileSync(full, 'utf8')}`;
  };
  const walk = (current: string, rel: string): void => {
    for (const e of fs
      .readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, e.name);
      const r = rel === '' ? e.name : `${rel}/${e.name}`;
      out[r] = describeEntry(full);
      if (!e.isSymbolicLink() && e.isDirectory()) {
        walk(full, r);
      }
    }
  };
  out['.'] = describeEntry(dir);
  walk(dir, '');
  return out;
}

/** Plant an outside victim tree with a canary file: a loose directory mode and a loose file mode,
 *  so a chmod "repair" or a write through a link would be visible in the snapshot. */
function plantOutside(root: string, ...subdirs: string[]): string {
  const dir = path.join(root, ...subdirs);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'canary.txt'), CANARY);
  if (process.platform !== 'win32') {
    fs.chmodSync(path.join(dir, 'canary.txt'), 0o666);
    fs.chmodSync(dir, 0o755);
  }
  return dir;
}

/** Run `fn` with STHAYI_HOME pointed at `home`, restoring the previous value afterwards. */
function withHome<T>(home: string, fn: () => T): T {
  const saved = process.env.STHAYI_HOME;
  process.env.STHAYI_HOME = home;
  try {
    return fn();
  } finally {
    if (saved === undefined) {
      // biome-ignore lint/performance/noDelete: assigning undefined coerces to the string "undefined".
      delete process.env.STHAYI_HOME;
    } else {
      process.env.STHAYI_HOME = saved;
    }
  }
}

/** Async form of withHome. The sync one restores the env var as soon as `fn` yields, which would
 *  silently run the rest of an async body against the OUTER home. */
async function withHomeAsync<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.STHAYI_HOME;
  process.env.STHAYI_HOME = home;
  try {
    return await fn();
  } finally {
    if (saved === undefined) {
      // biome-ignore lint/performance/noDelete: assigning undefined coerces to the string "undefined".
      delete process.env.STHAYI_HOME;
    } else {
      process.env.STHAYI_HOME = saved;
    }
  }
}

/** Capture stdout so a refusal path can be checked for canary leakage without polluting the
 *  reporter. */
function captureStdout(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  return { text: () => chunks.join(''), restore: () => spy.mockRestore() };
}

posixOnly('safety: an ancestor symlink at ANY depth refuses every storage entry point', () => {
  let home: FakeHome;
  let clientHome: string;

  beforeEach(() => {
    home = createFakeHome();
    // Client configs resolve from os.homedir() — isolate so the real machine's wiring can never
    // be read or written by these probes.
    clientHome = runTempDir('sthayi-hb-client-');
    vi.spyOn(os, 'homedir').mockReturnValue(clientHome);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    removeOwned(clientHome);
    home.cleanup();
  });

  interface Shape {
    name: string;
    /** builds the outside tree, returns [outsideRoot, plantedHomePath] */
    plant: () => { outside: string; home: string };
  }

  const shapes: Shape[] = [
    {
      name: 'IMMEDIATE parent is a symlink, home EXISTS',
      plant: () => {
        const outside = home.path('o-shallow-existing');
        plantOutside(outside, 'the-home');
        fs.symlinkSync(outside, home.path('hop-shallow-existing'), 'dir');
        return { outside, home: home.path('hop-shallow-existing', 'the-home') };
      },
    },
    {
      name: 'IMMEDIATE parent is a symlink, home MISSING',
      plant: () => {
        const outside = home.path('o-shallow-missing');
        plantOutside(outside);
        fs.symlinkSync(outside, home.path('hop-shallow-missing'), 'dir');
        return { outside, home: home.path('hop-shallow-missing', 'new-home') };
      },
    },
    {
      name: 'INTERMEDIATE symlink two levels up, home EXISTS',
      plant: () => {
        const outside = home.path('o-deep-existing');
        plantOutside(outside, 'sub', 'the-home');
        fs.symlinkSync(outside, home.path('hop-deep-existing'), 'dir');
        return { outside, home: home.path('hop-deep-existing', 'sub', 'the-home') };
      },
    },
    {
      name: 'INTERMEDIATE symlink two levels up, home MISSING (parent is a real dir through it)',
      plant: () => {
        const outside = home.path('o-deep-missing');
        plantOutside(outside, 'sub');
        fs.symlinkSync(outside, home.path('hop-deep-missing'), 'dir');
        return { outside, home: home.path('hop-deep-missing', 'sub', 'new-home') };
      },
    },
    {
      name: 'INTERMEDIATE symlink FOUR levels up, home MISSING',
      plant: () => {
        const outside = home.path('o-deeper-missing');
        plantOutside(outside, 'a', 'b', 'c');
        fs.symlinkSync(outside, home.path('hop-deeper-missing'), 'dir');
        return { outside, home: home.path('hop-deeper-missing', 'a', 'b', 'c', 'new-home') };
      },
    },
  ];

  for (const shape of shapes) {
    it(`${shape.name} → every WRITABLE path refuses; the outside tree is byte- and mode-identical`, () => {
      const { outside, home: planted } = shape.plant();
      const before = snapshotDeep(outside);

      withHome(planted, () => {
        // the validators themselves
        expect(() => ensureSthayiHome()).toThrow(/symlink/);
        // every writable public caller that reaches storage
        expect(() => openStore()).toThrow(/symlink/);
        expect(() => writeLauncher()).toThrow(/symlink/);
        expect(() => runWire()).toThrow(/symlink/);
        expect(() =>
          setClientState('codex', { backupPath: null, existedBefore: false, wiredAt: 1 }),
        ).toThrow(/symlink/);
        expect(() => clearClientState('codex')).toThrow(/symlink/);
      });

      expect(snapshotDeep(outside)).toEqual(before);
    });

    it(`${shape.name} → every OBSERVATIONAL path refuses and creates nothing`, () => {
      const { outside, home: planted } = shape.plant();
      const before = snapshotDeep(outside);

      withHome(planted, () => {
        expect(() => assertReadOnlySthayiHome()).toThrow(/symlink/);
        expect(() => openStoreReadOnly()).toThrow(/symlink/);
        expect(() => runStatus()).toThrow(/symlink/);
        expect(() => runUnwire({ dryRun: true })).toThrow(/symlink/);
        expect(() => runUnwire()).toThrow(/symlink/);
        expect(() => planInit()).toThrow(/symlink/);
        expect(() => runWire({ dryRun: true })).toThrow(/symlink/);
        expect(() => readState()).toThrow(/symlink/);
        expect(() => getClientState('codex')).toThrow(/symlink/);

        // launcherHealth never throws — it REPORTS the refusal, and inspects nothing through it
        const lh = launcherHealth();
        expect(lh.ok).toBe(false);
        expect(lh.state).toBe('untrusted-home');
        expect(lh.detail).toMatch(/symlink/);

        // doctor turns the refusal into a failing check and stops — it never reports on the
        // store, key or token that lives in the outside tree
        const checks = runDoctor();
        const homeCheck = checks.find((c) => c.name === 'Home directory');
        expect(homeCheck?.ok).toBe(false);
        expect(homeCheck?.detail).toMatch(/symlink/);
        expect(checks.map((c) => c.name)).not.toContain('Store');
        expect(JSON.stringify(checks)).not.toContain(CANARY.trim());
      });

      expect(snapshotDeep(outside)).toEqual(before);
    });

    it(`${shape.name} → init and its dry-run refuse without writing a byte`, async () => {
      const { outside, home: planted } = shape.plant();
      const before = snapshotDeep(outside);

      const cap = captureStdout();
      try {
        await withHomeAsync(planted, async () => {
          await expect(runInit({ dryRun: true })).rejects.toThrow(/symlink/);
          await expect(runInit({ yes: true })).rejects.toThrow(/symlink/);
        });
      } finally {
        cap.restore();
      }

      // dry-run's no-write guarantee holds on the REFUSAL path too, and no canary leaked into the
      // printed plan
      expect(snapshotDeep(outside)).toEqual(before);
      expect(cap.text()).not.toContain(CANARY.trim());
    });
  }
});

/**
 * INVARIANT: a symlink is not the only ancestor that steers us. An ancestor that is
 * GROUP/WORLD-WRITABLE WITHOUT the sticky bit, or owned by a FOREIGN UNPRIVILEGED user, can rename
 * the home away and put its own directory in its place — so the home's own 0700 bits decide
 * nothing, and neither does the absence of a link anywhere in the chain.
 *
 * THE SHAPE THAT MATTERS: an EXISTING 0700 STHAYI_HOME under a non-sticky 0777 parent. Establishing
 * it as a trust boundary would put every derived path — the memory database, the vault key, the
 * journal checkpoint, the launcher, the wiring ledger — beneath a directory any local peer can
 * rename away and replace. It must be refused, and nothing may be created under it.
 *
 * These probes therefore use NO symlink at all. The refusal must come from the ancestor's mode,
 * and the sticky variant of the SAME shape must still work (that is `/tmp`).
 */
posixOnly('safety: an UNSAFE ANCESTOR at any depth refuses every storage entry point', () => {
  let home: FakeHome;
  let clientHome: string;

  beforeEach(() => {
    home = createFakeHome();
    clientHome = runTempDir('sthayi-hb-uac-');
    vi.spyOn(os, 'homedir').mockReturnValue(clientHome);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    removeOwned(clientHome);
    home.cleanup();
  });

  const UNSAFE = /not a safe location for Sthayi state/;

  interface Shape {
    name: string;
    /** builds the tree, returns [the unsafe subtree to snapshot, the planted STHAYI_HOME] */
    plant: () => { unsafe: string; planted: string };
  }

  const shapes: Shape[] = [
    {
      name: 'the home EXISTS 0700 and its IMMEDIATE parent is 0777 non-sticky',
      plant: () => {
        const unsafe = home.path('uac-existing');
        const planted = path.join(unsafe, 'the-home');
        fs.mkdirSync(planted, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(planted, 'canary.txt'), CANARY, { mode: 0o600 });
        fs.chmodSync(planted, 0o700);
        fs.chmodSync(unsafe, 0o777);
        return { unsafe, planted };
      },
    },
    {
      name: 'the home is MISSING under a 0777 non-sticky parent',
      plant: () => {
        const unsafe = home.path('uac-missing');
        fs.mkdirSync(unsafe, { recursive: true, mode: 0o700 });
        fs.chmodSync(unsafe, 0o777);
        return { unsafe, planted: path.join(unsafe, 'new-home') };
      },
    },
    {
      name: 'a GROUP-writable 0770 ancestor two levels above an existing 0700 home',
      plant: () => {
        const unsafe = home.path('uac-group');
        const planted = path.join(unsafe, 'sub', 'the-home');
        fs.mkdirSync(planted, { recursive: true, mode: 0o700 });
        fs.chmodSync(planted, 0o700);
        fs.chmodSync(path.join(unsafe, 'sub'), 0o700);
        fs.chmodSync(unsafe, 0o770);
        return { unsafe, planted };
      },
    },
    {
      name: 'a 0777 non-sticky ancestor FOUR levels above an existing 0700 home',
      plant: () => {
        const unsafe = home.path('uac-deep');
        const planted = path.join(unsafe, 'a', 'b', 'c', 'the-home');
        fs.mkdirSync(planted, { recursive: true, mode: 0o700 });
        for (const d of [planted, path.join(unsafe, 'a', 'b', 'c'), path.join(unsafe, 'a', 'b')]) {
          fs.chmodSync(d, 0o700);
        }
        fs.chmodSync(path.join(unsafe, 'a'), 0o700);
        fs.chmodSync(unsafe, 0o777);
        return { unsafe, planted };
      },
    },
  ];

  for (const shape of shapes) {
    it(`${shape.name} → every WRITABLE path refuses; the tree is byte- and mode-identical`, () => {
      const { unsafe, planted } = shape.plant();
      const before = snapshotDeep(unsafe);

      withHome(planted, () => {
        expect(() => ensureSthayiHome()).toThrow(UNSAFE);
        expect(() => openStore()).toThrow(UNSAFE);
        expect(() => writeLauncher()).toThrow(UNSAFE);
        expect(() => runWire()).toThrow(UNSAFE);
        expect(() =>
          setClientState('codex', { backupPath: null, existedBefore: false, wiredAt: 1 }),
        ).toThrow(UNSAFE);
        expect(() => clearClientState('codex')).toThrow(UNSAFE);
        expect(() => fileLog('probe line')).not.toThrow(); // the logger swallows — but writes nothing
      });

      // no db, no key, no journal.checkpoint, no bin/, no logs/, no chmod of the loose ancestor
      expect(snapshotDeep(unsafe)).toEqual(before);
    });

    it(`${shape.name} → every OBSERVATIONAL path refuses and creates nothing`, () => {
      const { unsafe, planted } = shape.plant();
      const before = snapshotDeep(unsafe);

      withHome(planted, () => {
        expect(() => assertReadOnlySthayiHome()).toThrow(UNSAFE);
        expect(() => openStoreReadOnly()).toThrow(UNSAFE);
        expect(() => runStatus()).toThrow(UNSAFE);
        expect(() => runUnwire({ dryRun: true })).toThrow(UNSAFE);
        expect(() => planInit()).toThrow(UNSAFE);
        expect(() => readState()).toThrow(UNSAFE);

        const lh = launcherHealth();
        expect(lh.ok).toBe(false);
        expect(lh.state).toBe('untrusted-home');
        expect(lh.detail).toMatch(UNSAFE);

        const checks = runDoctor();
        const homeCheck = checks.find((c) => c.name === 'Home directory');
        expect(homeCheck?.ok).toBe(false);
        expect(homeCheck?.detail).toMatch(UNSAFE);
        expect(JSON.stringify(checks)).not.toContain(CANARY.trim());
      });

      expect(snapshotDeep(unsafe)).toEqual(before);
    });
  }

  // The SAME shapes with the sticky bit set are `/tmp`, and they must keep working end to end.
  it('PRESERVED: a STICKY world-writable ancestor still initializes a working home', () => {
    const sticky = home.path('uac-sticky');
    fs.mkdirSync(sticky, { recursive: true, mode: 0o700 });
    fs.chmodSync(sticky, 0o1777);
    const planted = path.join(sticky, 'the-home');

    withHome(planted, () => {
      expect(ensureSthayiHome()).toBe(planted);
      const store = openStore();
      try {
        expect(fs.existsSync(path.join(planted, 'sthayi.db'))).toBe(true);
      } finally {
        store.close();
      }
      expect(assertReadOnlySthayiHome()).toBe(planted);
      expect(fs.lstatSync(planted).mode & 0o777).toBe(0o700);
    });
  });
});

/**
 * INVARIANT: an established boundary is an IDENTITY, not a name. Testing that needs no symlink
 * anywhere — "establish through A, then retarget the ancestor link to B" is unreachable, because
 * the whole-path policy refuses establishment THROUGH a symlinked hop outright, leaving no
 * retarget to perform. The reachable shape is:
 *
 *   the ESTABLISHED STHAYI_HOME is DELETED and a NEW directory is created at the SAME PATH,
 *   mid-process.
 *
 * The boundary's identity is the canonical path PLUS the directory's device/inode, so this is a
 * different directory wearing the established name, and it must not be accepted silently: paths.ts
 * feeds the cached canonical root back through establishTrustedDir on EVERY call (and there are
 * many per command — store, launcher, ledger, logger, http server), so a re-registration that
 * REFRESHED the dev/inode instead of comparing it would re-bless the replacement as the boundary
 * and let every later write land inside it.
 *
 * Re-establishment COMPARES against the registered identity and REFUSES, before any chmod, mkdir,
 * read or write. The refusal is PROCESS-SCOPED: a new command establishes the new healthy
 * directory normally (proved by spawning the built CLI at the end).
 *
 * PLATFORM SCOPE — this block is `posixOnly` for a reason, not merely because the fixtures use
 * POSIX modes. The device/inode comparison is not performed on Windows (fs-safe.ts platform scope
 * note), so THIS PROPERTY IS NOT CLAIMED THERE and nothing here executes on `windows-latest`. It
 * is a macOS/Linux guarantee with macOS/Linux evidence.
 */
posixOnly(
  'safety: the ESTABLISHED home, deleted and recreated at the same path, is refused',
  () => {
    let home: FakeHome;
    let clientHome: string;
    let established: string;

    beforeAll(() => {
      ensureBuiltCli();
    }, 300_000);

    beforeEach(() => {
      home = createFakeHome();
      established = home.home;
      clientHome = runTempDir('sthayi-hb-recreate-');
      vi.spyOn(os, 'homedir').mockReturnValue(clientHome);
    });

    afterEach(() => {
      vi.restoreAllMocks();
      removeOwned(clientHome);
      home.cleanup();
    });

    /** Delete the established root and drop a NEW directory at the same path, with a canary inside
     *  it and a deliberately loose 0755 mode — so a chmod "repair" or ANY write through the stale
     *  boundary shows up in the snapshot. Returns the replacement's inode for the identity proof. */
    function deleteAndRecreate(): number {
      const establishedIno = fs.lstatSync(established).ino;
      fs.rmSync(established, { recursive: true, force: true });
      fs.mkdirSync(established, { mode: 0o755 });
      fs.chmodSync(established, 0o755);
      fs.writeFileSync(path.join(established, 'canary.txt'), CANARY);
      fs.chmodSync(path.join(established, 'canary.txt'), 0o666);
      const replacementIno = fs.lstatSync(established).ino;
      expect(replacementIno).not.toBe(establishedIno); // genuinely a different directory
      return replacementIno;
    }

    it('every writable and observational caller refuses; the replacement is byte- and mode-identical', () => {
      withHome(established, () => {
        // 1. the healthy first half of the session: establish and populate
        expect(ensureSthayiHome()).toBe(established);
        expect(sthayiHomeRoot()).toBe(established);
        openStore().close();
        writeLauncher();
        setClientState('codex', { backupPath: null, existedBefore: false, wiredAt: 1 });
        fileLog('before the swap');
        expect(fs.existsSync(path.join(established, 'logs', 'mcp.log'))).toBe(true);

        // 2. the swap
        deleteAndRecreate();
        const before = snapshotDeep(established);

        // 3. the validators themselves — writable AND observational
        expect(() => ensureSthayiHome()).toThrow(/no longer the directory that was validated/);
        expect(() => assertReadOnlySthayiHome()).toThrow(
          /no longer the directory that was validated/,
        );

        // 4. downstream writes: the store, the launcher, the ledger, the log
        expect(() => openStore()).toThrow(/no longer the directory that was validated/);
        expect(() => writeLauncher()).toThrow(/no longer the directory that was validated/);
        expect(() =>
          setClientState('codex', { backupPath: null, existedBefore: false, wiredAt: 2 }),
        ).toThrow(/no longer the directory that was validated/);
        expect(() => clearClientState('codex')).toThrow(
          /no longer the directory that was validated/,
        );
        // fileLog never throws — a refused target means the LINE IS DROPPED, never written through
        expect(() => fileLog('after the swap — must not land')).not.toThrow();

        // 5. observational readers
        expect(() => openStoreReadOnly()).toThrow(/no longer the directory that was validated/);
        expect(() => readState()).toThrow(/no longer the directory that was validated/);
        expect(() => getClientState('codex')).toThrow(/no longer the directory that was validated/);
        expect(() => runStatus()).toThrow(/no longer the directory that was validated/);
        expect(() => planInit()).toThrow(/no longer the directory that was validated/);

        // launcherHealth REPORTS the refusal instead of throwing, and inspects nothing through it
        const lh = launcherHealth();
        expect(lh.ok).toBe(false);
        expect(lh.state).toBe('untrusted-home');
        expect(lh.detail).toMatch(/no longer the directory that was validated/);

        // doctor turns it into a failing check and never reports on the replacement's contents
        const checks = runDoctor();
        const homeCheck = checks.find((c) => c.name === 'Home directory');
        expect(homeCheck?.ok).toBe(false);
        expect(homeCheck?.detail).toMatch(/no longer the directory that was validated/);
        expect(checks.map((c) => c.name)).not.toContain('Store');
        expect(JSON.stringify(checks)).not.toContain(CANARY.trim());

        // 6. the replacement tree is byte-, mode- and path-set-identical: no db, no key, no
        //    launcher, no ledger, no logs, no temp debris — and its loose 0755 was NOT chmodded
        expect(snapshotDeep(established)).toEqual(before);
        expect(fs.readdirSync(established)).toEqual(['canary.txt']);
        expect(fs.lstatSync(established).mode & 0o777).toBe(0o755);
      });
    });

    it('the refusal is PROCESS-SCOPED: a new command establishes the recreated directory normally', () => {
      withHome(established, () => {
        expect(ensureSthayiHome()).toBe(established);
        openStore().close();
        deleteAndRecreate();
        expect(() => ensureSthayiHome()).toThrow(/no longer the directory that was validated/);
      });

      // A FRESH process starts with an empty boundary registry — nothing about the refusal is
      // persisted, so the new healthy directory is established (and tightened to 0700) as usual.
      const r = spawnSync(process.execPath, [distEntry, 'status'], {
        env: {
          ...process.env,
          HOME: clientHome,
          USERPROFILE: clientHome,
          STHAYI_HOME: established,
        },
        cwd: clientHome,
        encoding: 'utf8',
        timeout: 60_000,
      });
      const all = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      expect(r.status, all).toBe(0);
      expect(all).not.toMatch(/no longer the directory that was validated/);
      expect(all).not.toContain(CANARY.trim());
    });
  },
);

posixOnly('safety: an npx-shaped writeLauncher refusal leaves nothing behind', () => {
  let home: FakeHome;
  let npxBase: string;
  let savedArgv1: string | undefined;

  /** A realistic npx cache layout: <base>/_npx/<hash>/node_modules/{sthayi,dep}. */
  function plantNpxTree(): string {
    const nm = path.join(npxBase, '_npx', 'cafe1234', 'node_modules');
    const pkg = path.join(nm, 'sthayi');
    fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'sthayi' }));
    fs.writeFileSync(path.join(pkg, 'dist', 'index.js'), '// fake sthayi entry\n');
    fs.mkdirSync(path.join(nm, 'some-dep'), { recursive: true });
    fs.writeFileSync(path.join(nm, 'some-dep', 'index.js'), '// dep\n');
    return path.join(pkg, 'dist', 'index.js');
  }

  beforeEach(() => {
    home = createFakeHome();
    npxBase = runTempDir('sthayi-hb-npx-');
    savedArgv1 = process.argv[1];
  });

  afterEach(() => {
    if (savedArgv1 !== undefined) {
      process.argv[1] = savedArgv1;
    }
    removeOwned(npxBase);
    home.cleanup();
  });

  /** No launcher, and no runtime copy — complete or partial — anywhere in `tree`. */
  function noLauncherOrRuntimeAnywhere(tree: string): void {
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (/^(sthayi-mcp|sthayi)$/.test(e.name) && !e.isDirectory()) {
          found.push(full);
        }
        if (e.name === 'runtime' || e.name === 'bin' || e.name.startsWith('.tmp-')) {
          found.push(full);
        }
        if (!e.isSymbolicLink() && e.isDirectory()) {
          walk(full);
        }
      }
    };
    walk(tree);
    expect(found).toEqual([]);
  }

  it('an ancestor symlink refuses the npx flow: nothing outside the home, no partial copy, launchers ABSENT', () => {
    const entry = plantNpxTree();
    process.argv[1] = entry;

    const outside = home.path('o-npx');
    plantOutside(outside, 'sub');
    fs.symlinkSync(outside, home.path('hop-npx'), 'dir');
    const before = snapshotDeep(outside);

    withHome(home.path('hop-npx', 'sub', 'new-home'), () => {
      expect(() => writeLauncher()).toThrow(/symlink/);
    });

    // the whole outside tree is byte- and mode-identical, and carries no runtime/bin debris
    expect(snapshotDeep(outside)).toEqual(before);
    noLauncherOrRuntimeAnywhere(outside);
  });

  it('a link standing at <home>/runtime is simply never used: outside tree untouched, BOTH launchers absent', () => {
    const entry = plantNpxTree();
    process.argv[1] = entry;

    const outside = home.path('o-runtime');
    plantOutside(outside);
    // A canonical, perfectly trusted home — with `runtime` replaced by a link outward. Sthayi no
    // longer copies anything into `runtime/`, so this link is not a hijack to be refused: it is a
    // name nothing reaches for. The npx entry is refused one step earlier, on durability alone.
    const canonical = home.path('legit-home');
    fs.mkdirSync(canonical, { mode: 0o700 });
    fs.symlinkSync(outside, path.join(canonical, 'runtime'), 'dir');
    const before = snapshotDeep(outside);

    withHome(canonical, () => {
      expect(() => writeLauncher()).toThrow(/refusing to write a launcher/);
      // the refusal happens BEFORE persistLauncher: neither launcher was written
      expect(fs.existsSync(path.join(canonical, 'bin', 'sthayi-mcp'))).toBe(false);
      expect(fs.existsSync(path.join(canonical, 'bin', 'sthayi'))).toBe(false);
    });

    // and not one byte was written through the link that was standing at the runtime name
    expect(snapshotDeep(outside)).toEqual(before);
    noLauncherOrRuntimeAnywhere(outside);
  });
});

/**
 * The same boundary through the BUILT CLI, with an OUTSIDE CANARY: a refused command must exit
 * nonzero, leave the canary's bytes AND mode untouched, create nothing in the outside tree, and
 * never echo the canary's content into stdout or stderr. Covers the ledger, unwire, status and
 * the dry-runs specifically — the read-shaped callers where skipping home validation is easiest
 * to justify and most costly: they would read (or rewrite) state in the outside tree.
 */
posixOnly('safety: refused commands never read or change an outside canary (built CLI)', () => {
  let probeRoot: string;
  let userHome: string;
  let outside: string;
  let plantedHome: string;

  beforeAll(() => {
    ensureBuiltCli();
  }, 300_000);

  beforeEach(() => {
    expect(fs.existsSync(distEntry), `missing ${distEntry} — run \`pnpm build\` first`).toBe(true);
    // realpath: os.tmpdir() is itself reached through /var -> private/var on macOS, and the whole
    // point of these fixtures is that the ONLY symlink in the chain is the one we plant.
    probeRoot = runTempDir('sthayi-hb-cli-');
    userHome = path.join(probeRoot, 'user-home');
    fs.mkdirSync(path.join(userHome, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(userHome, '.codex', 'config.toml'), 'model = "test"\n');

    // An outside tree holding a canary AND a plausible sthayi home, reached through `hop` two
    // levels up — the shape an immediate-parent-only check cannot see.
    outside = path.join(probeRoot, 'outside');
    plantOutside(outside, 'sub', 'the-home');
    fs.writeFileSync(path.join(outside, 'sub', 'the-home', 'clients-state.json'), '{}\n');
    fs.symlinkSync(outside, path.join(probeRoot, 'hop'), 'dir');
    plantedHome = path.join(probeRoot, 'hop', 'sub', 'the-home');
  });

  afterEach(() => {
    removeOwned(probeRoot);
  });

  function run(args: string[]) {
    const r = spawnSync(process.execPath, [distEntry, ...args], {
      env: {
        ...process.env,
        HOME: userHome,
        USERPROFILE: userHome,
        STHAYI_HOME: plantedHome,
      },
      cwd: probeRoot,
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { status: r.status, all: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  }

  it.each([
    ['status'],
    ['unwire', '--dry-run'],
    ['unwire'],
    ['wire', '--dry-run'],
    ['wire'],
    ['init', '--dry-run'],
    ['doctor'],
    ['pack'],
    ['add', '--confirm', 'probe', 'value'],
  ])('%s is refused: canary unread, unchanged, and never echoed', (...args) => {
    const before = snapshotDeep(outside);
    const userBefore = snapshotDeep(userHome);

    const r = run(args as string[]);
    expect(r.status, r.all).not.toBe(0);
    expect(r.all).toMatch(/symlink/);

    // the canary's bytes AND its mode survive, nothing new appeared, and its content was never
    // printed — a refusal that reads the file to report on it is still a disclosure
    expect(snapshotDeep(outside)).toEqual(before);
    expect(r.all).not.toContain(CANARY.trim());
    // and the user's client configs were not touched either
    expect(snapshotDeep(userHome)).toEqual(userBefore);
  });
});
