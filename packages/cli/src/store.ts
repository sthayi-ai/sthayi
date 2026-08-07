import fs from 'node:fs';
import path from 'node:path';
import {
  AssocService,
  type CheckpointStore,
  type CommitReceipt,
  JOURNAL_CHECKPOINT_KEY,
  type JournalAppend,
  JournalService,
  type Memory,
  MemoryService,
  type MutationOutcome,
  type SealResult,
  VaultService,
  committedReceipts,
  describeReceipt,
  isDegradedReceipt,
  maskDeep,
  stableStringify,
} from '@sthayi/core';
import { FileCheckpoint } from './drivers/checkpoint-file.js';
import { NodeCrypto } from './drivers/crypto.js';
import { SqliteDriver } from './drivers/sqlite.js';
import {
  assertReadOnlySthayiHome,
  checkpointPath,
  dbPath,
  ensureSthayiHome,
  keyPath,
  sthayiHomeRoot,
} from './paths.js';

/** Which of the store's AUTOMATIC startup mutations an outcome describes. */
export type StartupStep = 'first-run-seal' | 'pii-migration';

/**
 * WHAT THE STORE'S AUTOMATIC STARTUP MUTATIONS ACHIEVED — the typed channel every front door reads
 * before it runs a command.
 *
 * WHY THERE IS A CHANNEL AT ALL. Opening the store is not read-only. Two mutations run on the way
 * in, unasked: the first-run seal writes a `journal_seal` entry plus the meta checkpoint, and the
 * legacy-PII migration remasks memory rows and appends `migrate_masking`. Both are journaled
 * writes, so both have the third outcome — COMMITTED while the off-database anchor did not advance —
 * and neither is anything the invoked command asked for. Reduced to a stderr warning, that outcome
 * reaches the caller as decoration on a command that then prints its ordinary success and exits 0:
 * a store that has stopped accepting writes, reported as a healthy one. Riding on the store the
 * command is about to use, it cannot be left behind.
 *
 * THREE STATES, because there are three things that can have happened, and collapsing any two of
 * them mis-instructs the caller:
 *  - 'clean'                — the step ran to completion (or had nothing to do). Nothing to report;
 *  - 'refused'              — the step declined and wrote NOTHING. A refusal is safe to re-run: the
 *                             store is exactly as it was, and the reason says what to fix;
 *  - 'committed-unanchored' — the DATABASE half is durable and the anchor did not follow. Retrying
 *                             cannot undo or redo it, further writes are BLOCKED, and the repair is
 *                             the anchor rather than the operation.
 */
export type StartupOutcome =
  | { readonly state: 'clean'; readonly step: StartupStep }
  | { readonly state: 'refused'; readonly step: StartupStep; readonly reason: string }
  | {
      readonly state: 'committed-unanchored';
      readonly step: StartupStep;
      /** the single sentence every surface renders — states committed / do-not-retry / blocked */
      readonly message: string;
      /** the journal entry's receipt, for the steps that append one (the PII migration) */
      readonly receipt?: CommitReceipt;
    };

/** The one startup state a front door may not proceed past. */
export type StartupBlocked = Extract<StartupOutcome, { state: 'committed-unanchored' }>;

/** The startup steps that COMMITTED while the anchor did not advance — narrowing, so a caller
 *  handles the blocked state by reading a typed value rather than by testing a boolean. */
export function startupBlockers(outcomes: readonly StartupOutcome[]): StartupBlocked[] {
  const out: StartupBlocked[] = [];
  for (const o of outcomes) {
    if (o.state === 'committed-unanchored') {
      out.push(o);
    }
  }
  return out;
}

/**
 * A startup mutation committed while the anchor did not advance, on a path that has no other way to
 * report it — the MCP servers, whose only return is "the server is running".
 *
 * It is an ERROR rather than a return value on purpose: `runServer()` resolving normally means the
 * server is serving, and a server that hands a model a store which has stopped accepting writes,
 * while every tool result still reads clean, is the exact mis-framing this channel exists to
 * prevent. The blocked outcomes travel on the error so the CLI layer renders the same report a
 * command would.
 */
export class StartupUnanchoredError extends Error {
  constructor(readonly blocked: readonly StartupBlocked[]) {
    super(blocked.map((b) => b.message).join('\n'));
    this.name = 'StartupUnanchoredError';
  }
}

/** A usable store: the services plus the connection that owns them. */
export interface Store {
  driver: SqliteDriver;
  journal: JournalService;
  memory: MemoryService;
  vault: VaultService;
  assoc: AssocService;
  close(): void;
}

/**
 * A store THIS PROCESS OPENED — a {@link Store} that additionally carries what the automatic
 * startup mutations achieved on the way in.
 *
 * The two types are separate because the fact is: `Store` is what a component that was HANDED a
 * store holds, and it never ran a startup mutation; `OpenedStore` is what `openStore()` returns, and
 * opening is precisely the act that can commit the seal or the migration. Making `startup` required
 * HERE means every front door — each CLI command, the stdio MCP server, the HTTP MCP server — is
 * handed the outcome whether or not it thought to ask, and no path can be added that quietly does
 * not have one.
 */
export interface OpenedStore extends Store {
  readonly startup: readonly StartupOutcome[];
}

/**
 * Exit code for an operation that COMMITTED while the off-database anchor did NOT advance with it.
 *
 * It is deliberately NEITHER 0 NOR 1. 0 is what a fully anchored write exits with, and a caller
 * (script, CI, wrapper) that cannot tell those apart will treat a store that has stopped accepting
 * writes as a healthy one. 1 is a REFUSAL — nothing was written — and a caller that reads this as a
 * refusal may retry, duplicating a write that is already durable.
 */
export const EXIT_COMMITTED_UNANCHORED = 3;

/** The repair for every durable-but-unanchored outcome — one wording, so the CLI cannot describe
 *  the same state two ways. */
