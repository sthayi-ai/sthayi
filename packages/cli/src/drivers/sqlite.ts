import fs from 'node:fs';
import {
  type AssocEdgeRow,
  BOOTSTRAP_META,
  type EdgeDelta,
  type Entity,
  type EntityKind,
  type JournalRecord,
  type McpEntry,
  type McpTransport,
  type Memory,
  type MemoryFilter,
  type MemorySearchRow,
  type MemoryStatus,
  type MemoryType,
  type Provenance,
  SCHEMA_VERSION_KEY,
  type SealedJournalEntry,
  type SearchOptions,
  type StorageDriver,
  decayedWeight,
  pendingMigrations,
  queryTokens,
  sanitizeFtsQuery,
} from '@sthayi/core';
import Database from 'better-sqlite3';
import {
  assertTrustedContainingDirReadOnly,
  ensureTrustedContainingDir,
  untrustedFileReason,
  untrustedStatReason,
} from '../fs-safe.js';

/** Read-only snapshot branch cap: the no-sidecar path copies the whole db into memory. */
export const READONLY_SNAPSHOT_CAP_BYTES = 512 * 1024 * 1024;

/** Active cap — READONLY_SNAPSHOT_CAP_BYTES unless a test lowered it (see below). */
let readOnlySnapshotCap: number = READONLY_SNAPSHOT_CAP_BYTES;

/**
 * TEST-ONLY seam. Lowers the read-only snapshot cap so the "file grows after the fstat" race can
 * be exercised against a few KiB instead of allocating half a gigabyte. Production code never
 * calls this; pass `undefined` to restore the real cap. Exported (rather than hidden behind an
 * env var) so it is impossible to trip accidentally at runtime.
 */
export function setReadOnlySnapshotCapForTests(bytes?: number): void {
  readOnlySnapshotCap = bytes ?? READONLY_SNAPSHOT_CAP_BYTES;
}

interface MemoryRow {
  id: string;
  type: string;
  scope: string;
  content: string;
  provenance: string | null;
  confidence: number;
  boosts: number;
  status: string;
  source: string | null;
  created_at: number;
  updated_at: number;
  last_retrieved_at: number | null;
  decay_at: number | null;
}

interface AssocRow {
  a: string;
  b: string;
  kind: string;
  weight: number;
  events: number;
  last_reinforced_at: number;
  created_at: number;
}

interface JournalRow {
  id: number;
  ts: number;
  actor: string | null;
  op: string;
  payload: string | null;
  prompt_version: string | null;
  model: string | null;
  prev_hash: string | null;
  hash: string;
}

interface McpRow {
  id: string;
  name: string;
  transport: string | null;
  spec: string | null;
  cred_env: string | null;
  added_at: number;
}

interface EntityRow {
  id: string;
  kind: string;
  value_enc: Buffer | null;
  pseudonym: string;
  sensitivity: string | null;
  created_at: number;
}

/** Columns of `memories` that `updateMemory` may set, mapped from camelCase patch keys. */
const MEMORY_COLUMN: Partial<Record<keyof Memory, string>> = {
  type: 'type',
  scope: 'scope',
  content: 'content',
  confidence: 'confidence',
  boosts: 'boosts',
  status: 'status',
  source: 'source',
  updatedAt: 'updated_at',
  lastRetrievedAt: 'last_retrieved_at',
  decayAt: 'decay_at',
};

/**
 * The callbacks queued by ONE transaction frame — the outermost transaction, or one open SAVEPOINT
 * inside it. `after` runs only when the frame's writes reach a commit; `settles` runs on whichever
 * edge the frame ends on.
 */
interface CallbackFrame {
  after: (() => void)[];
  settles: ((committed: boolean) => void)[];
}

function newCallbackFrame(): CallbackFrame {
  return { after: [], settles: [] };
}

/**
 * better-sqlite3 implementation of the StorageDriver port. Lives in `packages/cli` (not core) so
 * core stays browser-clean (spec §1 invariant 6). Synchronous by design — no async ceremony.
 */
export class SqliteDriver implements StorageDriver {
  private constructor(private readonly db: Database.Database) {}

