import fs from 'node:fs';
import path from 'node:path';
import type { SourceFiles } from '@sthayi/core';
import yauzl from 'yauzl';

/**
 * Aggregate trust-boundary limits, enforced BEFORE any content is buffered or parsed and long
 * before any store transaction opens. Claude's conversations.json can be ~200 MB uncompressed —
 * the byte cap leaves headroom for it while refusing decompression bombs.
 */
export interface ImportLimits {
  /** total bytes of selected (allow-listed) content across the whole archive */
  totalBytes: number;
  /** entries examined per archive (files + directories) */
  entries: number;
  /** path segments per entry — deeper trees are hostile, not exports */
  pathDepth: number;
  /** zip expansion guard: uncompressed:compressed per selected entry */
  compressionRatio: number;
}

export const IMPORT_LIMITS: ImportLimits = {
  totalBytes: 256 * 1024 * 1024,
  entries: 10_000,
  pathDepth: 16,
  compressionRatio: 100,
};

const FLAT_FILES = new Set(['conversations.json', 'users.json', 'memories.json', 'user.json']);

/** Which archive entries we read (skip binaries, media, and unrelated files). */
export function wanted(name: string): boolean {
  const base = name.split('/').pop() ?? name;
  if (FLAT_FILES.has(base)) {
    return true;
  }
  if (
    name.includes('Conversation History/') &&
    name.endsWith('.txt') &&
    !name.includes('\n') &&
    !name.includes('\r') &&
    !name.includes('\u2028') &&
    !name.includes('\u2029')
  ) {
    return true;
  }
  if (name.endsWith('gemini_gems_data.html')) {
    return true;
  }
  return false;
}

export interface LoadOptions {
  /** receives one line per skipped-but-suspicious entry (symlinks, hostile names) */
  warn?: (msg: string) => void;
  /** test seam only — production callers always run with IMPORT_LIMITS */
  limits?: Partial<ImportLimits>;
}

/** Running aggregate-limit enforcement shared by the dir and zip loaders. Violations THROW —
 *  a hostile archive is refused whole, never partially imported. */
class ImportBudget {
  private bytes = 0;
  private entries = 0;
  constructor(private readonly limits: ImportLimits) {}

  countEntry(name: string): void {
    this.entries += 1;
    if (this.entries > this.limits.entries) {
      throw new Error(
        `import refused: archive contains more than ${this.limits.entries} entries — this does not look like a chat export`,
      );
    }
    const depth = name.split('/').filter((s) => s.length > 0).length;
    if (depth > this.limits.pathDepth) {
      throw new Error(
        `import refused: entry ${name} is nested more than ${this.limits.pathDepth} path segments deep — this does not look like a chat export`,
      );
    }
  }

  addBytes(n: number, name: string): void {
    this.assertFits(n, name);
    this.bytes += n;
  }

  /** Non-consuming fit check — the declared-size fast-fail before a read starts. */
  assertFits(n: number, name: string): void {
    if (this.bytes + n > this.limits.totalBytes) {
      throw new Error(
        `import refused: selected content exceeds the ${Math.floor(this.limits.totalBytes / (1024 * 1024))} MiB total size limit (at ${name}) — nothing was imported`,
      );
    }
  }

  /** Bytes left of the aggregate budget — the read loop's hard cap. */
  remaining(): number {
    return this.limits.totalBytes - this.bytes;
  }
}

function resolveLimits(opts: LoadOptions): ImportLimits {
  return { ...IMPORT_LIMITS, ...opts.limits };
}

/**
 * Load an export as a map of entry-path → text. Accepts a `.zip` or an already-extracted folder.
 * The archive path itself is the user's explicit choice; everything INSIDE it is untrusted:
 * symlinked entries are SKIPPED rather than resolved, hostile entry names are skipped with a
 * warning, and the aggregate limits above are enforced before any parse.
 *
 * Precisely (see loadDir/readSelectedFile for the mechanics, and the residual named there): the
 * folder loader skips symlink dirents, refuses a directory that stopped being a real directory
 * before it descends, opens every selected file with O_NOFOLLOW through a canonical parent it
 * has just validated as contained, and refuses the file unless the opened descriptor is the
 * very inode the enumeration classified.
 */
export async function loadArchive(
  archivePath: string,
  opts: LoadOptions = {},
): Promise<SourceFiles> {
  const stat = fs.statSync(archivePath);
  return stat.isDirectory() ? loadDir(archivePath, opts) : loadZip(archivePath, opts);
}

const READ_CHUNK = 64 * 1024;

