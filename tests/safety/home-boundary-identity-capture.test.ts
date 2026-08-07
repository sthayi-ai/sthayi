import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeLauncher } from '../../packages/cli/src/clients/launcher.js';
import { safeWriteFileAtomic } from '../../packages/cli/src/fs-safe.js';
import { assertReadOnlySthayiHome, ensureSthayiHome } from '../../packages/cli/src/paths.js';
import { type FakeHome, createFakeHome } from '../helpers/fake-home.js';

/**
 * SAFETY: the TRUST ANCHOR is the directory that was validated — never the directory that answers
 * to its name a moment later.
 *
 * WHAT ESTABLISHMENT IS FOR. Every other defence in this codebase is stated relative to "the
 * established home": the launcher binds its writes to it, `trustedBoundaryFor` re-checks it before
 * every read and write beneath it, and re-entering `establishTrustedDir` compares against it rather
 * than refreshing it. All of that is an argument about ONE recorded device/inode. So the moment
 * that recorded identity is read from a PATHNAME rather than from the object that passed
 * validation, every one of those defences is still working perfectly — about the wrong directory.
 *
 * THE WINDOW. A validation and a registration are two separate looks at a name. Between them the
 * name can be made to answer to a different directory, and the replacement then satisfies every
 * path-shaped test on its own merits: it is a real directory, not a link, owned by this uid, 0700,
 * and `<home>/bin` beneath it canonicalises to exactly the string a containment check expects.
 * Device and inode are the ONLY things that separate it from the home that was established, which
 * is why the substitutions below are REAL DIRECTORIES rather than symlinks — a substitution refused
 * for being a link proves nothing about identity.
 *
 * "THE FAILURE DIRECTION IS SAFE" IS NOT AVAILABLE HERE. The invariant is exact identity: the
 * identity registered must be the identity that was validated. A substitute that happens to pass
 * the same ownership and mode policy is still a substitute, and adopting it is worse than adopting
 * nothing — it is a permanent, confident mis-binding for the rest of the process.
 *
 * Each row drives the substitution at the seam BETWEEN the validating stat and the registration,
 * and requires: a REFUSAL, ZERO writes into the replacement, and the established directory left
 * exactly as it was.
 */

const posix = process.platform !== 'win32';

/** Every entry beneath `dir`, recursively — an empty array is "nothing was written here". */
function listDeep(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string): void => {
    for (const name of fs.readdirSync(d).sort()) {
      const full = path.join(d, name);
      const r = rel === '' ? name : `${rel}/${name}`;
      out.push(r);
      const st = fs.lstatSync(full);
      if (st.isDirectory() && !st.isSymbolicLink()) {
        walk(full, r);
      }
    }
  };
  walk(dir, '');
  return out;
}