export const REPAIR_LINES: readonly string[] = [
  '  Repair: clear whatever blocks ~/.sthayi/journal.checkpoint (e.g. a stray',
  '  `journal.checkpoint.lock`), then run `sthayi journal reseal`.',
];

/** Write one report line to stdout — the default surface for a command's own report. */
function writeStdout(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * Render what the store's automatic startup mutations committed, and set the distinct exit code.
 *
 * Startup mutations belong to nobody's command: the first-run seal and the legacy-PII migration run
 * because the store was OPENED. When one of them commits while the anchor does not advance, the
 * command that happened to open the store is running against a store that has stopped accepting
 * writes — so its own write will be refused (exit 1, a REFUSAL, over durable startup work) and its
 * ordinary success line would describe a state that no longer exists. Reported here, before the
 * command body runs, the caller reads the true outcome and the true exit code.
 */
export function reportStartupBlocked(
  blocked: readonly StartupBlocked[],
  write: (line: string) => void = writeStdout,
): void {
  for (const b of blocked) {
    write(b.message);
    for (const line of REPAIR_LINES) {
      write(line);
    }
    write('  This command did NOT run; re-running it will not redo the startup work above.');
  }
  process.exitCode = EXIT_COMMITTED_UNANCHORED;
}

/**
 * What settling the startup gate yielded: the opened store, or the startup steps that COMMITTED
 * while the anchor did not advance and therefore block the command.
 */
export type CliStoreOpen =
  | { readonly ok: true; readonly store: OpenedStore }
  | { readonly ok: false; readonly blocked: readonly StartupBlocked[] };

/**
 * Open the store for a CLI command and SETTLE the startup gate, WITHOUT reporting anything.
 *
 * This is the whole gate — open, read the typed startup channel, close the store again when a
 * startup mutation committed unanchored — with the rendering left to the caller, because rendering
 * is not one thing. A human-readable command prints the prose report {@link reportStartupBlocked}
 * writes; a `--json` surface owes its caller EXACTLY ONE parseable document, so the identical facts
 * have to arrive as VALUES it can place INSIDE that document rather than as lines already sitting
 * on stdout beside it. One gate, one decision, and each front door still honors its own contract.
 *
 * The store is CLOSED before the blocked outcomes are returned: the command must not run, so there
 * is no handle to hand it.
 */
export function settleCliStore(): CliStoreOpen {
  const store = openStore();
  const blocked = startupBlockers(store.startup);
  if (blocked.length === 0) {
    return { ok: true, store };
  }
  store.close();
  return { ok: false, blocked };
}

/**
 * Open the store for a CLI command that reports in PROSE, AFTER settling what opening it committed.
 *
 * Returns undefined when a startup mutation COMMITTED while the anchor did not advance: the report
 * is already on stdout and the exit code is already {@link EXIT_COMMITTED_UNANCHORED}, and the
 * command must not run. Every front door goes through here or through {@link settleCliStore}, which
 * is what makes the startup channel unignorable — a command written to call `openStore()` directly
 * would compile, but it would also be the one door with no answer to "what did opening this
 * commit?".
 *
 * It lives BESIDE the channel rather than inside the command layer because `init` is a front door
 * too: it is the command that creates the store, so it is the one that meets the first-run seal,
 * and it is also the command that goes on to write launchers, skills and client configs. A gate
 * only the command file could reach is a gate `init` reached by calling `openStore()` itself.
 */
export function openCliStore(write: (line: string) => void = writeStdout): OpenedStore | undefined {
  const opened = settleCliStore();
  if (opened.ok) {
    return opened.store;
  }
  reportStartupBlocked(opened.blocked, write);
  return undefined;
}

/**
 * Open (creating + migrating if needed) the store at `~/.sthayi/sthayi.db`, plus the vault (keyed by
 * `~/.sthayi/key`). The full first-run wizard is B4; every store-backed command auto-initializes so
 * it works standalone. The vault is keyless in the API-key sense — its key is a local file.
 */
/**
 * Fold newly journaled entries into the association graph. Non-fatal by design: the edge table is
 * derived state behind a cursor, so on failure the cursor is unchanged and the next successful
 * catchUp (every search runs one) folds from the same spot. Commands that journal merge rewires
 * (consolidate, rollback) call this so associative mass moves with the survivor immediately
 * instead of waiting for the next search.
 */
export function foldAssoc(store: Store): void {
  try {
    store.assoc.catchUp();
  } catch {
    // derived index only — never fail a command whose journal entries already committed
  }
}

export interface ReadOnlyStore {
  driver: SqliteDriver;
  journal: JournalService;
  close(): void;
}

/**
 * Doctor-only read-only open. No home creation, no migration, no key generation, no
 * vault, no TOFU seal — observation must never mutate. The optional crypto (loaded via
 * NodeCrypto.loadExisting, never open()) enables authenticated checkpoint verification; the
 * checkpoint file is wrapped read-only so verify()'s lag-heal write is refused (JournalService
 * degrades that to a warning, which we drop — a heal lag is not a doctor failure).
 *
 * The home is validated FIRST, with the OBSERVATIONAL validator (creates nothing, chmods
 * nothing — ensureSthayiHome would mutate, which observation must never do). Order matters: it
 * caches the validated CANONICAL root, so the dbPath()/checkpointPath() below resolve beneath
 * the directory that was just checked rather than beneath the logical STHAYI_HOME string. A
 * symlinked home (or symlinked parent) throws here instead of silently snapshot-reading a
 * SQLite database outside the home.
 */
export function openStoreReadOnly(opts: { crypto?: NodeCrypto } = {}): ReadOnlyStore {
  assertReadOnlySthayiHome();
  const driver = SqliteDriver.openReadOnly(dbPath());
  const file = new FileCheckpoint(checkpointPath());
  const external: CheckpointStore = {
    read: () => file.read(),
    write: () => {
      throw new Error('read-only session — refusing to write the journal checkpoint file');
    },
  };
  const journal = new JournalService(driver, {
    crypto: opts.crypto,
    external,
    // This session refuses every checkpoint write by construction (above), so a heal it could not
    // perform is OUR limitation, not the store's, and the flag keeps verification from reporting
    // the FAILED WRITE as the problem.
    //
    // It does NOT buy a green verdict for an anchor that is objectively missing or stale. Whether
    // the checkpoint file holds the live checkpoint is a property of the STORE, identical for
    // every observer, and doctor reporting 'ok' over a missing one would be telling the user the
    // whole-database-replacement guarantee is in place while nothing outside the database vouches
    // for the store at all. A healthy store needs no heal, so read-only inspection of one stays
    // green either way.
    externalReadOnly: true,
    warn: () => {
      // read-only diagnostics: heal-write refusals are expected, not reportable problems
    },
  });
  return { driver, journal, close: () => driver.close() };
}

/**
 * Prior-install evidence. Any of the key file, the client wiring ledger, or the external journal
 * checkpoint already existing proves this installation was initialized before — so an empty
 * journal with no authentic checkpoint is erased history, not a pristine store (JournalService
 * fails verification and refuses the TOFU auto-seal).
 * lstat (not existsSync) so a dangling symlink still counts as presence.
 *
 * ORDERING, both halves of which are load-bearing (see openStore): this runs AFTER
 * ensureSthayiHome() — probing the markers first would lstat paths beneath a home that has not
 * been validated yet and that the very next line may refuse, so a home reached through a
 * symlinked ancestor would have its markers read out of the attacker's tree before anything
 * objected — and BEFORE the crypto/store open, which CREATES the key file and would fabricate the
 * evidence it is asked about. ensureSthayiHome creates only the home directory itself, never a
 * marker, so
 * validating first leaves the answer unchanged.
 */
function priorInstallEvidence(): boolean {
  // sthayiHomeRoot(), not sthayiHome(): the marker must be the SAME file clients/state.ts reads,
  // and that one derives from the validated canonical root.
  const markers = [keyPath(), path.join(sthayiHomeRoot(), 'clients-state.json'), checkpointPath()];
  return markers.some((p) => {
    try {
      fs.lstatSync(p);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Meta key holding the state of THIS INSTALLATION'S FIRST-RUN BOOTSTRAP — the one fact a marker
 * on the filesystem cannot supply.
 *
 * WHY IT EXISTS. `priorInstallEvidence()` reads three markers (the key file, the client wiring
 * ledger, the checkpoint file) and answers "was this installation initialized before?". Every one
 * of those markers is also CREATED, by a peer, DURING a first run: opening the store mints the key
 * before it seals. So on a shared store two processes starting together produce a third state the
 * markers alone cannot name — a key that exists because a peer is bootstrapping RIGHT NOW, over a
 * journal that is empty because that peer has not sealed yet. Read as prior-install evidence it is
 * indistinguishable from an initialized installation whose history was erased, and the honest
 * response to erased history — refuse to auto-seal, refuse to append — is then handed to a store
 * that is merely young. THE DISTINCTION IS NOT DERIVABLE FROM THE FILESYSTEM; it has to be
 * RECORDED, and this is the record.
 *
 * WHY IT LIVES IN THE DATABASE, in the meta table, rather than in a lock file or a sentinel beside
 * the key. The bootstrap's other half — the `journal_seal` entry and the meta checkpoint — commits
 * transactionally, so a marker written here shares that transaction's fate and the database's own
 * durability. It also disappears exactly when the thing it describes disappears: ERASING THE STORE
 * ERASES THE CLAIM. That is what keeps erased-history detection intact — a wiped, truncated or
 * replaced database carries no claim, so its surviving key file is read as the prior-install
 * evidence it is, and the refusal stands.
 *
 * The three values are a CLOSED SET (see {@link firstRunState}); anything else means no claim is in
 * force, which is the strict reading.
 */
export const INSTALL_BOOTSTRAP_META_KEY = 'install_bootstrap';
/** A first run is UNDERWAY: recorded before the key file is created, so any process that can see
 *  the key can also see this. Cleared only by one of the two terminal values below. */
export const INSTALL_BOOTSTRAP_UNSETTLED = 'unsettled';
/** The first run COMPLETED: the store holds an authenticated checkpoint and the off-database
 *  anchor holds exactly those bytes. From here the markers mean what they have always meant. */
export const INSTALL_BOOTSTRAP_SETTLED = 'settled';
/** The first run ENDED WITHOUT ANCHORING — refused, partial, or not finished within the wait
 *  below. It is written so peers stop waiting for an anchor nobody is going to publish; it claims
 *  nothing, so the markers are evidence again and every refusal is back in force. */
export const INSTALL_BOOTSTRAP_ABANDONED = 'abandoned';

/** How the store reads the bootstrap marker. Only the two values this build writes for a live or
 *  completed first run are recognized; absent, abandoned, unknown, hand-edited and corrupt cells
 *  are all 'none' — no claim, so prior-install markers are evidence exactly as before. */
type FirstRunState = 'none' | 'in-flight' | 'settled';

function firstRunState(driver: SqliteDriver): FirstRunState {
  const raw = driver.getMeta(INSTALL_BOOTSTRAP_META_KEY);
  if (raw === INSTALL_BOOTSTRAP_UNSETTLED) {
    return 'in-flight';
  }
  if (raw === INSTALL_BOOTSTRAP_SETTLED) {
    return 'settled';
  }
  return 'none';
}

/**
 * How long a process waits for a PEER's first-run bootstrap to publish the off-database anchor.
 *
 * The gap being waited out is one file write: the seal's database half commits, the writer lock is
 * released, and the mirror that puts those bytes outside the database runs immediately afterwards.
 * A peer that takes the lock inside that gap sees an authenticated checkpoint with NO file beside
 * it — the state an ordinary write may never repair itself, because creating the anchor asserts
 * that this history is the real one. Waiting is the only answer that neither weakens that rule nor
 * fails a healthy store: the anchor is seconds of I/O away, and whoever published it is the process
 * entitled to.
 *
 * It matches the checkpoint file's own lock wait deliberately — a bootstrap that cannot publish its
 * anchor within the budget that file's writer is given is not going to publish it at all, and the
 * wait ends in {@link INSTALL_BOOTSTRAP_ABANDONED} rather than in a longer wait.
 */
const FIRST_RUN_SETTLE_WAIT_MS = 5_000;
/** Poll interval while waiting on a peer's bootstrap (same technique as the checkpoint lock). */
const FIRST_RUN_POLL_MS = 5;

/** Synchronous sleep — the whole open path is sync, and Atomics.wait is the only correct way to
 *  block without spinning the CPU. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Is the first run COMPLETE — both copies of the checkpoint in place and identical?
 *
 * Byte equality against the meta copy, because that is the same test verification applies: the MAC
 * is deterministic, so anything other than an exact match is a file committing to a different
 * history. A read that THROWS (a symlink, a special file, an unreadable one) is NOT settled —
 * fail closed, so a hostile or broken destination can never end a peer's wait early or promote the
 * claim to its terminal value.
 */
function firstRunAnchored(driver: SqliteDriver, external: FileCheckpoint): boolean {
  const meta = driver.getMeta(JOURNAL_CHECKPOINT_KEY);
  if (meta === undefined) {
    return false;
  }
  try {
    return external.read() === meta;
  } catch {
    return false;
  }
}

/** What THIS process's open did about the first-run seal — the input that decides whether the
 *  bootstrap marker can be retired here, and whether there is a peer worth waiting for. */
type FirstRunOutcome =
  /** our seal ran and CONFIRMED both copies: the first run is complete, by us */
  | 'anchored'
  /** our seal ran and did NOT anchor (refused, or committed while the file did not follow):
   *  nothing is in flight any more, and no peer is going to finish it */
  | 'unanchored'
  /** we did not perform the seal — the checkpoint was already there, or a peer won the race
   *  inside it. Whoever did is still mirroring, and that is worth waiting for */
  | 'peer';

/**
 * Retire the bootstrap marker — and, when the bootstrap belongs to a PEER, wait for it.
 *
 * THREE OUTCOMES, THREE DIFFERENT ACTIONS, because collapsing any two of them either strands the
 * marker or spends the wait on nothing:
 *  - 'anchored'   — we hold the proof (seal() confirms the file by read-back before reporting ok),
 *                   so the marker goes straight to its terminal value;
 *  - 'unanchored' — our own bootstrap ended without an anchor. There is nothing in flight, so the
 *                   marker is retired IMMEDIATELY as abandoned: leaving it would make every peer
 *                   spend the full wait on a bootstrap that already finished failing;
 *  - 'peer'       — someone else's seal committed and its mirror may still be in flight. Wait for
 *                   the anchor to appear, then retire the marker. This is the whole point of the
 *                   wait: the next thing this process does is a journaled write, and that write's
 *                   gate requires an off-database anchor it is not itself allowed to create.
 *
 * The wait is BOUNDED and its expiry is RECORDED. A bootstrap that never anchors (its process
 * died, the checkpoint path is blocked) would otherwise cost every later invocation the same full
 * wait; marking it abandoned ends that, and — because abandonment claims nothing — hands the
 * markers back their meaning, so the refusals a half-finished installation deserves all return.
 */
function settleFirstRun(
  driver: SqliteDriver,
  external: FileCheckpoint,
  outcome: FirstRunOutcome,
): void {
  if (firstRunState(driver) !== 'in-flight') {
    return; // no claim of ours or anyone else's is outstanding
  }
  const mark = (value: string): void => {
    driver.writeTransaction(() => driver.setMeta(INSTALL_BOOTSTRAP_META_KEY, value));
  };
  if (outcome === 'anchored') {
    mark(INSTALL_BOOTSTRAP_SETTLED);
    return;
  }
  if (outcome === 'unanchored') {
    mark(INSTALL_BOOTSTRAP_ABANDONED);
    return;
  }
  const deadline = Date.now() + FIRST_RUN_SETTLE_WAIT_MS;
  for (;;) {
    if (firstRunAnchored(driver, external)) {
      mark(INSTALL_BOOTSTRAP_SETTLED);
      return;
    }
    // Re-read every pass: the peer that owns the bootstrap retires the marker itself, and once it
    // has there is nothing left to wait for whichever terminal value it chose.
    if (firstRunState(driver) !== 'in-flight') {
      return;
    }
    if (Date.now() >= deadline) {
      mark(INSTALL_BOOTSTRAP_ABANDONED);
      return;
    }
    sleepSync(FIRST_RUN_POLL_MS);
  }
}

/**
 * Meta key holding the state of the two-phase remask that remediates LEGACY UNMASKED STORES —
 * databases written by a build that predates at-rest PII masking, whose memory content, scope,
 * source and provenance can hold plaintext PII (SECURITY.md, "Compatibility boundary — legacy
 * unmasked stores").
 *
 * THE KEY IS VERSIONED, AND THE VERSION IS LOAD-BEARING. The superseded v1 key
 * (`PII_REMASK_LEGACY_META_KEY`) cannot be trusted as evidence: a legacy build stamped its FINAL
 * value there whenever the row pass changed ZERO rows, reading clean current rows as proof about
 * the file's bytes. It is not proof — freed pages, superseded FTS segments and un-checkpointed
 * WAL frames can each still hold plaintext while every surviving row reads perfectly clean. So a
 * v1 value of ANY kind, `PII_REMASK_DONE` included, says nothing about whether the database was
 * ever physically scrubbed. Only THIS key gates the migration, its VALUE is parsed against a
 * closed state machine (`remaskState`) rather than tested for definedness, and its final value is
 * only ever written after the scrub itself completed and verified.
 */
export const PII_REMASK_META_KEY = 'pii_remask_v2';
/**
 * The superseded v1 key. Kept READABLE for diagnostics — the incomplete-scrub warning reports it,
 * so a store that came through the legacy stamp is identifiable — and never written again.
 * IT MUST NEVER GATE THE SCRUB: see PII_REMASK_META_KEY for why its final value proves nothing.
 */
export const PII_REMASK_LEGACY_META_KEY = 'pii_remask_v1';
/** Phase-1 state: memory rows scanned and remasked (and journaled, if any changed) — the
 *  byte-level remnant scrub is still PENDING. EVERY pre-existing database reaches this state,
 *  including one where zero rows changed: current row VALUES are not evidence about the file.
 *  A legacy row that was DELETED or OVERWRITTEN before the migration leaves its plaintext
 *  behind on freed pages, in superseded FTS segments and in un-checkpointed WAL frames while
 *  every surviving row reads perfectly clean. Only phase 2 can speak to bytes. THIS EXACT STRING
 *  under the current key is the only thing that skips the row pass — it is written by phase 1
 *  itself, inside phase 1's transaction, so it means the rows provably were covered. An absent,
 *  unknown or corrupt value is NOT this state (see `remaskState`): it re-runs the row pass and
 *  then the scrub, so an interrupted or unverified migration is redone and proven. */
export const PII_REMASK_ROWS_DONE = 'rows-done';
/** Final state, reachable exactly ONE way: the rows were remasked AND the remnant bytes were
 *  scrubbed and verified, in that order, in this process or an earlier one. There is no
 *  freshness shortcut and no "the file looked new" shortcut — a brand-new store simply runs the
 *  (empty, cheap) row pass and the scrub like everything else. Meaningful ONLY
 *  under PII_REMASK_META_KEY: the identical string under the legacy key is not evidence.
 *  SCOPE — visible by design: the rows phase covers MEMORY ROWS ONLY. Journal history is
 *  append-only (spec §1 invariant 3) and is never rewritten, so a legacy store's journal payloads
 *  (e.g. memory_retrieve query text, which was secret-only-masked back then) may legitimately
 *  retain plaintext PII. That compatibility boundary is stated in SECURITY.md and pinned by
 *  tests/safety/pii-migration.test.ts. */
export const PII_REMASK_DONE = 'scrubbed';

/**
 * The migration's state machine, and the ONLY reading of the marker cell that may skip work.
 *
 * THREE states, and everything that is not literally one of the two known markers under the
 * CURRENT key is the first one:
 *
 *  - `rows-pending` — absent, UNKNOWN (a value this build never writes: a future build's state,
 *    a hand-edited or corrupt cell, a truncated write, `'garbage-state'`), or anything else at
 *    all. NOTHING has been proven about this database, so BOTH phases run: the row remask first,
 *    then the physical scrub. Treating a merely-DEFINED value as evidence is the exact bug this
 *    machine exists to prevent: an unrecognized marker that skipped the row pass would let live
 *    plaintext survive in memory rows and then be promoted to the final state.
 *  - `rows-done` — phase 1 provably completed (this build wrote that marker inside phase 1's own
 *    transaction); the byte scrub is still owed and runs.
 *  - `scrubbed` — both phases completed and verified. The only state that stands down work.
 *
 * There is no freshness bypass, deliberately. lstat()ing the database path before
 * `SqliteDriver.open()` creates it and treating absence as proof that no legacy byte can exist is
 * a TOCTOU race: another process — or anything else on the machine — can create or replace the
 * file inside that check-then-open window, and the store would then be stamped final without ever
 * being scrubbed. No such shortcut is worth it anyway — a brand-new store has zero rows and a few
 * pages, so the row pass short-circuits on `countMemories() === 0`
 * and the scrub is trivially cheap, exactly once, on first open. Fail-safe by construction —
 * the only way to reach the final marker is to actually do the work.
 */
type RemaskState = 'rows-pending' | 'rows-done' | 'scrubbed';

function remaskState(driver: SqliteDriver): RemaskState {
  const raw = driver.getMeta(PII_REMASK_META_KEY);
  if (raw === PII_REMASK_DONE) {
    return 'scrubbed';
  }
  if (raw === PII_REMASK_ROWS_DONE) {
    return 'rows-done';
  }
  return 'rows-pending';
}

/**
 * PHASE 1 of the two-phase PII migration, for LEGACY UNMASKED STORES — written by a build that
 * predates at-rest PII masking, so they can hold plaintext PII in memory
 * content/scope/source/provenance. Inside ONE write transaction: run the current at-rest masker
 * (secrets + PII → vault pseudonyms) over every memory row, update only the rows that changed,
 * append ONE `migrate_masking` journal entry — only when rows actually changed AND no prior event
 * exists, so the count stays exactly one across retries — and set the state to
 * PII_REMASK_ROWS_DONE.
 *
 * ALWAYS PII_REMASK_ROWS_DONE, never the final state: this function only ever runs on a
 * database that already existed, and phase 2 is the only thing that can speak for that
 * database's BYTES. Zero remasked rows means "nothing left to change in the current rows" — it
 * does not mean "no old plaintext in the file". Deriving "nothing to scrub" from current row values
 * is an invalid inference: a legacy row deleted (or overwritten) before the migration leaves the
 * plaintext on freed pages and in superseded FTS segments with every surviving row clean.
 *
 * Runs on every store that lacks the CURRENT marker, including one an older build already
 * remasked — masking masked rows is a no-op, so such a store passes through with zero changes and
 * no second journal entry, and proceeds to the physical scrub it never provably had.
 *
 * Idempotent — racing processes serialize on the write lock and the loser re-checks the state
 * inside it. Mutates memory rows but never journal history (spec §1 invariant 3).
 *
 * Returns the remask count, the ORIGINAL field values that were replaced — the byte
 * needles phase 2 verifies are actually gone from the file (held in memory only; persisting
 * them anywhere would itself store plaintext) — and the `migrate_masking` entry's
 * {@link MutationOutcome}.
 *
 * THE OUTCOME IS A RETURN VALUE, not a discarded expression. This append is a journaled write like
 * any other and has the same three outcomes, but nobody asked for it: it rides in on whatever
 * command happened to open the store. Dropped here, a migration that COMMITTED while the anchor did
 * not advance can only be inferred from a stderr warning, and the command that triggered it goes on
 * to print its ordinary success at exit 0. 'no-entry' when the pass appended nothing — no rows
 * changed, or another process had already migrated.
 *
 * EXPORTED for the retried-attempt probe in tests/safety/startup-remask-retry.test.ts, which has
 * to read the OUTCOME this returns and no front door carries it that far. It is PHASE 1 ONLY:
 * `openStore` is the caller that sequences it with the phase-2 scrub, and nothing else may call it
 * without doing the same — a store left at PII_REMASK_ROWS_DONE has masked rows and unproven bytes.
 */
export function remaskLegacyRows(
  driver: SqliteDriver,
  journal: JournalService,
  vault: VaultService,
): { remasked: number; needles: string[]; outcome: MutationOutcome } {
  // EVERY PER-ATTEMPT VALUE IS MINTED INSIDE THE ATTEMPT AND RETURNED FROM IT — the append handle
  // included. `writeTransaction` retries the WHOLE body on SQLITE_BUSY, and every attempt before
  // the last one ROLLED BACK: its remasked rows and its `migrate_masking` row are gone with it. A
  // handle held in a variable OUT HERE survives that rollback, so a retry whose second attempt
  // takes the early return below — which a peer finishing the migration between the attempts makes
  // genuinely reachable — returns attempt 1's handle for an entry the database threw away, and the
  // caller reports 'rolled-back' where the truth is 'no-entry'. What escapes belongs to the attempt
  // that committed and to no other.
  const settled = driver.writeTransaction(() => {
    // Re-checked INSIDE the write lock, against the STATE MACHINE — never against mere
    // definedness. Only a state this build itself advanced past phase 1 ('rows-done' or
    // 'scrubbed') means the row pass is already covered; a marker holding anything else proves
    // nothing and must not buy a skip.
    if (remaskState(driver) !== 'rows-pending') {
      // another process migrated while we held the lock — this attempt wrote nothing, and says so
      return { remasked: 0, needles: [] as string[], append: undefined };
    }
    const now = Date.now();
    let remasked = 0;
    const needles: string[] = [];
    let append: JournalAppend | undefined;
    if (driver.countMemories() > 0) {
      // Vault pseudonym mints join this same transaction (allocate uses writeTransaction,
      // which joins) — a failed migration leaves no orphan entities.
      const mask = (s: string): string => vault.maskAtRest(s).masked;
      for (const m of driver.listMemories()) {
        const patch: Partial<Memory> = {};
        const content = mask(m.content);
        if (content !== m.content) {
          patch.content = content;
          needles.push(m.content);
        }
        const scope = mask(m.scope);
        if (scope !== m.scope) {
          patch.scope = scope;
          needles.push(m.scope);
        }
        const source = mask(m.source);
        if (source !== m.source) {
          patch.source = source;
          needles.push(m.source);
        }
        const provenance = maskDeep(m.provenance, mask);
        if (stableStringify(provenance) !== stableStringify(m.provenance)) {
          patch.provenance = provenance;
          needles.push(JSON.stringify(m.provenance));
        }
        if (Object.keys(patch).length > 0) {
          driver.updateMemory(m.id, patch);
          remasked++;
        }
      }
      const alreadyJournaled = driver.allJournal().some((r) => r.op === 'migrate_masking');
      if (remasked > 0 && !alreadyJournaled) {
        append = journal.append({
          ts: now,
          actor: 'migrate',
          op: 'migrate_masking',
          // scope makes the coverage honest and queryable: memory rows only — journal history
          // (a legacy store's retrieve-query payloads etc.) is preserved, never rewritten.
          payload: { remasked, scope: 'memory-rows' },
        });
      }
    }
    driver.setMeta(PII_REMASK_META_KEY, PII_REMASK_ROWS_DONE);
    return { remasked, needles, append };
  });
  // Read AFTER the transaction returned — inside it the answer is 'in-flight' by construction, and
  // an answer captured there would say so forever, including after the commit.
  const { append, ...counts } = settled;
  return { ...counts, outcome: append === undefined ? { state: 'no-entry' } : append.outcome };
}

/**
 * PHASE 2 of the PII migration — the byte-level scrub, on the SAME gated connection (legacy
 * behavior reopened the file via a bare `new Database(file)`, bypassing the open() trust gate;
 * there is no reopen at all now). SQLite never zeroes replaced bytes: the updated pages and the
 * superseded FTS5 segments still carry the OLD plaintext inside the file, and pre-checkpoint
 * WAL frames still carry plaintext page images. So: rebuild the FTS index, VACUUM, TRUNCATE-
 * checkpoint the WAL — then VERIFY, while the store is open: the freelist must be empty, the
 * WAL must be zero bytes, and (when phase 1 ran in this same process and handed us the exact
 * replaced values) the main-db bytes must no longer contain any needle. Needles that appear in
 * preserved journal payloads are excluded from the byte scan — that history is append-only and
 * deliberately outside this migration's scope (see PII_REMASK_DONE). Any throw leaves the state
 * pending; the caller warns and the next open retries.
 */
function scrubRemaskRemnants(driver: SqliteDriver, file: string, needles: string[]): void {
  driver.rebuildMemoryFts();
  driver.vacuum();
  driver.checkpointTruncate();
  const freePages = driver.freelistCount();
  if (freePages !== 0) {
    throw new Error(`${freePages} free pages remain after VACUUM — superseded bytes may survive`);
  }
  let walBytes = Buffer.alloc(0);
  try {
    walBytes = fs.readFileSync(`${file}-wal`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }
  if (walBytes.length > 0) {
    throw new Error(
      `the WAL still holds ${walBytes.length} bytes after the TRUNCATE checkpoint — plaintext page images may survive there`,
    );
  }
  if (needles.length > 0) {
    const preservedJournal = JSON.stringify(driver.allJournal().map((r) => r.payload));
    const active = needles.filter((n) => !preservedJournal.includes(n));
    const dbBytes = fs.readFileSync(file);
    for (const needle of active) {
      if (dbBytes.includes(Buffer.from(needle, 'utf8'))) {
        throw new Error(
          'replaced plaintext still present in the database bytes after the scrub — refusing to mark the migration complete',
        );
      }
    }
  }
}

/**
 * The first-run seal, read into the startup channel.
 *
 * A {@link SealResult} already separates the two halves of the operation, and the separation is the
 * whole point: `partial` means the DATABASE committed (the `journal_seal` entry and the meta
 * checkpoint are durable) while the checkpoint file outside it did not receive them. That is the
 * committed-unanchored state, not a failure — the store now holds an authenticated checkpoint
 * nothing off-database vouches for, every further write refuses, and re-running initialization
 * cannot redo it because the next open sees the meta checkpoint and does not seal again. The repair
 * is the file: clear whatever blocks it, then `sthayi journal reseal`.
 */
function sealStartup(sealed: SealResult): StartupOutcome {
  if (sealed.ok) {
    return { state: 'clean', step: 'first-run-seal' };
  }
  if (sealed.partial === true) {
    return {
      state: 'committed-unanchored',
      step: 'first-run-seal',
      message: [
        'DEGRADED: first-run initialization COMMITTED the journal seal into the database (the',
        '`journal_seal` entry and the store checkpoint are durable) but the off-database journal',
        'checkpoint file did NOT receive it.',
        'DO NOT RETRY — the database half is already durable, and initialization does not run again',
        'on a store that already holds a checkpoint.',
        'Further writes are BLOCKED until the anchor is repaired.',
        sealed.reason === undefined ? '' : `Cause: ${sealed.reason}`,
      ]
        .filter((s) => s !== '')
        .join(' '),
    };
  }
  return {
    state: 'refused',
    step: 'first-run-seal',
    reason: sealed.reason ?? 'the first-run seal was refused',
  };
}

/** The PII migration's `migrate_masking` append, read into the startup channel. Only a COMMITTED
 *  entry whose anchor did not advance blocks a front door; everything else is clean, because
 *  nothing else left the store unable to accept writes. */
function migrationStartup(outcome: MutationOutcome): StartupOutcome {
  const degraded = committedReceipts([outcome]).filter((r) => isDegradedReceipt(r));
  const receipt = degraded[0];
  if (receipt === undefined) {
    return { state: 'clean', step: 'pii-migration' };
  }
  return {
    state: 'committed-unanchored',
    step: 'pii-migration',
    message: describeReceipt(receipt),
    receipt,
  };
}

export function openStore(): OpenedStore {
  // HOME FIRST — nothing beneath it is inspected until it has been validated and its CANONICAL
  // root established. priorInstallEvidence() below probes three marker paths derived from
  // sthayiHomeRoot(); running it first would probe them through the LOGICAL home, i.e. through a
  // directory nothing has checked and that, in the hostile case, is about to be refused.
  // ensureSthayiHome creates the home directory and nothing else, so the evidence it is asked for
  // afterwards is exactly the evidence that was there before — and it still precedes the crypto
  // and store opens, which DO create markers.
  ensureSthayiHome();
  const markers = priorInstallEvidence();
  const driver = SqliteDriver.open(dbPath());
  driver.migrate();
  // THE MARKERS ARE READ FIRST AND THE CLAIM SECOND, and that order is the whole proof. A
  // bootstrapping peer records its claim BEFORE it creates the key file (below), so a key visible
  // at the marker probe was necessarily preceded by a claim — which this strictly later read
  // therefore cannot miss. It can only find that claim already retired, and retiring it requires
  // the checkpoint the peer committed, which is the state where prior-install evidence is not
  // consulted at all. So markers-plus-no-claim never describes a first run in flight; it describes
  // an installation that completed once and whose journal is now empty, which is erased history.
  const firstRun = firstRunState(driver);
  const priorInstall = markers && firstRun !== 'in-flight';
  const external = new FileCheckpoint(checkpointPath());
  // A store with no checkpoint, no claim and no prior-install evidence is a genuine first run and
  // this process is performing it: SAY SO BEFORE MINTING THE KEY. The claim is what lets a peer
  // that arrives mid-bootstrap read the key as this process's work in progress rather than as the
  // residue of an installation whose history is gone.
  const unsealed = driver.getMeta(JOURNAL_CHECKPOINT_KEY) === undefined;
  if (unsealed && firstRun === 'none' && !priorInstall) {
    driver.writeTransaction(() =>
      driver.setMeta(INSTALL_BOOTSTRAP_META_KEY, INSTALL_BOOTSTRAP_UNSETTLED),
    );
  }
  const crypto = NodeCrypto.open(keyPath());
  const vault = new VaultService(driver, crypto, { terms: [], now: () => Date.now() });
  const journal = new JournalService(driver, {
    crypto,
    external,
    masker: vault,
    warn: (m) => process.stderr.write(`sthayi: warning: ${m}\n`),
    priorInstall,
  });
  const assoc = new AssocService(driver);
  const memory = new MemoryService(driver, journal, vault, assoc);
  // First-run initialization ONLY: seal(onlyIfMissing) checkpoints a genuinely EMPTY store
  // (zero journal rows, no prior-install evidence, no surviving/unreadable external checkpoint)
  // exactly once — it re-checks for a checkpoint inside its write transaction, so racing
  // first-run processes seal exactly once. Everything else FAILS CLOSED: a rows-bearing store
  // with no authentic checkpoint (including a legitimate pre-checkpoint upgrade, which is
  // indistinguishable from a truncated or replaced database whose checkpoints were erased)
  // is never auto-sealed — verify() keeps failing with reseal guidance, and the explicit
  // `sthayi journal reseal` is the only trust decision that can bless it.
  //
  // THE SEAL IS A JOURNALED WRITE, so it settles into the typed startup channel like any other:
  // `ok` is a clean initialization, a plain refusal wrote nothing, and a PARTIAL seal is the
  // durable-but-unanchored state — the `journal_seal` entry and the meta checkpoint ARE in the
  // database while the file outside it is not, which blocks every further write and cannot be
  // undone by re-running initialization.
  const startup: StartupOutcome[] = [];
  // 'peer' unless this process itself performs the seal below: a store that already held a
  // checkpoint when we opened it was initialized by somebody else, and that somebody may still be
  // mirroring the anchor.
  let firstRunOutcome: FirstRunOutcome = 'peer';
  if (unsealed) {
    const sealed = journal.seal('migrate', Date.now(), { onlyIfMissing: true });
    startup.push(sealStartup(sealed));
    if (!sealed.ok && sealed.reason) {
      process.stderr.write(`sthayi: warning: ${sealed.reason}\n`);
    }
    // THREE READINGS, and `ok` alone tells only two of them apart. A seal that did not succeed —
    // refused outright, or committed while the file did not follow — is OUR attempt ending without
    // an anchor, and nothing is in flight afterwards. A seal that DID succeed either appended (its
    // `entries` count says so, and reporting ok required reading the checkpoint file back and
    // confirming it — exactly the proof the settled marker stands for) or found the store already
    // sealed by somebody else, whose mirror may still be on its way.
    firstRunOutcome =
      sealed.ok !== true ? 'unanchored' : sealed.entries === undefined ? 'peer' : 'anchored';
  }
  // Before anything journals — the PII migration below, and every command this store is opened
  // for — make sure a first run in flight has actually landed its off-database anchor.
  settleFirstRun(driver, external, firstRunOutcome);
  // Two-phase, retryable remask of a legacy unmasked store's plaintext PII (see remaskLegacyRows
  // and scrubRemaskRemnants). Phase 1 (rows + the single journal event + the pending state) is
  // one atomic transaction; phase 2 (scrub + verify) only flips the state to PII_REMASK_DONE
  // after EVERY step succeeded. On any phase-2 failure the state stays pending and every future
  // open retries — deliberately retry-forever, with a warning each time, rather than giving up:
  // the rows are already masked, and the pending state keeps the remnant-plaintext status
  // honestly detectable instead of silently marking the store clean.
  //
  // EVERYTHING here gates on PII_REMASK_META_KEY, the CURRENT (v2) key, READ THROUGH THE STATE
  // MACHINE (remaskState) — never on "is the key defined", which is what a hostile or corrupt
  // marker exploited: an UNKNOWN value skipped the row pass, live plaintext stayed in the
  // memory rows, and the final marker was stamped over it. Nothing reads the legacy key as
  // evidence either — a legacy build wrote its final value there on zero row changes alone, so
  // such a store may never have been physically scrubbed at all. Any state that is not this
  // key's 'rows-done' or 'scrubbed' therefore runs the row pass AND the physical scrub — EVEN IF
  // ZERO ROWS CHANGE, and whatever the legacy key says. Logical row values must never be read as
  // evidence about the file's bytes.
  //
  // There is NO bypass of phase 2 — not even for a store this process just created. The old
  // pre-open lstat() "freshness proof" was a check/open TOCTOU window, and a brand-new store is
  // zero rows and a handful of pages, so running the sequence unconditionally costs one cheap
  // VACUUM once in that store's life and removes the race outright.
  let scrubNeedles: string[] = [];
  if (remaskState(driver) === 'rows-pending') {
    const rows = remaskLegacyRows(driver, journal, vault);
    scrubNeedles = rows.needles;
    startup.push(migrationStartup(rows.outcome));
  }
  // Only the FINAL state stands the scrub down. 'rows-done', absent, unknown and corrupt all
  // scrub, which is the honest direction.
  if (remaskState(driver) !== 'scrubbed') {
    try {
      scrubRemaskRemnants(driver, dbPath(), scrubNeedles);
      driver.setMeta(PII_REMASK_META_KEY, PII_REMASK_DONE);
    } catch (err) {
      // The legacy marker is REPORTED, never trusted: a store carrying it is exactly the case
      // worth recognizing in the field, and this is the one place its value is read.
      const legacy = driver.getMeta(PII_REMASK_LEGACY_META_KEY);
      const legacyNote = legacy === undefined ? '' : `, ${PII_REMASK_LEGACY_META_KEY}=${legacy}`;
      process.stderr.write(
        `sthayi: warning: plaintext-remnant scrub incomplete (${
          err instanceof Error ? err.message : String(err)
        }${legacyNote}); memory rows are masked, but superseded plaintext bytes may remain inside ${dbPath()} — the scrub will retry on the next open\n`,
      );
    }
  }
  return {
    driver,
    journal,
    memory,
    vault,
    assoc,
    startup,
    close: () => driver.close(),
  };
}
