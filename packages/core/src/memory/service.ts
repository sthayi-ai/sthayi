import type { AssocService } from '../assoc/service.js';
import { GAMMA } from '../assoc/spread.js';
import { newId } from '../domain/ids.js';
import type { MutationOutcome } from '../domain/journal.js';
import type { Memory, MemoryDraft } from '../domain/memory.js';
import type { ImportedMemory } from '../importers/types.js';
import { dedupeKey } from '../importers/util.js';
import type { JournalService } from '../journal/service.js';
import { compositeScore, recencyBoost } from '../search/rank.js';
import type { MemorySearchRow, StorageDriver } from '../store/driver.js';
import { maskDeep } from '../vault/mask-deep.js';

export interface RankedHit {
  memory: Memory;
  score: number;
  /** set on the fused path: how the hit entered the result set (associative = zero query-keyword
   *  overlap; it arrived through the Samskara association graph) */
  via?: 'lexical' | 'associative';
}

/** Minimal vault hook: the write-time (at-rest) masker. The at-rest policy masks secrets AND
 *  PII classes when backed by VaultService (the method name predates the PII-at-rest policy).
 *  VaultService satisfies this via its `maskSecrets` alias for `maskAtRest`. */
export interface SecretMasker {
  maskSecrets(content: string): { masked: string; warnings: string[] };
}

/**
 * A DOMAIN VALUE THAT CARRIES THE OUTCOME OF THE JOURNAL ENTRY BEHIND IT.
 *
 * WHY IT IS ATTACHED TO THE VALUE. Every mutation here has an outcome that is neither success nor
 * failure: the write COMMITTED while the off-database anchor did not advance with it, so the rows
 * are durable, a retry would DUPLICATE them, and the store has stopped accepting writes. An
 * OPTIONAL channel for that — a sink the caller passes in, or does not — makes the dangerous case
 * indistinguishable from a clean one for anyone who simply did not pass it, and nothing at the call
 * site would ever say so. Riding on the return value, it cannot be left behind: every caller of
 * every mutation holds it, and reading it means narrowing {@link MutationOutcome} rather than
 * checking a boolean.
 *
 * NON-ENUMERABLE, deliberately. `outcome` is out-of-band bookkeeping, not part of the domain
 * payload: the CLI serializes search hits with `JSON.stringify` and MCP publishes memory rows as
 * structuredContent, and an enumerable property would silently change both wire shapes.
 *
 * READ ON ACCESS, not captured when the value was built. A mutation composed inside a CALLER's
 * transaction returns before that transaction settles, so a captured answer would be frozen at
 * 'in-flight' forever — including after the caller committed, and after it rolled back. Reading it
 * again asks the question again.
 */
export type Journaled<T extends object> = T & { readonly outcome: MutationOutcome };

/** Attach `outcome` to a domain value as a live, non-enumerable view (see {@link Journaled}). */
function journaled<T extends object>(value: T, outcome: () => MutationOutcome): Journaled<T> {
  Object.defineProperty(value, 'outcome', { get: outcome, enumerable: false });
  return value as Journaled<T>;
}

/** The outcome of a call that appended no entry at all — there is nothing to settle. */
const NO_ENTRY = (): MutationOutcome => ({ state: 'no-entry' });

export interface WriteOptions {
  now: number;
  actor?: string;
  /** default true — writes enter as proposals (spec: the runtime disposes) */
  asProposal?: boolean;
  /** if provided, secret-masking warnings are pushed here for the caller to surface */
  warnings?: string[];
}

export interface SearchParams {
  now: number;
  k?: number;
  actor?: string;
  /** bump retrieval bookkeeping + journal the retrieval (default true) */
  bump?: boolean;
  /** associative recall via the Samskara graph (default true when the service has one) */
  assoc?: boolean;
  /** restrict results to an exact scope (e.g. 'user' or 'project:x'); omitted = all scopes */
  scope?: string;
}

/** Floor for a seed's normalized lexical evidence: every real FTS hit stays above pure-noise
 *  associative candidates, and the affine map is order-preserving whatever sign bm25 takes
 *  (FTS5 bm25 can go positive when a term's df exceeds N/2 — no assumption about sign here). */
