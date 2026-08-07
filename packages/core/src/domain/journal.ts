/**
 * The journal is append-only and hash-chained (spec §1 invariant 3). Every write/retrieval/
 * consolidation op is a row; `hash = sha256(prevHash + canonical(fields))`. History is never
 * rewritten — a rollback is new compensating entries, not an edit.
 */
export interface JournalRecord {
  /** monotonic sequence assigned by the store (SQLite AUTOINCREMENT) */
  id: number;
  ts: number;
  actor: string;
  op: string;
  payload: unknown;
  promptVersion: string | null;
  model: string | null;
  prevHash: string | null;
  hash: string;
}

/** What a caller supplies; the store/journal service computes hashes and assigns the id. */
export interface JournalDraft {
  ts: number;
  actor: string;
  op: string;
  payload?: unknown;
  promptVersion?: string | null;
  model?: string | null;
}

/** A fully-hashed entry ready to persist, minus the store-assigned id. */
export type SealedJournalEntry = Omit<JournalRecord, 'id'>;

/**
 * Where the OFF-DATABASE anchor (the checkpoint file outside the database) stood once an
 * operation's write transaction had committed.
 *  - 'anchored'       — the file was read back and holds exactly the checkpoint the database
 *                       committed. This is the only fully-successful outcome;
 *  - 'unanchored'     — the database COMMITTED but the anchor did not advance with it. The rows are
 *                       durable and must not be re-applied; every further mutation refuses until
 *                       the anchor is repaired;
 *  - 'not-configured' — no external checkpoint store is wired (browser builds, keyless core tests):
 *                       there is no second copy to be out of step.
 *
 * THERE IS NO 'pending' MEMBER, and its absence is load-bearing. Every value here describes a
 * COMMITTED transaction, so an anchor state that means "the transaction has not settled" cannot be
 * written down — which is what makes a receipt for uncommitted rows unrepresentable rather than
 * merely discouraged. The unsettled case lives in {@link MutationOutcome} instead, where it carries
 * no receipt at all.
 */
export type AnchorOutcome = 'anchored' | 'unanchored' | 'not-configured';

/**
 * What ONE journaled mutation actually achieved, as a value the caller can act on.
 *
 * WHY IT EXISTS. A journaled mutation has THREE outcomes, not two. Between success and failure sits
 * the one that a bare `JournalRecord` return cannot express: the database transaction COMMITTED
 * while the off-database anchor did NOT advance. Left unrepresented in the return type, that state
 * can only be warned about out of band, and every front door renders it as an unqualified success —
 * a normal CLI line and exit 0, MCP success text with `warnings: []`, `{ok:true,reverted:n}` from
 * rollback. The type therefore carries the outcome, so no surface has the option of omitting it.
 *
 * The receipt states all three facts that outcome carries, so no surface has to infer them:
 *  - `committed` is TRUE — the rows ARE durable. This is NOT a rolled-back transaction and must
 *    never be reported (or thrown) as one;
 *  - `doNotRetry` — retrying would DUPLICATE a write that already landed. The repair is the anchor,
 *    not the operation;
 *  - `writesBlocked` — the store has stopped accepting mutations (the append gate requires a
 *    current off-database anchor), so the next write will refuse until the anchor is fixed.
 */
export interface CommitReceipt {
  /**
   * ALWAYS true. A refused append THROWS, and a receipt is only ever constructed on the COMMIT edge
   * of the transaction that wrote the entry — {@link MutationOutcome} carries every other state and
   * carries no receipt on any of them — so the existence of a receipt IS the statement that the
   * database half committed. It is a field rather than an implication because the degraded case
   * must SAY it, in structured output a machine reads and in text a human reads.
   */
  committed: true;
  /** the journal entry this operation appended */
  record: JournalRecord;
  /** convenience: `record.id` */
  journalId: number;
  /** domain rows the operation created or changed (memory ids), when the caller records them */
  ids?: string[];
  anchor: AnchorOutcome;
  /** why the anchor is not current — set exactly when `anchor` is 'unanchored' */
  reason?: string;
  /** true exactly when `anchor` is 'unanchored': further mutations refuse until the anchor is fixed */
  writesBlocked: boolean;
  /** true exactly when `anchor` is 'unanchored': the write is durable, so a retry duplicates it */
  doNotRetry: boolean;
}

