import { isId, newId } from '../domain/ids.js';
import type {
  AnchorOutcome,
  ChainVerification,
  CommitReceipt,
  JournalDraft,
  JournalRecord,
  MutationOutcome,
} from '../domain/journal.js';
import type { StorageDriver } from '../store/driver.js';
import type { CryptoPort } from '../vault/crypto.js';
import { maskDeep } from '../vault/mask-deep.js';
import {
  type Checkpoint,
  type CheckpointStore,
  JOURNAL_CHECKPOINT_KEY,
  buildCheckpoint,
  parseCheckpoint,
  replaceCheckpoint,
  verifyCheckpoint,
} from './checkpoint.js';
import { sealEntry, verifyChain } from './journal.js';
import { MEMORY_INSERT_DIGEST_RE, type RollbackPlan, planRollback } from './rollback.js';

/**
 * Optional wiring for the journal's safety rails. All fields are optional so existing
 * `new JournalService(store)` call sites (and browser builds without them) keep working.
 */
export interface JournalServiceOptions {
  /** MAC-capable crypto → authenticated checkpoints. Absent or without `mac`:
   *  verify() reports state 'checkpoint-disabled'. */
  crypto?: Pick<CryptoPort, 'mac'>;
  /** second checkpoint copy stored OUTSIDE the database (survives whole-db replacement) */
  external?: CheckpointStore;
  /** write-time secret masker: the journal is append-only and hash-chained, so any
   *  string that enters it unmasked is at rest permanently. VaultService satisfies this. */
  masker?: { maskSecrets(s: string): { masked: string; warnings: string[] } };
  /** non-fatal problem sink (core is browser-clean — it cannot write to stderr itself) */
  warn?: (message: string) => void;
  /**
   * Evidence, captured by the CALLER before opening crypto/store (opening creates the key), that
   * this installation was initialized before: the key file, the clients-state ledger, or the
   * external checkpoint file already existed. With it set, an empty journal with no authentic
   * checkpoint is ERASED HISTORY, not a pristine store — verify() fails and the TOFU auto-seal
   * refuses until the explicit `sthayi journal reseal`. Absent (core tests, browser builds):
   * the pristine state stays reachable.
   */
  priorInstall?: boolean;
  /**
   * The external checkpoint store cannot be written by this session (doctor's read-only open wraps
   * it so every write refuses).
   *
   * IT SUPPRESSES BLAME, NOT THE VERDICT. Observation must not turn "I am not allowed to write"
   * into "this store is broken", so a read-only session never reports the FAILED WRITE as the
   * problem (see failureAfterHealThrew). It does NOT buy a green verdict for an anchor that is
   * objectively missing or stale: whether the external copy holds the live checkpoint is a
   * property of the STORE, identical for every observer, and a read-only session that reported
   * 'ok' over a missing anchor would be doctor telling the user the off-database guarantee is in
   * place when it is not. Step (8) of verify() therefore runs for read-only sessions too.
   */
  externalReadOnly?: boolean;
}

/**
 * What ONE attempt to mirror the database checkpoint into the external file actually did.
 *
 * The mirror reports an outcome rather than returning void with a best-effort warning: a flush that
 * never landed must not be able to ride out of `seal()` as an unqualified success. Every terminal
 * state is enumerated here so a caller can DISTINGUISH "the file holds the new checkpoint" from
 * "the file was left alone", instead of inferring it from the absence of a throw:
 *  - 'disabled' — no external store or no MAC-capable crypto: there is nothing to mirror;
 *  - 'skipped'  — the database holds no checkpoint to mirror;
 *  - 'current'  — the file already held exactly these bytes; nothing was written;
 *  - 'written'  — the file holds them because this attempt wrote them;
 *  - 'refused'  — a guard (source, destination authenticity, ratchet, compare-and-swap) declined,
 *                 deliberately leaving the destination byte-identical;
 *  - 'failed'   — the attempt THREW (lock contention, I/O, a hostile destination path);
 *  - 'deferred' — a legacy driver was mid-transaction, so nothing ran at all. It is NEVER a
 *                 success: a caller that needs an outcome must run the mirror itself afterwards.
 * Only 'written', 'current' and 'disabled' mean the file is not standing in the way; the rest
 * mean the external copy did not reach the checkpoint the database now holds.
 */
export type FlushState =
  | 'disabled'
  | 'skipped'
  | 'current'
  | 'written'
  | 'refused'
  | 'failed'
  | 'deferred';

export interface FlushOutcome {
  state: FlushState;
  /** why, for every state that did not put the current checkpoint at the destination */
  reason?: string;
}

/**
 * Meta key holding the identity of the transaction that armed the external-mirror exemption.
 *
 * IT IS WRITTEN INSIDE THAT TRANSACTION, and that is the entire point: the database's own
 * transaction semantics then give the exemption its lifecycle for free. A COMMIT publishes the
 * token (and the settle callback drops the in-memory half); a ROLLBACK — including a forced one,
 * which discards `afterCommit` callbacks without telling anyone — takes the token away with every
 * other write of that transaction, so the surviving in-memory token can never match again. No
 * heuristic, no "is a transaction open" guess: the value is only there while the transaction that
 * wrote it is alive.
 *
 * A driver that implements `StorageDriver.transactionId()` is bound by THAT as well (checked
 * first); this token is what makes the binding work on drivers that do not.
 */
export const JOURNAL_TX_TOKEN_KEY = 'journal_tx_token';

/**
 * The external mirror QUEUED for one specific caller transaction's commit — and the identity of
 * that transaction.
 *
 * WHY IT EXISTS. The off-database anchor invariant (verify step 8) is "the checkpoint file holds
 * the live meta checkpoint". Between the appends of ONE caller transaction that is momentarily
 * false by design: the mirror is an afterCommit callback (it must never publish a checkpoint for
 * rows a rollback could still discard), so the second append of a batch sees a file that is one
 * entry behind. That IN-FLIGHT lag is legitimate; a COMMITTED STALE anchor is a violation.
 *
 * WHY IT IS BOUND TO A TRANSACTION. A bare `{ raw }` value scoped to the SERVICE INSTANCE would
 * outlive the transaction that created it: a forced rollback discards the SQLite afterCommit queue
 * without clearing anything in the service, so the next transaction on the same long-lived instance
 * (an MCP server holds one for its whole lifetime) would inherit the exemption and spend it
 * excusing an anchor that has actually frozen. Every field below exists to make that impossible —
 * `txId` and `token` say WHICH transaction, `minted` says our append is still in flight, and the
 * settle callback clears the whole thing at the commit edge.
 */
interface MirrorExemption {
  /** the exact checkpoint bytes committed when this transaction began — the only value the
   *  external copy may still legitimately hold while this transaction's mirror is outstanding.
   *  Legitimately `undefined` on a pristine store whose transaction mints the first checkpoint. */
  raw: string | undefined;
  /** driver-supplied transaction identity, when the driver implements `transactionId()` */
  txId: number | undefined;
  /** database-backed transaction identity (see JOURNAL_TX_TOKEN_KEY) */
  token: string;
  /** the meta checkpoint OUR latest in-flight append wrote — visible only while it is in flight */
  minted: string | undefined;
  /**
   * May this exemption grant the step-8 TOLERANCE, or does it only record that an append of ours
   * is uncommitted in this transaction?
   *
   * FALSE for a driver that can report NEITHER `onSettle` NOR `afterCommit`: nothing would clear
   * the exemption at the commit edge there, so it must never loosen anything. It is still ARMED,
   * because it carries a fact the gate needs in the STRICT direction — our meta checkpoint is
   * uncommitted, so the gate must not heal (publishing a checkpoint for rows the caller can still
   * roll back). Such a driver therefore refuses the batch's second append instead of either
   * publishing early or riding on a token that outlived its transaction.
   */
  tolerated: boolean;
}

/**
 * ONE ENTRY THIS PROCESS APPENDED, AND THE OUTCOME OF THE TRANSACTION THAT WROTE IT.
 *
 * WHY THE APPEND DOES NOT SIMPLY RETURN A RECEIPT. `appendJournal` runs inside a transaction the
 * CALLER may still own, and that transaction can roll back after the append returns. A receipt
 * minted at that moment would be asserting durability the database has not promised — and it is
 * exactly the value a caller keeps, prints, exits on, and hands to a client. So the append returns
 * this handle, and a {@link CommitReceipt} is constructed only on the COMMIT edge, from what the
 * off-database mirror actually did there.
 *
 * `outcome` is DERIVED ON EVERY READ, never a snapshot taken when the handle was made: the same
 * handle answers 'in-flight' inside the transaction and 'committed'/'rolled-back' after it settles.
 */
export interface JournalAppend {
  /** the sealed row as written — its `id` is authoritative ONLY once the outcome is 'committed' */
  readonly record: JournalRecord;
  /**
   * `record.id`. A ROLLBACK returns this id to the store's allocator, so on a rolled-back append
   * it names an entry that does not exist and that a LATER append will legitimately take. Read it
   * as an identity only on the 'committed' branch.
   */
  readonly journalId: number;
  /** domain rows this operation created or changed (memory ids), as supplied to `append` */
  readonly ids: readonly string[] | undefined;
  /** see {@link MutationOutcome} — 'in-flight' until the OUTERMOST transaction settles */
  readonly outcome: MutationOutcome;
}

/**
 * The mutable half of {@link JournalAppend}: it settles ONCE, at the first edge it is told about,
 * and every later report is ignored.
 *
 * FIRST WRITER WINS, in both directions. A rollback edge arriving after the mirror already
 * committed the receipt cannot retract a durable write; a commit edge arriving after a rollback was
 * reported (a stale callback that outlived its transaction, drained by an unrelated later one)
 * cannot resurrect rows that no longer exist. Latching is what keeps a callback that escaped its
 * transaction from rewriting a settled outcome.
 */
class AppendHandle implements JournalAppend {
  private settled: MutationOutcome | undefined;

  constructor(
    readonly record: JournalRecord,
    readonly ids: readonly string[] | undefined,
  ) {}

  get journalId(): number {
    return this.record.id;
  }

  get outcome(): MutationOutcome {
    return this.settled ?? { state: 'in-flight' };
  }

  /** The transaction COMMITTED and the mirror ran: mint the receipt from what it achieved. */
  settleCommitted(anchor: AnchorOutcome, reason: string | undefined): void {
    if (this.settled !== undefined) {
      return;
    }
    const receipt: CommitReceipt = {
      committed: true,
      record: this.record,
      journalId: this.record.id,
      ...(this.ids === undefined ? {} : { ids: [...this.ids] }),
      anchor,
      ...(reason === undefined ? {} : { reason }),
      writesBlocked: anchor === 'unanchored',
      doNotRetry: anchor === 'unanchored',
    };
    this.settled = { state: 'committed', receipt };
  }

  /** The transaction ROLLED BACK: nothing is durable, so there is no receipt to hand anyone. */
  settleRolledBack(): void {
    if (this.settled === undefined) {
      this.settled = { state: 'rolled-back' };
    }
  }
}

export interface SealResult {
  ok: boolean;
  reason?: string;
  /** total journal entries covered by the new checkpoint (including the seal's own entry) */
  entries?: number;
  /**
   * PARTIAL FAILURE: the database side of the reseal COMMITTED (the seal entry and the meta
   * checkpoint are durable) but the external checkpoint file did NOT end up holding it. `ok` is
   * false — the reseal did not do what it was asked to do, and verification will stay red — but
   * the caller must report it as an incomplete operation rather than a refusal, and must not
   * claim both copies were rewritten.
   */
  partial?: boolean;
  /** what the forced external flush actually did (absent when no flush was attempted) */
  external?: FlushState;
}

