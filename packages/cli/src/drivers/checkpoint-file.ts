import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { CheckpointStore } from '@sthayi/core';
import {
  assertTrustedContainingDirReadOnly,
  ensureTrustedContainingDir,
  untrustedContainingDirReason,
} from '../fs-safe.js';

/**
 * File-backed CheckpointStore at `~/.sthayi/journal.checkpoint`: the journal
 * checkpoint copy that lives OUTSIDE the database, so replacing the whole db file with an
 * older, internally-valid snapshot is still detected. Written tmp-then-rename (atomic on the
 * same filesystem — concurrent writers never interleave partial content), mode 0600.
 *
 * FAIL CLOSED: this file is a trust anchor, so both read and write lstat-validate the path
 * first — it must be absent or a regular file owned by us that is not group/world-writable,
 * and NEVER a symlink. Any violation (and any read error other than absence) THROWS instead
 * of degrading to "no checkpoint": JournalService.verify() turns the throw into a verification
 * failure, and seal() refuses to auto-seal through it.
 *
 * REPLACEMENT IS COMPARE-AND-SWAP (`replace`). Callers read the file, validate what they got, and
 * only then replace it; the destination can change in between. So `replace` takes the exact
 * expected old bytes, RE-READS the destination under an interprocess lock with the descriptor
 * discipline of fs-safe's `safeReadTextFile` (O_NOFOLLOW open, fstat re-validation on the open fd,
 * capped read), and writes only while the current bytes still equal the expectation. A destination
 * that changed is left BYTE-IDENTICAL and the call returns false, so tamper evidence survives and
 * verification stays red.
 *
 * THE LOCK IS NEVER RECLAIMED AUTOMATICALLY. A lock file whose holder crashed stays exactly where
 * it is, and every subsequent replacement FAILS CLOSED with the holder's recorded pid and the
 * platform-appropriate, safely quoted command needed to clear it. Age-based reclamation was
 * strictly worse than that: deciding
 * "abandoned" meant `lstat` -> compare mtime -> `unlink`, three separate operations against a NAME,
 * and in the window between them the old holder can release and a new one acquire — so the
 * reclaimer deleted a LIVE peer's lock on the strength of an age it read from an inode that no
 * longer occupied the path, and then wrote through the hole. Node (22) exposes no `flock`, so there
 * is no kernel-released advisory lock to fall back on; refusing to guess is the remaining honest
 * option. See `releaseLock` for why the one surviving unlink cannot be raced the same way.
 *
 * HONEST BOUNDARY — the lock is NOT a security boundary. It serializes COOPERATIVE Sthayi writers
 * (this process against another `sthayi` process) so they cannot clobber each other's evidence.
 * It cannot constrain a MALICIOUS process running as the same user: that attacker can take the
 * lock itself, delete it, or swap the file between our fstat and the rename, exactly as it can
 * already read the vault key and rewrite the database directly. The 0700 home boundary is what
 * excludes OTHER unprivileged users; against the user's own compromised processes the guarantee
 * offered here is narrower and deliberate — a same-user race can win, but it cannot win SILENTLY
 * by riding on Sthayi's own innocent writes, which is what the unconditional write allowed.
 */

/** O_NOFOLLOW where the platform provides it (POSIX); 0 (no-op) where it does not (Windows). */
const O_NOFOLLOW: number =
  (fs.constants as unknown as Record<string, number | undefined>).O_NOFOLLOW ?? 0;

/** A checkpoint is ~150 bytes. The cap bounds a hostile "grow the file" read to something the
 *  process can always hold, and is enforced at the DESCRIPTOR level (fstat size + a capped read
 *  loop with a limit+1 sentinel), so a file that grows after the fstat is refused too. */
const READ_CAP_BYTES = 64 * 1024;

/** How long a replacement waits for a lock another writer holds before failing closed. */
const DEFAULT_LOCK_WAIT_MS = 5_000;
/** Poll interval while waiting on a live lock. */
const LOCK_POLL_MS = 5;
/** Cap on the diagnostic read of a foreign lock file (ours holds `<pid>\n`). Bounds a hostile
 *  "grow the lock file" from turning an error message into a memory problem. */
const LOCK_DIAGNOSTIC_CAP = 64;

/** Synchronous sleep — everything on this path is sync, and Atomics.wait is the only correct
 *  way to block a worker thread without spinning the CPU (same technique as tests/helpers). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** A copy/pasteable manual recovery command that treats the lock path as data, not shell syntax. */
export function manualCheckpointLockRemoval(
  lock: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    // PowerShell single-quoted literals escape a quote by doubling it. `-LiteralPath` prevents
    // wildcard characters in a user's home path from selecting any neighbouring file.
    return `PowerShell: Remove-Item -LiteralPath '${lock.replace(/'/g, "''")}'`;
  }
  // POSIX single quotes make every character literal; the three-token splice represents one
  // embedded quote. `--` also keeps a leading dash in the path from becoming an rm option.
  return `rm -- '${lock.replace(/'/g, `'"'"'`)}'`;
}

