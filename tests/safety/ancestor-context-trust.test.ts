import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertTrustedContainingDirReadOnly,
  assertTrustedDirReadOnly,
  ensureTrustedContainingDir,
  establishTrustedDir,
  safeReadTextFile,
  safeWriteFileAtomic,
  untrustedContainingDirReason,
} from '../../packages/cli/src/fs-safe.js';
import { getSkill, listSkills, skillsSeeded } from '../../packages/cli/src/skills.js';
import { removeOwned, trackOwned } from '../helpers/owned-fs.js';
import { runTempDir } from '../helpers/run-temp.js';

/**
 * SAFETY: the ANCESTOR-TRUST INVARIANT. Outside an established trust boundary, "is this component
 * a symlink or a non-directory?" is NOT enough to decide that a directory may be built in, read
 * through, or written through. Two other powers steer us just as completely, and neither shows up
 * in symlink status:
 *
 *  - a GROUP/WORLD-WRITABLE ancestor WITHOUT the sticky bit lets any local peer rename our
 *    directory away and drop their own in its place, or pre-plant the entry we are about to
 *    create — the private 0700 child underneath buys nothing, because the ancestor's writability
 *    is what decides whether that child is still the same directory a moment later;
 *  - a FOREIGN UNPRIVILEGED OWNER may replace any descendant path regardless of the mode bits
 *    beneath it.
 *
 * A NON-STICKY 0777 parent is the canonical shape this file locks down. Beneath one, nothing may
 * be brought into existence and no boundary may be claimed: the memory database, the vault key and
 * the journal checkpoint must not be CREATED, an existing 0700 STHAYI_HOME must not be ESTABLISHED
 * as a trust boundary, and an atomic write must not land under a deeper unsafe ancestor — the
 * unsafe ancestor may sit any number of levels up, so the check is on the whole chain, not the leaf.
 *
 * The one shape that must KEEP WORKING is the root-owned STICKY directory — `/tmp` and
 * `/private/tmp`, mode 1777, uid 0. Sticky is exactly the bit that removes a peer's power to
 * unlink or rename our entry, and every macOS/Linux temp path depends on it; the last group here
 * proves it against the REAL /tmp rather than a fixture.
 *
 * Every refusal is checked against a full recursive snapshot of the unsafe subtree — the set of
 * paths AND permission bits AND content hashes — so a created directory, a written byte, a lock
 * file, or a chmod would show.
 */

const posixOnly = describe.skipIf(process.platform === 'win32');

/** Recursive snapshot: relative path → kind + permission bits + (file) size/sha256 / (link) target. */
type Snapshot = Record<string, string>;

