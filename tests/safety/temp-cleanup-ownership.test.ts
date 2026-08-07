import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeHome } from '../helpers/fake-home.js';
import { identityFromBigStat, removeOwned, trackOwned } from '../helpers/owned-fs.js';
import { runTempDir } from '../helpers/run-temp.js';
import setup, { RUN_IDENTITY_ENV, RUN_ROOT_ENV, RUN_TOKEN_ENV } from '../helpers/temp-sweep.js';

/**
 * SAFETY: a name is never enough. Every removal a test run makes is authorised by an identity the
 * run RECORDED WHEN IT CREATED the directory, and by nothing else.
 *
 * The failure this file exists to forbid is quiet and total: teardown reads a directory listing,
 * sees a name it expects, and walks whatever inode currently answers to that name. A concurrent
 * `pnpm test`, a live `sthayi` process, anything sharing this uid and this temp root can put a
 * different directory there — and the walk then empties a stranger's tree while reporting success.
 * Matching the name is what makes it possible; the inode recorded at allocation is what makes it
 * detectable.
 *
 * INVARIANT, in three parts:
 *   1. ALLOCATION RECORDS IDENTITY. Every fixture is created through `runTempDir()`, which writes
 *      the device/inode it had at creation into the run root's ledger. Teardown descends into a
 *      child only when the name is in that ledger AND the inode standing there is the recorded one.
 *   2. AN UNREGISTERED OR REPLACED CHILD IS NEVER WALKED. A directory the run did not allocate is
 *      removed only by a single non-recursive `rmdir`, which succeeds on an empty stray and fails
 *      rather than descend into anything else. A registered name occupied by a different inode —
 *      another directory, a symlink, a file — aborts teardown outright and leaks the whole root.
 *   3. AUTHORITY IS RE-PROVED BEFORE EVERY SINGLE SYSCALL. Inode, owner and private mode of the run
 *      root are checked immediately before each `unlink` and each `rmdir`, because the contract is
 *      that the root stays private for the whole life of the run, teardown included.
 *
 * WHAT IS NOT CLAIMED. Portable Node has no `unlinkat`, so a check and the call it authorises are
 * two acts. A peer that wins the last instant still gets ONE removal applied to whatever now
 * answers to that name — one file, one symlink, one already-empty directory. That is the entire
 * residual exposure. What is ruled out is the failure that destroys data: nothing here can walk
 * into a foreign subtree, so a lost race can never cost more than a single entry.
 */
