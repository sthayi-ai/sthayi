import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ephemeralEntryRefusal, renderLauncher } from '../../packages/cli/src/clients/launcher.js';
import { type FakeHome, createFakeHome } from '../helpers/fake-home.js';
import { removeOwned } from '../helpers/owned-fs.js';
import { runTempDir } from '../helpers/run-temp.js';

/**
 * SAFETY-ADJACENT, AND A CLAIM ABOUT THE READER'S MACHINE.
 *
 * The ephemeral-install refusal reads npm's global prefix and then says whether this account could
 * write it. That sentence is a statement about somebody's machine, so it has to be true of the
 * whole install rather than of one directory inside it.
 *
 * A GLOBAL INSTALL NEEDS TWO DESTINATIONS, NOT ONE. npm unpacks the package under
 * `<prefix>/lib/node_modules` and puts its command shim in `<prefix>/bin`; a prefix that grants
 * only one of them fails partway through. A probe satisfied by the first writable destination it
 * finds therefore reports "your account can write it" about a prefix where the install cannot
 * finish — and a reader who acts on that sentence gets the failure the refusal exists to prevent.
 *
 * Every row below builds a prefix that is deliberately half-writable and asserts the message tells
 * the truth about it. Nothing here runs npm: the prefix is read, never used (the refusal path
 * spawns no package manager at all).
 */

const posix = process.platform !== 'win32';
const notRoot = typeof process.getuid !== 'function' || process.getuid() !== 0;

