import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runTempDir } from '../../../tests/helpers/run-temp.js';
import {
  assertReadOnlySthayiHome,
  dbPath,
  ensureSthayiHome,
  keyPath,
  logsDir,
  sthayiHome,
} from './paths.js';

describe('sthayiHome — STHAYI_HOME validation (launcher code-exec guard, spec §1 invariant 7)', () => {
  const original = process.env.STHAYI_HOME;
  afterEach(() => {
    if (original === undefined) {
      Reflect.deleteProperty(process.env, 'STHAYI_HOME');
    } else {
      process.env.STHAYI_HOME = original;
    }
  });

  it('rejects a relative STHAYI_HOME (would yield a relative launcher command)', () => {
    process.env.STHAYI_HOME = 'relative/home';
    expect(() => sthayiHome()).toThrow(/absolute path/);
  });

  it('accepts an absolute STHAYI_HOME verbatim', () => {
    process.env.STHAYI_HOME = '/tmp/sthayi-abs-home';
    expect(sthayiHome()).toBe('/tmp/sthayi-abs-home');
  });
});

describe.skipIf(process.platform === 'win32')(
  'ensureSthayiHome — whole-path trust boundary (fs-safe establishTrustedDir)',
  () => {
    const original = process.env.STHAYI_HOME;
    let base: string;
    beforeEach(() => {
      // realpath: on macOS os.tmpdir() is reached through /var -> private/var, and the home's
      // CANONICAL root is what every derived path follows. A canonical base keeps these
      // assertions byte-exact instead of comparing two spellings of the same directory.
      base = runTempDir('sthayi-paths-');
    });
    afterEach(() => {
      if (original === undefined) {
        Reflect.deleteProperty(process.env, 'STHAYI_HOME');
      } else {
        process.env.STHAYI_HOME = original;
      }
      fs.rmSync(base, { recursive: true, force: true });
    });

    it('creates a fresh home 0700 and returns its canonical root', () => {
      const home = path.join(base, '.sthayi');
      process.env.STHAYI_HOME = home;
      expect(ensureSthayiHome()).toBe(home);
      expect(fs.lstatSync(home).mode & 0o777).toBe(0o700);
    });

    it('refuses a symlinked home BEFORE chmod — the link target keeps its mode', () => {
      const outside = path.join(base, 'outside');
      fs.mkdirSync(outside);
      fs.chmodSync(outside, 0o755);
      const planted = path.join(base, 'planted');
      fs.symlinkSync(outside, planted, 'dir');
      process.env.STHAYI_HOME = planted;
      expect(() => ensureSthayiHome()).toThrow(/symlink/);
      expect(fs.lstatSync(outside).mode & 0o777).toBe(0o755);
      expect(fs.readdirSync(outside)).toEqual([]);
    });

    it('refuses a world-writable home instead of chmodding over it', () => {
      const home = path.join(base, 'ww-home');
      fs.mkdirSync(home);
      fs.chmodSync(home, 0o777);
      process.env.STHAYI_HOME = home;
      expect(() => ensureSthayiHome()).toThrow(/world-writable/);
      expect(fs.lstatSync(home).mode & 0o777).toBe(0o777);
    });

    // INVARIANT (case E): a group-writable home is REFUSED, never silently "repaired" to 0700 —
    // every member of that group could already have planted entries inside while it was open.
    it('refuses an already GROUP-writable home instead of blessing it with a chmod', () => {
      const home = path.join(base, 'gw-home');
      fs.mkdirSync(home);
      fs.chmodSync(home, 0o770);
      process.env.STHAYI_HOME = home;
      expect(() => ensureSthayiHome()).toThrow(/group-writable/);
      expect(fs.lstatSync(home).mode & 0o777).toBe(0o770); // not tightened behind the user's back
    });

    // INVARIANT (case A): an EXISTING home reached through a symlinked parent. lstat on the home
    // itself sees a perfectly ordinary directory — the redirect lives one level up, where every
    // path-based operation (including the mode-tightening chmod) silently lands in the link's
    // target and a later retarget would move the whole home.
    it('refuses an EXISTING home whose parent is a symlink — the outside target is untouched', () => {
      const outside = path.join(base, 'outside-a');
      const victim = path.join(outside, 'existing-home');
      fs.mkdirSync(victim, { recursive: true });
      fs.chmodSync(victim, 0o755);
      fs.symlinkSync(outside, path.join(base, 'hop'), 'dir');
      process.env.STHAYI_HOME = path.join(base, 'hop', 'existing-home');
      expect(() => ensureSthayiHome()).toThrow(/symlink/);
      expect(fs.lstatSync(victim).mode & 0o777).toBe(0o755); // never chmodded through the hop
      expect(fs.readdirSync(victim)).toEqual([]); // and nothing was created inside it
    });

    // INVARIANT (case B): the same shape with a MISSING home. Resolving the symlinked ancestor
    // would create the home inside the attacker's tree, so the refusal comes before the mkdir.
    it('refuses a MISSING home whose parent is a symlink — nothing is created outside', () => {
      const outside = path.join(base, 'outside-b');
      fs.mkdirSync(outside);
      fs.symlinkSync(outside, path.join(base, 'hop2'), 'dir');
      process.env.STHAYI_HOME = path.join(base, 'hop2', 'new-home');
      expect(() => ensureSthayiHome()).toThrow(/symlink/);
      expect(fs.readdirSync(outside)).toEqual([]);
    });

    it('refuses a missing home whose deepest EXISTING ancestor is a symlink (deeper chain)', () => {
      const outside = path.join(base, 'outside-b2');
      fs.mkdirSync(outside);
      fs.symlinkSync(outside, path.join(base, 'hop3'), 'dir');
      process.env.STHAYI_HOME = path.join(base, 'hop3', 'a', 'new-home');
      expect(() => ensureSthayiHome()).toThrow(/symlink/);
      expect(fs.readdirSync(outside)).toEqual([]);
    });

    // The INTERMEDIATE-depth shape, which validating only the immediate parent cannot see: `hop`
    // is a symlink two levels up, so the home's parent (`hop/sub`) lstats as a perfectly ordinary
    // real directory. Follow it and an EXISTING home there gets chmodded to 0700 and has the
    // store, key and checkpoint created inside the OUTSIDE tree — so the WHOLE chain is checked.
    it('refuses an EXISTING home reached through an INTERMEDIATE symlink (depth 2)', () => {
      const outside = path.join(base, 'outside-deep-a');
      const victim = path.join(outside, 'sub', 'existing-home');
      fs.mkdirSync(victim, { recursive: true });
      fs.writeFileSync(path.join(victim, 'pre-existing.txt'), 'OUTSIDE\n');
      fs.chmodSync(victim, 0o755);
      fs.symlinkSync(outside, path.join(base, 'hop-deep-a'), 'dir');

      process.env.STHAYI_HOME = path.join(base, 'hop-deep-a', 'sub', 'existing-home');
      expect(() => ensureSthayiHome()).toThrow(/symlink/);
      expect(() => assertReadOnlySthayiHome()).toThrow(/symlink/);
      expect(fs.lstatSync(victim).mode & 0o777).toBe(0o755); // never chmodded through the hop
      expect(fs.readdirSync(victim)).toEqual(['pre-existing.txt']); // nothing created inside
    });

    // Same shape with a MISSING home whose deepest existing ancestor is a REAL directory reached
    // through the link — inspecting that ancestor alone finds nothing wrong, and the home lands
    // outside. The chain above it is what refuses.
    it('refuses a MISSING home reached through an INTERMEDIATE symlink (depth 2)', () => {
      const outside = path.join(base, 'outside-deep-b');
      fs.mkdirSync(path.join(outside, 'sub'), { recursive: true });
      fs.symlinkSync(outside, path.join(base, 'hop-deep-b'), 'dir');

      process.env.STHAYI_HOME = path.join(base, 'hop-deep-b', 'sub', 'new-home');
      expect(() => ensureSthayiHome()).toThrow(/symlink/);
      expect(fs.readdirSync(path.join(outside, 'sub'))).toEqual([]); // nothing created outside
    });

    // And at greater depth still — the rule is "no link anywhere in the chain", not "no link
    // within N levels".
    it('refuses a home reached through a symlink FOUR levels up', () => {
      const outside = path.join(base, 'outside-deep-c');
      fs.mkdirSync(path.join(outside, 'a', 'b', 'c'), { recursive: true });
      fs.symlinkSync(outside, path.join(base, 'hop-deep-c'), 'dir');

      process.env.STHAYI_HOME = path.join(base, 'hop-deep-c', 'a', 'b', 'c', 'home');
      expect(() => ensureSthayiHome()).toThrow(/symlink/);
      expect(fs.readdirSync(path.join(outside, 'a', 'b', 'c'))).toEqual([]);
    });

    // INVARIANT (case D): the directory a missing home would be created INSIDE is not ours to
    // chmod, so it is checked instead: non-sticky group/world-writable means a peer can pre-plant
    // or swap whatever we create. Sticky (the /tmp shape) is the normal safe case.
    it('refuses to create a home inside a NON-STICKY world-writable directory', () => {
      const loose = path.join(base, 'loose-parent');
      fs.mkdirSync(loose);
      fs.chmodSync(loose, 0o777);
      process.env.STHAYI_HOME = path.join(loose, 'home');
      expect(() => ensureSthayiHome()).toThrow(/sticky/);
      expect(fs.existsSync(path.join(loose, 'home'))).toBe(false);
    });

    it('creates a home inside a STICKY world-writable directory (the /tmp shape)', () => {
      const sticky = path.join(base, 'sticky-parent');
      fs.mkdirSync(sticky);
      fs.chmodSync(sticky, 0o1777);
      const home = path.join(sticky, 'home');
      process.env.STHAYI_HOME = home;
      expect(ensureSthayiHome()).toBe(home);
      expect(fs.lstatSync(home).mode & 0o777).toBe(0o700);
    });

    // INVARIANT (ancestor trust): the creation-context rule above covers the ONE directory a
    // MISSING home would be created inside, which is not enough on its own. Accepting an EXISTING
    // 0700 home no matter what sits above it would establish a custom STHAYI_HOME under a
    // non-sticky 0777 parent as a trust boundary, and everything derived from it (db, vault key,
    // journal checkpoint, launcher, ledger) would be written beneath a directory any local peer can
    // rename away and replace. The home's own 0700 buys nothing when its parent decides whether it
    // is still the same directory a moment later.
    it('refuses an EXISTING 0700 home whose parent is NON-STICKY world-writable', () => {
      const loose = path.join(base, 'existing-loose-parent');
      const home = path.join(loose, 'home');
      fs.mkdirSync(home, { recursive: true, mode: 0o700 });
      fs.chmodSync(home, 0o700);
      fs.chmodSync(loose, 0o777);
      process.env.STHAYI_HOME = home;

      expect(() => ensureSthayiHome()).toThrow(/not a safe location for Sthayi state/);
      expect(() => assertReadOnlySthayiHome()).toThrow(/not a safe location for Sthayi state/);
      // refused BEFORE any chmod, and nothing was created inside
      expect(fs.lstatSync(home).mode & 0o777).toBe(0o700);
      expect(fs.readdirSync(home)).toEqual([]);
    });

    it('refuses an EXISTING 0700 home whose parent is NON-STICKY GROUP-writable', () => {
      const loose = path.join(base, 'existing-group-parent');
      const home = path.join(loose, 'home');
      fs.mkdirSync(home, { recursive: true, mode: 0o700 });
      fs.chmodSync(loose, 0o770);
      process.env.STHAYI_HOME = home;

      expect(() => ensureSthayiHome()).toThrow(/not a safe location for Sthayi state/);
      expect(() => assertReadOnlySthayiHome()).toThrow(/not a safe location for Sthayi state/);
      expect(fs.readdirSync(home)).toEqual([]);
    });

    // The rule is "no unsafe directory anywhere in the chain", not "the immediate parent is fine".
    it('refuses a home under a DEEPER unsafe ancestor, three levels up', () => {
      const loose = path.join(base, 'deep-loose');
      const home = path.join(loose, 'a', 'b', 'home');
      fs.mkdirSync(home, { recursive: true, mode: 0o700 });
      fs.chmodSync(home, 0o700);
      fs.chmodSync(path.join(loose, 'a', 'b'), 0o700);
      fs.chmodSync(path.join(loose, 'a'), 0o700);
      fs.chmodSync(loose, 0o777);
      process.env.STHAYI_HOME = home;

      expect(() => ensureSthayiHome()).toThrow(/not a safe location for Sthayi state/);
      expect(() => assertReadOnlySthayiHome()).toThrow(/not a safe location for Sthayi state/);
      expect(fs.readdirSync(home)).toEqual([]);
    });

    // And the same ancestor with the sticky bit set is the /tmp shape — it must keep working, for
    // an EXISTING home as well as a missing one.
    it('accepts an EXISTING home under a STICKY world-writable ancestor', () => {
      const sticky = path.join(base, 'existing-sticky-parent');
      const home = path.join(sticky, 'home');
      fs.mkdirSync(home, { recursive: true, mode: 0o700 });
      fs.chmodSync(sticky, 0o1777);
      process.env.STHAYI_HOME = home;
      expect(ensureSthayiHome()).toBe(home);
      expect(assertReadOnlySthayiHome()).toBe(home);
    });
  },
);

