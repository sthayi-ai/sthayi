import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileCheckpoint } from '../../packages/cli/src/drivers/checkpoint-file.js';
import { NodeCrypto } from '../../packages/cli/src/drivers/crypto.js';
import { SqliteDriver } from '../../packages/cli/src/drivers/sqlite.js';
import { removeOwned } from '../helpers/owned-fs.js';
import { claimToolEntry } from '../helpers/owned-fs.js';
import { runTempDir } from '../helpers/run-temp.js';

/**
 * SAFETY: the DIRECT driver callers — `SqliteDriver.open`, `SqliteDriver.openReadOnly` and
 * `NodeCrypto.open`/`loadExisting` — must validate the WHOLE ancestor chain of the file they are
 * about to create, open or read, not merely the immediate containing directory.
 *
 * The threat:
 *  - `fs.mkdirSync(dir, { recursive: true })` ahead of any validation resolves the entire chain in
 *    the kernel, so with `hop -> outside` the tail of the path is created inside the link's target
 *    and the database (plus the `-wal`/`-shm` sidecars SQLite opens by path) is written there. An
 *    lstat of the immediate parent does not catch it either — adding one level defeats that:
 *    `hop/sub/sthayi.db` lstats a real directory.
 *  - a READ through a symlinked ancestor discloses a database outside the boundary exactly as a
 *    write would plant one there, so `openReadOnly` owes the same whole-chain check as `open`.
 *  - `NodeCrypto` guards the vault's trust anchor: lstat-validating only the key FILE, with a raw
 *    recursive mkdir on the create path and a raw `fs.readFileSync` on the read path, would leave
 *    that same raw-parent/raw-read pair open for the one file whose disclosure loses every
 *    vaulted entity.
 *
 * These probes call the drivers DIRECTLY (never through openStore/openStoreReadOnly, which
 * validate the home chain first), for SHALLOW (`hop/x`) and DEEP (`hop/sub/x`, `hop/a/b/c/x`)
 * ancestor symlinks, with the target file EXISTING and MISSING. Every refusal is checked against a
 * full recursive snapshot of the outside tree — path set AND permission bits AND content hashes —
 * so a created directory, a minted `-wal`/`-shm`, a chmod, or a single written byte would show.
 */

const posixOnly = describe.skipIf(process.platform === 'win32');

/** Recursive snapshot: relative path → kind + permission bits + (file) size/sha256 / (link) target.
 *  Content is hashed rather than read as text because a SQLite database is binary. */
type Snapshot = Record<string, string>;

function snapshotDeep(dir: string): Snapshot {
  const out: Snapshot = {};
  const describeEntry = (full: string): string => {
    const st = fs.lstatSync(full);
    const mode = (st.mode & 0o777).toString(8);
    if (st.isSymbolicLink()) {
      return `link:${mode}:${fs.readlinkSync(full)}`;
    }
    if (st.isDirectory()) {
      return `dir:${mode}`;
    }
    if (!st.isFile()) {
      return `special:${mode}`;
    }
    const sha = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    return `file:${mode}:${st.size}:${sha}`;
  };
  const walk = (current: string, rel: string): void => {
    for (const e of fs
      .readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, e.name);
      const r = rel === '' ? e.name : `${rel}/${e.name}`;
      out[r] = describeEntry(full);
      if (!e.isSymbolicLink() && e.isDirectory()) {
        walk(full, r);
      }
    }
  };
  out['.'] = describeEntry(dir);
  walk(dir, '');
  return out;
}

/** Every path under `dir`, for the "not one new entry appeared" assertion. */
function pathsUnder(dir: string): string[] {
  return Object.keys(snapshotDeep(dir)).sort();
}

