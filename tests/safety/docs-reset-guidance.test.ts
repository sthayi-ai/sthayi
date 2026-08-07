import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDoctor } from '../../packages/cli/src/doctor.js';
import { COMMANDS } from '../../packages/cli/src/index.js';
import { sthayiHome } from '../../packages/cli/src/paths.js';
import { removeOwned } from '../helpers/owned-fs.js';
import { runTempDir } from '../helpers/run-temp.js';

/**
 * SAFETY: uninstall and reset guidance has to be safe in ORDER and in what it AUTHORISES.
 *
 * Two independent failure modes, both executed here against isolated fixtures:
 *
 *   1. ORDER. `sthayi doctor` is the only thing that names the state directory, and it runs from
 *      the install being removed. A global install is referenced IN PLACE — nothing is copied into
 *      `~/.sthayi/runtime/` — so `npm rm -g sthayi` takes the durable launcher with it. Guidance
 *      that removes the package before reading the path leaves the owner with no way to ask.
 *
 *   2. AUTHORISATION. A path doctor printed is a LOCATION, not a verified removal target. The
 *      `Home directory` line can be missing entirely, can be a FAILED check whose text is a
 *      diagnostic rather than a path, and — when it passes — can perfectly legitimately name the
 *      owner's whole home directory, a filesystem root, or a directory full of unrelated files.
 *      "Delete what doctor printed" authorises every one of those.
 *
 * NO SIMULATED SAFE-REMOVAL DECISION LIVES HERE. A test-only classifier that sorts candidate
 * directories into "safe" and "refused" is not a safety control: it ships to nobody, it cannot be
 * reached by an owner, and the cases it silently gets WRONG (a final symlink with a trailing slash,
 * an alias of the OS home, unrelated files hidden under Sthayi-shaped names, EACCES/EIO, a mount
 * sharing its parent's device, extended UNC roots, and the lstat/realpath/readdir races between
 * every step) all fail OPEN — they read as "safe to remove". Presenting one as evidence that safe
 * whole-tree removal exists claims a control that is not there. Sthayi ships no reset command, so
 * what these tests enforce is the ABSENCE of destructive guidance: section 3 proves no such command
 * exists in the product, and section 4 proves neither published file authorises the operation by
 * imperative, by gerund, or by description.
 *
 * WINDOWS: nothing here executes PowerShell, `npm` on Windows, or drive/UNC paths against a real
 * filesystem.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readme = (): string => fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
const security = (): string => fs.readFileSync(path.join(repoRoot, 'SECURITY.md'), 'utf8');

function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  expect(start).toBeGreaterThan(-1);
  const end = text.indexOf('\n## ', start + 1);
  return text.slice(start, end === -1 ? undefined : end);
}

// ---------------------------------------------------------------------------------------------
// 1. ORDER: reading the path has to happen while a CLI still exists.
// ---------------------------------------------------------------------------------------------

/**
 * A fixture that models a GLOBAL install the way the README describes it: a `sthayi` on PATH under
 * an npm global prefix, plus the durable `~/.sthayi/bin/sthayi` launcher — which, for a global
 * install, references the global copy in place rather than owning its own runtime.
 */
function globalInstallFixture(prefix: string): {
  root: string;
  home: string;
  globalBin: string;
  env: Record<string, string>;
} {
  const root = runTempDir(prefix);
  const home = path.join(root, 'home');
  const sthayiHome = path.join(home, '.sthayi');
  const globalBin = path.join(root, 'npm-global', 'bin');
  fs.mkdirSync(path.join(sthayiHome, 'bin'), { recursive: true });
  fs.mkdirSync(globalBin, { recursive: true });
  fs.writeFileSync(path.join(sthayiHome, 'key'), 'k'.repeat(32));

  const realCli = path.join(globalBin, 'sthayi');
  fs.writeFileSync(
    realCli,
    [
      '#!/bin/sh',
      `[ "$1" = doctor ] || exit 64`,
      `echo "✓ Home directory      ${sthayiHome}"`,
    ].join('\n'),
  );
  fs.chmodSync(realCli, 0o755);

  // The durable launcher for a global install: a thin shim that execs the global copy.
  const launcher = path.join(sthayiHome, 'bin', 'sthayi');
  fs.writeFileSync(launcher, ['#!/bin/sh', `exec "${realCli}" "$@"`].join('\n'));
  fs.chmodSync(launcher, 0o755);

  return {
    root,
    home,
    globalBin,
    env: { HOME: home, PATH: `${globalBin}:${path.join(sthayiHome, 'bin')}:/usr/bin:/bin` },
  };
}

function sh(script: string, env: Record<string, string>): { status: number; stdout: string } {
  const r = spawnSync('/bin/sh', ['-c', script], {
    cwd: repoRoot,
    env: { PATH: '/usr/bin:/bin', ...env },
    encoding: 'utf8',
  });
  return { status: r.status ?? -1, stdout: r.stdout };
}

