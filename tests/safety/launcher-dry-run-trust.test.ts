import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { planInit, runWire } from '../../packages/cli/src/clients/commands.js';
import { launcherHealth, renderLauncher } from '../../packages/cli/src/clients/launcher.js';
import { type FakeHome, createFakeHome, snapshotTree } from '../helpers/fake-home.js';
import { removeOwned } from '../helpers/owned-fs.js';
import { runTempDir } from '../helpers/run-temp.js';

/**
 * SAFETY: the DRY-RUN launcher inspection is descriptor-safe.
 *
 * `init --dry-run` / `wire --dry-run` decide create/update/unchanged by reading the launcher that
 * is already on disk. Served by a raw `readFileSync` inside a bare try/catch, that read FOLLOWS a
 * launcher replaced by a symlink (and an outside target with identical bytes reports "unchanged"
 * — the hijack renders as health), BLOCKS the command on a FIFO, reads a hard link or an oversize
 * file whole, and collapses every one of those failures into the "create" outcome, which is
 * reserved for GENUINE ABSENCE. launcherHealth/diagnoseLauncher's body read carries the same
 * exposure.
 *
 * Both therefore go through the hardened capped O_NOFOLLOW reader, and every unsafe state is
 * propagated as a REFUSAL. Each row proves three things: the refusal happens, the OUTSIDE CANARY
 * is untouched (bytes AND mode), and the unsafe content never reaches the output.
 */

const posix = process.platform !== 'win32';
const SECRET = 'SECRET-OUTSIDE-CONTENT-must-never-be-read';

/** Capture stdout without leaking it into the vitest reporter. */
function captureStdout(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  return { text: () => chunks.join(''), restore: () => spy.mockRestore() };
}