describe.skipIf(process.platform === 'win32')(
  'derived paths follow the ESTABLISHED canonical root, not the logical STHAYI_HOME string',
  () => {
    const original = process.env.STHAYI_HOME;
    let base: string;
    beforeEach(() => {
      base = runTempDir('sthayi-paths-root-');
    });
    afterEach(() => {
      if (original === undefined) {
        Reflect.deleteProperty(process.env, 'STHAYI_HOME');
      } else {
        process.env.STHAYI_HOME = original;
      }
      fs.rmSync(base, { recursive: true, force: true });
    });

    // INVARIANT (case C): validating the home and then rebuilding every derived path from the
    // ORIGINAL logical string throws the validation away. The home must be named by its CANONICAL
    // REAL PATH (a home reached through a link is refused outright), and once established,
    // dbPath() / keyPath() / logsDir() are pinned to that root — so retargeting a symlink that
    // happens to point at the same tree cannot move the store, the vault key, or the logs.
    it('a retargeted ancestor symlink cannot move the store, key, or logs after establishment', () => {
      const realRoot = path.join(base, 'A');
      fs.mkdirSync(path.join(realRoot, 'sub'), { recursive: true });
      fs.symlinkSync(realRoot, path.join(base, 'hop'), 'dir');

      // The canonical real path is what a user must supply — and what gets established.
      const canonical = path.join(realRoot, 'sub', 'home');
      process.env.STHAYI_HOME = canonical;
      expect(ensureSthayiHome()).toBe(canonical);
      expect(dbPath()).toBe(path.join(canonical, 'sthayi.db'));

      // The attacker swings the ancestor link at a tree they control, wide open.
      const b = path.join(base, 'B');
      fs.mkdirSync(path.join(b, 'sub', 'home'), { recursive: true });
      fs.chmodSync(path.join(b, 'sub', 'home'), 0o777);
      fs.unlinkSync(path.join(base, 'hop'));
      fs.symlinkSync(b, path.join(base, 'hop'), 'dir');

      // Every derived path still names the validated canonical root — not B.
      expect(dbPath()).toBe(path.join(canonical, 'sthayi.db'));
      expect(keyPath()).toBe(path.join(canonical, 'key'));
      expect(logsDir()).toBe(path.join(canonical, 'logs'));
      expect(dbPath().startsWith(b)).toBe(false);
      expect(fs.readdirSync(path.join(b, 'sub', 'home'))).toEqual([]);
      expect(fs.lstatSync(path.join(b, 'sub', 'home')).mode & 0o777).toBe(0o777); // untouched
    });

    // The other half of the same invariant: the LOGICAL spelling that goes through the link is not
    // an alternative name for the home — it is refused, at any depth, existing or missing. There
    // is no interchangeable-prefix state left for a retarget to exploit.
    it('the symlinked spelling of the SAME tree is refused, not accepted as an alias', () => {
      const realRoot = path.join(base, 'A2');
      fs.mkdirSync(path.join(realRoot, 'sub', 'home'), { recursive: true });
      fs.symlinkSync(realRoot, path.join(base, 'hop2'), 'dir');

      process.env.STHAYI_HOME = path.join(base, 'hop2', 'sub', 'home');
      expect(() => ensureSthayiHome()).toThrow(/symlink/);
      expect(() => assertReadOnlySthayiHome()).toThrow(/symlink/);

      process.env.STHAYI_HOME = path.join(base, 'hop2', 'sub', 'missing-home');
      expect(() => ensureSthayiHome()).toThrow(/symlink/);
      expect(fs.readdirSync(path.join(realRoot, 'sub'))).toEqual(['home']);
    });

    it('the cached root is keyed on STHAYI_HOME — changing it re-derives from the new home', () => {
      const first = path.join(base, 'first');
      process.env.STHAYI_HOME = first;
      ensureSthayiHome();
      expect(dbPath()).toBe(path.join(first, 'sthayi.db'));

      const second = path.join(base, 'second');
      process.env.STHAYI_HOME = second;
      expect(dbPath()).toBe(path.join(second, 'sthayi.db')); // no stale root leaks through
    });
  },
);