describe('driver ancestor-chain trust', () => {
  let base: string;

  beforeEach(() => {
    // realpath: os.tmpdir() is itself reached through /var -> private/var on macOS, and the whole
    // point of these fixtures is that the ONLY symlink in the chain is the one we plant.
    base = runTempDir('sthayi-chain-');
  });

  afterEach(() => {
    removeOwned(base);
  });

  /** A real, migrated SQLite store at `file`, cleanly checkpointed (no sidecars) so a snapshot of
   *  the outside tree is stable and the read-only SNAPSHOT branch is the one under test. */
  function plantStore(file: string, marker: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const d = SqliteDriver.open(file);
    d.migrate();
    d.setMeta('outside-canary', marker);
    d.close();
    fs.rmSync(`${file}-wal`, { force: true });
    fs.rmSync(`${file}-shm`, { force: true });
  }

  interface Shape {
    name: string;
    /** builds the outside tree + the link, returns [outsideRoot, the db path through the link] */
    plant: (existing: boolean) => { outside: string; file: string };
  }

  const shapes: Shape[] = [
    {
      name: 'SHALLOW: the immediate containing directory is a symlink (hop/sthayi.db)',
      plant: (existing) => {
        const outside = path.join(base, 'o-shallow');
        fs.mkdirSync(outside, { recursive: true });
        if (existing) {
          plantStore(path.join(outside, 'sthayi.db'), 'shallow');
        }
        fs.chmodSync(outside, 0o755);
        fs.symlinkSync(outside, path.join(base, 'hop-shallow'), 'dir');
        return { outside, file: path.join(base, 'hop-shallow', 'sthayi.db') };
      },
    },
    {
      name: 'DEEP: an INTERMEDIATE symlink two levels up (hop/sub/sthayi.db)',
      plant: (existing) => {
        const outside = path.join(base, 'o-deep');
        fs.mkdirSync(path.join(outside, 'sub'), { recursive: true });
        if (existing) {
          plantStore(path.join(outside, 'sub', 'sthayi.db'), 'deep');
        }
        fs.chmodSync(path.join(outside, 'sub'), 0o755);
        fs.symlinkSync(outside, path.join(base, 'hop-deep'), 'dir');
        return { outside, file: path.join(base, 'hop-deep', 'sub', 'sthayi.db') };
      },
    },
    {
      name: 'DEEPER: an INTERMEDIATE symlink four levels up (hop/a/b/c/sthayi.db)',
      plant: (existing) => {
        const outside = path.join(base, 'o-deeper');
        fs.mkdirSync(path.join(outside, 'a', 'b', 'c'), { recursive: true });
        if (existing) {
          plantStore(path.join(outside, 'a', 'b', 'c', 'sthayi.db'), 'deeper');
        }
        fs.symlinkSync(outside, path.join(base, 'hop-deeper'), 'dir');
        return { outside, file: path.join(base, 'hop-deeper', 'a', 'b', 'c', 'sthayi.db') };
      },
    },
  ];

  posixOnly('SqliteDriver.open refuses an ancestor symlink at any depth', () => {
    for (const shape of shapes) {
      it(`${shape.name} — EXISTING db: refused, outside tree byte- and mode-identical`, () => {
        const { outside, file } = shape.plant(true);
        const before = snapshotDeep(outside);

        expect(() => SqliteDriver.open(file)).toThrow(/refusing to open the memory database/);
        expect(() => SqliteDriver.open(file)).toThrow(/symlink/);

        // nothing written, nothing chmodded, no -wal/-shm minted, no new path at all
        expect(snapshotDeep(outside)).toEqual(before);
        expect(pathsUnder(outside).filter((p) => /-wal$|-shm$/.test(p))).toEqual([]);
      });

      it(`${shape.name} — MISSING db: refused, NOTHING is created in the outside tree`, () => {
        const { outside, file } = shape.plant(false);
        const before = snapshotDeep(outside);

        expect(() => SqliteDriver.open(file)).toThrow(/refusing to open the memory database/);
        expect(() => SqliteDriver.open(file)).toThrow(/symlink/);

        expect(snapshotDeep(outside)).toEqual(before);
        expect(fs.existsSync(file)).toBe(false);
      });
    }

    // The mkdir-through-a-symlink case specifically: the CONTAINING DIRECTORY is missing too, so
    // an `fs.mkdirSync(dir, { recursive: true })` would create it inside the link's target before
    // a single check could run.
    it('a MISSING containing directory is never mkdir-ed through the link', () => {
      const outside = path.join(base, 'o-mkdir');
      fs.mkdirSync(outside, { recursive: true });
      fs.symlinkSync(outside, path.join(base, 'hop-mkdir'), 'dir');
      const before = snapshotDeep(outside);

      const file = path.join(base, 'hop-mkdir', 'brand', 'new', 'sthayi.db');
      expect(() => SqliteDriver.open(file)).toThrow(/symlink/);

      expect(snapshotDeep(outside)).toEqual(before);
      expect(fs.readdirSync(outside)).toEqual([]);
    });
  });

  posixOnly('SqliteDriver.openReadOnly refuses an ancestor symlink at any depth', () => {
    for (const shape of shapes) {
      it(`${shape.name} — EXISTING db: refused, nothing read, outside tree identical`, () => {
        const { outside, file } = shape.plant(true);
        const before = snapshotDeep(outside);

        expect(() => SqliteDriver.openReadOnly(file)).toThrow(
          /refusing to open the memory database/,
        );
        expect(() => SqliteDriver.openReadOnly(file)).toThrow(/symlink/);

        // a refusal, not a read: no driver was returned, and observation minted no sidecars
        expect(snapshotDeep(outside)).toEqual(before);
        expect(pathsUnder(outside).filter((p) => /-wal$|-shm$/.test(p))).toEqual([]);
      });

      it(`${shape.name} — MISSING db: refused, and nothing is created`, () => {
        const { outside, file } = shape.plant(false);
        const before = snapshotDeep(outside);

        expect(() => SqliteDriver.openReadOnly(file)).toThrow(
          /refusing to open the memory database/,
        );
        expect(() => SqliteDriver.openReadOnly(file)).toThrow(/symlink/);

        expect(snapshotDeep(outside)).toEqual(before);
        expect(fs.existsSync(file)).toBe(false);
      });
    }
  });

  posixOnly('NodeCrypto refuses an ancestor symlink on the vault key path', () => {
    /** `hop -> outside` with the key at `hop/<...>/key`. */
    function plantKeyShape(
      name: string,
      depth: string[],
      existing: boolean,
    ): { outside: string; key: string; planted?: Buffer } {
      const outside = path.join(base, `ok-${name}`);
      fs.mkdirSync(path.join(outside, ...depth), { recursive: true });
      let planted: Buffer | undefined;
      if (existing) {
        planted = Buffer.alloc(32, 0xab);
        fs.writeFileSync(path.join(outside, ...depth, 'key'), planted, { mode: 0o600 });
      }
      fs.symlinkSync(outside, path.join(base, `hop-${name}`), 'dir');
      return { outside, key: path.join(base, `hop-${name}`, ...depth, 'key'), planted };
    }

    it.each([
      ['SHALLOW', [] as string[]],
      ['DEEP', ['sub']],
      ['DEEPER', ['a', 'b', 'c']],
    ])('%s ancestor symlink, key EXISTS: open and loadExisting both refuse to read it', (n, d) => {
      const { outside, key, planted } = plantKeyShape(`e-${n}`, d, true);
      const before = snapshotDeep(outside);

      expect(() => NodeCrypto.open(key)).toThrow(/symlink/);
      expect(() => NodeCrypto.loadExisting(key)).toThrow(/symlink/);

      // the planted key's bytes and mode survive, and no replacement was minted anywhere
      expect(snapshotDeep(outside)).toEqual(before);
      expect(fs.readFileSync(path.join(outside, ...d, 'key')).equals(planted as Buffer)).toBe(true);
    });

    it.each([
      ['SHALLOW', [] as string[]],
      ['DEEP', ['sub']],
      ['DEEPER', ['a', 'b', 'c']],
    ])('%s ancestor symlink, key MISSING: open mints NOTHING in the outside tree', (n, d) => {
      const { outside, key } = plantKeyShape(`m-${n}`, d, false);
      const before = snapshotDeep(outside);

      expect(() => NodeCrypto.open(key)).toThrow(/symlink/);
      expect(() => NodeCrypto.loadExisting(key)).toThrow(/symlink/);

      // no key, no `.tmp` publish debris, no created directory
      expect(snapshotDeep(outside)).toEqual(before);
      expect(fs.readdirSync(path.join(outside, ...d))).toEqual([]);
    });

    it('a MISSING containing directory is never mkdir-ed through the link either', () => {
      const outside = path.join(base, 'ok-mkdir');
      fs.mkdirSync(outside, { recursive: true });
      fs.symlinkSync(outside, path.join(base, 'hop-key-mkdir'), 'dir');
      const before = snapshotDeep(outside);

      expect(() =>
        NodeCrypto.open(path.join(base, 'hop-key-mkdir', 'brand', 'new', 'key')),
      ).toThrow(/symlink/);

      expect(snapshotDeep(outside)).toEqual(before);
      expect(fs.readdirSync(outside)).toEqual([]);
    });
  });

  posixOnly('NodeCrypto key reads go through a validated descriptor', () => {
    it('a FIFO at the key path is refused without hanging, and no key is minted', () => {
      const dir = path.join(base, 'fifo-key');
      fs.mkdirSync(dir);
      const key = path.join(dir, 'key');
      try {
        execFileSync('mkfifo', [key]);
      } catch {
        return; // no mkfifo on this system — the directory row in crypto.test.ts covers the branch
      }
      // `mkfifo` is an external binary whose syscalls no wrapper in this process sees. This names
      // the ONE entry it was asked to make, so teardown has a basis for removing that entry alone.
      claimToolEntry(key);
      expect(() => NodeCrypto.open(key)).toThrow(/not a regular file/);
      expect(() => NodeCrypto.loadExisting(key)).toThrow(/not a regular file/);
      expect(fs.lstatSync(key).isFIFO()).toBe(true); // still the FIFO — nothing replaced it
      expect(fs.readdirSync(dir)).toEqual(['key']);
    });

    // The vault's trust anchor is never read unbounded: a planted oversize file is refused by the
    // descriptor-level cap, and — the part that matters — open() does NOT answer the refusal by
    // minting a fresh key over it.
    it('an oversize key file is refused by the byte cap, and open does not overwrite it', () => {
      const dir = path.join(base, 'big-key');
      fs.mkdirSync(dir);
      const key = path.join(dir, 'key');
      const bytes = Buffer.alloc(64 * 1024, 0x5a);
      fs.writeFileSync(key, bytes, { mode: 0o600 });

      expect(() => NodeCrypto.open(key)).toThrow(/cap for a 32-byte vault key/);
      expect(() => NodeCrypto.loadExisting(key)).toThrow(/cap for a 32-byte vault key/);
      expect(fs.readFileSync(key).equals(bytes)).toBe(true);
      expect(fs.readdirSync(dir)).toEqual(['key']); // no `.tmp` debris, no replacement key
    });
  });

  /**
   * The SAME three direct callers against an UNSAFE CREATION CONTEXT rather than a symlink. A
   * symlink is only one of the ways an ancestor steers us; a NON-STICKY group/world-writable
   * directory hands every local peer the power to pre-plant or replace what we create, and a
   * foreign owner can replace any descendant path. Under such a parent all three callers must
   * create NOTHING — no database, no key, no checkpoint — because a private 0700 child buys
   * nothing when the ancestor decides whether that child is still the same directory a moment later.
   *
   * Called DIRECTLY (never through openStore, which establishes the home boundary first), because
   * the boundary is exactly what is absent in this threat.
   */
  posixOnly('the direct drivers refuse an UNSAFE CREATION CONTEXT and create nothing', () => {
    interface Ctx {
      name: string;
      /** returns [the unsafe subtree to snapshot, the directory the state file would live in] */
      plant: (tag: string) => { unsafe: string; dir: string };
    }

    const contexts: Ctx[] = [
      {
        name: 'an EXISTING 0777 NON-STICKY final parent',
        plant: (tag) => {
          const unsafe = path.join(base, `ctx-final-${tag}`);
          fs.mkdirSync(unsafe, { mode: 0o700 });
          fs.chmodSync(unsafe, 0o777);
          return { unsafe, dir: unsafe };
        },
      },
      {
        name: 'a MISSING child under a 0777 NON-STICKY parent',
        plant: (tag) => {
          const unsafe = path.join(base, `ctx-missing-${tag}`);
          fs.mkdirSync(unsafe, { mode: 0o700 });
          fs.chmodSync(unsafe, 0o777);
          return { unsafe, dir: path.join(unsafe, 'kid') };
        },
      },
      {
        name: 'a DEEPER unsafe ancestor above an otherwise-private 0700 child',
        plant: (tag) => {
          const unsafe = path.join(base, `ctx-deep-${tag}`);
          fs.mkdirSync(path.join(unsafe, 'mid', 'priv'), { recursive: true, mode: 0o700 });
          fs.chmodSync(path.join(unsafe, 'mid', 'priv'), 0o700);
          fs.chmodSync(path.join(unsafe, 'mid'), 0o700);
          fs.chmodSync(unsafe, 0o777);
          return { unsafe, dir: path.join(unsafe, 'mid', 'priv') };
        },
      },
      {
        name: 'an EXISTING GROUP-writable 0770 NON-STICKY final parent',
        plant: (tag) => {
          const unsafe = path.join(base, `ctx-group-${tag}`);
          fs.mkdirSync(unsafe, { mode: 0o700 });
          fs.chmodSync(unsafe, 0o770);
          return { unsafe, dir: unsafe };
        },
      },
    ];

    /** Only the ancestor-trust invariant produces this wording — an older symlink/non-directory
     *  refusal cannot satisfy it, which is what makes these assertions load-bearing. */
    const UNSAFE_CONTEXT =
      /not a safe location for Sthayi state|refusing to create anything inside/;

    for (const ctx of contexts) {
      it(`SqliteDriver.open — ${ctx.name}: refused, no db, no -wal/-shm, nothing created`, () => {
        const { unsafe, dir } = ctx.plant('db');
        const before = snapshotDeep(unsafe);
        const file = path.join(dir, 'sthayi.db');

        expect(() => SqliteDriver.open(file)).toThrow(/refusing to open the memory database/);
        expect(() => SqliteDriver.open(file)).toThrow(UNSAFE_CONTEXT);

        expect(snapshotDeep(unsafe)).toEqual(before);
        expect(fs.existsSync(file)).toBe(false);
        expect(pathsUnder(unsafe).filter((p) => /-wal$|-shm$/.test(p))).toEqual([]);
      });

      it(`SqliteDriver.openReadOnly — ${ctx.name}: refused, nothing read, nothing created`, () => {
        const { unsafe, dir } = ctx.plant('dbro');
        const before = snapshotDeep(unsafe);

        expect(() => SqliteDriver.openReadOnly(path.join(dir, 'sthayi.db'))).toThrow(
          UNSAFE_CONTEXT,
        );

        expect(snapshotDeep(unsafe)).toEqual(before);
      });

      it(`NodeCrypto.open — ${ctx.name}: refused, the vault key is NEVER minted`, () => {
        const { unsafe, dir } = ctx.plant('key');
        const before = snapshotDeep(unsafe);
        const key = path.join(dir, 'key');

        expect(() => NodeCrypto.open(key)).toThrow(UNSAFE_CONTEXT);
        expect(() => NodeCrypto.loadExisting(key)).toThrow(UNSAFE_CONTEXT);

        expect(snapshotDeep(unsafe)).toEqual(before);
        expect(fs.existsSync(key)).toBe(false);
        // no `.tmp` publish debris either
        expect(pathsUnder(unsafe).filter((p) => /\.tmp$/.test(p))).toEqual([]);
      });

      it(`FileCheckpoint.write/replace — ${ctx.name}: refused, no checkpoint AND NO LOCK FILE`, () => {
        const { unsafe, dir } = ctx.plant('cp');
        const before = snapshotDeep(unsafe);
        const cp = path.join(dir, 'journal.checkpoint');
        const store = new FileCheckpoint(cp);

        expect(() => store.write('planted-checkpoint')).toThrow(UNSAFE_CONTEXT);
        expect(() => store.replace(undefined, 'planted-checkpoint')).toThrow(UNSAFE_CONTEXT);
        expect(() => store.read()).toThrow(UNSAFE_CONTEXT);

        expect(snapshotDeep(unsafe)).toEqual(before);
        expect(fs.existsSync(cp)).toBe(false);
        // the interprocess lock is taken INSIDE replace(); the refusal must precede it
        expect(pathsUnder(unsafe).filter((p) => /\.lock$|\.tmp$/.test(p))).toEqual([]);
      });
    }

    it('PRESERVED: all three still work under a root-owned STICKY parent (the /tmp shape)', () => {
      const sticky = path.join(base, 'sticky-ctx');
      fs.mkdirSync(sticky, { mode: 0o700 });
      fs.chmodSync(sticky, 0o1777); // world-writable AND sticky — the shape /tmp has

      const db = path.join(sticky, 'kid', 'sthayi.db');
      const d = SqliteDriver.open(db);
      d.migrate();
      d.setMeta('probe', 'sticky');
      d.close();
      expect(fs.existsSync(db)).toBe(true);

      const key = path.join(sticky, 'kid', 'key');
      expect(NodeCrypto.open(key).decrypt(NodeCrypto.open(key).encrypt('ok'))).toBe('ok');

      const cp = path.join(sticky, 'kid', 'journal.checkpoint');
      new FileCheckpoint(cp).write('sticky-ok');
      expect(new FileCheckpoint(cp).read()).toBe('sticky-ok');
    });
  });

  posixOnly('healthy direct-driver paths are unchanged', () => {
    it('SqliteDriver.open creates a missing chain one level at a time, 0700, and round-trips', () => {
      const file = path.join(base, 'real', 'nested', 'sthayi.db');
      const d = SqliteDriver.open(file);
      d.migrate();
      d.setMeta('probe', 'v1');
      d.close();

      expect(fs.lstatSync(path.join(base, 'real')).mode & 0o777).toBe(0o700);
      expect(fs.lstatSync(path.join(base, 'real', 'nested')).mode & 0o777).toBe(0o700);
      expect(fs.lstatSync(file).mode & 0o777).toBe(0o600);

      const again = SqliteDriver.open(file);
      expect(again.getMeta('probe')).toBe('v1');
      again.close();
    });

    it('SqliteDriver.openReadOnly still snapshot-reads a cleanly checkpointed store', () => {
      const file = path.join(base, 'ro', 'sthayi.db');
      plantStore(file, 'healthy');
      const bytes = fs.readFileSync(file);
      const ro = SqliteDriver.openReadOnly(file);
      try {
        expect(ro.getMeta('outside-canary')).toBe('healthy');
      } finally {
        ro.close();
      }
      expect(fs.readFileSync(file).equals(bytes)).toBe(true);
      expect(fs.existsSync(`${file}-wal`)).toBe(false); // observation minted no sidecars
    });

    it('NodeCrypto.open still creates a 0600 key in a missing chain and round-trips', () => {
      const key = path.join(base, 'vault', 'deeper', 'key');
      const a = NodeCrypto.open(key);
      expect(fs.readFileSync(key).length).toBe(32);
      expect(fs.lstatSync(key).mode & 0o777).toBe(0o600);
      expect(fs.lstatSync(path.join(base, 'vault')).mode & 0o777).toBe(0o700);
      const blob = a.encrypt('round trip');
      expect(NodeCrypto.open(key).decrypt(blob)).toBe('round trip');
      expect(NodeCrypto.loadExisting(key).decrypt(blob)).toBe('round trip');
    });
  });
});
