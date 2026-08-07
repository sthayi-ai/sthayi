import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runTempDir } from '../../../tests/helpers/run-temp.js';
import {
  DEFAULT_READ_CAP_BYTES,
  PRIVATE_READ_CAP_BYTES,
  assertTrustedContainingDirReadOnly,
  assertTrustedDirReadOnly,
  ensureTrustedContainingDir,
  establishTrustedDir,
  safeReadTextFile,
  safeWriteFileAtomic,
} from './fs-safe.js';

const posix = process.platform !== 'win32';

describe('fs-safe', () => {
  let base: string;
  beforeEach(() => {
    // realpath: os.tmpdir() is itself reached through a symlink on macOS (/var -> private/var),
    // and trust boundaries are keyed by CANONICAL path. A canonical base keeps the assertions
    // byte-exact; the hostile cases below plant their own symlinks explicitly.
    base = runTempDir('sthayi-fssafe-');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(base, { recursive: true, force: true });
  });

  describe('safeReadTextFile byte caps (descriptor-level: fstat fast-fail + capped read)', () => {
    it('a file at EXACTLY the limit is accepted byte-exact', () => {
      const p = path.join(base, 'exact.txt');
      const content = 'x'.repeat(16);
      fs.writeFileSync(p, content);
      expect(safeReadTextFile(p, 'probe', { maxBytes: 16 })).toBe(content);
    });

    it('limit+1 is refused via the fstat size fast-fail', () => {
      const p = path.join(base, 'over.txt');
      fs.writeFileSync(p, 'x'.repeat(17));
      expect(() => safeReadTextFile(p, 'probe', { maxBytes: 16 })).toThrow(/16-byte cap/);
    });

    it('growth AFTER the fstat is refused by the capped read loop (+1 sentinel)', () => {
      // The fstat under-reports (as if the file grew right after it) — the read loop itself
      // must still refuse at limit+1 instead of trusting the stat.
      const p = path.join(base, 'growing.txt');
      fs.writeFileSync(p, 'x'.repeat(17));
      const realFstat = fs.fstatSync.bind(fs);
      vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number) => {
        const st = realFstat(fd);
        Object.defineProperty(st, 'size', { value: 16 });
        return st;
      }) as typeof fs.fstatSync);
      expect(() => safeReadTextFile(p, 'probe', { maxBytes: 16 })).toThrow(/grew while being read/);
    });

    it(`modePolicy 'private' defaults to the ${PRIVATE_READ_CAP_BYTES}-byte secret cap (token file)`, () => {
      const ok = path.join(base, 'token-exact');
      fs.writeFileSync(ok, 'x'.repeat(PRIVATE_READ_CAP_BYTES), { mode: 0o600 });
      expect(safeReadTextFile(ok, 'HTTP token file', { modePolicy: 'private' })).toHaveLength(
        PRIVATE_READ_CAP_BYTES,
      );
      const over = path.join(base, 'token-over');
      fs.writeFileSync(over, 'x'.repeat(PRIVATE_READ_CAP_BYTES + 1), { mode: 0o600 });
      expect(() => safeReadTextFile(over, 'HTTP token file', { modePolicy: 'private' })).toThrow(
        new RegExp(`${PRIVATE_READ_CAP_BYTES}-byte cap`),
      );
    });

    it(`the default cap is ${DEFAULT_READ_CAP_BYTES} bytes (client wiring ledger)`, () => {
      const ok = path.join(base, 'state-exact.json');
      fs.writeFileSync(ok, 'x'.repeat(DEFAULT_READ_CAP_BYTES), { mode: 0o600 });
      expect(safeReadTextFile(ok, 'client wiring ledger')).toHaveLength(DEFAULT_READ_CAP_BYTES);
      const over = path.join(base, 'state-over.json');
      fs.writeFileSync(over, 'x'.repeat(DEFAULT_READ_CAP_BYTES + 1), { mode: 0o600 });
      expect(() => safeReadTextFile(over, 'client wiring ledger')).toThrow(
        new RegExp(`${DEFAULT_READ_CAP_BYTES}-byte cap`),
      );
    });
  });

  describe.skipIf(!posix)('safeReadTextFile parent chain', () => {
    it('a symlinked parent directory is refused — the read never travels through it', () => {
      const realDir = path.join(base, 'real-dir');
      fs.mkdirSync(realDir);
      fs.writeFileSync(path.join(realDir, 'f.txt'), 'secret');
      const linked = path.join(base, 'linked-dir');
      fs.symlinkSync(realDir, linked, 'dir');
      expect(() => safeReadTextFile(path.join(linked, 'f.txt'), 'probe')).toThrow(
        /parent directory .* symlink/,
      );
    });

    it('an absent parent directory reads as absent (undefined), not an error', () => {
      expect(safeReadTextFile(path.join(base, 'no-dir', 'f.txt'), 'probe')).toBeUndefined();
    });
  });

  describe('establishTrustedDir', () => {
    it('creates missing components one level at a time and returns the realpath', () => {
      const target = path.join(base, 'boundary', 'nested');
      const real = establishTrustedDir(target, 'probe dir');
      expect(fs.realpathSync(target)).toBe(real);
      if (posix) {
        expect(fs.lstatSync(target).mode & 0o777).toBe(0o700);
        expect(fs.lstatSync(path.dirname(target)).mode & 0o777).toBe(0o700);
      }
    });

    it.skipIf(!posix)('tightens a loose-but-safe existing dir to the requested mode', () => {
      const dir = path.join(base, 'loose');
      fs.mkdirSync(dir, { mode: 0o755 });
      fs.chmodSync(dir, 0o755);
      establishTrustedDir(dir, 'probe dir');
      expect(fs.lstatSync(dir).mode & 0o777).toBe(0o700);
    });

    it.skipIf(!posix)(
      'retains the boundary descriptor and re-fstats that same live pin on every later use',
      () => {
        const dir = path.join(base, 'pinned');
        fs.mkdirSync(dir, { mode: 0o700 });
        const realOpen = fs.openSync.bind(fs);
        const realFstat = fs.fstatSync.bind(fs);
        let boundaryFd: number | undefined;
        const fstatCalls: number[] = [];

        vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, flags: number) => {
          const fd = realOpen(p, flags);
          if (String(p) === dir && (flags & fs.constants.O_DIRECTORY) !== 0) {
            boundaryFd = fd;
          }
          return fd;
        }) as typeof fs.openSync);
        vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number, opts?: { bigint?: boolean }) => {
          fstatCalls.push(fd);
          return opts?.bigint === true ? realFstat(fd, { bigint: true }) : realFstat(fd);
        }) as typeof fs.fstatSync);

        expect(establishTrustedDir(dir, 'probe dir')).toBe(dir);
        expect(boundaryFd).toBeTypeOf('number');
        const fd = boundaryFd as number;
        const establishmentFstats = fstatCalls.filter((candidate) => candidate === fd).length;
        expect(establishmentFstats).toBeGreaterThan(0);
        expect(() => realFstat(fd, { bigint: true })).not.toThrow();

        safeWriteFileAtomic(path.join(dir, 'later.txt'), 'still pinned\n');
        expect(fstatCalls.filter((candidate) => candidate === fd).length).toBeGreaterThan(
          establishmentFstats,
        );
        expect(() => realFstat(fd, { bigint: true })).not.toThrow();
        expect(fs.readFileSync(path.join(dir, 'later.txt'), 'utf8')).toBe('still pinned\n');
      },
    );

    it.skipIf(!posix)('fails closed when the retained boundary descriptor is lost', () => {
      const dir = path.join(base, 'lost-pin');
      fs.mkdirSync(dir, { mode: 0o700 });
      const realOpen = fs.openSync.bind(fs);
      let boundaryFd: number | undefined;
      vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, flags: number) => {
        const fd = realOpen(p, flags);
        if (String(p) === dir && (flags & fs.constants.O_DIRECTORY) !== 0) {
          boundaryFd = fd;
        }
        return fd;
      }) as typeof fs.openSync);

      establishTrustedDir(dir, 'probe dir');
      vi.restoreAllMocks();
      expect(boundaryFd).toBeTypeOf('number');
      fs.closeSync(boundaryFd as number);

      expect(() => safeWriteFileAtomic(path.join(dir, 'never.txt'), 'no\n')).toThrow(
        /could not re-inspect the open descriptor/,
      );
      expect(() => establishTrustedDir(dir, 'probe dir')).toThrow(
        /could not re-inspect the open descriptor/,
      );
      expect(fs.existsSync(path.join(dir, 'never.txt'))).toBe(false);
    });

    it.skipIf(!posix)('fails closed when a later fstat of the retained pin errors', () => {
      const dir = path.join(base, 'errored-pin');
      fs.mkdirSync(dir, { mode: 0o700 });
      const realOpen = fs.openSync.bind(fs);
      let boundaryFd: number | undefined;
      vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, flags: number) => {
        const fd = realOpen(p, flags);
        if (String(p) === dir && (flags & fs.constants.O_DIRECTORY) !== 0) {
          boundaryFd = fd;
        }
        return fd;
      }) as typeof fs.openSync);
      establishTrustedDir(dir, 'probe dir');
      vi.restoreAllMocks();

      const realFstat = fs.fstatSync.bind(fs);
      vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number, opts?: { bigint?: boolean }) => {
        if (fd === boundaryFd) {
          throw Object.assign(new Error('synthetic retained-fd failure'), { code: 'EIO' });
        }
        return opts?.bigint === true ? realFstat(fd, { bigint: true }) : realFstat(fd);
      }) as typeof fs.fstatSync);

      expect(() => safeWriteFileAtomic(path.join(dir, 'never.txt'), 'no\n')).toThrow(
        /could not re-inspect the open descriptor.*EIO/,
      );
      expect(fs.existsSync(path.join(dir, 'never.txt'))).toBe(false);
    });

    it.skipIf(!posix)(
      'compares BigInt identities exactly when distinct inodes collide as unsafe Numbers',
      () => {
        const dir = path.join(base, 'bigint-identity');
        fs.mkdirSync(dir, { mode: 0o700 });
        const first = 9_007_199_254_740_992n;
        const replacement = first + 1n;
        expect(Number(first)).toBe(Number(replacement)); // the unsafe Number comparison collides

        const realOpen = fs.openSync.bind(fs);
        const realLstat = fs.lstatSync.bind(fs);
        const realFstat = fs.fstatSync.bind(fs);
        let boundaryFd: number | undefined;
        let pathnameWasReplaced = false;
        vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, flags: number) => {
          const fd = realOpen(p, flags);
          if (String(p) === dir && (flags & fs.constants.O_DIRECTORY) !== 0) {
            boundaryFd = fd;
          }
          return fd;
        }) as typeof fs.openSync);
        vi.spyOn(fs, 'lstatSync').mockImplementation(((
          p: fs.PathLike,
          opts?: { bigint?: boolean },
        ) => {
          const st = opts?.bigint === true ? realLstat(p, { bigint: true }) : realLstat(p);
          if (String(p) === dir && opts?.bigint === true) {
            Object.defineProperty(st, 'ino', {
              value: pathnameWasReplaced ? replacement : first,
            });
          }
          return st;
        }) as typeof fs.lstatSync);
        vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number, opts?: { bigint?: boolean }) => {
          const st = opts?.bigint === true ? realFstat(fd, { bigint: true }) : realFstat(fd);
          if (fd === boundaryFd && opts?.bigint === true) {
            Object.defineProperty(st, 'ino', { value: first });
          }
          return st;
        }) as typeof fs.fstatSync);

        establishTrustedDir(dir, 'probe dir');
        pathnameWasReplaced = true;
        expect(() => safeWriteFileAtomic(path.join(dir, 'never.txt'), 'no\n')).toThrow(
          /no longer the directory that was validated/,
        );
        expect(fs.existsSync(path.join(dir, 'never.txt'))).toBe(false);
      },
    );

    it.skipIf(!posix)('closes the raw directory fd when the first fstat throws', () => {
      const dir = path.join(base, 'initial-fstat-error');
      fs.mkdirSync(dir, { mode: 0o700 });
      const realOpen = fs.openSync.bind(fs);
      const realFstat = fs.fstatSync.bind(fs);
      let openedFd: number | undefined;
      vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, flags: number) => {
        const fd = realOpen(p, flags);
        if (String(p) === dir && (flags & fs.constants.O_DIRECTORY) !== 0) {
          openedFd = fd;
        }
        return fd;
      }) as typeof fs.openSync);
      vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number, opts?: { bigint?: boolean }) => {
        if (fd === openedFd) {
          throw Object.assign(new Error('synthetic initial fstat failure'), { code: 'EIO' });
        }
        return opts?.bigint === true ? realFstat(fd, { bigint: true }) : realFstat(fd);
      }) as typeof fs.fstatSync);

      expect(() => establishTrustedDir(dir, 'probe dir')).toThrow(
        /synthetic initial fstat failure/,
      );
      expect(openedFd).toBeTypeOf('number');
      vi.restoreAllMocks();
      expect(() => fs.fstatSync(openedFd as number)).toThrow();
    });

    it.skipIf(!posix)('refuses a symlinked dir BEFORE any chmod (target mode preserved)', () => {
      const realDir = path.join(base, 'real-dir');
      fs.mkdirSync(realDir, { mode: 0o755 });
      fs.chmodSync(realDir, 0o755);
      const linked = path.join(base, 'linked-dir');
      fs.symlinkSync(realDir, linked, 'dir');
      expect(() => establishTrustedDir(linked, 'probe dir')).toThrow(/symlink/);
      expect(fs.lstatSync(realDir).mode & 0o777).toBe(0o755);
    });

    it.skipIf(!posix)('refuses a world-writable dir instead of repairing it', () => {
      const dir = path.join(base, 'ww');
      fs.mkdirSync(dir);
      fs.chmodSync(dir, 0o777);
      expect(() => establishTrustedDir(dir, 'probe dir')).toThrow(/world-writable/);
      expect(fs.lstatSync(dir).mode & 0o777).toBe(0o777);
    });

    it.skipIf(!posix)('refuses a GROUP-writable dir instead of silently tightening it', () => {
      const dir = path.join(base, 'gw');
      fs.mkdirSync(dir);
      fs.chmodSync(dir, 0o770);
      expect(() => establishTrustedDir(dir, 'probe dir')).toThrow(/group-writable/);
      expect(fs.lstatSync(dir).mode & 0o777).toBe(0o770);
    });

    it.skipIf(!posix)('refuses a dir whose immediate parent is a symlink (existing target)', () => {
      const outside = path.join(base, 'outside-existing');
      fs.mkdirSync(path.join(outside, 'boundary'), { recursive: true });
      fs.chmodSync(path.join(outside, 'boundary'), 0o755);
      fs.symlinkSync(outside, path.join(base, 'hop'), 'dir');
      expect(() => establishTrustedDir(path.join(base, 'hop', 'boundary'), 'probe dir')).toThrow(
        /symlink/,
      );
      expect(fs.lstatSync(path.join(outside, 'boundary')).mode & 0o777).toBe(0o755);
    });

    it.skipIf(!posix)('refuses a symlinked ancestor when the target is missing', () => {
      const outside = path.join(base, 'outside-missing');
      fs.mkdirSync(outside);
      fs.symlinkSync(outside, path.join(base, 'hop2'), 'dir');
      expect(() => establishTrustedDir(path.join(base, 'hop2', 'boundary'), 'probe dir')).toThrow(
        /symlink/,
      );
      expect(fs.readdirSync(outside)).toEqual([]);
    });

    // The context a missing boundary would be created INSIDE is not ours to chmod, so it is
    // checked instead: without the sticky bit a peer can pre-plant or swap whatever we create.
    it.skipIf(!posix)('refuses to create inside a NON-STICKY world-writable directory', () => {
      const loose = path.join(base, 'loose-ctx');
      fs.mkdirSync(loose);
      fs.chmodSync(loose, 0o777);
      expect(() => establishTrustedDir(path.join(loose, 'b'), 'probe dir')).toThrow(/sticky/);
      expect(fs.existsSync(path.join(loose, 'b'))).toBe(false);
    });

    it.skipIf(!posix)('creates inside a STICKY world-writable directory (the /tmp shape)', () => {
      const sticky = path.join(base, 'sticky-ctx');
      fs.mkdirSync(sticky);
      fs.chmodSync(sticky, 0o1777);
      const real = establishTrustedDir(path.join(sticky, 'b'), 'probe dir');
      expect(real).toBe(path.join(sticky, 'b'));
      expect(fs.lstatSync(real).mode & 0o777).toBe(0o700);
    });

    it('refuses a regular file squatting at the path', () => {
      const p = path.join(base, 'occupied');
      fs.writeFileSync(p, 'x');
      expect(() => establishTrustedDir(p, 'probe dir')).toThrow(/not a directory/);
    });

    it('registers a boundary: safeWriteFileAtomic then validates the WHOLE chain beneath it', () => {
      // Both paths validate the whole chain: without a boundary the walk starts at the filesystem
      // root, with one it starts at the boundary and re-checks its dev/inode first. Either way a
      // symlink ANYWHERE in the chain is refused even when the final parent lstats as a real
      // directory — what the boundary adds is the identity check on the root itself, not the only
      // ancestor validation.
      if (!posix) {
        return;
      }
      const boundary = establishTrustedDir(path.join(base, 'bound'), 'probe dir');
      const outside = path.join(base, 'outside');
      fs.mkdirSync(path.join(outside, 'b'), { recursive: true });
      fs.symlinkSync(outside, path.join(boundary, 'a'), 'dir');
      expect(() => safeWriteFileAtomic(path.join(boundary, 'a', 'b', 'out.md'), 'x\n')).toThrow(
        /symlink/,
      );
      expect(fs.readdirSync(path.join(outside, 'b'))).toEqual([]);
    });

    // INVARIANT: a path string is not an identity. Registering a boundary under its logical
    // spelling as well as its realpath would make the two interchangeable trusted prefixes — swap
    // the directory the string names and it keeps blessing I/O in a tree nobody validated. The
    // boundary is bound to the canonical path PLUS its dev/inode, re-checked on every use.
    it.skipIf(!posix)(
      'a boundary root REPLACED after establishment is refused — read and write both, outside victims untouched',
      () => {
        const root = path.join(base, 'root');
        const boundary = establishTrustedDir(root, 'probe dir');
        safeWriteFileAtomic(path.join(boundary, 'export.md'), 'inside\n');

        // the attacker's tree: deliberately wide open, with a file at the same relative name
        const outside = path.join(base, 'outside-swap');
        fs.mkdirSync(outside);
        fs.chmodSync(outside, 0o777);
        const victim = path.join(outside, 'export.md');
        fs.writeFileSync(victim, 'OUTSIDE — must survive byte-identical\n');
        fs.chmodSync(victim, 0o666);

        // swing the established boundary root itself at that tree
        fs.rmSync(root, { recursive: true, force: true });
        fs.symlinkSync(outside, root, 'dir');

        expect(() => safeReadTextFile(path.join(root, 'export.md'), 'probe')).toThrow(
          /no longer the directory that was validated/,
        );
        expect(() => safeWriteFileAtomic(path.join(root, 'export.md'), 'hijacked\n')).toThrow(
          /no longer the directory that was validated/,
        );
        expect(fs.readFileSync(victim, 'utf8')).toBe('OUTSIDE — must survive byte-identical\n');
        expect(fs.lstatSync(victim).mode & 0o777).toBe(0o666);
        expect(fs.lstatSync(outside).mode & 0o777).toBe(0o777);
        expect(fs.readdirSync(outside)).toEqual(['export.md']); // no temp debris either
      },
    );

    // INVARIANT: re-establishing an ALREADY-established canonical root COMPARES the registered
    // dev/inode, before any chmod or mkdir — it never refreshes it. Refreshing would re-bless a
    // root that was deleted and replaced by a new directory at the same path, and the opportunity
    // is constant: paths.ts feeds the cached canonical root back through establishTrustedDir on
    // every call, many times per command.
    it.skipIf(!posix)(
      'a boundary root DELETED AND RECREATED at the same path is refused on re-establishment',
      () => {
        const root = path.join(base, 'recreate');
        expect(establishTrustedDir(root, 'probe dir')).toBe(root);
        expect(establishTrustedDir(root, 'probe dir')).toBe(root); // same directory — still fine

        fs.rmSync(root, { recursive: true, force: true });
        fs.mkdirSync(root, { mode: 0o755 });
        fs.chmodSync(root, 0o755);
        fs.writeFileSync(path.join(root, 'planted.txt'), 'PLANTED\n');

        expect(() => establishTrustedDir(root, 'probe dir')).toThrow(
          /no longer the directory that was validated \(it was deleted and recreated\)/,
        );
        expect(() => assertTrustedDirReadOnly(root, 'probe dir')).toThrow(
          /no longer the directory that was validated/,
        );
        // refused BEFORE the mode-tightening chmod and before anything was written inside
        expect(fs.lstatSync(root).mode & 0o777).toBe(0o755);
        expect(fs.readdirSync(root)).toEqual(['planted.txt']);
        // …and the stale boundary no longer blesses I/O beneath it either
        expect(() => safeWriteFileAtomic(path.join(root, 'out.md'), 'x\n')).toThrow(
          /no longer the directory that was validated/,
        );
        expect(() => safeReadTextFile(path.join(root, 'planted.txt'), 'probe')).toThrow(
          /no longer the directory that was validated/,
        );
      },
    );

    it.skipIf(!posix)(
      'a boundary root that simply VANISHED is refused, not silently recreated',
      () => {
        const root = path.join(base, 'vanished');
        establishTrustedDir(root, 'probe dir');
        fs.rmSync(root, { recursive: true, force: true });

        expect(() => establishTrustedDir(root, 'probe dir')).toThrow(
          /no longer the directory that was validated/,
        );
        expect(() => assertTrustedDirReadOnly(root, 'probe dir')).toThrow(
          /no longer the directory that was validated/,
        );
        expect(fs.existsSync(root)).toBe(false); // the refusal created nothing
      },
    );

    it.skipIf(!posix)(
      'a boundary root REPLACED BY A SYMLINK is refused on re-establishment',
      () => {
        const root = path.join(base, 'relinked');
        establishTrustedDir(root, 'probe dir');
        const outside = path.join(base, 'relinked-outside');
        fs.mkdirSync(outside);
        fs.chmodSync(outside, 0o777);
        fs.rmSync(root, { recursive: true, force: true });
        fs.symlinkSync(outside, root, 'dir');

        expect(() => establishTrustedDir(root, 'probe dir')).toThrow(
          /no longer the directory that was validated/,
        );
        expect(() => assertTrustedDirReadOnly(root, 'probe dir')).toThrow(
          /no longer the directory that was validated/,
        );
        expect(fs.lstatSync(outside).mode & 0o777).toBe(0o777); // never chmodded through the link
        expect(fs.readdirSync(outside)).toEqual([]);
      },
    );
  });

  describe.skipIf(!posix)('ensureTrustedContainingDir / assertTrustedContainingDirReadOnly', () => {
    it('creates a missing chain one level at a time at the requested mode', () => {
      const file = path.join(base, 'made', 'up', 'deep', 'state.db');
      expect(ensureTrustedContainingDir(file, 'probe', { mode: 0o700 })).toBe(path.dirname(file));
      expect(fs.lstatSync(path.join(base, 'made')).mode & 0o777).toBe(0o700);
      expect(fs.lstatSync(path.dirname(file)).mode & 0o777).toBe(0o700);
      expect(fs.existsSync(file)).toBe(false); // the FILE is the caller's business, not ours
    });

    it('refuses a symlinked ancestor at any depth and creates nothing through it', () => {
      const outside = path.join(base, 'ctd-outside');
      fs.mkdirSync(path.join(outside, 'sub'), { recursive: true });
      fs.symlinkSync(outside, path.join(base, 'ctd-hop'), 'dir');

      expect(() =>
        ensureTrustedContainingDir(path.join(base, 'ctd-hop', 'sub', 'x.db'), 'probe'),
      ).toThrow(/symlink/);
      expect(() =>
        ensureTrustedContainingDir(path.join(base, 'ctd-hop', 'a', 'b', 'x.db'), 'probe'),
      ).toThrow(/symlink/);
      expect(() =>
        assertTrustedContainingDirReadOnly(path.join(base, 'ctd-hop', 'sub', 'x.db'), 'probe'),
      ).toThrow(/symlink/);
      expect(fs.readdirSync(path.join(outside, 'sub'))).toEqual([]);
      expect(fs.readdirSync(outside)).toEqual(['sub']);
    });

    it('the read-only form refuses an absent containing directory and creates nothing', () => {
      const file = path.join(base, 'nowhere', 'x.db');
      expect(() => assertTrustedContainingDirReadOnly(file, 'probe')).toThrow(/does not exist/);
      expect(fs.existsSync(path.join(base, 'nowhere'))).toBe(false);
    });

    // THE ANCESTOR-TRUST INVARIANT at the module's own door. Symlink status is not a sufficient
    // test outside a boundary: a plain non-sticky 0777 directory contains no link anywhere and is
    // still a place where every local peer can rename our entry away and put their own there. So
    // it is not a place to create the memory database, the vault key or the journal checkpoint —
    // and not a place to read from either, since what we read there may be a peer's plant.
    it('refuses an EXISTING 0777 NON-STICKY containing directory (create AND write AND read)', () => {
      const loose = path.join(base, 'ctd-loose');
      fs.mkdirSync(loose, { mode: 0o700 });
      fs.writeFileSync(path.join(loose, 'planted.txt'), 'PLANTED\n', { mode: 0o600 });
      fs.chmodSync(loose, 0o777);
      const file = path.join(loose, 'x.db');

      expect(() => ensureTrustedContainingDir(file, 'probe')).toThrow(
        /refusing to create anything inside/,
      );
      expect(() => safeWriteFileAtomic(file, 'x\n')).toThrow(/refusing to create anything inside/);
      expect(() => assertTrustedContainingDirReadOnly(file, 'probe')).toThrow(
        /not a safe location for Sthayi state/,
      );
      expect(() => safeReadTextFile(path.join(loose, 'planted.txt'), 'probe')).toThrow(
        /not a safe location for Sthayi state/,
      );

      expect(fs.existsSync(file)).toBe(false);
      expect(fs.readdirSync(loose)).toEqual(['planted.txt']); // no tmp debris, no new entry
      expect(fs.lstatSync(loose).mode & 0o777).toBe(0o777); // never "repaired" behind the user's back
    });

    it('refuses a MISSING chain under a 0777 NON-STICKY parent without creating a level', () => {
      const loose = path.join(base, 'ctd-loose-missing');
      fs.mkdirSync(loose, { mode: 0o700 });
      fs.chmodSync(loose, 0o777);

      expect(() =>
        ensureTrustedContainingDir(path.join(loose, 'a', 'b', 'x.db'), 'probe', { mode: 0o700 }),
      ).toThrow(/not a safe location for Sthayi state/);
      expect(fs.readdirSync(loose)).toEqual([]);
    });

    it('refuses a DEEPER unsafe ancestor even when the containing directory is private 0700', () => {
      const loose = path.join(base, 'ctd-deep');
      fs.mkdirSync(path.join(loose, 'mid', 'priv'), { recursive: true, mode: 0o700 });
      fs.chmodSync(path.join(loose, 'mid', 'priv'), 0o700);
      fs.chmodSync(path.join(loose, 'mid'), 0o700);
      fs.chmodSync(loose, 0o777);
      const file = path.join(loose, 'mid', 'priv', 'x.db');

      expect(() => ensureTrustedContainingDir(file, 'probe')).toThrow(
        /not a safe location for Sthayi state/,
      );
      expect(() => safeWriteFileAtomic(file, 'x\n')).toThrow(
        /not a safe location for Sthayi state/,
      );
      expect(fs.readdirSync(path.join(loose, 'mid', 'priv'))).toEqual([]);
    });

    it('a STICKY world-writable containing directory is still accepted (the /tmp shape)', () => {
      const sticky = path.join(base, 'ctd-sticky');
      fs.mkdirSync(sticky, { mode: 0o700 });
      fs.chmodSync(sticky, 0o1777);
      const file = path.join(sticky, 'kid', 'x.json');
      expect(ensureTrustedContainingDir(file, 'probe', { mode: 0o700 })).toBe(path.dirname(file));
      safeWriteFileAtomic(file, '{"ok":true}\n');
      expect(safeReadTextFile(file, 'probe')).toBe('{"ok":true}\n');
    });

    // A level we CREATE is one we are entitled to be strict about: anything world-writable or
    // foreign-owned at that path is an entry we did not make, i.e. one that raced in.
    it('a level that RACES IN world-writable during the walk is refused, nothing written inside', () => {
      const root = path.join(base, 'ctd-race');
      fs.mkdirSync(root, { mode: 0o700 });
      const mid = path.join(root, 'mid');
      const realMkdir = fs.mkdirSync.bind(fs);
      vi.spyOn(fs, 'mkdirSync').mockImplementation(((p: fs.PathLike, opts?: unknown) => {
        const r = realMkdir(p as string, opts as undefined);
        if (String(p) === mid) {
          fs.chmodSync(p as string, 0o777); // a peer won the race and owns the level's bits
        }
        return r;
      }) as typeof fs.mkdirSync);

      expect(() =>
        ensureTrustedContainingDir(path.join(mid, 'deeper', 'x.db'), 'probe', { mode: 0o700 }),
      ).toThrow(/world-writable/);

      vi.restoreAllMocks();
      expect(fs.readdirSync(mid)).toEqual([]); // the walk stopped there — nothing beneath it
    });
  });

  describe('assertTrustedDirReadOnly (observational: creates nothing, chmods nothing)', () => {
    it('an absent directory reads as undefined and is NOT created', () => {
      const dir = path.join(base, 'never-there');
      expect(assertTrustedDirReadOnly(dir, 'probe dir')).toBeUndefined();
      expect(fs.existsSync(dir)).toBe(false);
    });

    it('a healthy dir is returned canonical and registers the boundary', () => {
      const dir = path.join(base, 'ro-healthy');
      fs.mkdirSync(dir, { mode: 0o700 });
      expect(assertTrustedDirReadOnly(dir, 'probe dir')).toBe(dir);
      expect(fs.readdirSync(dir)).toEqual([]);
    });

    it.skipIf(!posix)('a loose-but-safe 0755 dir is accepted AS IS — never tightened', () => {
      const dir = path.join(base, 'ro-loose');
      fs.mkdirSync(dir);
      fs.chmodSync(dir, 0o755);
      expect(assertTrustedDirReadOnly(dir, 'probe dir')).toBe(dir);
      expect(fs.lstatSync(dir).mode & 0o777).toBe(0o755); // observation is not repair
    });

    it.skipIf(!posix)(
      'a read-only EACCES result poisons later use instead of blessing a readable replacement',
      () => {
        const dir = path.join(base, 'ro-unpinned');
        const original = path.join(base, 'ro-unpinned-original');
        fs.mkdirSync(dir, { mode: 0o700 });
        fs.chmodSync(dir, 0o000);
        const realOpen = fs.openSync.bind(fs);
        vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, flags: number) => {
          if (String(p) === dir && (flags & fs.constants.O_DIRECTORY) !== 0) {
            throw Object.assign(new Error('synthetic locked directory'), { code: 'EACCES' });
          }
          return realOpen(p, flags);
        }) as typeof fs.openSync);

        // The first observational call remains useful to doctor/status and changes no mode or file.
        expect(assertTrustedDirReadOnly(dir, 'probe dir')).toBe(dir);
        expect(fs.lstatSync(dir).mode & 0o777).toBe(0o000);
        vi.restoreAllMocks();

        // Stand a healthy, same-owner, same-policy directory at the name after that return.
        fs.chmodSync(dir, 0o700);
        fs.renameSync(dir, original);
        fs.mkdirSync(dir, { mode: 0o700 });
        fs.writeFileSync(path.join(dir, 'planted.txt'), 'replacement\n', { mode: 0o600 });

        expect(() => assertTrustedDirReadOnly(dir, 'probe dir')).toThrow(
          /could not be pinned during an earlier read-only validation/,
        );
        expect(() => establishTrustedDir(dir, 'probe dir')).toThrow(
          /could not be pinned during an earlier read-only validation/,
        );
        expect(() => safeReadTextFile(path.join(dir, 'planted.txt'), 'probe')).toThrow(
          /could not be pinned during an earlier read-only validation/,
        );
        expect(() => safeWriteFileAtomic(path.join(dir, 'never.txt'), 'no\n')).toThrow(
          /could not be pinned during an earlier read-only validation/,
        );
        expect(fs.readdirSync(dir)).toEqual(['planted.txt']);
      },
    );

    it.skipIf(!posix)('refuses a symlinked dir (target mode preserved, contents unread)', () => {
      const outside = path.join(base, 'ro-outside');
      fs.mkdirSync(outside);
      fs.chmodSync(outside, 0o755);
      const linked = path.join(base, 'ro-linked');
      fs.symlinkSync(outside, linked, 'dir');
      expect(() => assertTrustedDirReadOnly(linked, 'probe dir')).toThrow(/symlink/);
      expect(fs.lstatSync(outside).mode & 0o777).toBe(0o755);
    });

    it.skipIf(!posix)('refuses a dir whose parent is a symlink', () => {
      const outside = path.join(base, 'ro-outside-p');
      fs.mkdirSync(path.join(outside, 'd'), { recursive: true });
      fs.symlinkSync(outside, path.join(base, 'ro-hop'), 'dir');
      expect(() => assertTrustedDirReadOnly(path.join(base, 'ro-hop', 'd'), 'probe dir')).toThrow(
        /symlink/,
      );
    });

    it.skipIf(!posix)('refuses group- and world-writable dirs without touching their modes', () => {
      const gw = path.join(base, 'ro-gw');
      fs.mkdirSync(gw);
      fs.chmodSync(gw, 0o770);
      expect(() => assertTrustedDirReadOnly(gw, 'probe dir')).toThrow(/group-writable/);
      expect(fs.lstatSync(gw).mode & 0o777).toBe(0o770);

      const ww = path.join(base, 'ro-ww');
      fs.mkdirSync(ww);
      fs.chmodSync(ww, 0o777);
      expect(() => assertTrustedDirReadOnly(ww, 'probe dir')).toThrow(/world-writable/);
      expect(fs.lstatSync(ww).mode & 0o777).toBe(0o777);
    });

    it('refuses a regular file squatting at the path', () => {
      const p = path.join(base, 'ro-occupied');
      fs.writeFileSync(p, 'x');
      expect(() => assertTrustedDirReadOnly(p, 'probe dir')).toThrow(/not a directory/);
    });
  });
});