export interface FileCheckpointOptions {
  /** Max wait for a contended lock before failing closed (default 5s). There is deliberately no
   *  "staleness" knob: a lock is never reclaimed on a timer, at any age. */
  lockWaitMs?: number;
}

export class FileCheckpoint implements CheckpointStore {
  private readonly lockWaitMs: number;

  constructor(
    private readonly file: string,
    opts: FileCheckpointOptions = {},
  ) {
    this.lockWaitMs = opts.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
  }

  /**
   * The trust checks themselves, shared by the lstat (path) and fstat (open descriptor) forms so
   * the two can never drift: a checkpoint the path check accepted and the descriptor check would
   * reject (or vice versa) would make the compare-and-swap compare against bytes it would not have
   * been willing to read. Anything present must be a regular file (never a symlink — lstat does
   * not follow, so a planted link can never redirect our read or write), owned by the current
   * user, and not group/world-writable. POSIX ownership/mode checks are meaningless on Windows and
   * are skipped there.
   */
  private assertSafeStat(st: fs.Stats, p: string, what: string): void {
    if (st.isSymbolicLink()) {
      throw new Error(
        `journal ${what} at ${p} is a symlink — refusing to follow it; replace it with a regular file or delete it`,
      );
    }
    if (!st.isFile()) {
      throw new Error(
        `journal ${what} at ${p} is not a regular file — refusing to use it; remove whatever occupies that path`,
      );
    }
    if (process.platform !== 'win32') {
      if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
        throw new Error(
          `journal ${what} at ${p} is not owned by the current user — refusing to use it; restore ownership or delete the file`,
        );
      }
      if ((st.mode & 0o022) !== 0) {
        throw new Error(
          `journal ${what} at ${p} is group- or world-writable — refusing to use it; run: chmod 600 ${p}`,
        );
      }
    }
  }

  /**
   * lstat-validate `p` before touching it. Absent is fine (returns). Anything present must pass
   * assertSafeStat above.
   */
  private assertSafePath(p: string, what: string): void {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return; // absent — a legitimate state for both read (undefined) and write (create)
      }
      throw new Error(
        `journal ${what} at ${p} could not be inspected (${(err as NodeJS.ErrnoException).code ?? 'unknown error'}) — refusing to use it`,
      );
    }
    this.assertSafeStat(st, p, what);
  }

  /**
   * Read the checkpoint with the two-layer TOCTOU discipline of fs-safe's `safeReadTextFile`:
   * the lstat gate refuses anything already hostile, then the open itself uses O_NOFOLLOW (where
   * available) and the SAME checks are repeated via fstat ON THE OPEN FD — a path swapped between
   * the lstat and the open cannot redirect the read, because what is validated is the very inode
   * held open. The read is byte-capped twice (fstat size fast-fail plus a capped loop with a
   * limit+1 sentinel), so a file that grows mid-read is refused rather than buffered past the cap.
   *
   * This is what `replace` compares against under the lock; `read()` uses it too so the value a
   * caller passes as `expected` is produced by exactly the same rules the comparison applies.
   */
  private readTrusted(): string | undefined {
    // The ancestor chain first: O_NOFOLLOW refuses a symlink at the FINAL component only, so a
    // symlinked directory anywhere above it would still serve a checkpoint from an unvalidated
    // tree. An absent containing directory means there is genuinely no external copy.
    if (untrustedContainingDirReason(this.file, 'journal checkpoint file') === 'absent') {
      return undefined;
    }
    assertTrustedContainingDirReadOnly(this.file, 'journal checkpoint file');
    this.assertSafePath(this.file, 'checkpoint file');
    let fd: number;
    try {
      fd = fs.openSync(this.file, fs.constants.O_RDONLY | O_NOFOLLOW);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return undefined; // absent (raced away after the lstat) — genuinely "no external copy"
      }
      if (code === 'ELOOP') {
        throw new Error(
          `journal checkpoint file at ${this.file} is a symlink — refusing to follow it; replace it with a regular file or delete it`,
        );
      }
      // Unreadable is NOT absent: the caller's fail-closed path (verify/seal) must see this.
      throw err;
    }
    try {
      const st = fs.fstatSync(fd);
      this.assertSafeStat(st, this.file, 'checkpoint file');
      if (st.size > READ_CAP_BYTES) {
        throw new Error(
          `journal checkpoint file at ${this.file} is ${st.size} bytes — over the ${READ_CAP_BYTES}-byte cap; refusing to read it (repair or delete the file)`,
        );
      }
      const buf = Buffer.alloc(READ_CAP_BYTES + 1);
      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        const n = fs.readSync(fd, buf, 0, READ_CAP_BYTES + 1 - total, null);
        if (n === 0) {
          break;
        }
        total += n;
        if (total > READ_CAP_BYTES) {
          throw new Error(
            `journal checkpoint file at ${this.file} produced more than the ${READ_CAP_BYTES}-byte cap (it grew while being read) — refusing to read it`,
          );
        }
        chunks.push(Buffer.from(buf.subarray(0, n)));
      }
      return Buffer.concat(chunks, total).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  }

  private lockPath(): string {
    return `${this.file}.lock`;
  }

  /**
   * Best-effort, byte-capped read of the pid a foreign lock recorded — diagnostics for the
   * fail-closed message ONLY, never a decision input. It is deliberately not used to test whether
   * the holder is alive: pids are reused, so "no such process" is not proof of abandonment, and
   * acting on it would reintroduce exactly the reclamation guess this driver removed.
   */
  private recordedHolder(lock: string): string | undefined {
    let fd: number;
    try {
      fd = fs.openSync(lock, fs.constants.O_RDONLY | O_NOFOLLOW);
    } catch {
      return undefined;
    }
    try {
      const buf = Buffer.alloc(LOCK_DIAGNOSTIC_CAP);
      const n = fs.readSync(fd, buf, 0, LOCK_DIAGNOSTIC_CAP, 0);
      const pid = buf.subarray(0, n).toString('utf8').split('\n')[0]?.trim();
      return pid !== undefined && /^[0-9]{1,10}$/.test(pid) ? pid : undefined;
    } catch {
      return undefined;
    } finally {
      fs.closeSync(fd);
    }
  }

  /** The fail-closed refusal, carrying everything a human needs to clear the lock BY HAND — since
   *  nothing will ever clear it for them. */
  private heldError(lock: string): Error {
    const pid = this.recordedHolder(lock);
    const holder = pid === undefined ? '' : ` (recorded holder pid ${pid})`;
    const recovery = manualCheckpointLockRemoval(lock);
    return new Error(
      `journal checkpoint lock at ${lock} is held by another writer${holder} — refusing to replace the checkpoint file after waiting ${this.lockWaitMs}ms. This lock is NEVER reclaimed automatically: retry, or, once you have confirmed no sthayi process is running, clear it by hand: ${recovery}`,
    );
  }

  /**
   * Exclusive-create lock file next to the checkpoint. O_EXCL makes creation itself the mutex, and
   * O_NOFOLLOW means a planted symlink at the lock path is refused rather than followed.
   *
   * NOTHING HERE EVER REMOVES A LOCK IT DID NOT CREATE. A lock that is present is waited on up to
   * `lockWaitMs` and then FAILS CLOSED — regardless of its age, its mtime, or which pid it names.
   * The lstat below only IDENTIFIES what is squatting the path (a symlink or a non-regular file is
   * a refusal, not a wait); it can never lead to an unlink, so the "observed, then acted on a name"
   * window that let a reclaimer delete a live peer's lock does not exist.
   */
  private acquireLock(): number {
    const lock = this.lockPath();
    const deadline = Date.now() + this.lockWaitMs;
    for (;;) {
      try {
        const fd = fs.openSync(
          lock,
          fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | O_NOFOLLOW,
          0o600,
        );
        try {
          fs.writeSync(fd, `${process.pid}\n`);
        } catch {
          // the lock IS the file's existence; the pid inside is only a diagnostic hint
        }
        return fd;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ELOOP') {
          throw new Error(
            `journal checkpoint lock at ${lock} is a symlink — refusing to follow it; delete it`,
          );
        }
        if (code !== 'EEXIST') {
          throw err;
        }
        const st = fs.lstatSync(lock, { throwIfNoEntry: false });
        if (st !== undefined) {
          if (st.isSymbolicLink()) {
            // O_EXCL|O_CREAT reports EEXIST (not ELOOP) for a symlink already at the path, so the
            // link is identified here rather than followed — nothing was opened or written.
            throw new Error(
              `journal checkpoint lock at ${lock} is a symlink — refusing to follow it; delete it`,
            );
          }
          if (!st.isFile()) {
            throw new Error(
              `journal checkpoint lock at ${lock} is not a regular file — refusing to use it; remove whatever occupies that path`,
            );
          }
        }
        // st === undefined means it was released between our open and the stat: retry at once
        // rather than sleeping, but still inside the same bounded wait.
        if (Date.now() >= deadline) {
          throw this.heldError(lock);
        }
        if (st !== undefined) {
          sleepSync(LOCK_POLL_MS);
        }
      }
    }
  }

  /**
   * Release the lock WE acquired — and never anything else.
   *
   * `unlink` names a PATH, not an inode. Unlinking unconditionally deletes whatever currently
   * occupies the lock name — which is how a resumed holder destroys a NEWER holder's lock.
   * The guard is therefore taken on OUR OWN OPEN DESCRIPTOR rather than by re-inspecting the path:
   * `fstat(fd).nlink` counts the directory entries pointing at the inode we created with
   * O_CREAT|O_EXCL, and exactly one entry was ever made for it — the lock path.
   *
   *   nlink === 1 → the lock path still names OUR inode; unlinking it removes OUR lock.
   *   nlink === 0 → our entry is already gone, so whatever sits at the lock path now belongs to
   *                 SOMEBODY ELSE and must not be touched.
   *
   * A re-stat of the path could not give this answer safely, and neither could comparing a token
   * against the file's CONTENT: both are a second lookup of a NAME whose meaning can change before
   * the unlink lands — the very shape of the race being removed. The descriptor is the identity and
   * it cannot be swapped underneath us. What makes the remaining unlink un-raceable is the pairing
   * of that identity with the removal of automatic reclamation: no Sthayi writer ever unlinks a
   * lock it does not own, so while we hold ours no COOPERATIVE peer can make our entry disappear
   * and put its own there — nlink cannot go 1 → 0 → (someone else's lock) behind our back.
   *
   * What is left is a same-user process that deliberately unlinks our lock while hard-linking the
   * inode elsewhere to hold nlink at 1. That is sabotage by an attacker who can already rewrite the
   * database and read the vault key, and is outside what a cooperative lock claims (see the class
   * note above).
   */
  private releaseLock(fd: number): void {
    let ours = false;
    try {
      ours = fs.fstatSync(fd).nlink > 0;
    } catch {
      // cannot prove the entry is still ours — then we delete nothing
    }
    try {
      fs.closeSync(fd);
    } catch {
      // already closed
    }
    if (!ours) {
      return;
    }
    try {
      fs.unlinkSync(this.lockPath());
    } catch {
      // best-effort: it may have been cleared by hand while we held it
    }
  }

  private withLock<T>(fn: () => T): T {
    const fd = this.acquireLock();
    try {
      return fn();
    } finally {
      this.releaseLock(fd);
    }
  }

  /** The atomic replacement itself — caller holds the lock and has already re-read + compared. */
  private writeLocked(value: string): void {
    // Validate the destination once more BEFORE writing: never rename over (or otherwise disturb)
    // a symlink, a foreign-owned file, or anything that is not our regular checkpoint file.
    this.assertSafePath(this.file, 'checkpoint file');
    // unique tmp name per writer: concurrent processes must never rename each other's partials
    const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    // The same validation guards the tmp path: a pre-planted file or symlink squatting on the
    // (unlikely) colliding name is a refusal, and 'wx' makes creation itself collision-atomic.
    this.assertSafePath(tmp, 'checkpoint tmp file');
    fs.writeFileSync(tmp, value, { mode: 0o600, flag: 'wx' });
    try {
      fs.renameSync(tmp, this.file);
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // best-effort tmp cleanup — the rename error is the one worth surfacing
      }
      throw err;
    }
  }

  read(): string | undefined {
    return this.readTrusted();
  }

  /**
   * Compare-and-swap. Under the lock: re-read the destination with the descriptor discipline
   * above, and write `next` only while the current bytes still equal `expected` (undefined =
   * expect absent). Returns false — having written NOTHING and left the file byte-identical —
   * when they changed. `opts.force` (the explicit `journal reseal` trust decision) skips the
   * comparison but still runs through this same serialized path.
   */
  replace(expected: string | undefined, next: string, opts?: { force?: boolean }): boolean {
    // Whole-chain validation, then one level at a time. A recursive mkdir here would resolve the
    // ancestor chain INSIDE THE KERNEL, so a symlinked ancestor at any depth would have this
    // trust anchor — and the lock file guarding it — materialized in a tree nothing validated.
    // The per-file lstat in assertSafePath says nothing about the directories walked to reach it.
    ensureTrustedContainingDir(this.file, 'refusing to write the journal checkpoint file', {
      mode: 0o700,
    });
    return this.withLock(() => {
      const current = this.readTrusted();
      if (current === next) {
        return true; // already exactly these bytes: nothing to write, nothing to destroy
      }
      if (opts?.force !== true && current !== expected) {
        return false; // changed under us — LEAVE IT, it may be the only evidence of a tamper
      }
      this.writeLocked(next);
      return true;
    });
  }

  /**
   * Unconditional replacement, kept for the CheckpointStore port. It routes through the same
   * serialized `replace` path (with force) so no writer of this file bypasses the lock — but
   * JournalService never calls it, because a blind write is the hazard `replace` closes.
   */
  write(value: string): void {
    this.replace(undefined, value, { force: true });
  }
}
