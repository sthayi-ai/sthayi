import type { EdgeDelta } from '../assoc/fold.js';
import type { Entity, EntityKind } from '../domain/entity.js';
import type { JournalRecord, SealedJournalEntry } from '../domain/journal.js';
import type { McpEntry } from '../domain/mcp.js';
import type { Memory, MemoryFilter, MemoryStatus } from '../domain/memory.js';

/** A raw FTS hit: the memory plus its bm25 score (lower = better; ranking negates it). */
export interface MemorySearchRow {
  memory: Memory;
  bm25: number;
}

/** One association edge (Samskara, packages/core/src/assoc/): undirected, a < b canonical. */
export interface AssocEdgeRow {
  a: string;
  b: string;
  kind: string;
  weight: number;
  lastReinforcedAt: number;
}

/** One page of a filtered memory listing: bounded rows plus the total match count. */
export interface MemoryPage {
  rows: Memory[];
  total: number;
}

export interface SearchOptions {
  /** max rows the driver returns for the ranker to re-score (over-fetch) */
  limit?: number;
  /** which statuses to include; defaults to proposed + confirmed (never archived) */
  includeStatuses?: MemoryStatus[];
  /** restrict to an exact scope (e.g. 'user' or 'project:x'); omitted = all scopes */
  scope?: string;
}

/**
 * The storage port. `packages/core` depends only on this interface; concrete drivers
 * (better-sqlite3, SQLite-WASM later) are constructor-injected from `packages/cli`. This is
 * the discipline that keeps core browser-clean (spec §1 invariant 6) and makes a possible future
 * browser/PWA build a build target rather than a rewrite.
 */
export interface StorageDriver {
  /** Run pending forward-only migrations (idempotent). */
  migrate(): void;
  /**
   * Run `fn` inside a single transaction; on throw, roll back.
   *
   * AT THE OUTERMOST LEVEL A DRIVER MUST MAKE THIS EQUIVALENT TO `writeTransaction` — same lock
   * acquisition, same settlement of after-commit and rollback handling. A nested
   * `writeTransaction` JOINS whatever frame is already open, so an outermost `transaction` that
   * settled differently would silently downgrade every mutating service composed inside it, and
   * nothing at the call site would show it. The distinction between the two exists for NESTED
   * bodies only, where `transaction` may open a savepoint that unwinds without taking its host
   * down (the chunked association fold relies on exactly that).
   */
  transaction<T>(fn: () => T): T;
  /**
   * Run `fn` inside a WRITE transaction: the writer lock is acquired before `fn` reads anything,
   * so read-then-write bodies (journal tip + append, vault get-or-create) are serialized across
   * processes. Joins an already-open transaction instead of nesting; retries a bounded number of
   * times when another process holds the lock. Every mutating service entry point goes through
   * this — never plain `transaction` — so no write can act on a stale snapshot.
   */
  writeTransaction<T>(fn: () => T): T;
  /**
   * True while a transaction is open on this connection. Optional (introspection only). Lets a
   * side-effect that must observe only COMMITTED state (the journal's external checkpoint
   * file) defer while an enclosing transaction could still roll back.
   *
   * OPTIONAL, AND ABSENCE IS NOT THE SAME ANSWER AS FALSE. This member, `afterCommit` and
   * `onSettle` are all optional together, so a driver implementing NONE of them is conforming and
   * can report nothing at all about an open transaction. A caller that reads the missing member as
   * "no transaction is open" turns that silence into a durability claim, and the claim is wrong for
   * exactly the composed write it matters for — one joined to a caller transaction that goes on to
   * roll back. A caller whose correctness depends on settlement must therefore require an EXPLICIT
   * false here (or a real settlement report from `afterCommit`/`onSettle`) and fail closed
   * otherwise; MemoryService's masking-warning publication is the worked example.
   */
  inTransaction?(): boolean;
  /**
   * Run `cb` after the OUTERMOST write transaction commits; immediately when no transaction is
   * open. Never runs on rollback (the queue is discarded). Optional. This is how a side-effect
   * that must observe only committed state (the journal's external checkpoint mirror) actually
   * runs in steady state — every service-level append sits inside a writeTransaction, so
   * "defer and hope for a top-level call" never fires. Callbacks must not throw.
   *
   * THE QUEUE IS SCOPED TO THE FRAME THAT QUEUED THE CALLBACK, not to the connection. A nested
   * `transaction` may open a savepoint that unwinds while its host goes on to commit (see above),
   * and the callbacks queued inside one describe rows that unwind with it: a savepoint that ROLLS
   * BACK discards its own after-commit callbacks and leaves the host's untouched, and one that is
   * RELEASED hands its callbacks to the host, which runs them at its commit. A connection-global
   * queue would instead run a discarded mutation's side-effect on the host's commit.
   */
  afterCommit?(cb: () => void): void;
  /**
   * TRANSACTION IDENTITY. A value that is STABLE for the whole lifetime of one OUTERMOST
   * transaction on this connection and NEVER repeats (a monotonic counter incremented when the
   * outermost transaction begins). `undefined` when no transaction is open.
   *
   * WHY THE PORT NEEDS IT. A caller-visible exemption that is only valid "while my earlier append
   * of this transaction is still in flight" (JournalService's external-mirror tolerance) has to be
   * bound to the EXACT transaction that created it. `inTransaction()` cannot express that — it is
   * equally true inside the transaction that created the exemption and inside a brand-new one
   * opened after the first was ROLLED BACK, and a forced rollback discards `afterCommit` callbacks
   * without notifying anyone. An instance-scoped token with no transaction identity is therefore
   * reusable across a rollback boundary, which is exactly the bypass this member closes.
   *
   * OPTIONAL, and its absence is not a licence to guess: JournalService binds its exemption to a
   * database-backed transaction token instead when a driver does not implement this (see
   * JOURNAL_TX_TOKEN_KEY in journal/service.ts), and refuses the exemption outright when a driver
   * offers neither this nor `afterCommit`. `packages/cli/src/drivers/sqlite.ts` implements it.
   */
  transactionId?(): number | undefined;
  /**
   * TRANSACTION LIFECYCLE. Run `cb` when the OUTERMOST transaction SETTLES — `committed` true after
   * a commit, false after a ROLLBACK. Unlike `afterCommit` (whose queue is discarded on rollback),
   * this fires on both edges, which is what lets a holder of transaction-scoped state clear it on
   * BOTH outcomes rather than only on the happy one. Runs immediately with `true` when no
   * transaction is open. Callbacks must not throw. Optional.
   *
   * IT IS THE ONLY WAY THE ROLLBACK EDGE IS OBSERVABLE. A driver without it can report that a
   * transaction committed and never that it did not, so anything waiting on the answer stays
   * unresolved — which is the fail-closed reading and must never be relaxed into "committed".
   * `packages/cli/src/drivers/sqlite.ts` implements it.
   *
   * THE ORDER IN WHICH ONE FRAME'S CALLBACKS RUN IS NOT PART OF THIS CONTRACT. A frame may hold
   * many, queued by unrelated callers and by callers that queued several of their own, and a
   * released savepoint's callbacks are merged into the frame that adopted them. A callback must
   * therefore describe the settled state itself — read it back, or be idempotent — rather than
   * replay a value remembered from when it was queued: a remembered value is only correct for
   * whichever callback happens to run last.
   *
   * A NESTED SAVEPOINT SETTLES ON ITS OWN EDGE. `cb` queued inside a nested `transaction` that
   * UNWINDS runs at the unwind with `committed` false — that is the moment its rows died, and it
   * is reported whatever the host transaction goes on to do, because the host's later commit
   * cannot make those rows durable. Queued inside one that is RELEASED, it becomes the host's and
   * runs on the host's edge. Holding it for the outermost edge regardless would report `true` for
   * a mutation the database threw away.
   */
  onSettle?(cb: (committed: boolean) => void): void;
  close(): void;

