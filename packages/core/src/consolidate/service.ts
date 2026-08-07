import { newId } from '../domain/ids.js';
import {
  type CommitReceipt,
  type MutationOutcome,
  committedReceipts,
  isDegradedReceipt,
} from '../domain/journal.js';
import type { Memory } from '../domain/memory.js';
import { dedupeKey } from '../importers/util.js';
import {
  type AppliedChange,
  ConsolidatePayloadSchema,
  memoryInsertDigest,
  planRollback,
} from '../journal/rollback.js';
import type { JournalAppend, JournalService } from '../journal/service.js';
import type { SecretMasker } from '../memory/service.js';
import type { StorageDriver } from '../store/driver.js';
import { DEFAULT_DECAY, type DecayConfig, shouldArchive } from './decay.js';
import { nearDupePairs } from './minhash.js';
import { MAX_BATCH, type ProviderPort, runOracleBatch } from './oracle/runner.js';
import type { OracleOutput } from './oracle/schema.js';

/**
 * The {@link MutationOutcome} of every entry a consolidation run appended, in append order.
 *
 * A consolidation pass can append several entries, and ANY of them can be the durable-but-
 * unanchored outcome: the batch COMMITTED while the off-database anchor failed to advance. The
 * caller must render that (see `committedReceipts`/`isDegradedReceipt`/`describeReceipt`) rather
 * than the plain summary line — the changes ARE applied, must not be re-run, and further writes
 * are blocked.
 *
 * OUTCOMES, NOT RECEIPTS. A receipt asserts durability, and each of these entries only reaches that
 * state when the transaction that wrote it commits; a run composed inside a caller's still-open
 * transaction has appended entries whose fate nothing yet knows. The union says which is which
 * instead of leaving the caller to read an absence.
 */
export interface ReceiptBearing {
  outcomes: MutationOutcome[];
}

export interface DeterministicReport extends ReceiptBearing {
  exactDupes: number;
  nearDupes: number;
  decayed: number;
  changed: number;
  batchId?: string;
}

export interface OracleReport extends ReceiptBearing {
  batches: number;
  /**
   * How many of `batches` were actually RUN.
   *
   * A multi-batch run is a sequence of INDEPENDENT durable commits, not one transaction, so "how
   * many batches exist" and "how many were attempted" are different facts and the caller needs
   * both: the changes from the batches that ran are already durable and must not be re-applied,
   * while the batches that never ran still have work waiting. It is lower than `batches` exactly
   * when `ended` is not 'complete'.
   */
  batchesRun: number;
  /**
   * WHY THE LOOP ENDED — the one fact a count cannot express.
   *  - 'complete'             — every batch ran;
   *  - 'committed-unanchored' — a batch COMMITTED while the off-database anchor did not advance,
   *                             so the run STOPPED there rather than attempting another batch
   *                             against a store that has stopped accepting writes;
   *  - 'failed'               — a batch threw. Only ever seen on the report carried by
   *                             {@link PartialOracleRunError}, i.e. only when earlier batches had
   *                             already committed.
   */
  ended: 'complete' | 'committed-unanchored' | 'failed';
  appliedBatches: number;
  rejectedBatches: number;
  changed: number;
  /** oracle merge groups discarded whole: spanning more than one scope, type, or STATUS
   *  (the review trust boundary), or referencing rows that changed since the batch
   *  was snapshotted */
  skippedGroups: number;
  /** individual oracle ops skipped because their target vanished or changed status between the
   *  batch snapshot and the in-transaction re-read */
  skippedOps: number;
  /** validated contradiction pairs the oracle flagged — journaled for review
   *  ('consolidate_contradictions'), NEVER auto-applied to any memory */
  contradictions: number;
}

/** Journaled contradiction reasons are bounded: the reason is model output, and the journal is
 *  append-only — an unbounded string would be at rest permanently. Masked BEFORE truncation. */
const MAX_CONTRADICTION_REASON = 280;