const LEX_NORM_FLOOR = 0.2;

/** Order-preserving map of -bm25 (higher = better) into [LEX_NORM_FLOOR, 1]. Scores whose whole
 *  span is float noise (near-identical bm25) are treated as a tie — min-max on a noise-sized span
 *  would stretch it across the full range and let noise dominate confidence/recency. */
export function lexNormalize(rows: MemorySearchRow[]): Map<string, number> {
  const out = new Map<string, number>();
  if (rows.length === 0) {
    return out;
  }
  const nb = rows.map((r) => -r.bm25);
  const min = Math.min(...nb);
  const max = Math.max(...nb);
  const span = max - min;
  const noise = 1e-9 * Math.max(1, Math.abs(max));
  rows.forEach((r, i) => {
    const norm =
      span > noise ? LEX_NORM_FLOOR + (1 - LEX_NORM_FLOOR) * (((nb[i] as number) - min) / span) : 1;
    out.set(r.memory.id, norm);
  });
  return out;
}

/** Options for the proposal-queue transitions (confirm/reject); the outcome rides on the
 *  returned ids (see {@link Journaled}). */
export interface TransitionOptions {
  now: number;
  actor?: string;
}

const DEFAULT_CONFIDENCE = 0.6;

/** Journaled search queries are masked + clipped first: the journal is append-only and
 *  hash-chained, so anything journaled raw would be at rest permanently (invariant 5). */
const JOURNAL_QUERY_MAX = 256;

/**
 * The one entry point for memory writes, retrieval, and the proposal queue. Every mutation is
 * journaled; every write defaults to a proposal (spec §4 / invariant 2). Search ranks with
 * `compositeScore` and, by default, bumps retrieval bookkeeping so kept memories rise over time.
 */
export class MemoryService {
  constructor(
    private readonly store: StorageDriver,
    private readonly journal: JournalService,
    private readonly vault?: SecretMasker,
    private readonly assoc?: AssocService,
  ) {}

  /** Apply the at-rest masking policy (secrets + PII, invariant 5) to one string,
   *  collecting any warnings. */
  private maskAtRest(content: string, warnings?: string[]): string {
    if (!this.vault) {
      return content;
    }
    const result = this.vault.maskSecrets(content);
    if (warnings && result.warnings.length > 0) {
      warnings.push(...result.warnings);
    }
    return result.masked;
  }

  /**
   * Hand the warnings an attempt earned to the CALLER's array only once the rows that earned them
   * are durable.
   *
   * A masking warning is a claim about rows that exist: a secret in what you just wrote was
   * replaced by a pseudonym, and the pseudonym was minted. `write()`'s own `writeTransaction`
   * JOINS whatever transaction the caller already has open, so its return says nothing about
   * whether anything committed — the transaction that decides is the caller's. Published on that
   * return, the warning survives an outer rollback that took the memory, the vault entity and the
   * `memory_write` entry with it, because the array is the caller's and no rollback reaches it:
   * `sthayi add` prints "a secret was masked" and the MCP server publishes it as
   * `structuredContent.warnings` over ZERO durable rows.
   *
   * Settlement is the driver's to report. `afterCommit` runs a callback only if the frame that
   * queued it reaches a commit — a savepoint that unwinds discards its own, a released one hands
   * them to its host — and runs it immediately when no transaction is open, which is the ordinary
   * top-level write whose rows are already durable here. `onSettle` reports the same edge with the
   * rollback named explicitly.
   *
   * WITHOUT EITHER HOOK, TOP-LEVEL SETTLEMENT IS INFERRED ONLY FROM AN EXPLICIT ANSWER. Every one
   * of `afterCommit`, `onSettle` and `inTransaction` is OPTIONAL on the storage port, so a driver
   * implementing none of them is fully conforming — and it can say nothing whatever about the
   * transaction the caller may have open. Reading that silence as "no transaction is open" answers
   * a question the driver was never asked: the warning is handed over at the moment of the write,
   * and the caller's array is not reached by the rollback that then takes the row, the pseudonym
   * and the entry. So `inTransaction` has to EXIST and return false — the driver stating that
   * nothing is left to settle — before this return counts as durability. When no member of the
   * port can establish it, the warning is withheld rather than guessed. A warning about rows that
   * were rolled back is a false report of a leak that never happened; a missing warning over
   * correctly masked rows is not, and the masking itself is unaffected either way.
   */
  private publishOnSettlement(sink: string[] | undefined, earned: string[]): void {
    if (sink === undefined || earned.length === 0) {
      return;
    }
    const publish = (): void => {
      sink.push(...earned);
    };
    if (this.store.afterCommit !== undefined) {
      this.store.afterCommit(publish);
    } else if (this.store.onSettle !== undefined) {
      this.store.onSettle((committed) => {
        if (committed) {
          publish();
        }
      });
    } else if (this.store.inTransaction?.() === false) {
      publish();
    }
  }