// --- op-aware journal masking -------------------------------------------------------------------
//
// The journal is append-only and hash-chained, so a string the masker rewrites on the way in is
// corrupted AT REST FOREVER — and the runtime's own machine identifiers are exactly what a PII
// detector is most likely to misfire on (~0.9% of sha256 digests end in ten decimal digits, and a
// ULID can too). A rewritten `changes[].digest` makes its batch permanently un-rollbackable (the
// strict rollback schema refuses the mangled value) while journal verification stays GREEN over
// the corruption, and a rewritten id silently corrupts the journal-derived association graph.
//
// The rule is NOT "skip anything named `id` or `digest`" — that would be an at-rest masking
// BYPASS: an attacker-influenced free-text value stored under a key called `id` would then never
// be masked at all. Preservation requires BOTH conditions, and neither alone is sufficient:
//   1. the (op, structural path) pair is DECLARED below as a runtime-generated identifier, and
//   2. the value sitting at that path actually VALIDATES as that machine shape.
// Everything else is masked as free text, and an op with no declaration falls back to FULL
// maskDeep (fail-closed) — a new op is masked wholesale until someone declares its shape here.

/** The machine grammars a declared field may hold. Nothing else is ever preserved. */
type MachineShape = 'id' | 'digest';

/** Structural description of one payload level: which keys hold machine identifiers (a string or
 *  an array of them) and which hold nested objects (or arrays of them) described recursively. */
interface PayloadShape {
  fields?: Readonly<Record<string, MachineShape>>;
  nested?: Readonly<Record<string, PayloadShape>>;
}

/** One `AppliedChange` — the same shape under `consolidate.changes` and `rollback.inverse`.
 *  `from`/`to` are deliberately absent: for a `memory_content` change they are memory CONTENT
 *  (free text that must stay masked), and for a `memory_status` change they are status literals
 *  no detector can match. */
const APPLIED_CHANGE_SHAPE: PayloadShape = {
  fields: { id: 'id', mergedInto: 'id', distilledFrom: 'id', digest: 'digest' },
};

/**
 * The declared machine fields of every op the runtime emits. Undeclared ops mask fully.
 *
 * The inventory below is the COMPLETE set of ops any runtime path can append, audited against
 * every `journal.append` call site in the workspace — each entry names the site that emits it, so
 * the claim is checkable rather than asserted. Anything not listed here is an op nobody emits yet
 * and is masked wholesale; adding a new op WITHOUT adding it here is safe (fail-closed) but
 * corrupts that op's identifiers at rest, so the table must grow with the emitters.
 * (tests/safety/journal-machine-fields.test.ts pins that this list still covers them all.)
 *
 * Free-text payload members are intentionally absent so they keep being masked:
 * `memory_retrieve.query` (a user query), `consolidate_rejected.reason` and
 * `consolidate_contradictions.pairs[].reason` (model output), `import.source` (a caller-supplied
 * path), `rollback.originalOp` (a string read back out of the editable database), and the
 * `mode`/`status`/`kind`/`scope` literals the runtime owns (masking those is already a no-op).
 */
const OP_PAYLOAD_SHAPES: Readonly<Record<string, PayloadShape>> = {
  // consolidate/service.ts — deterministic and oracle batches
  consolidate: { fields: { batch: 'id' }, nested: { changes: APPLIED_CHANGE_SHAPE } },
  consolidate_contradictions: { nested: { pairs: { fields: { a: 'id', b: 'id' } } } },
  consolidate_rejected: {},
  // memory/service.ts — importMemories
  import: {},
  // journal/service.ts — seal()
  journal_seal: {},
  // memory/service.ts — confirm()/reject() both go through transition(), whose payload is the
  // list of ids that actually changed status. Machine ids, minted by newId(), read back by the
  // journal-derived association graph — exactly the family memory_write/memory_retrieve are in.
  memory_confirm: { fields: { ids: 'id' } },
  memory_reject: { fields: { ids: 'id' } },
  // memory/service.ts — search() bump
  memory_retrieve: { fields: { ids: 'id' } },
  // memory/service.ts — write()
  memory_write: { fields: { ids: 'id' } },
  // cli/store.ts — the legacy at-rest PII remask
  migrate_masking: {},
  // journal/rollback.ts — planRollback's entry, appended by consolidate/service.ts rollback()
  rollback: { nested: { inverse: APPLIED_CHANGE_SHAPE } },
};

/** OWN-property lookup: a payload key (or an op) called `constructor`/`toString` must resolve to
 *  "undeclared", never to something inherited from Object.prototype. */
function declared<T>(table: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return table !== undefined && Object.hasOwn(table, key) ? table[key] : undefined;
}

/** A declared machine field: preserved byte-for-byte ONLY while the value validates as the shape
 *  claimed. A non-validating string is masked as free text; a non-string is masked structurally. */
function maskMachineField(
  value: unknown,
  shape: MachineShape,
  mask: (s: string) => string,
): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => maskMachineField(v, shape, mask));
  }
  if (typeof value === 'string') {
    // Both grammars are single-sourced with the code that MINTS and CONSUMES them: `isId` is the
    // ULID guard newId() satisfies, and MEMORY_INSERT_DIGEST_RE is the same constant the strict
    // rollback schema validates against — so masking can never accept a shape rollback rejects.
    const valid = shape === 'digest' ? MEMORY_INSERT_DIGEST_RE.test(value) : isId(value);
    return valid ? value : mask(value);
  }
  return maskDeep(value, mask);
}

/** Walk a payload against its declared shape. Object KEYS are always masked (a key is never a
 *  declared field), and a key the masker rewrote can no longer BE the declared field it spelled. */
function maskByShape(value: unknown, shape: PayloadShape, mask: (s: string) => string): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => maskByShape(v, shape, mask));
  }
  if (value === null || typeof value !== 'object') {
    return maskDeep(value, mask);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const key = mask(k);
    if (key === k) {
      const field = declared(shape.fields, k);
      if (field !== undefined) {
        out[key] = maskMachineField(v, field, mask);
        continue;
      }
      const child = declared(shape.nested, k);
      if (child !== undefined) {
        out[key] = maskByShape(v, child, mask);
        continue;
      }
    }
    out[key] = maskDeep(v, mask);
  }
  return out;
}

/**
 * How many times a verification may run its ladder when the healing compare-and-swap keeps losing
 * the checkpoint file to somebody else.
 *
 * A CONFLICT IS NOT A VERDICT. The swap is refused precisely because the destination no longer
 * holds the bytes that were authenticated, which says the state changed — not what it changed to.
 * Cooperative writers produce that constantly on a shared store (a peer commits and mirrors as two
 * steps, so its mirror lands inside another process's heal), and answering RED there turns ordinary
 * concurrency into refused writes; answering GREEN there would vouch for bytes nobody validated.
 * The honest answer is to look again, from scratch — new rows, new database checkpoint, new file —
 * and let the ladder judge what is actually there.
 *
 * BOUNDED, because "look again" cannot be unbounded: a destination being rewritten in a loop
 * (a runaway peer, or an attacker holding verification open) would otherwise spin forever. When the
 * budget is gone the conflict verdict stands, RED, with the file untouched — the same answer as
 * before, now reserved for a destination that genuinely will not hold still.
 */
const HEAL_CONFLICT_ATTEMPTS = 3;

/**
 * The one place entries enter the journal. `append` masks (when a masker is wired), runs the
 * fail-closed authenticity precondition, seals the draft against the current tip, persists
 * atomically, and refreshes the authenticated checkpoint in the same transaction. `verify` walks
 * the chain AND authenticates it against the checkpoints; `seal` accepts the current history as
 * trusted (explicit `journal reseal`; its automatic `onlyIfMissing` form initializes only a
 * genuinely empty first-run store).
 *
 * Ordinary appends REFUSE an unverifiable history: a store whose verification fails (erased
 * history, truncation, a break ANYWHERE in the chain, divergent, lagging or unreadable
 * checkpoints, …) must keep failing until the explicit trust decision — an innocent write that
 * minted or mirrored checkpoints over that state would launder it, and a write that merely
 * SUCCEEDS on a store that cannot verify is itself the laundering (it moves the store forward
 * on top of history nobody can vouch for). Only seal()/`journal reseal` accepts an untrusted
 * history.
 */
export class JournalService {
  constructor(
    private readonly store: StorageDriver,
    private readonly opts?: JournalServiceOptions,
  ) {}

  /** The keyed-MAC function when checkpointing is enabled, else undefined. */
  private macFn(): ((data: string) => string) | undefined {
    const crypto = this.opts?.crypto;
    return crypto?.mac ? crypto.mac.bind(crypto) : undefined;
  }

  /**
   * Mask every caller-influenced string BEFORE sealing (order: mask → JSON-normalize
   * → seal → persist → checkpoint). `op` is runtime-owned vocabulary and stays literal.
   *
   * `actor`, `model` and `promptVersion` stay FULLY MASKED. All three are caller-influenced —
   * `actor` carries an MCP client name, `model` a provider/model id, `promptVersion` a
   * caller-supplied tag — and nothing reads any of them back for identity: the `sthayi journal`
   * listing and the MCP journal tool only display them. Caller-influenced plus no byte-identity
   * consumer is exactly the free-text case, so they are masked, not preserved.
   *
   * The `payload` goes through the op-aware walker: declared machine identifiers that VALIDATE
   * survive byte-for-byte, everything else (and every payload of an undeclared op) is masked.
   */
  private maskDraft(draft: JournalDraft): JournalDraft {
    const masker = this.opts?.masker;
    if (!masker) {
      return draft;
    }
    const mask = (s: string): string => masker.maskSecrets(s).masked;
    const shape = declared(OP_PAYLOAD_SHAPES, draft.op);
    return {
      ts: draft.ts,
      actor: mask(draft.actor),
      op: draft.op,
      payload:
        draft.payload == null
          ? draft.payload
          : shape === undefined
            ? maskDeep(draft.payload, mask)
            : maskByShape(draft.payload, shape, mask),
      promptVersion: draft.promptVersion == null ? draft.promptVersion : mask(draft.promptVersion),
      model: draft.model == null ? draft.model : mask(draft.model),
    };
  }

  /**
   * The in-flight mirror exemption for the transaction that armed it (see {@link MirrorExemption}).
   *
   * Cleared: when a mirror actually runs, at every TOP-LEVEL append, when the transaction that
   * armed it SETTLES (commit or — with a driver that implements `onSettle` — rollback), and
   * whenever {@link exemptionIsLive} finds it no longer belongs to the open transaction. A leftover
   * is inert rather than merely unlikely: it is re-validated against the transaction's identity
   * every single time it is consulted, never trusted because it happens to be there.
   */
  private exemption: MirrorExemption | undefined;

  /**
   * Append one entry and hand back the {@link JournalAppend} handle through which the WHOLE
   * operation's outcome arrives — including the one that is neither success nor failure: the
   * database transaction COMMITTED while the off-database anchor did not advance with it. A refused
   * append still THROWS.
   *
   * READ `outcome` AFTER THE OUTERMOST TRANSACTION RETURNS. A caller that appends inside its own
   * `writeTransaction` is asking a question the database has not answered yet, and the handle says
   * so ('in-flight') rather than guessing. Every service in this workspace reads it afterwards.
   *
   * `ids` names the domain rows this operation created or changed. It is passed IN rather than
   * assigned to the result afterwards: the receipt is built at the commit edge, which for a
   * top-level append has already passed by the time this returns, so there is no moment at which a
   * caller could add them to it.
   */
  append(draft: JournalDraft, opts?: { ids?: readonly string[] }): JournalAppend {
    return this.appendEntry(draft, false, opts?.ids);
  }

  /**
   * Is the recorded exemption still the one belonging to the transaction currently open on this
   * connection? Four independent conditions, ALL required, and the last two are database state
   * rather than service memory — which is what a rolled-back transaction cannot fake:
   *
   *  1. TRANSACTION IDENTITY (when the driver has one): same `transactionId()`. A driver that
   *     implements it settles the question outright;
   *  2. a transaction must still be OPEN — outside one nothing can be in flight;
   *  3. the transaction TOKEN in the meta table must still be the one we wrote INSIDE this
   *     transaction. A rollback reverted that write, so after a rollback it is gone (or is an
   *     older transaction's) and can never match again; after a commit the settle callback has
   *     already dropped the in-memory half;
   *  4. the meta checkpoint must still be exactly what OUR latest append minted. It is uncommitted
   *     state visible only to this connection while that append is alive.
   *
   * Any read failure is "not live" — fail closed; the exemption only ever LOOSENS verification.
   */
  private exemptionIsLive(ex: MirrorExemption): boolean {
    try {
      const txId = this.store.transactionId?.();
      if (ex.txId !== undefined || txId !== undefined) {
        if (ex.txId === undefined || txId === undefined || ex.txId !== txId) {
          return false;
        }
      }
      if (this.store.inTransaction?.() !== true) {
        return false;
      }
      return (
        this.store.getMeta(JOURNAL_TX_TOKEN_KEY) === ex.token &&
        this.store.getMeta(JOURNAL_CHECKPOINT_KEY) === ex.minted
      );
    } catch {
      return false;
    }
  }