describe.skipIf(process.platform === 'win32')(
  'assertReadOnlySthayiHome — observational home validation (doctor / status / read-only store)',
  () => {
    const original = process.env.STHAYI_HOME;
    let base: string;
    beforeEach(() => {
      base = runTempDir('sthayi-paths-ro-');
    });
    afterEach(() => {
      if (original === undefined) {
        Reflect.deleteProperty(process.env, 'STHAYI_HOME');
      } else {
        process.env.STHAYI_HOME = original;
      }
      fs.rmSync(base, { recursive: true, force: true });
    });

    it('an absent home reads as undefined — and is NOT created', () => {
      const home = path.join(base, 'never-initialized');
      process.env.STHAYI_HOME = home;
      expect(assertReadOnlySthayiHome()).toBeUndefined();
      expect(fs.existsSync(home)).toBe(false);
    });

    it('a loose-but-safe 0755 home is accepted AS IS — never tightened (observation ≠ repair)', () => {
      const home = path.join(base, 'loose-home');
      fs.mkdirSync(home);
      fs.chmodSync(home, 0o755);
      process.env.STHAYI_HOME = home;
      expect(assertReadOnlySthayiHome()).toBe(home);
      expect(fs.lstatSync(home).mode & 0o777).toBe(0o755);
    });

    // INVARIANT (case F): the read-only path must refuse a symlinked home too — following it
    // would have doctor read a store (and a canary) out of an OUTSIDE database.
    it('refuses a symlinked home — nothing outside is read, nothing is modified', () => {
      const outside = path.join(base, 'outside');
      fs.mkdirSync(outside);
      fs.chmodSync(outside, 0o755);
      const planted = path.join(base, 'planted');
      fs.symlinkSync(outside, planted, 'dir');
      process.env.STHAYI_HOME = planted;
      expect(() => assertReadOnlySthayiHome()).toThrow(/symlink/);
      expect(fs.lstatSync(outside).mode & 0o777).toBe(0o755);
      expect(fs.readdirSync(outside)).toEqual([]);
    });

    it('refuses a home whose parent is a symlink', () => {
      const outside = path.join(base, 'outside-p');
      fs.mkdirSync(path.join(outside, 'home'), { recursive: true });
      fs.symlinkSync(outside, path.join(base, 'hop'), 'dir');
      process.env.STHAYI_HOME = path.join(base, 'hop', 'home');
      expect(() => assertReadOnlySthayiHome()).toThrow(/symlink/);
    });

    it('refuses a group- or world-writable home', () => {
      const gw = path.join(base, 'gw');
      fs.mkdirSync(gw);
      fs.chmodSync(gw, 0o770);
      process.env.STHAYI_HOME = gw;
      expect(() => assertReadOnlySthayiHome()).toThrow(/group-writable/);
      expect(fs.lstatSync(gw).mode & 0o777).toBe(0o770);

      const ww = path.join(base, 'ww');
      fs.mkdirSync(ww);
      fs.chmodSync(ww, 0o777);
      process.env.STHAYI_HOME = ww;
      expect(() => assertReadOnlySthayiHome()).toThrow(/world-writable/);
      expect(fs.lstatSync(ww).mode & 0o777).toBe(0o777);
    });

    it('a healthy home is returned canonical and pins the derived paths', () => {
      const home = path.join(base, 'healthy');
      fs.mkdirSync(home, { mode: 0o700 });
      process.env.STHAYI_HOME = home;
      expect(assertReadOnlySthayiHome()).toBe(home);
      expect(dbPath()).toBe(path.join(home, 'sthayi.db'));
      expect(fs.readdirSync(home)).toEqual([]); // observation created nothing
    });
  },
);