/**
 * Read one SELECTED file with the single-open discipline: opened exactly ONCE with O_NOFOLLOW
 * (a symlink swapped in after the dirent check is refused by the kernel at open time, not by a
 * racy path re-check), classified via fstat ON THAT DESCRIPTOR (regular file, single hard link,
 * declared size — never a second path-based stat), and read THROUGH the same descriptor with the
 * remaining aggregate budget enforced DURING the read: the loop reads at most remaining+1 bytes
 * (the +1 sentinel), so a file that GROWS between fstat and read still cannot pull the import
 * past the budget or buffer meaningfully beyond it.
 *
 * IDENTITY PIN (`expected`): O_NOFOLLOW protects the FINAL path component ONLY, so an ancestor
 * re-pointed at an outside directory after the caller's containment check hands us a completely
 * different file at a path that still reads as contained. The caller pins the
 * inode it classified BEFORE any of that re-derivation, and the fstat below refuses anything
 * whose (dev, ino) is not that exact file. Paths can be re-pointed under us; an inode cannot.
 *
 * Returns undefined (with a warning) for suspicious-but-skippable entries; THROWS on any budget
 * violation — hostile input refuses the whole import, never a partial one.
 */
function readSelectedFile(
  fullPath: string,
  rel: string,
  budget: ImportBudget,
  limits: ImportLimits,
  warn: (msg: string) => void,
  expected: fs.Stats,
): string | undefined {
  // O_NONBLOCK alongside O_NOFOLLOW: a regular file swapped for a FIFO after the dirent
  // classification must not make openSync BLOCK waiting for a writer — the nonblocking open
  // returns immediately and the fstat below classifies (and refuses) the non-regular file.
  const flags =
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
  let fd: number;
  try {
    fd = fs.openSync(fullPath, flags);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'EMLINK' || code === 'ENOENT') {
      // O_NOFOLLOW rejects a symlink at open time (ELOOP; EMLINK on some BSDs); ENOENT means
      // the entry vanished after enumeration. Either way: skip it — a symlink at the final
      // component is refused by the kernel, never resolved.
      warn(
        `import: skipping ${rel} — it is a symlink (or vanished before it could be opened), and a symlinked entry is skipped, never read through`,
      );
      return undefined;
    }
    throw err;
  }
  try {
    const st = fs.fstatSync(fd);
    if (st.dev !== expected.dev || st.ino !== expected.ino) {
      // The descriptor is NOT the inode the enumeration classified: something moved under us
      // between classification and open (the ancestor-swap race O_NOFOLLOW cannot see).
      warn(
        `import: skipping ${rel} — it is not the file that was found in the selected folder (it changed identity before it could be opened, possible hijack)`,
      );
      return undefined;
    }
    if (!st.isFile()) {
      warn(`import: skipping ${rel} — it is not a regular file`);
      return undefined;
    }
    if (st.nlink > 1) {
      warn(
        `import: skipping ${rel} — it has ${st.nlink} hard links, and multiply-linked files are refused`,
      );
      return undefined;
    }
    // Fast-fail on the declared size before reading a byte (same refusal as the aggregate cap)…
    budget.assertFits(st.size, rel);
    // …then trust only the bytes actually read: cap the loop at remaining+1.
    const remaining = budget.remaining();
    const cap = remaining + 1;
    const buf = Buffer.alloc(Math.min(READ_CHUNK, cap));
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, cap - total), null);
      if (n === 0) {
        break;
      }
      total += n;
      if (total > remaining) {
        throw new Error(
          `import refused: ${rel} produced more bytes than the ${Math.floor(limits.totalBytes / (1024 * 1024))} MiB total size limit allows (it changed while being read) — nothing was imported`,
        );
      }
      chunks.push(Buffer.from(buf.subarray(0, n)));
    }
    budget.addBytes(total, rel);
    return Buffer.concat(chunks, total).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function loadDir(dir: string, opts: LoadOptions): SourceFiles {
  const warn = opts.warn ?? (() => {});
  const limits = resolveLimits(opts);
  const budget = new ImportBudget(limits);
  const files: SourceFiles = {};
  // Containment anchor: the export root as the USER chose it (their own symlink here is fine —
  // the path is their explicit selection); everything below is untrusted and must resolve
  // beneath this.
  const rootReal = fs.realpathSync(dir);
  const walk = (current: string): void => {
    // INCREMENTAL enumeration (opendirSync + readSync), never readdirSync: a hostile folder
    // with millions of entries must trip the entry limit WHILE the directory is being read,
    // not after every name has been materialized into one array in this process. Sub-
    // directories are collected and descended AFTER the handle is closed, so the recursion
    // holds exactly one open directory handle at any depth; the try/finally closes it on every
    // exit, including the throw from budget.countEntry that refuses a hostile archive.
    const subdirs: string[] = [];
    const handle = fs.opendirSync(current);
    try {
      for (;;) {
        const entry = handle.readSync();
        if (entry === null) {
          break;
        }
        const full = path.join(current, entry.name);
        const rel = path.relative(dir, full).split(path.sep).join('/');
        budget.countEntry(rel);
        if (entry.isSymbolicLink()) {
          // Skipped, not resolved — a planted link (conversations.json → ~/.ssh/id_ed25519, or
          // a dir link escaping the selected folder) must not smuggle external content in.
          warn(
            `import: skipping ${rel} — it is a symlink, and a symlinked entry is skipped rather than resolved`,
          );
          continue;
        }
        if (entry.isDirectory()) {
          subdirs.push(full);
          continue;
        }
        if (entry.isFile()) {
          readSelected(full, rel);
        }
        // anything else (fifo, socket, device) is silently irrelevant to an export
      }
    } finally {
      handle.closeSync();
    }
    for (const full of subdirs) {
      const rel = path.relative(dir, full).split(path.sep).join('/');
      // The Dirent is STALE by the time we descend: a classified child dir swapped for an
      // outside symlink after the enumeration would be FOLLOWED by a path-based recursion. So
      // re-lstat immediately before descending and refuse anything that is no longer a real
      // directory. HONEST RESIDUAL: this lstat and the opendirSync inside walk() are separate
      // path-based syscalls — a swap that wins that narrower window can still be traversed;
      // the containment check plus the inode pin on every selected-file read (below) fail
      // closed on what this cannot catch. There is no portable O_NOFOLLOW/openat directory-
      // handle API in Node to eliminate the window outright.
      let st: fs.Stats;
      try {
        st = fs.lstatSync(full);
      } catch {
        continue; // vanished after enumeration — nothing to descend into
      }
      if (st.isSymbolicLink() || !st.isDirectory()) {
        warn(
          `import: skipping ${rel} — it changed underneath the import (no longer a real directory) and was not traversed`,
        );
        continue;
      }
      walk(full);
    }
  };
  /** Validate containment, then read ONE selected file through the validated canonical path. */
  function readSelected(full: string, rel: string): void {
    if (!wanted(rel)) {
      return;
    }
    // PIN THE TARGET FIRST — before any path is re-derived or re-resolved. Everything below
    // works with paths, and a path can be re-pointed under us between two syscalls; the inode
    // recorded here is what the open must actually land on (checked by fstat in
    // readSelectedFile). Taken before the realpath so a swap that lands in ANY of the windows
    // below is caught by either the containment check or the identity check.
    //
    // The (dev, ino) half of that pin is a POSIX guarantee: Windows does not expose a stable
    // inode through fs.Stats, so there the containment check and the O_NOFOLLOW open carry the
    // defence alone (same platform scope as the fs-safe trust boundary — see its header).
    let pinned: fs.Stats;
    try {
      pinned = fs.lstatSync(full);
    } catch {
      return; // vanished after enumeration — nothing to read
    }
    // Containment re-check at read time: the file's DIRECTORY must resolve beneath the export
    // root — catches an ancestor swapped to an outside symlink after its descend-time lstat.
    let parentReal: string;
    try {
      parentReal = fs.realpathSync(path.dirname(full));
    } catch {
      return; // directory vanished — the file cannot be read either
    }
    if (parentReal !== rootReal && !parentReal.startsWith(rootReal + path.sep)) {
      warn(
        `import: skipping ${rel} — its directory resolved outside the selected folder (possible hijack)`,
      );
      return;
    }
    // Open THROUGH THE VALIDATED CANONICAL PARENT, never the original logical ancestor chain:
    // realpath only INSPECTED that chain, and re-opening it would resolve every one of its
    // components a second time — the window in which a logical ancestor is re-pointed at an
    // outside directory. The canonical path contained no symlink component at validation time,
    // and the inode pin above refuses the read outright if what we open is not the file the
    // enumeration classified.
    //
    // HONEST RESIDUAL: this is still a path-based open, so an attacker who can write inside the
    // user's selected folder could in principle re-point a component of the canonical parent
    // between the realpath and the open AND arrange for the swapped-in target to be the pinned
    // inode — i.e. serve us the same file, which is not an escape. What remains truly
    // unresolvable without openat(2) is a swap-and-restore that re-points a canonical ancestor
    // and puts it back before the fstat; nothing in Node's fs API closes that.
    const text = readSelectedFile(
      path.join(parentReal, path.basename(full)),
      rel,
      budget,
      limits,
      warn,
      pinned,
    );
    if (text !== undefined) {
      files[rel] = text;
    }
  }
  walk(dir);
  return files;
}