/** The refusal text an ephemeral entry earns, taken from the real refusal path. */
function refusalFor(entry: string): string {
  try {
    renderLauncher({ cliEntry: entry });
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error(`renderLauncher did not refuse ${entry}`);
}

describe.skipIf(!posix || !notRoot)(
  'safety: what the refusal says about npm’s prefix is true of the whole install',
  () => {
    let home: FakeHome;
    let scratch: string;
    let entry: string;
    const savedPrefix = process.env.npm_config_prefix;
    /** Directories locked down for a row; reopened before teardown so removal is possible. */
    const locked: string[] = [];

    beforeEach(() => {
      home = createFakeHome();
      scratch = runTempDir('sthayi-prefix-probe-');
      entry = path.join(scratch, 'cache', '_npx', 'node_modules', 'sthayi', 'dist', 'index.js');
      fs.mkdirSync(path.dirname(entry), { recursive: true });
      fs.writeFileSync(entry, '// an ephemeral entry\n');
    });

    afterEach(() => {
      for (const dir of locked.splice(0)) {
        fs.chmodSync(dir, 0o700);
      }
      if (savedPrefix === undefined) {
        // biome-ignore lint/performance/noDelete: assigning undefined coerces to the string "undefined"
        delete process.env.npm_config_prefix;
      } else {
        process.env.npm_config_prefix = savedPrefix;
      }
      // the ownership-aware teardown, never a recursive primitive handed a pathname
      removeOwned(scratch);
      home.cleanup();
    });

    let made = 0;
    /** A prefix directory built to order: which of npm's two destinations exist, and their modes. */
    function prefixWith(shape: {
      packages?: number;
      shims?: number;
      prefixMode?: number;
    }): string {
      made += 1;
      const prefix = path.join(scratch, `prefix-${made}`);
      fs.mkdirSync(prefix, { mode: 0o700 });
      if (shape.packages !== undefined) {
        fs.mkdirSync(path.join(prefix, 'lib'), { mode: 0o700 });
        fs.mkdirSync(path.join(prefix, 'lib', 'node_modules'), { mode: 0o700 });
        if (shape.packages !== 0o700) {
          fs.chmodSync(path.join(prefix, 'lib', 'node_modules'), shape.packages);
          locked.push(path.join(prefix, 'lib', 'node_modules'));
        }
      }
      if (shape.shims !== undefined) {
        fs.mkdirSync(path.join(prefix, 'bin'), { mode: 0o700 });
        if (shape.shims !== 0o700) {
          fs.chmodSync(path.join(prefix, 'bin'), shape.shims);
          locked.push(path.join(prefix, 'bin'));
        }
      }
      if (shape.prefixMode !== undefined && shape.prefixMode !== 0o700) {
        fs.chmodSync(prefix, shape.prefixMode);
        locked.push(prefix);
      }
      process.env.npm_config_prefix = prefix;
      return prefix;
    }

    /** Does the message claim this account can write the prefix it just named? */
    function claimsWritable(message: string): boolean {
      return /your account can write it/.test(message);
    }
    /** Does it say the opposite — that an unscoped global install would fail there? */
    function claimsUnwritable(message: string): boolean {
      return /cannot write/.test(message);
    }

    it('a prefix whose SHIM destination is closed is not called writable', () => {
      // The package would unpack and the shim would fail: npm needs `<prefix>/bin` too.
      const prefix = prefixWith({ packages: 0o700, shims: 0o500 });
      const message = refusalFor(entry);

      expect(message).toContain(prefix);
      expect(claimsWritable(message), message).toBe(false);
      expect(claimsUnwritable(message), message).toBe(true);
    });

    it('a prefix whose PACKAGE destination is closed is not called writable', () => {
      // The mirror image: a writable `bin` says nothing about `lib/node_modules`.
      const prefix = prefixWith({ packages: 0o500, shims: 0o700 });
      const message = refusalFor(entry);

      expect(message).toContain(prefix);
      expect(claimsWritable(message), message).toBe(false);
      expect(claimsUnwritable(message), message).toBe(true);
    });

    it('CONTROL — a prefix where BOTH destinations are open is still called writable', () => {
      // A probe strict enough to catch the half-writable cases is worthless if it calls every
      // prefix unwritable: that failure would make both rows above pass for the wrong reason.
      const prefix = prefixWith({ packages: 0o700, shims: 0o700 });
      const message = refusalFor(entry);

      expect(message).toContain(prefix);
      expect(claimsWritable(message), message).toBe(true);
    });

    it('CONTROL — an empty prefix this account owns is writable: npm creates both destinations', () => {
      // Neither destination exists yet, which is the ordinary shape of a fresh user-space prefix.
      // "Absent" is not "refused": npm makes them, so the honest answer is that it can.
      const prefix = prefixWith({});
      const message = refusalFor(entry);

      expect(message).toContain(prefix);
      expect(claimsWritable(message), message).toBe(true);
    });

    it('an empty prefix this account CANNOT write is not called writable', () => {
      // Both destinations are absent and cannot be created, which is the root-owned-prefix case the
      // scoped install exists to route around.
      const prefix = prefixWith({ prefixMode: 0o500 });
      const message = refusalFor(entry);

      expect(message).toContain(prefix);
      expect(claimsWritable(message), message).toBe(false);
      expect(claimsUnwritable(message), message).toBe(true);
    });

    // -------------------------------------------------------------------------------------------
    // WRITE ALONE IS NOT PERMISSION TO CREATE AN ENTRY.
    //
    // On POSIX, creating a file in a directory needs the WRITE bit AND the EXECUTE (search) bit:
    // write says the listing may be modified, search says a name inside it may be resolved at all.
    // Mode 0200 — write, no execute — is the shape that separates the two questions, and it answers
    // YES to `access(W_OK)` while every create under it fails EACCES. A probe that asks only about
    // write therefore prints "your account can write it" about a prefix where npm cannot place one
    // file. Both of npm's destinations get the row, because either one alone stalls the install.
    // -------------------------------------------------------------------------------------------

    it('a PACKAGE destination that is write-but-not-searchable (0200) is not called writable', () => {
      const prefix = prefixWith({ packages: 0o200, shims: 0o700 });
      const message = refusalFor(entry);

      expect(message).toContain(prefix);
      expect(claimsWritable(message), message).toBe(false);
      expect(claimsUnwritable(message), message).toBe(true);
    });

    it('a SHIM destination that is write-but-not-searchable (0200) is not called writable', () => {
      const prefix = prefixWith({ packages: 0o700, shims: 0o200 });
      const message = refusalFor(entry);

      expect(message).toContain(prefix);
      expect(claimsWritable(message), message).toBe(false);
      expect(claimsUnwritable(message), message).toBe(true);
    });

    it('CONTROL — write+execute without READ (0300) is still a destination npm can install into', () => {
      // The other side of the rule, and what stops it being over-tightened into `R_OK` as well:
      // creating an entry needs write and search, and it does NOT need permission to list the
      // directory. A probe that demanded read would call this prefix unwritable and print the
      // opposite false sentence — so the two rows above would pass for the wrong reason.
      const prefix = prefixWith({ packages: 0o300, shims: 0o300 });
      const message = refusalFor(entry);

      expect(message).toContain(prefix);
      expect(claimsWritable(message), message).toBe(true);
    });

    // -------------------------------------------------------------------------------------------
    // A DESTINATION OF THE WRONG KIND IS NOT A DESTINATION.
    //
    // "Can this account write it" and "can npm install there" are different questions, and only the
    // second one is what the sentence means. `access(W_OK)` answers the first: a REGULAR FILE at
    // `<prefix>/bin` that this account can write answers yes, while npm — which has to CREATE
    // ENTRIES INSIDE that name — cannot begin. The rows below stand something of the wrong kind at
    // each of npm's destinations and require the message to say the install cannot happen there.
    // -------------------------------------------------------------------------------------------

    /** A prefix whose contents this row plants itself: each wrong-kind shape is a one-off, and
     *  spelling it out reads better than another flag on the shape matrix. */
    function prefixBuilt(plant: (prefix: string) => void): string {
      made += 1;
      const prefix = path.join(scratch, `prefix-built-${made}`);
      fs.mkdirSync(prefix, { mode: 0o700 });
      plant(prefix);
      process.env.npm_config_prefix = prefix;
      return prefix;
    }

    /** npm's package destination, made properly, so a row can isolate the OTHER one. */
    function goodPackages(prefix: string): void {
      fs.mkdirSync(path.join(prefix, 'lib'), { mode: 0o700 });
      fs.mkdirSync(path.join(prefix, 'lib', 'node_modules'), { mode: 0o700 });
    }
    /** npm's shim destination, made properly, for the same reason. */
    function goodShims(prefix: string): void {
      fs.mkdirSync(path.join(prefix, 'bin'), { mode: 0o700 });
    }

    it('a writable regular FILE at `<prefix>/bin` is not a shim destination', () => {
      const prefix = prefixBuilt((p) => {
        goodPackages(p);
        fs.writeFileSync(path.join(p, 'bin'), 'not a directory\n', { mode: 0o600 });
      });
      const message = refusalFor(entry);

      expect(message).toContain(prefix);
      expect(claimsWritable(message), message).toBe(false);
      expect(claimsUnwritable(message), message).toBe(true);
    });

    it('a writable regular FILE at `<prefix>/lib/node_modules` is not a package destination', () => {
      const prefix = prefixBuilt((p) => {
        goodShims(p);
        fs.mkdirSync(path.join(p, 'lib'), { mode: 0o700 });
        fs.writeFileSync(path.join(p, 'lib', 'node_modules'), 'not a directory\n', { mode: 0o600 });
      });
      const message = refusalFor(entry);

      expect(message).toContain(prefix);
      expect(claimsWritable(message), message).toBe(false);
      expect(claimsUnwritable(message), message).toBe(true);
    });

    it('a regular FILE at `<prefix>/lib` is not a directory npm can unpack beneath', () => {
      // The wrong kind at an INTERMEDIATE component rather than at the destination itself.
      const prefix = prefixBuilt((p) => {
        goodShims(p);
        fs.writeFileSync(path.join(p, 'lib'), 'not a directory\n', { mode: 0o600 });
      });
      const message = refusalFor(entry);

      expect(message).toContain(prefix);
      expect(claimsWritable(message), message).toBe(false);
      expect(claimsUnwritable(message), message).toBe(true);
    });

    it('a SYMLINK at `<prefix>/bin` pointing at a file is not a shim destination', () => {
      const prefix = prefixBuilt((p) => {
        goodPackages(p);
        const target = path.join(scratch, `bin-target-${made}`);
        fs.writeFileSync(target, 'a file, reached through a link\n', { mode: 0o600 });
        fs.symlinkSync(target, path.join(p, 'bin'));
      });
      const message = refusalFor(entry);

      expect(message).toContain(prefix);
      expect(claimsWritable(message), message).toBe(false);
      expect(claimsUnwritable(message), message).toBe(true);
    });

    it('a DANGLING symlink at `<prefix>/bin` is not a shim destination', () => {
      // The name is occupied, so npm's own `mkdir` fails there — and "absent, so npm creates it"
      // is the answer a probe reaches by asking a question that follows links.
      const prefix = prefixBuilt((p) => {
        goodPackages(p);
        fs.symlinkSync(path.join(scratch, `never-created-${made}`), path.join(p, 'bin'));
      });
      const message = refusalFor(entry);

      expect(message).toContain(prefix);
      expect(claimsWritable(message), message).toBe(false);
      expect(claimsUnwritable(message), message).toBe(true);
    });

    it('a regular FILE standing at the prefix itself is not a prefix', () => {
      made += 1;
      const prefix = path.join(scratch, `prefix-file-${made}`);
      fs.writeFileSync(prefix, 'not a directory\n', { mode: 0o600 });
      process.env.npm_config_prefix = prefix;
      const message = refusalFor(entry);

      expect(message).toContain(prefix);
      expect(claimsWritable(message), message).toBe(false);
      expect(claimsUnwritable(message), message).toBe(true);
    });

    // -------------------------------------------------------------------------------------------
    // THE WINDOWS LAYOUT IS TWO DESTINATIONS TOO, SPELLED DIFFERENTLY.
    //
    // With `--prefix <dir>` on Windows npm puts the shims directly in `<dir>\` and the package under
    // `<dir>\node_modules` — no `lib/node_modules`, no `bin/`. Asking only about the prefix answers
    // for the shims and says nothing about the package: an entry ALREADY STANDING at
    // `<prefix>\node_modules` that is not a directory occupies the name npm has to unpack into, so
    // the install cannot finish while the prefix reads perfectly writable.
    //
    // NO WINDOWS HOST RUNS THESE. The platform is a PARAMETER, so a POSIX run can evaluate the
    // Windows branch — and what these rows assert is what that branch DECIDES, never that a real
    // Windows install was observed. Real hosted-Windows validation is not available here, and the
    // layout stays designed and unvalidated until hosted CI executes it. (`path.join` therefore
    // builds the fixture with this platform's separator, which is also the separator the branch
    // under test joins with, so the two agree by construction.)
    // -------------------------------------------------------------------------------------------

    /** The Windows refusal text for an npx-cache entry, read on POSIX via the platform parameter. */
    function winRefusalFor(): string {
      return ephemeralEntryRefusal(
        'C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\deadbeef\\node_modules\\sthayi\\dist\\cli.js',
        'win32',
      );
    }

    it('a regular FILE at `<prefix>\\node_modules` is not a package destination (win32 branch)', () => {
      const prefix = prefixBuilt((p) => {
        fs.writeFileSync(path.join(p, 'node_modules'), 'not a directory\n', { mode: 0o600 });
      });
      const message = winRefusalFor();

      expect(message).toContain(prefix);
      expect(claimsWritable(message), message).toBe(false);
      expect(claimsUnwritable(message), message).toBe(true);
    });

    it('a DANGLING symlink at `<prefix>\\node_modules` is not a package destination (win32 branch)', () => {
      // The name is occupied, so npm's own create fails there — and "absent, so npm makes it" is
      // the answer a probe reaches by asking a question that follows links.
      const prefix = prefixBuilt((p) => {
        fs.symlinkSync(
          path.join(scratch, `never-created-win-${made}`),
          path.join(p, 'node_modules'),
        );
      });
      const message = winRefusalFor();

      expect(message).toContain(prefix);
      expect(claimsWritable(message), message).toBe(false);
      expect(claimsUnwritable(message), message).toBe(true);
    });

    it('a symlink to a FILE at `<prefix>\\node_modules` is not a package destination (win32 branch)', () => {
      const prefix = prefixBuilt((p) => {
        const target = path.join(scratch, `win-nm-target-${made}`);
        fs.writeFileSync(target, 'a file, reached through a link\n', { mode: 0o600 });
        fs.symlinkSync(target, path.join(p, 'node_modules'));
      });
      const message = winRefusalFor();

      expect(message).toContain(prefix);
      expect(claimsWritable(message), message).toBe(false);
      expect(claimsUnwritable(message), message).toBe(true);
    });

    it('CONTROL — a win32 prefix with no `node_modules` yet is writable: npm creates it', () => {
      // Absent is not refused, or every fresh user-space prefix on Windows would be called
      // unwritable and the three rows above would pass for the wrong reason.
      const prefix = prefixBuilt(() => undefined);
      const message = winRefusalFor();

      expect(message).toContain(prefix);
      expect(claimsWritable(message), message).toBe(true);
    });

    it('CONTROL — a win32 prefix with a real `node_modules` DIRECTORY is writable', () => {
      const prefix = prefixBuilt((p) => {
        fs.mkdirSync(path.join(p, 'node_modules'), { mode: 0o700 });
      });
      const message = winRefusalFor();

      expect(message).toContain(prefix);
      expect(claimsWritable(message), message).toBe(true);
    });

    it('CONTROL — the POSIX branch ignores `<prefix>/node_modules`, which is not its layout', () => {
      // The two layouts must not bleed into each other: a wrong-kind entry at the WINDOWS package
      // destination says nothing about a POSIX install, which unpacks under `lib/node_modules`.
      const prefix = prefixBuilt((p) => {
        goodPackages(p);
        goodShims(p);
        fs.writeFileSync(path.join(p, 'node_modules'), 'not a directory\n', { mode: 0o600 });
      });
      const message = refusalFor(entry);

      expect(message).toContain(prefix);
      expect(claimsWritable(message), message).toBe(true);
    });

    it('CONTROL — a symlink to a writable DIRECTORY is a destination, and is called one', () => {
      // The rows above are about KIND, not about links. npm installs happily through a symlinked
      // destination, so refusing one here would print the opposite false sentence — "your account
      // cannot write it" about a prefix where the install completes. Nothing is written through
      // these names; the probe only asks what npm would find, so the link is resolved for its kind.
      const prefix = prefixBuilt((p) => {
        goodPackages(p);
        const target = path.join(scratch, `bin-dir-${made}`);
        fs.mkdirSync(target, { mode: 0o700 });
        fs.symlinkSync(target, path.join(p, 'bin'));
      });
      const message = refusalFor(entry);

      expect(message).toContain(prefix);
      expect(claimsWritable(message), message).toBe(true);
    });
  },
);
