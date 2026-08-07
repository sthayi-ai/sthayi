import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureBuiltCli } from '../helpers/build-cli.js';
import { snapshotTree } from '../helpers/fake-home.js';
import { removeOwned } from '../helpers/owned-fs.js';
import { claimToolEntry } from '../helpers/owned-fs.js';
import { runTempDir } from '../helpers/run-temp.js';

/**
 * SAFETY: the canonical dry-run probe, against the BUILT CLI.
 * A planted `~/.codex/config.toml` under a temp HOME, separate virgin STHAYI_HOMEs, then
 * `init --dry-run` and `wire --client codex --dry-run` — full-tree snapshot equality is required:
 * every dry-run leaves HOME, STHAYI_HOME, client configs, backups, state ledger, database, key,
 * launcher, and skills byte-for-byte and path-for-path unchanged.
 *
 * Requires `pnpm build` (same as keyless-matrix / multi-process-writes): the dist under test
 * must include the current source.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const distEntry = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');

describe('safety: dry-run is genuinely write-free (built CLI)', () => {
  let probeRoot: string;
  let userHome: string;

  beforeAll(() => {
    ensureBuiltCli(); // shared build-once lock — never race another file's rebuild of dist
  }, 300_000);

  beforeEach(() => {
    expect(fs.existsSync(distEntry), `missing ${distEntry} — run \`pnpm build\` first`).toBe(true);
    // realpath: on macOS os.tmpdir() is itself reached through a symlink (/var -> private/var),
    // and Sthayi refuses a STHAYI_HOME reached through ANY link — a storage location must be named
    // by its canonical real path. The probe root is canonicalized so these fixtures are real paths.
    // The digits in the prefix are deliberate. Every refusal below prints the path it refused, so
    // the probe root reaches stdout/stderr on every row — which keeps a permission canary written
    // as the bare digits `646` failing on the pathname alone, with nothing disclosed. The canary is
    // anchored to `mode 646` instead, and this name is what proves the anchor is load-bearing.
    probeRoot = runTempDir('sthayi-dryrun-tmp646-');
    userHome = path.join(probeRoot, 'home');
    fs.mkdirSync(path.join(userHome, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(userHome, '.codex', 'config.toml'), 'model = "test"\n');
  });

  afterEach(() => {
    removeOwned(probeRoot);
  });

  function run(sthayiHome: string, args: string[]) {
    const r = spawnSync(process.execPath, [distEntry, ...args], {
      env: {
        ...process.env,
        HOME: userHome,
        USERPROFILE: userHome,
        STHAYI_HOME: sthayiHome,
      },
      cwd: probeRoot,
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }

  it('init --dry-run: exit 0, plan printed, full probe tree untouched', () => {
    const sthayiHome = path.join(probeRoot, 'init-dry');
    const before = snapshotTree(probeRoot);

    const r = run(sthayiHome, ['init', '--dry-run']);
    const label = `--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`;
    expect(r.status, label).toBe(0);
    expect(r.stdout, label).toMatch(/Dry run — would initialize/);

    expect(snapshotTree(probeRoot)).toEqual(before);
    expect(fs.existsSync(sthayiHome)).toBe(false); // a virgin STHAYI_HOME stays nonexistent
  });

  it('wire --client codex --dry-run: exit 0, "would wire" reported, full probe tree untouched', () => {
    const sthayiHome = path.join(probeRoot, 'wire-dry');
    const before = snapshotTree(probeRoot);

    const r = run(sthayiHome, ['wire', '--client', 'codex', '--dry-run']);
    const label = `--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`;
    expect(r.status, label).toBe(0);
    expect(r.stdout, label).toMatch(/would wire/);

    expect(snapshotTree(probeRoot)).toEqual(before);
    expect(fs.existsSync(sthayiHome)).toBe(false);
  });

  // A launcher replaced by a symlink whose OUTSIDE target holds exactly the bytes `wire` would
  // write: a content comparison calls that "unchanged" and the hijack is reported as health. The
  // dry-run must REFUSE — and, being a dry-run, still write nothing on that refusal path.
  it.skipIf(process.platform === 'win32')(
    'init --dry-run over a launcher symlinked to a byte-identical OUTSIDE file: refuses, writes nothing',
    () => {
      const sthayiHome = path.join(probeRoot, 'init-dry-symlink');
      const outside = path.join(probeRoot, 'outside');
      fs.mkdirSync(outside);
      // Seed the real launcher, capture its exact bytes, then plant them outside and symlink to them.
      expect(run(sthayiHome, ['wire']).status).toBe(0);
      const launcher = path.join(sthayiHome, 'bin', 'sthayi-mcp');
      const victim = path.join(outside, 'identical-launcher');
      fs.copyFileSync(launcher, victim);
      fs.chmodSync(victim, 0o644);
      fs.rmSync(launcher);
      fs.symlinkSync(victim, launcher);
      const victimBytes = fs.readFileSync(victim);
      const before = snapshotTree(probeRoot);

      const r = run(sthayiHome, ['init', '--dry-run']);
      const label = `--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`;
      expect(r.status, label).toBe(1);
      expect(r.stderr, label).toMatch(/symlink/i);
      expect(r.stdout, label).not.toMatch(/keep launcher/);

      expect(snapshotTree(probeRoot)).toEqual(before);
      expect(fs.readFileSync(victim).equals(victimBytes)).toBe(true);
      expect(fs.statSync(victim).mode & 0o777).toBe(0o644);
      expect(fs.lstatSync(launcher).isSymbolicLink()).toBe(true);
    },
  );

  // A FIFO at the launcher path BLOCKS a plain readFileSync forever, so the dry-run never
  // returns. The descriptor-safe reader refuses it at the lstat gate instead.
  it.skipIf(process.platform === 'win32')(
    'wire --dry-run over a FIFO at the launcher path: refuses promptly, never blocks',
    () => {
      const sthayiHome = path.join(probeRoot, 'wire-dry-fifo');
      fs.mkdirSync(path.join(sthayiHome, 'bin'), { recursive: true, mode: 0o700 });
      try {
        execFileSync('mkfifo', [path.join(sthayiHome, 'bin', 'sthayi-mcp')]);
      } catch {
        return; // no mkfifo on this system — the symlink row covers the descriptor gate
      }
      // `mkfifo` writes outside every binding this process wraps. This names the ONE entry it was
      // asked to make, so teardown has a basis for removing that entry alone.
      claimToolEntry(path.join(sthayiHome, 'bin', 'sthayi-mcp'));
      const before = snapshotTree(path.join(probeRoot, 'home'));

      const started = Date.now();
      const r = run(sthayiHome, ['wire', '--client', 'codex', '--dry-run']);
      const label = `--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`;
      expect(r.status, label).toBe(1); // not null — null is the 60s timeout kill (a hang)
      expect(Date.now() - started).toBeLessThan(30_000);
      expect(r.stderr, label).toMatch(/not a regular file/i);

      expect(snapshotTree(path.join(probeRoot, 'home'))).toEqual(before);
      expect(fs.lstatSync(path.join(sthayiHome, 'bin', 'sthayi-mcp')).isFIFO()).toBe(true);
      expect(fs.readdirSync(path.join(sthayiHome, 'bin'))).toEqual(['sthayi-mcp']);
    },
  );

  // `existsSync` FOLLOWS: with the db path symlinked to an outside file, `init --dry-run` printed
  // `keep existing db` — a user-visible verdict about a file outside the home, whose existence the
  // dry-run thereby disclosed. It must REFUSE, name the symlink, and still write nothing.
  it.skipIf(process.platform === 'win32')(
    'init --dry-run over a db symlinked OUTSIDE: refuses, discloses nothing, writes nothing',
    () => {
      const sthayiHome = path.join(probeRoot, 'init-dry-db-symlink');
      const outside = path.join(probeRoot, 'outside');
      fs.mkdirSync(outside);
      const victim = path.join(outside, 'db-canary');
      fs.writeFileSync(victim, 'OUTSIDE-DB-CANARY');
      fs.chmodSync(victim, 0o646);
      fs.mkdirSync(sthayiHome, { recursive: true, mode: 0o700 });
      fs.symlinkSync(victim, path.join(sthayiHome, 'sthayi.db'));
      const before = snapshotTree(probeRoot);

      const r = run(sthayiHome, ['init', '--dry-run']);
      const label = `--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`;
      expect(r.status, label).toBe(1);
      expect(r.stderr, label).toMatch(/symlink/i);
      expect(r.stdout, label).not.toMatch(/keep existing db/);
      expect(`${r.stdout}${r.stderr}`, label).not.toContain('OUTSIDE-DB-CANARY');
      // The leak shape is the rendered permission bits — `(mode 646)`. A bare `646` also fires on
      // any run whose temp path happens to contain those digits, which says nothing about
      // disclosure, so the canary is anchored to the words the code would actually print.
      expect(`${r.stdout}${r.stderr}`, label).not.toMatch(/\bmode 646\b/);

      expect(snapshotTree(probeRoot)).toEqual(before);
      expect(fs.readFileSync(victim, 'utf8')).toBe('OUTSIDE-DB-CANARY');
      expect(fs.lstatSync(victim).mode & 0o777).toBe(0o646);
      expect(fs.lstatSync(path.join(sthayiHome, 'sthayi.db')).isSymbolicLink()).toBe(true);
    },
  );

  it('wire --client codex --dry-run over a BROKEN entry: reports repair, still write-free', () => {
    // Broken-wiring dry-run rule: a broken entry may only be REPORTED, never repaired, on --dry-run.
    fs.writeFileSync(
      path.join(userHome, '.codex', 'config.toml'),
      'model = "test"\n\n[mcp_servers.sthayi]\ncommand = "/definitely/missing/sthayi"\nargs = []\n',
    );
    const sthayiHome = path.join(probeRoot, 'wire-dry-broken');
    const before = snapshotTree(probeRoot);

    const r = run(sthayiHome, ['wire', '--client', 'codex', '--dry-run']);
    const label = `--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`;
    expect(r.status, label).toBe(0);
    expect(r.stdout, label).toMatch(/would repair/);

    expect(snapshotTree(probeRoot)).toEqual(before);
    expect(fs.existsSync(sthayiHome)).toBe(false);
  });
});