describe('safety: teardown removes only what this run allocated', () => {
  const props: string[] = [];
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = {
      [RUN_ROOT_ENV]: process.env[RUN_ROOT_ENV],
      [RUN_TOKEN_ENV]: process.env[RUN_TOKEN_ENV],
      [RUN_IDENTITY_ENV]: process.env[RUN_IDENTITY_ENV],
      STHAYI_HOME: process.env.STHAYI_HOME,
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // These tests drive setup()/teardown() by hand inside a process already running under one. The
    // root, the token and the identity are ONE published fact and are restored together: leaving a
    // simulated run's identity behind next to the real run's path describes a root that does not
    // exist, and every later allocation in this worker would refuse it.
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    // Newest first. A foreign tree these tests plant INSIDE a root they also keep has to go before
    // the root does: teardown refuses to enter anything it has no creation record for, so a
    // replacement still standing would (correctly) abort the root's own removal and leak it.
    for (const p of props.splice(0).reverse()) {
      try {
        fs.chmodSync(p, 0o700); // a prop left non-private must still be sweepable
      } catch {
        // already gone
      }
      // Several scenarios deliberately plant a SYMLINK where a directory used to be. The test
      // planted it, so the test detaches it — one unlink, which removes the link and never what it
      // points at. `removeOwned` will not do it: its record describes a directory that is already
      // gone, and a retired record must never authorise removing whatever took the name.
      if (fs.lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink() === true) {
        fs.unlinkSync(p);
        continue;
      }
      removeOwned(p);
    }
  });

  /** Record a directory this test created, so its own cleanup removes it by proven identity. */
  function keep(dir: string): string {
    const canonical = trackOwned(dir);
    props.push(canonical);
    return canonical;
  }

  /** Record a directory only if the code under test left it standing. */
  function keepIfPresent(dir: string): void {
    if (fs.existsSync(dir)) {
      keep(dir);
    }
  }

  const systemTemp = (): string => fs.realpathSync(os.tmpdir());

  /** Move an allocated directory out of the way and stand a foreign tree at its name. */
  function substitute(dir: string): { aside: string; canary: string } {
    const aside = path.join(systemTemp(), `${path.basename(dir)}-aside`);
    fs.renameSync(dir, aside);
    keep(aside);
    fs.mkdirSync(path.join(dir, 'nested'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'nested', 'canary'), 'FOREIGN');
    fs.writeFileSync(path.join(dir, 'top-canary'), 'FOREIGN-TOP');
    // The stand-in is NOT recorded here. Recording it would hand cleanup an identity for the very
    // directory each scenario asserts is left alone, and the assertion would then be testing this
    // helper rather than the invariant. Each scenario adopts the litter with keepIfPresent() AFTER
    // it has finished asserting on it.
    return { aside, canary: path.join(dir, 'nested', 'canary') };
  }

  it('a run-root child SUBSTITUTED after the listing is refused, never walked', () => {
    const teardown = setup({ systemTemp: systemTemp() });
    const root = keep(String(process.env[RUN_ROOT_ENV]));

    const fixture = runTempDir('sthayi-ownprobe-');
    fs.writeFileSync(path.join(fixture, 'ours'), 'OURS');
    const name = path.basename(fixture);

    // The names a listing produces are only meaningful while the inodes behind them are the ones
    // that were allocated. Swapping from inside the listing call puts the substitution in exactly
    // that window, deterministically — the same window a peer process wins by chance.
    let swapped = false;
    const realReaddir = fs.readdirSync;
    vi.spyOn(fs, 'readdirSync').mockImplementation(((p: fs.PathLike, o?: unknown) => {
      const listed = (realReaddir as unknown as (a: fs.PathLike, b?: unknown) => unknown)(p, o);
      if (!swapped && String(p) === root) {
        swapped = true;
        substitute(fixture);
      }
      return listed;
    }) as typeof fs.readdirSync);

    teardown();
    vi.restoreAllMocks();

    expect(swapped).toBe(true); // the race really was run
    // The substitute wears the name this run allocated and not the inode it recorded, so it is
    // refused outright rather than descended into on the strength of a matching pathname.
    expect(fs.readFileSync(path.join(root, name, 'nested', 'canary'), 'utf8')).toBe('FOREIGN');
    expect(fs.readFileSync(path.join(root, name, 'top-canary'), 'utf8')).toBe('FOREIGN-TOP');
    expect(fs.existsSync(root)).toBe(true); // refusing one child leaks the root, on purpose
    keepIfPresent(path.join(root, name)); // asserted on; now this test's own litter to remove
  });

  it('a run root REPLACED before its identity is published is never adopted', () => {
    const base = systemTemp();
    // The window is after the wrapped exclusive `mkdir` captured what it made but before setup's
    // own first identity read. POSIX reaches that point through its second no-follow directory open
    // (the first belongs to the wrapper); Windows reaches it through its third lstat (the wrapper's
    // before/after pair comes first). Driving the swap from inside that platform-specific read makes
    // the replacement deterministic and proves setup carries the wrapper's creation receipt rather
    // than minting new authority from the object that the read finds.
    let replaced: string | undefined;
    let runRootOpens = 0;
    let runRootLstats = 0;
    const plantReplacement = (target: string): void => {
      replaced = target;
      // Allocate the stand-in while the original still exists, so the two identities differ even
      // on a filesystem that immediately recycles the full tuple after the last handle closes.
      const staged = fs.mkdtempSync(path.join(base, 'sthayi-setup-replacement-'));
      const stagedIdentity = identityFromBigStat(fs.lstatSync(staged, { bigint: true }));
      if (stagedIdentity === null) throw new Error('replacement has no test identity');
      fs.rmdirSync(target); // the empty root this run just created
      // The stand-in is planted OUTSIDE any run root, so nothing would record what goes inside it
      // and this test could never take its own litter away again. Adopting the stand-in first and
      // filling it second is what puts its contents in the creation ledger. It changes nothing
      // setup() can see: the identity it bound is already gone either way.
      fs.renameSync(staged, target);
      props.push(trackOwned(target, stagedIdentity));
      fs.mkdirSync(path.join(target, 'nested'), { mode: 0o700 });
      fs.writeFileSync(path.join(target, 'nested', 'canary'), 'FOREIGN');
    };
    if (process.platform === 'win32') {
      const realLstat = fs.lstatSync;
      vi.spyOn(fs, 'lstatSync').mockImplementation(((p: fs.PathLike, o?: unknown) => {
        const target = String(p);
        const runRootLstat = path.basename(target).startsWith('sthayi-run-');
        if (runRootLstat) runRootLstats += 1;
        if (replaced === undefined && runRootLstat && runRootLstats === 3) {
          plantReplacement(target);
        }
        return (realLstat as unknown as (a: fs.PathLike, b?: unknown) => fs.Stats)(p, o);
      }) as typeof fs.lstatSync);
    } else {
      const realOpen = fs.openSync;
      vi.spyOn(fs, 'openSync').mockImplementation(((
        p: fs.PathLike,
        flags: unknown,
        mode?: unknown,
      ) => {
        const target = String(p);
        const runRootDirectoryOpen =
          path.basename(target).startsWith('sthayi-run-') &&
          typeof flags === 'number' &&
          (flags & fs.constants.O_DIRECTORY) !== 0;
        if (runRootDirectoryOpen) runRootOpens += 1;
        if (replaced === undefined && runRootDirectoryOpen && runRootOpens === 2) {
          plantReplacement(target);
        }
        return (realOpen as unknown as (a: fs.PathLike, b: unknown, c?: unknown) => number)(
          p,
          flags,
          mode,
        );
      }) as typeof fs.openSync);
    }

    let teardown: (() => void) | undefined;
    expect(() => {
      teardown = setup({ systemTemp: base });
    }).toThrow(/was replaced while this run was creating it/);
    vi.restoreAllMocks();

    expect(teardown).toBeUndefined(); // nothing was published, so nothing can be torn down
    expect(replaced).toBeTypeOf('string');
    const foreign = String(replaced);
    // A replacement must not be adopted, and must not be unwound either: the unwind removes entries
    // only through a name that still resolves to the inode this run created.
    expect(fs.readFileSync(path.join(foreign, 'nested', 'canary'), 'utf8')).toBe('FOREIGN');
    expect(fs.existsSync(path.join(foreign, '.sthayi-test-run'))).toBe(false);
    keepIfPresent(foreign);
  });

  it("a fake home's ALLOCATION replaced at its own path survives cleanup byte for byte", () => {
    const home = createFakeHome();
    fs.writeFileSync(path.join(home.home, 'ours'), 'OURS');
    // The allocation, not the home: that is the directory whose identity was recorded, so that is
    // the name a peer has to win to turn a routine teardown into the erasure of a foreign tree.
    const at = home.fixture;
    const { canary } = substitute(at);

    home.cleanup();

    expect(fs.readFileSync(canary, 'utf8')).toBe('FOREIGN');
    expect(fs.readFileSync(path.join(at, 'top-canary'), 'utf8')).toBe('FOREIGN-TOP');
    keepIfPresent(at);
  });

  it.skipIf(process.platform === 'win32')(
    'CONTROL — a fake home allocation turned into a SYMLINK: the target keeps every byte',
    () => {
      // A control, and named as one: the removal primitives never follow a symlink, so this shape
      // is safe on the primitive alone rather than on ownership tracking. It is here because the
      // property is load-bearing and has to keep holding, not because ownership is what secures it.
      const home = createFakeHome();
      const at = home.fixture;
      const victim = keep(fs.mkdtempSync(path.join(systemTemp(), 'sthayi-homevictim-')));
      fs.writeFileSync(path.join(victim, 'canary'), 'VICTIM');

      const aside = path.join(systemTemp(), `${path.basename(at)}-aside`);
      fs.renameSync(at, aside);
      keep(aside);
      fs.symlinkSync(victim, at);

      home.cleanup();

      // Removing a link removes the entry; a removal that resolved it would empty the victim.
      expect(fs.readFileSync(path.join(victim, 'canary'), 'utf8')).toBe('VICTIM');
      expect(fs.readdirSync(victim)).toEqual(['canary']);
      if (fs.existsSync(at)) {
        fs.unlinkSync(at);
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'a run root that turns GROUP-ACCESSIBLE mid-walk stops every further removal',
    () => {
      const teardown = setup({ systemTemp: systemTemp() });
      const root = keep(String(process.env[RUN_ROOT_ENV]));
      const fixture = runTempDir('sthayi-modeprobe-');
      for (const name of ['a', 'b', 'c']) {
        fs.writeFileSync(path.join(fixture, name), `FIXTURE-${name}`);
      }

      // The mode is flipped once the fixture has been listed and before anything inside it has been
      // removed. A root anyone can write is a root anyone can have redirected, and its contents can
      // no longer be attributed to this run — so the walk must stop where it stands.
      let flipped = false;
      const realReaddir = fs.readdirSync;
      vi.spyOn(fs, 'readdirSync').mockImplementation(((p: fs.PathLike, o?: unknown) => {
        const listed = (realReaddir as unknown as (a: fs.PathLike, b?: unknown) => unknown)(p, o);
        if (!flipped && String(p) === fixture) {
          flipped = true;
          fs.chmodSync(root, 0o777);
        }
        return listed;
      }) as typeof fs.readdirSync);

      teardown();
      vi.restoreAllMocks();

      expect(flipped).toBe(true);
      expect(fs.existsSync(root)).toBe(true);
      expect(fs.readdirSync(fixture).sort()).toEqual(['a', 'b', 'c']);
    },
  );

  it('a fixture that reports a DIFFERENT DEVICE is refused, not descended into', () => {
    const teardown = setup({ systemTemp: systemTemp() });
    const root = keep(String(process.env[RUN_ROOT_ENV]));
    const fixture = runTempDir('sthayi-devprobe-');
    fs.mkdirSync(path.join(fixture, 'nested'), { mode: 0o700 });
    fs.writeFileSync(path.join(fixture, 'nested', 'canary'), 'FIXTURE');

    // A mount appearing at a fixture's name puts a different filesystem there. The inode number
    // alone is meaningless across devices, so the device is part of the recorded identity and a
    // change to it reads as a substitution.
    const realLstat = fs.lstatSync;
    vi.spyOn(fs, 'lstatSync').mockImplementation(((p: fs.PathLike, o?: unknown) => {
      const st = (realLstat as unknown as (a: fs.PathLike, b?: unknown) => fs.Stats)(p, o);
      if (String(p) === fixture) {
        Object.defineProperty(st, 'dev', { value: st.dev + 1, configurable: true });
      }
      return st;
    }) as typeof fs.lstatSync);

    teardown();
    vi.restoreAllMocks();

    expect(fs.existsSync(root)).toBe(true);
    expect(fs.readFileSync(path.join(fixture, 'nested', 'canary'), 'utf8')).toBe('FIXTURE');
  });

  it.skipIf(process.platform === 'win32')(
    'a SYMLINK standing where an allocated fixture was is refused, not detached',
    () => {
      const base = systemTemp();
      const teardown = setup({ systemTemp: base });
      const root = keep(String(process.env[RUN_ROOT_ENV]));
      const fixture = runTempDir('sthayi-linkprobe-');
      const victim = keep(fs.mkdtempSync(path.join(base, 'sthayi-fixvictim-')));
      fs.writeFileSync(path.join(victim, 'canary'), 'VICTIM');

      const aside = path.join(base, `${path.basename(fixture)}-aside`);
      fs.renameSync(fixture, aside);
      keep(aside);
      fs.symlinkSync(victim, fixture);

      teardown();

      // An allocated name occupied by anything other than the inode that was allocated is a
      // substitution, and a substitution stops teardown rather than steering it.
      expect(fs.lstatSync(fixture).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(path.join(victim, 'canary'), 'utf8')).toBe('VICTIM');
      expect(fs.existsSync(root)).toBe(true);
      fs.unlinkSync(fixture);
    },
  );

  it('no test helper hands a pathname to a recursive removal primitive', () => {
    const helpers = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'helpers');
    const hits: string[] = [];
    for (const name of fs.readdirSync(helpers).sort()) {
      if (!name.endsWith('.ts')) {
        continue;
      }
      const lines = fs.readFileSync(path.join(helpers, name), 'utf8').split('\n');
      for (const [i, line] of lines.entries()) {
        const code = line.trim();
        // Prose describing the hazard is not the hazard; only executable lines count.
        if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*')) {
          continue;
        }
        if (/\brmSync\b[^\n]*recursive/.test(code) || /\bfs\.rm\s*\(/.test(code)) {
          hits.push(`${name}:${i + 1}: ${code}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