/**
 * WHAT ONE JOURNALED MUTATION ACHIEVED, AS A SINGLE VALUE WITH EXACTLY ONE SHAPE.
 *
 * A {@link CommitReceipt} is the statement "these rows are durable". Only a COMMIT can make that
 * statement true, so a receipt may only exist on the branch that says commit — that is the whole
 * reason this is a discriminated union rather than an optional receipt beside a boolean. The
 * remaining branches are the states in which no such statement can be made, and none of them can
 * hand a caller a receipt:
 *  - 'no-entry'    — the call appended nothing (an empty batch, a transition that matched no row, a
 *                    search that bumped nothing). There is no journal entry to have an outcome;
 *  - 'in-flight'   — the entry is written but its OUTERMOST transaction has not settled: an
 *                    enclosing CALLER transaction is still open, and it may still roll back. Also
 *                    the terminal state on a driver that implements no settlement hook, which
 *                    cannot report the rollback edge — the honest reading is always "not known to
 *                    have committed", never "committed";
 *  - 'rolled-back' — the transaction rolled back. Nothing is durable, the rows the caller is
 *                    holding do not exist, and the journal id is FREE FOR REUSE by the next append;
 *  - 'committed'   — the transaction committed and the off-database mirror ran. `receipt.anchor`
 *                    then says whether the anchor advanced with it.
 *
 * READ IT AFTER THE OUTERMOST TRANSACTION RETURNS. Inside one, 'in-flight' is the only truthful
 * answer, and the value re-derives itself on every read rather than caching a verdict from before
 * the transaction settled.
 */
export type MutationOutcome =
  | { readonly state: 'no-entry' }
  | { readonly state: 'in-flight' }
  | { readonly state: 'rolled-back' }
  | { readonly state: 'committed'; readonly receipt: CommitReceipt };

/** True for the one outcome that is neither a clean success nor a failure. */
export function isDegradedReceipt(r: CommitReceipt | undefined): boolean {
  return r !== undefined && r.anchor === 'unanchored';
}

/**
 * The receipts among `outcomes` whose transaction COMMITTED — the only ones that describe durable
 * rows, and therefore the only ones a surface may report on. An 'in-flight' or 'rolled-back'
 * outcome contributes nothing: there is no committed write to render, warn about, or exit nonzero
 * over.
 */
export function committedReceipts(outcomes: readonly MutationOutcome[]): CommitReceipt[] {
  const out: CommitReceipt[] = [];
  for (const o of outcomes) {
    if (o.state === 'committed') {
      out.push(o.receipt);
    }
  }
  return out;
}

/**
 * The single sentence every surface renders for a durable-but-unanchored operation. Kept here so
 * the CLI, the MCP text result and the MCP structured result cannot drift from each other — and so
 * none of them can quietly downgrade it to a warning that reads like a failed write.
 */
export function describeReceipt(r: CommitReceipt): string {
  if (r.anchor !== 'unanchored') {
    return `journal entry #${r.journalId} committed; off-database anchor: ${r.anchor}`;
  }
  return [
    `DEGRADED: this operation COMMITTED (journal entry #${r.journalId}${
      r.ids && r.ids.length > 0 ? `, ${r.ids.length} row(s)` : ''
    }) but the off-database journal checkpoint did NOT advance with it.`,
    'DO NOT RETRY — the write is already durable and retrying would duplicate it.',
    'Further writes are BLOCKED until the anchor is repaired.',
    r.reason === undefined ? '' : `Cause: ${r.reason}`,
  ]
    .filter((s) => s !== '')
    .join(' ');
}

export interface ChainVerification {
  ok: boolean;
  /** number of entries checked */
  length: number;
  /** id of the first entry that failed, if any */
  brokenAt?: number;
  reason?: string;
  /**
   * Checkpoint-aware verification state, set by JournalService.verify():
   * 'ok' — chain AND authenticated checkpoint verified; 'pristine' — empty store, never sealed,
   * and no prior-install evidence (an initialized installation whose journal is empty FAILS as
   * erased history instead); 'checkpoint-disabled' — chain verified but no MAC-capable crypto is
   * wired (bare verifyChain leaves it unset).
   */
  state?: 'pristine' | 'ok' | 'checkpoint-disabled';
}
