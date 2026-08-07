import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decodeIdentity,
  encodeIdentity,
  identityFromBigStat,
  removeOwned,
  sameIdentity,
  trackOwned,
} from '../helpers/owned-fs.js';
import { runTempDir } from '../helpers/run-temp.js';
import {
  RUN_DIRS,
  RUN_FIXTURES,
  RUN_IDENTITY_ENV,
  RUN_MARKER,
  RUN_ROOT_ENV,
  RUN_TOKEN_ENV,
} from '../helpers/temp-sweep.js';

/**
 * SAFETY: fixture allocation must fail closed rather than scatter state outside the run root.
 *
 * A run root is published so that teardown can delete ONE directory it owns instead of scanning a
 * shared temp root for names that look like ours. That only holds if every fixture actually lands
 * inside it. Silently falling back to the shared temp root when the published root is missing,
 * replaced, or a symlink defeats the whole arrangement twice over: the fixtures — which include
 * vault keys and SQLite stores — end up somewhere nothing will ever clean, and a symlinked root
 * puts them wherever the link points.
 *
 * INVARIANT: the shared temp root is used ONLY when no run root was published at all. When one is
 * published, allocation proceeds only against a real directory (never a symlink), owned by us,
 * whose full ephemeral tuple matches the identity published at creation and which carries this
 * run's token. A differing tuple refuses before creation. A full tuple collision completed before
 * the first descriptor open is the explicit residual tested below.
 *
 * The expected identity travels in the ENVIRONMENT, not in the directory. Validating only a marker
 * would let every replacement vouch for itself. The tuple blocks ordinary self-vouching when it
 * differs; it is not an unforgeable generation. Once POSIX opens the root, a retained descriptor
 * pins one object against the observed same-layer delete/recreate reuse through recording. Windows
 * retains the documented weaker path-only checks.
 *
 * VALIDATING THE ROOT IS NOT THE SAME AS ALLOCATING INSIDE IT. `mkdtemp` resolves the parent path
 * again inside the call, after every check has returned, so a same-uid peer sharing the system
 * temp root can move that name onto a symlink or another directory in between and the fixture —
 * vault key, store, journal — is created wherever the name now leads. Portable Node offers no
 * `mkdirat`, so the second half of the invariant is a PROOF AFTER THE FACT: the root must still be
 * the same inode, and the fixture's canonical path must sit directly beneath the root's canonical
 * path, on that same inode. A fixture that cannot be proved contained is refused, never returned.
 *
 * PRIVACY IS A PRECONDITION, RE-ASSERTED EACH TIME. A run root that is readable or writable by
 * group or world exposes every fixture secret and lets a second account plant directories this run
 * would adopt, so the mode is checked on every allocation rather than assumed from creation.
 */