  /** The exemption, but ONLY while it still belongs to the open transaction. A dead one is
   *  dropped here rather than left to be re-tested (and possibly matched) later. */
  private liveExemption(): MirrorExemption | undefined {
    const ex = this.exemption;
    if (ex === undefined) {
      return undefined;
    }
    if (!this.exemptionIsLive(ex)) {
      this.exemption = undefined;
      return undefined;
    }
    return ex;
  }

  /**
   * Arm (or refresh) the exemption for the transaction this append is running inside. Called from
   * INSIDE the append's write transaction, after the meta checkpoint has been advanced, so the
   * token write joins the same transaction and shares its fate.
   *
   * NOT TOLERATED for a driver that can report neither `onSettle` nor `afterCommit` — see
   * MirrorExemption.tolerated: it is armed for its strict effect only.
   */
  private armExemption(committedRaw: string | undefined, continuing: boolean): void {
    if (!this.opts?.external || !this.macFn()) {
      return; // no off-database anchor is wired: there is nothing for an exemption to excuse
    }
    const existing = this.exemption;
    if (continuing && existing !== undefined) {
      // A later append of the SAME transaction (liveness was established before this append moved
      // the checkpoint): keep `raw` — the last COMMITTED checkpoint, which is what the file may
      // still legitimately hold — and move the in-flight expectation forward.
      existing.minted = this.store.getMeta(JOURNAL_CHECKPOINT_KEY);
      // THIS APPEND MAY BE SITTING IN A SAVEPOINT ITS CALLER CAN UNWIND ON ITS OWN. The unwind
      // takes the append and the meta checkpoint it minted with it, but not this in-memory field,
      // so the frame's own settle edge puts `minted` back to the value the database has returned
      // to. Without that, the exemption stops matching the store and is dropped — and the next
      // append of the STILL-OPEN outer transaction re-arms one whose `raw` is the UNCOMMITTED
      // checkpoint of that transaction, which is the value the gate would then publish and
      // tolerate on behalf of rows the outer transaction can still roll back.
      //
      // THE RESTORED VALUE IS RE-DERIVED FROM THE DATABASE, NEVER REPLAYED FROM MEMORY. One frame
      // may hold MANY of these restorers — a savepoint is free to append repeatedly, and it also
      // adopts the restorers of any savepoint that released into it — and they all describe the
      // same single fact: where the checkpoint stands once that frame is gone. A restorer carrying
      // a remembered "the value before MY append" is only correct when it is the last one to run,
      // so a frame holding several of them lands on whichever one happens to run last and leaves
      // the exemption pointing at a checkpoint the unwind discarded. Reading the store at the
      // settle edge is the same answer for every restorer in the frame, in any order, run any
      // number of times: the rollback has already happened by the time a settle callback runs, so
      // the meta checkpoint IS the value the database returned to.
      this.store.onSettle?.((committedFrame) => {
        if (committedFrame || this.exemption !== existing) {
          return;
        }
        try {
          existing.minted = this.store.getMeta(JOURNAL_CHECKPOINT_KEY);
        } catch {
          // Unreadable meta means nothing about this exemption can be established, so it stops
          // being one: `exemptionIsLive` fails closed on the same read, and dropping it here says
          // so directly rather than leaving a stale expectation for the gate to test.
          this.exemption = undefined;
        }
      });
      return;
    }
    const token = newId();
    this.store.setMeta(JOURNAL_TX_TOKEN_KEY, token);
    const armed: MirrorExemption = {
      raw: committedRaw,
      txId: this.store.transactionId?.(),
      token,
      minted: this.store.getMeta(JOURNAL_CHECKPOINT_KEY),
      tolerated: this.store.onSettle !== undefined || this.store.afterCommit !== undefined,
    };
    this.exemption = armed;
    const drop = (): void => {
      if (this.exemption === armed) {
        this.exemption = undefined;
      }
    };
    // onSettle clears on BOTH edges; afterCommit closes the commit edge for drivers without it
    // (the rollback edge is then covered by the token, which the rollback itself reverted).
    if (this.store.onSettle) {
      this.store.onSettle(drop);
    } else {
      this.store.afterCommit?.(drop);
    }
  }

  /** `trustHistory` is set ONLY by seal() — the explicit trust decision that re-derives the
   *  checkpoint from the rows. Ordinary appends NEVER recount: recounting over an unverified
   *  chain would launder a truncation or snapshot restore. */
  private appendEntry(
    draft: JournalDraft,
    trustHistory: boolean,
    ids?: readonly string[],
    flushSink?: (outcome: FlushOutcome) => void,
  ): JournalAppend {
    // Read BEFORE opening our own transaction: inside it `inTransaction()` is unconditionally
    // true, so only this reading distinguishes "the caller has a transaction open, my mirror will
    // be deferred to ITS commit" from "I am the top-level writer and my mirror runs immediately".
    const mirrorDeferred = this.store.inTransaction?.() === true;
    if (!mirrorDeferred) {
      this.exemption = undefined;
    }
    // writeTransaction: the tip read and the append are serialized under the writer lock (joins
    // the caller's write transaction when one is open), so the chain cannot fork across processes.
    // Masking runs INSIDE it so vault pseudonym mints join the same transaction (no orphans).
    const handle = this.store.writeTransaction(() => {
      if (!trustHistory) {
        // Fail-closed authenticity precondition for ORDINARY appends (seal()'s trustHistory
        // path is the explicit trust decision and bypasses it). Runs under the writer lock
        // BEFORE anything is written: a throw here aborts the ENTIRE caller transaction —
        // memories, journal rows, meta, and (because the external mirror is an afterCommit
        // callback that a rollback discards) the external checkpoint file all stay untouched.
        this.assertAppendable();
      }
      // Decide HERE, before our own append advances the meta checkpoint, whether the exemption we
      // hold belongs to this transaction. Afterwards `minted` necessarily differs from what it
      // recorded, so re-deriving liveness below would drop a perfectly live exemption and re-arm a
      // fresh one whose `raw` is an UNCOMMITTED checkpoint — which then refuses the batch's third
      // append. Liveness is a property of the transaction, not of the moment we ask.
      const continuing = mirrorDeferred && this.liveExemption() !== undefined;
      const masked = this.maskDraft(draft);
      const prev = this.store.lastJournalHash();
      // The last COMMITTED checkpoint, read before this append advances it — the only value the
      // external copy may still legitimately hold while this transaction's mirror is outstanding.
      const committed = this.store.getMeta(JOURNAL_CHECKPOINT_KEY);
      const rec = this.store.appendJournal(sealEntry(masked, prev));
      this.updateMetaCheckpoint(rec, prev, trustHistory);
      if (mirrorDeferred) {
        this.armExemption(committed, continuing);
      }
      const h = new AppendHandle(rec, ids);
      // THE ROLLBACK EDGE, registered inside the very transaction whose fate it reports. A rollback
      // discards the after-commit queue without telling anyone, so without this the handle would
      // sit at 'in-flight' while the caller held rows that no longer exist. A driver that offers no
      // `onSettle` cannot report this edge at all: its handle stays 'in-flight', which claims
      // nothing — the fail-closed reading, never 'committed'.
      this.store.onSettle?.((committedTx) => {
        if (!committedTx) {
          h.settleRolledBack();
        }
      });
      return h;
    });
    // THE COMMIT EDGE. The mirror runs immediately for a top-level append and at the enclosing
    // transaction's commit for a deferred one; either way the receipt is minted THERE, from what the
    // mirror actually achieved, and never before.
    this.flushExternal(trustHistory, (outcome) => {
      flushSink?.(outcome);
      if (outcome.state === 'deferred') {
        // A legacy driver mid-transaction: NOTHING ran and nothing will tell us how the transaction
        // ended. The handle stays 'in-flight' rather than minting a receipt for rows the caller can
        // still roll back. seal() has its own channel (`flushSink`) and repeats the flush itself.
        return;
      }
      // seal() reports its own partial-failure result, so the ordinary "further writes will
      // refuse" warning is left to ordinary appends (the callers with no other channel).
      const anchor = this.classifyAnchor(outcome, flushSink === undefined);
      handle.settleCommitted(anchor.anchor, anchor.reason);
    });
    return handle;
  }

  /**
   * Where the off-database anchor stands after a COMMITTED append, from what the mirror actually
   * did — CONFIRMED BY READ-BACK, never inferred from the absence of a throw (`externalShortfall`
   * re-reads both copies).
   *
   * This is the one place the durable-but-unanchored outcome is classified, so every surface
   * downstream reports the same three facts: it COMMITTED, it must not be retried, and further
   * writes are blocked until the anchor is repaired.
   */
  private classifyAnchor(
    flush: FlushOutcome,
    warn: boolean,
  ): { anchor: AnchorOutcome; reason?: string } {
    if (flush.state === 'disabled' || !this.opts?.external) {
      return { anchor: 'not-configured' };
    }
    const shortfall = this.externalShortfall(flush);
    if (shortfall === undefined) {
      return { anchor: 'anchored' };
    }
    // A shortfall is not yet the degraded outcome. ORDINARY CONCURRENCY produces one: a peer
    // process commits and mirrors as two steps, so our post-commit read can catch the file
    // mid-advance (or already carrying the peer's NEWER checkpoint, which our mirror correctly
    // refused to regress). Calling that "further writes are blocked" would fire on healthy
    // multi-process traffic and make the signal worthless.
    //
    // The honest test is the one the NEXT write will actually apply: re-verify, advancing a lag
    // exactly as the append gate does. Green means the anchor is current after all. Red is the
    // durable-but-unanchored outcome — and it is red for the same reason the next write will
    // refuse, which is precisely what the receipt promises the caller.
    if (this.verify({ heal: true, advanceOnly: true }).ok) {
      return { anchor: 'anchored' };
    }
    if (warn) {
      this.opts?.warn?.(shortfall);
    }
    return { anchor: 'unanchored', reason: shortfall };
  }