describe.skipIf(!posix)(
  'safety: a trust boundary is registered under the identity it validated',
  () => {
    let home: FakeHome;
    /** Entries this test stood at the home's pathname, newest last, for teardown to undo. */
    let substituted: 'dir' | 'link' | 'file' | undefined;

    /** Where the ESTABLISHED home is parked so assertions can still name it. */
    function asidePath(): string {
      return `${home.home}-established`;
    }

    /** A directory the substituted symlink points at, so `listDeep(home.home)` never walks into the
     *  established tree through the link and mistakes it for a write into the replacement. */
    function decoyPath(): string {
      return `${home.home}-decoy`;
    }

    /**
     * Move the established home aside and stand ANOTHER REAL DIRECTORY at its pathname — 0700, owned
     * by this uid, a genuine directory. This is the substitution the whole file is about.
     */
    function substituteRealDir(): void {
      fs.renameSync(home.home, asidePath());
      fs.mkdirSync(home.home, { mode: 0o700 });
      substituted = 'dir';
    }

    /** Move it aside and stand a SYMLINK at its pathname. */
    function substituteSymlink(): void {
      fs.renameSync(home.home, asidePath());
      fs.mkdirSync(decoyPath(), { mode: 0o700 });
      fs.symlinkSync(decoyPath(), home.home);
      substituted = 'link';
    }

    /** Move it aside and stand a NON-DIRECTORY at its pathname. */
    function substituteNonDir(): void {
      fs.renameSync(home.home, asidePath());
      fs.writeFileSync(home.home, 'not a directory\n', { mode: 0o600 });
      substituted = 'file';
    }

    /**
     * Put the established home back before teardown: the harness pinned that inode, and a replacement
     * standing at the name would be refused entry and leaked instead of cleaned.
     *
     * ONE `rmdir`/`unlink`, never a recursive removal. Every row asserts the replacement is EMPTY, so
     * a non-recursive removal is all that is ever needed — and where that assertion has already
     * failed, the replacement is LEFT STANDING rather than deleted, which is what preserves the
     * evidence of whatever the code wrote into it.
     */
    function restoreHome(): void {
      if (substituted === undefined) {
        return;
      }
      try {
        if (substituted === 'dir') {
          fs.rmdirSync(home.home);
        } else {
          fs.unlinkSync(home.home);
        }
      } catch {
        return; // something is in it: leave both entries exactly as the test found them
      }
      if (substituted === 'link') {
        try {
          fs.rmdirSync(decoyPath());
        } catch {
          return;
        }
      }
      fs.renameSync(asidePath(), home.home);
      substituted = undefined;
    }

    /**
     * Drive a substitution in the window between the stat that VALIDATES the boundary and the moment
     * its identity is recorded.
     *
     * `realpathSync(<home>)` is that seam exactly: `establishTrustedDir` and `assertTrustedDirReadOnly`
     * both lstat the home, decide from that stat that it is trustworthy, and only then canonicalise
     * it on the way to registering it. Substituting after the real call returns puts the replacement
     * in precisely the interval a peer process wins by chance — deterministically, and at the same
     * point whether the identity is captured from the validating stat or looked up again afterwards.
     */
    function substituteAtRegistrationSeam(swap: () => void): () => boolean {
      const realRealpath = fs.realpathSync.bind(fs) as (...a: unknown[]) => string;
      let fired = false;
      vi.spyOn(fs, 'realpathSync').mockImplementation(((...args: unknown[]) => {
        const result = realRealpath(...args);
        if (!fired && String(args[0]) === home.home) {
          fired = true;
          swap();
        }
        return result;
      }) as unknown as typeof fs.realpathSync);
      return () => fired;
    }

    /** Run `body`, returning the refusal message ('' when it did not throw). */
    function refusalFrom(body: () => unknown): string {
      try {
        body();
        return '';
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    }

    beforeEach(() => {
      home = createFakeHome();
      substituted = undefined;
    });

    afterEach(() => {
      vi.restoreAllMocks();
      restoreHome();
      home.cleanup();
    });

    // -------------------------------------------------------------------------------------------
    // establishTrustedDir — the WRITING entry point, reached through the launcher.
    // -------------------------------------------------------------------------------------------

    it('home replaced by another REAL directory in the validate→register window: writeLauncher refuses and writes nothing', () => {
      // THE CASE THIS FILE EXISTS FOR. Binding the launcher's writes to the established home's
      // identity is correct and necessary — and completely defeated if the ESTABLISHMENT itself
      // adopted the substitute, because then the identity everything binds to IS the attacker's.
      const fired = substituteAtRegistrationSeam(substituteRealDir);

      const message = refusalFrom(writeLauncher);
      vi.restoreAllMocks();

      expect(fired()).toBe(true); // the race really was run
      expect(message).toMatch(/no longer the directory that was validated/);
      // Both launchers are executables every wired MCP client runs. Not one byte of either may land
      // in a directory that merely wears the home's name.
      expect(listDeep(home.home)).toEqual([]);
      // And the home that WAS established is untouched: the refusal came before anything was created.
      expect(listDeep(asidePath())).toEqual([]);
    });

    it('home replaced by a SYMLINK in that window: writeLauncher refuses and writes nothing', () => {
      const fired = substituteAtRegistrationSeam(substituteSymlink);

      const message = refusalFrom(writeLauncher);
      vi.restoreAllMocks();

      expect(fired()).toBe(true);
      expect(message).toMatch(/symlink \(possible hijack\)/);
      expect(listDeep(decoyPath())).toEqual([]);
      expect(listDeep(asidePath())).toEqual([]);
    });

    it('home replaced by a NON-DIRECTORY in that window: writeLauncher refuses and writes nothing', () => {
      const fired = substituteAtRegistrationSeam(substituteNonDir);

      const message = refusalFrom(writeLauncher);
      vi.restoreAllMocks();

      expect(fired()).toBe(true);
      expect(message).toMatch(/is not a directory/);
      // The file standing at the home's name still holds exactly what was planted in it.
      expect(fs.readFileSync(home.home, 'utf8')).toBe('not a directory\n');
      expect(listDeep(asidePath())).toEqual([]);
    });

    it('home replaced by another REAL directory in that window: ensureSthayiHome itself refuses', () => {
      // Straight at the establishment, with no launcher in the way: no caller may be handed a
      // canonical root whose registered identity belongs to a directory it never validated.
      const fired = substituteAtRegistrationSeam(substituteRealDir);

      const message = refusalFrom(ensureSthayiHome);
      vi.restoreAllMocks();

      expect(fired()).toBe(true);
      expect(message).toMatch(/no longer the directory that was validated/);
      expect(listDeep(home.home)).toEqual([]);
    });

    // -------------------------------------------------------------------------------------------
    // assertTrustedDirReadOnly — the OBSERVATIONAL entry point registers a boundary too.
    // -------------------------------------------------------------------------------------------

    it('home replaced in that window: the OBSERVATIONAL validation refuses rather than register the substitute', () => {
      // doctor/status create nothing, which is exactly why this is easy to wave through — but they
      // REGISTER the boundary, and a boundary registered here is the anchor every later read and
      // write in the process is measured against. Reporting on a swapped-in home is also the same
      // disclosure a write into it would be.
      const fired = substituteAtRegistrationSeam(substituteRealDir);

      const message = refusalFrom(assertReadOnlySthayiHome);
      vi.restoreAllMocks();

      expect(fired()).toBe(true);
      expect(message).toMatch(/no longer the directory that was validated/);
      expect(listDeep(home.home)).toEqual([]);
    });

    it('home replaced by a SYMLINK in that window: the OBSERVATIONAL validation refuses', () => {
      const fired = substituteAtRegistrationSeam(substituteSymlink);

      const message = refusalFrom(assertReadOnlySthayiHome);
      vi.restoreAllMocks();

      expect(fired()).toBe(true);
      expect(message).toMatch(/symlink \(possible hijack\)/);
      expect(listDeep(decoyPath())).toEqual([]);
    });

    it('home replaced by a NON-DIRECTORY in that window: the OBSERVATIONAL validation refuses', () => {
      const fired = substituteAtRegistrationSeam(substituteNonDir);

      const message = refusalFrom(assertReadOnlySthayiHome);
      vi.restoreAllMocks();

      expect(fired()).toBe(true);
      expect(message).toMatch(/is not a directory/);
      expect(fs.readFileSync(home.home, 'utf8')).toBe('not a directory\n');
    });

    // -------------------------------------------------------------------------------------------
    // CONTROLS — the ordinary path still works, and the refusals that already existed still fire.
    // -------------------------------------------------------------------------------------------

    it('CONTROL — an untouched home establishes, tightens loose bits, and takes both launchers', () => {
      // A capture strict enough to refuse a substitution is worthless if it also refuses the ordinary
      // home: that failure would make every hostile row above pass for the wrong reason.
      fs.chmodSync(home.home, 0o755); // loose but safe — establishment tightens it in place
      const canonical = ensureSthayiHome();
      expect(canonical).toBe(home.home);
      expect(fs.lstatSync(home.home).mode & 0o777).toBe(0o700);
      expect(assertReadOnlySthayiHome()).toBe(home.home);

      const target = writeLauncher();
      expect(target).toBe(path.join(home.home, 'bin', 'sthayi-mcp'));
      expect(listDeep(home.home)).toEqual(['bin', 'bin/sthayi', 'bin/sthayi-mcp']);
    });

    it('CONTROL — a home replaced AFTER establishment is still refused by every later caller', () => {
      ensureSthayiHome();
      substituteRealDir();

      expect(refusalFrom(ensureSthayiHome)).toMatch(/no longer the directory that was validated/);
      expect(refusalFrom(assertReadOnlySthayiHome)).toMatch(
        /no longer the directory that was validated/,
      );
      expect(refusalFrom(writeLauncher)).toMatch(/no longer the directory that was validated/);
      expect(listDeep(home.home)).toEqual([]);
    });

    it('CONTROL — a group-writable home is still refused outright, never "repaired"', () => {
      fs.chmodSync(home.home, 0o770);
      expect(refusalFrom(ensureSthayiHome)).toMatch(/group-writable/);
      expect(refusalFrom(assertReadOnlySthayiHome)).toMatch(/group-writable/);
      // Refused, not chmodded: a tightening cannot un-plant what a peer may already have written.
      expect(fs.lstatSync(home.home).mode & 0o777).toBe(0o770);
      fs.chmodSync(home.home, 0o700);
    });

    it('CONTROL — a symlinked home is still refused before anything is created', () => {
      substituteSymlink();
      expect(refusalFrom(ensureSthayiHome)).toMatch(/symlink \(possible hijack\)/);
      expect(refusalFrom(assertReadOnlySthayiHome)).toMatch(/symlink \(possible hijack\)/);
      expect(listDeep(decoyPath())).toEqual([]);
    });

    // -----------------------------------------------------------------------------------------
    // A home that DENIES US READ ACCESS — inspectable, not openable. The descriptor is
    // unavailable, so the identity comes from the validating stat alone; the invariant that the
    // registered identity IS the validated one must hold there too.
    // -----------------------------------------------------------------------------------------

    it('a home that cannot be opened is still refused when it is substituted in that window', () => {
      // Losing the descriptor must not lose the identity check with it. Both the established home
      // and the replacement are unopenable here, so nothing about this row can be answered by the
      // descriptor: only the comparison against the stat that validated the home can catch it.
      fs.chmodSync(home.home, 0o000);
      const fired = substituteAtRegistrationSeam(() => {
        fs.chmodSync(home.home, 0o700); // rename needs no access to the directory itself; be exact
        fs.renameSync(home.home, asidePath());
        fs.mkdirSync(home.home, { mode: 0o000 });
        substituted = 'dir';
        fs.chmodSync(asidePath(), 0o700);
      });

      const message = refusalFrom(assertReadOnlySthayiHome);
      vi.restoreAllMocks();

      expect(fired()).toBe(true);
      expect(message).toMatch(/no longer the directory that was validated/);
      fs.chmodSync(home.home, 0o700); // so teardown can take the empty replacement away
      expect(listDeep(home.home)).toEqual([]);
      expect(listDeep(asidePath())).toEqual([]);
    });

    it('CONTROL — an untouched home that cannot be opened remains diagnosable but is not established for writes', () => {
      // `sthayi doctor` exists to REPORT this state. A refusal here would replace an accurate
      // "cannot tell whether the store exists" diagnosis with a bare failure to look at all.
      fs.chmodSync(home.home, 0o000);
      expect(assertReadOnlySthayiHome()).toBe(home.home);
      // A write path must refuse the observational call's non-authorizing, process-scoped poison
      // state rather than register a recyclable dev/inode or bless a now-readable replacement.
      expect(refusalFrom(ensureSthayiHome)).toMatch(
        /could not be pinned during an earlier read-only validation/,
      );
      // Both paths preserve the owner's locked state; neither repairs it behind their back.
      expect(fs.lstatSync(home.home).mode & 0o777).toBe(0o000);
      fs.chmodSync(home.home, 0o700);
    });
  },
);

/**
 * SAFETY: the CREATION path records the level it made, not the level standing at that name.
 *
 * A missing home is built one level at a time and each level is checked after creation. The check
 * and the identity that goes into the trust boundary have to be the same look at the directory: a
 * second lookup after the check registers whatever occupies the name by then, and `mkdir` returns
 * no handle, so nothing about the name says the two are the same object.
 *
 * RESIDUAL, STATED IN FULL. The interval between the `mkdir` SYSCALL and the first look at what it
 * made cannot be closed with portable Node — there is no `mkdirat`, and no handle comes back from
 * the create. A peer that substitutes inside THAT interval is not detected here; what excludes it
 * is that the created level must be owned by this uid, which a peer cannot arrange, and that the
 * directory it is created inside must already be non-shared-writable or sticky. The window this row
 * closes is the one AFTER the check: from the validating stat to the registration.
 */
describe.skipIf(!posix)(
  'safety: a boundary created from scratch is registered under what was created',
  () => {
    let home: FakeHome;
    let substituted = false;
    let newHome = '';

    function asidePath(): string {
      return `${newHome}-established`;
    }

    function restore(): void {
      if (!substituted) {
        return;
      }
      try {
        fs.rmdirSync(newHome);
      } catch {
        return; // something is inside the replacement: leave it standing as evidence
      }
      fs.renameSync(asidePath(), newHome);
      substituted = false;
    }

    beforeEach(() => {
      home = createFakeHome();
      newHome = home.path('fresh-home');
      process.env.STHAYI_HOME = newHome;
      substituted = false;
    });

    afterEach(() => {
      vi.restoreAllMocks();
      restore();
      try {
        fs.rmdirSync(newHome);
      } catch {
        // it either never existed or still holds something a row deliberately left there
      }
      home.cleanup();
    });

    it('a level swapped between its post-creation check and the registration is refused', () => {
      // The seam is the check ESTABLISHMENT itself makes on the newly created level — the stat that
      // decides the level is sound. Substituting immediately after it returns is exactly the interval
      // a second lookup would read the identity from, and the interval is only reachable by asking
      // WHO is looking: the test harness records its own creations by identity too, so it takes a
      // look at the same pathname first, and firing there would land in the `mkdir`-to-first-look
      // window instead — a different, openly un-closable window (no `mkdirat` in portable Node)
      // rather than the validate-to-register one this row exists to test.
      const realLstat = fs.lstatSync.bind(fs) as (...a: unknown[]) => fs.Stats;
      let fired = false;
      vi.spyOn(fs, 'lstatSync').mockImplementation(((...args: unknown[]) => {
        const st = realLstat(...args);
        // The establishment's OWN look, not one the harness's creation recorder takes on its behalf:
        // the recorder runs inside `mkdirSync`, so its stack reaches fs-safe.ts too, and firing there
        // would land in the other window instead.
        const stack = new Error().stack ?? '';
        const fromEstablishment = stack.includes('fs-safe.ts') && !stack.includes('owned-fs.ts');
        if (!fired && fromEstablishment && String(args[0]) === newHome && st.isDirectory()) {
          fired = true;
          fs.renameSync(newHome, asidePath());
          fs.mkdirSync(newHome, { mode: 0o700 });
          substituted = true;
        }
        return st;
      }) as unknown as typeof fs.lstatSync);

      let message = '';
      try {
        writeLauncher();
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      vi.restoreAllMocks();

      expect(fired).toBe(true);
      expect(message).toMatch(/no longer the directory that was validated/);
      expect(listDeep(newHome)).toEqual([]);
      expect(listDeep(asidePath())).toEqual([]);
    });

    it('CONTROL — an ordinary missing home is created, established and written into', () => {
      expect(ensureSthayiHome()).toBe(newHome);
      expect(fs.lstatSync(newHome).mode & 0o777).toBe(0o700);
      writeLauncher();
      expect(listDeep(newHome)).toEqual(['bin', 'bin/sthayi', 'bin/sthayi-mcp']);
      // Leave the fixture the way the teardown can take it down.
      fs.unlinkSync(path.join(newHome, 'bin', 'sthayi'));
      fs.unlinkSync(path.join(newHome, 'bin', 'sthayi-mcp'));
      fs.rmdirSync(path.join(newHome, 'bin'));
    });
  },
);

/**
 * SAFETY: the permission bits a write reuses come from the file that was VALIDATED.
 *
 * `safeWriteFileAtomic` lets an existing file keep its own mode. That mode has to be read from the
 * same look that proved the file trustworthy: read it again from the pathname and a file
 * substituted in between donates ITS bits to the file we then write. The trust gate refuses a
 * group- or world-writable target, so those bits could never have passed the check — but they can
 * still be worn by the file that replaces it, and the result is a state file (the wiring ledger,
 * the HTTP token, an export) created group- or world-writable while the write reports success.
 */
describe.skipIf(!posix)('safety: a reused file mode comes from the validated file', () => {
  let home: FakeHome;

  beforeEach(() => {
    home = createFakeHome();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    home.cleanup();
  });

  /** Count the lstats of `target`, and after the first one replace it with a 0666 file. */
  function substituteAfterFirstLook(target: string): () => number {
    const realLstat = fs.lstatSync.bind(fs) as (...a: unknown[]) => fs.Stats;
    let looks = 0;
    vi.spyOn(fs, 'lstatSync').mockImplementation(((...args: unknown[]) => {
      const st = realLstat(...args);
      if (String(args[0]) === target) {
        looks += 1;
        if (looks === 1) {
          fs.unlinkSync(target);
          fs.writeFileSync(target, 'PLANTED\n', { mode: 0o666 });
          fs.chmodSync(target, 0o666); // writeFileSync's mode is umask-filtered; pin it exactly
        }
      }
      return st;
    }) as unknown as typeof fs.lstatSync);
    return () => looks;
  }

  it('a target swapped after the trust check never donates its permission bits to the write', () => {
    const target = home.path('ledger.json');
    fs.writeFileSync(target, 'ours\n', { mode: 0o600 });

    const looks = substituteAfterFirstLook(target);
    safeWriteFileAtomic(target, 'rewritten\n');
    vi.restoreAllMocks();

    expect(looks()).toBe(1); // ONE look: the mode came from the stat that validated the file
    expect(fs.readFileSync(target, 'utf8')).toBe('rewritten\n');
    expect(fs.lstatSync(target).mode & 0o777).toBe(0o600);
  });

  it('CONTROL — an existing file keeps its own validated bits and a new file is owner-only', () => {
    const existing = home.path('export.json');
    fs.writeFileSync(existing, 'old\n', { mode: 0o600 });
    fs.chmodSync(existing, 0o644);
    safeWriteFileAtomic(existing, 'new\n');
    expect(fs.lstatSync(existing).mode & 0o777).toBe(0o644);
    expect(fs.readFileSync(existing, 'utf8')).toBe('new\n');

    const fresh = home.path('fresh.json');
    safeWriteFileAtomic(fresh, 'first\n');
    expect(fs.lstatSync(fresh).mode & 0o777).toBe(0o600);

    const shared = home.path('shared.json');
    safeWriteFileAtomic(shared, 'first\n', { mode: 0o644 });
    expect(fs.lstatSync(shared).mode & 0o777).toBe(0o644);
  });

  it('CONTROL — a world-writable target is still refused rather than rewritten', () => {
    const target = home.path('loose.json');
    fs.writeFileSync(target, 'loose\n', { mode: 0o600 });
    fs.chmodSync(target, 0o666);
    expect(() => safeWriteFileAtomic(target, 'nope\n')).toThrow(/group- or world-writable/);
    expect(fs.readFileSync(target, 'utf8')).toBe('loose\n');
  });
});