  static open(file: string): SqliteDriver {
    // The WHOLE chain leading to the db must be real directories, validated BEFORE anything is
    // created. Two threats make that ordering load-bearing for a DIRECT driver caller (openStore
    // validates the home chain first; a direct caller has nothing above it). A recursive
    // `fs.mkdirSync(dir, { recursive: true })` resolves the entire chain in the kernel, so a
    // symlinked ancestor at any depth would have the directory created inside the link's target
    // and the db (plus its -wal/-shm sidecars, which SQLite also opens by path) written there; and
    // an lstat of the immediate parent ONLY is defeated by adding one level. Missing levels are
    // therefore created ONE AT A TIME beneath the deepest validated ancestor, each verified after
    // creation. Beneath an established home boundary the walk starts there and re-checks the
    // boundary's device/inode, so a home swapped out mid-process is refused here too — POSIX
    // ONLY; that identity comparison is not performed on Windows (see the platform-scope note in
    // fs-safe.ts), so this sentence is not a Windows guarantee.
    ensureTrustedContainingDir(file, 'refusing to open the memory database', { mode: 0o700 });
    // Trust gate BEFORE creating/opening: better-sqlite3 opens by PATH, so a planted symlink,
    // FIFO, directory, hard link, or foreign-owned file at the db path (or its -wal/-shm
    // sidecar paths, which SQLite also opens by path) would otherwise be followed or served as
    // the database. Absent is fine — the healthy path below creates it. Permission bits are NOT
    // gated here ('ignore'): the chmod further down repairs the db to 0600 whatever it opened
    // with. HONEST RESIDUAL: between this lstat and SQLite's own open(2) there is an
    // unavoidable TOCTOU window — a path-based open cannot exclude an attacker who can win that
    // race with write access to the directory; the 0700 home directory is what excludes such an
    // attacker, and this gate removes every practical planted-file attack visible at open time.
    for (const [p, what] of [
      [file, 'memory database'],
      [`${file}-wal`, 'memory database WAL sidecar'],
      [`${file}-shm`, 'memory database shared-memory sidecar'],
    ] as const) {
      const reason = untrustedFileReason(p, what, { modePolicy: 'ignore' });
      if (reason) {
        throw new Error(`refusing to open the memory database: ${reason}`);
      }
    }
    const db = new Database(file);
    if (process.platform !== 'win32') {
      // Owner-only BEFORE the WAL pragma: SQLite copies the db file's mode onto -wal/-shm.
      // Re-lstat IMMEDIATELY before the chmod (never chmod through a link): the gate above ran
      // before SQLite's open(2), and a symlink swapped in between must not have its TARGET
      // re-modded. HONEST RESIDUAL: lstat→chmod is itself a (much smaller) path-based window;
      // the 0700 home directory is what excludes the attacker who could race it.
      try {
        const st = fs.lstatSync(file);
        if (st.isSymbolicLink() || !st.isFile()) {
          throw new Error(
            `refusing to open the memory database: ${file} was replaced with ${st.isSymbolicLink() ? 'a symlink' : 'a non-regular file'} while opening (possible hijack)`,
          );
        }
        fs.chmodSync(file, 0o600);
      } catch (err) {
        try {
          db.close();
        } catch {
          // already closed
        }
        throw err;
      }
    }
    // busy_timeout first: every later pragma/DDL that needs a lock (including the one-time WAL
    // switch below) waits for a contending process instead of failing immediately.
    db.pragma('busy_timeout = 5000');
    // WAL is persistent in the db file — switch only when not already set, so a fleet of MCP
    // processes starting together doesn't race to re-run the mode change on every open.
    const mode = db.pragma('journal_mode', { simple: true }) as string;
    if (mode !== 'wal') {
      // First-run fleet race: the DELETE→WAL switch needs exclusive access, and SQLite can
      // report SQLITE_BUSY for it IMMEDIATELY (without consulting the busy handler) while a
      // sibling process holds the writer lock (migration, journal TOFU seal). The mode is
      // persistent, so losing the race is success too — retry briefly and accept the outcome
      // as long as SOMEONE completed the switch.
      for (let attempt = 1; ; attempt++) {
        try {
          db.pragma('journal_mode = WAL');
          break;
        } catch (err) {
          const code = (err as { code?: string }).code;
          if (code !== 'SQLITE_BUSY' && code !== 'SQLITE_BUSY_SNAPSHOT') {
            throw err;
          }
          try {
            if ((db.pragma('journal_mode', { simple: true }) as string) === 'wal') {
              break; // a sibling process won the switch — nothing left to do
            }
          } catch {
            // the re-read can hit the same contention — keep retrying below
          }
          if (attempt >= 20) {
            throw err;
          }
          // Synchronous bounded backoff (same technique as writeTransaction below).
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * attempt);
        }
      }
    }
    db.pragma('foreign_keys = ON');
    return new SqliteDriver(db);
  }

  /**
   * Read-only open for observational commands (`doctor`). No file creation, no chmod,
   * no WAL switch, no migration — observation must not even mint `-wal`/`-shm` sidecar paths.
   *
   * Two branches:
   *  - WAL sidecars already exist (a live — or crashed — writer): attach with a normal readonly
   *    connection (busy_timeout only) for correctly coordinated reads. Caveat: if the WAL is
   *    "hot" (the last writer crashed mid-commit), recovery needs write access and SQLite fails
   *    with SQLITE_READONLY_RECOVERY — doctor reports that as a failing store check, still with
   *    zero writes, which is the point.
   *  - No sidecars (cleanly checkpointed store — the common doctor case): a plain readonly
   *    connection would CREATE `-wal`/`-shm` in a writable directory, so instead the main db
   *    file is snapshotted into memory. The WAL flag in the header (bytes 18/19) is flipped to
   *    rollback-journal ON THE COPY ONLY — a deserialized WAL database cannot be opened, and the
   *    file on disk is never touched. Local memory stores are small; the copy is cheap.
   */
  static openReadOnly(file: string): SqliteDriver {
    // The WHOLE chain leading to the db must be real directories, validated BEFORE any read and
    // WITHOUT creating anything. This path checked only the IMMEDIATE containing directory, so a
    // symlinked ancestor one level further up was followed: a READ through it discloses a database
    // outside the home just as surely as a write would plant one there. Callers that come through
    // openStoreReadOnly have already validated the whole home chain (assertReadOnlySthayiHome);
    // this re-check covers direct driver callers, and beneath an established boundary it re-checks
    // that boundary's device/inode as well — POSIX ONLY; the identity comparison is skipped on
    // Windows (see the platform-scope note in fs-safe.ts), so this is not a Windows guarantee.
    assertTrustedContainingDirReadOnly(file, 'refusing to open the memory database read-only');
    // The SAME trust gate as open(), applied BEFORE any read: a planted symlink, hard link,
    // FIFO, directory, or foreign-owned file at the db (or sidecar) paths is refused — the
    // read-only path must not follow what the writable path refuses. Same residual as open():
    // the lstat→open window on path-based APIs cannot be closed from here; the snapshot branch
    // below narrows it further with an O_NOFOLLOW|O_NONBLOCK fd and fstat re-validation.
    for (const [p, what] of [
      [file, 'memory database'],
      [`${file}-wal`, 'memory database WAL sidecar'],
      [`${file}-shm`, 'memory database shared-memory sidecar'],
    ] as const) {
      const reason = untrustedFileReason(p, what, { modePolicy: 'ignore' });
      if (reason) {
        throw new Error(`refusing to open the memory database: ${reason}`);
      }
    }
    if (fs.existsSync(`${file}-wal`) || fs.existsSync(`${file}-shm`)) {
      const db = new Database(file, { readonly: true, fileMustExist: true });
      db.pragma('busy_timeout = 5000');
      return new SqliteDriver(db);
    }
    // Snapshot branch: open a descriptor ourselves (never follow a link, never block on a FIFO
    // swapped in after the lstat gate), re-validate ON THE FD, cap the size, and read through
    // the same descriptor — the bytes deserialized are the very inode that passed the checks.
    const O_NOFOLLOW =
      (fs.constants as unknown as Record<string, number | undefined>).O_NOFOLLOW ?? 0;
    const O_NONBLOCK =
      (fs.constants as unknown as Record<string, number | undefined>).O_NONBLOCK ?? 0;
    let fd: number;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ELOOP') {
        throw new Error(
          `refusing to open the memory database: ${file} is a symlink (possible hijack) — refusing to follow it`,
        );
      }
      throw err; // including ENOENT — same contract as fileMustExist
    }
    try {
      const st = fs.fstatSync(fd);
      const reason = untrustedStatReason(st, file, 'memory database', { modePolicy: 'ignore' });
      if (reason) {
        throw new Error(`refusing to open the memory database: ${reason}`);
      }
      const cap = readOnlySnapshotCap;
      if (st.size > cap) {
        throw new Error(
          `refusing to open the memory database read-only: ${file} is ${st.size} bytes, over the ${cap / (1024 * 1024)} MiB snapshot cap (this path copies the file into memory) — compact the store with \`sthayi doctor\` guidance (VACUUM) or inspect it with the sqlite3 CLI directly`,
        );
      }
      // The fstat size is a HINT, never the bound: a file that grows between the stat and the
      // read would otherwise sail past the advertised cap (fs.readFileSync(fd) reads to EOF,
      // unbounded). Same discipline as fs-safe safeReadTextFile: read through the SAME already
      // validated descriptor, never ask for more than cap+1 bytes in total, and refuse the
      // moment the +1 sentinel is crossed — so at most cap+1 bytes are ever held.
      const chunk = Buffer.alloc(Math.min(1024 * 1024, cap + 1));
      const parts: Buffer[] = [];
      let total = 0;
      for (;;) {
        const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, cap + 1 - total), null);
        if (n === 0) {
          break;
        }
        total += n;
        if (total > cap) {
          throw new Error(
            `refusing to open the memory database read-only: ${file} produced more than the ${cap}-byte snapshot cap (it grew while being read) — compact the store with \`sthayi doctor\` guidance (VACUUM) or inspect it with the sqlite3 CLI directly`,
          );
        }
        parts.push(Buffer.from(chunk.subarray(0, n)));
      }
      const buf = Buffer.concat(parts, total);
      if (buf.length > 19) {
        buf[18] = 1; // file-format write version: 2 (WAL) → 1 (rollback journal)
        buf[19] = 1; // file-format read version
      }
      return new SqliteDriver(new Database(buf, { readonly: true }));
    } finally {
      fs.closeSync(fd);
    }
  }

  /** In-memory database for tests. */
  static openMemory(): SqliteDriver {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    return new SqliteDriver(db);
  }

  migrate(): void {
    this.db.exec(BOOTSTRAP_META);
    // Read the version INSIDE the write lock: when several processes hit a fresh store at once,
    // the losers re-read the winner's version and no-op instead of crashing on duplicate DDL.
    this.writeTransaction(() => {
      const current = Number(this.getMeta(SCHEMA_VERSION_KEY) ?? '0');
      for (const migration of pendingMigrations(current)) {
        this.db.exec(migration.sql);
        this.setMeta(SCHEMA_VERSION_KEY, String(migration.version));
      }
    });
  }

  /**
   * Run `fn` in a transaction. AT THE OUTERMOST LEVEL THIS IS `writeTransaction` — same BEGIN
   * IMMEDIATE, same busy retry, same settlement.
   *
   * THE TWO MAY NOT DIVERGE THERE. Services compose: a body handed to this method can call one that
   * opens its own `writeTransaction`, which JOINS rather than nests, so whatever the outermost
   * frame chose is what that write actually gets. A weaker outermost frame therefore silently
   * downgrades every write inside it — a DEFERRED begin hands a read-then-write body a snapshot
   * taken before the writer lock, and a frame with no settlement leaves the after-commit queue
   * undrained (an off-database mirror that never runs, a checkpoint frozen while the rows advance)
   * and the queue itself alive to be drained later by an unrelated transaction. Neither is a
   * property a caller can see at the call site, so the composition is made SAFE here rather than
   * left to a convention every future caller has to know.
   *
   * NESTED, the two differ and must: this opens a SAVEPOINT (better-sqlite3's nested form), which
   * can unwind on its own without rolling back the host transaction — the property AssocService's
   * chunked fold depends on, so that a fold failure degrades instead of destroying its host's work.
   * The outermost transaction still owns settlement in that case, exactly as it does for a joined
   * `writeTransaction`, but only for the callbacks that SURVIVE the savepoint: a savepoint that
   * unwinds takes its own with it (see {@link runSavepoint}).
   */
  transaction<T>(fn: () => T): T {
    if (this.db.inTransaction) {
      return this.runSavepoint(fn);
    }
    return this.runOutermost(fn);
  }

  /**
   * The queued callbacks of every transaction frame open on this connection, OUTERMOST FIRST.
   * Index 0 belongs to the outermost transaction; every deeper entry is one open SAVEPOINT. The
   * stack is never empty — index 0 is replaced at settlement, never popped — so a callback always
   * has a frame to land in while a transaction is open.
   *
   * THE STACK IS WHAT MAKES A CALLBACK'S FATE MATCH ITS WRITES'. A savepoint can unwind on its own
   * while the host transaction goes on to commit, so a callback queued inside one describes rows
   * that may no longer exist by the time the host commits. Held in a single connection-global
   * queue it would be drained by that commit regardless — publishing an after-commit effect for
   * discarded rows and reporting a COMMITTED settlement for a mutation the database threw away.
   * Framed, it settles with the savepoint that queued it.
   */
  private frames: CallbackFrame[] = [newCallbackFrame()];

  /** Monotonic per-connection counter; `currentTxId` is set for the lifetime of one OUTERMOST
   *  transaction and cleared the instant it settles. */
  private txCount = 0;
  private currentTxId: number | undefined;

  /** The innermost open frame — the one a callback queued right now belongs to. */
  private currentFrame(): CallbackFrame {
    // Never empty: settle() replaces the root frame rather than removing it.
    return this.frames[this.frames.length - 1] as CallbackFrame;
  }

  afterCommit(cb: () => void): void {
    if (this.db.inTransaction) {
      this.currentFrame().after.push(cb);
    } else {
      cb();
    }
  }

  onSettle(cb: (committed: boolean) => void): void {
    if (this.db.inTransaction) {
      this.currentFrame().settles.push(cb);
    } else {
      cb(true);
    }
  }

  transactionId(): number | undefined {
    return this.currentTxId;
  }

  /**
   * Settle ONE outermost transaction: identity retired, every frame still open emptied, the
   * after-commit callbacks run only on commit and the settle callbacks run on both edges.
   *
   * EVERYTHING IS TAKEN OUT OF THE INSTANCE BEFORE ANYTHING RUNS. A callback left in a frame past
   * the transaction that queued it belongs to no transaction at all, and the next transaction on
   * this connection would drain it as its own — which is how a checkpoint mirror scheduled by rows
   * that were rolled back comes to run against rows that were not, and how a value it was going to
   * complete gets completed long after its own transaction died. Clearing first also means a
   * callback that queues another one sees no open transaction and runs it immediately, rather than
   * re-queuing it into the transaction that follows.
   */
  private settle(committed: boolean): void {
    const open = this.frames;
    this.frames = [newCallbackFrame()];
    this.currentTxId = undefined;
    // Every frame still open settles WITH the outermost one. A savepoint that unwound has already
    // taken itself off the stack, so what is left here are frames the outermost transaction's own
    // edge decides — and replacing the stack wholesale is what guarantees none of them is still
    // there for the NEXT transaction to adopt.
    const after = open.flatMap((f) => f.after);
    const settles = open.flatMap((f) => f.settles);
    if (committed) {
      for (const cb of after) {
        cb();
      }
    }
    for (const cb of settles) {
      cb(committed);
    }
  }

  /**
   * Run `fn` in a SAVEPOINT of the transaction already open on this connection, with its callbacks
   * in a frame of their own.
   *
   * A SAVEPOINT SETTLES ITS OWN CALLBACKS, and the two edges are not symmetric:
   *  - RELEASED (the body returned): its writes are now part of the host transaction and its
   *    callbacks become the host's, MERGED into the parent frame in the order they were queued.
   *    They run when — and only when — the outermost transaction settles;
   *  - ROLLED BACK (the body threw, whether or not the host catches it): its writes are gone. The
   *    after-commit callbacks are DISCARDED unrun, because there is no commit of those rows for
   *    them to describe, and the settle callbacks are run IMMEDIATELY with `false` — this is the
   *    moment their rows died, and it is the only moment anything can report it. Deferring them to
   *    the host's commit would report `true` for a mutation the database threw away, which is the
   *    receipt that must never exist; leaving them queued would put a dead entry's completion in
   *    the path of the live entry that legitimately takes its journal id.
   */
  private runSavepoint<T>(fn: () => T): T {
    const frame = newCallbackFrame();
    this.frames.push(frame);
    let result: T;
    try {
      result = this.db.transaction(fn)();
    } catch (err) {
      for (const f of this.takeFrom(frame)) {
        for (const cb of f.settles) {
          cb(false);
        }
      }
      throw err;
    }
    // Off the stack BEFORE the parent is read: while this frame is still the innermost one it is
    // its own parent, and merging it into itself would drop everything it holds.
    const released = this.takeFrom(frame);
    const parent = this.currentFrame();
    for (const f of released) {
      parent.after.push(...f.after);
      parent.settles.push(...f.settles);
    }
    return result;
  }

  /**
   * Take `frame` off the stack, together with anything pushed above it — a body that unwound
   * without unwinding the stack leaves no callback behind for a later frame to adopt. The root
   * frame (index 0) is never taken: it belongs to the outermost transaction, which settles it.
   */
  private takeFrom(frame: CallbackFrame): CallbackFrame[] {
    const at = this.frames.lastIndexOf(frame);
    return at > 0 ? this.frames.splice(at) : [frame];
  }

  /**
   * The ONE outermost-transaction path: BEGIN IMMEDIATE (the writer lock is held before the body
   * reads anything), bounded retry on a busy BEGIN, and exactly one settlement per attempt.
   *
   * A retried attempt is a SETTLED attempt: it rolled back, so its callbacks are discarded and its
   * identity retired before the next attempt mints a new one. An attempt that inherited the
   * previous one's queue would run callbacks belonging to a transaction that never committed.
   */
  private runOutermost<T>(fn: () => T): T {
    const run = this.db.transaction(fn);
    for (let attempt = 1; ; attempt++) {
      this.currentTxId = ++this.txCount;
      try {
        const result = run.immediate();
        this.settle(true);
        return result;
      } catch (err) {
        this.settle(false);
        const code = (err as { code?: string }).code;
        const busy = code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT';
        if (!busy || attempt >= 3) {
          throw err;
        }
        // Synchronous bounded backoff (better-sqlite3 is sync; busy_timeout already waited 5s).
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * attempt);
      }
    }
  }

  writeTransaction<T>(fn: () => T): T {
    if (this.db.inTransaction) {
      // Join the enclosing transaction — the outermost writer owns atomicity. Callbacks queued
      // by this nested body stay in the instance queue and drain when the OWNER settles.
      return fn();
    }
    return this.runOutermost(fn);
  }

  inTransaction(): boolean {
    return this.db.inTransaction;
  }

  close(): void {
    this.db.close();
  }

  // -------------------------------------------------------------------------------------------
  // Plaintext-remnant scrub surface (store.ts PII remask migration, phase 2). These run on THIS
  // already-gated connection — the scrub never reopens the file, because a bare
  // `new Database(file)` reopen would bypass the open() trust gate entirely. Each step throws on
  // failure so the migration state machine can stay pending and retry on the next open.
  // -------------------------------------------------------------------------------------------

  /** Rebuild the external-content FTS index — drops superseded segments that still carry
   *  pre-remask plaintext tokens. */
  rebuildMemoryFts(): void {
    this.db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
  }

  /** VACUUM — rewrites the database, discarding freed pages (and the plaintext bytes on them).
   *  Must not be called inside a transaction. */
  vacuum(): void {
    this.db.exec('VACUUM');
  }

  /** TRUNCATE-checkpoint the WAL: transfer every frame into the main file and truncate the WAL
   *  to zero bytes — pre-checkpoint WAL frames can still carry plaintext page images. Throws
   *  when the checkpoint was blocked by a concurrent connection (the caller retries later). */
  checkpointTruncate(): void {
    const rows = this.db.pragma('wal_checkpoint(TRUNCATE)') as { busy: number }[];
    if (rows.some((r) => r.busy !== 0)) {
      throw new Error(
        'WAL checkpoint (TRUNCATE) was blocked by a concurrent connection — retrying on the next open',
      );
    }
  }

  /** Free-page count — 0 after a successful VACUUM (part of the scrub verification). */
  freelistCount(): number {
    return this.db.pragma('freelist_count', { simple: true }) as number;
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT v FROM meta WHERE k = ?').get(key) as
      | { v: string }
      | undefined;
    return row?.v;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .run(key, value);
  }

  insertMemory(m: Memory): void {
    this.db
      .prepare(
        `INSERT INTO memories
          (id, type, scope, content, provenance, confidence, boosts, status, source,
           created_at, updated_at, last_retrieved_at, decay_at)
         VALUES
          (@id, @type, @scope, @content, @provenance, @confidence, @boosts, @status, @source,
           @created_at, @updated_at, @last_retrieved_at, @decay_at)`,
      )
      .run({
        id: m.id,
        type: m.type,
        scope: m.scope,
        content: m.content,
        provenance: JSON.stringify(m.provenance ?? { source: m.source }),
        confidence: m.confidence,
        boosts: m.boosts,
        status: m.status,
        source: m.source,
        created_at: m.createdAt,
        updated_at: m.updatedAt,
        last_retrieved_at: m.lastRetrievedAt,
        decay_at: m.decayAt,
      });
  }

  getMemory(id: string): Memory | undefined {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as
      | MemoryRow
      | undefined;
    return row ? mapMemory(row) : undefined;
  }

  updateMemory(id: string, patch: Partial<Memory>): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(MEMORY_COLUMN)) {
      if (key in patch && column) {
        sets.push(`${column} = ?`);
        values.push((patch as Record<string, unknown>)[key]);
      }
    }
    if ('provenance' in patch) {
      sets.push('provenance = ?');
      values.push(JSON.stringify(patch.provenance));
    }
    if (sets.length === 0) {
      return;
    }
    values.push(id);
    this.db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  deleteMemory(id: string): void {
    this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
  }

  listMemories(filter?: MemoryFilter): Memory[] {
    const where: string[] = [];
    const values: unknown[] = [];
    if (filter?.status) {
      where.push('status = ?');
      values.push(filter.status);
    }
    if (filter?.type) {
      where.push('type = ?');
      values.push(filter.type);
    }
    if (filter?.scope) {
      where.push('scope = ?');
      values.push(filter.scope);
    }
    let sql = 'SELECT * FROM memories';
    if (where.length) {
      sql += ` WHERE ${where.join(' AND ')}`;
    }
    sql += ' ORDER BY created_at DESC';
    if (filter?.limit != null) {
      sql += ' LIMIT ?';
      values.push(filter.limit);
    }
    return (this.db.prepare(sql).all(...values) as MemoryRow[]).map(mapMemory);
  }

  countMemories(filter?: MemoryFilter): number {
    const where: string[] = [];
    const values: unknown[] = [];
    if (filter?.status) {
      where.push('status = ?');
      values.push(filter.status);
    }
    if (filter?.type) {
      where.push('type = ?');
      values.push(filter.type);
    }
    if (filter?.scope) {
      where.push('scope = ?');
      values.push(filter.scope);
    }
    let sql = 'SELECT COUNT(*) AS n FROM memories';
    if (where.length) {
      sql += ` WHERE ${where.join(' AND ')}`;
    }
    const row = this.db.prepare(sql).get(...values) as { n: number };
    return row.n;
  }

  /** Parameterized WHERE builder for the paged listing — the same filter semantics as
   *  listMemories/countMemories, factored for the pagination path. */
  private memoryFilterWhere(filter?: MemoryFilter): { where: string; values: unknown[] } {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (filter?.status) {
      clauses.push('status = ?');
      values.push(filter.status);
    }
    if (filter?.type) {
      clauses.push('type = ?');
      values.push(filter.type);
    }
    if (filter?.scope) {
      clauses.push('scope = ?');
      values.push(filter.scope);
    }
    return { where: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', values };
  }

  listMemoriesPage(
    filter: MemoryFilter | undefined,
    page: { limit: number; offset: number },
  ): { rows: Memory[]; total: number } {
    const { where, values } = this.memoryFilterWhere(filter);
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM memories${where}`).get(...values) as { n: number }
    ).n;
    // Newest-first like listMemories, with id as a deterministic tiebreaker so pages never
    // overlap or skip when created_at ties. Bounded in SQL — LIMIT/OFFSET, never a full scan
    // materialized into JS.
    const rows = (
      this.db
        .prepare(
          `SELECT * FROM memories${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
        )
        .all(...values, page.limit, page.offset) as MemoryRow[]
    ).map(mapMemory);
    return { rows, total };
  }

  searchMemories(query: string, opts?: SearchOptions): MemorySearchRow[] {
    const statuses = opts?.includeStatuses ?? ['proposed', 'confirmed'];
    const limit = opts?.limit ?? 40;
    const statusPlaceholders = statuses.map(() => '?').join(',');
    // Optional exact-scope filter (parameterized). Omitted = all scopes.
    const scopeClause = opts?.scope ? ' AND m.scope = ?' : '';
    const scopeArgs = opts?.scope ? [opts.scope] : [];
    const fts = sanitizeFtsQuery(query);

    if (fts.length > 0) {
      try {
        const rows = this.db
          .prepare(
            `SELECT m.*, bm25(memories_fts) AS bm25
             FROM memories_fts
             JOIN memories m ON m.rowid = memories_fts.rowid
             WHERE memories_fts MATCH ? AND m.status IN (${statusPlaceholders})${scopeClause}
             ORDER BY bm25 ASC
             LIMIT ?`,
          )
          .all(fts, ...statuses, ...scopeArgs, limit) as (MemoryRow & { bm25: number })[];
        return rows.map((r) => ({ memory: mapMemory(r), bm25: r.bm25 }));
      } catch {
        // FTS syntax error on hostile input → fall through to a LIKE scan so search never hard-fails.
      }
    }

    // Bound the token count so a pathological query can't blow the SQL variable limit, and wrap
    // the fallback so search degrades to empty rather than throwing (the FTS path already does).
    const tokens = queryTokens(query).slice(0, 64);
    if (tokens.length === 0) {
      return [];
    }
    const likeClauses = tokens.map(() => 'm.content LIKE ?').join(' OR ');
    try {
      const rows = this.db
        .prepare(
          `SELECT m.* FROM memories m
           WHERE m.status IN (${statusPlaceholders})${scopeClause} AND (${likeClauses})
           LIMIT ?`,
        )
        .all(...statuses, ...scopeArgs, ...tokens.map((t) => `%${t}%`), limit) as MemoryRow[];
      return rows.map((r) => ({ memory: mapMemory(r), bm25: -1 }));
    } catch {
      return [];
    }
  }

  insertEntity(e: Entity): void {
    this.db
      .prepare(
        'INSERT INTO entities (id, kind, value_enc, pseudonym, sensitivity, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        e.id,
        e.kind,
        e.valueEnc ? Buffer.from(e.valueEnc) : null,
        e.pseudonym,
        e.sensitivity,
        e.createdAt,
      );
  }

  listEntities(kind?: EntityKind): Entity[] {
    const rows = (
      kind
        ? this.db.prepare('SELECT * FROM entities WHERE kind = ? ORDER BY created_at').all(kind)
        : this.db.prepare('SELECT * FROM entities ORDER BY created_at').all()
    ) as EntityRow[];
    return rows.map(mapEntity);
  }

  listMcpEntries(name?: string): McpEntry[] {
    const rows = (
      name
        ? this.db.prepare('SELECT * FROM mcp_registry WHERE name = ? ORDER BY name').all(name)
        : this.db.prepare('SELECT * FROM mcp_registry ORDER BY name').all()
    ) as McpRow[];
    return rows.map(mapMcp);
  }

  bumpRetrieval(ids: string[], now: number): void {
    if (ids.length === 0) {
      return;
    }
    const stmt = this.db.prepare(
      'UPDATE memories SET last_retrieved_at = ?, boosts = boosts + 1 WHERE id = ?',
    );
    const tx = this.db.transaction((list: string[]) => {
      for (const id of list) {
        stmt.run(now, id);
      }
    });
    tx(ids);
  }

  appendJournal(entry: SealedJournalEntry): JournalRecord {
    const info = this.db
      .prepare(
        `INSERT INTO journal (ts, actor, op, payload, prompt_version, model, prev_hash, hash)
         VALUES (@ts, @actor, @op, @payload, @prompt_version, @model, @prev_hash, @hash)`,
      )
      .run({
        ts: entry.ts,
        actor: entry.actor,
        op: entry.op,
        payload: entry.payload == null ? null : JSON.stringify(entry.payload),
        prompt_version: entry.promptVersion,
        model: entry.model,
        prev_hash: entry.prevHash,
        hash: entry.hash,
      });
    return { id: Number(info.lastInsertRowid), ...entry };
  }

  lastJournalHash(): string | null {
    const row = this.db.prepare('SELECT hash FROM journal ORDER BY id DESC LIMIT 1').get() as
      | { hash: string }
      | undefined;
    return row?.hash ?? null;
  }

  recentJournal(n: number): JournalRecord[] {
    return (
      this.db.prepare('SELECT * FROM journal ORDER BY id DESC LIMIT ?').all(n) as JournalRow[]
    ).map(mapJournal);
  }

  allJournal(): JournalRecord[] {
    return (this.db.prepare('SELECT * FROM journal ORDER BY id ASC').all() as JournalRow[]).map(
      mapJournal,
    );
  }

  journalSince(id: number, limit?: number): JournalRecord[] {
    const rows =
      limit != null
        ? this.db
            .prepare('SELECT * FROM journal WHERE id > ? ORDER BY id ASC LIMIT ?')
            .all(id, limit)
        : this.db.prepare('SELECT * FROM journal WHERE id > ? ORDER BY id ASC').all(id);
    return (rows as JournalRow[]).map(mapJournal);
  }

  // Prepared lazily (the table only exists after migration) and cached: a cold fold of a large
  // journal runs applyAssocDelta hundreds of thousands of times — per-call prepare() dominates.
  private assocStmts?: {
    select: Database.Statement;
    update: Database.Statement;
    insert: Database.Statement;
  };

  private assocStatements(): NonNullable<typeof this.assocStmts> {
    if (!this.assocStmts) {
      this.assocStmts = {
        select: this.db.prepare(
          'SELECT weight, last_reinforced_at FROM assoc_edges WHERE a = ? AND b = ? AND kind = ?',
        ),
        update: this.db.prepare(
          `UPDATE assoc_edges SET weight = ?, events = events + 1, last_reinforced_at = ?
           WHERE a = ? AND b = ? AND kind = ?`,
        ),
        insert: this.db.prepare(
          `INSERT INTO assoc_edges (a, b, kind, weight, events, last_reinforced_at, created_at)
           VALUES (?, ?, ?, ?, 1, ?, ?)`,
        ),
      };
    }
    return this.assocStmts;
  }

  applyAssocDelta(d: EdgeDelta): void {
    const stmts = this.assocStatements();
    const row = stmts.select.get(d.a, d.b, d.kind) as
      | { weight: number; last_reinforced_at: number }
      | undefined;
    if (row) {
      // decay-then-add, arithmetic in core (decayedWeight) — never SQL math functions
      const weight = decayedWeight(row.weight, row.last_reinforced_at, d.ts) + d.delta;
      stmts.update.run(weight, d.ts, d.a, d.b, d.kind);
    } else {
      stmts.insert.run(d.a, d.b, d.kind, d.delta, d.ts, d.ts);
    }
  }

  rewireAssoc(from: string, to: string, now: number): void {
    const rows = this.db
      .prepare('SELECT * FROM assoc_edges WHERE a = ? OR b = ? ORDER BY a, b, kind')
      .all(from, from) as AssocRow[];
    const del = this.db.prepare('DELETE FROM assoc_edges WHERE a = ? AND b = ? AND kind = ?');
    for (const r of rows) {
      const other = r.a === from ? r.b : r.a;
      del.run(r.a, r.b, r.kind);
      if (other === to) {
        continue; // would be a self-edge — the pair's mass dissolves into the survivor
      }
      const [na, nb] = to < other ? [to, other] : [other, to];
      const carried = decayedWeight(r.weight, r.last_reinforced_at, now);
      const existing = this.db
        .prepare(
          'SELECT weight, last_reinforced_at FROM assoc_edges WHERE a = ? AND b = ? AND kind = ?',
        )
        .get(na, nb, r.kind) as { weight: number; last_reinforced_at: number } | undefined;
      if (existing) {
        const weight = decayedWeight(existing.weight, existing.last_reinforced_at, now) + carried;
        this.db
          .prepare(
            `UPDATE assoc_edges SET weight = ?, events = events + ?, last_reinforced_at = ?
             WHERE a = ? AND b = ? AND kind = ?`,
          )
          .run(weight, r.events, now, na, nb, r.kind);
      } else {
        this.db
          .prepare(
            `INSERT INTO assoc_edges (a, b, kind, weight, events, last_reinforced_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(na, nb, r.kind, carried, r.events, now, r.created_at);
      }
    }
  }

  neighborsAssoc(ids: string[]): AssocEdgeRow[] {
    if (ids.length === 0) {
      return [];
    }
    // Chunk the IN-list: SQLite's bind-parameter budget is finite and callers may pass large
    // id sets. Chunks can return the same edge twice (a in one chunk, b in another) → dedupe.
    const CHUNK = 200;
    const seen = new Set<string>();
    const out: AssocEdgeRow[] = [];
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const ph = chunk.map(() => '?').join(',');
      const rows = this.db
        .prepare(
          `SELECT e.a, e.b, e.kind, e.weight, e.last_reinforced_at
           FROM assoc_edges e
           JOIN memories ma ON ma.id = e.a
           JOIN memories mb ON mb.id = e.b
           WHERE (e.a IN (${ph}) OR e.b IN (${ph}))
             AND ma.status IN ('proposed','confirmed')
             AND mb.status IN ('proposed','confirmed')
           ORDER BY e.a, e.b, e.kind`,
        )
        .all(...chunk, ...chunk) as AssocRow[];
      for (const r of rows) {
        const key = `${r.a} ${r.b} ${r.kind}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({
            a: r.a,
            b: r.b,
            kind: r.kind,
            weight: r.weight,
            lastReinforcedAt: r.last_reinforced_at,
          });
        }
      }
    }
    return out;
  }

  clearAssoc(): void {
    this.db.prepare('DELETE FROM assoc_edges').run();
  }

  countAssocEdges(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM assoc_edges').get() as { n: number };
    return row.n;
  }
}

