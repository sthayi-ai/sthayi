import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runTempDir } from '../../../../tests/helpers/run-temp.js';
import { IMPORT_LIMITS, loadArchive, wanted } from './load.js';

/**
 * Trust-boundary behavior of the folder loader: symlinks inside a selected export are NEVER
 * followed (files or directories), and the aggregate limits (entries, depth, total bytes)
 * reject a hostile tree before anything is parsed. Zip-side coverage (including the
 * decompression-bomb guards) lives in tests/safety/import-hardening.test.ts.
 */
describe('loadArchive (extracted folder) — symlink containment and limits', () => {
  let base: string;
  let exportDir: string;
  let outside: string;
  let warnings: string[];

  beforeEach(() => {
    base = runTempDir('sthayi-load-');
    exportDir = path.join(base, 'export');
    outside = path.join(base, 'outside-secret.json');
    fs.mkdirSync(exportDir);
    fs.writeFileSync(outside, '[{"chat_messages": "EXFILTRATED"}]');
    warnings = [];
  });
  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  const warn = (m: string) => warnings.push(m);

  function trySymlink(target: string, linkPath: string): boolean {
    try {
      fs.symlinkSync(target, linkPath);
      return true;
    } catch {
      return false; // platform without symlink privilege — POSIX runners cover these rows
    }
  }

  it('a symlinked conversations.json pointing outside the export is skipped with a warning', async () => {
    fs.writeFileSync(path.join(exportDir, 'users.json'), '[]');
    if (!trySymlink(outside, path.join(exportDir, 'conversations.json'))) {
      return;
    }
    const files = await loadArchive(exportDir, { warn });
    expect(files['conversations.json']).toBeUndefined();
    expect(files['users.json']).toBe('[]');
    // the warning names the offending file
    expect(warnings.some((w) => w.includes('conversations.json') && w.includes('symlink'))).toBe(
      true,
    );
    // nothing exfiltrated, link untouched
    expect(JSON.stringify(files)).not.toContain('EXFILTRATED');
    expect(fs.lstatSync(path.join(exportDir, 'conversations.json')).isSymbolicLink()).toBe(true);
  });

  it('a symlinked directory is never traversed', async () => {
    const outsideDir = path.join(base, 'outside-dir');
    fs.mkdirSync(outsideDir);
    fs.writeFileSync(path.join(outsideDir, 'memories.json'), '"EXFILTRATED"');
    if (!trySymlink(outsideDir, path.join(exportDir, 'linked'))) {
      return;
    }
    const files = await loadArchive(exportDir, { warn });
    expect(Object.keys(files)).toEqual([]);
    expect(warnings.some((w) => w.includes('linked') && w.includes('symlink'))).toBe(true);
    expect(fs.readFileSync(path.join(outsideDir, 'memories.json'), 'utf8')).toBe('"EXFILTRATED"');
  });

  it('an inside-pointing symlink is also skipped — symlinks are categorically never followed', async () => {
    fs.writeFileSync(path.join(exportDir, 'users.json'), '[]');
    if (!trySymlink(path.join(exportDir, 'users.json'), path.join(exportDir, 'memories.json'))) {
      return;
    }
    const files = await loadArchive(exportDir, { warn });
    expect(files['memories.json']).toBeUndefined();
    expect(files['users.json']).toBe('[]');
    expect(warnings.some((w) => w.includes('memories.json'))).toBe(true);
  });

  it('rejects a tree with more entries than the limit (before parsing anything)', async () => {
    for (let i = 0; i < 6; i++) {
      fs.writeFileSync(path.join(exportDir, `f${i}.txt`), 'x');
    }
    await expect(loadArchive(exportDir, { limits: { entries: 5 } })).rejects.toThrow(
      /more than 5 entries/,
    );
  });

  it('rejects a tree nested deeper than the path-depth limit', async () => {
    const deep = path.join(
      exportDir,
      ...Array.from({ length: IMPORT_LIMITS.pathDepth + 1 }, (_, i) => `d${i}`),
    );
    fs.mkdirSync(deep, { recursive: true });
    await expect(loadArchive(exportDir)).rejects.toThrow(/nested more than 16 path segments/);
  });

  it('rejects selected content over the total byte cap with an actionable error', async () => {
    fs.writeFileSync(path.join(exportDir, 'conversations.json'), 'x'.repeat(64));
    fs.writeFileSync(path.join(exportDir, 'memories.json'), 'y'.repeat(64));
    await expect(loadArchive(exportDir, { limits: { totalBytes: 100 } })).rejects.toThrow(
      /total size limit/,
    );
  });

  it('the real limits admit a normal export shape untouched', async () => {
    fs.writeFileSync(path.join(exportDir, 'conversations.json'), '[{"chat_messages": []}]');
    const files = await loadArchive(exportDir);
    expect(files['conversations.json']).toBe('[{"chat_messages": []}]');
  });

  it('a file that GROWS between fstat and read is refused at the budget, naming the file', async () => {
    // 80 bytes at fstat time — comfortably inside a 100-byte budget…
    const target = path.join(exportDir, 'conversations.json');
    fs.writeFileSync(target, 'x'.repeat(80));
    const realFstat = fs.fstatSync.bind(fs);
    let grown = false;
    const spy = vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number) => {
      const st = realFstat(fd);
      if (!grown) {
        grown = true;
        // …then the file grows AFTER the size was taken and BEFORE the read: the declared-size
        // check has already passed, so only read-time enforcement can stop the overrun.
        fs.appendFileSync(target, 'g'.repeat(200));
      }
      return st;
    }) as typeof fs.fstatSync);
    try {
      await expect(loadArchive(exportDir, { limits: { totalBytes: 100 } })).rejects.toThrow(
        /conversations\.json produced more bytes than the .* total size limit .* nothing was imported/,
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('a symlink swapped in after the dirent check is still refused at open time (O_NOFOLLOW)', async () => {
    if ((fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW === undefined) {
      return; // platform without O_NOFOLLOW — the dirent check rows above still cover it
    }
    fs.writeFileSync(path.join(exportDir, 'users.json'), '[]');
    if (!trySymlink(outside, path.join(exportDir, 'conversations.json'))) {
      return;
    }
    // Simulate the classify→open race: the walker sees a REGULAR FILE dirent (as it would if the
    // entry were swapped for a symlink right after it was enumerated) — only O_NOFOLLOW can
    // refuse it now. The loader enumerates incrementally, so the lie is injected per-Dirent.
    const realOpendir = fs.opendirSync.bind(fs);
    const spy = vi.spyOn(fs, 'opendirSync').mockImplementation(((
      p: fs.PathLike,
      o?: Parameters<typeof fs.opendirSync>[1],
    ) => {
      const handle = realOpendir(p as string, o as never);
      const readSync = handle.readSync.bind(handle);
      (handle as { readSync: () => fs.Dirent | null }).readSync = () => {
        const d = readSync();
        if (d?.isSymbolicLink()) {
          d.isSymbolicLink = () => false;
          d.isFile = () => true;
        }
        return d;
      };
      return handle;
    }) as typeof fs.opendirSync);
    try {
      const files = await loadArchive(exportDir, { warn });
      expect(files['conversations.json']).toBeUndefined();
      expect(files['users.json']).toBe('[]');
      expect(warnings.some((w) => w.includes('conversations.json') && w.includes('symlink'))).toBe(
        true,
      );
      expect(JSON.stringify(files)).not.toContain('EXFILTRATED');
    } finally {
      spy.mockRestore();
    }
  });

  it('an ancestor re-pointed OUTSIDE between the containment realpath and the open cannot serve its canary', async () => {
    // THE RACE — validate, then swap, then open. `sub` is a real directory holding
    // the export's own conversations.json; the moment the loader has realpath-validated it as
    // contained, it is replaced by a symlink to an outside directory holding a same-named
    // canary. O_NOFOLLOW guards only the FINAL component, so re-opening the logical ancestor
    // chain would read the canary. Deterministic: the swap is performed by the realpathSync
    // seam itself, strictly between the two steps — no sleeps, no timing assumptions.
    const outsideDir = path.join(base, 'outside-dir');
    fs.mkdirSync(outsideDir);
    fs.writeFileSync(path.join(outsideDir, 'conversations.json'), '"OUTSIDE_CANARY"');
    const sub = path.join(exportDir, 'sub');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'conversations.json'), '"INSIDE_CONTENT"');
    fs.writeFileSync(path.join(exportDir, 'users.json'), '[]');

    const realRealpath = fs.realpathSync.bind(fs);
    let swapped = false;
    const spy = vi.spyOn(fs, 'realpathSync').mockImplementation(((
      p: fs.PathLike,
      o?: Parameters<typeof fs.realpathSync>[1],
    ) => {
      const resolved = realRealpath(p as string, o as never);
      if (!swapped && path.resolve(String(p)) === path.resolve(sub)) {
        swapped = true; // validated as contained — NOW re-point it, before the open
        fs.rmSync(path.join(sub, 'conversations.json'));
        fs.rmdirSync(sub);
        try {
          fs.symlinkSync(outsideDir, sub, 'dir');
        } catch {
          fs.mkdirSync(sub); // platform without symlink privilege — restore, row degrades
        }
      }
      return resolved;
    }) as typeof fs.realpathSync);
    try {
      const files = await loadArchive(exportDir, { warn });
      if (!fs.lstatSync(sub).isSymbolicLink()) {
        return; // no symlink privilege — POSIX runners cover this row
      }
      // the canary is nowhere: not loaded, not under the inside key, not anywhere in the result
      expect(JSON.stringify(files)).not.toContain('OUTSIDE_CANARY');
      expect(files['sub/conversations.json']).toBeUndefined();
      // …the rest of the export still loaded, and the refusal was reported by name
      expect(files['users.json']).toBe('[]');
      expect(
        warnings.some(
          (w) => w.includes('sub/conversations.json') && w.includes('changed identity'),
        ),
      ).toBe(true);
      // and the outside directory was left completely untouched
      expect(fs.readFileSync(path.join(outsideDir, 'conversations.json'), 'utf8')).toContain(
        'OUTSIDE_CANARY',
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('folder enumeration is INCREMENTAL: the entry limit trips mid-directory, and the dir handle is always closed', async () => {
    // The limit must bind while the directory is being read — a hostile folder with millions of
    // entries must never have all its names materialized into one array first. And the handle
    // must be closed even though budget.countEntry throws straight out of the read loop.
    for (let i = 0; i < 40; i++) {
      fs.writeFileSync(path.join(exportDir, `f${i}.txt`), 'x');
    }
    let reads = 0;
    let closes = 0;
    const realOpendir = fs.opendirSync.bind(fs);
    const readdirSpy = vi.spyOn(fs, 'readdirSync');
    const spy = vi.spyOn(fs, 'opendirSync').mockImplementation(((
      p: fs.PathLike,
      o?: Parameters<typeof fs.opendirSync>[1],
    ) => {
      const handle = realOpendir(p as string, o as never);
      const readSync = handle.readSync.bind(handle);
      const closeSync = handle.closeSync.bind(handle);
      const patch = handle as { readSync: () => fs.Dirent | null; closeSync: () => void };
      patch.readSync = () => {
        reads++;
        return readSync();
      };
      patch.closeSync = () => {
        closes++;
        closeSync();
      };
      return handle;
    }) as typeof fs.opendirSync);
    try {
      await expect(loadArchive(exportDir, { limits: { entries: 5 } })).rejects.toThrow(
        /more than 5 entries/,
      );
      // stopped ON the entry that broke the limit — five accepted, the sixth refused
      expect(reads).toBe(6);
      expect(closes).toBe(1); // closed on the way out of the throw
      expect(readdirSpy).not.toHaveBeenCalled(); // no array materialization anywhere
    } finally {
      spy.mockRestore();
      readdirSpy.mockRestore();
    }
  });

  it('recursion holds at most ONE open directory handle, however deep the tree', async () => {
    // Descend AFTER the parent's handle is closed: a deep export must not cost one open fd per
    // level (that is how a nested tree exhausts the process fd table).
    let deep = exportDir;
    for (let i = 0; i < 8; i++) {
      deep = path.join(deep, `d${i}`);
    }
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'conversations.json'), '[]');

    let open = 0;
    let maxOpen = 0;
    const realOpendir = fs.opendirSync.bind(fs);
    const spy = vi.spyOn(fs, 'opendirSync').mockImplementation(((
      p: fs.PathLike,
      o?: Parameters<typeof fs.opendirSync>[1],
    ) => {
      const handle = realOpendir(p as string, o as never);
      open++;
      maxOpen = Math.max(maxOpen, open);
      const closeSync = handle.closeSync.bind(handle);
      (handle as { closeSync: () => void }).closeSync = () => {
        open--;
        closeSync();
      };
      return handle;
    }) as typeof fs.opendirSync);
    try {
      const files = await loadArchive(exportDir);
      expect(files['d0/d1/d2/d3/d4/d5/d6/d7/conversations.json']).toBe('[]');
      expect(maxOpen).toBe(1);
      expect(open).toBe(0); // every handle closed
    } finally {
      spy.mockRestore();
    }
  });
});

describe('wanted — the allow-list is unchanged', () => {
  it('selects exactly the export files', () => {
    expect(wanted('conversations.json')).toBe(true);
    expect(wanted('nested/users.json')).toBe(true);
    expect(wanted('Takeout/Gemini/Conversation History/chat 1.txt')).toBe(true);
    expect(wanted('Takeout/Gemini/gemini_gems_data.html')).toBe(true);
    expect(wanted('image.png')).toBe(false);
    expect(wanted('random.txt')).toBe(false);
  });

  it('handles an adversarially long repeated archive name without regex backtracking', () => {
    const repeated = 'Conversation History/'.repeat(30_000);
    expect(wanted(`${repeated}chat.txt`)).toBe(true);
    expect(wanted(`${repeated}chat.bin`)).toBe(false);
    expect(wanted('Takeout/Conversation History/chat\n.txt')).toBe(false);
  });
});