  /**
   * Sink-complete write-time masking (the at-rest policy): ONE place that masks
   * every caller-supplied string that will be persisted — content, scope, source, and the whole
   * provenance structure including its object KEYS (maskDeep). `type`/`confidence`/`status` are
   * enum/number fields and carry no free text.
   */
  private maskDraft(d: MemoryDraft, warnings?: string[]): MemoryDraft {
    if (!this.vault) {
      return d;
    }
    const mask = (s: string): string => this.maskAtRest(s, warnings);
    return {
      ...d,
      content: mask(d.content),
      scope: d.scope === undefined ? undefined : mask(d.scope),
      source: d.source === undefined ? undefined : mask(d.source),
      provenance: d.provenance === undefined ? undefined : maskDeep(d.provenance, mask),
    };
  }

  private materialize(draft: MemoryDraft, opts: WriteOptions): Memory {
    const asProposal = opts.asProposal ?? true;
    const source = draft.source ?? opts.actor ?? 'cli';
    return {
      id: newId(),
      type: draft.type,
      scope: draft.scope ?? 'user',
      content: draft.content,
      provenance: draft.provenance ?? { source },
      confidence: draft.confidence ?? DEFAULT_CONFIDENCE,
      boosts: 0,
      status: asProposal ? 'proposed' : (draft.status ?? 'confirmed'),
      source,
      createdAt: opts.now,
      updatedAt: opts.now,
      lastRetrievedAt: null,
      decayAt: null,
    };
  }

  /**
   * Write one or more memories (proposals by default), journaled as a single `memory_write`.
   * Secrets AND PII are masked to vault pseudonyms before storage (invariant 5).
   *
   * The rows come back carrying `outcome` (see {@link Journaled}); an EMPTY batch appends nothing
   * and says 'no-entry'.
   */
  write(drafts: MemoryDraft[], opts: WriteOptions): Journaled<Memory[]> {
    if (drafts.length === 0) {
      return journaled([], NO_ENTRY);
    }
    // Masking happens INSIDE the write transaction: vault allocation joins it, so a failed write
    // leaves no orphan entity, and the write lock serializes allocation across processes.
    //
    // THE WARNINGS ARE COLLECTED PER ATTEMPT AND PUBLISHED ONLY BY THE ATTEMPT THAT COMMITTED.
    // `writeTransaction` retries the WHOLE body on SQLITE_BUSY, and every attempt before the last
    // one ROLLED BACK — its row, its journal entry and its vault mint are gone with it. The
    // CALLER'S array is not: handed straight to `maskDraft`, it accumulated one warning per
    // ATTEMPT while exactly one memory and one `memory_write` entry became durable, so a write
    // that hit one retry told the user a second secret had been masked and a second pseudonym
    // minted, when neither happened. That array is what `sthayi add` prints and what the MCP
    // server publishes as `structuredContent.warnings`, so the duplicate is the answer the user
    // and the model both act on. An EXHAUSTED retry publishes nothing at all: nothing committed,
    // so there is nothing that was masked.
    //
    // AND THE COMMITTED ATTEMPT PUBLISHES AT THE OUTERMOST EDGE, NOT AT THIS RETURN — see
    // {@link publishOnSettlement}. A write composed inside a CALLER's transaction merely joins it,
    // so the rows are not durable when this returns, and a caller that rolls back would keep a
    // warning describing rows that no longer exist.
    const { memories, warnings, append } = this.store.writeTransaction(() => {
      const attemptWarnings: string[] = [];
      const rows = drafts.map((d) => this.materialize(this.maskDraft(d, attemptWarnings), opts));
      for (const m of rows) {
        this.store.insertMemory(m);
      }
      const ids = rows.map((m) => m.id);
      return {
        memories: rows,
        warnings: attemptWarnings,
        append: this.journal.append(
          {
            ts: opts.now,
            actor: opts.actor ?? 'cli',
            op: 'memory_write',
            payload: { ids, status: rows[0]?.status },
          },
          { ids },
        ),
      };
    });
    this.publishOnSettlement(opts.warnings, warnings);
    // Read on ACCESS, not here: for a top-level write the answer is already final by the time this
    // returns, and for one composed inside a caller transaction it becomes final when that
    // transaction settles.
    return journaled(memories, () => append.outcome);
  }