  /**
   * The append-time authenticity gate: NEVER writes anything (no meta, no external file), only
   * decides whether an ordinary append may proceed. It runs the FULL non-healing verification —
   * the complete chain walk over every row PLUS both checkpoint copies — and throws on every
   * state verify() fails on: erased history on a prior installation, truncation/snapshot
   * restore, a broken or tampered link ANYWHERE in the chain (interior rows included), missing
   * checkpoints on a rows-bearing store, unauthentic or unreadable checkpoints (either copy), a
   * database meta checkpoint that is absent/lagging/divergent rather than the current live one,
   * a divergent external checkpoint at any count, AND — since the off-database anchor invariant —
   * an external checkpoint that is merely ABSENT or STALE.
   *
   * THAT LAST ONE IS THE POINT, AND IT IS A SYNCHRONIZATION, NOT JUST A REFUSAL. Passing an
   * authentic PREFIX unconditionally — on the theory that its advance is "deferred to the
   * post-commit mirror" — never establishes that the mirror ARRIVED. A file frozen at count 1 by a
   * jammed lock would then authorize appends 2, 3, 4 … and finally a DB-only restore to an
   * intermediate snapshot, every verdict green. The gate therefore makes the anchor CURRENT before
   * the entry is written, and refuses when it cannot:
   *
   *  - LAG (an authentic prefix of this chain) is ADVANCED here, by the same CAS-plus-read-back
   *    heal verify() uses. Advancing a prefix asserts nothing new — the file already attests to
   *    this exact chain — so it is mechanical, not a trust decision. Refusing instead would also
   *    be WRONG rather than merely strict: a peer process commits and mirrors as two steps, so a
   *    concurrent writer legitimately observes the file one (or several) entries behind, and a
   *    flat refusal turns ordinary concurrency into spurious failures. Whoever gets here first
   *    closes the gap. If the advance cannot be completed — a jammed lock, an unwritable path, a
   *    destination that changed — the append REFUSES: that is the frozen anchor, and it is
   *    exactly the state that must never authorize a write.
   *  - ABSENCE is never healed here. Creating the anchor asserts "this history is the real one"
   *    with nothing outside the database to corroborate it — the same trust decision `seal`'s
   *    TOFU path guards, and an ordinary write may not make it. The append refuses; the explicit
   *    healing `verify()` (`sthayi journal verify`) creates the file, and writes resume.
   *  - The one lag left untouched is the mirror that is genuinely IN FLIGHT: a LIVE
   *    {@link MirrorExemption} says an earlier append of ours sits uncommitted in THIS SAME
   *    transaction (proved against the transaction's identity, not merely "a transaction is
   *    open"), so the checkpoint we would publish is UNCOMMITTED — nothing may be written, and the
   *    file may still hold exactly the bytes committed when that transaction began.
   *
   * There is deliberately NO O(1) fast path. Short-circuiting on "authentic meta checkpoint
   * matching the live tip, external byte-identical" never walks the interior of the chain, so a
   * tampered INTERIOR row — tip and both checkpoints left intact — leaves verification red while
   * ordinary writes keep succeeding on top of it. Correctness over
   * cost: every ordinary append pays one allJournal() + chain walk, and a store that cannot
   * verify accepts NO writes at all.
   */
  private assertAppendable(): void {
    const mac = this.macFn();
    if (!mac) {
      return; // no MAC-capable crypto: checkpointing, and therefore this gate, is disabled
    }
    // A LIVE exemption ⇒ we already appended inside THIS transaction ⇒ the meta checkpoint is
    // uncommitted and must not be published. Liveness is re-established here against the open
    // transaction's identity (see exemptionIsLive), so an exemption left behind by a transaction
    // that ROLLED BACK is dropped rather than reused — reusing it is what would let a frozen
    // anchor authorize a further write. Otherwise the meta checkpoint we read is COMMITTED state (nothing
    // but our own appends moves it, and we have made none in this transaction), so writing it out
    // publishes nothing a rollback could take back — safe even while a caller transaction is open.
    const live = this.liveExemption();
    const v =
      live !== undefined
        ? // An append of OURS is uncommitted in this transaction: never heal (that would publish a
          // checkpoint a rollback could take back). `mirrorPending` — the actual tolerance — is
          // granted only when the driver can tell us the transaction settled.
          this.verify({ heal: false, mirrorPending: live.tolerated })
        : this.verify({ heal: true, advanceOnly: true });
    if (!v.ok) {
      throw new Error(
        `refusing to append: journal failed verification — ${v.reason ?? 'unknown failure'}`,
      );
    }
  }

  /**
   * Refresh the meta-table checkpoint for the just-appended tip (same transaction as the
   * append). Steady state is O(1): the previous checkpoint's tip is the hash we linked to.
   * Everything else refuses to touch the checkpoint — a chain that changed in a way this
   * connection never observed (truncation, snapshot restore, tamper, erased checkpoints) must
   * keep FAILING verification until the explicit trust decision (`sthayi journal reseal`).
   * Minting a fresh checkpoint here would launder the divergence with the next innocent append.
   */
  private updateMetaCheckpoint(
    rec: JournalRecord,
    prev: string | null,
    trustHistory: boolean,
  ): void {
    const mac = this.macFn();
    if (!mac) {
      return;
    }
    if (trustHistory) {
      // seal(): re-derive the count from the rows (includes the seal entry just appended).
      const count = this.store.allJournal().length;
      this.store.setMeta(JOURNAL_CHECKPOINT_KEY, buildCheckpoint(mac, count, rec.id, rec.hash));
      return;
    }
    const raw = this.store.getMeta(JOURNAL_CHECKPOINT_KEY);
    const cp = raw === undefined ? undefined : parseCheckpoint(raw);
    if (cp) {
      if (verifyCheckpoint(mac, cp) && cp.tipHash === prev) {
        // Steady state: the checkpoint's tip is exactly the hash this append linked to.
        this.store.setMeta(
          JOURNAL_CHECKPOINT_KEY,
          buildCheckpoint(mac, cp.count + 1, rec.id, rec.hash),
        );
        return;
      }
      // Unauthentic, or authentic for a chain we never observed: leave it untouched.
      this.opts?.warn?.(
        'journal checkpoint does not match the chain — leaving it untouched (the journal was truncated, replaced, or its checkpoint tampered); verification will fail until the history is reviewed and `sthayi journal reseal` is run',
      );
      return;
    }
    // No meta checkpoint at all. Mint only for the genuinely-first entry of a pristine store:
    // no prior rows, NO prior-install evidence (an initialized installation whose journal is
    // empty is erased history, not a first run), AND no surviving authenticated external
    // checkpoint (an UNREADABLE external file counts as surviving — fail closed, we cannot rule
    // out that it is authentic). Anything else — pre-checkpoint rows, an erased meta checkpoint,
    // an erased-to-empty store whose external file survives — stays uncheckpointed; verify()'s
    // reseal guidance is the recovery path. (The append gate refuses these states outright for
    // ordinary appends; this guard is the same decision at the minting site.)
    if (prev === null) {
      if (!this.opts?.priorInstall && this.externalProbe(mac) === 'none') {
        this.store.setMeta(JOURNAL_CHECKPOINT_KEY, buildCheckpoint(mac, 1, rec.id, rec.hash));
        return;
      }
      this.opts?.warn?.(
        'an authenticated journal checkpoint file survives (or cannot be read) but the store has no history — refusing to checkpoint implicitly (erased or replaced store?); run `sthayi journal reseal` only if this was intentional',
      );
      return;
    }
    this.opts?.warn?.(
      'journal has prior history but no checkpoint — refusing to mint one implicitly; review the history, then run `sthayi journal reseal` to accept it as trusted',
    );
  }

  /**
   * The checkpoint the database holds RIGHT NOW, or undefined when it cannot be established.
   *
   * Deliberately swallows a failed read: this is only ever used to recognize that the store moved
   * FORWARD under an in-progress verification, and "I could not tell" must never be mistaken for
   * "it matches". Every verdict that depends on the checkpoint being readable is step (3)'s.
   */
  private committedCheckpointRaw(): string | undefined {
    try {
      return this.store.getMeta(JOURNAL_CHECKPOINT_KEY);
    } catch {
      return undefined;
    }
  }

  /**
   * Read-only probe of the external checkpoint copy.
   *  'authentic'  — present and MAC-verified under our key;
   *  'unreadable' — the read THREW (permissions, symlink refusal, I/O error). Fail closed: an
   *                 unreadable file may well be the authentic evidence an attacker is hiding,
   *                 so callers must treat this at least as strictly as 'authentic';
   *  'none'       — absent, or present but not an authentic checkpoint of ours.
   */
  private externalProbe(mac: (data: string) => string): 'authentic' | 'unreadable' | 'none' {
    let raw: string | undefined;
    try {
      raw = this.opts?.external?.read();
    } catch {
      return 'unreadable';
    }
    if (raw === undefined) {
      return 'none';
    }
    const cp = parseCheckpoint(raw);
    return cp && verifyCheckpoint(mac, cp) ? 'authentic' : 'none';
  }

  /**
   * Mirror the committed meta checkpoint into the external store, RIGHT NOW, and report what
   * happened as an explicit `FlushOutcome` (`flushExternal` below is what schedules it for the
   * post-commit moment). Nothing here throws — every failure becomes a state the caller can act
   * on: a mirror whose only failure signal is a warning is how a forced flush that never landed
   * gets reported as a successful reseal.
   * THREE guards, all required, all skipped only by `force` (seal()'s explicit trust decision):
   *  1. SOURCE — the meta copy is mirrored ONLY when it is the CURRENT LIVE checkpoint (its tip
   *     is the live tip, id AND hash). A meta copy that lags the rows or describes a different
   *     history is never copied out: doing so would overwrite a good external anchor with a
   *     lagging or divergent one and REGRESS the file — a green verify turned red by an
   *     ordinary write, which is exactly what must be impossible;
   *  2. DESTINATION authenticity — a file that EXISTS but does not PARSE, or does not
   *     AUTHENTICATE under our MAC key, is tamper evidence and is never overwritten. Only
   *     ABSENCE licenses creating the file. Overwriting an unparseable or unauthentic copy
   *     (the fall-through a falsy `parseCheckpoint`/`verifyCheckpoint` result must never reach)
   *     destroys the sole record that anything was touched, and quietly turns a red verify()
   *     green by way of an ordinary write;
   *  3. DESTINATION ratchet — an authentic external checkpoint is overwritten only when it is a
   *     genuine ANCESTOR of the current chain: its count is not ahead of the meta copy's AND its
   *     tip row is in this chain with that exact hash. Anything else (count lower, EQUAL, or
   *     higher) is the surviving evidence of a truncation, snapshot restore, or divergent-branch
   *     swap, and is kept.
   * The append gate refuses these states before commit; these guards also cover a database or
   * checkpoint file swapped in AFTER the gate ran (a concurrent process between commit and
   * flush). Failures warn, never throw.
   *
   * Those three guards validate the bytes the `read()` above returned. The destination can change
   * again between that read and the write, so the replacement itself is guard (4):
   *  4. COMPARE-AND-SWAP — the store is asked to replace `extRaw` (the exact bytes just validated)
   *     with the meta copy, re-reading the destination under its own serialization and writing
   *     ONLY while it still equals that expectation. Anything else is a refusal that leaves the
   *     file BYTE-IDENTICAL and warns. Without it the guards are decorative in a race: they would
   *     vouch for bytes no longer at the path and then overwrite whatever had replaced them,
   *     destroying the evidence and turning a red verify green by way of an ordinary append.
   *     `force` (seal's explicit trust decision) skips the COMPARISON, never the serialization.
   *
   * HONEST BOUNDARY for that post-gate window: this runs AFTER the write transaction has already
   * COMMITTED, so a file swapped in between the gate's verification and this flush cannot undo
   * the database mutation — the memory row and the journal entry are durable by then. What these
   * guards buy is that the swapped-in bytes are LEFT INTACT and verification stays RED, so the
   * tamper is still discoverable; they do not and cannot make the committed append atomic with
   * the external file. Nor is the store's lock a security boundary: it serializes COOPERATIVE
   * Sthayi writers, and a MALICIOUS process running as the same user can always take that lock or
   * race the descriptor (it can equally read the vault key and rewrite the database outright).
   * What it removes is the SILENT variant — the attacker's bytes being erased by Sthayi's own
   * innocent write.
   */
  private mirrorExternal(force: boolean): FlushOutcome {
    // The mirror is being ATTEMPTED, so no in-flight lag is outstanding any more — whatever the
    // attempt does below, the file must from here on be judged against the live checkpoint alone.
    // Clearing is always the strict direction: it only ever REMOVES the tolerance in verify (8).
    this.exemption = undefined;
    const external = this.opts?.external;
    const mac = this.macFn();
    if (!external || !mac) {
      return { state: 'disabled' };
    }
    const refuse = (reason: string): FlushOutcome => {
      this.opts?.warn?.(reason);
      return { state: 'refused', reason };
    };
    try {
      const raw = this.store.getMeta(JOURNAL_CHECKPOINT_KEY);
      if (raw === undefined) {
        return {
          state: 'skipped',
          reason: 'the database holds no journal checkpoint to mirror into the checkpoint file',
        };
      }
      const meta = parseCheckpoint(raw);
      if (!meta || !verifyCheckpoint(mac, meta)) {
        // never mirror an unauthentic checkpoint
        return {
          state: 'refused',
          reason:
            'the journal checkpoint in the database is not authentic under this vault key — refusing to mirror it into the checkpoint file',
        };
      }
      const extRaw = external.read();
      if (extRaw === raw) {
        return { state: 'current' };
      }
      if (!force) {
        // (1) SOURCE: is this meta copy the checkpoint of the chain as it stands right now?
        const tip = this.store.recentJournal(1)[0];
        if (!tip || tip.id !== meta.tipId || tip.hash !== meta.tipHash) {
          return refuse(
            `journal checkpoint in the database records ${meta.count} entries ending at #${meta.tipId}, which is not the current tip of this journal — refusing to mirror it into the checkpoint file (the database was truncated, restored, or swapped; verification will fail until \`sthayi journal reseal\`)`,
          );
        }
        // (2) DESTINATION ratchet: never overwrite an authentic non-ancestor, and never
        // regress the file's count.
        if (extRaw !== undefined) {
          const ext = parseCheckpoint(extRaw);
          if (!ext || !verifyCheckpoint(mac, ext)) {
            // (2a) A file that EXISTS but cannot be parsed or cannot be authenticated is
            // TAMPER EVIDENCE, and it is the only copy of that evidence. Falling through to
            // the write below would overwrite the tampered bytes with a fresh authentic
            // checkpoint and destroy the only proof anything happened — turning a red
            // verify() green by way of an ordinary, innocent write. Refuse.
            return refuse(
              'journal checkpoint file is unparseable or not authentic under this vault key — refusing to overwrite it (it is tamper evidence); verification will fail until the file is reviewed and `sthayi journal reseal` is run',
            );
          }
          if (ext.count > meta.count || !this.externalTipIsAncestor(ext)) {
            return refuse(
              `journal checkpoint file records ${ext.count} entries ending at #${ext.tipId}, which is not part of this journal's history — keeping the file (it is evidence of a truncation, restore, or swapped store; verification will fail until \`sthayi journal reseal\`)`,
            );
          }
        }
      }
      // (4) COMPARE-AND-SWAP. Everything above validated the bytes `extRaw` — read moments ago.
      // Passing them as the expectation is what makes the replacement conditional: the store
      // re-reads the destination under its lock and writes only while it still holds exactly
      // those bytes. A destination that changed in the window is left BYTE-IDENTICAL, because
      // what arrived there may be the only evidence that anything was touched.
      if (!replaceCheckpoint(external, extRaw, raw, { force })) {
        return refuse(
          'journal checkpoint file changed between the read that validated it and the replacement — leaving the file byte-identical and NOT mirroring the current checkpoint (a concurrent writer, or tampering); verification will fail until the file is reviewed and `sthayi journal reseal` is run',
        );
      }
      return { state: 'written' };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.opts?.warn?.(`journal checkpoint file write failed: ${detail}`);
      return { state: 'failed', reason: detail };
    }
  }