/** Deterministic keep-rank for dedupe survivors: confidence desc, then oldest first, then id asc. */
function rank(a: Memory, b: Memory): number {
  return (
    b.confidence - a.confidence ||
    a.createdAt - b.createdAt ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * Attach `outcomes` to a report as a LIVE view over the entries the run appended.
 *
 * Read on ACCESS, never captured: a run composed inside a caller's still-open transaction returns
 * before that transaction settles, and a captured array would hold 'in-flight' forever — including
 * after the caller committed, and after it rolled back.
 */
function withOutcomes<T extends object>(
  report: T,
  appends: readonly JournalAppend[],
): T & ReceiptBearing {
  return Object.defineProperty(report, 'outcomes', {
    get: (): MutationOutcome[] => appends.map((a) => a.outcome),
    enumerable: true,
  }) as T & ReceiptBearing;
}

/**
 * WHAT A ROLLBACK ACHIEVED, AS A DISCRIMINATED UNION — the two branches have different shapes and
 * `ok` is the discriminant.
 *
 * WHY THE UNION. A rollback that reverted rows has a compensating journal entry, and that entry has
 * an outcome: it can COMMIT while the off-database anchor fails to advance, which reverts the rows,
 * blocks every further write, and must never be re-run. Carried as an OPTIONAL field beside a
 * boolean, that outcome is something a surface may simply not look at — and a degraded rollback then
 * renders byte-identically to a clean one, at exit 0. Here the success branch cannot be CONSTRUCTED
 * without it, so "forgot to check" is not a reachable state: reading the report means narrowing on
 * `ok`, and the `ok: true` side always has an outcome to narrow further.
 *
 * The undefined-typed members on each branch (`reason` on success, `outcome` on refusal) are what
 * let a caller read either field off the un-narrowed union and be told, by the type, that it is
 * absent on the other branch.
 */
export type RollbackReport = RollbackReverted | RollbackRefused;

/** A rollback that APPLIED its inverses and appended the compensating entry. */
export interface RollbackReverted {
  readonly ok: true;
  /** store mutations actually applied */
  readonly reverted: number;
  /**
   * The compensating entry's {@link MutationOutcome} — REQUIRED, because this branch only exists
   * once that entry has been appended. A rollback whose outcome carries a degraded receipt reverted
   * the rows and COMMITTED — `ok` stays true, because the database half did happen — but the
   * off-database anchor did not advance, so the caller must not render it as an ordinary success
   * and must not re-run it.
   */
  readonly outcome: MutationOutcome;
  readonly reason?: undefined;
  readonly failedPrecondition?: undefined;
}

/** A rollback that REFUSED: the ladder rejected it, or a precondition failed and the whole
 *  transaction unwound. Nothing was applied and nothing was appended. */
export interface RollbackRefused {
  readonly ok: false;
  readonly reason: string;
  /** always 0 — rollback is all-or-nothing, so a refusal leaves zero net mutations */
  readonly reverted: 0;
  /** set when a current row no longer matches the recorded post-state */
  readonly failedPrecondition?: { id: string; expected: string; actual: string };
  readonly outcome?: undefined;
}

/**
 * A multi-batch oracle run that FAILED AFTER earlier batches had already COMMITTED.
 *
 * WHY IT IS A TYPED VALUE AND NOT A BARE THROW. Each batch is its own durable commit, so a throw
 * from batch N is not a statement about batches 1..N-1 — their rows are archived, their entries are
 * in the journal, and re-running the command would apply them a second time. A bare exception
 * carries none of that: every surface renders it as "consolidate failed", which is the one reading
 * that is certainly wrong. This error carries the run's report instead, with every committed
 * outcome and the exact counts as of the failure, so the caller reports durable progress first and
 * the failure second.
 */
export class PartialOracleRunError extends Error {
  constructor(
    /** the run so far: committed outcomes + exact applied counts, `ended: 'failed'` */
    readonly report: OracleReport,
    /** the failure that ended the run */
    readonly failure: unknown,
  ) {
    super(
      `oracle consolidation stopped after ${report.batchesRun} of ${report.batches} batch(es), with ${report.changed} change(s) already COMMITTED: ${
        failure instanceof Error ? failure.message : String(failure)
      }`,
    );
    this.name = 'PartialOracleRunError';
  }
}

/**
 * Internal: what the rollback ladder settled on, INSIDE the write transaction.
 *
 * It is deliberately not a {@link RollbackReport}: in here the compensating entry is still
 * 'in-flight' — the transaction can take it back — so the success branch carries the raw
 * {@link JournalAppend} handle and rollback() turns it into the caller-facing report once the
 * transaction has settled. That is what makes a success report with no outcome unconstructible
 * rather than merely unusual.
 */
type RollbackSettlement =
  | { refusal: RollbackRefused }
  | { reverted: number; append: JournalAppend };

/** Internal: a row's current state no longer matches what the target batch recorded. Thrown
 *  inside the rollback transaction so the WHOLE rollback (all mutations + the compensating
 *  entry) unwinds — zero partial effects. */
class RollbackPreconditionError extends Error {
  constructor(
    message: string,
    readonly detail: { id: string; expected: string; actual: string },
  ) {
    super(message);
  }
}

/**
 * The Consolidation Protocol (spec §6). Deterministic passes are always-on, local, keyless. The
 * oracle path runs only with a provider (BYO key), sends egress-masked bounded batches, and applies
 * only schema-valid, in-batch output — through the journal, so any run is one command to roll back.
 */
export class ConsolidationService {
  constructor(
    private readonly store: StorageDriver,
    private readonly journal: JournalService,
    /** masks secrets in oracle-minted content before it is stored (invariant 5) */
    private readonly masker?: SecretMasker,
  ) {}

  /** Exact dedupe (sha256) + near-dupe (MinHash) + decay — applied as one journaled batch.
   *  EVERYTHING — the active snapshot, the dedupe groups, and each change's `from` status — is
   *  computed INSIDE the write transaction that applies it: the writer lock is taken
   *  before the first read, so a concurrent confirm/reject can never be silently overwritten
   *  and the journal never certifies a stale pre-state. */
  runDeterministic(opts: {
    now: number;
    decay?: DecayConfig;
    nearDupeThreshold?: number;
  }): DeterministicReport {
    const decay = opts.decay ?? DEFAULT_DECAY;
    const { report, appends } = this.store.writeTransaction(() =>
      this.runDeterministicLocked(opts, decay),
    );
    return withOutcomes(report, appends);
  }

  private runDeterministicLocked(
    opts: { now: number; nearDupeThreshold?: number },
    decay: DecayConfig,
  ): { report: Omit<DeterministicReport, 'outcomes'>; appends: JournalAppend[] } {
    const appends: JournalAppend[] = [];
    const active = this.store.listMemories().filter((m) => m.status !== 'archived');
    const changes: AppliedChange[] = [];
    const archivedIds = new Set<string>();
    const archive = (m: Memory, mergedInto?: string): void => {
      if (!archivedIds.has(m.id)) {
        archivedIds.add(m.id);
        changes.push(
          mergedInto
            ? { kind: 'memory_status', id: m.id, from: m.status, to: 'archived', mergedInto }
            : { kind: 'memory_status', id: m.id, from: m.status, to: 'archived' },
        );
      }
    };

    // Exact dedupe groups by scope+type+content — dedupe never crosses scope or type.
    let exactDupes = 0;
    const byKey = new Map<string, Memory[]>();
    for (const m of active) {
      const key = dedupeKey(m.scope, m.type, m.content);
      const group = byKey.get(key);
      if (group) {
        group.push(m);
      } else {
        byKey.set(key, [m]);
      }
    }
    for (const group of byKey.values()) {
      if (group.length < 2) {
        continue;
      }
      const ranked = [...group].sort(rank);
      // Trust boundary: a proposal can never displace a confirmed memory. If any confirmed row
      // exists, the best confirmed survives and everything else — other confirmed dupes AND every
      // proposal of the same content — archives into it (a redundant proposal of confirmed content
      // is safe to fold: same direction as reject, reversible via rollback). Only when the whole
      // group is proposed does the best proposal survive.
      const survivor = ranked.find((m) => m.status === 'confirmed') ?? ranked[0];
      for (const dup of ranked) {
        if (dup.id === survivor?.id) {
          continue;
        }
        archive(dup, survivor?.id);
        exactDupes++;
      }
    }

    // Near-dupe detection runs only within one scope+type+status partition: cross-status folding
    // would let a proposal absorb (or be absorbed by) confirmed memory without review, and
    // cross-scope/type folding would break the same boundary as exact dedupe.
    let nearDupes = 0;
    const survivors = active.filter((m) => !archivedIds.has(m.id));
    const partitions = new Map<string, Memory[]>();
    for (const m of survivors) {
      const key = `${m.scope}\u0000${m.type}\u0000${m.status}`;
      const part = partitions.get(key);
      if (part) {
        part.push(m);
      } else {
        partitions.set(key, [m]);
      }
    }
    for (const part of partitions.values()) {
      for (const { a, b } of nearDupePairs(
        part,
        (m) => m.content,
        opts.nearDupeThreshold ?? 0.85,
      )) {
        if (archivedIds.has(a.id) || archivedIds.has(b.id)) {
          continue;
        }
        const keep = rank(a, b) <= 0 ? a : b;
        archive(keep === a ? b : a, keep.id);
        nearDupes++;
      }
    }

    let decayed = 0;
    for (const m of active) {
      if (archivedIds.has(m.id)) {
        continue;
      }
      if (shouldArchive(m, opts.now, decay)) {
        archive(m);
        decayed++;
      }
    }

    let batchId: string | undefined;
    if (changes.length > 0) {
      batchId = newId();
      // Same transaction as the compute above (runDeterministic holds the write lock): apply
      // the store mutations AND journal them atomically.
      for (const c of changes) {
        if (c.kind === 'memory_status') {
          this.store.updateMemory(c.id, { status: 'archived', updatedAt: opts.now });
        }
      }
      appends.push(
        this.journal.append({
          ts: opts.now,
          actor: 'consolidate',
          op: 'consolidate',
          payload: { batch: batchId, mode: 'deterministic', changes },
        }),
      );
    }
    return {
      report: { exactDupes, nearDupes, decayed, changed: changes.length, batchId },
      appends,
    };
  }

  /**
   * Run oracle consolidation over egress-masked bounded batches. Rejected output applies nothing.
   *
   * EACH BATCH IS INSPECTED THE MOMENT IT RETURNS, before another one is attempted. A batch is its
   * own durable commit, so the run is a SEQUENCE of independent outcomes rather than one: reading
   * them only after the last batch means a batch that committed while the anchor did not advance is
   * followed by another batch against a store that has stopped accepting writes — whose refusal
   * throws, taking the committed batch's outcome with it. So a committed-unanchored batch STOPS the
   * run and RETURNS the report (`ended: 'committed-unanchored'`), and a throw that arrives after
   * anything has committed is re-raised as {@link PartialOracleRunError}, carrying every committed
   * outcome and the exact counts. A throw with nothing committed yet is an ordinary failure and
   * propagates unchanged.
   */
  async runOracle(opts: {
    now: number;
    provider: ProviderPort;
    systemPrompt: string;
    promptVersion: string;
    mask: (content: string) => string;
    /** only process the latest N active memories (listMemories is created_at DESC) */
    limit?: number;
    /** only process memories of this type (e.g. 'semantic' to consolidate distilled facts) */
    type?: Memory['type'];
  }): Promise<OracleReport> {
    let active = this.store.listMemories().filter((m) => m.status !== 'archived');
    if (opts.type) {
      active = active.filter((m) => m.type === opts.type);
    }
    if (opts.limit != null) {
      active = active.slice(0, opts.limit);
    }
    const batches: Memory[][] = [];
    for (let i = 0; i < active.length; i += MAX_BATCH) {
      batches.push(active.slice(i, i + MAX_BATCH));
    }

    let appliedBatches = 0;
    let rejectedBatches = 0;
    let changed = 0;
    let skippedGroups = 0;
    let skippedOps = 0;
    let contradictions = 0;
    const appends: JournalAppend[] = [];
    let batchesRun = 0;

    /** The run AS IT STANDS — usable at any point in the loop, not only after the last batch. */
    const runSoFar = (ended: OracleReport['ended']): OracleReport =>
      withOutcomes(
        {
          batches: batches.length,
          batchesRun,
          ended,
          appliedBatches,
          rejectedBatches,
          changed,
          skippedGroups,
          skippedOps,
          contradictions,
        },
        appends,
      );
    /** The receipts of everything this run has already made durable. */
    const committedSoFar = (): CommitReceipt[] => committedReceipts(appends.map((a) => a.outcome));

    for (const batch of batches) {
      batchesRun++;
      try {
        const items = batch.map((m) => ({ id: m.id, content: opts.mask(m.content) }));
        const result = await runOracleBatch(items, opts.provider, opts.systemPrompt);
        if (!result.applied) {
          appends.push(
            this.journal.append({
              ts: opts.now,
              actor: `oracle:${opts.provider.id}`,
              op: 'consolidate_rejected',
              payload: { reason: result.reason },
              model: opts.provider.id,
              promptVersion: opts.promptVersion,
            }),
          );
          // COUNTED ONLY NOW — after the append above settled. `rejectedBatches` is a DURABLE
          // counter on a report the caller trusts after a partial run, so it says how many
          // rejections are IN THE JOURNAL, never how many the model pronounced: an append that
          // throws leaves nothing to find, and a count of it sends the reader looking for an
          // entry that does not exist.
          rejectedBatches++;
        } else {
          // ONE BATCH, ONE TRANSACTION, ONE ACCOUNT. The store mutations, the `consolidate` entry
          // that makes them rollbackable, and every piece of EVIDENCE the batch produced — the
          // contradiction pairs it flagged, the merge groups it discarded, the ops whose targets
          // moved — are journaled inside the SAME transaction that applies the changes.
          //
          // Written as separate top-level appends afterwards, each of those was an independent
          // durable commit that could fail on its own, and the counters were incremented on either
          // side of them: a batch could archive a memory, commit its `consolidate` entry, have the
          // contradiction append REFUSED by the store its own commit had just blocked, and report
          // `appliedBatches=0, changed=0, contradictions=1` — three numbers, all false, over a
          // durably archived memory and a contradiction that was never journaled. A partial report
          // exists so a caller can trust what is durable, so it may describe DURABLE FACTS ONLY.
          //
          // Atomic rather than settle-each-append: the evidence is what makes the applied changes
          // reviewable, and a batch whose changes are durable while its contradictions are not has
          // no honest description at all. One transaction gives one commit edge, one anchor
          // verdict, and one set of counts to increment — after it has settled.
          //
          // The batch's handles are collected PER ATTEMPT and adopted by the run only once the
          // transaction has returned. The driver re-runs this body on a busy BEGIN, and an attempt
          // that rolled back took its entries with it — pushed straight into the run's list, that
          // dead attempt leaves a handle behind for an entry the database no longer holds.
          const batchAppends: JournalAppend[] = [];
          const applied = this.applyOracleOps(result.ops, batch, opts.now, (a) => {
            batchAppends.length = 0;
            if (a.changes.length > 0) {
              batchAppends.push(
                this.journal.append({
                  ts: opts.now,
                  actor: `oracle:${opts.provider.id}`,
                  op: 'consolidate',
                  payload: { batch: newId(), mode: 'oracle', changes: a.changes },
                  model: opts.provider.id,
                  promptVersion: opts.promptVersion,
                }),
              );
            }
            // Contradictions the oracle flagged are REVIEW EVIDENCE, never mutations: the runner
            // already enforced that both ids are in-batch (out-of-batch references rejected the
            // whole batch), so journal the validated pairs — with the model-authored reason masked
            // and bounded — and touch no memory. The user decides what a contradiction means.
            if (result.ops.contradictions.length > 0) {
              batchAppends.push(
                this.journal.append({
                  ts: opts.now,
                  actor: `oracle:${opts.provider.id}`,
                  op: 'consolidate_contradictions',
                  payload: {
                    pairs: result.ops.contradictions.map((c) => ({
                      a: c.a,
                      b: c.b,
                      reason: this.maskReason(c.reason),
                    })),
                  },
                  model: opts.provider.id,
                  promptVersion: opts.promptVersion,
                }),
              );
            }
            if (a.skippedGroups > 0) {
              // Same journaled-rejection pattern as a rejected batch: the boundary violation is
              // auditable even though the rest of the batch applied.
              batchAppends.push(
                this.journal.append({
                  ts: opts.now,
                  actor: `oracle:${opts.provider.id}`,
                  op: 'consolidate_rejected',
                  payload: {
                    reason: `${a.skippedGroups} merge group(s) spanned more than one scope or type, crossed a status boundary, or referenced memories that changed since the batch was read — skipped (dedupe never crosses scope, type, or review status)`,
                  },
                  model: opts.provider.id,
                  promptVersion: opts.promptVersion,
                }),
              );
            }
            if (a.skippedOps > 0) {
              // Ops whose target vanished or changed status while the LLM call was in flight: the
              // store, not the snapshot, decides — skipped and journaled.
              batchAppends.push(
                this.journal.append({
                  ts: opts.now,
                  actor: `oracle:${opts.provider.id}`,
                  op: 'consolidate_rejected',
                  payload: {
                    reason: `${a.skippedOps} op(s) targeted memories that were archived, changed, or removed after the batch was read — skipped`,
                  },
                  model: opts.provider.id,
                  promptVersion: opts.promptVersion,
                }),
              );
            }
          });
          appends.push(...batchAppends);
          // COUNTED ONLY NOW — after the transaction above returned, i.e. after it committed.
          // A transaction that unwound took its rows AND its entries with it, and it must take the
          // counts with them too.
          if (applied.changes.length > 0) {
            appliedBatches++;
            changed += applied.changes.length;
          }
          contradictions += result.ops.contradictions.length;
          skippedGroups += applied.skippedGroups;
          skippedOps += applied.skippedOps;
        }
      } catch (err) {
        // Nothing durable yet: an ordinary failed run, and the caller may read the exception as
        // "this run changed nothing".
        if (committedSoFar().length === 0) {
          throw err;
        }
        // Earlier batches ARE durable. Their outcomes and exact counts travel WITH the failure
        // rather than being erased by it.
        throw new PartialOracleRunError(runSoFar('failed'), err);
      }
      // Inspected HERE — after every batch, before another one is attempted. A batch that
      // committed while the anchor did not advance has blocked every further write, so continuing
      // would refuse, throw, and take what this batch just made durable with it.
      if (committedSoFar().some((r) => isDegradedReceipt(r))) {
        return runSoFar('committed-unanchored');
      }
    }
    return runSoFar('complete');
  }

  /** Mask (invariant 5 — oracle output is untrusted) then bound a contradiction reason for the
   *  journal. Mask FIRST: truncating first could shear a secret into an undetectable fragment. */
  private maskReason(reason: string): string {
    const masked = this.masker ? this.masker.maskSecrets(reason).masked : reason;
    return masked.length > MAX_CONTRADICTION_REASON
      ? `${masked.slice(0, MAX_CONTRADICTION_REASON)}…`
      : masked;
  }

  /**
   * Apply one batch's ops and journal everything it produced, inside ONE write transaction.
   *
   * `journalBatch` is called with the SETTLED result of the ops — the changes that applied and the
   * counts that were skipped — while the transaction is still open, so the entries it appends
   * commit or unwind with the rows they describe. It runs UNCONDITIONALLY, including when nothing
   * applied: a batch can produce evidence (a flagged contradiction, a discarded merge group) with
   * zero changes, and that evidence is journaled just the same.
   */
  private applyOracleOps(
    ops: OracleOutput,
    batch: Memory[],
    now: number,
    journalBatch: (applied: {
      changes: AppliedChange[];
      skippedGroups: number;
      skippedOps: number;
    }) => void,
  ): { changes: AppliedChange[]; skippedGroups: number; skippedOps: number } {
    // The batch snapshot is STALE by construction — it crossed an awaited LLM call. Everything
    // below runs inside ONE write transaction: every id is re-read under the writer
    // lock, and ops whose target vanished or changed status since the snapshot are skipped, so
    // the journal records the true in-transaction pre-state (`from`), never the snapshot's — a
    // later rollback can then never silently revert a user's concurrent confirm/reject.
    return this.store.writeTransaction(() => {
      const current = new Map<string, Memory>();
      for (const m of batch) {
        const row = this.store.getMemory(m.id);
        if (row) {
          current.set(m.id, row);
        }
      }
      const changes: AppliedChange[] = [];
      const archivedIds = new Set<string>();
      let skippedOps = 0;
      // `mergedInto`: provenance — the id this memory was folded into (undefined for a plain
      // archive). A missing or already-archived target is a SKIP (counted), never an apply.
      const archive = (id: string, mergedInto?: string): void => {
        if (archivedIds.has(id)) {
          return;
        }
        const m = current.get(id);
        if (!m || m.status === 'archived') {
          skippedOps++;
          return;
        }
        archivedIds.add(id);
        changes.push(
          mergedInto
            ? { kind: 'memory_status', id, from: m.status, to: 'archived', mergedInto }
            : { kind: 'memory_status', id, from: m.status, to: 'archived' },
        );
      };
      // merge: keep the first id in each group, archive the rest — recording which id they
      // merged into. A group is discarded WHOLE when any member vanished/was archived since the
      // snapshot, or when it spans more than one scope, type, or STATUS: oracle merges are
      // semantic (not identical content), so folding across the review boundary would let a
      // proposal absorb — or be absorbed by — confirmed memory without review. The
      // oracle proposes; the runtime disposes.
      let skippedGroups = 0;
      for (const group of ops.merge) {
        const members: Memory[] = [];
        let stale = false;
        for (const id of group) {
          const m = current.get(id);
          if (!m || m.status === 'archived') {
            stale = true;
            break;
          }
          members.push(m);
        }
        if (stale) {
          skippedGroups++;
          continue;
        }
        const identities = new Set(
          members.map((m) => `${m.scope}\u0000${m.type}\u0000${m.status}`),
        );
        if (identities.size > 1) {
          skippedGroups++;
          continue;
        }
        const into = group[0];
        for (const id of group.slice(1)) {
          archive(id, into);
        }
      }
      for (const id of ops.archive) {
        archive(id);
      }
      // promote: mint a new semantic memory (proposal), stamped with the source it was
      // distilled from. A source archived or removed since the snapshot (a concurrent reject)
      // is skipped — distilling from rejected memory would carry it past the review boundary.
      const inserts: Memory[] = [];
      for (const p of ops.promote) {
        const source = current.get(p.from);
        if (!source || source.status === 'archived') {
          skippedOps++;
          continue;
        }
        // inserts below go through store.insertMemory (not MemoryService), so invariant 5's
        // write-time secret masking must happen here — oracle content is untrusted
        const content = this.masker ? this.masker.maskSecrets(p.to_content).masked : p.to_content;
        const m: Memory = {
          id: newId(),
          type: 'semantic',
          scope: source.scope,
          content,
          provenance: { source: 'oracle-distill', distilledFrom: [p.from], conversationId: p.from },
          confidence: Math.max(source.confidence, 0.6),
          boosts: 0,
          status: 'proposed',
          source: 'oracle',
          createdAt: now,
          updatedAt: now,
          lastRetrievedAt: null,
          decayAt: null,
        };
        inserts.push(m);
        // `digest` commits to the row's identity fields AS INSERTED: rollback
        // recomputes it from the current row and refuses to delete an edited proposal.
        changes.push({
          kind: 'memory_insert',
          id: m.id,
          digest: memoryInsertDigest(m),
          distilledFrom: [p.from],
        });
      }

      for (const c of changes) {
        if (c.kind === 'memory_status') {
          this.store.updateMemory(c.id, { status: 'archived', updatedAt: now });
        }
      }
      for (const m of inserts) {
        this.store.insertMemory(m);
      }
      const applied = { changes, skippedGroups, skippedOps };
      journalBatch(applied);
      return applied;
    });
  }

  /**
   * Revert a consolidation batch by journal id via compensating entries (spec §6).
   *
   * The ENTIRE ladder below — verification included — runs inside ONE write transaction
   * (BEGIN IMMEDIATE: the writer lock is held before the first read), so ALL DATABASE READS
   * AND MUTATIONS ARE ATOMIC: there is no window in which the journal or a target row can
   * change between what was verified and what is applied — the verified view IS the applied
   * view. External-file effects (the journal checkpoint mirror) are NOT covered by that
   * transaction; they are only coordinated via the post-commit flush: verification runs in its
   * NON-HEALING mode (`verify({ heal: false })`), so a refusal performs zero external-file
   * writes, and on success the compensating append's post-commit mirror is the only thing that
   * touches the checkpoint file.
   *
   * Fail-closed ladder (all inside the transaction):
   *  1. the WHOLE journal must verify (chain + checkpoint) — a tampered journal is not a
   *     source of truth for what to undo — AND must be AUTHENTICATED: state
   *     'checkpoint-disabled' (no MAC-capable crypto) refuses, because an unkeyed chain can be
   *     rewritten wholesale by whoever can edit the db file;
   *  2. the target must be a 'consolidate' entry whose payload passes the strict schema;
   *  3. a batch already rolled back refuses (replaying a rollback would overwrite every
   *     decision made since the first one);
   *  4. every current row must still match the recorded post-state, then all inverses AND the
   *     compensating entry apply together — one stale row (or any mid-flight failure) unwinds
   *     everything, zero net mutations.
   */
  rollback(journalId: number, now: number): RollbackReport {
    try {
      const settled = this.store.writeTransaction(() => this.rollbackLocked(journalId, now));
      if ('refusal' in settled) {
        return settled.refusal;
      }
      const { append } = settled;
      // A LIVE view, for the same reason the reports above carry one: the compensating entry has no
      // outcome until the transaction that wrote it settles, which for a composed rollback is after
      // this returns. It is defined onto the success branch rather than offered as an option: that
      // branch's type REQUIRES it, so there is no shape of this value that omits the outcome.
      return Object.defineProperty({ ok: true as const, reverted: settled.reverted }, 'outcome', {
        get: (): MutationOutcome => append.outcome,
        enumerable: true,
      }) as RollbackReverted;
    } catch (err) {
      // Thrown INSIDE the transaction so every mutation — including any same-connection write
      // that slipped in after verification — unwinds with it: zero net mutations on refusal.
      if (err instanceof RollbackPreconditionError) {
        return { ok: false, reason: err.message, reverted: 0, failedPrecondition: err.detail };
      }
      throw err;
    }
  }

  /** The rollback ladder body. MUST run under the write lock (rollback() wraps it): every read
   *  below — verify()'s journal walk, the target lookup, the replay scan, each precondition —
   *  observes the same locked view the mutations then apply to. */
  private rollbackLocked(journalId: number, now: number): RollbackSettlement {
    // (1) journal authenticity — ok covers state 'ok' / 'pristine'; 'checkpoint-disabled'
    // refuses. NON-HEALING mode: a rollback that is about to refuse must not have mutated the
    // external checkpoint file first; a legitimately lagging external is healed by the
    // compensating append's post-commit flush instead.
    const chain = this.journal.verify({ heal: false });
    if (!chain.ok) {
      return {
        refusal: {
          ok: false,
          reason: `refusing rollback: journal failed verification — ${chain.reason ?? 'unknown failure'}`,
          reverted: 0,
        },
      };
    }
    if (chain.state === 'checkpoint-disabled') {
      return {
        refusal: {
          ok: false,
          reason:
            'refusing rollback: journal history cannot be authenticated — checkpointing is unavailable (no MAC-capable crypto wired)',
          reverted: 0,
        },
      };
    }
    const target = this.store.allJournal().find((r) => r.id === journalId);
    if (!target) {
      return { refusal: { ok: false, reason: `no journal entry #${journalId}`, reverted: 0 } };
    }
    // (2) strict target validation
    if (target.op !== 'consolidate') {
      return {
        refusal: {
          ok: false,
          reason: `entry #${journalId} is a '${target.op}' entry, not a consolidate batch — only consolidate batches can be rolled back`,
          reverted: 0,
        },
      };
    }
    const parsed = ConsolidatePayloadSchema.safeParse(target.payload);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      // report the location + failure code, never the (attacker-controllable) payload content
      return {
        refusal: {
          ok: false,
          reason: `entry #${journalId} payload failed strict validation at '${issue?.path.join('.') || '(root)'}' (${issue?.code ?? 'invalid'}) — refusing to roll back`,
          reverted: 0,
        },
      };
    }
    // (3) replay guard
    const prior = this.store
      .allJournal()
      .find(
        (r) =>
          r.op === 'rollback' &&
          (r.payload as { rollsBack?: unknown } | null)?.rollsBack === journalId,
      );
    if (prior) {
      return {
        refusal: {
          ok: false,
          reason: `entry #${journalId} was already rolled back by entry #${prior.id} — rolling it back again would overwrite decisions made since`,
          reverted: 0,
        },
      };
    }

    const plan = planRollback({ ...target, payload: parsed.data }, now, 'cli');
    if (plan.inverse.length === 0) {
      return {
        refusal: {
          ok: false,
          reason: `entry #${journalId} has no reversible changes`,
          reverted: 0,
        },
      };
    }

    // (4) preconditions + inverses + compensating entry — same transaction as the verification
    // above, all-or-nothing (a precondition failure THROWS, unwinding the whole transaction)
    for (const c of plan.inverse) {
      this.checkRollbackPrecondition(c);
    }
    let applied = 0;
    for (const c of plan.inverse) {
      if (c.kind === 'memory_status') {
        this.store.updateMemory(c.id, { status: c.to, updatedAt: now });
        applied++;
      } else if (c.kind === 'memory_content') {
        this.store.updateMemory(c.id, { content: c.to, updatedAt: now });
        applied++;
      } else if (c.kind === 'memory_insert') {
        // inverse of an insert: delete the row (digest + status verified above)
        this.store.deleteMemory(c.id);
        applied++;
      }
    }
    // The compensating entry's outcome is read by rollback() AFTER this transaction returns: in
    // here it is 'in-flight', and a report claiming a rollback happened would be claiming it for
    // rows the transaction can still take back.
    return { reverted: applied, append: this.journal.append(plan.entry) };
  }

  /** Verify one INVERSE change still applies: the row's current state must equal the post-state
   *  the original batch recorded (which is the inverse's `from` side). Throws on any mismatch. */
  private checkRollbackPrecondition(c: AppliedChange): void {
    const row = this.store.getMemory(c.id);
    switch (c.kind) {
      case 'memory_status': {
        // undoing original from→to; the row must still be in `to` (= this inverse's `from`)
        if (!row) {
          throw new RollbackPreconditionError(
            `memory ${c.id} no longer exists (expected status '${c.from}') — nothing was rolled back`,
            { id: c.id, expected: `status '${c.from}'`, actual: 'row missing' },
          );
        }
        if (row.status !== c.from) {
          throw new RollbackPreconditionError(
            `memory ${c.id} changed after consolidation: expected status '${c.from}', found '${row.status}' — rolling back would overwrite a newer decision; nothing was rolled back`,
            { id: c.id, expected: `status '${c.from}'`, actual: `status '${row.status}'` },
          );
        }
        return;
      }
      case 'memory_content': {
        if (!row) {
          throw new RollbackPreconditionError(
            `memory ${c.id} no longer exists (expected its consolidated content) — nothing was rolled back`,
            { id: c.id, expected: 'recorded content', actual: 'row missing' },
          );
        }
        if (row.content !== c.from) {
          throw new RollbackPreconditionError(
            `memory ${c.id} content changed after consolidation — rolling back would overwrite a newer edit; nothing was rolled back`,
            { id: c.id, expected: 'recorded content', actual: 'different content' },
          );
        }
        return;
      }
      case 'memory_insert': {
        // undoing a memory_insert (deleting the inserted proposal): only an UNTOUCHED proposal
        // may be deleted again — status must still be 'proposed' AND the recorded post-state
        // digest must recompute identically from the current row.
        if (!row) {
          throw new RollbackPreconditionError(
            `memory ${c.id} no longer exists (expected the inserted proposal) — nothing was rolled back`,
            { id: c.id, expected: "status 'proposed'", actual: 'row missing' },
          );
        }
        if (row.status !== 'proposed') {
          throw new RollbackPreconditionError(
            `memory ${c.id} was ${row.status} after consolidation; reject it explicitly instead of rolling back — nothing was rolled back`,
            { id: c.id, expected: "status 'proposed'", actual: `status '${row.status}'` },
          );
        }
        if (memoryInsertDigest(row) !== c.digest) {
          throw new RollbackPreconditionError(
            `memory ${c.id} was edited after consolidation (its content, type, scope, source, confidence, or provenance changed) — rolling back would delete the edited proposal; nothing was rolled back`,
            {
              id: c.id,
              expected:
                'recorded insert digest over {content,type,scope,source,confidence,provenance}',
              actual: 'digest mismatch — at least one of those fields changed',
            },
          );
        }
        return;
      }
    }
  }
}