function mapMemory(row: MemoryRow): Memory {
  let provenance: Provenance;
  try {
    provenance = row.provenance
      ? (JSON.parse(row.provenance) as Provenance)
      : { source: row.source ?? 'unknown' };
  } catch {
    provenance = { source: row.source ?? 'unknown' };
  }
  return {
    id: row.id,
    type: row.type as MemoryType,
    scope: row.scope,
    content: row.content,
    provenance,
    confidence: row.confidence,
    boosts: row.boosts,
    status: row.status as MemoryStatus,
    source: row.source ?? 'unknown',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRetrievedAt: row.last_retrieved_at,
    decayAt: row.decay_at,
  };
}

function mapEntity(row: EntityRow): Entity {
  return {
    id: row.id,
    kind: row.kind as EntityKind,
    valueEnc: row.value_enc ? new Uint8Array(row.value_enc) : null,
    pseudonym: row.pseudonym,
    sensitivity: row.sensitivity,
    createdAt: row.created_at,
  };
}

function mapMcp(row: McpRow): McpEntry {
  let spec: Record<string, unknown> = {};
  try {
    spec = row.spec ? (JSON.parse(row.spec) as Record<string, unknown>) : {};
  } catch {
    spec = {};
  }
  return {
    id: row.id,
    name: row.name,
    transport: (row.transport ?? 'stdio') as McpTransport,
    spec,
    credEnv: row.cred_env,
    addedAt: row.added_at,
  };
}

function mapJournal(row: JournalRow): JournalRecord {
  return {
    id: row.id,
    ts: row.ts,
    actor: row.actor ?? '',
    op: row.op,
    payload: row.payload == null ? null : (JSON.parse(row.payload) as unknown),
    promptVersion: row.prompt_version,
    model: row.model,
    prevHash: row.prev_hash,
    hash: row.hash,
  };
}