  // --- meta (k/v) ---
  getMeta(key: string): string | undefined;
  setMeta(key: string, value: string): void;

  // --- memories ---
  insertMemory(memory: Memory): void;
  getMemory(id: string): Memory | undefined;
  updateMemory(id: string, patch: Partial<Memory>): void;
  deleteMemory(id: string): void;
  listMemories(filter?: MemoryFilter): Memory[];
  countMemories(filter?: MemoryFilter): number;
  /**
   * Paged variant of listMemories: same filter semantics and newest-first ordering, but bounded
   * AT THE STORAGE LAYER (SQL LIMIT/OFFSET + COUNT in the sqlite driver) — serving one page of a
   * large queue must never materialize the whole queue in memory.
   */
  listMemoriesPage(
    filter: MemoryFilter | undefined,
    page: { limit: number; offset: number },
  ): MemoryPage;

  /** FTS5 lexical search; returns rows + bm25 for the ranker to re-score. Never throws on hostile
   * input — falls back to a LIKE scan (bm25 neutral) on FTS syntax errors. */
  searchMemories(query: string, opts?: SearchOptions): MemorySearchRow[];
  /** Bump retrieval bookkeeping: set last_retrieved_at = now and boosts += 1 for each id. */
  bumpRetrieval(ids: string[], now: number): void;

  // --- vault entities (canonicals AES-GCM encrypted in value_enc) ---
  insertEntity(entity: Entity): void;
  listEntities(kind?: EntityKind): Entity[];

  // --- mcp registry (credentials are never stored — only the env-var NAME) ---
  listMcpEntries(name?: string): McpEntry[];

  // --- journal (append-only, hash-chained) ---
  appendJournal(entry: SealedJournalEntry): JournalRecord;
  lastJournalHash(): string | null;
  recentJournal(n: number): JournalRecord[];
  allJournal(): JournalRecord[];
  /** Entries with id > `id`, ascending, at most `limit` (all if omitted) — the assoc fold's feed. */
  journalSince(id: number, limit?: number): JournalRecord[];

  // --- assoc graph (derived, journal-folded via AssocService; never a source of truth) ---
  /** Decay-then-add upsert of one edge delta (decay arithmetic via core's decayedWeight). */
  applyAssocDelta(delta: EdgeDelta): void;
  /** Re-point every edge incident to `from` onto `to` (merging weights; dropping self-edges). */
  rewireAssoc(from: string, to: string, now: number): void;
  /** Edges incident to `ids` whose BOTH endpoints are live (proposed|confirmed). */
  neighborsAssoc(ids: string[]): AssocEdgeRow[];
  clearAssoc(): void;
  countAssocEdges(): number;
}