/** Unix mode bits live in the high 16 bits of a zip entry's external attributes. */
function isSymlinkZipEntry(entry: yauzl.Entry): boolean {
  return ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000;
}

/** Absolute (POSIX or Windows) or `..`-traversing entry names are hostile input — we never
 *  extract to disk, but such names must not even reach the parsers under a trusted-looking key. */
function isHostileEntryName(name: string): boolean {
  return /^([A-Za-z]:)?[\\/]/.test(name) || name.split(/[\\/]/).includes('..');
}

function loadZip(zipPath: string, opts: LoadOptions): Promise<SourceFiles> {
  const warn = opts.warn ?? (() => {});
  const limits = resolveLimits(opts);
  const budget = new ImportBudget(limits);
  return new Promise((resolve, reject) => {
    const files: SourceFiles = {};
    let settled = false;
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) {
        reject(err ?? new Error(`cannot open zip: ${zipPath}`));
        return;
      }
      const fail = (failErr: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        try {
          zip.close();
        } catch {
          // already closed
        }
        reject(failErr);
      };
      zip.on('entry', (entry) => {
        if (settled) {
          return;
        }
        // Aggregate limits and containment guards run BEFORE any bytes of the entry are read.
        try {
          budget.countEntry(entry.fileName);
        } catch (limitErr) {
          fail(limitErr as Error);
          return;
        }
        if (entry.fileName.endsWith('/')) {
          zip.readEntry();
          return;
        }
        if (isHostileEntryName(entry.fileName)) {
          warn(
            `import: skipping ${entry.fileName} — absolute or ..-traversing entry names are refused`,
          );
          zip.readEntry();
          return;
        }
        if (isSymlinkZipEntry(entry)) {
          // Nothing is ever extracted to disk, so a zip symlink entry is literally never
          // resolved: its target string is dropped along with the entry.
          warn(
            `import: skipping ${entry.fileName} — it is a symlink entry, and symlink entries are never resolved`,
          );
          zip.readEntry();
          return;
        }
        if (!wanted(entry.fileName)) {
          zip.readEntry();
          return;
        }
        // Expansion guard from central-directory metadata, before opening the read stream.
        if (
          entry.compressedSize > 0 &&
          entry.uncompressedSize / entry.compressedSize > limits.compressionRatio
        ) {
          fail(
            new Error(
              `import refused: zip entry ${entry.fileName} expands more than ${limits.compressionRatio}:1 (${entry.uncompressedSize} bytes from ${entry.compressedSize}) — this looks like a decompression bomb`,
            ),
          );
          return;
        }
        try {
          budget.addBytes(entry.uncompressedSize, entry.fileName);
        } catch (limitErr) {
          fail(limitErr as Error);
          return;
        }
        zip.openReadStream(entry, (streamErr, stream) => {
          if (settled) {
            return;
          }
          if (streamErr || !stream) {
            // A SELECTED entry we cannot read cleanly is a refusal, not a silent skip — lying
            // local headers must not quietly drop the very file the user asked to import.
            fail(
              new Error(
                `import refused: could not read zip entry ${entry.fileName} (${streamErr?.message ?? 'no stream'}) — extract the archive yourself and import the folder if the export is merely damaged`,
              ),
            );
            return;
          }
          const chunks: Buffer[] = [];
          let received = 0;
          stream.on('data', (c: Buffer) => {
            received += c.length;
            if (received > entry.uncompressedSize) {
              // Headers lied — the declared size cleared the budget, the stream must not exceed it.
              stream.destroy();
              fail(
                new Error(
                  `import refused: zip entry ${entry.fileName} produced more bytes than its declared size — this looks like a decompression bomb`,
                ),
              );
              return;
            }
            chunks.push(c);
          });
          stream.on('end', () => {
            if (settled) {
              return;
            }
            files[entry.fileName] = Buffer.concat(chunks).toString('utf8');
            zip.readEntry();
          });
          stream.on('error', (err: Error) => {
            fail(
              new Error(
                `import refused: could not read zip entry ${entry.fileName} (${err.message}) — extract the archive yourself and import the folder if the export is merely damaged`,
              ),
            );
          });
        });
      });
      zip.on('end', () => {
        if (!settled) {
          settled = true;
          resolve(files);
        }
      });
      zip.on('error', (zipErr: Error) => fail(zipErr));
      zip.readEntry();
    });
  });
}
