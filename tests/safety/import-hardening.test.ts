import { execFileSync } from 'node:child_process';
import { randomBytes as nodeRandom } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  AssocService,
  type CryptoPort,
  JournalService,
  MemoryService,
  VaultService,
} from '@sthayi/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteDriver } from '../../packages/cli/src/drivers/sqlite.js';
import { IMPORT_LIMITS, loadArchive } from '../../packages/cli/src/importers/load.js';
import { runImport } from '../../packages/cli/src/importers/run.js';
import type { Store } from '../../packages/cli/src/store.js';
import { claimToolEntry, removeOwned } from '../helpers/owned-fs.js';
import { runTempDir } from '../helpers/run-temp.js';

/**
 * SAFETY: import extraction is a trust boundary. An export archive is untrusted input — this
 * suite proves the loader (a) skips symlinked entries rather than resolving them, and refuses a
 * selected file whose identity changed under it (folder OR zip form), (b) enforces the
 * aggregate limits (total bytes, entry count, path depth) and the zip expansion guard BEFORE
 * buffering/parsing and before any store transaction opens, and (c) still loads a well-formed
 * export byte-exactly. The zips are built in-test from raw ZIP records so hostile shapes
 * (lying size headers, symlink entries, traversal names, entry floods) can be crafted exactly.
 */

// ---------------------------------------------------------------------------------------------
// Minimal in-test zip writer (local file headers + central directory + EOCD). Supports stored
// (method 0) and deflate (method 8) entries, arbitrary external attributes (symlink modes),
// and deliberately LYING size fields — everything a hostile archive can do.
// ---------------------------------------------------------------------------------------------
interface ZipEntrySpec {
  name: string;
  data: Buffer | string;
  method?: 0 | 8;
  /** override the uncompressed size recorded in BOTH headers (to lie to the budget) */
  claimUncompressedSize?: number;
  /** central-directory external attributes; high 16 bits are the unix mode */
  externalAttrs?: number;
}