describe('safety: run-temp allocation fails closed', () => {
  const strays: string[] = [];
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {
      [RUN_ROOT_ENV]: process.env[RUN_ROOT_ENV],
      [RUN_TOKEN_ENV]: process.env[RUN_TOKEN_ENV],
      [RUN_IDENTITY_ENV]: process.env[RUN_IDENTITY_ENV],
    };
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const s of strays.splice(0)) {
      // Several scenarios deliberately plant a SYMLINK where a directory used to be. The test
      // planted it, so the test detaches it — one unlink, which removes the link and never what it
      // points at. `removeOwned` will not do it: its record describes a directory that is already
      // gone, and a retired record must never authorise removing whatever took the name.
      if (fs.lstatSync(s, { throwIfNoEntry: false })?.isSymbolicLink() === true) {
        fs.unlinkSync(s);
        continue;
      }
      removeOwned(s);
    }
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  });

  /** A directory shaped exactly like a real run root, with its identity published. */
  function publishRoot(): string {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sthayi-runprobe-')),
    );
    strays.push(trackOwned(root));
    const token = crypto.randomBytes(12).toString('hex');
    fs.writeFileSync(path.join(root, RUN_MARKER), `${process.pid}\n${token}\n`, { mode: 0o600 });
    const id = identityFromBigStat(fs.lstatSync(root, { bigint: true }));
    if (id === null) throw new Error('run root has no test identity');
    process.env[RUN_ROOT_ENV] = root;
    process.env[RUN_TOKEN_ENV] = token;
    process.env[RUN_IDENTITY_ENV] = encodeIdentity(id);
    return root;
  }

  /** Assert the call refuses AND never reached mkdtemp — a refusal must create nothing. */
  function expectRefusalWithoutMkdtemp(match: RegExp): void {
    const spy = vi.spyOn(fs, 'mkdtempSync');
    expect(() => runTempDir('sthayi-x-')).toThrow(match);
    expect(spy).not.toHaveBeenCalled();
  }

  it('healthy published root: allocates inside it', () => {
    const root = publishRoot();
    const d = runTempDir('sthayi-x-');
    expect(d.startsWith(root)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'POSIX allocation keeps the root descriptor live through mkdtemp, both ledgers, and trackOwned, then closes it',
    () => {
      const root = publishRoot();
      const prefix = 'sthayi-fd-pin-';
      const events: string[] = [];
      let rootFd: number | undefined;

      const realOpen = fs.openSync;
      const realFstat = fs.fstatSync;
      const realClose = fs.closeSync;
      const realMkdtemp = fs.mkdtempSync;
      const realAppend = fs.appendFileSync;
      const realRealpath = fs.realpathSync;
      const descriptorIsLive = (): void => {
        if (rootFd === undefined) throw new Error('run-root descriptor was not opened');
        expect(() => realFstat(rootFd as number)).not.toThrow();
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
          String(p) === root &&
          typeof flags === 'number' &&
          (flags & fs.constants.O_DIRECTORY) !== 0
        ) {
          rootFd = fd;
          events.push('open');
        }
        return fd;
      }) as typeof fs.openSync);
      vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number, options?: unknown) => {
        const out = (realFstat as unknown as (a: number, b?: unknown) => unknown)(fd, options);
        if (fd === rootFd) events.push('fstat');
        return out;
      }) as typeof fs.fstatSync);
      vi.spyOn(fs, 'mkdtempSync').mockImplementation(((p: string, options?: unknown) => {
        if (path.basename(p) === prefix) {
          descriptorIsLive();
          events.push('mkdtemp');
        }
        return (realMkdtemp as unknown as (a: string, b?: unknown) => string)(p, options);
      }) as typeof fs.mkdtempSync);
      vi.spyOn(fs, 'appendFileSync').mockImplementation(((
        p: fs.PathOrFileDescriptor,
        ...rest: unknown[]
      ) => {
        const basename = typeof p === 'number' ? '' : path.basename(String(p));
        if (basename === RUN_FIXTURES || basename === RUN_DIRS) {
          descriptorIsLive();
          events.push(basename === RUN_FIXTURES ? 'fixture-ledger' : 'dir-ledger');
        }
        return (realAppend as unknown as (a: fs.PathOrFileDescriptor, ...b: unknown[]) => void)(
          p,
          ...rest,
        );
      }) as typeof fs.appendFileSync);
      vi.spyOn(fs, 'realpathSync').mockImplementation(((p: fs.PathLike, options?: unknown) => {
        if (
          String(p).startsWith(path.join(root, prefix)) &&
          events.includes('fixture-ledger') &&
          events.includes('dir-ledger')
        ) {
          descriptorIsLive();
          events.push('trackOwned');
        }
        return (realRealpath as unknown as (a: fs.PathLike, b?: unknown) => string)(p, options);
      }) as typeof fs.realpathSync);
      vi.spyOn(fs, 'closeSync').mockImplementation((fd: number) => {
        if (fd === rootFd) events.push('close');
        return realClose(fd);
      });

      const d = runTempDir(prefix);
      expect(path.dirname(d)).toBe(root);
      expect(rootFd).toBeDefined();
      expect(events).toContain('mkdtemp');
      expect(events).toContain('fixture-ledger');
      expect(events).toContain('dir-ledger');
      expect(events).toContain('trackOwned');
      const closeAt = events.lastIndexOf('close');
      const finalFstatAt = events.lastIndexOf('fstat');
      expect(finalFstatAt).toBeGreaterThan(events.lastIndexOf('trackOwned'));
      expect(closeAt).toBeGreaterThan(finalFstatAt);
      expect(events.filter((e) => e === 'close')).toHaveLength(1);
      expect(() => realFstat(rootFd as number)).toThrow(expect.objectContaining({ code: 'EBADF' }));
    },
  );

  it.skipIf(process.platform === 'win32')(
    'POSIX allocation closes the pinned root descriptor when recording throws',
    () => {
      const root = publishRoot();
      let rootFd: number | undefined;
      let closes = 0;
      const realOpen = fs.openSync;
      const realFstat = fs.fstatSync;
      const realClose = fs.closeSync;
      const realAppend = fs.appendFileSync;

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
          String(p) === root &&
          typeof flags === 'number' &&
          (flags & fs.constants.O_DIRECTORY) !== 0
        ) {
          rootFd = fd;
        }
        return fd;
      }) as typeof fs.openSync);
      vi.spyOn(fs, 'appendFileSync').mockImplementation(((
        p: fs.PathOrFileDescriptor,
        ...rest: unknown[]
      ) => {
        if (typeof p !== 'number' && path.basename(String(p)) === RUN_FIXTURES) {
          if (rootFd === undefined) throw new Error('run-root descriptor was not opened');
          expect(() => realFstat(rootFd as number)).not.toThrow();
          throw new Error('injected fixture-ledger failure');
        }
        return (realAppend as unknown as (a: fs.PathOrFileDescriptor, ...b: unknown[]) => void)(
          p,
          ...rest,
        );
      }) as typeof fs.appendFileSync);
      vi.spyOn(fs, 'closeSync').mockImplementation((fd: number) => {
        if (fd === rootFd) closes += 1;
        return realClose(fd);
      });

      expect(() => runTempDir('sthayi-fd-failure-')).toThrow(/injected fixture-ledger failure/);
      expect(rootFd).toBeDefined();
      expect(closes).toBe(1);
      expect(() => realFstat(rootFd as number)).toThrow(expect.objectContaining({ code: 'EBADF' }));
      expect(fs.readdirSync(root).filter((name) => name.startsWith('sthayi-fd-failure-'))).toEqual(
        [],
      );
    },
  );

  it('root MISSING: refuses instead of falling back to the shared temp root', () => {
    const root = publishRoot();
    removeOwned(root);
    expectRefusalWithoutMkdtemp(/could not be inspected/);
  });

  it.skipIf(process.platform === 'win32')(
    'root replaced by a SYMLINK: refused, never followed',
    () => {
      const root = publishRoot();
      const victim = fs.realpathSync(
        fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sthayi-runvictim-')),
      );
      strays.push(trackOwned(victim));
      removeOwned(root);
      fs.symlinkSync(victim, root);
      expectRefusalWithoutMkdtemp(/is a symlink/);
      expect(fs.readdirSync(victim)).toEqual([]); // nothing was written through the link
    },
  );

  it('root replaced before descriptor pinning: a different full identity is refused', () => {
    const root = publishRoot();
    const token = String(process.env[RUN_TOKEN_ENV]);

    // Create the replacement WHILE the original still exists. The two directories therefore
    // cannot share an inode, even on overlayfs implementations that immediately recycle the full
    // dev+ino+birthtimeNs tuple after removal. This is the deterministic mismatch branch.
    const replacement = fs.realpathSync(
      fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sthayi-runreplacement-')),
    );
    const replacementId = identityFromBigStat(fs.lstatSync(replacement, { bigint: true }));
    if (replacementId === null) throw new Error('replacement has no test identity');
    trackOwned(replacement, replacementId);
    fs.writeFileSync(path.join(replacement, RUN_MARKER), `${process.pid}\n${token}\n`, {
      mode: 0o600,
    });

    removeOwned(root);
    fs.renameSync(replacement, root);
    strays.push(trackOwned(root, replacementId));

    // The replacement even carries a correct-looking marker — self-vouching must not be enough
    // when the independently published incarnation differs.
    expectRefusalWithoutMkdtemp(/no longer the directory this run created/);
  });

  it('pre-open recreation refuses only if the full tuple differs; an exact tuple collision is the documented residual', () => {
    const root = publishRoot();
    const token = String(process.env[RUN_TOKEN_ENV]);
    const published = decodeIdentity(process.env[RUN_IDENTITY_ENV]);
    if (published === null) throw new Error('published root identity did not round-trip');

    // This is deliberately the shape Linux overlayfs is known to recycle: remove, immediately
    // recreate at the same name, and copy the visible token. No descriptor from runTempDir exists
    // yet, so an implementation that reports the same full ephemeral tuple leaves no observable
    // fact by which this helper can distinguish the two directories. The descriptor pin closes ABA
    // only AFTER its first successful open; it does not pretend to recover history from before it.
    removeOwned(root);
    fs.mkdirSync(root, { mode: 0o700 });
    const replacementId = identityFromBigStat(fs.lstatSync(root, { bigint: true }));
    if (replacementId === null) throw new Error('replacement has no test identity');
    trackOwned(root, replacementId);
    fs.writeFileSync(path.join(root, RUN_MARKER), `${process.pid}\n${token}\n`, { mode: 0o600 });

    if (sameIdentity(replacementId, published)) {
      // Honest residual: every checked fact, including the independently published tuple, collides.
      // The allocation can pin only the replacement that is already standing there and accepts it.
      const d = runTempDir('sthayi-x-');
      expect(path.dirname(d)).toBe(root);
    } else {
      // Filesystems that preserve a discriminator across immediate reuse take the refusal branch.
      expectRefusalWithoutMkdtemp(/no longer the directory this run created/);
    }
  });

  it('WRONG token: refused', () => {
    const root = publishRoot();
    fs.writeFileSync(path.join(root, RUN_MARKER), 'someone-elses-token\n', { mode: 0o600 });
    expectRefusalWithoutMkdtemp(/different run's token/);
  });

  it('MISSING marker: refused', () => {
    const root = publishRoot();
    removeOwned(path.join(root, RUN_MARKER));
    expectRefusalWithoutMkdtemp(/no run marker/);
  });

  it('root published but identity NOT published: refused', () => {
    publishRoot();
    delete process.env[RUN_IDENTITY_ENV];
    expectRefusalWithoutMkdtemp(/identity was never published/);
  });

  it('LEGACY pair-only identity is malformed authority and is refused', () => {
    publishRoot();
    process.env[RUN_IDENTITY_ENV] = '1:2';
    expectRefusalWithoutMkdtemp(/identity was never published/);
  });

  it('same device/inode with a different birth time is a different incarnation and is refused', () => {
    const root = publishRoot();
    const actual = decodeIdentity(process.env[RUN_IDENTITY_ENV]);
    if (actual === null) throw new Error('published root identity did not round-trip');
    process.env[RUN_IDENTITY_ENV] = encodeIdentity({
      ...actual,
      birthtimeNs: (BigInt(actual.birthtimeNs) + 1n).toString(),
    });

    expectRefusalWithoutMkdtemp(/incarnation changed/);
    expect(fs.existsSync(path.join(root, RUN_MARKER))).toBe(true);
  });

  it('ZERO birth time, legacy v2 authority, and malformed JSON are refused', () => {
    publishRoot();
    process.env[RUN_IDENTITY_ENV] = JSON.stringify({
      v: 3,
      dev: '1',
      ino: '2',
      birthtimeNs: '0',
    });
    expectRefusalWithoutMkdtemp(/identity was never published/);
    process.env[RUN_IDENTITY_ENV] = JSON.stringify({
      v: 2,
      dev: '1',
      ino: '2',
      birthtimeNs: '1',
    });
    expectRefusalWithoutMkdtemp(/identity was never published/);
    process.env[RUN_IDENTITY_ENV] = '{not-json';
    expectRefusalWithoutMkdtemp(/identity was never published/);
  });

  it('v3 preserves file identifiers above the safe-integer ceiling without collision', () => {
    const a = identityFromBigStat({
      dev: 9_007_199_254_740_992n,
      ino: 9_007_199_254_740_992n,
      birthtimeNs: 1n,
    } as fs.BigIntStats);
    const b = identityFromBigStat({
      dev: 9_007_199_254_740_993n,
      ino: 9_007_199_254_740_993n,
      birthtimeNs: 1n,
    } as fs.BigIntStats);
    expect(a).toEqual({
      dev: '9007199254740992',
      ino: '9007199254740992',
      birthtimeNs: '1',
    });
    expect(b).toEqual({
      dev: '9007199254740993',
      ino: '9007199254740993',
      birthtimeNs: '1',
    });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    if (a === null || b === null) throw new Error('exact identity unexpectedly refused');
    expect(sameIdentity(a, b)).toBe(false);
    expect(decodeIdentity(encodeIdentity(b))).toEqual(b);
    expect(JSON.parse(encodeIdentity(b))).toMatchObject({ v: 3 });

    // A numeric v2 payload may already have been rounded by JSON/JavaScript. No v2 JSON payload
    // confers authority; v3 exact decimal strings are the only accepted environment representation.
    expect(
      decodeIdentity(
        JSON.stringify({
          v: 2,
          dev: 9_007_199_254_740_992,
          ino: 9_007_199_254_740_992,
          birthtimeNs: '1',
        }),
      ),
    ).toBeNull();
    expect(
      decodeIdentity(
        JSON.stringify({
          v: 2,
          dev: '9007199254740993',
          ino: '9007199254740993',
          birthtimeNs: '1',
        }),
      ),
    ).toBeNull();
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'FOREIGN owner: refused',
    () => {
      const root = publishRoot();
      const real = fs.lstatSync(root);
      vi.spyOn(fs, 'lstatSync').mockImplementation(((p: fs.PathLike, o?: unknown) => {
        if (String(p) === root) {
          return Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
            uid: (process.getuid?.() ?? 0) + 12345,
          }) as fs.Stats;
        }
        return (fs.lstatSync as unknown as (a: fs.PathLike, b?: unknown) => fs.Stats).call(
          fs,
          p,
          o,
        );
      }) as typeof fs.lstatSync);
      // spy is installed on the same binding runTempDir uses; assert the refusal directly
      expect(() => runTempDir('sthayi-x-')).toThrow(/owned by uid/);
    },
  );

  it('NO run root published at all: the shared temp root is the legitimate fallback', () => {
    delete process.env[RUN_ROOT_ENV];
    delete process.env[RUN_TOKEN_ENV];
    delete process.env[RUN_IDENTITY_ENV];
    const d = runTempDir('sthayi-fallback-');
    strays.push(d);
    expect(d.startsWith(fs.realpathSync(os.tmpdir()))).toBe(true);
  });

  it('EMPTY run root variable is treated as unset, not as a broken root', () => {
    process.env[RUN_ROOT_ENV] = '';
    const d = runTempDir('sthayi-fallback-');
    strays.push(d);
    expect(d.startsWith(fs.realpathSync(os.tmpdir()))).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'GROUP- or WORLD-accessible run root: refused before anything is created',
    () => {
      const root = publishRoot();
      // Identity, owner and token are all still correct — only the mode is wrong, and that alone
      // must be disqualifying: those bits are what let another account read a vault key out of a
      // fixture, or plant a directory this run would then treat as its own.
      fs.chmodSync(root, 0o777);
      expectRefusalWithoutMkdtemp(/group- or world-accessible run root/);

      fs.chmodSync(root, 0o750); // group execute alone is still shared access
      expectRefusalWithoutMkdtemp(/group- or world-accessible run root/);

      fs.chmodSync(root, 0o700); // and the private root is still accepted
      expect(runTempDir('sthayi-x-').startsWith(root)).toBe(true);
    },
  );

  /**
   * Replace the run root at the exact check/use gap: after validation has returned and before
   * `mkdtemp` resolves the parent. Driving the swap from inside the `mkdtemp` call is what makes
   * the race deterministic rather than a timing lottery — it is the same window a peer process
   * wins by chance.
   */
  function swapDuringAllocation(swap: () => void): void {
    const realMkdtemp = fs.mkdtempSync;
    vi.spyOn(fs, 'mkdtempSync').mockImplementation(((p: fs.PathLike, o?: unknown) => {
      swap();
      return (realMkdtemp as unknown as (a: fs.PathLike, b?: unknown) => string)(p, o);
    }) as typeof fs.mkdtempSync);
  }

  it.skipIf(process.platform === 'win32')(
    'root swapped for a SYMLINK during allocation: refused, and the victim keeps every byte',
    () => {
      const root = publishRoot();
      const victim = fs.realpathSync(
        fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sthayi-runvictim-')),
      );
      strays.push(trackOwned(victim));
      fs.writeFileSync(path.join(victim, 'canary'), 'VICTIM-DATA');

      swapDuringAllocation(() => {
        removeOwned(root);
        fs.symlinkSync(victim, root);
      });

      const before = fs.readdirSync(victim).sort();
      expect(() => runTempDir('sthayi-x-')).toThrow(/whose parent changed under it/);

      // WHAT THE REFUSAL COSTS, STATED EXACTLY. `mkdtemp` had already resolved the run-root name —
      // now a link — and created its directory inside the victim before any check could run. That
      // directory is LEFT THERE, empty. Removing it would mean deleting through a parent that is no
      // longer provably ours, which is the one thing this whole arrangement exists to forbid, so an
      // empty stray is the deliberate choice and not an oversight.
      //
      // The properties that hold are therefore: nothing is deleted, every byte the victim already
      // held is still there, and AT MOST ONE empty directory is added. "Nothing is left inside the
      // victim" is NOT one of them, and asserting it would be asserting something false.
      expect(fs.readFileSync(path.join(victim, 'canary'), 'utf8')).toBe('VICTIM-DATA');
      expect(fs.lstatSync(root).isSymbolicLink()).toBe(true);

      const after = fs.readdirSync(victim).sort();
      for (const name of before) {
        expect(after).toContain(name); // nothing the victim held was removed
      }
      const added = after.filter((n) => !before.includes(n));
      expect(added.length).toBeLessThanOrEqual(1);
      for (const name of added) {
        const stray = path.join(victim, name);
        expect(name.startsWith('sthayi-x-')).toBe(true);
        expect(fs.lstatSync(stray).isDirectory()).toBe(true);
        expect(fs.readdirSync(stray)).toEqual([]); // empty: no fixture was ever written into it
        fs.rmdirSync(stray); // one non-recursive rmdir, by the test that caused it
      }
    },
  );

  it('root swapped for ANOTHER DIRECTORY during allocation: refused on identity', () => {
    const root = publishRoot();
    const token = String(process.env[RUN_TOKEN_ENV]);

    swapDuringAllocation(() => {
      removeOwned(root);
      fs.mkdirSync(root, { mode: 0o700 });
      trackOwned(root);
      trackOwned(root);
      // The replacement carries a correct-looking marker and lives at the correct pathname; only
      // the inode differs, and that is the one thing it cannot forge.
      fs.writeFileSync(path.join(root, RUN_MARKER), `${process.pid}\n${token}\n`, { mode: 0o600 });
      fs.writeFileSync(path.join(root, 'NOT-OURS'), 'someone else lives here');
    });

    expect(() => runTempDir('sthayi-x-')).toThrow(/whose parent changed under it/);
    expect(fs.readFileSync(path.join(root, 'NOT-OURS'), 'utf8')).toBe('someone else lives here');
  });

  it('a fixture that cannot be proved DIRECTLY beneath the root is refused, not returned', () => {
    const root = publishRoot();
    const elsewhere = fs.realpathSync(
      fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sthayi-runelsewhere-')),
    );
    strays.push(trackOwned(elsewhere));

    // The root itself stays intact; only the fixture's resolved location is made to land outside
    // it. Containment is decided on the CANONICAL path, so a fixture reached through a path that
    // resolves out of the root is refused even though its requested path looked contained.
    const realRealpath = fs.realpathSync;
    vi.spyOn(fs, 'realpathSync').mockImplementation(((p: fs.PathLike, o?: unknown) => {
      const s = String(p);
      if (s.startsWith(root + path.sep)) {
        return path.join(elsewhere, path.basename(s));
      }
      return (realRealpath as unknown as (a: fs.PathLike, b?: unknown) => string)(p, o);
    }) as typeof fs.realpathSync);

    expect(() => runTempDir('sthayi-x-')).toThrow(/not directly beneath the run root/);
    vi.restoreAllMocks();
    // Refusing must not leave the fixture it made behind: the root was re-proved ours immediately
    // beforehand, so the one entry created inside it is removed with a non-recursive rmdir. What
    // remains is the run's own bookkeeping and nothing else — named exactly, so a fixture that
    // survived a refusal would still fail this.
    expect(fs.readdirSync(root).sort()).toEqual([RUN_DIRS, RUN_MARKER].sort());
  });

  it('an accepted fixture is proved to sit on the run root INODE, not merely at its path', () => {
    const root = publishRoot();
    const d = runTempDir('sthayi-x-');
    expect(path.dirname(d)).toBe(root);
    const parent = identityFromBigStat(fs.lstatSync(path.dirname(d), { bigint: true }));
    const published = decodeIdentity(process.env[RUN_IDENTITY_ENV]);
    expect(parent).not.toBeNull();
    expect(published).not.toBeNull();
    expect(
      sameIdentity(
        parent as NonNullable<typeof parent>,
        published as NonNullable<typeof published>,
      ),
    ).toBe(true);
  });

  it('the shared-temp fallback leaves nothing behind when canonicalisation fails', () => {
    delete process.env[RUN_ROOT_ENV];
    delete process.env[RUN_TOKEN_ENV];
    delete process.env[RUN_IDENTITY_ENV];
    const systemTemp = fs.realpathSync(os.tmpdir());
    const prefix = `sthayi-fallback-leak-${crypto.randomBytes(6).toString('hex')}-`;

    const realRealpath = fs.realpathSync;
    vi.spyOn(fs, 'realpathSync').mockImplementation(((p: fs.PathLike, o?: unknown) => {
      if (path.basename(String(p)).startsWith(prefix)) {
        throw Object.assign(new Error('injected'), { code: 'EIO' });
      }
      return (realRealpath as unknown as (a: fs.PathLike, b?: unknown) => string)(p, o);
    }) as typeof fs.realpathSync);

    expect(() => runTempDir(prefix)).toThrow(/injected/);
    vi.restoreAllMocks();
    // A directory was created before the failure; an ordinary synchronous error must not turn into
    // a permanent stray in the shared temp root, which nothing here will ever sweep.
    expect(fs.readdirSync(systemTemp).filter((n) => n.startsWith(prefix))).toEqual([]);
  });
});
