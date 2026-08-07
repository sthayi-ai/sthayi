import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeLauncher } from '../../packages/cli/src/clients/launcher.js';
import { type FakeHome, createFakeHome } from '../helpers/fake-home.js';
import { removeOwned } from '../helpers/owned-fs.js';
import { runTempDir } from '../helpers/run-temp.js';

/**
 * SAFETY: the launcher write is bound to the bin DIRECTORY IT PROVED, not to the name `bin/`.
 *
 * `persistLauncher` proves `<home>/bin` resolves inside the canonical home — and then creates a
 * temp file, writes it, renames it over the target and cleans up after itself through that same
 * pathname, several syscalls later. Each of those calls resolves `bin/` again inside itself, so a
 * `bin/` swapped for a link after the containment check steers ALL of them: the generated launcher
 * is created and renamed OVER an outside file, and the failure path's temp cleanup deletes a
 * pre-existing outside file it never created.
 *
 * The fix is a real binding, not a tighter check. The proved directory is ENTERED once and the
 * acting syscalls are aimed by RELATIVE NAME, so what they act in is the directory the kernel is
 * holding rather than whatever the path leads to at that instant. Every row below substitutes the
 * bin directory at the precise moment before one of those syscalls and asserts the same two facts:
 * the outside tree is byte- and mode-identical afterwards, and the launcher landed in the very
 * directory that was proved.
 *
 * The substitution RENAMES the real bin directory aside rather than deleting it, so the assertions
 * can name the proved directory afterwards and show the write went there — a deletion would leave
 * "nothing happened" and "it happened in the right place" indistinguishable.
 */

const posix = process.platform !== 'win32';

/** Byte- AND mode-exact picture of a tree. */
function snapshotDeep(dir: string): string[] {
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
}