function buildZip(specs: ZipEntrySpec[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const s of specs) {
    const raw = Buffer.isBuffer(s.data) ? s.data : Buffer.from(s.data, 'utf8');
    const method = s.method ?? 0;
    const compressed = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const crc = zlib.crc32(raw) >>> 0;
    const usize = s.claimUncompressedSize ?? raw.length;
    const csize = compressed.length;
    const name = Buffer.from(s.name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0x21, 12); // mod date (a valid DOS date)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(csize, 18);
    local.writeUInt32LE(usize, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    const localOffset = offset;
    locals.push(local, name, compressed);
    offset += local.length + name.length + compressed.length;

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory header signature
    central.writeUInt16LE(0x031e, 4); // version made by (unix)
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12); // mod time
    central.writeUInt16LE(0x21, 14); // mod date
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(csize, 20);
    central.writeUInt32LE(usize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE((s.externalAttrs ?? 0) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centrals.push(central, name);
  }
  const cdStart = offset;
  const cdSize = centrals.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // central dir start disk
  eocd.writeUInt16LE(specs.length, 8);
  eocd.writeUInt16LE(specs.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20); // comment length
  return Buffer.concat([...locals, ...centrals, eocd]);
}

const CLAUDE_CONVERSATIONS = JSON.stringify([
  {
    uuid: 'conv-hardening-1',
    name: 'safe conversation',
    created_at: '2026-01-02T10:00:00Z',
    updated_at: '2026-01-02T10:05:00Z',
    chat_messages: [
      { uuid: 'm-1', sender: 'human', text: 'Remember that my favorite color is teal.' },
      { uuid: 'm-2', sender: 'assistant', text: 'Noted!' },
    ],
  },
]);

const fakeCrypto: CryptoPort = {
  encrypt: (s) => new TextEncoder().encode(s),
  decrypt: (b) => new TextDecoder().decode(b),
};

function makeStore(): { store: Store; driver: SqliteDriver } {
  const driver = SqliteDriver.openMemory();
  driver.migrate();
  const journal = new JournalService(driver);
  const vault = new VaultService(driver, fakeCrypto, {});
  const assoc = new AssocService(driver);
  const memory = new MemoryService(driver, journal, vault, assoc);
  return { store: { driver, journal, memory, vault, assoc, close: () => driver.close() }, driver };
}

describe('safety: zip import hardening (in-test crafted archives)', () => {
  let dir: string;
  let warnings: string[];
  const warn = (m: string) => warnings.push(m);

  beforeEach(() => {
    dir = runTempDir('sthayi-ziphard-');
    warnings = [];
  });
  afterEach(() => {
    removeOwned(dir);
  });

  function writeZip(name: string, specs: ZipEntrySpec[]): string {
    const p = path.join(dir, name);
    fs.writeFileSync(p, buildZip(specs));
    return p;
  }

  it('a well-formed small zip loads byte-exactly and imports end-to-end', async () => {
    const zip = writeZip('claude.zip', [
      { name: 'conversations.json', data: CLAUDE_CONVERSATIONS, method: 8 },
      { name: 'users.json', data: '[]' },
      { name: 'unrelated.png', data: 'binary-ish' }, // not allow-listed: never buffered
    ]);
    const files = await loadArchive(zip, { warn });
    expect(files['conversations.json']).toBe(CLAUDE_CONVERSATIONS);
    expect(files['users.json']).toBe('[]');
    expect(files['unrelated.png']).toBeUndefined();
    expect(warnings).toEqual([]);

    const { store, driver } = makeStore();
    try {
      const summary = await runImport(zip, store, 1_700_000_000_000);
      expect(summary.source).toBe('claude');
      expect(summary.imported).toBeGreaterThan(0);
      expect(driver.listMemories({ status: 'proposed' }).length).toBe(summary.imported);
    } finally {
      driver.close();
    }
  });

  it('over-ratio zip (real deflate bomb) is rejected BEFORE buffering, store untouched', async () => {
    // 5 MiB of zeros deflates to a few KiB — far beyond the 100:1 guard, honestly encoded.
    const zip = writeZip('bomb.zip', [
      { name: 'conversations.json', data: Buffer.alloc(5 * 1024 * 1024), method: 8 },
    ]);
    await expect(loadArchive(zip)).rejects.toThrow(/expands more than 100:1/);

    const { store, driver } = makeStore();
    try {
      await expect(runImport(zip, store, 1)).rejects.toThrow(/decompression bomb/);
      // rejected before any store transaction: zero memories, zero journal entries
      expect(driver.countMemories()).toBe(0);
      expect(driver.allJournal().length).toBe(0);
    } finally {
      driver.close();
    }
  });

  it('headers claiming more than the 256 MiB total cap are rejected before any stream opens', async () => {
    // deflate entry LYING that it holds 300 MiB. The compressed payload is ~3.5 MiB of
    // incompressible random bytes, so the claimed ratio (~86:1) stays under the 100:1 guard —
    // the TOTAL byte cap alone must reject, on central-directory metadata, before streaming.
    // (A stored-entry lie cannot reach this guard: yauzl itself rejects stored entries whose
    // compressed and uncompressed sizes disagree.)
    const zip = writeZip('liar.zip', [
      {
        name: 'conversations.json',
        data: nodeRandom(3_500_000),
        method: 8,
        claimUncompressedSize: 300 * 1024 * 1024,
      },
    ]);
    await expect(loadArchive(zip)).rejects.toThrow(/total size limit/);
  });

  it('a stream exceeding its declared uncompressed size is refused, never silently truncated', async () => {
    // deflate entry whose headers UNDERSTATE the content (1 MiB real, 2 KiB declared): the lie
    // passes the metadata budget, so the guard must catch it the moment the stream overruns.
    const zip = writeZip('understated.zip', [
      {
        name: 'conversations.json',
        data: Buffer.alloc(1024 * 1024, 0x61),
        method: 8,
        claimUncompressedSize: 2048,
      },
    ]);
    await expect(loadArchive(zip)).rejects.toThrow(/import refused/);
  });

  it('symlink zip entries are skipped with a warning naming the file — never followed', async () => {
    const symlinkMode = 0o120777 << 16; // S_IFLNK | 0777 in the unix-mode high bits
    const zip = writeZip('symlink.zip', [
      { name: 'conversations.json', data: '/etc/passwd', externalAttrs: symlinkMode },
      { name: 'users.json', data: '[]' },
    ]);
    const files = await loadArchive(zip, { warn });
    expect(files['conversations.json']).toBeUndefined();
    expect(files['users.json']).toBe('[]');
    expect(warnings.some((w) => w.includes('conversations.json') && w.includes('symlink'))).toBe(
      true,
    );
  });

  it('path-traversal entry names never reach the parsers (yauzl refuses the archive)', async () => {
    const zip = writeZip('traversal.zip', [{ name: '../conversations.json', data: '[]' }]);
    await expect(loadArchive(zip)).rejects.toThrow(/invalid relative path|\.\./);
  });

  it('absolute entry names never reach the parsers', async () => {
    const zip = writeZip('absolute.zip', [{ name: '/etc/conversations.json', data: '[]' }]);
    await expect(loadArchive(zip)).rejects.toThrow(/absolute path/i);
  });

  it('windows-drive absolute names are refused — they never reach the parsers', async () => {
    const zip = writeZip('drive.zip', [
      { name: 'C:/evil/conversations.json', data: '[]' },
      { name: 'users.json', data: '[]' },
    ]);
    await expect(loadArchive(zip)).rejects.toThrow(/absolute path/i);
  });

  it(`rejects a zip with more than ${IMPORT_LIMITS.entries} entries (the real cap)`, async () => {
    const specs: ZipEntrySpec[] = [];
    for (let i = 0; i <= IMPORT_LIMITS.entries; i++) {
      specs.push({ name: `f${i}.txt`, data: '' });
    }
    const zip = writeZip('flood.zip', specs);
    await expect(loadArchive(zip)).rejects.toThrow(/more than 10000 entries/);
  }, 30_000);

  it(`rejects an entry nested deeper than ${IMPORT_LIMITS.pathDepth} segments (the real cap)`, async () => {
    const deepName = `${Array.from({ length: IMPORT_LIMITS.pathDepth + 1 }, (_, i) => `d${i}`).join('/')}/x.txt`;
    const zip = writeZip('deep.zip', [{ name: deepName, data: '' }]);
    await expect(loadArchive(zip)).rejects.toThrow(/nested more than 16 path segments/);
  });
});

/**
 * Deterministic classify→act race seam for the FOLDER loader. The loader enumerates
 * incrementally (opendirSync + readSync) so the entry limit binds before a hostile directory's
 * names are materialized, which means the race window opens the instant a Dirent is handed to
 * the walker — not after a whole readdir array. This wrapper fires `swap` at exactly that
 * instant for the entry named `afterEntry` inside `inDir`: classification has happened, the
 * loader has not yet acted on it. No sleeps, no timing assumptions.
 */
function raceAfterDirent(
  inDir: string,
  afterEntry: string,
  swap: () => void,
): ReturnType<typeof vi.spyOn> {
  const realOpendir = fs.opendirSync.bind(fs);
  let fired = false;
  return vi.spyOn(fs, 'opendirSync').mockImplementation(((
    p: fs.PathLike,
    o?: Parameters<typeof fs.opendirSync>[1],
  ) => {
    const handle = realOpendir(p as string, o as never);
    if (path.resolve(String(p)) !== path.resolve(inDir)) {
      return handle;
    }
    const readSync = handle.readSync.bind(handle);
    (handle as { readSync: () => fs.Dirent | null }).readSync = () => {
      const entry = readSync();
      if (!fired && entry?.name === afterEntry) {
        fired = true;
        swap();
      }
      return entry;
    };
    return handle;
  }) as typeof fs.opendirSync) as ReturnType<typeof vi.spyOn>;
}

describe('safety: folder import hardening (symlink containment before any store write)', () => {
  let base: string;

  beforeEach(() => {
    base = runTempDir('sthayi-dirhard-');
  });
  afterEach(() => {
    removeOwned(base);
  });

  it('a symlinked conversations.json escaping the selected folder is skipped with a warning; the secret never enters the store', async () => {
    const secret = path.join(base, 'outside-secret.json');
    const marker = 'OUTSIDE-SECRET-CANARY';
    fs.writeFileSync(
      secret,
      JSON.stringify([
        {
          uuid: 'x',
          chat_messages: [{ uuid: 'm', sender: 'human', text: marker }],
        },
      ]),
    );
    const exportDir = path.join(base, 'export');
    fs.mkdirSync(exportDir);
    fs.writeFileSync(path.join(exportDir, 'users.json'), '[]');
    try {
      fs.symlinkSync(secret, path.join(exportDir, 'conversations.json'));
    } catch {
      return; // platform without symlink privilege — POSIX runners cover this row
    }

    const { store, driver } = makeStore();
    try {
      const summary = await runImport(exportDir, store, 1);
      expect(summary.source).toBe('claude'); // users.json still identifies the export
      expect(
        summary.warnings.some((w) => w.includes('conversations.json') && w.includes('symlink')),
      ).toBe(true);
      // the canary is nowhere: not imported, not journaled
      expect(summary.imported).toBe(0);
      expect(JSON.stringify(driver.listMemories({}))).not.toContain(marker);
      expect(JSON.stringify(driver.allJournal())).not.toContain(marker);
      // and the symlink itself was left exactly in place
      expect(fs.lstatSync(path.join(exportDir, 'conversations.json')).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(secret, 'utf8')).toContain(marker);
    } finally {
      driver.close();
    }
  });

  it('selected files are opened exactly ONCE, fd-read — never a second path-based open/read', async () => {
    // INVARIANT — the single-open discipline: O_NOFOLLOW open, fstat on the fd, read through
    // the fd. A second path-based open would reopen the classify→read race.
    const exportDir = path.join(base, 'export');
    fs.mkdirSync(exportDir);
    fs.writeFileSync(path.join(exportDir, 'conversations.json'), CLAUDE_CONVERSATIONS);
    fs.writeFileSync(path.join(exportDir, 'users.json'), '[]');

    const realOpen = fs.openSync.bind(fs);
    const opens: string[] = [];
    const openSpy = vi.spyOn(fs, 'openSync').mockImplementation(((
      p: fs.PathLike,
      flags: number,
      mode?: number,
    ) => {
      opens.push(String(p));
      return realOpen(p, flags, mode);
    }) as typeof fs.openSync);
    const readFileSpy = vi.spyOn(fs, 'readFileSync');
    try {
      const files = await loadArchive(exportDir);
      expect(files['conversations.json']).toBe(CLAUDE_CONVERSATIONS);
      expect(files['users.json']).toBe('[]');
      // each selected file: exactly one open (the O_NOFOLLOW fd the read went through)
      expect(opens.filter((p) => p.endsWith('conversations.json'))).toHaveLength(1);
      expect(opens.filter((p) => p.endsWith('users.json'))).toHaveLength(1);
      // and no whole-file path-based read ever ran during the load
      for (const call of readFileSpy.mock.calls) {
        expect(typeof call[0], 'path-based readFileSync during import load').not.toBe('string');
      }
    } finally {
      openSpy.mockRestore();
      readFileSpy.mockRestore();
    }
  });

  it('a classified child directory swapped for an outside symlink AFTER readdir is refused at descend time', async () => {
    // THE RACE: a Dirent from the parent's readdir says `data` is a directory, and the attacker
    // then swaps it for a symlink to an OUTSIDE dir holding a conversations.json. A recursion that
    // trusts the stale Dirent follows the link. Driven deterministically here by performing the
    // swap the moment the parent readdir returns — the walker must re-lstat at descend time and
    // refuse.
    const marker = 'DIR-SWAP-CANARY';
    const outsideDir = path.join(base, 'outside-dir');
    fs.mkdirSync(outsideDir);
    fs.writeFileSync(
      path.join(outsideDir, 'conversations.json'),
      JSON.stringify([
        { uuid: 'x', chat_messages: [{ uuid: 'm', sender: 'human', text: marker }] },
      ]),
    );
    const exportDir = path.join(base, 'export');
    const child = path.join(exportDir, 'data');
    fs.mkdirSync(child, { recursive: true });
    fs.writeFileSync(path.join(exportDir, 'users.json'), '[]');

    const warnings: string[] = [];
    const spy = raceAfterDirent(exportDir, 'data', () => {
      fs.rmdirSync(child);
      try {
        fs.symlinkSync(outsideDir, child, 'dir');
      } catch {
        fs.mkdirSync(child); // platform without symlink privilege — restore and let it pass
      }
    });
    try {
      const files = await loadArchive(exportDir, { warn: (m) => warnings.push(m) });
      // the outside content never entered the load, and the descend-time re-lstat named the swap
      expect(JSON.stringify(files)).not.toContain(marker);
      expect(files['data/conversations.json']).toBeUndefined();
      if (fs.lstatSync(child).isSymbolicLink()) {
        expect(
          warnings.some((w) => w.includes('data') && w.includes('no longer a real directory')),
        ).toBe(true);
        // the outside dir was left untouched
        expect(fs.readFileSync(path.join(outsideDir, 'conversations.json'), 'utf8')).toContain(
          marker,
        );
      }
    } finally {
      spy.mockRestore();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'a selected file swapped for a FIFO after classification is skipped WITHOUT blocking',
    async () => {
      // regular-file → FIFO swap after the Dirent classification: the O_NOFOLLOW|O_NONBLOCK open
      // must return immediately (no writer ever connects — a blocking openSync would hang the
      // import forever) and the fstat-on-the-fd classification must refuse the non-regular file.
      const exportDir = path.join(base, 'export');
      fs.mkdirSync(exportDir);
      const target = path.join(exportDir, 'conversations.json');
      fs.writeFileSync(target, CLAUDE_CONVERSATIONS);
      fs.writeFileSync(path.join(exportDir, 'users.json'), '[]');

      const warnings: string[] = [];
      let fifoAvailable = true;
      const spy = raceAfterDirent(exportDir, 'conversations.json', () => {
        fs.rmSync(target);
        try {
          execFileSync('mkfifo', [target]);
          // `mkfifo` is an external program, so no `fs` binding in this process witnessed the entry
          // it made. Declaring it is what lets teardown remove this one entry; without the claim the
          // fixture is refused and leaks, holding the store this test wrote beside it.
          claimToolEntry(target);
        } catch {
          fifoAvailable = false;
          fs.writeFileSync(target, CLAUDE_CONVERSATIONS); // no mkfifo — restore, test degrades
        }
      });
      try {
        const files = await loadArchive(exportDir, { warn: (m) => warnings.push(m) });
        expect(files['users.json']).toBe('[]');
        if (fifoAvailable) {
          expect(files['conversations.json']).toBeUndefined();
          expect(
            warnings.some(
              (w) => w.includes('conversations.json') && w.includes('not a regular file'),
            ),
          ).toBe(true);
        }
      } finally {
        spy.mockRestore();
      }
    },
    10_000,
  );

  it('limit violations reject before ANY store transaction (zero memories, zero journal)', async () => {
    const exportDir = path.join(base, 'export');
    const deep = path.join(
      exportDir,
      ...Array.from({ length: IMPORT_LIMITS.pathDepth + 1 }, (_, i) => `d${i}`),
    );
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(exportDir, 'conversations.json'), CLAUDE_CONVERSATIONS);

    const { store, driver } = makeStore();
    try {
      await expect(runImport(exportDir, store, 1)).rejects.toThrow(/path segments/);
      expect(driver.countMemories()).toBe(0);
      expect(driver.allJournal().length).toBe(0);
    } finally {
      driver.close();
    }
  });
});