function snapshotDeep(dir: string): Snapshot {
  const out: Snapshot = {};
  const describeEntry = (full: string): string => {
    const st = fs.lstatSync(full);
    const mode = (st.mode & 0o7777).toString(8);
    if (st.isSymbolicLink()) {
      return `link:${mode}:${fs.readlinkSync(full)}`;
    }
    if (st.isDirectory()) {
      return `dir:${mode}`;
    }
    if (!st.isFile()) {
      return `special:${mode}`;
    }
    return `file:${mode}:${st.size}:${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`;
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

/** Force `fs.lstatSync` to report a different owner for ONE exact path — the only way to build a
 *  foreign-owned ancestor without privileges. Everything else passes through untouched, so the
 *  real tree (and therefore the "nothing was created" snapshot) stays honest. */
function spoofOwner(target: string, uid: number): void {
  const real = fs.lstatSync.bind(fs);
  vi.spyOn(fs, 'lstatSync').mockImplementation(((p: fs.PathLike, opts?: unknown) => {
    const st = real(p as string, opts as undefined) as fs.Stats;
    if (String(p) === target) {
      Object.defineProperty(st, 'uid', { value: uid, configurable: true });
    }
    return st;
  }) as typeof fs.lstatSync);
}

describe('safety: ancestor ownership and writability outside a trust boundary', () => {
  let base: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    // CANONICAL temp home: os.tmpdir() is itself reached through /var -> private/var on macOS, and
    // the whole point here is that the only hostile property in the chain is the one we plant.
    base = runTempDir('sthayi-anc-');
    previousHome = process.env.STHAYI_HOME;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousHome === undefined) {
      // biome-ignore lint/performance/noDelete: unsetting an env var; assigning undefined coerces to "undefined".
      delete process.env.STHAYI_HOME;
    } else {
      process.env.STHAYI_HOME = previousHome;
    }
    // chmod back before rm: a 0500 fixture would otherwise survive the sweep.
    fs.chmodSync(base, 0o700);
    removeOwned(base);
  });

  /** Wording produced ONLY by the ancestor-trust invariant — the two doors it governs. Matching on
   *  it (rather than on any refusal) is what makes these cases load-bearing: the separate
   *  symlink/non-directory refusals cannot satisfy it. */
  const NEW_REFUSAL = /not a safe location for Sthayi state|refusing to create anything inside/;

  /** An unsafe ancestor `root`, and the target path reached through it. */
  interface Shape {
    name: string;
    /** builds the tree, returns [the unsafe subtree root to snapshot, the boundary/dir, the file] */
    plant: () => { unsafe: string; dir: string; file: string };
    /**
     * What establishTrustedDir/assertTrustedDirReadOnly must say. When the unsafe directory IS the
     * boundary being established (shapes a/a-group) the boundary rule itself already refuses it by
     * name; the ancestor invariant is what covers every other shape, and what covers the
     * create/write/read doors in all of them.
     */
    boundaryRefusal: RegExp;
  }

  const shapes: Shape[] = [
    {
      name: '(a) the EXISTING FINAL parent is 0777 and NOT sticky',
      boundaryRefusal: /world-writable/,
      plant: () => {
        const unsafe = path.join(base, 'a-final');
        fs.mkdirSync(unsafe, { mode: 0o700 });
        fs.chmodSync(unsafe, 0o777);
        return { unsafe, dir: unsafe, file: path.join(unsafe, 'sthayi.db') };
      },
    },
    {
      name: '(b) a MISSING child under a 0777 NON-STICKY parent',
      boundaryRefusal: /not a safe location for Sthayi state/,
      plant: () => {
        const unsafe = path.join(base, 'b-missing');
        fs.mkdirSync(unsafe, { mode: 0o700 });
        fs.chmodSync(unsafe, 0o777);
        return {
          unsafe,
          dir: path.join(unsafe, 'kid'),
          file: path.join(unsafe, 'kid', 'sthayi.db'),
        };
      },
    },
    {
      name: '(c) an EXISTING 0700 boundary under a 0777 NON-STICKY parent',
      boundaryRefusal: /not a safe location for Sthayi state/,
      plant: () => {
        const unsafe = path.join(base, 'c-private-child');
        fs.mkdirSync(path.join(unsafe, 'home'), { recursive: true, mode: 0o700 });
        fs.chmodSync(path.join(unsafe, 'home'), 0o700);
        fs.chmodSync(unsafe, 0o777);
        return {
          unsafe,
          dir: path.join(unsafe, 'home'),
          file: path.join(unsafe, 'home', 'sthayi.db'),
        };
      },
    },
    {
      name: '(d) a DEEPER unsafe ancestor above an otherwise-private child',
      boundaryRefusal: /not a safe location for Sthayi state/,
      plant: () => {
        const unsafe = path.join(base, 'd-deep');
        fs.mkdirSync(path.join(unsafe, 'mid', 'priv'), { recursive: true, mode: 0o700 });
        fs.chmodSync(path.join(unsafe, 'mid', 'priv'), 0o700);
        fs.chmodSync(path.join(unsafe, 'mid'), 0o700);
        fs.chmodSync(unsafe, 0o777); // three levels above the target, and still decisive
        return {
          unsafe,
          dir: path.join(unsafe, 'mid', 'priv'),
          file: path.join(unsafe, 'mid', 'priv', 'sthayi.db'),
        };
      },
    },
    {
      name: '(a-group) the EXISTING FINAL parent is GROUP-writable 0770 and NOT sticky',
      boundaryRefusal: /group-writable/,
      plant: () => {
        const unsafe = path.join(base, 'a-group');
        fs.mkdirSync(unsafe, { mode: 0o700 });
        fs.chmodSync(unsafe, 0o770);
        return { unsafe, dir: unsafe, file: path.join(unsafe, 'sthayi.db') };
      },
    },
    {
      name: '(d-group) a DEEPER GROUP-writable 0770 ancestor above a private child',
      boundaryRefusal: /not a safe location for Sthayi state/,
      plant: () => {
        const unsafe = path.join(base, 'd-group');
        fs.mkdirSync(path.join(unsafe, 'mid', 'priv'), { recursive: true, mode: 0o700 });
        fs.chmodSync(unsafe, 0o770);
        return {
          unsafe,
          dir: path.join(unsafe, 'mid', 'priv'),
          file: path.join(unsafe, 'mid', 'priv', 'sthayi.db'),
        };
      },
    },
  ];

  posixOnly('every fs-safe entry point refuses, and NOTHING is created', () => {
    for (const shape of shapes) {
      it(`${shape.name} — establish/observe/create/write/read all refuse`, () => {
        const { unsafe, dir, file } = shape.plant();
        const before = snapshotDeep(unsafe);

        // The two boundary doors — the STHAYI_HOME shape.
        expect(() => establishTrustedDir(dir, 'sthayi home', { mode: 0o700 })).toThrow(
          shape.boundaryRefusal,
        );
        expect(() => assertTrustedDirReadOnly(dir, 'sthayi home')).toThrow(shape.boundaryRefusal);

        // The direct-caller doors — SqliteDriver.open / NodeCrypto.open / FileCheckpoint use these.
        expect(() =>
          ensureTrustedContainingDir(file, 'refusing to open the memory database'),
        ).toThrow(NEW_REFUSAL);
        expect(() => assertTrustedContainingDirReadOnly(file, 'probe')).toThrow(NEW_REFUSAL);
        expect(untrustedContainingDirReason(file, 'probe')).toMatch(NEW_REFUSAL);

        // The shared write/read doors.
        expect(() => safeWriteFileAtomic(file, 'hijacked\n')).toThrow(NEW_REFUSAL);
        expect(() => safeReadTextFile(file, 'probe')).toThrow(NEW_REFUSAL);

        // Not one path, byte, mode or lock changed anywhere beneath the unsafe ancestor.
        expect(snapshotDeep(unsafe)).toEqual(before);
        expect(fs.existsSync(file)).toBe(false);
      });
    }

    it('the refusal names the mode AND the remedy, so a user can act on it', () => {
      const unsafe = path.join(base, 'msg');
      fs.mkdirSync(unsafe, { mode: 0o700 });
      fs.chmodSync(unsafe, 0o777);
      let msg = '';
      try {
        establishTrustedDir(path.join(unsafe, 'home'), 'sthayi home');
      } catch (err) {
        msg = (err as Error).message;
      }
      expect(msg).toContain(unsafe);
      expect(msg).toMatch(/mode 777/);
      expect(msg).toMatch(/NOT sticky/);
      expect(msg).toMatch(/chmod 700/);
    });
  });

  posixOnly('a FOREIGN UNPRIVILEGED OWNER of an ancestor is refused', () => {
    /** A uid that is neither us nor root. Never actually chowned — only reported (see spoofOwner). */
    const FOREIGN = (typeof process.getuid === 'function' ? process.getuid() : 0) + 4242;

    it('a foreign-owned ancestor at mode 0755 is refused by every entry point, nothing created', () => {
      const unsafe = path.join(base, 'foreign');
      fs.mkdirSync(path.join(unsafe, 'home'), { recursive: true, mode: 0o700 });
      fs.chmodSync(unsafe, 0o755); // permission bits alone say nothing — the OWNER is the power here
      const dir = path.join(unsafe, 'home');
      const file = path.join(dir, 'sthayi.db');
      const before = snapshotDeep(unsafe);

      spoofOwner(unsafe, FOREIGN);

      const owned = new RegExp(`owned by uid ${FOREIGN} \\(neither you nor root\\)`);
      expect(() => establishTrustedDir(dir, 'sthayi home', { mode: 0o700 })).toThrow(owned);
      expect(() => assertTrustedDirReadOnly(dir, 'sthayi home')).toThrow(owned);
      expect(() => ensureTrustedContainingDir(file, 'probe')).toThrow(owned);
      expect(() => assertTrustedContainingDirReadOnly(file, 'probe')).toThrow(owned);
      expect(() => safeWriteFileAtomic(file, 'hijacked\n')).toThrow(owned);

      vi.restoreAllMocks();
      expect(snapshotDeep(unsafe)).toEqual(before);
      expect(fs.existsSync(file)).toBe(false);
    });

    it('a foreign-owned ancestor is refused even when the target is a MISSING deep chain', () => {
      const unsafe = path.join(base, 'foreign-deep');
      fs.mkdirSync(unsafe, { mode: 0o700 });
      const before = snapshotDeep(unsafe);

      spoofOwner(unsafe, FOREIGN);
      expect(() =>
        ensureTrustedContainingDir(path.join(unsafe, 'a', 'b', 'c', 'sthayi.db'), 'probe'),
      ).toThrow(/neither you nor root/);

      vi.restoreAllMocks();
      expect(snapshotDeep(unsafe)).toEqual(before);
      expect(fs.readdirSync(unsafe)).toEqual([]);
    });

    // The complement, and the reason the rule is `uid !== us && uid !== 0` rather than `uid === us`:
    // /, /Users, /private, /var/folders and /tmp are ALL root-owned. Refusing root would refuse
    // every real installation.
    it('a ROOT-owned ancestor at mode 0755 is ACCEPTED — the real chain depends on it', () => {
      const rootish = path.join(base, 'rootish');
      fs.mkdirSync(path.join(rootish, 'home'), { recursive: true, mode: 0o700 });
      fs.chmodSync(rootish, 0o755);

      spoofOwner(rootish, 0);
      expect(establishTrustedDir(path.join(rootish, 'home'), 'sthayi home', { mode: 0o700 })).toBe(
        path.join(rootish, 'home'),
      );
    });
  });

  posixOnly('a component CREATED or RACED IN during the chain walk is strictly validated', () => {
    /** Make `fs.mkdirSync` behave as if a peer won the race at `target`: the level appears, but
     *  wide open (0777) rather than with the mode we asked for. */
    function raceInWorldWritable(target: string): void {
      const real = fs.mkdirSync.bind(fs);
      vi.spyOn(fs, 'mkdirSync').mockImplementation(((p: fs.PathLike, opts?: unknown) => {
        const r = real(p as string, opts as undefined);
        if (String(p) === target) {
          fs.chmodSync(p as string, 0o777);
        }
        return r;
      }) as typeof fs.mkdirSync);
    }

    it('OUTSIDE a boundary: a level that races in world-writable is refused, nothing written inside', () => {
      const root = path.join(base, 'race-out');
      fs.mkdirSync(root, { mode: 0o700 });
      const mid = path.join(root, 'mid');
      raceInWorldWritable(mid);

      expect(() =>
        ensureTrustedContainingDir(path.join(mid, 'deeper', 'sthayi.db'), 'probe', { mode: 0o700 }),
      ).toThrow(/world-writable/);

      vi.restoreAllMocks();
      // the raced-in level is left exactly as the "peer" made it — and is EMPTY
      expect(fs.lstatSync(mid).mode & 0o777).toBe(0o777);
      expect(fs.readdirSync(mid)).toEqual([]);
    });

    it('BENEATH a boundary: the same race at a level below the home is refused too', () => {
      const home = establishTrustedDir(path.join(base, 'race-in'), 'sthayi home', { mode: 0o700 });
      const sub = path.join(home, 'sub');
      raceInWorldWritable(sub);

      expect(() =>
        ensureTrustedContainingDir(path.join(sub, 'deeper', 'sthayi.db'), 'probe', { mode: 0o700 }),
      ).toThrow(/world-writable/);

      vi.restoreAllMocks();
      expect(fs.lstatSync(sub).mode & 0o777).toBe(0o777);
      expect(fs.readdirSync(sub)).toEqual([]);
    });

    it('a level that races in FOREIGN-OWNED is refused as well', () => {
      const root = path.join(base, 'race-owner');
      fs.mkdirSync(root, { mode: 0o700 });
      const mid = path.join(root, 'mid');
      spoofOwner(mid, (typeof process.getuid === 'function' ? process.getuid() : 0) + 4242);

      expect(() =>
        ensureTrustedContainingDir(path.join(mid, 'deeper', 'sthayi.db'), 'probe', { mode: 0o700 }),
      ).toThrow(/not you/);

      vi.restoreAllMocks();
      expect(fs.readdirSync(mid)).toEqual([]);
    });
  });

  // (f) the DIRECT skills readers. skills.ts and skills-trust.test.ts belong to another change in
  // flight, so this covers the readers from the outside — importing them, never editing them.
  posixOnly('the direct skills readers refuse a home under an unsafe ancestor', () => {
    it('listSkills / getSkill / skillsSeeded refuse instead of serving a planted skill', () => {
      const unsafe = path.join(base, 'skills-unsafe');
      const home = path.join(unsafe, 'home');
      fs.mkdirSync(path.join(home, 'skills', 'planted'), { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        path.join(home, 'skills', 'planted', 'SKILL.md'),
        '---\nname: planted\ndescription: ATTACKER CONTENT\n---\nbody\n',
        { mode: 0o600 },
      );
      fs.chmodSync(unsafe, 0o777); // the ancestor above the home — the home itself stays 0700
      process.env.STHAYI_HOME = home;
      const before = snapshotDeep(unsafe);

      expect(() => listSkills()).toThrow(/not a safe location for Sthayi state/);
      expect(() => getSkill('planted')).toThrow(/not a safe location for Sthayi state/);
      expect(() => skillsSeeded()).toThrow(/not a safe location for Sthayi state/);

      expect(snapshotDeep(unsafe)).toEqual(before);
    });
  });

  posixOnly('PRESERVED: the root-owned STICKY /tmp shape keeps working', () => {
    it('the real /tmp is root-owned and sticky, and state can still be built directly under it', () => {
      const realTmp = fs.realpathSync(os.platform() === 'darwin' ? '/private/tmp' : '/tmp');
      const st = fs.lstatSync(realTmp);
      expect(st.uid).toBe(0); // root-owned…
      expect(st.mode & 0o1000).not.toBe(0); // …and sticky: the shape this rule must never break

      // trackOwned records the device/inode NOW, so the cleanup below removes this directory on
      // the strength of what it created rather than on the strength of a name in the one temp root
      // every user on the machine shares.
      const home = trackOwned(fs.mkdtempSync(path.join(realTmp, 'sthayi-sticky-')));
      // Cryptographically unique, and CLAIMED EXCLUSIVELY. /tmp is shared with every user and
      // every other process: a pid-derived name is recyclable, so a peer's file could be adopted,
      // overwritten and then deleted by this test. O_EXCL means the name is ours or the test
      // fails; the cleanup below only ever removes a path this test proved it created.
      const direct = path.join(
        realTmp,
        `sthayi-sticky-direct-${crypto.randomBytes(12).toString('hex')}.txt`,
      );
      // Each fixture is released by the `finally` of the block that created it. These two live in
      // the REAL /tmp, outside the run root, so nothing else sweeps them: a failure while claiming
      // `direct` must still take `home` with it, or the failure leaves a permanent stray.
      try {
        const claim = fs.openSync(direct, 'wx', 0o600); // throws if anything already exists there
        try {
          fs.closeSync(claim);
          // a boundary established as a child of root-owned sticky /tmp
          expect(
            establishTrustedDir(path.join(home, 'inner'), 'sthayi home', { mode: 0o700 }),
          ).toBe(path.join(home, 'inner'));
          // and a file written DIRECTLY into root-owned sticky /tmp, with no boundary at all
          safeWriteFileAtomic(direct, 'sticky-ok\n');
          expect(safeReadTextFile(direct, 'probe')).toBe('sticky-ok\n');
        } finally {
          fs.rmSync(direct, { force: true });
        }
      } finally {
        removeOwned(home);
      }
      expect(fs.existsSync(direct)).toBe(false);
      expect(fs.existsSync(home)).toBe(false);
    });

    it('a STICKY world-writable ancestor is accepted; the SAME ancestor without +t is refused', () => {
      const sticky = path.join(base, 'sticky-anc');
      fs.mkdirSync(path.join(sticky, 'home'), { recursive: true, mode: 0o700 });
      fs.chmodSync(sticky, 0o1777);
      expect(establishTrustedDir(path.join(sticky, 'home'), 'sthayi home', { mode: 0o700 })).toBe(
        path.join(sticky, 'home'),
      );

      // the ONLY difference is the sticky bit
      const loose = path.join(base, 'loose-anc');
      fs.mkdirSync(path.join(loose, 'home'), { recursive: true, mode: 0o700 });
      fs.chmodSync(loose, 0o777);
      expect(() => establishTrustedDir(path.join(loose, 'home'), 'sthayi home')).toThrow(
        /NOT sticky/,
      );
    });

    it('the ordinary private chain is untouched: a 0700 tree still establishes, writes and reads', () => {
      const home = establishTrustedDir(path.join(base, 'healthy', 'home'), 'sthayi home', {
        mode: 0o700,
      });
      const file = path.join(home, 'nested', 'state.json');
      ensureTrustedContainingDir(file, 'probe', { mode: 0o700 });
      safeWriteFileAtomic(file, '{"ok":true}\n');
      expect(safeReadTextFile(file, 'probe')).toBe('{"ok":true}\n');
      expect(fs.lstatSync(path.join(base, 'healthy')).mode & 0o777).toBe(0o700);
      expect(fs.lstatSync(home).mode & 0o777).toBe(0o700);
    });
  });
});