describe.skipIf(!posix)('safety: the launcher write is bound to the proved bin directory', () => {
  let home: FakeHome;
  let external: string;

  function binPath(): string {
    return home.path('bin');
  }
  function asidePath(): string {
    return home.path('bin-moved-aside');
  }

  /** The outside tree, including a file wearing the launcher's own name: the audited overwrite. */
  function plantExternal(): void {
    fs.writeFileSync(path.join(external, 'sthayi-mcp'), 'EXTERNAL MCP CANARY', { mode: 0o644 });
    fs.writeFileSync(path.join(external, 'loose.txt'), 'LOOSE CANARY');
    fs.chmodSync(path.join(external, 'loose.txt'), 0o640);
  }

  /** Substitute the ALREADY-PROVED bin directory: the real one is moved aside (so it can still be
   *  named in assertions) and its name is made to lead outside the home. */
  function substituteBin(): void {
    fs.renameSync(binPath(), asidePath());
    fs.symlinkSync(external, binPath());
  }

  beforeEach(() => {
    home = createFakeHome();
    external = runTempDir('sthayi-bin-ext-');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Identity-aware, not recursive-by-name: this is teardown, and teardown removes the
    // allocation whose device/inode `runTempDir()` recorded, one entry at a time.
    removeOwned(external);
    home.cleanup();
  });

  it('bin substituted immediately BEFORE the exclusive create: nothing outside is created or overwritten', () => {
    plantExternal();
    const before = snapshotDeep(external);

    const realOpen = fs.openSync.bind(fs) as (...a: unknown[]) => number;
    let fired = false;
    vi.spyOn(fs, 'openSync').mockImplementation(((...args: unknown[]) => {
      const p = String(args[0]);
      if (!fired && p.includes('.sthayi-mcp.') && p.endsWith('.tmp')) {
        fired = true;
        substituteBin();
      }
      return realOpen(...args);
    }) as unknown as typeof fs.openSync);

    // the CLI-variant write that follows re-derives bin/ and finds the planted link
    expect(() => writeLauncher()).toThrow(/resolves to/);
    vi.restoreAllMocks();

    expect(fired).toBe(true);
    // the outside tree is byte- and mode-identical: nothing was created there, nothing overwritten
    expect(snapshotDeep(external)).toEqual(before);
    expect(fs.readFileSync(path.join(external, 'sthayi-mcp'), 'utf8')).toBe('EXTERNAL MCP CANARY');
    // …and the launcher landed in the directory that was PROVED, wherever its name now leads
    const landed = path.join(asidePath(), 'sthayi-mcp');
    expect(fs.readFileSync(landed, 'utf8')).toContain('serve');
    expect(fs.statSync(landed).mode & 0o777).toBe(0o755);
  });

  it('bin substituted immediately BEFORE the rename: the launcher lands in the proved directory', () => {
    plantExternal();
    const before = snapshotDeep(external);

    const realRename = fs.renameSync.bind(fs);
    let fired = false;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (!fired && path.basename(String(to)) === 'sthayi-mcp') {
        fired = true;
        substituteBin();
      }
      return realRename(from, to);
    });

    expect(() => writeLauncher()).toThrow(/resolves to/);
    vi.restoreAllMocks();

    expect(fired).toBe(true);
    expect(snapshotDeep(external)).toEqual(before);
    const landed = path.join(asidePath(), 'sthayi-mcp');
    expect(fs.readFileSync(landed, 'utf8')).toContain('serve');
    // no temp debris left standing in the proved directory
    expect(fs.readdirSync(asidePath()).filter((e) => e.endsWith('.tmp'))).toEqual([]);
  });

  it('a FAILED exclusive create never unlinks the pathname it did not create', () => {
    // A fixed temp name is what makes "the cleanup removed a file this invocation did not create"
    // observable at all: the name is random by design, so it has to be pinned to be planted at.
    vi.spyOn(crypto, 'randomBytes').mockImplementation(((n: number) =>
      Buffer.alloc(n, 0xab)) as unknown as typeof crypto.randomBytes);
    const squatted = `.sthayi-mcp.${'ab'.repeat(6)}.tmp`;
    fs.mkdirSync(binPath(), { recursive: true });
    fs.writeFileSync(path.join(binPath(), squatted), 'PRE-EXISTING DEBRIS, NOT OURS');
    fs.writeFileSync(path.join(external, squatted), 'PRE-EXISTING OUTSIDE FILE');
    const before = snapshotDeep(external);

    const removals: string[] = [];
    const realUnlink = fs.unlinkSync.bind(fs);
    const realRm = fs.rmSync.bind(fs);
    vi.spyOn(fs, 'unlinkSync').mockImplementation((p) => {
      removals.push(String(p));
      return realUnlink(p);
    });
    vi.spyOn(fs, 'rmSync').mockImplementation((p, o) => {
      removals.push(String(p));
      return realRm(p, o);
    });

    expect(() => writeLauncher()).toThrow(/EEXIST/);
    vi.restoreAllMocks();

    // the exclusive create FAILED, so this invocation created nothing — and removed nothing
    expect(removals.filter((r) => r.includes(squatted))).toEqual([]);
    expect(fs.readFileSync(path.join(binPath(), squatted), 'utf8')).toBe(
      'PRE-EXISTING DEBRIS, NOT OURS',
    );
    expect(snapshotDeep(external)).toEqual(before);
  });

  it('cleanup after a PARTIAL write removes only this invocation’s temp, in the proved directory', () => {
    vi.spyOn(crypto, 'randomBytes').mockImplementation(((n: number) =>
      Buffer.alloc(n, 0xcd)) as unknown as typeof crypto.randomBytes);
    const ours = `.sthayi-mcp.${'cd'.repeat(6)}.tmp`;
    plantExternal();
    // an identically-named decoy outside: the cleanup must not be steerable onto it
    fs.writeFileSync(path.join(external, ours), 'OUTSIDE DECOY TEMP');
    const before = snapshotDeep(external);

    const realWrite = fs.writeSync.bind(fs) as (...a: unknown[]) => number;
    const realUnlink = fs.unlinkSync.bind(fs);
    let fired = false;
    let launcherFd: number | undefined;
    let liveDuringCleanup = false;
    vi.spyOn(fs, 'writeSync').mockImplementation(((...args: unknown[]) => {
      // matched on the LAUNCHER BODY, not on "the first write this process makes": the reporter
      // writing to stdout goes through fs.writeSync too, and a seam that a log line can consume is
      // a seam that fires somewhere else on a quiet day
      if (!fired && typeof args[1] === 'string' && args[1].includes('sthayi launcher')) {
        fired = true;
        launcherFd = args[0] as number;
        // the bytes are half-written and the directory's name is made to lead outside, right
        // before the failure path reaches for its own temp file
        substituteBin();
        throw new Error('probe: the launcher write failed mid-flight');
      }
      return realWrite(...args);
    }) as unknown as typeof fs.writeSync);
    vi.spyOn(fs, 'unlinkSync').mockImplementation((p) => {
      if (String(p) === ours) {
        try {
          fs.fstatSync(launcherFd as number);
          liveDuringCleanup = true;
        } catch {
          liveDuringCleanup = false;
        }
      }
      return realUnlink(p);
    });

    expect(() => writeLauncher()).toThrow(/probe: the launcher write failed mid-flight/);
    vi.restoreAllMocks();

    expect(fired).toBe(true);
    expect(liveDuringCleanup).toBe(true);
    // Cleanup is authorised while the pin is live, but the transaction never leaks that pin.
    expect(launcherFd).toBeTypeOf('number');
    expect(() => fs.fstatSync(launcherFd as number)).toThrow();
    // the outside decoy — and everything else outside — is untouched
    expect(snapshotDeep(external)).toEqual(before);
    // our own temp is gone from the directory that was proved: no debris, no launcher
    expect(fs.readdirSync(asidePath())).toEqual([]);
  });

  it('where the directory cannot be BOUND at all, the write refuses instead of acting blind', () => {
    // A worker thread has no process.chdir, and there is no other portable way to hold a directory
    // — Node exposes no openat/unlinkat family. So the honest outcome is a refusal: acting anyway
    // would mean writing and cleaning up on the strength of a pathname, which is the whole defect.
    plantExternal();
    const before = snapshotDeep(external);
    fs.mkdirSync(binPath(), { recursive: true });

    const real = process.chdir;
    (process as { chdir?: typeof process.chdir }).chdir = undefined;
    try {
      expect(() => writeLauncher()).toThrow(/no process\.chdir/);
    } finally {
      process.chdir = real;
    }

    // nothing created, nothing removed, nothing outside touched
    expect(fs.readdirSync(binPath())).toEqual([]);
    expect(snapshotDeep(external)).toEqual(before);
  });

  // ---------------------------------------------------------------------------------------------
  // THE DIRECTORY'S IDENTITY, AND THE TEMP FILE'S — proved to be the SAME subject the checks named.
  // ---------------------------------------------------------------------------------------------

  /** Substitute the bin directory with a DIFFERENT REAL DIRECTORY at the same canonical path: it
   *  passes every path-shaped test there is — real directory, not a link, resolves inside the home
   *  — so only device/inode separates it from the one that was proved. */
  function substituteBinReal(): void {
    fs.renameSync(binPath(), asidePath());
    fs.mkdirSync(binPath(), { mode: 0o700 });
  }

  it('bin replaced by a REAL directory between the containment proof and the identity capture', () => {
    plantExternal();
    fs.mkdirSync(binPath(), { recursive: true });

    let fired = false;
    const realRealpath = fs.realpathSync.bind(fs) as (...a: unknown[]) => string;
    vi.spyOn(fs, 'realpathSync').mockImplementation(((...args: unknown[]) => {
      const result = realRealpath(...args);
      if (!fired && String(args[0]) === binPath()) {
        fired = true;
        substituteBinReal();
      }
      return result;
    }) as unknown as typeof fs.realpathSync);

    let threw = false;
    try {
      writeLauncher();
    } catch {
      threw = true;
    }
    vi.restoreAllMocks();

    expect(fired).toBe(true);
    // The substitute is not the directory anything was proved about, so nothing is written into it.
    expect(fs.readdirSync(binPath())).toEqual([]);
    expect(fs.readdirSync(asidePath())).toEqual([]);
    expect(threw).toBe(true);
  });

  /** A file THIS INVOCATION DID NOT CREATE, standing at the temp name after the exclusive create
   *  returned. Distinct bytes and a distinct mode, so publication or removal is unmistakable. */
  const FOREIGN_TEMP = 'FOREIGN TEMP — this inode was never created by this invocation\n';

  /** Pin the temp name: it is random by design, so it has to be fixed to be planted at. */
  function pinnedTempName(): string {
    vi.spyOn(crypto, 'randomBytes').mockImplementation(((n: number) =>
      Buffer.alloc(n, 0xef)) as unknown as typeof crypto.randomBytes);
    return `.sthayi-mcp.${'ef'.repeat(6)}.tmp`;
  }

  /** Replace the temp file with a foreign inode wearing the same name. */
  function substituteTemp(name: string): void {
    fs.unlinkSync(path.join(binPath(), name));
    fs.writeFileSync(path.join(binPath(), name), FOREIGN_TEMP, { mode: 0o600 });
  }

  it('the temp descriptor stays live through rename and published-name verification', () => {
    const tmpName = pinnedTempName();
    fs.mkdirSync(binPath(), { recursive: true });

    let tempFd: number | undefined;
    let liveAtRename = false;
    let liveAtPublishedCheck = false;
    let mcpRenamed = false;
    const realOpen = fs.openSync.bind(fs) as (...a: unknown[]) => number;
    const realRename = fs.renameSync.bind(fs);
    const realLstat = fs.lstatSync.bind(fs) as typeof fs.lstatSync;
    vi.spyOn(fs, 'openSync').mockImplementation(((...args: unknown[]) => {
      const opened = realOpen(...args);
      if (String(args[0]) === tmpName) {
        tempFd = opened;
      }
      return opened;
    }) as unknown as typeof fs.openSync);
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from) === tmpName && String(to) === 'sthayi-mcp') {
        try {
          fs.fstatSync(tempFd as number);
          liveAtRename = true;
        } catch {
          liveAtRename = false;
        }
        const result = realRename(from, to);
        mcpRenamed = true;
        return result;
      }
      return realRename(from, to);
    });
    vi.spyOn(fs, 'lstatSync').mockImplementation(((p: fs.PathLike, o?: unknown) => {
      if (mcpRenamed && String(p) === 'sthayi-mcp') {
        try {
          fs.fstatSync(tempFd as number);
          liveAtPublishedCheck = true;
        } catch {
          liveAtPublishedCheck = false;
        }
      }
      return (realLstat as (a: fs.PathLike, b?: unknown) => fs.Stats)(p, o);
    }) as unknown as typeof fs.lstatSync);

    writeLauncher();
    vi.restoreAllMocks();

    expect(tempFd).toBeTypeOf('number');
    expect(liveAtRename).toBe(true);
    expect(liveAtPublishedCheck).toBe(true);
    // The pin lasts only for the publication transaction, not for the launcher file's lifetime.
    expect(() => fs.fstatSync(tempFd as number)).toThrow();
  });

  it('POSIX identity remains exact above Number.MAX_SAFE_INTEGER and closes on refusal', () => {
    const tmpName = pinnedTempName();
    fs.mkdirSync(binPath(), { recursive: true });

    const first = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    const adjacent = first + 1n;
    // These are distinct kernel identities but the legacy number conversion collapses them.
    expect(first).not.toBe(adjacent);
    expect(Number(first)).toBe(Number(adjacent));

    let tempFd: number | undefined;
    let exactFdReads = 0;
    let exactNameReads = 0;
    let numericFdReads = 0;
    let numericNameReads = 0;
    const realOpen = fs.openSync.bind(fs) as (...a: unknown[]) => number;
    const realFstat = fs.fstatSync.bind(fs) as (...a: unknown[]) => fs.Stats | fs.BigIntStats;
    const realLstat = fs.lstatSync.bind(fs) as (...a: unknown[]) => fs.Stats | fs.BigIntStats;
    const withIdentity = (
      st: fs.Stats | fs.BigIntStats,
      dev: number | bigint,
      ino: number | bigint,
    ): fs.Stats | fs.BigIntStats =>
      new Proxy(st, {
        get(target, property, receiver) {
          if (property === 'dev') {
            return dev;
          }
          if (property === 'ino') {
            return ino;
          }
          return Reflect.get(target, property, receiver);
        },
      });
    const exactRequested = (options: unknown): boolean =>
      typeof options === 'object' &&
      options !== null &&
      'bigint' in options &&
      (options as { bigint?: unknown }).bigint === true;

    vi.spyOn(fs, 'openSync').mockImplementation(((...args: unknown[]) => {
      const opened = realOpen(...args);
      if (String(args[0]) === tmpName) {
        tempFd = opened;
      }
      return opened;
    }) as unknown as typeof fs.openSync);
    vi.spyOn(fs, 'fstatSync').mockImplementation(((...args: unknown[]) => {
      const st = realFstat(...args);
      if (args[0] !== tempFd) {
        return st;
      }
      if (exactRequested(args[1])) {
        exactFdReads += 1;
        return withIdentity(st, first, first);
      }
      numericFdReads += 1;
      return withIdentity(st, Number(first), Number(first));
    }) as unknown as typeof fs.fstatSync);
    vi.spyOn(fs, 'lstatSync').mockImplementation(((...args: unknown[]) => {
      const st = realLstat(...args);
      if (String(args[0]) !== tmpName) {
        return st;
      }
      if (exactRequested(args[1])) {
        exactNameReads += 1;
        return withIdentity(st, first, adjacent);
      }
      numericNameReads += 1;
      return withIdentity(st, Number(first), Number(adjacent));
    }) as unknown as typeof fs.lstatSync);

    expect(() => writeLauncher()).toThrow(/no longer the file this run created/);
    vi.restoreAllMocks();

    expect(exactFdReads).toBeGreaterThan(0);
    expect(exactNameReads).toBeGreaterThan(0);
    expect(numericFdReads).toBe(0);
    expect(numericNameReads).toBe(0);
    expect(tempFd).toBeTypeOf('number');
    // A refusal leaves the mismatched name standing, but never leaks the descriptor that pinned it.
    expect(fs.existsSync(path.join(binPath(), tmpName))).toBe(true);
    expect(fs.existsSync(path.join(binPath(), 'sthayi-mcp'))).toBe(false);
    expect(() => fs.fstatSync(tempFd as number)).toThrow();
  });

  it('the temp replaced before the error cleanup is never UNLINKED', () => {
    const tmpName = pinnedTempName();
    fs.mkdirSync(binPath(), { recursive: true });

    let fired = false;
    const realWrite = fs.writeSync.bind(fs) as (...a: unknown[]) => number;
    vi.spyOn(fs, 'writeSync').mockImplementation(((...args: unknown[]) => {
      if (!fired && typeof args[1] === 'string' && args[1].includes('sthayi launcher')) {
        fired = true;
        // the temp this run created is swapped out, and the write then fails: the failure path
        // reaches for "its own" temp with a foreign inode standing at the name
        substituteTemp(tmpName);
        throw new Error('probe: the launcher write failed mid-flight');
      }
      return realWrite(...args);
    }) as unknown as typeof fs.writeSync);

    expect(() => writeLauncher()).toThrow(/probe: the launcher write failed mid-flight/);
    vi.restoreAllMocks();

    expect(fired).toBe(true);
    const left = path.join(binPath(), tmpName);
    expect(fs.readFileSync(left, 'utf8')).toBe(FOREIGN_TEMP);
    expect(fs.statSync(left).mode & 0o777).toBe(0o600);
  });
});
