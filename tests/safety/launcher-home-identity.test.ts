import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeLauncher } from '../../packages/cli/src/clients/launcher.js';
import { type FakeHome, createFakeHome } from '../helpers/fake-home.js';

/**
 * SAFETY: the launcher write acts inside the home that was ESTABLISHED, not inside whatever
 * directory answers to `STHAYI_HOME` by the time the write gets there.
 *
 * `writeLauncher` establishes the home first — that is the whole point of establishing it — and
 * `persistLauncher` then reached for `bin/` by PATHNAME: an absolute `mkdir`, an absolute `lstat`,
 * an absolute `realpath`. Every one of those resolves the home component again, inside the call.
 * So a home moved aside and replaced by ANOTHER REAL DIRECTORY at the same pathname passes each of
 * those tests on its own merits — it is a real, owner-owned directory, and `<home>/bin` under it
 * canonicalises to exactly the string the containment check expects — and both launchers were
 * created inside the replacement while `writeLauncher` RETURNED SUCCESS.
 *
 * A real directory rather than a symlink is the whole point: symlinks are already refused, so a
 * substitution that is refused for being a link proves nothing about identity. What separates the
 * replacement from the established home is device/inode and nothing else.
 *
 * Both rows below require ZERO WRITES INTO THE REPLACEMENT. Where the write proceeds it must
 * proceed in the established directory (moved aside, so it can still be named); where it cannot,
 * it must refuse.
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

describe.skipIf(!posix)('safety: the launcher write is bound to the established home', () => {
  let home: FakeHome;
  let substituted = false;

  /** Where the ESTABLISHED home is parked so assertions can still name it. */
  function asidePath(): string {
    return `${home.home}-established`;
  }

  /**
   * Move the established home aside and stand a DIFFERENT REAL DIRECTORY at its pathname. The
   * replacement passes every path-shaped test: real directory, not a link, correct owner, 0700.
   */
  function substituteHome(mkdir: typeof fs.mkdirSync): void {
    fs.renameSync(home.home, asidePath());
    mkdir(home.home, { mode: 0o700 });
    substituted = true;
  }

  /** Put the established home back before teardown: the harness pinned that inode, and a
   *  replacement standing at the name would be refused entry and leaked instead of cleaned.
   *
   *  ONE `rmdir`, never a recursive removal. Every row here asserts the replacement is empty, so a
   *  non-recursive removal is all that is ever needed — and where the assertion has already failed,
   *  the replacement is LEFT STANDING rather than deleted, which is the outcome that keeps the
   *  evidence of what the code wrote into it. */
  function restoreHome(): void {
    if (!substituted) {
      return;
    }
    try {
      fs.rmdirSync(home.home);
    } catch {
      return; // something is in it: leave both directories exactly as the test found them
    }
    fs.renameSync(asidePath(), home.home);
    substituted = false;
  }

  beforeEach(() => {
    home = createFakeHome();
    substituted = false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreHome();
    home.cleanup();
  });

  it('home replaced by another REAL directory at the bin mkdir: nothing is written into the replacement', () => {
    const realMkdir = fs.mkdirSync.bind(fs) as typeof fs.mkdirSync;
    let fired = false;
    vi.spyOn(fs, 'mkdirSync').mockImplementation(((p: fs.PathLike, o?: unknown) => {
      if (!fired && path.basename(String(p)) === 'bin') {
        fired = true;
        substituteHome(realMkdir);
      }
      return (realMkdir as (a: fs.PathLike, b?: unknown) => string | undefined)(p, o);
    }) as unknown as typeof fs.mkdirSync);

    let threw = false;
    try {
      writeLauncher();
    } catch {
      threw = true;
    }
    vi.restoreAllMocks();

    expect(fired).toBe(true);
    // NOTHING lands in the directory that merely wears the home's name.
    expect(listDeep(home.home)).toEqual([]);
    // Either the write refused outright, or it happened in the home that was established.
    if (!threw) {
      expect(fs.readFileSync(path.join(asidePath(), 'bin', 'sthayi-mcp'), 'utf8')).toContain(
        'serve',
      );
      expect(fs.existsSync(path.join(asidePath(), 'bin', 'sthayi'))).toBe(true);
    }
  });

  it('home replaced after it is bound and before the write: the write refuses', () => {
    // The other side of the seam: the home has been established AND its identity taken, and the
    // substitution lands while the plan is still being rendered — before a single byte is written.
    // Nothing downstream re-reads the home, so only the identity can catch this.
    const realRealpath = fs.realpathSync.bind(fs) as (...a: unknown[]) => string;
    const realMkdir = fs.mkdirSync.bind(fs) as typeof fs.mkdirSync;
    const argv1 = process.argv[1] as string;
    let fired = false;
    vi.spyOn(fs, 'realpathSync').mockImplementation(((...args: unknown[]) => {
      const result = realRealpath(...args);
      // renderLauncher canonicalises the CLI entry — squarely between the bind and the write
      if (!fired && String(args[0]) === argv1) {
        fired = true;
        substituteHome(realMkdir);
      }
      return result;
    }) as unknown as typeof fs.realpathSync);

    let message = '';
    try {
      writeLauncher();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    vi.restoreAllMocks();

    expect(fired).toBe(true);
    expect(message).toMatch(/no longer the directory that was validated/);
    expect(listDeep(home.home)).toEqual([]);
    expect(listDeep(asidePath())).toEqual([]);
  });
});