  /**
   * Schedule the mirror above for the right moment and hand its EXPLICIT OUTCOME to `sink`.
   *
   * `sink` is invoked exactly once with whatever the attempt did — including 'deferred', which is
   * the legacy-driver case where nothing ran at all. That is the whole point of the outcome: a
   * caller that must not overstate what happened (seal()) can see the difference between "the file
   * holds the new checkpoint" and "the write never landed", instead of reading the absence of a
   * throw as success.
   *
   * The sink is MANDATORY: `appendEntry` always supplies one so the outcome becomes a typed
   * {@link CommitReceipt} (and, for an ordinary append, the honest warning). A mirror that refused,
   * threw or was deferred leaves the store with no current off-database anchor, and the next
   * ordinary write will refuse (the append gate requires one) — so an outcome nobody received
   * would leave the user with a write that "succeeded" and a store that has silently stopped
   * accepting writes.
   *
   * A STORE WITH NO OFF-DATABASE ANCHOR IS SCHEDULED IDENTICALLY. 'disabled' is a fact about the
   * WIRING, but the moment it may be reported is a fact about the TRANSACTION: it is the sink that
   * settles the append, and settling one inside a caller transaction that can still roll back is
   * the same false claim of durability whether or not a checkpoint file exists. So the outcome —
   * every outcome — is delivered from the post-commit callback, never from this call frame.
   */
  private flushExternal(force: boolean, sink: (outcome: FlushOutcome) => void): void {
    const anchored = this.opts?.external !== undefined && this.macFn() !== undefined;
    const run = (): void => {
      sink(anchored ? this.mirrorExternal(force) : { state: 'disabled' });
    };
    if (this.store.afterCommit) {
      this.store.afterCommit(run);
      return;
    }
    if (this.store.inTransaction?.()) {
      // legacy driver without afterCommit: verify()'s heal is the recovery path — but NOTHING ran
      // here, so the caller must be told that rather than left to assume the file was written.
      sink({
        state: 'deferred',
        reason:
          'the storage driver cannot run post-commit callbacks, so the checkpoint file was not written inside this transaction',
      });
      return;
    }
    run();
  }

  /**
   * Did the mirror actually leave the external copy holding the checkpoint the database committed?
   *
   * READ-BACK, not inference. `FlushOutcome` says what the writer BELIEVES it did; only the
   * destination can say what it holds, and between the two a peer or a hostile process can have
   * replaced it. Returns `undefined` when the file is confirmed current, otherwise the reason it
   * is not — which is also the reason the next ordinary write will refuse, since the append gate
   * requires a current off-database anchor.
   */
  private externalShortfall(flush: FlushOutcome): string | undefined {
    const external = this.opts?.external;
    if (!external || flush.state === 'disabled') {
      return undefined; // no external copy is wired — there is no second half to be out of step
    }
    const detail = flush.reason === undefined ? '' : ` (${flush.reason})`;
    let raw: string | undefined;
    try {
      raw = this.store.getMeta(JOURNAL_CHECKPOINT_KEY);
    } catch (err) {
      return `the journal checkpoint could not be read back out of the database after this write (${err instanceof Error ? err.message : String(err)}) — the checkpoint file cannot be confirmed current`;
    }
    if (raw === undefined) {
      return 'this write committed but the database holds no journal checkpoint for it — the store changed underneath the write; run `sthayi journal reseal`';
    }
    let current: string | undefined;
    try {
      current = external.read();
    } catch (err) {
      return `the journal checkpoint file could not be read back after this write (${err instanceof Error ? err.message : String(err)}) — the store has no confirmed off-database anchor and further writes will refuse until it is repaired; fix the file, then run \`sthayi journal reseal\``;
    }
    if (current === raw) {
      return undefined;
    }
    return current === undefined
      ? `the journal checkpoint file was not written${detail} — this write committed but nothing outside the database vouches for it, and further writes will refuse until it is repaired; fix the cause, then run \`sthayi journal reseal\``
      : `the journal checkpoint file still holds an older checkpoint${detail} — this write committed but the off-database anchor did not advance with it, and further writes will refuse until it is repaired; fix the cause, then run \`sthayi journal reseal\``;
  }

  /**
   * True iff the external checkpoint's tip row exists in the current chain with the same hash —
   * i.e. the external copy merely LAGS this history rather than describing a different one. The
   * caller must ALSO have established that its count does not exceed the current chain's (a
   * higher count is truncation evidence, not lag). O(1) in steady state: after an append the
   * external copy is at most one entry behind, so the tip is found in recentJournal(2); only a
   * deeper lag or a foreign tip falls back to the full scan (ids are unique, so a recent id
   * match with a different hash is divergence, not lag).
   */
  private externalTipIsAncestor(ext: Checkpoint): boolean {
    for (const r of this.store.recentJournal(2)) {
      if (r.id === ext.tipId) {
        return r.hash === ext.tipHash;
      }
    }
    const row = this.store.allJournal().find((r) => r.id === ext.tipId);
    return row !== undefined && row.hash === ext.tipHash;
  }

  /**
   * True iff `cp` is the checkpoint OF THE CURRENT LIVE CHAIN: it commits to exactly as many
   * entries as the store holds, and its tip is the live tip (id AND hash). `rows` must be the
   * full journal in id order (what allJournal returns). Anything else — a lower count, a
   * higher count, a foreign tip — is a checkpoint for a history this store is not currently in.
   */
  private isLiveCheckpoint(cp: Checkpoint, rows: readonly JournalRecord[]): boolean {
    const tip = rows[rows.length - 1];
    return (
      rows.length === cp.count &&
      tip !== undefined &&
      tip.id === cp.tipId &&
      tip.hash === cp.tipHash
    );
  }

  /**
   * True iff `cp` commits to a PREFIX of the current chain: the cp.count-th row (1-based, id
   * order) is exactly cp's tip. That is the only shape a legitimately LAGGING copy can have —
   * the history it committed to is the beginning of the history we hold, so advancing it past
   * that point destroys no evidence. Checking the row AT ITS OWN COUNT (rather than "the tip is
   * some row of ours") is what makes a renumbered or partially-replayed chain fail.
   */
  private isChainPrefix(cp: Checkpoint, rows: readonly JournalRecord[]): boolean {
    const row = rows[cp.count - 1];
    return row !== undefined && row.id === cp.tipId && row.hash === cp.tipHash;
  }