/** `npm rm -g sthayi` for the fixture: the global copy goes, the launcher shim is left dangling. */
function removeGlobalPackage(globalBin: string): void {
  fs.rmSync(path.join(globalBin, 'sthayi'), { force: true });
}

describe('safety: uninstall order — the path must be read before the package is removed', () => {
  it.skipIf(process.platform === 'win32')(
    'removing the global package first leaves NO way to run doctor at all',
    () => {
      const fx = globalInstallFixture('sthayi-uninstall-order-wrong-');

      // BEFORE: doctor answers.
      expect(sh('sthayi doctor', fx.env).status).toBe(0);

      removeGlobalPackage(fx.globalBin);

      // AFTER: nothing can name the state directory any more. Not the PATH entry…
      const onPath = sh('sthayi doctor', fx.env);
      expect(onPath.status).not.toBe(0);
      expect(onPath.stdout).toBe('');
      // …and not the durable launcher either: a global install is referenced in place, so the shim
      // now execs a file that was just deleted.
      const viaLauncher = sh(`"$HOME/.sthayi/bin/sthayi" doctor`, fx.env);
      expect(viaLauncher.status).not.toBe(0);
      expect(viaLauncher.stdout).toBe('');
      // Neither route can produce the line the owner was told to read.
      expect(onPath.stdout + viaLauncher.stdout).not.toContain('Home directory');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'reading the path first survives the package removal',
    () => {
      const fx = globalInstallFixture('sthayi-uninstall-order-right-');

      const before = sh('sthayi doctor', fx.env);
      expect(before.status).toBe(0);
      const recorded = before.stdout.trim();
      expect(recorded.startsWith('✓ Home directory')).toBe(true);

      removeGlobalPackage(fx.globalBin);

      // The recorded line is still the answer; the CLI is simply gone.
      expect(recorded).toContain(path.join(fx.home, '.sthayi'));
      const after = sh('sthayi doctor', fx.env);
      expect(after.status).not.toBe(0);
      expect(after.stdout).toBe('');
    },
  );

  it('the README documents doctor and unwire BEFORE the package removal', () => {
    const s = section(readme(), '## Upgrade & uninstall');
    // The ordering claim is about the numbered STEP LIST, so read the fenced block itself rather
    // than prose mentions of the same commands.
    const from = s.indexOf('**Uninstalling');
    expect(from).toBeGreaterThan(-1);
    const open = s.indexOf('```bash', from);
    expect(open).toBeGreaterThan(-1);
    const steps = s.slice(open, s.indexOf('```', open + 7));

    const doctorIdx = steps.indexOf('sthayi doctor');
    const unwireIdx = steps.indexOf('sthayi unwire');
    const removeIdx = steps.indexOf('npm rm -g sthayi');
    expect(doctorIdx).toBeGreaterThan(-1);
    expect(unwireIdx).toBeGreaterThan(-1);
    expect(removeIdx).toBeGreaterThan(-1);
    expect(doctorIdx).toBeLessThan(removeIdx);
    expect(unwireIdx).toBeLessThan(removeIdx);
  });
});

// ---------------------------------------------------------------------------------------------
// 2. THE `Home directory` LINE: absent, failed, or a legitimate path to something you must keep.
// ---------------------------------------------------------------------------------------------

// The live `$HOME` and the live `~/.sthayi` are never read: every case below points BOTH at
// fixtures, and vitest's env stubs restore the process environment after each test.
afterEach(() => {
  vi.unstubAllEnvs();
});

/** Run the real doctor against a fixture home. Never against the live `$HOME` or `~/.sthayi`. */
function doctorAt(
  osHome: string,
  sthayiHome: string,
): { name: string; ok: boolean; detail: string }[] {
  vi.stubEnv('HOME', osHome);
  vi.stubEnv('STHAYI_HOME', sthayiHome);
  return runDoctor().map((c) => ({ name: c.name, ok: c.ok, detail: c.detail }));
}

const homeCheck = (
  checks: { name: string; ok: boolean; detail: string }[],
): { name: string; ok: boolean; detail: string } | undefined =>
  checks.find((c) => c.name === 'Home directory');

describe('safety: doctor does not always print a usable Home directory line', () => {
  it('an uninitialized machine gets NO Home directory line at all', () => {
    const root = runTempDir('sthayi-doctor-absent-line-');
    const osHome = path.join(root, 'home');
    const store = path.join(root, 'state');
    fs.mkdirSync(osHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(store, { recursive: true, mode: 0o700 });

    const checks = doctorAt(osHome, store);

    expect(homeCheck(checks)).toBeUndefined();
    expect(checks.some((c) => c.name === 'Initialization')).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'an unreadable home stops doctor before the Home directory line is ever printed',
    () => {
      const root = runTempDir('sthayi-doctor-unreadable-');
      const osHome = path.join(root, 'home');
      const store = path.join(root, 'state');
      fs.mkdirSync(osHome, { recursive: true, mode: 0o700 });
      fs.mkdirSync(store, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(store, 'key'), 'k'.repeat(32), { mode: 0o600 });
      fs.chmodSync(store, 0o000); // the single commonest way a real home becomes unreadable

      try {
        const checks = doctorAt(osHome, store);
        expect(homeCheck(checks)).toBeUndefined();
        // …and what IS printed is a failure naming the errno, not a location.
        const failed = checks.filter((c) => !c.ok);
        expect(failed.length).toBeGreaterThan(0);
        expect(failed.some((c) => /could not be inspected/.test(c.detail))).toBe(true);
      } finally {
        fs.chmodSync(store, 0o700); // so the run's teardown can remove it
      }
    },
  );

  it('a refused symlinked home yields a FAILED line whose text is a diagnostic, not a path', () => {
    const root = runTempDir('sthayi-doctor-symlink-refusal-');
    const osHome = path.join(root, 'home');
    const elsewhere = path.join(root, 'elsewhere', '.sthayi');
    fs.mkdirSync(osHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(elsewhere, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(elsewhere, 'key'), 'k'.repeat(32), { mode: 0o600 });
    fs.symlinkSync(path.join(root, 'elsewhere'), path.join(root, 'alias'));

    const checks = doctorAt(osHome, path.join(root, 'alias', '.sthayi'));
    const home = homeCheck(checks);

    expect(home).toBeDefined();
    expect(home?.ok).toBe(false);
    expect(home?.detail).toMatch(/possible hijack/);
    // The refusal MENTIONS a real path so the owner can see what is planted — that is the whole
    // reason it is quoted. It is prose, not a path: it does not name an existing directory, so
    // "act on what doctor printed" has nothing to act on. Nothing was resolved on the owner's
    // behalf, and the directory the link points at was never validated.
    expect(fs.existsSync(home?.detail ?? '')).toBe(false);
    expect(home?.detail).toContain(fs.realpathSync(path.join(root, 'elsewhere')));
    expect(fs.existsSync(elsewhere)).toBe(true);
  });

  it('a PASSING line can legitimately name the owners entire OS home', () => {
    const root = runTempDir('sthayi-doctor-os-home-alias-');
    const osHome = path.join(root, 'home');
    fs.mkdirSync(osHome, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(osHome, '.profile'), 'canary: shell profile');
    fs.mkdirSync(path.join(osHome, 'Documents'));
    fs.writeFileSync(path.join(osHome, 'Documents', 'taxes.pdf'), 'canary: unrelated user file');
    fs.writeFileSync(path.join(osHome, 'key'), 'k'.repeat(32), { mode: 0o600 });

    // STHAYI_HOME=$HOME is legal and doctor reports it exactly like any other state directory.
    const home = homeCheck(doctorAt(osHome, osHome));

    expect(home?.ok).toBe(true);
    expect(home?.detail).toBe(fs.realpathSync(osHome));
    // Everything a "delete what doctor printed" instruction would take with it.
    expect(fs.existsSync(path.join(osHome, '.profile'))).toBe(true);
    expect(fs.existsSync(path.join(osHome, 'Documents', 'taxes.pdf'))).toBe(true);
    // The printed path IS the OS home — the same directory by device/inode, not merely a string
    // that resembles it. Nothing in the passing check says so.
    const printed = fs.lstatSync(home?.detail ?? '');
    const real = fs.lstatSync(fs.realpathSync(osHome));
    expect(printed.dev).toBe(real.dev);
    expect(printed.ino).toBe(real.ino);
  });

  it('a PASSING line can name a broad directory holding unrelated files', () => {
    const root = runTempDir('sthayi-doctor-broad-dir-');
    const osHome = path.join(root, 'home');
    const shared = path.join(root, 'shared');
    fs.mkdirSync(osHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(shared, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(shared, 'key'), 'k'.repeat(32), { mode: 0o600 });
    fs.writeFileSync(path.join(shared, 'payroll.csv'), 'canary: unrelated');
    fs.mkdirSync(path.join(shared, 'photos'));
    fs.writeFileSync(path.join(shared, 'photos', 'wedding.jpg'), 'canary: unrelated');

    const home = homeCheck(doctorAt(osHome, shared));

    expect(home?.ok).toBe(true);
    expect(home?.detail).toBe(fs.realpathSync(shared));
    // The unrelated files are still there, and the passing check counted none of them.
    expect(fs.existsSync(path.join(shared, 'payroll.csv'))).toBe(true);
    expect(fs.existsSync(path.join(shared, 'photos', 'wedding.jpg'))).toBe(true);
    expect(fs.readdirSync(shared).sort()).toEqual(['key', 'payroll.csv', 'photos']);
  });

  it('a dedicated home passes in EXACTLY the same shape as the hazardous ones', () => {
    const root = runTempDir('sthayi-doctor-dedicated-home-');
    const osHome = path.join(root, 'home');
    const store = path.join(root, 'custom-sthayi-home');
    fs.mkdirSync(osHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(store, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(store, 'key'), 'k'.repeat(32), { mode: 0o600 });
    fs.writeFileSync(path.join(store, 'config.json'), '{}');
    fs.mkdirSync(path.join(store, 'bin'));
    fs.mkdirSync(path.join(store, 'logs'));

    const home = homeCheck(doctorAt(osHome, store));

    // Same `ok`, same bare-path detail as the OS-home and broad-directory cases above.
    expect(home?.ok).toBe(true);
    expect(home?.detail).toBe(fs.realpathSync(store));
    // And the check carries a name, a boolean, a location and an optional FIX LINE — nowhere for
    // a removal verdict to live, and the fix line is empty on a pass. Nothing an owner reads
    // separates this dedicated home from the OS home or the directory full of unrelated files.
    const raw = runDoctor().find((c) => c.name === 'Home directory');
    expect(Object.keys(raw ?? {}).sort()).toEqual(['detail', 'fix', 'name', 'ok']);
    expect(raw?.fix).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// 3. NO PRODUCTION RESET OR ERASE COMMAND EXISTS — which is why the docs publish no procedure.
// ---------------------------------------------------------------------------------------------

/**
 * The docs claim Sthayi ships no reset or erase command and that the safe form of it does not
 * exist yet. That is a claim about the PRODUCT, so it is checked against the product: the declared
 * CLI surface, and every recursive removal the CLI source actually performs.
 *
 * Deliberately NOT asserted here: that some directory is a safe removal target. Deciding that needs
 * directory handles Node does not expose — race-free opens, race-free readdir — and every
 * path-based approximation of it fails OPEN (file header). While no command ships, "no such
 * operation exists in the product" is the invariant available, and it is the stronger one.
 */

const CLI_SRC = path.join(repoRoot, 'packages', 'cli', 'src');

/** Every production `.ts` under packages/cli/src — test files excluded. */
function productionSources(dir: string = CLI_SRC): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...productionSources(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** `file:line: text` for every production line matching `re`. */
function sourceHits(re: RegExp): string[] {
  const hits: string[] = [];
  for (const file of productionSources()) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (const [i, line] of lines.entries()) {
      if (re.test(line)) {
        hits.push(`${path.relative(repoRoot, file)}:${i + 1}: ${line.trim()}`);
      }
    }
  }
  return hits;
}

const DESTRUCTIVE_COMMAND = /^(?:reset|erase|purge|wipe|destroy|nuke|forget|delete|uninstall)$/i;

describe('safety: the product ships no whole-tree removal, so the docs describe none', () => {
  it('the declared CLI surface has no reset, erase, purge or wipe command', () => {
    expect(COMMANDS.length).toBeGreaterThan(0);
    for (const spec of COMMANDS) {
      expect(spec.name).not.toMatch(DESTRUCTIVE_COMMAND);
      // …and no summary offers the same operation under a name that is not on that list.
      expect(spec.summary).not.toMatch(/\b(erase|purge|wipe|destroy|delete)\b/i);
    }
    // `unwire` is the only removal Sthayi automates, and it reaches client configs alone.
    expect(COMMANDS.find((c) => c.name === 'unwire')?.summary).toMatch(/client configs/i);
  });

  it('no production module hands the state-directory root to a destructive fs call', () => {
    // Line-local by design: the hazard is a mutation whose argument IS the home root, in any of
    // the four shapes that would move or erase the whole tree at once.
    const hits = sourceHits(
      /\b(?:rmSync|rmdirSync|renameSync|cpSync)\b[^\n]*\b(?:sthayiHomeRoot|sthayiHome|ensureSthayiHome|assertReadOnlySthayiHome)\s*\(\s*\)/,
    );
    expect(hits).toEqual([]);
  });

  /**
   * THE INVARIANT: writing a launcher removes NOTHING it did not itself just create.
   *
   * `<home>/runtime/` is not a directory Sthayi maintains. An ephemeral install is refused outright,
   * nothing is copied, staged, refreshed or garbage collected there, and no launcher points inside
   * it — so the property to prove is not "the removals are non-recursive" but that THERE ARE NO
   * REMOVALS at all.
   *
   * Reading the source for `recursive: true` cannot settle that: the string says nothing about which
   * directory a call will name when the kernel resolves it, and a helper one indirection away would
   * pass a grep unread. So this is EXECUTED against the real launcher, with every removal syscall
   * instrumented, over a `runtime/` directory deliberately stocked with the entries a whole-tree
   * cleanup would reach for.
   */
  const npxFixture = async (
    base: string,
  ): Promise<{ entry: string; home: string; runtime: string }> => {
    const home = path.join(base, 'home');
    fs.mkdirSync(home, { mode: 0o700 });
    const nm = path.join(base, 'cache', '_npx', 'feedface', 'node_modules');
    const pkg = path.join(nm, 'sthayi');
    fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'sthayi' }));
    fs.writeFileSync(path.join(pkg, 'dist', 'index.js'), '// fake sthayi entry\n');
    vi.stubEnv('STHAYI_HOME', home);
    return { entry: path.join(pkg, 'dist', 'index.js'), home, runtime: path.join(home, 'runtime') };
  };

  /** Type, permission bits and contents of every entry — a tree compared as bytes AND modes. */
  const deepSnapshot = (dir: string): string[] => {
    const out: string[] = [];
    const walk = (d: string, rel: string): void => {
      for (const name of fs.readdirSync(d).sort()) {
        const full = path.join(d, name);
        const r = rel === '' ? name : `${rel}/${name}`;
        const st = fs.lstatSync(full);
        const mode = (st.mode & 0o7777).toString(8);
        if (st.isSymbolicLink()) {
          out.push(`link ${r} -> ${fs.readlinkSync(full)}`);
        } else if (st.isDirectory()) {
          out.push(`dir  ${r} mode=${mode}`);
          walk(full, r);
        } else {
          out.push(`file ${r} mode=${mode} :: ${fs.readFileSync(full, 'utf8')}`);
        }
      }
    };
    walk(dir, '');
    return out;
  };

  it.skipIf(process.platform === 'win32')(
    'the CLI issues NO removal at all, and leaves a stocked runtime/ byte- and mode-identical',
    async () => {
      const { writeLauncher } = await import('../../packages/cli/src/clients/launcher.js');
      const { VERSION } = await import('../../packages/cli/src/version.js');
      const base = runTempDir('sthayi-reset-nonrecursive-');
      const savedArgv1 = process.argv[1];
      try {
        const { entry, runtime } = await npxFixture(base);
        process.argv[1] = entry;
        // The shapes a whole-tree cleanup would reach for: a stale version tree, the CURRENT
        // version's tree, a stale-looking staging dir, and a quarantine. Not one of them
        // is touched, swept, parked or reclaimed.
        for (const name of [VERSION, '0.0.1-old', '.tmp-stale', '.discard-abc']) {
          fs.mkdirSync(path.join(runtime, name), { recursive: true });
          fs.writeFileSync(path.join(runtime, name, 'junk.txt'), `contents of ${name}`);
        }
        const before = deepSnapshot(runtime);

        const calls: { op: string; target: string; recursive: boolean }[] = [];
        const realRm = fs.rmSync.bind(fs);
        const realRmdir = fs.rmdirSync.bind(fs);
        const realUnlink = fs.unlinkSync.bind(fs);
        const realRename = fs.renameSync.bind(fs);
        vi.spyOn(fs, 'rmSync').mockImplementation((p, o) => {
          calls.push({ op: 'rmSync', target: String(p), recursive: o?.recursive === true });
          return realRm(p, o);
        });
        vi.spyOn(fs, 'rmdirSync').mockImplementation((p, o) => {
          calls.push({ op: 'rmdirSync', target: String(p), recursive: o?.recursive === true });
          return realRmdir(p, o);
        });
        vi.spyOn(fs, 'unlinkSync').mockImplementation((p) => {
          calls.push({ op: 'unlinkSync', target: String(p), recursive: false });
          return realUnlink(p);
        });
        vi.spyOn(fs, 'renameSync').mockImplementation((a, b) => {
          calls.push({
            op: 'renameSync',
            target: `${String(a)} -> ${String(b)}`,
            recursive: false,
          });
          return realRename(a, b);
        });

        // The npx entry is refused; nothing is copied, and so nothing is ever cleaned up either.
        expect(() => writeLauncher()).toThrow(/refusing to write a launcher/);

        expect(calls).toEqual([]);
        expect(deepSnapshot(runtime)).toEqual(before);
      } finally {
        vi.restoreAllMocks();
        if (savedArgv1 !== undefined) {
          process.argv[1] = savedArgv1;
        }
        // Identity-aware, not recursive-by-name: the `finally` is teardown, whatever the test
        // above it was about, and teardown removes the recorded allocation entry by entry.
        removeOwned(base);
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'a runtime/ retargeted at an outside tree is never followed: the outside tree is untouched',
    async () => {
      const { writeLauncher } = await import('../../packages/cli/src/clients/launcher.js');
      const { VERSION } = await import('../../packages/cli/src/version.js');
      const base = runTempDir('sthayi-reset-identity-');
      const savedArgv1 = process.argv[1];
      try {
        const { entry, runtime } = await npxFixture(base);
        process.argv[1] = entry;

        // An outside tree wearing exactly the names the retired cleanup reached for, plus a canary.
        const outside = path.join(base, 'outside');
        fs.mkdirSync(path.join(outside, VERSION), { recursive: true });
        fs.writeFileSync(path.join(outside, VERSION, 'victim.txt'), 'EXTERNAL VERSION TREE');
        fs.mkdirSync(path.join(outside, 'unrelated'), { recursive: true });
        fs.writeFileSync(path.join(outside, 'unrelated', 'keep.txt'), 'CANARY');
        fs.chmodSync(path.join(outside, 'unrelated', 'keep.txt'), 0o640);
        const before = deepSnapshot(outside);
        // `runtime/` IS the link — no substitution seam is needed any more, because there is no
        // moment at which the launcher resolves that name at all.
        fs.symlinkSync(outside, runtime);

        expect(() => writeLauncher()).toThrow(/refusing to write a launcher/);
        // byte- AND mode-identical, and the link itself still stands as a link
        expect(deepSnapshot(outside)).toEqual(before);
        expect(fs.readlinkSync(runtime)).toBe(outside);
      } finally {
        vi.restoreAllMocks();
        if (savedArgv1 !== undefined) {
          process.argv[1] = savedArgv1;
        }
        removeOwned(base); // teardown: the recorded allocation, never a pathname walk
      }
    },
  );

  it('both docs say the command does not exist, and the shipped surface agrees', () => {
    for (const text of [readme(), security()]) {
      expect(text).toMatch(/does\s+not\s+exist\s+yet/i);
    }
    expect(COMMANDS.some((c) => DESTRUCTIVE_COMMAND.test(c.name))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// 4. WHAT THE DOCS MAY AND MAY NOT SAY TODAY — imperative, gerund and descriptive forms alike.
// ---------------------------------------------------------------------------------------------

/**
 * Destructive guidance does not have to be phrased as an order. "…then removing the selected
 * archive folder removes the notes themselves" authorises precisely what "Delete that directory"
 * authorises, while reading as a statement of fact — and an imperative-only scan waves it straight
 * through. Four families are refused, and every one is applied to the WHOLE of README.md and
 * SECURITY.md: the bill of rights, the quickstart and the troubleshooting notes all name the state
 * directory too, so a scan limited to the uninstall section is not enough.
 *
 *   IMPERATIVE  — "Delete that directory"; "2. **Rename** that folder to a dated sibling".
 *   CHAINED     — a deletion GERUND hung off a procedure connective: "then deleting…",
 *                 "by removing…", "start by erasing…". The connective is what makes it a step.
 *   POINTED     — a deletion GERUND aimed at a DEFINITE directory: "removing the directory",
 *                 "deleting your state directory". An honest limitation speaks of *a* state
 *                 directory in general; only guidance points at *the* one the owner has, which is
 *                 what makes this line drawable at all.
 *   CONSEQUENT  — a described removal with its payoff attached: "<gerund> … the directory …
 *                 deletes the memory". Promising the outcome is what turns description into
 *                 instruction, whoever the grammatical subject is.
 */
const DELETION_GERUND = 'deleting|removing|erasing|renaming|moving|wiping|purging';
const TARGET_NOUN = 'director(?:y|ies)|folder|tree|store|home|path|memory';
const DEFINITE = 'the|that|this|these|those|your|its';

/**
 * `scan: 'raw'` for patterns anchored to the start of a line; `scan: 'flat'` for everything else,
 * which runs against a whitespace-collapsed copy. Markdown HARD-WRAPS, so the sentence this scan
 * exists for splits as "…then deleting the⏎  configured state directory deletes…", and a pattern
 * that treats a newline as a boundary reads two harmless halves.
 */
const DESTRUCTIVE_GUIDANCE: readonly { name: string; re: RegExp; scan: 'raw' | 'flat' }[] = [
  {
    name: 'imperative',
    scan: 'raw',
    re: /(^|\n)\s*(?:\d+\.\s*|[-*]\s*)?(?:Then\s+|Now\s+|So\s+)?\*{0,2}(?:Delete|Remove|Erase|Rename|Move|Wipe|Purge)\b[^.]{0,120}?\b(?:that|the)\b[^.]{0,120}?\b(?:directory|folder|tree|path|store|home)\b/i,
  },
  { name: 'imperative: then delete that', scan: 'flat', re: /\bthen\s+delete\s+\*{0,2}that\b/i },
  {
    name: 'imperative: the literal path',
    scan: 'flat',
    re: /\bdelete\b[^.]{0,40}\bthe literal path\b/i,
  },
  {
    name: 'chained gerund',
    scan: 'flat',
    re: new RegExp(
      `\\b(?:then|now|next|finally|lastly|afterwards?|subsequently)\\s+(?:${DELETION_GERUND})\\b`,
      'i',
    ),
  },
  {
    name: 'gerund as means',
    scan: 'flat',
    re: new RegExp(`\\bby\\s+(?:${DELETION_GERUND})\\b`, 'i'),
  },
  {
    name: 'gerund as step',
    scan: 'flat',
    re: new RegExp(
      `\\b(?:start|starts|begin|begins|finish|finishes|end|ends|conclude|concludes|follow|follows)\\s+(?:with|by)\\s+(?:${DELETION_GERUND})\\b`,
      'i',
    ),
  },
  {
    name: 'gerund pointed at a definite directory',
    scan: 'flat',
    re: new RegExp(
      `\\b(?:${DELETION_GERUND})\\s+(?:${DEFINITE})\\s+(?:[\\w'’-]+\\s+){0,3}?(?:${TARGET_NOUN})\\b`,
      'i',
    ),
  },
  {
    name: 'described removal with its payoff attached',
    scan: 'flat',
    re: new RegExp(
      `\\b(?:${DELETION_GERUND})\\s[^.]{0,80}?\\b(?:${TARGET_NOUN})\\b[^.]{0,60}?\\b(?:deletes|removes|erases|wipes|destroys|purges)\\b`,
      'i',
    ),
  },
];

/** The families a passage trips, empty when it authorises nothing. */
function destructiveGuidanceIn(text: string): string[] {
  const flat = text.replace(/\s+/g, ' ');
  return DESTRUCTIVE_GUIDANCE.filter(({ re, scan }) => re.test(scan === 'raw' ? text : flat)).map(
    ({ name }) => name,
  );
}

/**
 * Phrasings the scan has to catch, written as SYNTHETIC samples rather than lifted from any file
 * in this repository — the scan is a grammar check, so what it must catch is a SHAPE, and a sample
 * that is also a real sentence somewhere would quietly turn this into a string comparison.
 *
 * The first is the shape the whole non-imperative half of the family exists for: a bullet in a
 * feature list that names no imperative verb at all, so an imperative-only scan reports a clean
 * file on it — and that HARD-WRAPS mid-clause, which is why the scan flattens whitespace first.
 */
const MUST_BE_CAUGHT: readonly { sample: string; families: readonly string[] }[] = [
  {
    sample:
      '- **Portable** — `widget unhook` restores editor configs, then removing the\n' +
      '  selected archive folder removes the notes themselves — the last copy.',
    families: [
      'chained gerund',
      'gerund pointed at a definite directory',
      'described removal with its payoff attached',
    ],
  },
  {
    sample: 'Removing the directory removes the memory.',
    families: [
      'gerund pointed at a definite directory',
      'described removal with its payoff attached',
    ],
  },
  { sample: 'You can start over by deleting the state directory.', families: ['gerund as means'] },
  { sample: 'Then delete that directory.', families: ['imperative'] },
  { sample: 'Start by erasing your state directory.', families: ['gerund as step'] },
];

/** Honest limitation statements, which say the same words and authorise nothing. */
const MUST_NOT_BE_CAUGHT: readonly string[] = [
  'This page publishes no procedure for erasing a state directory.',
  'Erasing a store means renaming or deleting a whole directory tree.',
  'Removal of the state directory itself is a separate decision, and one Sthayi leaves to you.',
  'Physically removing that plaintext is an owner decision about a directory on your disk.',
  'Sthayi does not yet ship a validated erase command.',
];

describe('safety: the docs authorise no whole-tree operation on a path doctor printed', () => {
  it('neither doc turns the printed path into a delete or rename instruction', () => {
    for (const text of [readme(), security()]) {
      // Whole file, every family — not the uninstall section, and not imperatives alone.
      expect(destructiveGuidanceIn(text)).toEqual([]);
      // Two phrasings that would name the printed path as a removal target outright, and that the
      // grammar families above do not reach: a bare noun phrase, and a rename destination.
      expect(text).not.toContain('the literal path doctor printed');
      expect(text).not.toContain('timestamped sibling');
    }
  });

  it('the scan catches the gerund and descriptive forms an imperative scan misses', () => {
    for (const { sample, families } of MUST_BE_CAUGHT) {
      expect(destructiveGuidanceIn(sample)).toEqual(expect.arrayContaining([...families]));
    }
  });

  it('the scan leaves the honest limitation statements alone', () => {
    for (const sample of MUST_NOT_BE_CAUGHT) {
      expect(destructiveGuidanceIn(sample)).toEqual([]);
    }
  });

  it('the Memory bill of rights states deletability without directing a removal', () => {
    const bill = section(readme(), '## Memory bill of rights');
    const deletable = bill.slice(bill.indexOf('- **Deletable**'));
    expect(deletable).not.toBe('');
    expect(destructiveGuidanceIn(deletable)).toEqual([]);
    const flat = deletable.replace(/\s+/g, ' ');
    // Deletability IN PRINCIPLE still stands: the owner holds the only copy, at a location the
    // CLI reports, and Sthayi retains no hosted copy.
    expect(flat).toContain('STHAYI_HOME');
    expect(flat).toMatch(/retains no hosted copy/i);
    // What replaces the instruction: the state of the product, and a pointer to the warning.
    expect(flat).toMatch(/does not yet ship a validated erase command/i);
    expect(flat).toMatch(/publishes no procedure/i);
    expect(flat).toContain('#upgrade--uninstall');
  });

  it('paths.ts accepts ANY non-empty absolute STHAYI_HOME, so no doc may claim otherwise', () => {
    const root = runTempDir('sthayi-paths-accepts-');
    const osHome = path.join(root, 'home');
    fs.mkdirSync(osHome, { recursive: true, mode: 0o700 });
    // An OS home, a filesystem root, a volume/share root and a plain directory are all legal.
    for (const candidate of [osHome, '/', '/Volumes/backup', '/mnt/shared', path.join(root, 'x')]) {
      vi.stubEnv('STHAYI_HOME', candidate);
      expect(sthayiHome()).toBe(candidate);
    }
    // The ONE refusal here is a relative home, and it is about launcher-command safety — not
    // about whether the directory is a sound thing to remove whole.
    vi.stubEnv('STHAYI_HOME', 'relative/home');
    expect(() => sthayiHome()).toThrow(/absolute/i);
  });

  it('neither doc claims a check exists that refuses an OS home, a root or a broad directory', () => {
    for (const text of [readme(), security()]) {
      const flat = text.replace(/\s+/g, ' ');
      // The overclaim: that Sthayi's own code turns the hazard list above into refusals.
      expect(flat).not.toMatch(/refuses these cases/i);
      expect(flat).not.toMatch(
        /\brefuses\b[^.]{0,120}\b(?:your OS home|whole home directory|broad director)/i,
      );
      // The narrower truth both files carry instead.
      expect(flat).toMatch(/canonicalizes paths/i);
      expect(flat).toMatch(/does not certify a directory as a safe whole-tree removal target/i);
      expect(flat).toMatch(/any non-empty absolute `STHAYI_HOME` is a legal state directory/i);
      expect(flat).toContain('packages/cli/src/paths.ts');
    }
  });

  it('the README states the stop condition on the Home directory check', () => {
    const s = section(readme(), '## Upgrade & uninstall');
    expect(s).toContain('✓ Home directory');
    expect(s).toContain('✗ Home directory');
    // A failed line is a diagnostic, and the docs must not describe it as a resolved location.
    expect(s).toMatch(/diagnostic, not a location/i);
    expect(s).toMatch(/not a target to act on/i);
    expect(s).toMatch(/No `Home directory` line at all/);
    expect(s).toMatch(/stop/i);
  });

  it('neither doc claims a REFUSED home was resolved for the owner', () => {
    // "symlinks already resolved" is only true of a PASSING check. Every occurrence has to sit in
    // the sentence describing the `✓` line, never in the one describing `✗`.
    for (const text of [readme(), security()]) {
      const re = /symlinks? already resolved/gi;
      let seen = 0;
      for (let m = re.exec(text); m !== null; m = re.exec(text)) {
        seen++;
        const context = text.slice(Math.max(0, m.index - 400), m.index);
        const lastPass = context.lastIndexOf('✓');
        const lastFail = context.lastIndexOf('✗');
        expect(lastPass).toBeGreaterThan(-1);
        expect(lastPass).toBeGreaterThan(lastFail);
      }
      expect(seen).toBeGreaterThan(0);
    }
  });

  it('the README names every printed path that is not a safe target', () => {
    const s = section(readme(), '## Upgrade & uninstall');
    expect(s).toMatch(/STHAYI_HOME=\$HOME/);
    expect(s).toMatch(/whole home directory/i);
    expect(s).toMatch(/filesystem root/i);
    expect(s).toMatch(/mounted volume|network share/i);
    expect(s).toMatch(/your own files/i);
    expect(s).toMatch(/`sthayi\.db`[^\n]*does not make/i);
  });

  it('both docs state the limitation honestly instead of publishing a procedure', () => {
    const uninstall = section(readme(), '## Upgrade & uninstall');
    expect(uninstall).toMatch(/publishes\s+no\s+procedure/i);
    expect(uninstall).toMatch(/no\s+reset\s+or\s+erase\s+command/i);
    expect(uninstall).toMatch(/does\s+not\s+exist\s+yet/i);

    const sec = security();
    expect(sec).toMatch(/neither\s+scripts\s+nor\s+validates/i);
    expect(sec).toMatch(/publishes\s+no\s+snippet\s+and\s+no\s+by-hand\s+procedure/i);
    expect(sec).toMatch(/does\s+not\s+exist\s+yet/i);
  });

  it('SECURITY.md still offers a non-destructive route, and it is genuinely non-destructive', () => {
    const sec = security();
    // A second store at a new STHAYI_HOME leaves the legacy one untouched.
    expect(sec).toMatch(/export STHAYI_HOME=/);
    expect(sec).toMatch(/stays\s+exactly\s+where\s+it\s+is/i);
    expect(sec).not.toMatch(/^\s*mv\s/m);
    expect(sec).not.toContain('rm -rf');
  });

  it('neither doc claims a Windows or PowerShell reset path was verified', () => {
    for (const text of [readme(), security()]) {
      expect(text).not.toMatch(/PowerShell[^.\n]*\b(tested|verified)\b/i);
      expect(text).not.toMatch(/\b(tested|verified)\b[^.\n]*PowerShell/i);
    }
  });
});
