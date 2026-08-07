import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { removeOwned, trackOwned } from '../helpers/owned-fs.js';
import { runTempDir } from '../helpers/run-temp.js';
import setup, {
  RUN_DIRS,
  RUN_FIXTURES,
  RUN_IDENTITY_ENV,
  RUN_MARKER,
  RUN_ROOT_ENV,
  RUN_TOKEN_ENV,
} from '../helpers/temp-sweep.js';

/**
 * SAFETY: a test run may only ever delete directories it created itself.
 *
 * The threat is not hypothetical and not limited to attackers. Two `pnpm test` runs share one
 * system temp root, and so does any real `sthayi` process that allocates a scratch path there. A
 * teardown that decides what to delete by matching a shared NAME PREFIX will delete a peer's live
 * fixtures — including an open store's database and vault key. Narrowing the match to "entries
 * that appeared during this run" does not help: that set is exactly what a concurrently starting
 * peer also looks like.
 *
 * INVARIANT: the run allocates ONE cryptographically named root, every fixture lands beneath it
 * via runTempDir(), and teardown removes only that path after proving — with no-follow checks —
 * that it is still the very directory this run created (real directory, same device/inode, owned
 * by us, private, carrying this run's token). Anything else at that path is left untouched.
 *
 * A PROVED PATHNAME IS NOT A DELETION PERMIT. Every check describes the inode a name pointed at
 * one instant ago; portable Node has no `unlinkat`, so a peer can move that name afterwards. The
 * defence is therefore about BLAST RADIUS, not about winning the race: teardown never invokes a
 * recursive deletion primitive on a pathname. It walks the tree it proved it owns and removes one
 * entry at a time — `unlink` for files and symlinks, `rmdir` for directories it has already
 * emptied — re-proving the containing directory's device/inode immediately before each removal.
 * One lost race can therefore cost one entry; it can never cost a foreign subtree. Every mismatch
 * aborts and LEAVES the remainder standing, because a stray temp directory is recoverable and a
 * deleted vault key is not.
 */