  /**
   * The heal threw. Decide whether the green verdict reached moments ago may still be reported.
   *
   * INVARIANT: a thrown replacement may NEVER be taken to mean the bytes originally read are still
   * current. The throw itself carries no information about the destination — the store refuses to
   * touch a symlink, a FIFO, an unreadable, oversized or foreign-owned file exactly as loudly as it
   * refuses a contended lock — so the ONLY honest move is to RE-READ the destination, WITHOUT
   * healing, and re-establish what is actually there.
   *
   * Returns `undefined` (the verdict stands) in exactly two cases, both of which mean the current
   * external state is already fully validated:
   *  - the destination still holds `validated`, the very bytes this verification authenticated and
   *    ran the ladder against — the failed heal is then a deferred advance, nothing more;
   *  - it holds `metaRaw`, the current live checkpoint the heal was trying to install (a
   *    cooperative concurrent writer got there first) — a state strictly better than the one that
   *    was about to be blessed.
   * EVERYTHING else returns a failure reason: unreadable (symlinked, special file, over the size
   * cap, permissions), absent when a copy was there before, and any other bytes — hostile,
   * unauthentic, or merely different — because nothing has authenticated them and the ladder above
   * never saw them.
   */
  private failureAfterHealThrew(
    validated: string | undefined,
    metaRaw: string,
  ): string | undefined {
    let current: string | undefined;
    try {
      current = this.opts?.external?.read();
    } catch (err) {
      this.opts?.warn?.(
        `journal checkpoint file re-read after a failed heal also failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 'external journal checkpoint could not be re-read after a failed heal — refusing to report this journal as verified (the file may have been replaced with a symlink, a special file, or something unreadable). Review the file, then run `sthayi journal reseal` if this was intentional.';
    }
    if (current === metaRaw) {
      return undefined; // already exactly the checkpoint the heal wanted (a peer installed it)
    }
    if (current === undefined) {
      // Nothing is at the path. Two DIFFERENT states reach here and they must not be conflated:
      //
      //  (1) a copy existed when this verification read it and is GONE now — it was removed under
      //      an in-progress verification. That is tamper-shaped regardless of who could write, so
      //      it is red even for a read-only observer.
      if (validated !== undefined) {
        return 'external journal checkpoint disappeared while it was being verified — the heal failed and the file is no longer there, so nothing vouches for this store. Restore the file, then run `sthayi journal reseal` if this was intentional.';
      }
      //  (2) it was absent all along and the attempt to CREATE it failed. The external copy is the
      //      only anchor that survives whole-database replacement — the meta copy lives inside the
      //      very database an attacker would be swapping — so a writable session running with no
      //      anchor, while something actively prevents its creation (a directory planted at the
      //      lock path does this permanently, with no privilege beyond writing the home), is
      //      DEGRADED. Reporting 'ok' would vouch for a guarantee that is not in place.
      //      A read-only session (doctor) is the one caller that cannot heal BY DESIGN; it says so
      //      via `externalReadOnly`, and for it an uninstalled copy stays a warning.
      if (this.opts?.externalReadOnly) {
        return undefined;
      }
      return 'external journal checkpoint is absent and could not be written — the heal failed, so nothing outside the database vouches for this store (a whole-database replacement would no longer be detectable). Clear whatever is blocking the checkpoint file (check for a stray `journal.checkpoint.lock`), then run `sthayi journal reseal`.';
    }
    if (current === validated) {
      return undefined; // unchanged: still the authentic copy this verification already validated
    }
    return 'external journal checkpoint changed while it was being verified and the heal failed — the bytes now at the path were never authenticated, and they have been left untouched. Review the file, then run `sthayi journal reseal` if this was intentional.';
  }

  /**
   * Describe the bytes ACTUALLY at the checkpoint path after a heal, when they are neither the
   * checkpoint the heal was installing nor the copy this verification authenticated.
   *
   * The classification is performed on THESE bytes — parsed and MAC-checked here — so the verdict
   * states the real shape (unauthentic, foreign, or merely different) instead of reciting the
   * pre-heal `extRaw`. Every branch is a FAILURE: nothing at the path has been validated by this
   * verification, and the bytes are left untouched because they may be the only evidence of a
   * tamper.
   */
  private describeReplacedAnchor(
    raw: string | undefined,
    mac: (data: string) => string,
    rows: readonly JournalRecord[],
    tip: JournalRecord,
  ): string {
    if (raw === undefined) {
      return 'the external journal checkpoint was REMOVED between the heal and the read-back — nothing is at the path, so nothing outside the database vouches for this store. Restore the checkpoint file (clear anything blocking it, e.g. a stray `journal.checkpoint.lock`), then run `sthayi journal reseal`.';
    }
    const cp = parseCheckpoint(raw);
    if (!cp || !verifyCheckpoint(mac, cp)) {
      return 'the external journal checkpoint was REPLACED between the heal and the read-back with bytes that are NOT an authentic checkpoint under this vault key — they are tamper evidence and have been left untouched. Review the file, then run `sthayi journal reseal` if this was intentional.';
    }
    if (cp.count > rows.length || !this.isChainPrefix(cp, rows)) {
      return `the external journal checkpoint was REPLACED between the heal and the read-back with an authenticated checkpoint that is NOT part of this journal's history (${cp.count} entr${cp.count === 1 ? 'y' : 'ies'} ending at #${cp.tipId}, while the store has ${rows.length} ending at #${tip.id}) — the file has been left untouched. Review it, then run \`sthayi journal reseal\` if this was intentional.`;
    }
    return `the external journal checkpoint was REPLACED between the heal and the read-back with a different authenticated checkpoint of this history (${cp.count} entr${cp.count === 1 ? 'y' : 'ies'} ending at #${cp.tipId}, while the store has ${rows.length} ending at #${tip.id}) — those bytes were never validated by this verification, so the off-database anchor does not vouch for the store's current state. Review the file, then run \`sthayi journal reseal\` if this was intentional.`;
  }

  /**
   * Checkpoint-aware verification. Ladder:
   *  1. broken/tampered chain → fail, checkpoint or no checkpoint;
   *  2. no MAC-capable crypto → ok, state 'checkpoint-disabled';
   *  3. a checkpoint read that THROWS (either copy) → fail closed (unreadable is not absent);
   *     a present-but-unauthentic checkpoint (either copy) → fail (tampered or key changed);
   *  4. no checkpoint anywhere: empty store → ok 'pristine' ONLY without prior-install evidence
   *     (an initialized installation with an empty journal is erased history, and fails); rows
   *     without a checkpoint → fail with reseal guidance (erased history is NOT a pristine store);
   *  5. the DATABASE META copy is the primary anchor and must be the CURRENT LIVE checkpoint —
   *     same count as the live row count, same tip id, same tip hash. Meta and the journal rows
   *     commit in ONE transaction, so a meta copy that is absent (while an external copy
   *     survives), lagging, or divergent is never a legitimate steady state: it is truncation,
   *     restore, or a swapped/edited database, and it fails until an explicit reseal;
   *  6. the EXTERNAL copy must be identical to the meta copy or a VERIFIED ANCESTOR (an
   *     authentic PREFIX of the current chain — the row at its own count is its tip). A copy at
   *     a HIGHER count than the store holds is truncation/older-snapshot evidence; any other
   *     mismatch, at a lower or equal count, is divergence. Both fail; neither is overwritten.
   *  7. a verified ancestor (or an absent file) is healed forward — healing mode only, and only by
   *     COMPARE-AND-SWAP against the exact bytes this verification read: a file replaced under an
   *     in-progress verification is left byte-identical and turns the verdict RED rather than
   *     being overwritten with a fresh authentic checkpoint. The heal is then CONFIRMED BY
   *     READ-BACK — `replace` returning true is what the writer believes, not what the path holds;
   *  8. THE OFF-DATABASE ANCHOR INVARIANT. When an external CheckpointStore is CONFIGURED, a
   *     verdict of state 'ok' requires its authenticated bytes to EQUAL the current authenticated
   *     live meta checkpoint. Missing is not "not yet there" and a verified ancestor is not "about
   *     to advance": both are states in which NOTHING OUTSIDE THE DATABASE vouches for this store,
   *     which is the entire job of the second copy — the meta copy lives inside the very file an
   *     attacker replaces. Step 6 alone accepts any authentic prefix forever, so on its own a file
   *     frozen at count 1 (a jammed lock is enough, and needs no privilege beyond writing the home)
   *     would go on authorizing appends at counts 2, 3, 4 … and then authorize a DB-ONLY restore
   *     back to an intermediate snapshot, every verdict green. Under step 8 every one of those is
   *     RED, and the append gate additionally SYNCHRONIZES the anchor before it lets a write
   *     through, so a lag can never accumulate across writes (see assertAppendable).
   *     THE ONE TOLERATED LAG is the mirror that is genuinely in flight — see
   *     {@link MirrorExemption}: the caller holds an open transaction, IDENTIFIED as the very one
   *     that armed the exemption, whose commit will run our mirror, and the file still holds
   *     EXACTLY the checkpoint that was committed when that transaction began. That keeps batched
   *     and nested writes working without accepting a single committed stale anchor — and an
   *     exemption whose transaction ROLLED BACK is dead, so it can never excuse a frozen anchor in
   *     a later transaction.
   *     Read-only sessions are NOT exempt: `externalReadOnly` suppresses blame for a write this
   *     session could never perform, not the objective fact that the anchor is not current.
   *
   * `heal: false` (the NON-HEALING mode — the append gate and rollback run it) skips step 7's
   * external-file write: verification then NEVER mutates the external checkpoint file or meta, so
   * a caller can refuse an operation with zero side effects. It does NOT skip step 8 — a
   * non-healing verification reports the missing or stale anchor instead of assuming a later heal
   * will fix it.
   *
   * Residual limitation (honest boundary): defeating this requires replaying BOTH copies —
   * a database together with an external checkpoint file captured from the SAME earlier state.
   * That coordinated replay is locally undetectable, and the vault key does not need to be
   * replaced for it: the key is static signing material, so every checkpoint it ever minted keeps
   * verifying under it. Everything short of it fails: an INCONSISTENT replacement (the two copies
   * from different states) fails at step 5 or 6, and — since step 8 — so does replaying the
   * DATABASE ALONE while leaving the checkpoint file behind, which would otherwise pass whenever
   * the file happened to sit at or before the restored snapshot.
   *
   * The one thing that makes "database alone" cost the attacker the file too is that the anchor is
   * current at EVERY mutation: the gate advances it before each write and refuses when it
   * cannot, so the file can never be left sitting at an old count while the database runs ahead.
   * A frozen anchor is therefore not a quiet blind spot but a store that stops accepting writes.
   * What an anchor still cannot do is testify about counts it never recorded: if it is frozen at
   * count N (writes refused throughout), and the database is then restored to some state at or
   * after N and the freeze lifted, the heal advances the file along that prefix. Nothing anywhere
   * witnessed the higher counts — that is what freezing the anchor destroyed — but it cost the
   * attacker a store that was RED, and refusing every write, for the whole interval.
   */
  verify(opts?: {
    heal?: boolean;
    /**
     * INTERNAL, set only by the append gate: heal a LAG but never an ABSENCE. Advancing an
     * authentic prefix along its own chain asserts nothing new; CREATING the anchor asserts that
     * this history is the real one with nothing outside the database to corroborate it, which is
     * a trust decision an ordinary write may not make (it belongs to the explicit healing
     * verify() and to `seal`).
     */
    advanceOnly?: boolean;
    /**
     * INTERNAL, set only by the append gate: this caller has a mirror queued for the enclosing
     * transaction's commit, so step 8 may accept a file still holding the checkpoint that was
     * committed when that transaction began. Never set by external callers, and never enough on
     * its own: the exemption must still be LIVE for the open transaction (see exemptionIsLive)
     * AND the bytes must match its recorded `raw` exactly.
     */
    mirrorPending?: boolean;
  }): ChainVerification {
    for (let attempt = 1; ; attempt++) {
      let unsettled: 'conflict' | 'moved' | undefined;
      const verdict = this.verifyPass(opts, attempt > 1, (kind) => {
        unsettled = kind;
      });
      if (unsettled === undefined) {
        return verdict;
      }
      if (attempt >= HEAL_CONFLICT_ATTEMPTS) {
        // The store kept moving for the whole budget. Report the verdict this pass produced —
        // nothing was ever written, so whatever is at the path is intact and unvalidated, and a
        // store nobody could read a settled picture of must not be reported as verified.
        if (unsettled === 'conflict') {
          this.opts?.warn?.(
            'journal checkpoint file changed while it was being verified — refusing to overwrite it (it may be the only evidence of a tamper)',
          );
        }
        return verdict;
      }
    }
  }

  /**
   * ONE PASS of the ladder documented on {@link verify}. Everything it needs — the rows, the
   * database checkpoint, the checkpoint file — is READ HERE, at the top, so a restart is a genuine
   * re-evaluation of the current state and never a second look at the same stale comparison.
   *
   * `unsettled` is called for the two conditions under which THIS PASS DID NOT GET A PICTURE OF ONE
   * STATE, neither of which is a verdict about the store:
   *  - 'moved'    — the database checkpoint changed across the row read, so the rows and the
   *                 checkpoint describe different moments. Every comparison downstream (is the
   *                 checkpoint live? is the file its ancestor?) would then be judging a store that
   *                 does not exist: a peer's commit advances rows AND checkpoint together, so a
   *                 mismatched pair is a skewed read, not a truncation;
   *  - 'conflict' — the healing compare-and-swap found the destination no longer holding the bytes
   *                 this pass authenticated, wrote NOTHING, and left the file byte-identical. It
   *                 says the question was asked about bytes that are no longer there.
   *
   * `restarted` says this pass follows one of those, and it makes one thing STRICTER: an external
   * copy that is ABSENT now is not the "no anchor has been installed yet" state a healing
   * verification is entitled to create. Something was at that path moments ago — a conflict is
   * exactly the proof that the destination held bytes — so its absence is a copy REMOVED under an
   * in-progress verification, and creating a fresh one over that would erase the only trace.
   */
  private verifyPass(
    opts:
      | {
          heal?: boolean;
          advanceOnly?: boolean;
          mirrorPending?: boolean;
        }
      | undefined,
    restarted: boolean,
    unsettled: (kind: 'conflict' | 'moved') => void,
  ): ChainVerification {
    const heal = opts?.heal !== false;
    // The database checkpoint AS IT STOOD BEFORE the rows were read. Rows and checkpoint move in
    // ONE transaction, so this value is the version the row snapshot below belongs to, and
    // comparing it against the copy read after (step 3) is what proves the two were read from the
    // same state. Best effort only: a read that fails here decides nothing — step 3 owns that
    // verdict.
    let versionBefore: string | undefined;
    let versionRead = false;
    try {
      versionBefore = this.store.getMeta(JOURNAL_CHECKPOINT_KEY);
      versionRead = true;
    } catch {
      // unreadable meta is step (3)'s failure to report, not a stability signal
    }
    const rows = this.store.allJournal();
    const chain = verifyChain(rows);
    if (!chain.ok) {
      return chain; // (1)
    }
    const mac = this.macFn();
    if (!mac) {
      return { ...chain, state: 'checkpoint-disabled' }; // (2)
    }

    const fail = (reason: string): ChainVerification => ({
      ok: false,
      length: rows.length,
      reason,
    });

    // (3) load + authenticate both copies. A read that THROWS is a verification FAILURE, not an
    // absent checkpoint: treating "unreadable" as "missing" would let whoever can chmod/symlink
    // the checkpoint (or corrupt the meta table) erase the trust anchor without erasing it.
    let metaRaw: string | undefined;
    try {
      metaRaw = this.store.getMeta(JOURNAL_CHECKPOINT_KEY);
    } catch (err) {
      this.opts?.warn?.(
        `journal checkpoint read failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return fail(
        'journal checkpoint unreadable — refusing to verify; repair or restore the database',
      );
    }
    if (versionRead && metaRaw !== versionBefore) {
      // The store COMMITTED between the two reads, so `rows` and `metaRaw` describe different
      // moments and no comparison between them means anything. Ask again from one state.
      unsettled('moved');
      return fail(
        'the journal advanced while it was being verified, so its rows and its checkpoint could not be read from one state — nothing was written. Run `sthayi journal verify` again once the store is idle.',
      );
    }
    let extRaw: string | undefined;
    try {
      extRaw = this.opts?.external?.read();
    } catch (err) {
      this.opts?.warn?.(
        `journal checkpoint file read failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return fail(
        'journal checkpoint file unreadable — refusing to verify; fix permissions or restore the file',
      );
    }
    // (3b) THE EXTERNAL READ IS PART OF THE SNAPSHOT. It is the one step of this pass that leaves
    // the database, and it is not instantaneous: a peer holding the same store can commit its own
    // entry — advancing rows AND the database checkpoint in ONE transaction — and mirror it into
    // the file while that read is in flight. The bytes handed back then anchor a state one entry
    // AHEAD of `rows`, and judged against them that is indistinguishable from a journal TRUNCATED
    // under its own anchor: the healthiest possible store accused of a snapshot restore.
    //
    // So the database checkpoint is read AGAIN here and compared. Unchanged means nothing committed
    // for the whole span (rows and checkpoint move together), so rows, meta and file all belong to
    // ONE state; changed means this pass never had one picture, and the ladder RESTARTS from freshly
    // read rows, checkpoint and file rather than reporting a verdict nobody's state supports.
    // Unreadable is fail-closed: this is the last read of the meta copy, so no later step owns that
    // verdict, and a snapshot nobody could confirm must not be rendered as verified.
    let versionAfter: string | undefined;
    try {
      versionAfter = this.store.getMeta(JOURNAL_CHECKPOINT_KEY);
    } catch (err) {
      this.opts?.warn?.(
        `journal checkpoint re-read failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return fail(
        'journal checkpoint unreadable — refusing to verify; repair or restore the database',
      );
    }
    if (versionAfter !== metaRaw) {
      unsettled('moved');
      return fail(
        'the journal advanced while its checkpoint file was being read, so its rows and its checkpoints could not be read from one state — nothing was written. Run `sthayi journal verify` again once the store is idle.',
      );
    }
    const authenticate = (raw: string): Checkpoint | undefined => {
      const cp = parseCheckpoint(raw);
      return cp && verifyCheckpoint(mac, cp) ? cp : undefined;
    };
    const meta = metaRaw === undefined ? undefined : authenticate(metaRaw);
    if (metaRaw !== undefined && !meta) {
      return fail(
        'journal checkpoint tampered or vault key changed — if you rotated ~/.sthayi/key on purpose, run `sthayi journal reseal`',
      );
    }
    const ext = extRaw === undefined ? undefined : authenticate(extRaw);
    if (extRaw !== undefined && !ext) {
      return fail(
        'external journal checkpoint tampered or vault key changed — if you rotated ~/.sthayi/key on purpose, run `sthayi journal reseal`',
      );
    }
    if (restarted && extRaw === undefined) {
      // See `restarted`: this verification already found bytes at that path, so nothing being
      // there now is a removal, not an anchor that was never installed.
      return fail(
        'external journal checkpoint disappeared while it was being verified — nothing is at the path, so nothing outside the database vouches for this store. Restore the checkpoint file, then run `sthayi journal reseal` if this was intentional.',
      );
    }

    // (4) no checkpoint anywhere. 'pristine' is only reachable WITHOUT prior-install evidence:
    // an installation that demonstrably existed before (key file, clients ledger, or external
    // checkpoint were present at open) whose journal is now empty had its history erased or its
    // database replaced — that must fail, not pass as a fresh store.
    if (!meta && !ext) {
      if (rows.length === 0) {
        if (this.opts?.priorInstall) {
          return fail(
            'initialized installation with erased journal history — run `sthayi journal reseal` only if you intentionally reset it',
          );
        }
        return { ok: true, length: 0, state: 'pristine' };
      }
      return fail(
        `journal has ${rows.length} entries but no authenticated checkpoint — either this store predates checkpoints or its checkpoints were erased. Review the history, then run \`sthayi journal reseal\` to accept it as trusted.`,
      );
    }

    // (5) the DATABASE META copy must be the checkpoint of the CURRENT LIVE chain. Validating
    // only the higher-count copy would let a lagging or divergent meta copy ride along behind a
    // good external one — and the next ordinary append would then mirror that bad meta copy over
    // the good file, turning a green verify red with no attacker involvement.
    const tip = rows[rows.length - 1];
    if (!meta) {
      // ext is necessarily present here (no-checkpoint-anywhere returned at (4)): an external
      // anchor survives next to a database that has none. Meta is written transactionally with
      // every append, so it cannot legitimately be missing while rows and a file copy exist.
      const survivor = ext as Checkpoint;
      return fail(
        `journal has no authenticated checkpoint in the database, but the checkpoint file records ${survivor.count} entries ending at #${survivor.tipId} — the database was replaced or its checkpoint erased. Review the history, then run \`sthayi journal reseal\` to accept the current store as trusted.`,
      );
    }
    if (!tip || !this.isLiveCheckpoint(meta, rows)) {
      return fail(
        `journal truncated or restored from a different snapshot — the authenticated checkpoint records ${meta.count} entries ending at #${meta.tipId}, but the store has ${rows.length}${tip ? ` ending at #${tip.id}` : ''}. If you restored a backup on purpose, run \`sthayi journal reseal\` to accept the current history.`,
      );
    }

    // (6) the external copy: identical to meta, or a verified ancestor (prefix) that may advance
    const external = this.opts?.external;
    if (ext && (ext.count !== meta.count || ext.tipId !== tip.id || ext.tipHash !== tip.hash)) {
      if (ext.count > rows.length) {
        return fail(
          `journal truncated or restored from an older snapshot — the authenticated checkpoint records ${ext.count} entries ending at #${ext.tipId}, but the store has ${rows.length} ending at #${tip.id}. If you restored a backup on purpose, run \`sthayi journal reseal\` to accept the current history.`,
        );
      }
      if (!this.isChainPrefix(ext, rows)) {
        return fail(
          `external journal checkpoint (${ext.count} entries ending at #${ext.tipId}) does not match this journal's history — the store or the checkpoint file was swapped. If this was an intentional restore, run \`sthayi journal reseal\`.`,
        );
      }
    }
    // Is the off-database anchor CURRENT? Byte equality against the live meta checkpoint, because
    // the MAC is deterministic: equal fields serialize to equal bytes, so anything other than an
    // exact match is a file that commits to a different history than the one this store holds.
    let anchored = extRaw === metaRaw;

    // (7) Heal only ever ADVANCES the file: by (5) the meta copy is the current live checkpoint,
    // and by (6) the external copy is absent or a strict prefix of the same chain, so writing the
    // meta bytes out can only move the file forward — it can never regress or diverge it.
    // Skipped entirely in non-healing mode.
    //
    // COMPARE-AND-SWAP, for the same reason the mirror needs one: (3) and (6) validated `extRaw` —
    // the bytes read at the top of this verification — and the file can change before the heal
    // lands. The replacement therefore carries that exact expectation, and a destination that
    // changed under us is left BYTE-IDENTICAL. A conflict also turns this verification RED: the
    // green verdict was reached over bytes that are no longer at the path, so reporting 'ok' would
    // be vouching for a state nobody checked.
    // `advanceOnly` (the append gate) heals a lag but never a CREATE: see the option's note.
    const mayHeal = heal && !anchored && (extRaw !== undefined || opts?.advanceOnly !== true);
    if (mayHeal && external !== undefined && metaRaw !== undefined) {
      let swapped = false;
      try {
        swapped = !replaceCheckpoint(external, extRaw, metaRaw);
      } catch (err) {
        // A heal that THREW proves NOTHING about the destination. The throw may come from the
        // write side (read-only session, lock contention, I/O) — in which case the state this
        // verification already validated is still the state on disk and the verdict stands — or
        // from the DESTINATION ITSELF having become something the store refuses to touch: a
        // symlink, a FIFO, an unreadable or oversized file, a path that vanished. Falling through
        // to `return ok` on a warning alone is the false green: it vouches for `extRaw`, bytes
        // that may no longer be at the path at all — a SYMLINK carrying attacker bytes is exactly
        // what both throws and a swap look like from here.
        this.opts?.warn?.(
          `journal checkpoint file heal failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        const broken = this.failureAfterHealThrew(extRaw, metaRaw);
        if (broken !== undefined) {
          return fail(broken);
        }
      }
      if (swapped) {
        // COMPARE-AND-SWAP CONFLICT. Nothing was written and the destination is byte-identical, so
        // the only thing established is that the bytes this pass authenticated are no longer the
        // bytes at the path. That is the SHAPE a cooperative peer produces — it commits and
        // mirrors as two steps, and its mirror can land inside our heal — and it is also the shape
        // of a tamper. Neither reading may be assumed here, so the pass reports the conflict and
        // the verdict is decided by starting OVER on freshly read state (see verify): whatever is
        // at the path now walks the whole ladder on its own merits. Unauthentic, divergent,
        // non-ancestor, absent and unreadable bytes each fail it for their own reason; only a
        // complete, authenticated, current snapshot passes.
        unsettled('conflict');
        return fail(
          'external journal checkpoint changed between the read that authenticated it and the heal — the file was replaced under an in-progress verification and has been left untouched. Review the file, then run `sthayi journal reseal` if this was intentional.',
        );
      }
      // READ-BACK. A heal is green only once the DESTINATION says so. `replace` returning true is
      // the writer's belief; the two states failureAfterHealThrew forgives are "unchanged" and
      // "someone else installed the live copy", and only the second of those leaves the anchor
      // current — so an unchanged old prefix after a failed heal must fall through to (8) as a
      // degraded anchor, exactly like one nobody tried to heal at all.
      //
      // THE BYTES READ BACK ARE RETAINED AND AUTHENTICATED, and they — not `extRaw` — are what the
      // verdict describes. Reading back only to compare against `metaRaw` and then DIAGNOSING from
      // the stale pre-heal copy would report hostile bytes swapped in during the heal as "an
      // authentic part of this history … a checkpoint file that stopped advancing": the
      // destination may hold a bad-MAC blob, a foreign authentic checkpoint, or nothing at all,
      // while the verdict recites the count and tip of a prefix that is no longer at the path.
      let readBack: string | undefined;
      try {
        readBack = external.read();
      } catch (err) {
        this.opts?.warn?.(
          `journal checkpoint file re-read after the heal failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return fail(
          'external journal checkpoint could not be re-read after the heal — refusing to report this journal as verified while nothing can confirm what is at the path. Review the file, then run `sthayi journal reseal` if this was intentional.',
        );
      }
      anchored = readBack === metaRaw;
      if (!anchored && readBack !== extRaw) {
        // ONE of these arrivals is not a tamper: the bytes at the path are EXACTLY the checkpoint
        // the database holds RIGHT NOW. That is a peer which committed its own entry and mirrored
        // it while we healed — it moved the store forward and anchored it there, so `metaRaw` (read
        // before that commit) is simply out of date, and diagnosing from it would report the
        // healthiest possible state as a replaced anchor. It is also unforgeable as a bypass: bytes
        // that equal the database's current checkpoint ARE the anchor being current. Ask again from
        // one state; every other arrival is judged on what it actually is, fail-closed.
        if (readBack !== undefined && readBack === this.committedCheckpointRaw()) {
          unsettled('moved');
          return fail(
            'the journal advanced while its checkpoint file was being healed, so the two could not be read from one state — nothing was written. Run `sthayi journal verify` again once the store is idle.',
          );
        }
        // Neither the checkpoint the heal was installing nor the bytes this verification
        // authenticated: whatever is at the path arrived after the ladder ran and has been
        // validated by nobody. Report ITS actual state, fail-closed.
        return fail(this.describeReplacedAnchor(readBack, mac, rows, tip));
      }
    }

    // (8) THE OFF-DATABASE ANCHOR INVARIANT (see the ladder above). A CONFIGURED external copy
    // that is absent or stale means nothing outside the database vouches for this store, so it
    // may not authorize an append, a rollback, or any other mutation — and it may not be rendered
    // as a green integrity check either. `extRaw`/`ext` are safe to describe here: a heal that
    // observed different bytes on read-back has already returned above, so reaching this point
    // means the path still holds exactly the copy step (3) read and step (6) classified.
    if (external && !anchored) {
      const pending = opts?.mirrorPending === true ? this.liveExemption() : undefined;
      const inFlight = pending !== undefined && extRaw === pending.raw;
      if (!inFlight) {
        return fail(
          extRaw === undefined
            ? `journal has ${rows.length} entr${rows.length === 1 ? 'y' : 'ies'} and an authenticated checkpoint in the database, but NO checkpoint file outside it — nothing off-database vouches for this store, so replacing the whole database would not be detectable. Restore the checkpoint file (clear anything blocking it, e.g. a stray \`journal.checkpoint.lock\`), then run \`sthayi journal reseal\`.`
            : `external journal checkpoint is STALE — it records ${(ext as Checkpoint).count} entr${(ext as Checkpoint).count === 1 ? 'y' : 'ies'} ending at #${(ext as Checkpoint).tipId} while the database is at ${rows.length} ending at #${tip.id}. It is an authentic part of this history, so this is a checkpoint file that stopped advancing (a jammed \`journal.checkpoint.lock\`, a failed mirror, or a database restored without it) — not proof of tampering, but the off-database anchor is not vouching for the store's current state. Fix whatever is blocking the file, then run \`sthayi journal reseal\`.`,
        );
      }
    }
    return { ok: true, length: rows.length, state: 'ok' };
  }

  /**
   * Accept the CURRENT history as trusted and write fresh checkpoints (both copies) — the
   * explicit trust decision behind `sthayi journal reseal`. With `onlyIfMissing` (openStore's
   * automatic path) it initializes ONLY a genuinely empty first-run store: any rows-bearing
   * store without an authentic checkpoint refuses and stays failing until the explicit reseal
   * (a pre-checkpoint upgrade is indistinguishable from an erased-checkpoint attack, so the
   * automatic path fails closed). Refuses when the chain itself does not verify: resealing
   * must never bless a broken chain. Appends an auditable 'journal_seal' entry (spec §1
   * invariant 3 — every trust decision is journal history), whose append refreshes both
   * checkpoint copies.
   *
   * TWO HALVES, REPORTED HONESTLY. The database half (the seal entry + the meta checkpoint) commits
   * transactionally; the external file half is a separate write that a live lock, an I/O error or a
   * hostile destination can defeat on its own. The two cannot be made atomic, so the RESULT
   * distinguishes them: `ok` is true only after the file has been READ BACK and confirmed to hold
   * exactly the new authenticated checkpoint, and a committed-database/failed-file outcome returns
   * `{ ok: false, partial: true }` with the reason. Callers must never render a partial result as
   * "both checkpoints rewritten", and must exit nonzero on it — verification stays red until the
   * file is fixed.
   */
  seal(actor: string, now: number, opts?: { onlyIfMissing?: boolean }): SealResult {
    const mac = this.macFn();
    if (!mac) {
      return { ok: false, reason: 'checkpointing is disabled (no MAC-capable crypto wired)' };
    }
    // The forced mirror's explicit outcome, delivered by the post-commit flush the seal's own
    // append schedules. A seal whose database half committed while its file half did not is a
    // PARTIAL failure, and the only way to know which happened is to be told.
    //
    // Both facts are PER ATTEMPT and are minted inside the attempt. `writeTransaction` retries the
    // whole callback on SQLITE_BUSY, and an attempt that rolled back left no seal entry behind —
    // so a flag that outlived it would let a LATER attempt's `onlyIfMissing` early return (another
    // process sealed in between, which is the case this option exists to tolerate) inherit "this
    // process appended", force an external mirror, and report a partial seal for work that never
    // happened. Only the attempt that ran last — the one that committed — is read below.
    let settled: { appended: boolean; flush?: FlushOutcome } | undefined;
    const result = this.store.writeTransaction((): SealResult => {
      const attempt: { appended: boolean; flush?: FlushOutcome } = { appended: false };
      settled = attempt;
      if (opts?.onlyIfMissing) {
        if (this.store.getMeta(JOURNAL_CHECKPOINT_KEY) !== undefined) {
          return { ok: true }; // another process already sealed — nothing to do
        }
        // TOFU means FIRST use, and first use means a genuinely EMPTY store. A rows-bearing
        // store with no authentic checkpoint — even a chain-valid one — must FAIL CLOSED:
        // from here, a legitimate pre-checkpoint upgrade is indistinguishable from a database
        // that was truncated or wholesale-replaced with its checkpoints erased, so auto-sealing
        // at open would launder the attack. Only the explicit trust decision
        // (`sthayi journal reseal`) may bless a rows-bearing checkpoint-less store.
        const rowCount = this.store.allJournal().length;
        if (rowCount > 0) {
          return {
            ok: false,
            reason: `journal has ${rowCount} entr${rowCount === 1 ? 'y' : 'ies'} but no authenticated checkpoint — refusing to auto-seal (a pre-checkpoint store is indistinguishable from one whose checkpoints were erased); review the history, then run \`sthayi journal reseal\` to accept it as trusted`,
          };
        }
        // An initialized installation (prior-install evidence captured by the caller) whose
        // journal is EMPTY had its history erased or its database replaced — auto-sealing
        // would bless the wipe.
        if (this.opts?.priorInstall) {
          return {
            ok: false,
            reason:
              'initialized installation with erased journal history — refusing to auto-seal; run `sthayi journal reseal` only if you intentionally reset it',
          };
        }
        // An authenticated EXTERNAL checkpoint surviving next to a store with no meta checkpoint
        // is evidence of an erased or snapshot-restored database, not a fresh one — auto-sealing
        // at open would launder it. Only the explicit trust decision (`sthayi journal reseal`)
        // may bless that state. An UNREADABLE external file fails closed the same way: we cannot
        // rule out that it is that evidence.
        const probe = this.externalProbe(mac);
        if (probe === 'authentic') {
          return {
            ok: false,
            reason:
              'an authenticated journal checkpoint file exists but the store has no checkpoint — refusing to auto-seal (erased or restored store?); review the history, then run `sthayi journal reseal` if this was intentional',
          };
        }
        if (probe === 'unreadable') {
          return {
            ok: false,
            reason:
              'journal checkpoint file unreadable — refusing to auto-seal; fix permissions or restore the file',
          };
        }
      }
      const rows = this.store.allJournal();
      const chain = verifyChain(rows);
      if (!chain.ok) {
        return {
          ok: false,
          reason: `refusing to seal: the hash chain itself is broken — ${chain.reason ?? `at entry ${chain.brokenAt}`}`,
        };
      }
      this.appendEntry(
        { ts: now, actor, op: 'journal_seal', payload: { entries: rows.length } },
        true,
        undefined,
        (outcome) => {
          attempt.flush = outcome;
        },
      );
      attempt.appended = true;
      return { ok: true, entries: rows.length + 1 };
    });
    if (!result.ok || settled === undefined || !settled.appended) {
      // refused, or `onlyIfMissing` found another process had already sealed: nothing was
      // written here, so there is nothing to confirm and nothing to overstate.
      return result;
    }
    // Legacy drivers without afterCommit deferred the mirror rather than running it — run it now
    // and take THAT outcome. Either way `flush` is a real result, never an assumption.
    let flush = settled.flush;
    if (flush === undefined || flush.state === 'deferred') {
      flush = this.mirrorExternal(true);
    }
    // The database half is committed and durable at this point. Report success ONLY once the
    // external half has been CONFIRMED to hold it — read back, compared, not inferred from the
    // absence of a throw.
    //
    // A SHORTFALL IS NOT YET THE PARTIAL OUTCOME, for the same reason it is not for an ordinary
    // append (see classifyAnchor): on a shared store the checkpoint this seal minted can be
    // SUPERSEDED between the mirror and the read-back. A peer commits its own entry — advancing the
    // database checkpoint past ours — and mirrors it as a second step, so the comparison above can
    // catch the pair mid-advance and report "the database was resealed but the file was NOT" about
    // a store that is perfectly anchored a moment later, and one entry further on. Read as a
    // partial seal that is a durable trust decision reported as a failure, with a nonzero exit and
    // an instruction to reseal again.
    //
    // The honest test is the one the NEXT write will actually apply: re-verify, advancing a lag
    // exactly as the append gate does. Green means both copies agree on the store's CURRENT state,
    // which is everything the reseal was for. Red is the genuine partial outcome — the database
    // half is durable, nothing outside it vouches for the store, and every further write refuses.
    const shortfall = this.confirmExternalSealed(flush);
    if (shortfall !== undefined && !this.verify({ heal: true, advanceOnly: true }).ok) {
      return {
        ok: false,
        partial: true,
        entries: result.entries,
        external: flush.state,
        reason: shortfall,
      };
    }
    return { ...result, external: flush.state };
  }

  /**
   * Post-reseal confirmation: does the external checkpoint file now hold EXACTLY the authenticated
   * checkpoint the database just committed?
   *
   * INVARIANT: a reseal may only be reported as successful when BOTH copies carry the new
   * checkpoint. The flush outcome alone is not enough — it says what the writer believes it did,
   * and the destination can be replaced by a peer or a hostile process the instant afterwards — so
   * this RE-READS the file and compares bytes. Returns `undefined` when confirmed, otherwise the
   * reason the reseal is only PARTIAL.
   */
  private confirmExternalSealed(flush: FlushOutcome): string | undefined {
    const external = this.opts?.external;
    if (!external || flush.state === 'disabled') {
      return undefined; // no external copy is wired — there is no second half to be out of step
    }
    const raw = this.store.getMeta(JOURNAL_CHECKPOINT_KEY);
    if (raw === undefined) {
      return 'the seal entry committed but the database no longer holds a checkpoint for it — the store changed underneath the reseal; run `sthayi journal reseal` again';
    }
    let current: string | undefined;
    try {
      current = external.read();
    } catch (err) {
      return `the journal checkpoint file could not be read back after the reseal (${err instanceof Error ? err.message : String(err)}) — the database was resealed but the file was NOT; fix the file, then run \`sthayi journal reseal\` again`;
    }
    if (current === raw) {
      return undefined;
    }
    const detail = flush.reason === undefined ? '' : ` (${flush.reason})`;
    return current === undefined
      ? `the journal checkpoint file was not written${detail} — the database was resealed but the file is absent; fix the cause, then run \`sthayi journal reseal\` again`
      : `the journal checkpoint file still holds different bytes${detail} — the database was resealed but the file was NOT; fix the cause, then run \`sthayi journal reseal\` again`;
  }

  recent(n = 20): JournalRecord[] {
    return this.store.recentJournal(n);
  }

  planUndo(targetId: number, now: number, actor = 'cli'): RollbackPlan | undefined {
    const target = this.store.allJournal().find((r) => r.id === targetId);
    if (!target) {
      return undefined;
    }
    return planRollback(target, now, actor);
  }
}