describe.skipIf(!posix)(
  'safety: dry-run launcher inspection refuses hostile launcher paths',
  () => {
    let home: FakeHome;
    let external: string;
    let userHome: string;
    let previousHome: string | undefined;

    beforeEach(() => {
      home = createFakeHome();
      // realpath: the probe trees must be canonical (macOS reaches /var through a symlink) so the
      // assertions compare the same paths production derives.
      external = runTempDir('sthayi-ext-');
      userHome = runTempDir('sthayi-userhome-');
      // Point client DETECTION at a throwaway HOME: these probes must never read the real user's
      // client configs, and an empty HOME keeps the plan deterministic.
      previousHome = process.env.HOME;
      process.env.HOME = userHome;
    });

    afterEach(() => {
      vi.restoreAllMocks();
      if (previousHome === undefined) {
        // biome-ignore lint/performance/noDelete: unsetting an env var; assigning undefined coerces to "undefined".
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      // Identity-aware, not recursive-by-name: this is teardown, and teardown removes the
      // allocations whose device/inodes `runTempDir()` recorded, one entry at a time.
      removeOwned(external);
      removeOwned(userHome);
      home.cleanup();
    });

    function mcpTarget(): string {
      return home.path('bin', 'sthayi-mcp');
    }
    function cliTarget(): string {
      return home.path('bin', 'sthayi');
    }
    function mkBin(): void {
      fs.mkdirSync(home.path('bin'), { recursive: true });
    }
    /** The exact bytes `sthayi wire` would write — what a naive content comparison calls healthy. */
    function expectedBody(variant: 'mcp' | 'cli'): string {
      return renderLauncher(variant === 'cli' ? { variant: 'cli' } : {}).content;
    }
    /** An outside canary file: bytes + mode are snapshotted for the after-assertions. */
    function plantCanary(name: string, content: string, mode = 0o644) {
      const p = path.join(external, name);
      fs.writeFileSync(p, content);
      fs.chmodSync(p, mode);
      return {
        path: p,
        bytes: fs.readFileSync(p),
        mode: fs.statSync(p).mode & 0o777,
        assertIntact(): void {
          expect(fs.readFileSync(p).equals(this.bytes)).toBe(true);
          expect(fs.statSync(p).mode & 0o777).toBe(this.mode);
        },
      };
    }

    it('BYTE-IDENTICAL outside symlink target: init --dry-run REFUSES instead of reporting unchanged', () => {
      // The nastiest shape: the link target holds exactly the bytes `wire` would write, so a
      // content comparison sees "already correct" and the hijack is rendered as health.
      const canary = plantCanary('identical-launcher', expectedBody('mcp'), 0o644);
      mkBin();
      fs.symlinkSync(canary.path, mcpTarget());
      const before = snapshotTree(external);

      expect(() => planInit()).toThrow(/symlink/i);
      canary.assertIntact();
      expect(snapshotTree(external)).toEqual(before);
      expect(fs.lstatSync(mcpTarget()).isSymbolicLink()).toBe(true);
      expect(fs.readdirSync(home.path('bin'))).toEqual(['sthayi-mcp']); // nothing written
    });

    it('BYTE-IDENTICAL outside symlink target at the CLI launcher is refused too', () => {
      const canary = plantCanary('identical-cli-launcher', expectedBody('cli'), 0o644);
      mkBin();
      fs.symlinkSync(canary.path, cliTarget());

      expect(() => planInit()).toThrow(/symlink/i);
      canary.assertIntact();
      expect(fs.readdirSync(home.path('bin'))).toEqual(['sthayi']);
    });

    it('wire --dry-run over a byte-identical symlink: refuses, prints nothing, writes nothing', () => {
      const canary = plantCanary('identical-launcher', expectedBody('mcp'), 0o644);
      mkBin();
      fs.symlinkSync(canary.path, mcpTarget());
      const beforeExternal = snapshotTree(external);
      const beforeHome = fs.readdirSync(home.path('bin'));

      const cap = captureStdout();
      let message = '';
      try {
        runWire({ dryRun: true });
        throw new Error('runWire --dry-run did not refuse');
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      } finally {
        cap.restore();
      }
      expect(message).toMatch(/symlink/i);
      expect(cap.text()).not.toMatch(/unchanged/);
      expect(snapshotTree(external)).toEqual(beforeExternal);
      expect(fs.readdirSync(home.path('bin'))).toEqual(beforeHome);
    });

    it('symlink to outside CONTENT: refused, and the outside bytes never appear in the message', () => {
      const canary = plantCanary('secret', `${SECRET}\n`, 0o600);
      mkBin();
      fs.symlinkSync(canary.path, mcpTarget());

      let message = '';
      try {
        planInit();
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toMatch(/symlink/i);
      expect(message).not.toContain(SECRET);
      canary.assertIntact();
    });

    it('hard link to an outside file: refused; the link target is byte- and mode-identical', () => {
      const canary = plantCanary('hardlink-victim', `${SECRET}\n`, 0o644);
      mkBin();
      fs.linkSync(canary.path, mcpTarget());

      let message = '';
      try {
        planInit();
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toMatch(/hard link/i);
      expect(message).not.toContain(SECRET);
      canary.assertIntact();
      expect(fs.lstatSync(canary.path).nlink).toBe(2);
    });

    it('a directory at the launcher path is refused, not treated as absent', () => {
      fs.mkdirSync(mcpTarget(), { recursive: true });
      fs.writeFileSync(path.join(mcpTarget(), 'keep.txt'), 'keep');

      expect(() => planInit()).toThrow(/not a regular file/i);
      expect(fs.readFileSync(path.join(mcpTarget(), 'keep.txt'), 'utf8')).toBe('keep');
    });

    it('an OVERSIZE launcher is refused by the cap, and its bytes are never echoed', () => {
      mkBin();
      fs.writeFileSync(mcpTarget(), `${SECRET}\n`.repeat(6000), { mode: 0o755 });
      const size = fs.statSync(mcpTarget()).size;
      expect(size).toBeGreaterThan(64 * 1024);

      let message = '';
      try {
        planInit();
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toMatch(/cap/i);
      expect(message).not.toContain(SECRET);
      expect(fs.statSync(mcpTarget()).size).toBe(size);
    });

    it('lstat→read SWAP: a symlink that lstats as a clean regular file is refused at the descriptor', () => {
      // The lstat gate is a path check; only O_NOFOLLOW on the descriptor itself can refuse a path
      // that was swapped after it. Simulated by making lstat LIE about the launcher path while the
      // real entry is a symlink pointing outside.
      const canary = plantCanary('swap-victim', `${SECRET}\n`, 0o644);
      mkBin();
      const decoy = home.path('bin', 'decoy');
      fs.writeFileSync(decoy, 'clean', { mode: 0o755 });
      const cleanStat = fs.lstatSync(decoy);
      fs.symlinkSync(canary.path, mcpTarget());

      const realLstat = fs.lstatSync.bind(fs);
      vi.spyOn(fs, 'lstatSync').mockImplementation(((p: fs.PathLike, opts?: unknown) =>
        String(p) === mcpTarget()
          ? cleanStat
          : realLstat(p, opts as never)) as typeof fs.lstatSync);

      let message = '';
      try {
        planInit();
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      vi.restoreAllMocks();
      expect(message).toMatch(/symlink/i);
      expect(message).not.toContain(SECRET);
      canary.assertIntact();
    });

    it('a GENUINELY ABSENT launcher is still the only path to the "create" outcome', () => {
      expect(planInit().launcher.action).toBe('create');
      expect(fs.existsSync(home.path('bin'))).toBe(false);
    });
  },
);

describe.skipIf(!posix)('safety: launcherHealth reads the launcher body descriptor-safely', () => {
  let home: FakeHome;
  let external: string;

  beforeEach(() => {
    home = createFakeHome();
    external = runTempDir('sthayi-ext-health-');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    removeOwned(external); // teardown: the recorded allocation, never a pathname walk
    home.cleanup();
  });

  it('an OVERSIZE launcher body is refused, not slurped, and never echoed', () => {
    fs.mkdirSync(home.path('bin'), { recursive: true });
    fs.writeFileSync(home.path('bin', 'sthayi-mcp'), `${SECRET}\n`.repeat(6000), { mode: 0o755 });

    const h = launcherHealth();
    expect(h.ok).toBe(false);
    expect(h.detail).toMatch(/cap/i);
    expect(h.detail).not.toContain(SECRET);
  });

  it('lstat→read SWAP: a symlinked launcher that lstats clean is refused at the descriptor', () => {
    const victim = path.join(external, 'victim');
    fs.writeFileSync(victim, `${SECRET}\n`);
    fs.mkdirSync(home.path('bin'), { recursive: true });
    const decoy = home.path('bin', 'decoy');
    fs.writeFileSync(decoy, 'clean', { mode: 0o755 });
    const cleanStat = fs.lstatSync(decoy);
    const target = home.path('bin', 'sthayi-mcp');
    fs.symlinkSync(victim, target);

    const realLstat = fs.lstatSync.bind(fs);
    vi.spyOn(fs, 'lstatSync').mockImplementation(((p: fs.PathLike, opts?: unknown) =>
      String(p) === target ? cleanStat : realLstat(p, opts as never)) as typeof fs.lstatSync);
    const h = launcherHealth();
    vi.restoreAllMocks();

    expect(h).toMatchObject({ ok: false, state: 'unreadable' });
    expect(h.detail).toMatch(/symlink/i); // named as a hijack, not mis-diagnosed as stale wiring
    expect(h.detail).not.toContain(SECRET);
    expect(fs.readFileSync(victim, 'utf8')).toBe(`${SECRET}\n`);
  });
});