describe('safety: a test run deletes only its own temp root', () => {
  const strays: string[] = [];
  // These tests drive setup()/teardown() BY HAND, several times, inside a process that is itself
  // already running under one. Production pairs them once per process; here the run-root variable
  // is pinned per test so a later test never inherits an earlier simulated run's root.
  let envRun: string | undefined;
  beforeEach(() => {
    envRun = process.env[RUN_ROOT_ENV];
  });
  afterEach(() => {
    vi.restoreAllMocks();
    const survived: string[] = [];
    for (const s of strays.splice(0)) {
      try {
        fs.chmodSync(s, 0o700); // a fixture left non-private must still be sweepable
      } catch {
        // already gone
      }
      // Several scenarios deliberately plant a SYMLINK where a directory used to be. The test
      // planted it, so the test detaches it — one unlink, which removes the link and never what it
      // points at. `removeOwned` will not do it: its record describes a directory that is already
      // gone, and a retired record must never authorise removing whatever took the name.
      if (fs.lstatSync(s, { throwIfNoEntry: false })?.isSymbolicLink() === true) {
        fs.unlinkSync(s);
        continue;
      }
      removeOwned(s);
      if (fs.existsSync(s)) {
        survived.push(s);
      }
    }
    // EVERY PROP THIS SUITE MADE HAS TO GO, and saying so here is what keeps the claim honest.
    // These scenarios stand their fixtures OUTSIDE the run roots on purpose — a stand-in for a peer
    // has to be a peer — so nothing inside one is recordable until the directory itself is an
    // anchor this run holds an identity for. Fill one before tracking it and its contents carry no
    // receipt, `removeOwned` rightly refuses an entry it cannot account for, and the directory is
    // stranded in the SHARED system temp root, outside every teardown that exists. That failure is
    // silent: the assertions all still pass and only a census of the temp root ever finds it. So it
    // is asserted, in the one place that can see it.
    expect(survived, 'a prop this suite created was left standing in the shared temp root').toEqual(
      [],
    );
    // Only RUN_ROOT_ENV needs restoring: setup() deliberately does not touch TMPDIR, and these
    // tests drive setup()/teardown() by hand several times inside a process already running under
    // one, so a later test must not inherit an earlier simulated run's root.
    if (envRun === undefined) {
      delete process.env[RUN_ROOT_ENV];
    } else {
      process.env[RUN_ROOT_ENV] = envRun;
    }
  });

  /** Snapshot a tree as {relative path -> bytes|mode}, for byte-exact survival assertions. */
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

  it("OVERLAPPING RUNS: one run tearing down leaves the other run's live tree byte-identical", () => {
    // Simulated runs must be SIBLINGS under the real system temp, never nested inside one another.
    const systemTemp = fs.realpathSync(os.tmpdir());

    // Run A and run B start concurrently, each taking its own root.
    const teardownA = setup({ systemTemp: systemTemp });
    const rootA = String(process.env[RUN_ROOT_ENV]);
    const teardownB = setup({ systemTemp: systemTemp });
    const rootB = String(process.env[RUN_ROOT_ENV]);
    strays.push(rootA, rootB);

    expect(rootA).not.toBe(rootB); // cryptographically distinct, not a shared prefix

    // Run B has live fixtures, including an OPEN file handle — the shape a real suite is in
    // while a peer's teardown fires. The fixture is allocated the way every fixture is, through
    // runTempDir(), so it is RECORDED: run B's own teardown descends into a child only when the
    // name is in its ledger and the inode standing there is the one that was allocated.
    const bFixture = runTempDir('sthayi-test-');
    fs.writeFileSync(path.join(bFixture, 'sthayi.db'), 'B-LIVE-STORE');
    fs.writeFileSync(path.join(bFixture, 'key'), 'B-VAULT-KEY', { mode: 0o600 });
    const openFd = fs.openSync(path.join(bFixture, 'sthayi.db'), 'r');

    // A pre-existing peer that predates BOTH runs and shares the historic naming prefix — the
    // exact thing a prefix-matching sweeper would spare only by luck of timing.
    //
    // TRACKED BEFORE IT IS FILLED, and that order is load-bearing. A stand-in for a peer has to live
    // OUTSIDE both run roots to be a peer at all, so nothing inside it is recordable until the
    // directory itself is an anchor this run holds an identity for. Writing the canary first would
    // leave it with no receipt, `removeOwned` would rightly refuse to take an entry it cannot
    // account for, and this test's own props would be left standing in the shared temp root — a
    // leak this suite creates while asserting that leaks are the safe direction.
    const preExisting = trackOwned(fs.mkdtempSync(path.join(systemTemp, 'sthayi-test-')));
    strays.push(preExisting);
    fs.writeFileSync(path.join(preExisting, 'canary'), 'PRE-EXISTING');

    const beforeB = snapshot(rootB);
    const beforePre = snapshot(preExisting);

    teardownA(); // run A finishes first

    try {
      expect(fs.existsSync(rootA)).toBe(false); // A removed its own root
      expect(fs.existsSync(rootB)).toBe(true); // B untouched
      expect(snapshot(rootB)).toEqual(beforeB);
      expect(fs.readFileSync(path.join(bFixture, 'sthayi.db'), 'utf8')).toBe('B-LIVE-STORE');
      expect(fs.readFileSync(path.join(bFixture, 'key'), 'utf8')).toBe('B-VAULT-KEY');
      expect(fs.readSync(openFd, Buffer.alloc(12), 0, 12, 0)).toBe(12); // handle still valid
      expect(snapshot(preExisting)).toEqual(beforePre);
    } finally {
      fs.closeSync(openFd);
    }

    teardownB();
    expect(fs.existsSync(rootB)).toBe(false);
    expect(snapshot(preExisting)).toEqual(beforePre); // still survives
  });

  it('refuses to delete a root that was REPLACED at the same path', () => {
    const teardown = setup({ systemTemp: fs.realpathSync(os.tmpdir()) });
    const root = String(process.env[RUN_ROOT_ENV]);
    strays.push(root);

    // Something swaps a different directory in at the same pathname.
    removeOwned(root);
    fs.mkdirSync(root, { mode: 0o700 });
    trackOwned(root);
    fs.writeFileSync(path.join(root, 'NOT-OURS'), 'someone else lives here');

    teardown();
    expect(fs.existsSync(path.join(root, 'NOT-OURS'))).toBe(true);
    expect(fs.readFileSync(path.join(root, 'NOT-OURS'), 'utf8')).toBe('someone else lives here');
  });

  it.skipIf(process.platform === 'win32')(
    'refuses to follow a SYMLINK planted at the run-root path',
    () => {
      const systemTemp = fs.realpathSync(os.tmpdir());
      const teardown = setup({ systemTemp });
      const root = String(process.env[RUN_ROOT_ENV]);
      strays.push(root);

      // Tracked before it is filled: the victim stands outside every run root, so its contents are
      // recordable only once the directory itself is an anchor. See the note in the first test.
      const victim = trackOwned(fs.mkdtempSync(path.join(systemTemp, 'sthayi-victim-')));
      strays.push(victim);
      fs.writeFileSync(path.join(victim, 'canary'), 'VICTIM');

      removeOwned(root);
      fs.symlinkSync(victim, root);

      teardown();
      expect(fs.readFileSync(path.join(victim, 'canary'), 'utf8')).toBe('VICTIM');
      expect(fs.lstatSync(root).isSymbolicLink()).toBe(true); // link itself left alone too
    },
  );

  it('runTempDir allocates inside the run root, and TMPDIR is left alone', () => {
    const beforeTmp = process.env.TMPDIR;
    const teardown = setup({ systemTemp: fs.realpathSync(os.tmpdir()) });
    const root = String(process.env[RUN_ROOT_ENV]);
    strays.push(root);

    // Fixtures land inside the run root...
    const allocated = runTempDir('sthayi-test-');
    expect(allocated.startsWith(root)).toBe(true);

    // ...without rewriting the temp directory for this process or anything it spawns. Repointing
    // TMPDIR would change the environment of every child process a test starts, and of the
    // toolchain inside it — isolation must not be bought by altering what is under observation.
    expect(process.env.TMPDIR).toBe(beforeTmp);

    teardown();
    expect(fs.existsSync(root)).toBe(false);
    expect(fs.existsSync(allocated)).toBe(false); // removed with the root that owned it
  });

  it.skipIf(process.platform === 'win32')(
    'setup pins its created root through publication, both ledgers, trackOwned, and teardown, then closes it',
    () => {
      const systemTemp = fs.realpathSync(os.tmpdir());
      const previous = {
        root: process.env[RUN_ROOT_ENV],
        token: process.env[RUN_TOKEN_ENV],
        identity: process.env[RUN_IDENTITY_ENV],
      };
      const events: string[] = [];
      let setupFd: number | undefined;
      let runRootOpens = 0;
      let markerWritten = false;
      const realOpen = fs.openSync;
      const realFstat = fs.fstatSync;
      const realClose = fs.closeSync;
      const realWrite = fs.writeFileSync;
      const realAppend = fs.appendFileSync;
      const realRealpath = fs.realpathSync;
      const live = (): void => {
        if (setupFd === undefined) throw new Error('setup root descriptor was not captured');
        expect(() => realFstat(setupFd as number)).not.toThrow();
      };

      vi.spyOn(fs, 'openSync').mockImplementation(((
        p: fs.PathLike,
        flags: unknown,
        mode?: unknown,
      ) => {
        const fd = (realOpen as unknown as (a: fs.PathLike, b: unknown, c?: unknown) => number)(
          p,
          flags,
          mode,
        );
        if (
          path.basename(String(p)).startsWith('sthayi-run-') &&
          typeof flags === 'number' &&
          (flags & fs.constants.O_DIRECTORY) !== 0
        ) {
          runRootOpens += 1;
          // #1 is the wrapped mkdir's short-lived creation capture. #2 is setup's retained pin.
          if (runRootOpens === 2) {
            setupFd = fd;
            events.push('open');
          }
        }
        return fd;
      }) as typeof fs.openSync);
      vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number, options?: unknown) => {
        const out = (realFstat as unknown as (a: number, b?: unknown) => unknown)(fd, options);
        if (fd === setupFd) events.push('fstat');
        return out;
      }) as typeof fs.fstatSync);
      vi.spyOn(fs, 'writeFileSync').mockImplementation(((
        p: fs.PathOrFileDescriptor,
        data: unknown,
        options?: unknown,
      ) => {
        const out = (
          realWrite as unknown as (a: fs.PathOrFileDescriptor, b: unknown, c?: unknown) => void
        )(p, data, options);
        if (typeof p !== 'number' && path.basename(String(p)) === RUN_MARKER) {
          live();
          markerWritten = true;
          events.push('marker');
        }
        return out;
      }) as typeof fs.writeFileSync);
      vi.spyOn(fs, 'appendFileSync').mockImplementation(((
        p: fs.PathOrFileDescriptor,
        ...rest: unknown[]
      ) => {
        const basename = typeof p === 'number' ? '' : path.basename(String(p));
        if (basename === RUN_DIRS || basename === RUN_FIXTURES) {
          live();
          events.push(basename === RUN_DIRS ? 'dir-ledger' : 'fixture-ledger');
        }
        return (realAppend as unknown as (a: fs.PathOrFileDescriptor, ...b: unknown[]) => void)(
          p,
          ...rest,
        );
      }) as typeof fs.appendFileSync);
      vi.spyOn(fs, 'realpathSync').mockImplementation(((p: fs.PathLike, options?: unknown) => {
        if (markerWritten && path.basename(String(p)).startsWith('sthayi-run-')) {
          live();
          events.push('trackOwned');
        }
        return (realRealpath as unknown as (a: fs.PathLike, b?: unknown) => string)(p, options);
      }) as typeof fs.realpathSync);
      vi.spyOn(fs, 'closeSync').mockImplementation((fd: number) => {
        if (fd === setupFd) events.push('close');
        return realClose(fd);
      });

      const teardown = setup({ systemTemp });
      const root = String(process.env[RUN_ROOT_ENV]);
      strays.push(root);
      expect(setupFd).toBeDefined();
      live();
      const fixture = runTempDir('sthayi-setup-pin-');
      expect(path.dirname(fixture)).toBe(root);
      live();
      teardown();

      expect(events).toContain('marker');
      expect(events).toContain('dir-ledger');
      expect(events).toContain('fixture-ledger');
      expect(events).toContain('trackOwned');
      expect(events.lastIndexOf('fstat')).toBeGreaterThan(events.indexOf('trackOwned'));
      expect(events.filter((event) => event === 'close')).toHaveLength(1);
      expect(() => realFstat(setupFd as number)).toThrow(
        expect.objectContaining({ code: 'EBADF' }),
      );
      expect(process.env[RUN_ROOT_ENV]).toBe(previous.root);
      expect(process.env[RUN_TOKEN_ENV]).toBe(previous.token);
      expect(process.env[RUN_IDENTITY_ENV]).toBe(previous.identity);
      expect(fs.existsSync(root)).toBe(false);
    },
  );

  /**
   * Stand a foreign tree at the run-root pathname: a nested subtree plus a top-level file, and a
   * marker named exactly like ours so the replacement is as convincing as a replacement can be.
   * Returns the names planted, so a test can count how many of them a lost race cost.
   */
  function plantReplacement(root: string): string[] {
    removeOwned(root);
    fs.mkdirSync(path.join(root, 'nested'), { recursive: true, mode: 0o700 });
    trackOwned(root);
    fs.writeFileSync(path.join(root, 'nested', 'canary'), 'REPLACEMENT');
    fs.writeFileSync(path.join(root, 'top-canary'), 'REPLACEMENT-TOP');
    fs.writeFileSync(path.join(root, RUN_MARKER), 'decoy\n', { mode: 0o600 });
    return ['nested', 'top-canary', RUN_MARKER];
  }

  it('a swap between LISTING the run root and the first removal aborts teardown', () => {
    const teardown = setup({ systemTemp: fs.realpathSync(os.tmpdir()) });
    const root = String(process.env[RUN_ROOT_ENV]);
    strays.push(root);
    fs.mkdirSync(path.join(root, 'fixture'), { mode: 0o700 });
    fs.writeFileSync(path.join(root, 'fixture', 'db'), 'OURS');

    // The names a directory listing produces are only meaningful while the directory they came
    // from is still the one proved owned. Swapping from inside the listing call puts the
    // replacement in exactly that window, deterministically.
    let swapped = false;
    const realReaddir = fs.readdirSync;
    vi.spyOn(fs, 'readdirSync').mockImplementation(((p: fs.PathLike, o?: unknown) => {
      const listed = (realReaddir as unknown as (a: fs.PathLike, b?: unknown) => unknown)(p, o);
      if (!swapped && String(p) === root) {
        swapped = true;
        plantReplacement(root);
      }
      return listed;
    }) as typeof fs.readdirSync);

    teardown();
    vi.restoreAllMocks();

    expect(swapped).toBe(true); // the race really was run
    expect(fs.existsSync(root)).toBe(true);
    expect(fs.readFileSync(path.join(root, 'nested', 'canary'), 'utf8')).toBe('REPLACEMENT');
    expect(fs.readFileSync(path.join(root, 'top-canary'), 'utf8')).toBe('REPLACEMENT-TOP');
    expect(fs.readdirSync(root).sort()).toEqual([RUN_MARKER, 'nested', 'top-canary']);
  });

  it('ONE swap at the DESTRUCTIVE CALL costs one entry, never a subtree', () => {
    const teardown = setup({ systemTemp: fs.realpathSync(os.tmpdir()) });
    const root = String(process.env[RUN_ROOT_ENV]);
    strays.push(root);

    // The hardest possible position for the swap: after every check any implementation could make,
    // inside the removal itself. Nothing can win this race — the contract is about what LOSING it
    // costs. Because removal is one non-recursive `unlink`/`rmdir` per re-proved identity, ONE lost
    // race costs the single entry that call was aimed at; a recursive primitive would take the whole
    // replacement, nested subtree and all.
    //
    // ONE swap is what is staged here, and the bound below is therefore about one ATTEMPT. It is not
    // a ceiling on the sweep: the sweep makes an attempt per entry, each opens its own interval, and
    // a peer that keeps winning costs one entry each time — see
    // `tests/safety/final-unlink-interval.test.ts`, which stages exactly that and loses all three.
    let swapped = false;
    const planted: string[] = [];
    const swapFirst = (): void => {
      if (!swapped) {
        swapped = true;
        planted.push(...plantReplacement(root));
      }
    };
    const realUnlink = fs.unlinkSync;
    const realRmdir = fs.rmdirSync;
    vi.spyOn(fs, 'unlinkSync').mockImplementation(((p: fs.PathLike) => {
      swapFirst();
      return (realUnlink as unknown as (a: fs.PathLike) => void)(p);
    }) as typeof fs.unlinkSync);
    vi.spyOn(fs, 'rmdirSync').mockImplementation(((p: fs.PathLike, o?: unknown) => {
      swapFirst();
      return (realRmdir as unknown as (a: fs.PathLike, b?: unknown) => void)(p, o);
    }) as typeof fs.rmdirSync);

    teardown();
    vi.restoreAllMocks();

    expect(swapped).toBe(true);
    expect(fs.existsSync(root)).toBe(true); // the foreign directory itself is still standing
    expect(fs.readFileSync(path.join(root, 'nested', 'canary'), 'utf8')).toBe('REPLACEMENT');
    const lost = planted.filter((n) => !fs.existsSync(path.join(root, n)));
    expect(lost.length).toBeLessThanOrEqual(1);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses to delete a run root that turned GROUP- or WORLD-accessible',
    () => {
      const teardown = setup({ systemTemp: fs.realpathSync(os.tmpdir()) });
      const root = String(process.env[RUN_ROOT_ENV]);
      strays.push(root);
      fs.writeFileSync(path.join(root, 'canary'), 'OURS');

      // Identity, owner and token all still match. Shared access is on its own disqualifying: a
      // root anyone can write is a root anyone can have redirected, and its contents can no longer
      // be attributed to this run.
      fs.chmodSync(root, 0o777);

      teardown();
      expect(fs.existsSync(root)).toBe(true);
      expect(fs.readFileSync(path.join(root, 'canary'), 'utf8')).toBe('OURS');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'a SYMLINK planted inside the run root is detached, never followed',
    () => {
      const systemTemp = fs.realpathSync(os.tmpdir());
      const teardown = setup({ systemTemp });
      const root = String(process.env[RUN_ROOT_ENV]);
      strays.push(root);

      // Tracked before it is filled: the victim stands outside every run root, so its contents are
      // recordable only once the directory itself is an anchor. See the note in the first test.
      const victim = trackOwned(fs.mkdtempSync(path.join(systemTemp, 'sthayi-linkvictim-')));
      strays.push(victim);
      fs.writeFileSync(path.join(victim, 'canary'), 'VICTIM');
      fs.symlinkSync(victim, path.join(root, 'escape'));

      teardown();
      // Removing the link removes the entry; a deletion that resolved it would empty the victim.
      expect(fs.existsSync(root)).toBe(false);
      expect(fs.readFileSync(path.join(victim, 'canary'), 'utf8')).toBe('VICTIM');
    },
  );

  it('setup() leaves nothing behind when publishing the run root fails', () => {
    const systemTemp = fs.realpathSync(os.tmpdir());
    // Roots are named for the process that made them, so "did THIS process strand one" is answered
    // without ever attributing a shared-temp entry by prefix alone — the very inference this file
    // exists to forbid. A concurrent run's root shares the prefix and must stay out of the verdict.
    const ourRoots = (): string[] =>
      fs.readdirSync(systemTemp).filter((n) => n.startsWith(`sthayi-run-${process.pid}-`));
    const isRunRoot = (name: string): boolean => name.startsWith('sthayi-run-');

    // A crash can strand a directory; an ordinary synchronous failure must not. Nothing has been
    // published at this point, so a root left here would be a permanent stray in the shared temp
    // root — outside every teardown that exists.
    const expectNoLeak = (inject: () => void, match: RegExp): void => {
      const before = new Set(ourRoots());
      const beforeEnv = {
        root: process.env[RUN_ROOT_ENV],
        token: process.env[RUN_TOKEN_ENV],
        identity: process.env[RUN_IDENTITY_ENV],
      };
      inject();
      expect(() => setup({ systemTemp })).toThrow(match);
      vi.restoreAllMocks();
      expect(ourRoots().filter((n) => !before.has(n))).toEqual([]);
      expect(process.env[RUN_ROOT_ENV]).toBe(beforeEnv.root);
      expect(process.env[RUN_TOKEN_ENV]).toBe(beforeEnv.token);
      expect(process.env[RUN_IDENTITY_ENV]).toBe(beforeEnv.identity);
    };

    // the marker write fails, after the root exists
    let markerFailureFd: number | undefined;
    let markerRunRootOpens = 0;
    const realMarkerOpen = fs.openSync;
    const realWrite = fs.writeFileSync;
    expectNoLeak(() => {
      vi.spyOn(fs, 'openSync').mockImplementation(((
        p: fs.PathLike,
        flags: unknown,
        mode?: unknown,
      ) => {
        const fd = (
          realMarkerOpen as unknown as (a: fs.PathLike, b: unknown, c?: unknown) => number
        )(p, flags, mode);
        if (
          path.basename(String(p)).startsWith('sthayi-run-') &&
          typeof flags === 'number' &&
          (flags & fs.constants.O_DIRECTORY) !== 0
        ) {
          markerRunRootOpens += 1;
          if (markerRunRootOpens === 2) markerFailureFd = fd;
        }
        return fd;
      }) as typeof fs.openSync);
      vi.spyOn(fs, 'writeFileSync').mockImplementation(((
        p: fs.PathOrFileDescriptor,
        d: unknown,
        o?: unknown,
      ) => {
        if (String(p).endsWith(RUN_MARKER)) {
          if (process.platform !== 'win32') {
            if (markerFailureFd === undefined)
              throw new Error('retained descriptor was not captured');
            expect(() => fs.fstatSync(markerFailureFd as number)).not.toThrow();
          }
          throw Object.assign(new Error('injected marker failure'), { code: 'EIO' });
        }
        return (
          realWrite as unknown as (a: fs.PathOrFileDescriptor, b: unknown, c?: unknown) => void
        )(p, d, o);
      }) as typeof fs.writeFileSync);
    }, /injected marker failure/);
    if (process.platform !== 'win32') {
      expect(markerFailureFd).toBeDefined();
      expect(() => fs.fstatSync(markerFailureFd as number)).toThrow(
        expect.objectContaining({ code: 'EBADF' }),
      );
    }

    if (process.platform === 'win32') {
      // Windows has no portable no-follow directory descriptor. Its setup identity read is the
      // first bigint lstat after the wrapped mkdir has fully returned. Selecting that semantic
      // boundary keeps the recorder's own before/after/recording reads intact while proving that a
      // later setup failure unwinds through the carried receipt, just as a POSIX open failure does.
      const realSetupMkdir = fs.mkdirSync;
      const realSetupLstat = fs.lstatSync;
      let returnedRunRoot: string | undefined;
      let failedSetupLstat = false;
      expectNoLeak(() => {
        vi.spyOn(fs, 'mkdirSync').mockImplementation(((p: fs.PathLike, o?: unknown) => {
          const made = (
            realSetupMkdir as unknown as (a: fs.PathLike, b?: unknown) => string | undefined
          )(p, o);
          if (path.basename(String(p)).startsWith('sthayi-run-')) {
            returnedRunRoot = path.resolve(String(p));
          }
          return made;
        }) as typeof fs.mkdirSync);
        vi.spyOn(fs, 'lstatSync').mockImplementation(((p: fs.PathLike, o?: unknown) => {
          const isSetupIdentityRead =
            returnedRunRoot !== undefined &&
            typeof p === 'string' &&
            path.resolve(p) === returnedRunRoot &&
            (o as { bigint?: boolean } | undefined)?.bigint === true;
          if (isSetupIdentityRead && !failedSetupLstat) {
            failedSetupLstat = true;
            throw Object.assign(new Error('injected root-lstat failure'), { code: 'EIO' });
          }
          return (realSetupLstat as unknown as (a: fs.PathLike, b?: unknown) => fs.Stats)(p, o);
        }) as typeof fs.lstatSync);
      }, /injected root-lstat failure/);
      expect(failedSetupLstat).toBe(true);
    } else {
      // setup's own descriptor open fails after the mkdir wrapper captured creation identity. The
      // carried receipt still authorises one bounded rmdir of the unchanged empty root.
      const realOpen = fs.openSync;
      let openCount = 0;
      expectNoLeak(() => {
        vi.spyOn(fs, 'openSync').mockImplementation(((
          p: fs.PathLike,
          flags: unknown,
          mode?: unknown,
        ) => {
          const isRunRootOpen =
            path.basename(String(p)).startsWith('sthayi-run-') &&
            typeof flags === 'number' &&
            (flags & fs.constants.O_DIRECTORY) !== 0;
          if (isRunRootOpen) openCount += 1;
          if (isRunRootOpen && openCount === 2) {
            throw Object.assign(new Error('injected root-open failure'), { code: 'EIO' });
          }
          return (realOpen as unknown as (a: fs.PathLike, b: unknown, c?: unknown) => number)(
            p,
            flags,
            mode,
          );
        }) as typeof fs.openSync);
      }, /injected root-open failure/);

      // The initial setup fstat fails once. The descriptor is still open, so unwind re-fstats it,
      // compares it with the carried receipt and current path, removes the empty root, then closes.
      const realSetupOpen = fs.openSync;
      const realSetupFstat = fs.fstatSync;
      let fstatRunRootOpens = 0;
      let fstatFailureFd: number | undefined;
      let failedFirstFstat = false;
      expectNoLeak(() => {
        vi.spyOn(fs, 'openSync').mockImplementation(((
          p: fs.PathLike,
          flags: unknown,
          mode?: unknown,
        ) => {
          const fd = (
            realSetupOpen as unknown as (a: fs.PathLike, b: unknown, c?: unknown) => number
          )(p, flags, mode);
          if (
            path.basename(String(p)).startsWith('sthayi-run-') &&
            typeof flags === 'number' &&
            (flags & fs.constants.O_DIRECTORY) !== 0
          ) {
            fstatRunRootOpens += 1;
            if (fstatRunRootOpens === 2) fstatFailureFd = fd;
          }
          return fd;
        }) as typeof fs.openSync);
        vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number, options?: unknown) => {
          if (fd === fstatFailureFd && !failedFirstFstat) {
            failedFirstFstat = true;
            throw Object.assign(new Error('injected root-fstat failure'), { code: 'EIO' });
          }
          return (realSetupFstat as unknown as (a: number, b?: unknown) => unknown)(fd, options);
        }) as typeof fs.fstatSync);
      }, /injected root-fstat failure/);
      expect(failedFirstFstat).toBe(true);
      expect(fstatFailureFd).toBeDefined();
      expect(() => fs.fstatSync(fstatFailureFd as number)).toThrow(
        expect.objectContaining({ code: 'EBADF' }),
      );
    }

    // canonicalisation fails, after the root and its marker exist
    const realRealpath = fs.realpathSync;
    expectNoLeak(() => {
      vi.spyOn(fs, 'realpathSync').mockImplementation(((p: fs.PathLike, o?: unknown) => {
        if (isRunRoot(path.basename(String(p)))) {
          throw Object.assign(new Error('injected realpath failure'), { code: 'EIO' });
        }
        return (realRealpath as unknown as (a: fs.PathLike, b?: unknown) => string)(p, o);
      }) as typeof fs.realpathSync);
    }, /injected realpath failure/);

    // The created root does not come back private. Windows exposes synthetic POSIX mode bits and
    // the harness deliberately does not treat them as an access-control signal; its path, shape,
    // receipt and cleanup failure probes above still run there.
    if (process.platform !== 'win32') {
      const realPrivateOpen = fs.openSync;
      const realFstat = fs.fstatSync;
      let privateRunRootOpens = 0;
      let privateSetupFd: number | undefined;
      let injectedSharedMode = false;
      expectNoLeak(() => {
        vi.spyOn(fs, 'openSync').mockImplementation(((
          p: fs.PathLike,
          flags: unknown,
          mode?: unknown,
        ) => {
          const fd = (
            realPrivateOpen as unknown as (a: fs.PathLike, b: unknown, c?: unknown) => number
          )(p, flags, mode);
          if (
            path.basename(String(p)).startsWith('sthayi-run-') &&
            typeof flags === 'number' &&
            (flags & fs.constants.O_DIRECTORY) !== 0
          ) {
            privateRunRootOpens += 1;
            if (privateRunRootOpens === 2) privateSetupFd = fd;
          }
          return fd;
        }) as typeof fs.openSync);
        vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number, o?: unknown) => {
          const st = (realFstat as unknown as (a: number, b?: unknown) => fs.Stats)(fd, o);
          if (fd === privateSetupFd && !injectedSharedMode) {
            injectedSharedMode = true;
            const mode = st.mode as number | bigint;
            Object.defineProperty(st, 'mode', {
              value: typeof mode === 'bigint' ? mode | 0o077n : mode | 0o077,
              configurable: true,
            });
          }
          return st;
        }) as typeof fs.fstatSync);
      }, /must not be group- or world-accessible/);
      expect(injectedSharedMode).toBe(true);
    }
  });
});
