import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** The MCP server name Sthayi writes into every client config. */
export const SERVER_NAME = 'sthayi';

/**
 * "An entry named sthayi exists" and "correctly wired" are different facts.
 * - 'absent'  — no sthayi entry in the config
 * - 'broken'  — a sthayi entry exists but does not match the canonical launcher wiring
 *               (wrong/missing command, wrong args, or unparseable config that names sthayi)
 * - 'wired'   — the entry matches the canonical launcher command and args exactly
 */
export type WireState = 'absent' | 'broken' | 'wired';

export interface InspectResult {
  state: WireState;
  /** the command currently present in the sthayi entry, when one could be parsed */
  command?: string;
  /** human-readable reason when state is 'broken' */
  detail?: string;
}

export interface WireResult {
  id: string;
  label: string;
  configPath: string;
  detected: boolean;
  /** did this operation actually change the config on disk? */
  changed: boolean;
  /** is Sthayi present in the config after the operation? */
  wired: boolean;
  dryRun: boolean;
  backupPath?: string;
  message: string;
}

export interface ClientAdapter {
  readonly id: string;
  readonly label: string;
  /** absolute path to this client's config file */
  configPath(): string;
  /** is this client installed on this machine? */
  detect(): boolean;
  /** is Sthayi already wired into the config? (state === 'wired') */
  isWired(): boolean;
  /** tri-state wiring diagnosis: absent | broken | wired */
  inspect(): InspectResult;
  wire(opts?: { dryRun?: boolean }): WireResult;
  unwire(opts?: { dryRun?: boolean }): WireResult;
}

/** Filesystem-safe ISO timestamp for backup filenames. */
export function backupStamp(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, '-');
}

/** SHA-256 hex of config content. Wire records what it wrote so unwire can detect drift. */
export function contentHash(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Trust-boundary check for a config write destination (mirrors the launcher's persistLauncher
 * discipline): the target must be absent or a regular file — NEVER a symlink, which a hostile
 * process could plant to steer our rename/backup at an external file — and its parent must be a
 * real directory (a symlinked parent would land the temp file, the rename, and the backup in an
 * attacker-chosen tree). Returns an actionable reason when unsafe, undefined when safe. lstat
 * only — nothing is followed, nothing is modified.
 */
export function unsafeConfigPathReason(target: string): string | undefined {
  const parent = path.dirname(target);
  let pst: fs.Stats | undefined;
  try {
    pst = fs.lstatSync(parent);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return `config directory ${parent} could not be inspected (${(err as NodeJS.ErrnoException).code ?? 'unknown error'})`;
    }
    // parent absent — the write path creates it as a real directory
  }
  if (pst) {
    if (pst.isSymbolicLink()) {
      return `config directory ${parent} is a symlink (possible hijack) — refusing to write through it; replace it with a real directory (nothing was modified)`;
    }
    if (!pst.isDirectory()) {
      return `config directory ${parent} is not a directory — remove whatever occupies that path (nothing was modified)`;
    }
  }
  let st: fs.Stats | undefined;
  try {
    st = fs.lstatSync(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return `config file ${target} could not be inspected (${(err as NodeJS.ErrnoException).code ?? 'unknown error'})`;
    }
    return undefined; // absent target in a real directory — safe to create
  }
  if (st.isSymbolicLink()) {
    return `config file ${target} is a symlink (possible hijack) — refusing to write through or replace it; replace the symlink with a regular file (the link and its target were not touched)`;
  }
  if (!st.isFile()) {
    return `config file ${target} is not a regular file — remove whatever occupies that path (nothing was modified)`;
  }
  return undefined;
}

/** Is `p` a regular file (lstat — a symlink is NOT), swallowing absence? Backup restore reads
 *  must never follow a symlink swapped in at the recorded backup path. */
export function isRegularFile(p: string): boolean {
  try {
    return fs.lstatSync(p).isFile();
  } catch {
    return false;
  }
}

const WRITE_ATTEMPTS = 8;

/**
 * Write `content` atomically with the hardened-launcher discipline: validate the target and its
 * parent (no-follow — see unsafeConfigPathReason), then exclusive-create ('wx') a RANDOM temp
 * name in the SAME directory and rename it over the target. A preplanted file or symlink at any
 * predictable temp path is moot (the name is random and 'wx' never follows or truncates an
 * existing path); an actual name collision simply regenerates. Preserves the target's existing
 * permission bits — client configs routinely hold OTHER MCP servers' API keys, so a default-mode
 * (0644) temp file would silently relax a 0600 config to world-readable on rename. New files
 * keep the platform default.
 */
export function atomicWrite(target: string, content: string): void {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const reason = unsafeConfigPathReason(target);
  if (reason) {
    throw new Error(`refusing to write: ${reason}`);
  }
  let mode: number | undefined;
  try {
    mode = fs.lstatSync(target).mode & 0o777;
  } catch {
    // target doesn't exist yet (new config) — leave the default mode
  }
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    const tmp = path.join(
      dir,
      `.${path.basename(target)}.${crypto.randomBytes(6).toString('hex')}.sthayi-tmp`,
    );
    let fd: number | undefined;
    try {
      fd = fs.openSync(tmp, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        continue; // collision with a squatting file/symlink — regenerate, never reuse
      }
      throw err;
    }
    try {
      fs.writeSync(fd, content);
      if (mode !== undefined) {
        fs.fchmodSync(fd, mode);
      }
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(tmp, target); // rename replaces the path, never follows a link
      return;
    } catch (err) {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // already closed
        }
      }
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // best-effort tmp cleanup — the original error is the one worth surfacing
      }
      throw err;
    }
  }
  throw new Error(
    `refusing to write ${target}: could not create a unique temporary file in ${dir} after ${WRITE_ATTEMPTS} attempts — remove the .sthayi-tmp debris squatting there and retry`,
  );
}

/**
 * Copy `src` to a timestamped backup next to it with the same discipline as atomicWrite:
 * exclusive create (COPYFILE_EXCL — a preplanted file or symlink at the predictable
 * `.sthayi-bak-<stamp>` name is never followed or overwritten), regenerating with a random
 * suffix on collision. Returns the backup path actually written.
 */
export function createBackup(src: string, now: number): string {
  const base = `${src}.sthayi-bak-${backupStamp(now)}`;
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    const candidate = attempt === 0 ? base : `${base}-${crypto.randomBytes(4).toString('hex')}`;
    try {
      fs.copyFileSync(src, candidate, fs.constants.COPYFILE_EXCL);
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        continue; // something squats on the candidate name — regenerate, never overwrite
      }
      throw err;
    }
  }
  throw new Error(
    `refusing to back up ${src}: every candidate backup name already exists — remove the stale .sthayi-bak files and retry`,
  );
}