  /** Convenience for a single write; the outcome rides on the returned memory. */
  add(draft: MemoryDraft, opts: WriteOptions): Journaled<Memory> {
    const written = this.write([draft], opts);
    return journaled(written[0] as Memory, () => written.outcome);
  }

  /**
   * Ranked search: FTS seeds, then (when an AssocService is wired and `assoc` isn't false)
   * Samskara spreading activation surfaces memories with zero query-keyword overlap. On a store
   * with no association evidence for the seeds, the legacy bm25 path runs byte-identically to
   * pre-Samskara behavior. Bumps retrieval bookkeeping + journals a `memory_retrieve` by default;
   * the retrieve entry is immediately folded back into the graph (Hebbian: returned together →
   * wired together).
   */
  search(query: string, params: SearchParams): Journaled<RankedHit[]> {
    const k = params.k ?? 8;
    let useAssoc = this.assoc !== undefined && params.assoc !== false;
    if (useAssoc && this.assoc) {
      // Search availability beats index freshness: if the fold can't run right now (e.g. a
      // concurrent writer under WAL snapshot rules), degrade to lexical — the cursor is
      // unchanged (chunk transactions are atomic) and the next search heals.
      try {
        this.assoc.catchUp();
      } catch {
        useAssoc = false;
      }
    }
    const rows = this.store.searchMemories(query, { limit: k * 5, scope: params.scope });

    let assocScores = new Map<string, number>();
    if (useAssoc && this.assoc && rows.length > 0) {
      try {
        assocScores = this.assoc.spread(lexNormalize(rows), params.now);
      } catch {
        useAssoc = false;
      }
    }

    let ranked: RankedHit[];
    if (assocScores.size === 0) {
      // Legacy path — scores identical to pre-Samskara builds (fresh-store guarantee).
      ranked = rows
        .map((r) => ({ memory: r.memory, score: compositeScore(r.bm25, r.memory, params.now) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k);
    } else {
      const lexNorm = lexNormalize(rows);
      const candidates = new Map<string, { memory: Memory; lex: number; assoc: number }>();
      for (const r of rows) {
        candidates.set(r.memory.id, {
          memory: r.memory,
          lex: lexNorm.get(r.memory.id) ?? 0,
          assoc: assocScores.get(r.memory.id) ?? 0,
        });
      }
      for (const [id, a] of assocScores) {
        if (candidates.has(id)) {
          continue;
        }
        const m = this.store.getMemory(id);
        // the scope gate applies to associative arrivals too — an edge must never leak a
        // memory from another scope into a scoped search
        if (
          m &&
          (m.status === 'proposed' || m.status === 'confirmed') &&
          (!params.scope || m.scope === params.scope)
        ) {
          candidates.set(id, { memory: m, lex: 0, assoc: a });
        }
      }
      const scored = [...candidates.values()].map((c) => ({
        memory: c.memory,
        score: (c.lex + GAMMA * c.assoc) * c.memory.confidence * recencyBoost(c.memory, params.now),
        via: (c.lex > 0 ? 'lexical' : 'associative') as RankedHit['via'],
      }));
      // Associative evidence supplements lexical evidence, never overrides it: an assoc-only
      // candidate is capped at the best lexical score (the boosts multiplier is unbounded, so
      // GAMMA alone cannot guarantee this), and lexical wins ties.
      const topLex = scored.reduce((m, h) => (h.via === 'lexical' && h.score > m ? h.score : m), 0);
      if (topLex > 0) {
        for (const h of scored) {
          if (h.via === 'associative' && h.score > topLex) {
            h.score = topLex;
          }
        }
      }
      ranked = scored
        .sort(
          (a, b) =>
            b.score - a.score ||
            (a.via === b.via ? 0 : a.via === 'lexical' ? -1 : 1) ||
            (a.memory.id < b.memory.id ? -1 : 1),
        )
        .slice(0, k);
    }

    if (params.bump === false || ranked.length === 0) {
      return journaled(ranked, NO_ENTRY);
    }
    {
      const ids = ranked.map((h) => h.memory.id);
      const append = this.store.writeTransaction(() => {
        // mask BEFORE truncating — clipping first could leave a recognizable secret prefix;
        // in-transaction so a query containing a NEW secret can't leave an orphan entity
        const masked = this.maskAtRest(query);
        const journalQuery =
          masked.length > JOURNAL_QUERY_MAX ? `${masked.slice(0, JOURNAL_QUERY_MAX)}…` : masked;
        this.store.bumpRetrieval(ids, params.now);
        const entry = this.journal.append(
          {
            ts: params.now,
            actor: params.actor ?? 'cli',
            op: 'memory_retrieve',
            payload: { query: journalQuery, ids },
          },
          { ids },
        );
        if (useAssoc && this.assoc) {
          // catchUp (not a fold of just our own entry): our append is visible to this
          // connection, and any entries another process committed since the pre-search catchUp
          // are folded too — the cursor can never jump past unfolded history. A fold failure
          // here must not void the search: the chunk's savepoint rolls back leaving the cursor
          // unchanged, the bump + retrieve entry still commit, and the next catchUp heals.
          try {
            this.assoc.catchUp();
          } catch {
            // degrade: hits are already ranked; the unfolded entry is picked up next search
          }
        }
        return entry;
      });
      // The retrieval bump MUTATES, so it too can commit while the off-database anchor fails to
      // advance — and its outcome is read on access, exactly like a write's.
      return journaled(ranked, () => append.outcome);
    }
  }

  /** The full proposal queue (no page), or — with a page — one STORAGE-BOUNDED page plus the
   *  total: the paged form goes through listMemoriesPage (SQL LIMIT/OFFSET + COUNT, with an
   *  optional type filter applied IN the SQL), so listing one page of a large queue never
   *  materializes the whole queue. */
  listProposals(): Memory[];
  listProposals(page: { limit: number; offset: number; type?: Memory['type'] }): {
    rows: Memory[];
    total: number;
  };
  listProposals(page?: {
    limit: number;
    offset: number;
    type?: Memory['type'];
  }): Memory[] | { rows: Memory[]; total: number } {
    if (page) {
      return this.store.listMemoriesPage(
        { status: 'proposed', type: page.type },
        { limit: page.limit, offset: page.offset },
      );
    }
    return this.store.listMemories({ status: 'proposed' });
  }

  /** Confirm proposals → status 'confirmed', journaled. Returns the ids actually transitioned,
   *  carrying the outcome (see {@link Journaled}). */
  confirm(ids: string[], opts: TransitionOptions): Journaled<string[]> {
    return this.transition(ids, 'proposed', 'confirmed', 'memory_confirm', opts);
  }

  /** Reject proposals → status 'archived', journaled. */
  reject(ids: string[], opts: TransitionOptions): Journaled<string[]> {
    return this.transition(ids, 'proposed', 'archived', 'memory_reject', opts);
  }

  /**
   * Import memories as proposals, skipping any whose scope+type+normalized-content identity
   * already exists (re-import → zero dupes). Dedup never crosses scope or type: the same content
   * in a different scope, or as a different type, imports fresh. Status is deliberately
   * excluded — a duplicate of an archived/rejected row in the same scope+type still skips, so a
   * reject stays sticky across re-imports. Also dedups within the batch. Journals a single
   * `import` op with the counts.
   */
  importMemories(
    items: ImportedMemory[],
    opts: { now: number; actor?: string; source: string },
  ): Journaled<{ imported: number; skipped: number }> {
    // Whole batch — dedupe scan, masking (vault allocation), inserts, journal — in one write
    // transaction: the dedupe snapshot can't go stale under a concurrent writer, and a failed
    // import leaves no orphan entities.
    const { counts, append } = this.store.writeTransaction(() => {
      const seen = new Set(
        this.store.listMemories().map((m) => dedupeKey(m.scope, m.type, m.content)),
      );
      const toWrite: Memory[] = [];
      for (const it of items) {
        // Mask the WHOLE draft first (content, scope, source, provenance — sink-complete), then key
        // on the masked values: the stored row and the dedupe key must share one identity.
        // provenance.importedAt records WHEN the import ran (audit trail) — a number,
        // untouched by maskDeep.
        const draft = this.maskDraft({
          type: it.type,
          content: it.content,
          scope: it.scope,
          confidence: it.confidence,
          provenance: { ...it.provenance, importedAt: opts.now },
          source: opts.source,
        });
        // materialize() defaults scope to 'user' — the incoming key must use the same default
        // or the stored row's identity would drift from the key we deduped on
        const key = dedupeKey(draft.scope ?? 'user', draft.type, draft.content);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        const memory = this.materialize(draft, {
          now: opts.now,
          actor: opts.actor,
          asProposal: true,
        });
        // The memory's createdAt is the VALIDATED source creation time when the parser
        // extracted one, so ranking/decay treat an imported memory as old as its source — not as
        // born today. The import moment itself lives in provenance.importedAt (above); rank/decay
        // code is unchanged (both read createdAt).
        if (it.sourceCreatedAt !== undefined) {
          memory.createdAt = it.sourceCreatedAt;
        }
        toWrite.push(memory);
      }
      const skipped = items.length - toWrite.length;
      for (const m of toWrite) {
        this.store.insertMemory(m);
      }
      return {
        counts: { imported: toWrite.length, skipped },
        append: this.journal.append(
          {
            ts: opts.now,
            actor: opts.actor ?? 'import',
            op: 'import',
            payload: { source: opts.source, imported: toWrite.length, skipped },
          },
          { ids: toWrite.map((m) => m.id) },
        ),
      };
    });
    return journaled(counts, () => append.outcome);
  }

  private transition(
    ids: string[],
    from: Memory['status'],
    to: Memory['status'],
    op: string,
    opts: TransitionOptions,
  ): Journaled<string[]> {
    // THE APPLIED LIST IS MINTED INSIDE THE ATTEMPT, never captured from out here. The driver
    // retries the WHOLE body on a busy BEGIN, and every attempt before the last one ROLLED BACK —
    // its rows and its journal row are gone with it. A list living outside the callback collects
    // one id per ATTEMPT instead of one per transitioned row, so a single proposal confirmed
    // through one retry comes back twice, is journaled twice, and appears twice in the receipt,
    // over exactly one durable row. What escapes is the committed attempt's own list and nothing
    // else's.
    const { applied, append } = this.store.writeTransaction(() => {
      const settled: string[] = [];
      for (const id of ids) {
        const m = this.store.getMemory(id);
        if (m && m.status === from) {
          this.store.updateMemory(id, { status: to, updatedAt: opts.now });
          settled.push(id);
        }
      }
      // Nothing transitioned (every id was missing or already past `from`): no rows changed, so
      // there is no entry to journal and no outcome to report.
      return {
        applied: settled,
        append:
          settled.length === 0
            ? undefined
            : this.journal.append(
                { ts: opts.now, actor: opts.actor ?? 'cli', op, payload: { ids: settled } },
                { ids: settled },
              ),
      };
    });
    return journaled(applied, append === undefined ? NO_ENTRY : () => append.outcome);
  }
}
