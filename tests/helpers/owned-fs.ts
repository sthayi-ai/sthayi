import fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * The identity primitives, the one bounded removal walk, and the SINGLE cleanup entry point every
 * test fixture is torn down through.
 *
 * WHY THIS MODULE EXISTS. `fs.rmSync(p, { recursive: true })` decides the whole recursion inside
 * the call, long after the caller's last check, from nothing but a PATHNAME. One directory swapped
 * in at that name — by a concurrent run, by a live `sthayi` process, by anything sharing this uid
 * and this temp root — converts a tidy teardown into the loss of a foreign tree. So no test hands a
 * pathname to a recursive primitive. Removal happens here, one entry at a time, with the authority
 * for each single syscall re-proved immediately before it.
 *
 * A PATHNAME IS NOT A CAPABILITY. lstat, device/inode, owner and mode all describe the inode a NAME
 * resolved to at one instant, and portable Node exposes no `openat`/`unlinkat`, so a check and the
 * operation it authorises are two acts, not one. The window is therefore not "closed" here and
 * nothing pretends it is. It is made NARROW and, above all, BOUNDED: `unlinkSync` removes the entry
 * and never follows a symlink to its target, `rmdirSync` refuses rather than descend, and every
 * mismatch aborts and leaves the remainder standing.
 *
 * IDENTITY IS RECORDED AT CREATION, NEVER INFERRED AT DELETION — AT EVERY DEPTH. A directory is
 * removable here only because the device/inode it had when this run CREATED it was written down
 * then. Reading an identity out of whatever currently occupies a name proves only that something
 * occupies the name — a replacement satisfies that test trivially, and it satisfies it just as
 * trivially four levels down as it does at the top. So the walk carries no authority of its own:
 * every directory it descends into must appear in the CREATION LEDGER below — under the parent it
 * was created in with the inode it had then, or, for a tree this run made and something outside
 * this process later renamed, by that same device/inode under whatever name it now answers to.
 * Anything else is refused.
 *
 * LEAKING BEATS DELETING SOMEONE ELSE'S DATA. Every refusal leaves the tree exactly where it is. A
 * stray temp directory is a nuisance a human deletes; a vault key belonging to a concurrent run is
 * not recoverable.
 */

/**
 * `lstat` as it was before anything in this process could reach it.
 *
 * BOOKKEEPING MUST BE INVISIBLE TO THE CODE UNDER TEST. Several suites count the syscalls a
 * production function makes against one path — "the mode came from the stat that validated the
 * file" is proved by there being exactly ONE look — and they count them by replacing `fs.lstatSync`.
 * A recorder that identified its entries through that same property would add looks the caller
 * never made, and turn a true invariant into a failing assertion.
 *
 * It is also the stricter binding for the job: a receipt describes what this run just did, and a
 * stand-in installed by a test cannot answer for it.
 */
const nativeLstat: typeof fs.lstatSync = fs.lstatSync;

/**
 * The descriptor primitives a receipt is minted from, bound the same way and for the same reasons.
 *
 * A receipt names the object a syscall of this run's actually changed, and it names it by asking the
 * DESCRIPTOR that syscall held. A stand-in installed by a test cannot answer for that, and neither
 * can one added by the code under test, so the three calls that turn a descriptor into an identity
 * are captured here before anything can reach them.
 */
const nativeOpen: typeof fs.openSync = fs.openSync;
const nativeFstat: typeof fs.fstatSync = fs.fstatSync;
const nativeFtruncate: typeof fs.ftruncateSync = fs.ftruncateSync;
const nativeClose: typeof fs.closeSync = fs.closeSync;

/**
 * The deterministic Windows umask owned by this disposable test process.
 *
 * Windows' CRT mask is process-local and has no safe getter. Establish zero once, before the test
 * modules can run, then track every setter. The restrictive-mask cases below deliberately change
 * it and restore it, so product behavior under a nonzero mask remains covered without an unsafe
 * read-modify-restore interval.
 */
const nativeUmask = process.umask.bind(process);

function normalizedUmask(mask: number | string): number {
  const parsed = typeof mask === 'string' ? Number.parseInt(mask, 8) : mask;
  return parsed & 0o777;
}

let observedWindowsUmask: number | null = null;

if (process.platform === 'win32') {
  nativeUmask(0);
  observedWindowsUmask = 0;
  (process as { umask: (mask?: number | string) => number }).umask = (
    mask?: number | string,
  ): number => {
    if (mask === undefined) {
      return nativeUmask();
    }
    const previous = nativeUmask(mask);
    observedWindowsUmask = normalizedUmask(mask);
    return previous;
  };
  // `import { umask } from 'node:process'` is a live built-in ESM binding. Synchronize it with the
  // patched CommonJS/default object so the supported named route cannot bypass the tracker.
  syncBuiltinESMExports();
}

/**
 * Identity-bearing stats are always collected in bigint mode. A regular `fs.Stats` rounds time
 * fields to a JavaScript number and does not expose `birthtimeNs`; taking a second stat merely to
 * recover it would describe a potentially different pathname occupant. These wrappers therefore
 * obtain shape, device/inode and the birth-time discriminator in one syscall.
 */
const nativeLstatBig = (p: fs.PathLike): fs.BigIntStats =>
  (nativeLstat as unknown as (path: fs.PathLike, opts: { bigint: true }) => fs.BigIntStats)(p, {
    bigint: true,
  });
const nativeFstatBig = (fd: number): fs.BigIntStats =>
  (nativeFstat as unknown as (descriptor: number, opts: { bigint: true }) => fs.BigIntStats)(fd, {
    bigint: true,
  });

/** Env var carrying the run root path. */
export const RUN_ROOT_ENV = 'STHAYI_TEST_RUN_ROOT';
/**
 * Env vars carrying the run root's EXPECTED IDENTITY, published independently of the directory.
 *
 * This separation is the point. Validating a root by reading a marker OUT OF that root proves only
 * that whatever now sits there carries a marker — a replacement can carry one too. The token and
 * the device/inode recorded at creation travel in the environment instead, so a directory swapped
 * in at the same pathname cannot satisfy them no matter what it contains.
 */
export const RUN_TOKEN_ENV = 'STHAYI_TEST_RUN_TOKEN';
export const RUN_IDENTITY_ENV = 'STHAYI_TEST_RUN_IDENTITY';

/** Marker file written inside the run root; its presence is a secondary check, never the proof. */
export const RUN_MARKER = '.sthayi-test-run';

/**
 * Ledger file inside the run root naming every fixture the run ALLOCATED, with the device/inode
 * each one had at allocation.
 *
 * Fixtures are allocated in vitest worker processes and the run root is torn down in the parent, so
 * the record has to survive a process boundary; the run root — private, owned by this uid, and
 * itself proved by an identity published in the environment — is where it lives. Its purpose is
 * narrow and it is never a permit on its own: teardown descends into a directory only when the name
 * appears here AND the inode standing at that name is the one recorded. A substitute inherits the
 * name and never the inode, so it is refused instead of walked.
 */
export const RUN_FIXTURES = '.sthayi-test-fixtures';

/**
 * Ledger file inside the run root recording every directory this run created INSIDE a fixture.
 *
 * The fixture ledger above answers "which children of the run root did this run allocate". It says
 * nothing whatever about what lives inside one, and a fixture's contents are exactly where the
 * interesting data is — a vault key, a store, a journal, four levels down. Authorising the top of a
 * tree does not authorise its descendants: a directory swapped in at `fixture/home` is a different
 * directory from the one the run made there, and the only thing that can tell them apart is a
 * record written when the run made it.
 *
 * So every directory this run creates beneath a fixture is recorded here, keyed by the identity of
 * the directory it was created IN plus its own name. Keying on the parent's inode rather than on a
 * pathname is what keeps the record true across a rename: moving a subtree changes the path of its
 * root and of nothing inside it, so only the moved entry needs re-recording (see the rename hook).
 */
export const RUN_DIRS = '.sthayi-test-dirs';

/**
 * One ephemeral test-run incarnation.
 *
 * `birthtimeNs` is an ABA discriminator for this cleanup harness, not a filesystem generation and
 * not a product security boundary. Node documents platform-specific precision and may report zero
 * (or a ctime substitute) where creation time is unavailable, so zero is never accepted as cleanup
 * authority. Product trust boundaries use retained descriptors instead.
 */
export interface Identity {
  /** Exact unsigned decimal: Windows file identifiers need not fit a JavaScript safe integer. */
  readonly dev: string;
  /** Exact unsigned decimal: never round a kernel identity through `number`. */
  readonly ino: string;
  readonly birthtimeNs: string;
}

/** Text-ledger grammar. Its decimal tokens were already lossless, so this format remains v2. */
export const IDENTITY_WIRE_VERSION = 'v2';

/**
 * Environment JSON grammar. v2 used JavaScript numbers for dev/ino and could round Windows file
 * identifiers before another process received them. v3 requires exact decimal strings; every v2
 * environment payload is legacy authority and is rejected rather than guessed at.
 */
const IDENTITY_ENV_VERSION = 3;

function exactStatDecimal(value: bigint): string | null {
  return value >= 0n ? value.toString(10) : null;
}

/** Capture an identity from the same bigint stat that inspected the object. */
export function identityFromBigStat(st: fs.BigIntStats): Identity | null {
  const dev = exactStatDecimal(st.dev);
  const ino = exactStatDecimal(st.ino);
  if (dev === null || ino === null || typeof st.birthtimeNs !== 'bigint' || st.birthtimeNs <= 0n) {
    return null;
  }
  return { dev, ino, birthtimeNs: st.birthtimeNs.toString(10) };
}

export function sameIdentity(a: Identity, b: Identity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
}

export function identityKey(id: Identity): string {
  return `${id.dev}:${id.ino}:${id.birthtimeNs}`;
}

function validIdentity(id: unknown): id is Identity {
  if (typeof id !== 'object' || id === null) {
    return false;
  }
  const candidate = id as Partial<Identity>;
  return (
    typeof candidate.dev === 'string' &&
    /^(0|[1-9][0-9]*)$/.test(candidate.dev) &&
    typeof candidate.ino === 'string' &&
    /^(0|[1-9][0-9]*)$/.test(candidate.ino) &&
    typeof candidate.birthtimeNs === 'string' &&
    /^[1-9][0-9]*$/.test(candidate.birthtimeNs)
  );
}

/** Versioned environment codec. Legacy `dev:ino` and numeric-v2 values confer no authority. */
export function encodeIdentity(id: Identity): string {
  if (!validIdentity(id)) {
    throw new Error('cannot encode an invalid test-run identity');
  }
  return JSON.stringify({
    v: IDENTITY_ENV_VERSION,
    dev: id.dev,
    ino: id.ino,
    birthtimeNs: id.birthtimeNs,
  });
}

export function decodeIdentity(raw: string | undefined): Identity | null {
  if (raw === undefined || raw === '') {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (record.v !== IDENTITY_ENV_VERSION) {
      return null;
    }
    const id = {
      dev: record.dev,
      ino: record.ino,
      birthtimeNs: record.birthtimeNs,
    };
    return validIdentity(id) ? id : null;
  } catch {
    return null;
  }
}

function identityFields(id: Identity): string {
  return `${id.dev} ${id.ino} ${id.birthtimeNs}`;
}

function identityFromFields(parts: readonly string[], at: number): Identity | null {
  const devText = parts[at];
  const inoText = parts[at + 1];
  const birthtimeNs = parts[at + 2];
  if (
    typeof devText !== 'string' ||
    typeof inoText !== 'string' ||
    typeof birthtimeNs !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(devText) ||
    !/^(0|[1-9][0-9]*)$/.test(inoText)
  ) {
    return null;
  }
  const id = { dev: devText, ino: inoText, birthtimeNs };
  return validIdentity(id) ? id : null;
}

/**
 * A run root holds vault keys, SQLite stores and journals. On POSIX it must be PRIVATE for its
 * whole life — not merely at the instant it was created — because any group- or world-accessible
 * bit lets a second account read those secrets, or plant entries that this run then treats as its
 * own fixtures. Mode is therefore re-asserted on every use and before every removal, never assumed
 * to be whatever `mkdir` was asked for.
 *
 * Windows does not expose POSIX permission bits through `fs.Stats`: Node reports a synthetic mode
 * (0666 on the GitHub runner) that says nothing about group/world access. Treating that value as a
 * POSIX policy makes the harness refuse every Windows run before collecting a test. The product's
 * filesystem policy has the same explicit platform boundary, so the harness skips only this
 * meaningless bit test there; its path, shape, receipt and cleanup checks still run.
 */
export function isPrivateMode(mode: number): boolean {
  return process.platform === 'win32' || (mode & 0o077) === 0;
}

/** Render a mode for a refusal message, e.g. 0777. */
export function describeMode(mode: number): string {
  return `0${(mode & 0o7777).toString(8)}`;
}

/** Whether this process owns the inode — the check is skipped only where uids do not exist. */
export function ownedByThisUid(st: fs.Stats | fs.BigIntStats): boolean {
  return typeof process.getuid !== 'function' || Number(st.uid) === process.getuid();
}

/** ENOENT means the entry is already gone; every other error means something is in the way. */
export function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
}

/**
 * Recursion ceiling for the removal walk. Fixture trees are shallow; a tree deep enough to reach
 * this is either pathological or adversarial, and stopping (leaking) is the correct response to
 * both.
 */
export const MAX_TREE_DEPTH = 64;

/**
 * Re-prove that `p` is STILL the exact directory identified by `id`.
 *
 * lstat, never stat: a symlink that appeared at this name reads as a mismatch instead of being
 * resolved to whatever it points at. Called immediately before every removal, so the name a removal
 * is about to act on is tied to the authorised inode as late as portable Node allows.
 */
export function proveDir(
  p: string,
  id: Identity,
  opts: { requirePrivate?: boolean } = {},
): fs.BigIntStats | null {
  let st: fs.BigIntStats;
  try {
    st = fs.lstatSync(p, { bigint: true });
  } catch {
    return null;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    return null;
  }
  const standing = identityFromBigStat(st);
  if (standing === null || !sameIdentity(standing, id)) {
    return null;
  }
  if (!ownedByThisUid(st)) {
    return null;
  }
  if (opts.requirePrivate === true && !isPrivateMode(Number(st.mode))) {
    return null;
  }
  return st;
}

// -------------------------------------------------------------------------------------------
// The creation ledger: which directory this run made, in which directory, under which name.
// -------------------------------------------------------------------------------------------

/**
 * A record's key: the identity of the directory a child was created IN, plus the child's name.
 *
 * Not a pathname. A pathname is what a substitution inherits for free, and it is also what a
 * rename invalidates for a whole subtree at once. The parent's inode plus one name survives both:
 * a replacement gets the name and never the parent-plus-inode pairing that was written down, and
 * moving a subtree changes the key of the moved entry alone.
 */
function dirKey(parent: Identity, name: string): string {
  return `${identityKey(parent)}/${name}`;
}

/**
 * PINNED records: the harness's own skeleton — a fixture, and the home cut from it.
 *
 * These are the directories cleanup exists to remove, and they are the exact names a hostile test
 * substitutes at. A pin is never OVERWRITTEN, by any process including this one: a second directory
 * standing at a pinned name is a substitution by definition, whoever made it, and it is refused
 * rather than walked.
 *
 * A pin ends in exactly one way — this run DESTROYS the directory it names, and witnesses itself
 * doing so (`rm`, `rmdir`; see `pinnedAt`). A suite that wipes its fake home and lets the code under
 * test rebuild one has genuinely vacated the name and there is nothing left to protect. A `rename`
 * never ends a pin, and that asymmetry is the whole point: moving the directory aside leaves it
 * intact somewhere else, which is what a substitution needs and what a destructive teardown never
 * does.
 */
const pinnedDirs = new Map<string, Identity>();

/**
 * CREATED records: everything else this run makes inside a fixture, recorded at the call that made
 * it.
 *
 * Fixture contents churn — a store is written, a fake home is wiped and rebuilt, a bin directory is
 * removed and made again — and each of those is a fresh `mkdir` at a name the run has just vacated. A
 * record here therefore describes the LATEST directory this run made at the name: a name cannot be
 * created over while it is occupied (`mkdir` fails with EEXIST), so the only way a second record
 * ever arrives is that this run itself removed or moved the first one away.
 *
 * That is exactly why a peer's substitution cannot launder itself through this map. A peer's
 * `rename` and `mkdir` happen in ITS process, with ITS `fs`, which nothing here witnesses; the
 * record keeps naming the directory this run made, the inode standing at the name is a different
 * one, and the walk refuses. What this map does NOT distinguish is a substitution performed by THIS
 * process, which is indistinguishable from ordinary churn from the inside — and that is what pinned
 * records above are for: the fixture and the home a test attacks are pinned, so no creation at those
 * names is ever adopted, whoever makes it.
 */
const createdDirs = new Map<string, Identity>();

/**
 * Every device/inode this run has been recorded creating, WITHOUT the name it was created under.
 *
 * A directory can acquire a name this run never wrote down: `mv ~/.sthayi ~/.sthayi.backup.$(date)`
 * out of the documentation, run by `sh`, moves a tree this run made to a name no wrapper here can
 * witness. Refusing it would leak the fixture; entering it because a directory is sitting there
 * would be the teardown-time inference this module exists to refuse.
 *
 * The device/inode settles it. An inode identifies one directory on one filesystem, so "this run
 * created the directory that is standing here" is a statement about the record written at creation,
 * not about the name it now answers to — a foreign tree moved in has an inode this run never made
 * and is refused exactly as before. The name records above stay the stricter test and are consulted
 * FIRST: a name this run created that now holds a different directory aborts, even when that other
 * directory is also one of ours.
 *
 * Inodes are dropped as the walk removes the directories that hold them, so a number the kernel
 * later recycles cannot go on authorising anything.
 */
const createdInodes = new Set<string>();

function inodeKey(id: Identity): string {
  return identityKey(id);
}

/**
 * ENTRY RECEIPTS: every single named entry this run has created or altered, keyed by the directory
 * it sits in and the one name it answers to.
 *
 * WHY A CREATION RECORD IS NOT ENOUGH, AND CANNOT BE MADE ENOUGH. `mkdirSync` is exclusive, so when
 * it returns this process did make an inode at that name — but it returns no descriptor, and
 * portable Node has no `mkdirat`. The identity has to be fetched by looking the NAME up again, and
 * in the interval a same-uid peer can destroy what we made and stand its own EMPTY directory at the
 * name. Empty is exactly the shape `mkdir` produces, so it satisfies every leg of the freshness
 * proof — directory, our uid, link count 2, empty listing — and no check performed afterwards can
 * separate the two. That is not a gap to be narrowed; it is the whole class of post-hoc
 * identification, and this module states it rather than papering over it.
 *
 * WHAT FOLLOWS FROM THAT. A creation record may name a directory this run did not make. So a
 * creation record buys exactly what it proves and no more: THE RIGHT TO REMOVE THE DIRECTORY IT
 * NAMES, once that directory is empty. It buys no right whatever to remove what is INSIDE, because
 * the contents arrived after the record was written and the record says nothing about them.
 *
 * AND NO DIRECTORY-WIDE PERMISSION CAN SUPPLY THE REST. "This run wrote something inside this
 * directory" is a true statement about the run and an empty one about the directory's contents: it
 * describes one act on one entry and is then spent on every other entry that happens to be sitting
 * there — including the ones a peer put there before, during or after the write. Whatever such a
 * permission is called, its shape is "the run used this place, therefore this place may be
 * emptied", and that is trusting a pathname with an extra step. The peer's data is not the run's to
 * remove, and one write by the run does not make it so.
 *
 * SO THE AUTHORITY IS THE ENTRY ITSELF, AND IT COMES FROM A DESCRIPTOR. An entry is removable only
 * if this run holds a RECEIPT for it, and a receipt is minted from the OBJECT THE SYSCALL ACTUALLY
 * CHANGED — `fstat` on the descriptor the write was performed through — never from a look-up of the
 * pathname afterwards.
 *
 * WHY THE DISTINCTION IS THE WHOLE POINT. A write returns, and the name it was addressed to is then
 * resolved a second time to find out what was written. Between those two acts a same-uid peer can
 * unlink what this run made and put its OWN file, with its own inode and its own bytes, at the name.
 * A receipt taken from that second look-up names the peer's file, and the peer's file is then
 * removable — the run destroys data it never wrote a byte of. The descriptor cannot be moved: it
 * refers to the object the bytes went into for as long as it is open, whatever happens to the name.
 *
 * WHERE NO DESCRIPTOR EXISTS, NOTHING IS CLAIMED. `symlink()` returns no handle and portable Node
 * cannot open a symlink, so a symlink's receipt is the one that cannot be descriptor-bound. It is
 * therefore narrowed instead of faked: the receipt records THE KIND as well as the identity, and it
 * authorises removing a SYMLINK and nothing else. Every object that can hold bytes — a regular file,
 * a directory, a device node, a fifo — fails that check outright, so a peer's DATA is never
 * removable on one. What remains removable is a symlink standing at the name with the recorded
 * inode, which is a name and not a byte of anyone's content. Entry points that hand over no
 * descriptor and name no kind claim nothing at all, and the entries they leave behind are refused at
 * teardown and leak.
 *
 * RECEIPTS COVER NON-DIRECTORIES ONLY. A directory is authorised by the record its CREATION wrote,
 * which is a stronger statement than "something named this path": the creation record is checked
 * against the shape a fresh `mkdir` produces. Letting a later `chmod` or `utimes` mint a directory
 * receipt would hand a walk an entrance the creation proof had already refused.
 *
 * WHAT A RECEIPT STILL DOES NOT PROVE, STATED PLAINLY. It proves the run changed that object and
 * that the call succeeded. A peer that pre-positions a file at a name the run itself then opens for
 * writing gets a receipt for THAT ONE OBJECT, and that one object is removable — the run truncated
 * it on purpose. The residual is exactly one entry the run has already overwritten — never a
 * directory, never a tree, and never an entry the run has not written into.
 *
 * Receipts are dropped with the entries and the directories that hold them: an inode number returns
 * to the kernel when its object does, and a receipt left behind would vouch for whatever inherits
 * the number.
 */
interface EntryReceipt extends Identity {
  /** The kind the run's own call produced; a receipt never authorises removing any other kind. */
  readonly link: boolean;
}

const entryReceipts = new Map<string, Map<string, EntryReceipt>>();

/** The receipts this run holds for entries of the directory `id` names. */
function receiptsIn(id: Identity): Map<string, EntryReceipt> | undefined {
  return entryReceipts.get(inodeKey(id));
}

/** The receipt this run holds for one entry of one directory, or `undefined` when it holds none. */
export function entryReceipt(parent: Identity, name: string): EntryReceipt | undefined {
  return receiptsIn(parent)?.get(name);
}

/**
 * Whether the entry standing at `name` inside the directory `parent` names is one this run may
 * remove: same inode, and the same KIND the run's own call produced.
 *
 * The kind check is what keeps the one receipt that cannot be descriptor-bound — a symlink's — from
 * ever authorising the removal of something that holds bytes.
 */
export function receiptAuthorises(parent: Identity, name: string, st: fs.BigIntStats): boolean {
  const held = receiptsIn(parent)?.get(name);
  const standing = identityFromBigStat(st);
  return (
    held !== undefined &&
    standing !== null &&
    sameIdentity(held, standing) &&
    held.link === st.isSymbolicLink()
  );
}

/**
 * Take a receipt in memory, and report whether anything changed.
 *
 * `false` means the run already held this exact receipt, which is what stops the ledger append
 * below from recursing: persisting a receipt is itself a write, and the file it writes to is an
 * entry that wants a receipt of its own.
 */
function applyEntryReceipt(parent: Identity, name: string, id: EntryReceipt): boolean {
  const key = inodeKey(parent);
  let byName = entryReceipts.get(key);
  if (byName === undefined) {
    byName = new Map<string, EntryReceipt>();
    entryReceipts.set(key, byName);
  }
  const held = byName.get(name);
  if (held !== undefined && sameIdentity(held, id) && held.link === id.link) {
    return false;
  }
  byName.set(name, id);
  return true;
}

/** Forget every receipt for entries of a directory that no longer exists. */
function forgetReceiptsIn(id: Identity): void {
  entryReceipts.delete(inodeKey(id));
}

/** Forget one receipt, and only when it still names the object being retired. */
function forgetEntryReceipt(parent: Identity, name: string, id: Identity): void {
  const byName = entryReceipts.get(inodeKey(parent));
  const held = byName?.get(name);
  if (byName !== undefined && held !== undefined && sameIdentity(held, id)) {
    byName.delete(name);
  }
}

/** The directory an entry sits in, and the one name it answers to, or `null` when there is none. */
function entrySlot(target: string): { parent: Identity; name: string } | null {
  const name = path.basename(target);
  if (name === '' || name === '.' || name === '..') {
    return null;
  }
  const parentPath = path.dirname(target);
  if (parentPath === target) {
    return null;
  }
  let parentStat: fs.BigIntStats;
  try {
    parentStat = nativeLstatBig(parentPath);
  } catch {
    return null;
  }
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    return null;
  }
  const parent = identityFromBigStat(parentStat);
  return parent === null ? null : { parent, name };
}

/**
 * The identity of an entry and of the directory it sits in, read together.
 *
 * Used where the question is "which object is standing at this name", never to MINT authority over
 * one: a removal reads it to find out which receipt it is about to invalidate, and that answer is
 * then checked against a receipt this run already held.
 *
 * `null` whenever either is unreadable, the parent is not a real directory, or the entry is a
 * directory — directories carry creation records instead, and are never given a receipt here.
 */
function identifyEntry(
  target: string,
): { parent: Identity; name: string; id: Identity; link: boolean } | null {
  const slot = entrySlot(target);
  if (slot === null) {
    return null;
  }
  let st: fs.BigIntStats;
  try {
    st = nativeLstatBig(target);
  } catch {
    return null;
  }
  if (st.isDirectory() && !st.isSymbolicLink()) {
    return null;
  }
  const id = identityFromBigStat(st);
  if (id === null) {
    return null;
  }
  return {
    parent: slot.parent,
    name: slot.name,
    id,
    link: st.isSymbolicLink(),
  };
}

/**
 * The same answer, for a path THAT MAY BE RELATIVE, read through the spelling as given.
 *
 * `fs` resolves a relative argument against the directory the process is IN, which is not always the
 * directory the remembered path names: renaming that directory, or planting a symlink at the name it
 * used to answer to, separates the two. Every look-up here therefore goes through the same string
 * the syscall did, so what gets identified is what the syscall touched.
 */
function identifyGiven(
  given: unknown,
): { parent: Identity; name: string; id: Identity; link: boolean } | null {
  return typeof given === 'string' ? identifyEntry(given) : null;
}

/**
 * Write down a receipt this run has already established, in memory and in the ledger.
 *
 * Persisted because ownership, like creation, has to cross a process boundary: fixtures are filled
 * in vitest workers and in the `sthayi` children they spawn, and the run root is swept in a parent
 * that witnessed none of it. A receipt the sweep cannot see makes it REFUSE — the safe direction —
 * so the cost of a lost line is a leaked fixture.
 */
function keepEntryReceipt(target: string, parent: Identity, name: string, id: EntryReceipt): void {
  if (!applyEntryReceipt(parent, name, id)) {
    return; // already held: nothing new to persist, and nothing to recurse on
  }
  if (recordable(target)) {
    appendDirLedger(
      `${id.link ? 'L' : 'F'} ${IDENTITY_WIRE_VERSION} ${identityFields(id)} ${identityFields(parent)} ${name}\n`,
    );
  }
}

/**
 * Take a receipt for THE OBJECT A DESCRIPTOR NAMES, filed under the name it was reached by.
 *
 * This is the only way a receipt for something that holds bytes is ever created. `fstat` answers
 * about the open object and about nothing else, so the identity that gets written down is the one
 * the write went into — not the one a second resolution of the pathname turns up, which is a
 * different question with a different and attacker-controlled answer.
 *
 * The directory the entry is filed under is read by name, and that is sound because it decides only
 * WHERE the receipt is filed: a receipt filed under a directory the walk never proves is a receipt
 * the walk never consults, so a wrong answer there costs a refusal and never a removal.
 *
 * CALLED ONLY ONCE THE MUTATION HAS SUCCEEDED. A call that raises wrote nothing, so there is nothing
 * to hold a receipt for; taking one first would record a mutation the operation then refuses to
 * perform, and hand a teardown authority over whatever else is standing at that name.
 */
function receiptFromFd(fd: number, target: string | null): void {
  if (target === null) {
    return;
  }
  const slot = entrySlot(target);
  if (slot === null) {
    return;
  }
  let st: fs.BigIntStats;
  try {
    st = nativeFstatBig(fd);
  } catch {
    return;
  }
  if (st.isDirectory()) {
    return; // directories are authorised by their creation record, never by a receipt
  }
  const id = identityFromBigStat(st);
  if (id !== null) {
    keepEntryReceipt(target, slot.parent, slot.name, { ...id, link: false });
  }
}

/**
 * Open the object at `target` for the sole purpose of naming it, refusing to follow a link and
 * refusing to WAIT.
 *
 * `O_NONBLOCK` is not an optimisation. A fixture may hold entries that are not files at all — a
 * fifo stood up by an external tool is one of the shapes this harness deliberately exercises — and
 * opening a fifo for reading BLOCKS until somebody opens the other end. A bookkeeping call must
 * never be able to stop the program it is bookkeeping for; on anything that would have waited, the
 * open fails, no receipt is taken, and the entry is left standing.
 *
 * `null` is the refusal, and a refusal simply means no receipt is taken. Every caller treats that
 * as "unclaimed", which makes teardown leave the entry standing.
 */
function openForIdentity(target: string, flags: number): number | null {
  try {
    return nativeOpen(target, flags | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch {
    return null;
  }
}

/** Run `body` with a descriptor held on `target`, and always give the descriptor back. */
function withDescriptor<T>(fd: number, body: () => T): T {
  try {
    return body();
  } finally {
    try {
      nativeClose(fd);
    } catch {
      // the descriptor outlives nothing that matters
    }
  }
}

/**
 * Take the one receipt that cannot be descriptor-bound: a symlink this run's `symlinkSync` created.
 *
 * `symlink()` hands back no descriptor and portable Node cannot open a symlink, so the identity has
 * to be read from the name. That is stated rather than dressed up, and the receipt is narrowed to
 * match what it can honestly support: it records THE KIND, and it authorises removing a symlink and
 * nothing else. An object holding bytes standing at the name — which is what a peer substitutes to
 * protect its own data — fails the kind check and is never removable on it.
 */
function receiptForCreatedSymlink(target: string | null): void {
  if (target === null) {
    return;
  }
  const found = identifyEntry(target);
  if (found === null || !found.link) {
    return; // not a symlink any more: nothing this call produced, so nothing to claim
  }
  keepEntryReceipt(target, found.parent, found.name, { ...found.id, link: true });
}

/** A receipt a removal is about to invalidate, read while the entry it describes still exists. */
interface DoomedEntry {
  readonly parent: Identity;
  readonly name: string;
  readonly id: Identity;
  readonly recordable: boolean;
}

/** The receipt standing behind `target`, or `null` when this run holds none for it. */
function doomedEntry(target: string | null): DoomedEntry | null {
  if (target === null) {
    return null;
  }
  const found = identifyEntry(target);
  if (found === null) {
    return null;
  }
  const held = receiptsIn(found.parent)?.get(found.name);
  if (held === undefined || !sameIdentity(held, found.id) || held.link !== found.link) {
    return null;
  }
  // Where the record is KEPT is a question about the run's own bookkeeping, so the reconstructed
  // absolute form answers it; which object is being retired was already settled above, through the
  // spelling the syscall used.
  const absolute = absolutePath(target);
  return {
    parent: found.parent,
    name: found.name,
    id: found.id,
    recordable: absolute !== null && recordable(absolute),
  };
}

/** The same answer, for a path that may be relative; see {@link identifyGiven}. */
function doomedEntryAt(given: unknown): DoomedEntry | null {
  return typeof given === 'string' ? doomedEntry(given) : null;
}

/** Retire a receipt for an entry a removal really did take away; leave a survivor's alone. */
function retireEntryReceiptAt(doomed: DoomedEntry, given: unknown): void {
  if (typeof given === 'string') {
    retireEntryReceipt(doomed, given);
  }
}

/** Retire a receipt for an entry a removal really did take away; leave a survivor's alone. */
function retireEntryReceipt(doomed: DoomedEntry, target: string): void {
  if (nativeLstat(target, { throwIfNoEntry: false }) !== undefined) {
    return; // still standing, so the receipt still describes something
  }
  forgetEntryReceipt(doomed.parent, doomed.name, doomed.id);
  if (doomed.recordable) {
    appendDirLedger(
      `- ${IDENTITY_WIRE_VERSION} ${identityFields(doomed.id)} ${identityFields(doomed.parent)} ${doomed.name}\n`,
    );
  }
}

/**
 * Declare that this run has handed ONE NAMED ENTRY to a program whose syscalls NOTHING HERE CAN SEE.
 *
 * `execFileSync('mkfifo', [key])`, a stub `npm` written in shell, any external binary: the run
 * asked for that exact path to be filled, and the program filled it without touching a single
 * JavaScript `fs` binding. No wrapper fires, no receipt is taken, and teardown refuses to remove it
 * — leaking the fixture, and the run root with it.
 *
 * Witnessing the invocation instead is not available: every caller reaches `child_process` through
 * a DESTRUCTURED import, which binds the original function at module evaluation, so a wrapper
 * installed here would never be reached. So the declaration is made explicitly, AT THE CALL SITE:
 * the claim stands in the source beside the invocation that produced it, naming the single entry it
 * covers and the program that filled it.
 *
 * ITS AUTHORITY IS THE DECLARATION, NOT A DESCRIPTOR. The bytes were written by another program, so
 * there is no descriptor of this run's to bind to; the identity is read through an `O_NOFOLLOW`
 * open, so a symlink standing at the name is refused outright and the identity that gets recorded
 * belongs to an object rather than to a name.
 *
 * IT NAMES ONE ENTRY AND NEVER A DIRECTORY'S FUTURE CONTENTS. That is the whole difference between
 * this and a blanket permission: it cannot be spent on anything the caller did not write down, and
 * it is refused outright for a directory, which is authorised by its creation record instead.
 */
export function claimToolEntry(entry: string): void {
  const target = path.resolve(entry);
  const fd = openForIdentity(target, fs.constants.O_RDONLY);
  if (fd === null) {
    return;
  }
  withDescriptor(fd, () => receiptFromFd(fd, target));
}

/** The recorded identity for a name, or `undefined` when this run never created one there. */
function dirRecord(parent: Identity, name: string): Identity | undefined {
  const key = dirKey(parent, name);
  return pinnedDirs.get(key) ?? createdDirs.get(key);
}

/** Whether this run recorded creating the exact directory `id` names, under any name. */
function createdThisRun(id: Identity): boolean {
  return createdInodes.has(inodeKey(id));
}

function applyPin(key: string, id: Identity): void {
  createdInodes.add(inodeKey(id));
  if (!pinnedDirs.has(key)) {
    pinnedDirs.set(key, id);
  }
}

function applyCreate(key: string, id: Identity): void {
  createdInodes.add(inodeKey(id));
  if (!pinnedDirs.has(key)) {
    createdDirs.set(key, id);
  }
}

/**
 * Retire every record for a directory this run has DESTROYED.
 *
 * Two reasons, and both matter. A pin says "the harness's own skeleton lives at this name"; once the
 * run has destroyed that directory the name is genuinely vacant and holding the pin would refuse the
 * replacement the run itself builds. And an inode number goes back to the kernel with the directory
 * that held it — a `created` record left behind would go on vouching for whatever inherits the
 * number, which is authority granted to a directory this run never made.
 *
 * Guarded on identity in both maps: a vacate line that does not name the directory currently
 * recorded changes nothing, so a stale or replayed line cannot retire a live record.
 */
/**
 * Release the NAME a directory has MOVED AWAY FROM, and nothing else.
 *
 * A rename ends one fact and only one: that this name holds that directory. The directory itself is
 * intact somewhere else, so the two things a destruction retires must survive here — the inode is
 * still one this run created, and the receipts for the entries inside it are still keyed by that
 * inode, which the move did not change. Retiring those as well would leave the run unable to remove
 * its own tree at the name it just moved it to, and the fixture would leak.
 *
 * WHY THE NAME CANNOT KEEP THE RECORD. The record is spent by ENTERING whatever answers to the name.
 * Once the directory has gone the name is vacant, and the next thing to occupy it was made by
 * somebody else — a concurrent run, a peer, a `sthayi` process — or by the kernel handing the inode
 * number on after the directory is later removed at its new name. Either way the record would be
 * vouching for something this run never made.
 *
 * A PIN IS NOT RELEASED BY A MOVE, and that asymmetry is deliberate: a pin says the harness's own
 * skeleton lives at this name, and a tree stood up at a pinned name is a substitution whoever put it
 * there. Moving the pinned directory aside is exactly what a substitution needs; destroying it is
 * what an honest teardown does, and only destruction ends a pin (see {@link applyVacate}).
 */
function applyMoved(key: string, id: Identity): void {
  const created = createdDirs.get(key);
  if (created !== undefined && sameIdentity(created, id)) {
    createdDirs.delete(key);
  }
}

function applyVacate(parent: Identity, name: string, id: Identity): void {
  const key = dirKey(parent, name);
  const pinned = pinnedDirs.get(key);
  if (pinned !== undefined && sameIdentity(pinned, id)) {
    pinnedDirs.delete(key);
    createdInodes.delete(inodeKey(id));
    forgetReceiptsIn(id);
  }
  const created = createdDirs.get(key);
  if (created !== undefined && sameIdentity(created, id)) {
    createdDirs.delete(key);
    createdInodes.delete(inodeKey(id));
    forgetReceiptsIn(id);
  }
  // The same line retires a receipt for a non-directory entry, which is keyed the same way. Parent
  // and name travel separately: reparsing a composite key would couple authority to its encoding.
  forgetEntryReceipt(parent, name, id);
}

/**
 * Where the ledger is persisted, or `null` when no run root is published.
 *
 * Fixtures are created in vitest WORKER processes and the run root is swept in the parent, so a
 * record kept only in the process that made it would be invisible to the sweep — and an invisible
 * record means an unauthorised descendant, which means the sweep refuses and the root leaks. The
 * file therefore lives in the run root, which is private, owned by this uid, and itself proved by
 * an identity published in the environment.
 */
/**
 * Drop EVERY record this process holds, on word that a removal destroyed more than it counted.
 *
 * The records are keyed by identity, not by path, so there is no subset of them that corresponds to
 * "the tree that went". A holding that may describe destroyed directories is a holding that may
 * authorise walking into whatever inherits their inode numbers, and the only honest answer to "which
 * ones" — when the process that destroyed them could not say — is all of them.
 *
 * The cost is that every removal afterwards refuses for want of a record, and the fixtures leak.
 * That is the safe direction, and it is the one this module takes everywhere else.
 */
/**
 * Retire EVERYTHING THAT DESCRIBES ONE DESTROYED DIRECTORY, keyed by the directory itself.
 *
 * `applyVacate` retires the record standing at ONE NAME, which is the right rule when the name is
 * how the loss was observed. It is the wrong rule when a directory was destroyed at a name it was
 * never recorded under. A directory created as `made` and carried to `dst` by a program no wrapper
 * here witnesses is still recorded as `made`; a `rename` onto `dst` then destroys it, and a
 * retirement aimed at `dst` matches nothing. The `made` record survives, the inode number returns to
 * the kernel, and the next directory to receive that number is walked into as one this run created.
 *
 * So the unit of destruction is the IDENTITY. Every created-name mapping that resolves to it goes —
 * under every name, pinned or not — together with the inode authority that vouches for it under no
 * name at all, the receipts for the entries it held, and the creation receipt keyed by the pathname
 * it was made at. Nothing here is guarded on a key, because the key is precisely what a hidden move
 * makes unreliable; what guards it is that the caller WATCHED the destruction.
 *
 * A directory that is merely MOVED must never be put through this: it still exists, and everything
 * except the name it left still describes it. See {@link applyMoved}.
 */
function applyDestroyedIdentity(id: Identity): void {
  const gone = inodeKey(id);
  for (const [key, held] of pinnedDirs) {
    if (inodeKey(held) === gone) {
      pinnedDirs.delete(key);
    }
  }
  for (const [key, held] of createdDirs) {
    if (inodeKey(held) === gone) {
      createdDirs.delete(key);
    }
  }
  for (const [p, held] of creationReceipts) {
    if (inodeKey(held) === gone) {
      creationReceipts.delete(p);
    }
  }
  createdInodes.delete(gone);
  forgetReceiptsIn(id);
}

function applyPoison(): void {
  pinnedDirs.clear();
  createdDirs.clear();
  createdInodes.clear();
  entryReceipts.clear();
  creationReceipts.clear();
}

function dirLedgerPath(): string | null {
  const root = process.env[RUN_ROOT_ENV];
  return root === undefined || root === '' ? null : path.join(root, RUN_DIRS);
}

/**
 * How far into each ledger file this process has already read.
 *
 * Per file, not one number: a suite that drives setup()/teardown() by hand runs several simulated
 * runs inside one process, each with its own root and its own ledger, and a shared offset would
 * apply one file's byte count to another's.
 *
 * Appends do NOT advance it. Re-reading a line this process wrote costs one map lookup and changes
 * nothing — a pin is written once, a creation is first-write-wins, and a retirement removes a key
 * that is already gone — whereas guessing at byte counts while other workers append to the same
 * file would silently skip THEIR records.
 */
const dirLedgerOffsets = new Map<string, number>();

/**
 * Depth of removal walks in progress. A walk only ever REMOVES, so the sole record it could produce
 * is the release of a pin it has just taken away — and writing that release would recreate the
 * ledger file inside the very root the walk has already emptied, leaving it non-empty and leaking
 * it. The release still happens in memory, where the walk needs it; nothing outside this process
 * needs to be told about a directory that no longer exists.
 */
let walking = 0;

/** Run a removal with ledger PERSISTENCE stood down. In-memory records are untouched. */
export function duringWalk<T>(body: () => T): T {
  walking += 1;
  try {
    return body();
  } finally {
    walking -= 1;
  }
}

function appendDirLedger(line: string): void {
  if (walking > 0) {
    return;
  }
  const file = dirLedgerPath();
  if (file === null) {
    return; // no run root: the records live in this process, which is also where they are used
  }
  // The ledger is written THROUGH the run-root pathname, so the identity published at creation is
  // re-proved first. Without that, a run root that has been substituted would quietly receive this
  // run's bookkeeping — writing into a stranger's tree, and publishing to it what this run has made.
  const root = publishedRunRoot();
  if (root === null || proveDir(root.path, root.id) === null) {
    return; // in memory only; a record the sweep cannot see makes it refuse, never adopt
  }
  try {
    // One `open(O_APPEND|O_CREAT|O_WRONLY)` plus one small write, which concurrent workers can
    // interleave without tearing each other's lines.
    fs.appendFileSync(file, line, { mode: 0o600 });
  } catch {
    // The record stays in memory. A record this process cannot persist is one the sweep will not
    // see, and an unseen record makes the sweep REFUSE — the safe direction.
  }
}

function applyDirLedgerLine(line: string): void {
  // `<op> v2 <dev> <ino> <birth> <parentDev> <parentIno> <parentBirth> <name>`.
  // Name is last because it may contain spaces. Legacy pair-only lines grant no authority.
  const parts = line.split(' ');
  if (line === '') {
    return;
  }
  if (parts[0] === 'X') {
    if (parts.length === 3 && parts[1] === IDENTITY_WIRE_VERSION && parts[2] === 'poisoned') {
      applyPoison();
    } else {
      applyPoison();
    }
    return;
  }
  if (parts.length < 9 || parts[1] !== IDENTITY_WIRE_VERSION) {
    applyPoison(); // a malformed history may hide a retirement, so no older authority survives it
    return;
  }
  const op = parts[0] as string;
  const id = identityFromFields(parts, 2);
  const parent = identityFromFields(parts, 5);
  const name = parts.slice(8).join(' ');
  if (id === null || parent === null) {
    applyPoison();
    return;
  }
  // A record names one ENTRY of one directory. Anything with a separator in it describes a path
  // instead, and a path is exactly what must never decide a removal here.
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    applyPoison();
    return;
  }
  const key = dirKey(parent, name);
  if (op === 'A') {
    applyPin(key, id);
  } else if (op === '+') {
    applyCreate(key, id);
  } else if (op === 'F' || op === 'L') {
    // One named entry of one directory, with the inode of the object this run changed and the KIND
    // its own call produced — `F` for something holding bytes, `L` for a symlink. Keyed exactly as a
    // directory record is, so a removal retires either with the same `-` line.
    applyEntryReceipt(parent, name, {
      ...id,
      link: op === 'L',
    });
  } else if (op === 'M') {
    // The name a directory was MOVED away from. Distinct from `-` because the directory still
    // exists: only the name-to-identity record goes, while the inode record and the receipts for
    // everything inside it — none of which the move touched — stay exactly as they are.
    applyMoved(key, id);
  } else if (op === '-') {
    applyVacate(parent, name, id);
  } else if (op === 'D') {
    // A directory this run WATCHED BEING DESTROYED, named by its identity rather than by the key it
    // answered to. The parent and name are carried for readability and for the one-entry retirement
    // below; the destruction itself is applied to the identity, so a record written under an older
    // name — a directory moved by a program no wrapper witnessed — is retired by this line too.
    //
    // Ordering does the rest: the ledger is a history replayed in order, so a `+` line written after
    // this one, for a directory that later received the same inode number, restores authority for
    // THAT directory and not for the one this line buried.
    applyVacate(parent, name, id);
    applyDestroyedIdentity(id);
  } else {
    applyPoison();
  }
}

/**
 * Take in whatever other processes have appended since the last read.
 *
 * Called once at the start of a removal, never per directory: the ledger only ever grows, and the
 * records that matter for a tree were written before anything started removing it.
 */
export function syncDirLedger(rootCanonical?: string): void {
  const file = rootCanonical === undefined ? dirLedgerPath() : path.join(rootCanonical, RUN_DIRS);
  if (file === null) {
    return;
  }
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return; // absent ledger registers nothing, which makes the walk refuse rather than adopt
  }
  try {
    const from = dirLedgerOffsets.get(file) ?? 0;
    const size = fs.fstatSync(fd).size;
    if (size <= from) {
      return;
    }
    const buf = Buffer.alloc(size - from);
    const read = fs.readSync(fd, buf, 0, buf.length, from);
    const text = buf.subarray(0, read).toString('utf8');
    const lastBreak = text.lastIndexOf('\n');
    if (lastBreak < 0) {
      return; // only a partial line so far — leave it for the next read
    }
    for (const line of text.slice(0, lastBreak).split('\n')) {
      applyDirLedgerLine(line);
    }
    dirLedgerOffsets.set(file, from + Buffer.byteLength(text.slice(0, lastBreak + 1)));
  } catch {
    // unreadable: registers nothing, so the walk refuses rather than adopts
  } finally {
    fs.closeSync(fd);
  }
}

/** The identity of a directory and of the directory it sits in, or `null` if either is unreadable. */
function identifyWithParent(dir: string): { id: Identity; parent: Identity; name: string } | null {
  const name = path.basename(dir);
  if (name === '' || name === '.' || name === '..') {
    return null;
  }
  try {
    const st = fs.lstatSync(dir, { bigint: true });
    const parentStat = fs.lstatSync(path.dirname(dir), { bigint: true });
    if (st.isSymbolicLink() || !st.isDirectory() || !parentStat.isDirectory()) {
      return null;
    }
    const id = identityFromBigStat(st);
    const parent = identityFromBigStat(parentStat);
    if (id === null || parent === null) {
      return null;
    }
    return {
      id,
      parent,
      name,
    };
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------------------------------
// Capturing an identity AT the operation that creates a directory.
// -------------------------------------------------------------------------------------------

/**
 * THE ONE PLACE AN IDENTITY IS EVER MINTED, and the reason nothing else may mint one.
 *
 * Reading `lstat` off a pathname after a creating syscall answers "what occupies this name NOW",
 * and a peer that moves the created directory aside and stands its own tree at the name answers it
 * just as well. Recording that answer is how a foreign tree becomes "run-created" — and once it is
 * run-created, teardown walks into it. Every recorder below therefore takes an identity that was
 * CAPTURED HERE, inside the creating call, and re-checks the occupant against it; none of them looks
 * a directory up and adopts whatever it finds.
 *
 * WHAT THE CAPTURE ACTUALLY PROVES, AND WHAT IT CANNOT. Portable Node has no `mkdirat`, no
 * `O_TMPFILE`-style linkat, and `mkdirSync` returns no handle, so the interval between the syscall
 * and the first thing that can look at the result is real and cannot be closed. It is instead made
 * DISCRIMINATING, on three legs:
 *
 *   1. THE HANDLE. `open(O_DIRECTORY|O_NOFOLLOW)` refuses a symlink in the kernel, and `fstat` on
 *      the resulting descriptor names one object that no later rename can change. The identity that
 *      travels out of here is the descriptor's, not a name's.
 *   2. THE SHAPE, READ THROUGH THE HANDLE. A directory `mkdir` has just made is EMPTY, and a level
 *      of a recursive `mkdir` holds exactly the level below it. `nlink` is `.` plus the parent's
 *      entry plus one per subdirectory, and it is read from the descriptor, so a substituted tree
 *      that holds subdirectories is refused on evidence that cannot be swapped underneath.
 *   3. THE LISTING, TIED BACK TO THE HANDLE. The directory must hold EXACTLY the entries the call
 *      put there, and an `lstat` afterwards must still be the descriptor's inode — otherwise the
 *      listing described something other than the object being identified, and nothing is returned.
 *
 * A REFUSAL RECORDS NOTHING, and an unrecorded directory is never entered by any walk here, so the
 * cost of refusing is a leaked fixture.
 *
 * THE RESIDUAL, WHICH IS NOT SMALL AND MUST NOT BE UNDERSOLD. A peer that destroys the directory
 * this call just made and stands an EMPTY one at the name defeats all three legs at once, because
 * empty IS the shape a fresh `mkdir` produces: there is nothing left for a check to disagree with.
 * The capture then names the peer's inode, and that is not a theoretical concern — it is
 * reproduced, deterministically, in `tests/safety/creation-window-substitution.test.ts`. Nothing
 * here should be read as claiming the exposure is "one already-empty `rmdir`"; a record obtained
 * this way names a directory that the peer is free to FILL afterwards.
 *
 * WHICH IS WHY A RECORD IS NOT SUFFICIENT AUTHORITY TO EMPTY ANYTHING. A creation record buys the
 * right to remove the directory it names once that directory is empty, and nothing else. Every
 * entry INSIDE answers for itself, on a receipt this run took at the successful syscall that named
 * that exact entry — which a peer's canary, planted at a name this run never mentions, never has.
 * See `entryReceipts`.
 */
interface FreshDirProof {
  /**
   * The entry names the fresh directory must hold — EXACTLY these, no more and no fewer.
   *
   * Equality rather than containment, because containment is what a substitution satisfies for
   * free: an EMPTY directory is a subset of every set, so a rule that only forbids extra names
   * waves through the one shape a peer can always produce. A creating call knows precisely what it
   * put there — nothing, one level below, or a mirror of the source it copied — so anything else is
   * not what the call just made.
   */
  readonly permitted: ReadonlySet<string>;
  /** Subdirectories the link count may report — a bound read from the open descriptor. */
  readonly maxSubdirs: number;
}

const NO_ENTRIES: ReadonlySet<string> = new Set<string>();

/** The proof shape for a directory a creating call has just made and nothing has written into. */
const FRESHLY_EMPTY: FreshDirProof = { permitted: NO_ENTRIES, maxSubdirs: 0 };

/**
 * Whether the descriptor-bound identity survives on this platform.
 *
 * Windows has neither portable `O_DIRECTORY` nor `O_NOFOLLOW` semantics for this proof, so the
 * handle leg is unavailable there and the capture falls back to `lstat` before and after the same
 * shape and listing checks. That is a WEAKER capture and it is named as one rather than presented
 * as equal.
 */
const HANDLE_CAPTURE = process.platform !== 'win32';

/** The directory holds exactly the names the creating call put there — no more, and no fewer. */
function listingMatches(dir: string, permitted: ReadonlySet<string>): boolean {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return false;
  }
  return names.length === permitted.size && names.every((n) => permitted.has(n));
}

/**
 * Identify the directory a creating call just made, or refuse.
 *
 * `null` is the refusal, and it is the answer whenever any leg of the proof is unavailable —
 * including "this platform cannot open a directory" and "the entry is not a directory at all".
 */
function proveFreshDir(p: string, proof: FreshDirProof): Identity | null {
  if (!HANDLE_CAPTURE) {
    let before: fs.BigIntStats;
    try {
      before = fs.lstatSync(p, { bigint: true });
    } catch {
      return null;
    }
    if (before.isSymbolicLink() || !before.isDirectory() || !ownedByThisUid(before)) {
      return null;
    }
    if (!listingMatches(p, proof.permitted)) {
      return null;
    }
    try {
      const after = fs.lstatSync(p, { bigint: true });
      const beforeId = identityFromBigStat(before);
      const afterId = identityFromBigStat(after);
      if (
        after.isSymbolicLink() ||
        !after.isDirectory() ||
        !ownedByThisUid(after) ||
        beforeId === null ||
        afterId === null ||
        !sameIdentity(beforeId, afterId)
      ) {
        return null;
      }
      return beforeId;
    } catch {
      return null;
    }
  }
  let fd: number;
  try {
    fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  } catch {
    return null; // a symlink, a file, or gone — none of them is what a `mkdir` just made
  }
  try {
    const st = fs.fstatSync(fd, { bigint: true });
    if (!st.isDirectory() || !ownedByThisUid(st)) {
      return null;
    }
    // `.` + the parent's entry + one per subdirectory. Filesystems that do not maintain the count
    // report 1, and the listing below is then the only shape evidence there is.
    if (st.nlink > BigInt(2 + proof.maxSubdirs)) {
      return null;
    }
    if (!listingMatches(p, proof.permitted)) {
      return null;
    }
    const now = fs.lstatSync(p, { bigint: true });
    const heldId = identityFromBigStat(st);
    const pathId = identityFromBigStat(now);
    if (heldId === null || pathId === null || !sameIdentity(pathId, heldId)) {
      return null; // the listing described a different object from the one being identified
    }
    return heldId;
  } catch {
    return null;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // the descriptor outlives nothing that matters
    }
  }
}

/**
 * Identities captured at creation, so a caller that creates a directory and then asks to have it
 * recorded supplies the identity the CREATION saw rather than the one a fresh look-up finds.
 *
 * A receipt is never a permit on its own. Every consumer re-checks the occupant against it, so a
 * receipt for a directory something has since replaced produces a REFUSAL — which is exactly the
 * behaviour wanted, and the reason receipts can be kept without expiry.
 */
const creationReceipts = new Map<string, Identity>();

/** Ceiling on retained receipts; the oldest are dropped, and a dropped receipt refuses. */
const MAX_RECEIPTS = 8192;

function rememberReceipt(p: string, id: Identity): void {
  if (creationReceipts.size >= MAX_RECEIPTS) {
    for (const key of creationReceipts.keys()) {
      creationReceipts.delete(key);
      if (creationReceipts.size <= MAX_RECEIPTS / 2) {
        break;
      }
    }
  }
  creationReceipts.set(p, id);
  // Fixtures are handed around in canonical form (`/private/var/...` on macOS) while the syscall was
  // issued against the path as written, so both spellings answer to the same captured identity.
  try {
    const real = fs.realpathSync(p);
    if (real !== p) {
      creationReceipts.set(real, id);
    }
  } catch {
    // uncanonicalisable: the direct spelling is the only one that will answer
  }
}

/** Capture the identity of a directory a creating call just made, and keep the receipt. */
function captureCreatedDir(p: string, proof: FreshDirProof): Identity | null {
  const id = proveFreshDir(p, proof);
  if (id !== null) {
    rememberReceipt(p, id);
  }
  return id;
}

/** The identity captured when this process created `dir`, or `undefined` if none ever was. */
export function creationIdentity(dir: string): Identity | undefined {
  return creationReceipts.get(path.resolve(dir));
}

/**
 * The identity captured when this process created `dir` — or a refusal.
 *
 * A caller that has just created a directory and cannot say which inode it made has nothing to
 * record, and adopting whatever occupies the name is the defect this module exists to refuse. So it
 * raises rather than guesses.
 */
export function requireCreationIdentity(dir: string): Identity {
  const id = creationIdentity(dir);
  if (id === undefined) {
    throw new Error(
      `no creation identity was captured for ${dir} — a directory whose creation this process did not witness cannot be recorded, and adopting whatever now occupies the path is exactly what must not happen`,
    );
  }
  return id;
}

/**
 * PIN a directory the harness just created: a fixture, or the home cut from one.
 *
 * Pinned rather than merely recorded because these are the names tests deliberately substitute at.
 * A pin is permanent for the life of the run, so the second directory to wear the name is refused
 * however it got there — including when this very process is the one that put it there.
 *
 * `expected` is the identity the ALLOCATION captured, and it is checked rather than trusted: a pin
 * is only taken when the directory standing at the name is still that exact inode. `false` means the
 * name is occupied by something else and nothing was recorded, so no walk will ever enter it.
 */
export function recordAllocatedDir(dir: string, expected: Identity): boolean {
  const found = identifyWithParent(dir);
  if (found === null) {
    return false;
  }
  if (!sameIdentity(found.id, expected)) {
    return false; // replaced between its creation and this call — refuse rather than pin a stranger
  }
  const key = dirKey(found.parent, found.name);
  applyPin(key, expected);
  appendDirLedger(
    `A ${IDENTITY_WIRE_VERSION} ${identityFields(expected)} ${identityFields(found.parent)} ${found.name}\n`,
  );
  return true;
}

/**
 * Record a directory this run just created inside a fixture, on the identity its CREATION captured.
 *
 * The parent's inode is read here because that is how the record is keyed, but it decides nothing:
 * the identity being written down is `carried`, and a name now answering to any other inode is
 * refused outright.
 */
function recordCreatedDir(dir: string, carried: Identity): void {
  const found = identifyWithParent(dir);
  if (found === null) {
    return;
  }
  if (!sameIdentity(found.id, carried)) {
    return; // substituted since the capture — record nothing, so nothing is ever entered
  }
  const key = dirKey(found.parent, found.name);
  if (pinnedDirs.has(key)) {
    return; // a pin is the harness's own skeleton and is never re-recorded, by anyone
  }
  applyCreate(key, carried);
  appendDirLedger(
    `+ ${IDENTITY_WIRE_VERSION} ${identityFields(carried)} ${identityFields(found.parent)} ${found.name}\n`,
  );
}

/**
 * Drop the records for a directory the walk has just removed, in memory only.
 *
 * The inode number goes back to the kernel the moment the directory does, and it may be handed to
 * somebody else's directory next. A record that outlived the directory it described would go on
 * vouching for whatever inherits the number, so it is dropped with the removal it authorised.
 */
function forgetDirRecord(parent: Identity, name: string, removed: Identity): void {
  const key = dirKey(parent, name);
  createdDirs.delete(key);
  const pinned = pinnedDirs.get(key);
  if (pinned !== undefined && sameIdentity(pinned, removed)) {
    pinnedDirs.delete(key);
  }
  createdInodes.delete(inodeKey(removed));
  forgetReceiptsIn(removed);
}

// -------------------------------------------------------------------------------------------
// Recording the run's own directory creations, at the call that makes them.
// -------------------------------------------------------------------------------------------

/**
 * The run creates directories inside its fixtures from everywhere: the tests themselves, and the
 * code under test running in-process. None of those call sites can be asked to announce what they
 * made — and a record taken later, by looking at the tree, would be exactly the teardown-time
 * inference this whole module exists to refuse. So the record is taken AT THE CALL: `fs`'s
 * directory-creating entry points are wrapped once, here, and each one writes down the identity of
 * what it just made before returning it to the caller.
 *
 * The wrappers change nothing a caller can observe — same arguments, same return value, same
 * errors, same order of effects. They only witness.
 *
 * WHAT THEY DO NOT COVER, STATED PLAINLY. A CHILD PROCESS creates its directories with its own
 * `fs`, which no wrapper in this process can see; `tests/helpers/child-dir-ledger.mjs` is loaded
 * into node children through `NODE_OPTIONS` so they record their own creations into the same
 * ledger. A child that is not a node process, or one launched with `NODE_OPTIONS` stripped, records
 * nothing — and a directory with no record is never walked, so the cost of that gap is a leaked
 * fixture, never a deleted stranger.
 */

/**
 * The absolute form of a path a wrapper was handed, or `null` when it is not a plain path.
 *
 * `fs` accepts relative paths, and the code under test uses them: the launcher publishes its body
 * by renaming a randomly named temporary FILE onto the launcher's bare name, while its cwd is the
 * bin directory it has chdir'd into so the syscalls cannot land outside it. Comparing a bare name
 * against the run root would say "not ours" and the record would never be written, so every wrapper
 * resolves first — against the same cwd the syscall itself resolved against.
 *
 * THE RESULT DECIDES WHERE RECORDS ARE KEPT, AND NEVER WHICH OBJECT WAS TOUCHED. Reconstructing an
 * absolute path for a relative argument reproduces how the SHELL would read it, not necessarily how
 * the kernel just did: a process whose working directory has been renamed, or whose path now runs
 * through a symlink somebody planted, resolves a bare name to one object while this reconstruction
 * names another. So the reconstruction is used only to ask "is this somewhere this run keeps
 * records", and identity is always read through the spelling the syscall itself was given.
 */
function absolutePath(p: unknown): string | null {
  if (typeof p !== 'string') {
    return null;
  }
  try {
    return path.resolve(p);
  } catch {
    return null;
  }
}

/** Whether a path is somewhere this run's records are kept: inside the run root, or a tracked tree. */
function recordable(p: string): boolean {
  const root = process.env[RUN_ROOT_ENV];
  if (root !== undefined && root !== '' && p.startsWith(root + path.sep)) {
    return true;
  }
  for (const anchor of tracked.keys()) {
    if (p.startsWith(anchor + path.sep)) {
      return true;
    }
  }
  return false;
}

/** Whether an `open` flag set would CREATE the entry; a read-only open witnesses nothing. */
function createsEntry(flags: unknown): boolean {
  if (typeof flags === 'number') {
    return (flags & fs.constants.O_CREAT) !== 0;
  }
  // The string forms that create are exactly those carrying `w` or `a`; every `r` form requires the
  // entry to exist already. An absent flag defaults to `r`.
  return typeof flags === 'string' && (flags.includes('w') || flags.includes('a'));
}

/**
 * WHY A REMOVAL RETIRES A RECORD AND A RENAME DOES NOT.
 *
 * A pin says "cleanup's own skeleton lives at this name" and outlives any number of directories
 * being moved around it — which is what makes a tree stood up at the name refuse. It does not
 * outlive the DESTRUCTION of the pinned directory: a suite that wipes its fake home and lets the
 * code under test build a new one has genuinely vacated the name, and there is nothing left for the
 * pin to protect. The distinction is deliberate and it is the whole difference between the two
 * shapes: `rm` ends the recorded directory, while a `rename` leaves it intact somewhere else, which
 * is exactly what a substitution needs and what an honest teardown never does.
 *
 * The retirement is written to the ledger as well as applied in memory. The sweep of the run root
 * runs in the PARENT process, which knows a worker's records only from the ledger; a retirement kept
 * in the worker that performed the removal would leave the parent still holding a record for a
 * directory that no longer exists — refusing the replacement the run itself built, and vouching for
 * an inode number the kernel has already handed on. See `doomedRecords`/`retireDestroyed`.
 */

/**
 * Record every level a recursive `mkdir` just built, from the deepest up to the first one it had to
 * create — each on the identity captured at that level, and each shape-checked as what `mkdir` makes.
 *
 * The deepest level is empty; every level above it holds exactly the level below. A level that
 * cannot be proved stops the walk: the levels above it stay unrecorded and therefore unenterable,
 * which leaks a fixture and never adopts a stranger.
 */
function recordCreatedChain(target: string, first: string): void {
  let below: string | null = null;
  for (let cur = target, i = 0; i <= MAX_TREE_DEPTH; i += 1) {
    const proof: FreshDirProof =
      below === null
        ? FRESHLY_EMPTY
        : { permitted: new Set([path.basename(below)]), maxSubdirs: 1 };
    const id = captureCreatedDir(cur, proof);
    if (id === null) {
      return;
    }
    if (recordable(cur)) {
      recordCreatedDir(cur, id);
    }
    below = cur;
    const up = path.dirname(cur);
    if (cur === first || up === cur) {
      return;
    }
    cur = up;
  }
}

/** Ceiling on any bookkeeping census; beyond it the records are left exactly as they were. */
const MAX_CENSUS = 8192;

/**
 * The option shapes the RECORDABLE COPY reproduces; anything else is handed to the real `cpSync`
 * and claims nothing.
 *
 * Narrow on purpose. A copy performed here has to behave exactly as the one it replaces, and the
 * honest way to guarantee that for `filter`, `preserveTimestamps`, `errorOnExist`, `verbatimSymlinks`
 * and `force: false` is not to claim to: those calls run natively and leave a tree with no receipts,
 * which teardown then refuses and leaks.
 */
function recordableCopyOptions(opts: unknown): boolean {
  if (typeof opts !== 'object' || opts === null) {
    return false;
  }
  const o = opts as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (key !== 'recursive' && key !== 'dereference' && key !== 'verbatimSymlinks') {
      return false;
    }
  }
  if (o.recursive !== true) {
    return false; // a non-recursive copy has native semantics worth keeping intact
  }
  for (const key of ['dereference', 'verbatimSymlinks'] as const) {
    if (o[key] !== undefined && typeof o[key] !== 'boolean') {
      return false;
    }
  }
  return true;
}

/**
 * Copy a tree through the run's OWN recordable entry points, one entry at a time.
 *
 * WHY THE COPY IS PERFORMED HERE RATHER THAN IDENTIFIED AFTERWARDS. `cpSync` reports nothing about
 * what it made, so the only way to say which entries came out of it is to look at the destination
 * once it has finished — and every such look is an inference from the tree. Comparing the
 * destination against the SOURCE is the strongest version of that inference and it is still an
 * inference: a peer that reproduces the source's entry names satisfies it exactly, and for a source
 * holding one file that costs the peer one file. There is no shape a destination can wear that
 * distinguishes "this copy wrote it" from "something else did".
 *
 * So the copy stops being a black box. Each directory is made with `mkdirSync`, each file with
 * `copyFileSync`, each link with `symlinkSync` — the wrapped entry points — so every entry that
 * arrives carries a receipt from its own creating syscall, and nothing has to be identified after
 * the fact at all. A destination directory substituted inside the capture window fails the
 * fresh-`mkdir` shape proof exactly as any other substituted `mkdir` does, is never recorded, and
 * is therefore never entered.
 *
 * BEHAVIOUR IS THE CALL'S, NOT AN APPROXIMATION OF IT, AND THE SCOPE IS SET BY THAT RULE RATHER
 * THAN BY WHAT WOULD BE CONVENIENT. Two shapes have semantics this walk can state exactly and
 * reproduce exactly: a DIRECTORY is merged with `mkdirSync({recursive:true})` and left at the mode
 * `mkdir` gives it, and a REGULAR FILE goes through `copyFileSync`, which is the same primitive the
 * real copy uses and which carries the source's permissions across. A source tree made of nothing
 * else is copied here.
 *
 * A SOURCE HOLDING ANY OTHER KIND IS NOT COPIED HERE AT ALL — see `plainTree()`. A SYMLINK is the
 * reason: the real call does not copy one verbatim. Unless `verbatimSymlinks` says otherwise it
 * REWRITES the target into an absolute, resolved path, it does so for link text that was already
 * absolute, and it keeps doing it under `dereference` rather than following the link. Reproducing
 * raw `readlink` text instead would be a different function wearing the same name: a relative `../x`
 * that pointed inside the source would silently start pointing inside the destination. Reproducing
 * the rewriting is no better while it is being GUESSED at from the outside. So the whole call goes
 * to the real one, which is the semantics by definition, and claims nothing — the copied entries
 * carry no receipts, and teardown leaks them rather than removing what it cannot account for.
 *
 * A destination whose KIND disagrees with the source's is likewise the real call's to refuse, and it
 * words that refusal in terms of the copy rather than of whichever syscall happened to hit it first.
 */
function copyRecordably(
  from: string,
  to: string,
  opts: unknown,
  realCp: (a: string, b: string, c?: unknown) => undefined,
  depth: number,
): void {
  if (depth > MAX_TREE_DEPTH) {
    throw new Error(`cpSync: ${from} is nested deeper than ${MAX_TREE_DEPTH} levels`);
  }
  const st = fs.lstatSync(from);
  if (!st.isDirectory()) {
    try {
      fs.copyFileSync(from, to);
    } catch {
      // A destination of the wrong kind, or anything else in the way: the real call owns the
      // refusal, and words it in terms of the copy rather than of whichever syscall hit it first.
      realCp(from, to, opts);
    }
    return;
  }
  try {
    // `recursive` merges into a destination that already exists and returns undefined when it
    // creates nothing, so an existing directory keeps whatever record it already had. NOTHING looks
    // at the destination before this call: asking what stands there first would be a look at a name
    // this copy has not yet created, and the answer would be about somebody else's entry.
    fs.mkdirSync(to, { recursive: true });
  } catch {
    realCp(from, to, opts);
    return;
  }
  for (const name of fs.readdirSync(from)) {
    copyRecordably(path.join(from, name), path.join(to, name), opts, realCp, depth + 1);
  }
}

/**
 * Whether a source tree is made of nothing but directories and regular files.
 *
 * `false` sends the whole call to the real `cpSync`. That is deliberately an all-or-nothing answer
 * about the SOURCE rather than a decision taken per entry: handing one entry to the real call turns
 * an inner entry into a top-level one, and the real call treats those differently — a dangling link
 * that a whole-tree copy rewrites without complaint is an error when it is the argument, and the
 * target rewriting itself is computed from the root the copy was started at. Splitting a copy up
 * therefore changes its meaning, so it is not split up.
 */
function plainTree(root: string, depth = 0): boolean {
  if (depth > MAX_TREE_DEPTH) {
    return false;
  }
  let st: fs.Stats;
  try {
    st = fs.lstatSync(root);
  } catch {
    return false; // unreadable, or absent: the real call words that too
  }
  if (st.isFile()) {
    return true;
  }
  if (!st.isDirectory() || st.isSymbolicLink()) {
    return false;
  }
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return false;
  }
  return entries.every((name) => plainTree(path.join(root, name), depth + 1));
}

/** A directory's identity read BEFORE it is moved, so the record can carry it across the rename. */
function identifyBeforeMove(from: string): Identity | null {
  let st: fs.BigIntStats;
  try {
    st = fs.lstatSync(from, { bigint: true });
  } catch {
    return null;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    return null; // files and links carry nothing this ledger records
  }
  return identityFromBigStat(st);
}

/**
 * Whether this run is recorded as having created the directory `id` names, consulting what other
 * processes have written down as well before answering no.
 */
function knownCreated(id: Identity): boolean {
  if (createdThisRun(id)) {
    return true;
  }
  syncDirLedger();
  return createdThisRun(id);
}

/** A directory whose record is about to be destroyed, kept so the record can be retired with it. */
interface DoomedRecord {
  readonly path: string;
  readonly key: string;
  readonly parent: Identity;
  readonly name: string;
  readonly id: Identity;
}

/**
 * A census, AND WHETHER IT IS ONE.
 *
 * A list of records on its own cannot be told apart from a list that stopped early, and the two mean
 * opposite things: the first says "these are the records the call will invalidate", the second says
 * "there are records this walk never reached and the call is going to destroy them anyway". Carrying
 * the flag beside the entries is what makes the second case sayable at all.
 */
interface DoomedCensus {
  readonly entries: readonly DoomedRecord[];
  /** False when the walk could not account for everything the call is about to destroy. */
  readonly complete: boolean;
}

/**
 * The records a removal is about to invalidate — the target's own, and, for a RECURSIVE removal,
 * every recorded directory underneath it.
 *
 * A recursive primitive destroys a whole tree inside one call, and every record it leaves behind
 * names an inode the kernel is now free to hand to somebody else's directory. `createdThisRun()`
 * would then answer yes for a directory this run never made, which is authority conjured out of a
 * recycled number. So the records are collected BEFORE the call, while the directories they describe
 * still exist, and retired after it.
 */
function doomedRecords(target: string, recursive: boolean): DoomedCensus {
  const out: DoomedRecord[] = [];
  let complete = true;
  const visit = (dir: string, depth: number): void => {
    if (depth > MAX_TREE_DEPTH || out.length >= MAX_CENSUS) {
      // THE CEILING STOPS THE COUNTING AND NOT THE DESTRUCTION. Whatever is below this point is
      // going with the call regardless, so the walk cannot say what the removal took.
      complete = false;
      return;
    }
    const found = identifyWithParent(dir);
    if (found === null) {
      return;
    }
    const key = dirKey(found.parent, found.name);
    const recorded = dirRecord(found.parent, found.name);
    if (recorded !== undefined && sameIdentity(recorded, found.id)) {
      out.push({ path: dir, key, parent: found.parent, name: found.name, id: recorded });
    }
    if (!recursive) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      // A directory that has already VANISHED holds nothing left for the call to destroy, so the
      // census is still complete without it. Any other failure — a mode change, a lost permission,
      // an I/O error — means records may live below a level this walk will never see, and the
      // removal is going in anyway.
      if (!isMissing(err)) {
        complete = false;
      }
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        visit(path.join(dir, e.name), depth + 1);
      }
    }
  };
  visit(target, 0);
  return { entries: out, complete };
}

/**
 * INVALIDATE EVERYTHING, in this process and in the file every other process reads.
 *
 * Written BEFORE the destruction it answers for, so a process killed halfway through has already
 * given its authority up rather than left it lying beside a half-removed tree. The line names
 * nothing, because naming the survivors is exactly what the census could not do.
 */
function poisonRecords(): void {
  applyPoison();
  appendDirLedger(`X ${IDENTITY_WIRE_VERSION} poisoned\n`);
}

/**
 * Retire the record for the name a directory has just been MOVED away from — and only when the
 * directory really did leave it.
 *
 * Read before the call and settled after it, for the same reason every other retirement here is:
 * afterwards there is nothing at the source to identify. A source that still holds the recorded
 * directory means the rename did not move what this wrapper thought it did, and the record stands.
 */
function retireMovedName(from: string, parent: Identity, name: string, moved: Identity): void {
  let standing: Identity | null = null;
  try {
    const st = fs.lstatSync(from, { bigint: true });
    if (st.isDirectory() && !st.isSymbolicLink()) {
      standing = identityFromBigStat(st);
    }
  } catch {
    // absent or unreadable means the old name cannot prove the moved directory is still there
  }
  if (standing !== null && sameIdentity(standing, moved)) {
    return;
  }
  const key = dirKey(parent, name);
  applyMoved(key, moved);
  appendDirLedger(
    `M ${IDENTITY_WIRE_VERSION} ${identityFields(moved)} ${identityFields(parent)} ${name}\n`,
  );
}

/**
 * Retire everything that described the directory a RENAME DESTROYED at its destination.
 *
 * `rename(src, dst)` where `dst` is an existing EMPTY DIRECTORY succeeds, and the destination
 * directory is UNLINKED as part of the call. One syscall, two effects — a move and a destruction —
 * and only the move appears in the arguments. Recording the arriving directory and saying nothing
 * about the departed one leaves three pieces of authority attached to an inode number the kernel has
 * already taken back: the name record, the INODE record that authorises the directory under any name
 * at all, and every entry receipt keyed by that inode, which would license removing the entries of
 * whatever object inherits the number.
 *
 * `destroyed` is read BEFORE the call, while there is still something there to identify; afterwards
 * the name answers to the object that replaced it. It is spent only once the destination is known to
 * hold the moved directory instead — a call that moved something else, or nothing, destroyed nothing
 * here.
 *
 * THE INODE AND ITS RECEIPTS GO WHETHER OR NOT A NAME RECORD MATCHED. `applyVacate` is guarded on
 * identity so that a stale or replayed LINE cannot retire a live record, which is the right rule for
 * a line arriving from a file. This process WATCHED the destruction, so it is not inferring anything:
 * a directory that was here and is now gone authorises nothing, under any name, and a record keyed
 * some other way must not keep it alive.
 *
 * The retirement is persisted BEFORE the arriving directory is recorded, and the order is part of
 * the record: both lines describe the same name under the same parent, so a reader that applied the
 * re-record first would find the retirement matching nothing and keep every stale record it had.
 */
function retireOverwrittenDestination(
  destroyed: { id: Identity; parent: Identity; name: string } | null,
  moved: Identity,
): void {
  if (destroyed === null || sameIdentity(destroyed.id, moved)) {
    return; // nothing was standing there, or it was the moved directory itself
  }
  applyVacate(destroyed.parent, destroyed.name, destroyed.id);
  applyDestroyedIdentity(destroyed.id);
  const where = `${identityFields(destroyed.parent)} ${destroyed.name}`;
  appendDirLedger(`- ${IDENTITY_WIRE_VERSION} ${identityFields(destroyed.id)} ${where}\n`);
  // AND THE SAME LOSS STATED WITHOUT REFERENCE TO THE NAME. The `-` line above is keyed by the
  // destination, and a reader applies it by that key: a directory carried here by a move no wrapper
  // witnessed is recorded under the name it was MADE at, so the `-` line matches nothing and every
  // record it should have retired survives the replay. This line names the identity, and a reader
  // retires by identity — which is what was destroyed.
  appendDirLedger(`D ${IDENTITY_WIRE_VERSION} ${identityFields(destroyed.id)} ${where}\n`);
}

/** Retire the records for directories a removal really did destroy; leave the rest untouched. */
function retireDestroyed(doomed: readonly DoomedRecord[]): void {
  for (const d of doomed) {
    let standing: Identity | null = null;
    try {
      const st = fs.lstatSync(d.path, { bigint: true });
      if (st.isDirectory() && !st.isSymbolicLink()) {
        standing = identityFromBigStat(st);
      }
    } catch {
      // already gone or unreadable
    }
    if (standing !== null && sameIdentity(standing, d.id)) {
      continue; // still standing, still the recorded directory — the record still describes it
    }
    applyVacate(d.parent, d.name, d.id);
    appendDirLedger(
      `- ${IDENTITY_WIRE_VERSION} ${identityFields(d.id)} ${identityFields(d.parent)} ${d.name}\n`,
    );
  }
}

function installCreationRecorder(): void {
  const realMkdir = fs.mkdirSync;
  (fs as { mkdirSync: unknown }).mkdirSync = ((p: fs.PathLike, opts?: unknown) => {
    const made = (realMkdir as unknown as (a: fs.PathLike, b?: unknown) => string | undefined)(
      p,
      opts,
    );
    const target = absolutePath(p);
    if (target !== null) {
      if ((opts as { recursive?: boolean } | undefined)?.recursive !== true) {
        // One directory, made this instant and never written to, so it is EMPTY — the shape a
        // substituted tree cannot wear without losing everything that made it worth substituting.
        const id = captureCreatedDir(target, FRESHLY_EMPTY);
        if (id !== null && recordable(target)) {
          recordCreatedDir(target, id);
        }
      } else {
        // `recursive` returns the FIRST directory it had to create; everything from there down to
        // the requested path is new, and every level of it is this run's work.
        const first = absolutePath(made);
        if (first !== null) {
          recordCreatedChain(target, first);
        }
      }
    }
    return made;
  }) as typeof fs.mkdirSync;

  const realMkdtemp = fs.mkdtempSync;
  (fs as { mkdtempSync: unknown }).mkdtempSync = ((p: fs.PathLike, opts?: unknown) => {
    const made = (realMkdtemp as unknown as (a: fs.PathLike, b?: unknown) => string)(p, opts);
    const target = absolutePath(made);
    if (target !== null) {
      const id = captureCreatedDir(target, FRESHLY_EMPTY);
      if (id !== null && recordable(target)) {
        recordCreatedDir(target, id);
      }
    }
    return made;
  }) as typeof fs.mkdtempSync;

  const realCp = fs.cpSync;
  (fs as { cpSync: unknown }).cpSync = ((src: string | URL, dest: string | URL, opts?: unknown) => {
    const source = absolutePath(src);
    const target = absolutePath(dest);
    const native = realCp as unknown as (
      a: string | URL,
      b: string | URL,
      c?: unknown,
    ) => undefined;
    // A destination inside its own source is the one shape the recursive walk below cannot
    // terminate on, and the real call already refuses it with the right error.
    const nested =
      source !== null &&
      target !== null &&
      (target === source || target.startsWith(source + path.sep));
    if (
      !recordableCopyOptions(opts) ||
      source === null ||
      target === null ||
      nested ||
      !plainTree(source)
    ) {
      return native(src, dest, opts);
    }
    copyRecordably(
      source,
      target,
      opts,
      native as (a: string, b: string, c?: unknown) => undefined,
      0,
    );
    return undefined;
  }) as typeof fs.cpSync;

  const realRename = fs.renameSync;
  (fs as { renameSync: unknown }).renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    // A rename is how a tree acquires a name without a `mkdir` — a home moved aside before it is
    // replaced, a directory a test relocates. The identity is read from the SOURCE, before
    // the call, and carried across: a rename preserves the inode, so the directory that arrives is
    // recorded as the directory that left, and a destination holding anything else is refused.
    const fromPath = absolutePath(from);
    const moving = fromPath === null ? null : identifyBeforeMove(fromPath);
    // A NON-DIRECTORY source is identified BEFORE the call, for both halves of the move: the entry
    // that leaves can have its receipt retired, and the object that arrives is named by the identity
    // it had on the way out rather than by a fresh look at the destination. `rename` preserves the
    // inode, so that identity IS the arriving object's — and a destination holding anything else is
    // something this call did not put there.
    //
    // BOTH ENDS ARE IDENTIFIED THROUGH THE SPELLING THE CALL WAS GIVEN. The one caller that renames
    // with bare names does it deliberately: the launcher chdirs into the directory it is publishing
    // into so its syscalls cannot land outside it, and then moves a temporary name onto the
    // launcher's own. A bare name is resolved by the KERNEL against the directory the process is in;
    // rebuilding an absolute path for it instead resolves it against the path that directory used to
    // answer to, which is a different place the moment a test renames that directory or plants a
    // symlink at its old name. Identifying through the given spelling keeps the receipt about the
    // object the rename really moved.
    const leaving = moving === null ? doomedEntryAt(from) : null;
    const arriving = moving === null ? identifyGiven(from) : null;
    // THE NAME A DIRECTORY LEAVES DOES NOT KEEP ITS AUTHORITY. Recording the destination without
    // releasing the source leaves a record that says "this run made a directory here" about a name
    // whose directory has gone — and the walk spends a record by ENTERING whatever answers to the
    // name. Read here, while the source still exists to be identified, and settled after the call.
    const vacating =
      moving === null || fromPath === null || !recordable(fromPath)
        ? null
        : identifyWithParent(fromPath);
    const toPath = absolutePath(to);
    // A DESTINATION THAT ALREADY HOLDS A DIRECTORY IS DESTROYED BY THIS CALL, and everything that
    // described it has to die with it. Read here, for the same reason as everything else on this
    // side of the call: afterwards the name answers to the object that replaced it.
    const destroyed =
      moving === null || toPath === null || !recordable(toPath) ? null : identifyWithParent(toPath);
    (realRename as unknown as (a: fs.PathLike, b: fs.PathLike) => void)(from, to);
    if (
      moving !== null &&
      vacating !== null &&
      fromPath !== null &&
      sameIdentity(vacating.id, moving)
    ) {
      retireMovedName(fromPath, vacating.parent, vacating.name, moving);
    }
    if (moving === null) {
      if (leaving !== null) {
        retireEntryReceiptAt(leaving, from);
      }
      if (arriving !== null && toPath !== null && recordable(toPath)) {
        const landedEntry = identifyGiven(to);
        if (
          landedEntry !== null &&
          sameIdentity(landedEntry.id, arriving.id) &&
          landedEntry.link === arriving.link
        ) {
          keepEntryReceipt(toPath, landedEntry.parent, landedEntry.name, {
            ...arriving.id,
            link: arriving.link,
          });
        }
      }
      return;
    }
    if (toPath === null) {
      return;
    }
    const landed = identifyWithParent(toPath);
    if (landed === null || !sameIdentity(landed.id, moving)) {
      return; // whatever is at the destination is not what this call moved there
    }
    // The destination now holds the moved directory, so the directory that was standing here is
    // gone. Retired FIRST: the re-record below describes the same name under the same parent.
    retireOverwrittenDestination(destroyed, moving);
    rememberReceipt(toPath, moving);
    // Moving a directory does not make it this run's. A tree that arrived from outside carries no
    // creation record, and giving it one here would let anything be walked into simply by being
    // renamed under a name the harness tracks. Everything inside a moved tree is keyed by parents
    // that did not move and stays recorded exactly as it was.
    if (recordable(toPath) && knownCreated(moving)) {
      recordCreatedDir(toPath, moving);
    }
  }) as typeof fs.renameSync;

  // A removal CLAIMS NOTHING. Taking an entry out of a directory says nothing about the entries
  // still in it, and a rule that let it say something would let a walk license itself one entry at
  // a time. What a removal does is INVALIDATE: a pin whose directory this run destroyed would
  // refuse the replacement the run itself builds, and a record left behind would go on vouching for
  // an inode number the kernel has already handed on. The records have to be read BEFORE the call —
  // afterwards there is nothing left to identify — and are retired only for entries the removal
  // really did take away.
  const removalWrapper =
    (real: (a: fs.PathLike, b?: unknown) => void) =>
    (p: fs.PathLike, opts?: unknown): void => {
      const target = absolutePath(p);
      // The identity-aware walk retires its own records as it goes and suppresses ledger writes, so
      // censusing underneath it would be duplicated work on a tree that is already being accounted.
      const recursive =
        walking === 0 && (opts as { recursive?: boolean } | undefined)?.recursive === true;
      const doomed: DoomedCensus =
        target !== null && recordable(target)
          ? doomedRecords(target, recursive)
          : { entries: [], complete: true };
      // A CENSUS THAT STOPPED EARLY CANNOT NAME THE RECORDS THIS CALL IS ABOUT TO INVALIDATE, and
      // the records are keyed by identity rather than by path, so there is no subset to select. The
      // whole holding therefore goes — before the destruction, not after it.
      if (!doomed.complete) {
        poisonRecords();
      }
      const entry = doomedEntry(target);
      real(p, opts);
      retireDestroyed(doomed.entries);
      if (entry !== null && target !== null) {
        retireEntryReceipt(entry, target);
      }
    };

  const realRmdir = fs.rmdirSync;
  (fs as { rmdirSync: unknown }).rmdirSync = removalWrapper(
    realRmdir as unknown as (a: fs.PathLike, b?: unknown) => void,
  ) as typeof fs.rmdirSync;

  const realRm = fs.rmSync;
  (fs as { rmSync: unknown }).rmSync = removalWrapper(
    realRm as unknown as (a: fs.PathLike, b?: unknown) => void,
  ) as typeof fs.rmSync;

  // The entry points that CREATE OR ALTER a non-directory. Each takes a RECEIPT for the one object
  // its call changed, and for nothing else: the receipt is what later permits that single entry to
  // be removed, and it says nothing whatever about the directory around it.
  //
  // EVERY ONE OF THEM WORKS THROUGH A DESCRIPTOR. The wrapper opens the target itself, performs the
  // mutation through that handle, and reads the identity off the handle with `fstat`. A peer that
  // replaces the name the instant the write returns therefore changes nothing about what the receipt
  // says: the descriptor still refers to the object the bytes went into, the replacement is never
  // named by any receipt, and teardown leaves it exactly where it is.
  //
  // A PATH THIS RUN DOES NOT KEEP RECORDS FOR IS LEFT ENTIRELY ALONE. Outside the run root and the
  // tracked trees there is nothing a receipt could ever authorise, so those calls go straight to the
  // real implementation and behave to the byte as they always did.
  //
  // ALTERING COUNTS, NOT ONLY CREATING, and that is not a convenience. The one file in a fake home
  // that no JavaScript wrapper ever sees created is the SQLite store: `new Database(file)` opens it
  // in native code. What the run does do through this binding is `chmodSync` that store to 0600
  // immediately after opening it — this run, holding a descriptor on that exact object, changing it.
  // Without it a home whose only content is a store would be refused at teardown and leaked.
  const claimable = (p: unknown): string | null => {
    const target = absolutePath(p);
    return target !== null && recordable(target) ? target : null;
  };

  /** The `flag` and `mode` a write was asked for, defaulted exactly as the real call defaults them. */
  const writeOptions = (
    options: unknown,
    fallbackFlag: string,
  ): { flag: string | number; mode: fs.Mode } => {
    if (typeof options === 'object' && options !== null) {
      const o = options as { flag?: unknown; mode?: unknown };
      return {
        flag: (o.flag as string | number | undefined) ?? fallbackFlag,
        mode: (o.mode as fs.Mode | undefined) ?? 0o666,
      };
    }
    return { flag: fallbackFlag, mode: 0o666 };
  };

  /** Whether the payload is one the real call accepts without converting it first. */
  const writableData = (data: unknown): boolean =>
    typeof data === 'string' || ArrayBuffer.isView(data);

  /**
   * Whether taking a descriptor on this name is safe to do at all.
   *
   * A name that is free, or that holds a regular file, can be opened without waiting for anything.
   * A fifo cannot: opening one blocks until the other end is opened, and a wrapper that takes a
   * descriptor in order to record something must never be able to stop the program it is recording
   * for. A symlink cannot either — following it would write into the target while the entry being
   * recorded is the link. Both go to the real call, which behaves exactly as it always did, and
   * neither is claimed.
   */
  const openable = (target: string): boolean => {
    const st = nativeLstat(target, { throwIfNoEntry: false });
    return st === undefined || st.isFile();
  };

  const realWriteFile = fs.writeFileSync;
  const writeThroughDescriptor =
    (real: (...a: unknown[]) => unknown, fallbackFlag: string) =>
    (file: unknown, data: unknown, options?: unknown): unknown => {
      const target = claimable(file);
      if (target === null || !writableData(data) || !openable(target)) {
        return real(file, data, options);
      }
      const { flag, mode } = writeOptions(options, fallbackFlag);
      // The descriptor is opened here so the identity can be read off it. `O_NOFOLLOW` is NOT used:
      // writing through a symlink is what the real call does, and this has to do the same.
      const fd = nativeOpen(target, flag, mode);
      return withDescriptor(fd, () => {
        const out = real(fd, data, options);
        receiptFromFd(fd, target);
        return out;
      });
    };

  (fs as { writeFileSync: unknown }).writeFileSync = writeThroughDescriptor(
    realWriteFile as unknown as (...a: unknown[]) => unknown,
    'w',
  ) as typeof fs.writeFileSync;

  const realAppendFile = fs.appendFileSync;
  (fs as { appendFileSync: unknown }).appendFileSync = writeThroughDescriptor(
    realAppendFile as unknown as (...a: unknown[]) => unknown,
    'a',
  ) as typeof fs.appendFileSync;

  /**
   * Copy one file the way the real call does, but through descriptors this wrapper holds.
   *
   * The destination's identity comes from the handle the bytes are written into. Every shape this
   * cannot reproduce exactly — a source that is not a regular file, a destination that cannot be
   * opened, a `mode` argument asking for clone semantics — is handed to the real call instead, which
   * produces the real behaviour and the real error, and claims nothing.
   */
  const realCopyFile = fs.copyFileSync;
  const nativeCopyFallback = Symbol('native-copy-fallback');
  (fs as { copyFileSync: unknown }).copyFileSync = ((
    src: fs.PathLike,
    dest: fs.PathLike,
    mode?: number,
  ) => {
    const target = claimable(dest);
    const source = absolutePath(src);
    const native = (): undefined =>
      (realCopyFile as unknown as (a: fs.PathLike, b: fs.PathLike, c?: number) => undefined)(
        src,
        dest,
        mode,
      );
    // `COPYFILE_EXCL` is the one flag with an exact open-flag twin (`O_EXCL`). The clone flags ask
    // for a filesystem operation this cannot reproduce, so they go to the real call and claim
    // nothing.
    const exclusive = mode === fs.constants.COPYFILE_EXCL;
    if (
      target === null ||
      source === null ||
      !(mode === undefined || mode === 0 || exclusive) ||
      !openable(target)
    ) {
      return native();
    }
    let srcFd: number;
    try {
      srcFd = nativeOpen(source, fs.constants.O_RDONLY);
    } catch {
      return native(); // ENOENT, EACCES, a directory: the real call words all of these
    }
    const outcome = withDescriptor(srcFd, () => {
      const srcStat = nativeFstat(srcFd);
      if (!srcStat.isFile()) {
        return nativeCopyFallback;
      }
      if (process.platform === 'win32') {
        // CopyFileW carries the READONLY attribute, including over an existing writable file. This
        // descriptor copy cannot change it without a pathname race, so preserve the native call.
        if ((srcStat.mode & 0o222) === 0) {
          return nativeCopyFallback;
        }
        // libuv applies the process umask when O_CREAT opens a Windows file. CopyFileW does not, so
        // masking owner-write would turn a writable native copy into a READONLY emulation. A worker
        // where umask cannot be queried is equally outside this recorder's exact subset.
        if (observedWindowsUmask === null || (observedWindowsUmask & 0o200) !== 0) {
          return nativeCopyFallback;
        }
      }
      const perm = srcStat.mode & 0o7777;
      let destFd: number;
      try {
        destFd = nativeOpen(
          target,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | (exclusive ? fs.constants.O_EXCL : 0),
          perm,
        );
      } catch {
        return nativeCopyFallback;
      }
      return withDescriptor(destFd, () => {
        // Opening without O_TRUNC is load-bearing: source and destination may be the same object
        // through the same path or two hard-link names. Native copy owns that case; truncating first
        // would silently empty the held source before there was anything left to compare.
        if (!exclusive) {
          const sourceId = nativeFstatBig(srcFd);
          const destinationId = nativeFstatBig(destFd);
          if (sourceId.dev === destinationId.dev && sourceId.ino === destinationId.ino) {
            return nativeCopyFallback;
          }
        }
        // POSIX copy gives the destination the source permissions, so pin them through this
        // descriptor after the umask-filtered open. The writable Windows shape already has its
        // native synthetic mode; fchmod on this write descriptor raises EPERM there.
        if (process.platform !== 'win32') {
          fs.fchmodSync(destFd, perm);
        }
        if (!exclusive) {
          nativeFtruncate(destFd, 0);
        }
        const buf = Buffer.allocUnsafe(64 * 1024);
        for (let at = 0; ; ) {
          const read = fs.readSync(srcFd, buf, 0, buf.length, at);
          if (read === 0) {
            break;
          }
          let written = 0;
          while (written < read) {
            written += fs.writeSync(destFd, buf, written, read - written, at + written);
          }
          at += read;
        }
        receiptFromFd(destFd, target);
        return undefined;
      });
    });
    // A native fallback must begin in the same descriptor state as an untouched call. In
    // particular, Windows copyFileSync(source, source) is not transparent while the recorder's
    // extra source and destination handles are still live. Both withDescriptor scopes have
    // unwound before this branch runs.
    return outcome === nativeCopyFallback ? native() : outcome;
  }) as typeof fs.copyFileSync;

  // A symlink is the one entry with no descriptor to bind to; see `receiptForCreatedSymlink`.
  const realSymlink = fs.symlinkSync;
  (fs as { symlinkSync: unknown }).symlinkSync = ((
    target: fs.PathLike,
    at: fs.PathLike,
    type?: unknown,
  ) => {
    const out = (
      realSymlink as unknown as (a: fs.PathLike, b: fs.PathLike, c?: unknown) => undefined
    )(target, at, type);
    receiptForCreatedSymlink(claimable(at));
    return out;
  }) as typeof fs.symlinkSync;

  /**
   * A hard link names the SAME OBJECT the source names, so the identity is read from a descriptor on
   * the source and carried to the new name. A source that cannot be opened without following a link,
   * or that something moved between the `fstat` and the `link`, produces a receipt that does not
   * match what is standing at the new name — which teardown refuses, leaking rather than removing.
   */
  const realLink = fs.linkSync;
  (fs as { linkSync: unknown }).linkSync = ((existing: fs.PathLike, at: fs.PathLike) => {
    const source = absolutePath(existing);
    const target = claimable(at);
    const fd =
      source === null || target === null ? null : openForIdentity(source, fs.constants.O_RDONLY);
    const id =
      fd === null
        ? null
        : withDescriptor(fd, () => {
            const st = nativeFstatBig(fd);
            const identity = identityFromBigStat(st);
            return st.isDirectory() || identity === null ? null : { ...identity, link: false };
          });
    const out = (realLink as unknown as (a: fs.PathLike, b: fs.PathLike) => undefined)(
      existing,
      at,
    );
    if (id !== null && target !== null) {
      const slot = entrySlot(target);
      if (slot !== null) {
        keepEntryReceipt(target, slot.parent, slot.name, id);
      }
    }
    return out;
  }) as typeof fs.linkSync;

  const realOpen = fs.openSync;
  (fs as { openSync: unknown }).openSync = ((p: fs.PathLike, flags?: unknown, mode?: unknown) => {
    const fd = (realOpen as unknown as (a: fs.PathLike, b?: unknown, c?: unknown) => number)(
      p,
      flags,
      mode,
    );
    // Only a flag set that CREATES claims anything. A read-only open — including the
    // `O_DIRECTORY|O_NOFOLLOW` one the capture above performs — changes nothing and claims nothing.
    // The identity comes from the descriptor just returned, which is the object the caller is about
    // to write into whatever later happens to the name.
    if (createsEntry(flags)) {
      receiptFromFd(fd, claimable(p));
    }
    return fd;
  }) as typeof fs.openSync;

  // Unlinking claims nothing; it RETIRES, so a receipt cannot outlive the entry it described and go
  // on vouching for whatever inherits the inode number.
  const realUnlink = fs.unlinkSync;
  (fs as { unlinkSync: unknown }).unlinkSync = ((p: fs.PathLike) => {
    const target = absolutePath(p);
    const entry = doomedEntry(target);
    const out = (realUnlink as unknown as (a: fs.PathLike) => void)(p);
    if (entry !== null && target !== null) {
      retireEntryReceipt(entry, target);
    }
    return out;
  }) as typeof fs.unlinkSync;

  // Metadata and size are content too, and each has a descriptor-taking twin: the wrapper opens the
  // object, changes it through the handle, and names it from the same handle. `O_NOFOLLOW` means a
  // symlink standing at the name is never opened here — those calls fall through to the real one,
  // which resolves the link exactly as it always did and claims nothing.
  // Windows requires a writable descriptor for `futimesSync`; an O_RDONLY handle produces EPERM
  // even where the native path-taking `utimesSync` succeeds. Prefer the compatible handle there.
  // If it cannot be opened, `openForIdentity` returns null and the wrapper falls through to the
  // native path operation without minting a receipt, preserving Node's result rather than changing
  // product behavior to satisfy the recorder.
  const timestampHandleFlags =
    process.platform === 'win32' ? fs.constants.O_RDWR : fs.constants.O_RDONLY;
  const throughHandle: Array<[string, string, number]> = [
    ['chmodSync', 'fchmodSync', fs.constants.O_RDONLY],
    ['chownSync', 'fchownSync', fs.constants.O_RDONLY],
    ['utimesSync', 'futimesSync', timestampHandleFlags],
    ['truncateSync', 'ftruncateSync', fs.constants.O_WRONLY],
  ];
  for (const [name, handleName, flags] of throughHandle) {
    const bindings = fs as unknown as Record<string, (...a: unknown[]) => unknown>;
    const real = bindings[name];
    const viaHandle = bindings[handleName];
    if (typeof real !== 'function' || typeof viaHandle !== 'function') {
      continue;
    }
    (fs as unknown as Record<string, unknown>)[name] = (
      p: unknown,
      ...rest: unknown[]
    ): unknown => {
      const target = claimable(p);
      // Windows path chmod can change a directory while fchmod on the descriptor used by this
      // recorder raises EPERM. Directories never receive entry receipts, so the native path call is
      // both the exact behavior and the strongest authority this harness can honestly retain.
      if (process.platform === 'win32' && name === 'chmodSync' && target !== null) {
        try {
          if (nativeLstat(target).isDirectory()) {
            return real(p, ...rest);
          }
        } catch {
          // The normal open/fallback path below preserves the native missing-entry refusal.
        }
      }
      const fd = target === null ? null : openForIdentity(target, flags);
      if (fd === null || target === null) {
        return real(p, ...rest);
      }
      return withDescriptor(fd, () => {
        const out = viaHandle(fd, ...rest);
        receiptFromFd(fd, target);
        return out;
      });
    };
  }
}

/**
 * Hand the recorder to every node CHILD this run starts.
 *
 * A child's `fs` is its own, so nothing wrapped in this process sees the directories a spawned
 * `sthayi` creates inside a fixture. The loader is passed in `NODE_OPTIONS`, which children inherit
 * even when a test rebuilds the rest of the environment from scratch, and the ledger it writes to
 * travels inside the loader URL rather than in a variable a test might scrub.
 *
 * The return value is the exact option this run requires. Ordinary imports ignore it; Windows CI
 * global setup uses it to prove NODE_OPTIONS is final before recording the pre-worker CLI build.
 */
export function publishChildRecorder(): string | undefined {
  const ledger = dirLedgerPath();
  const root = process.env[RUN_ROOT_ENV];
  if (ledger === null || root === undefined || root === '') {
    return undefined;
  }
  const loader = pathToFileURL(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'child-dir-ledger.mjs'),
  );
  loader.searchParams.set('ledger', ledger);
  loader.searchParams.set('root', root);
  const option = `--import=${loader.href}`;
  const current = process.env.NODE_OPTIONS ?? '';
  if (current.includes('child-dir-ledger.mjs')) {
    return option;
  }
  process.env.NODE_OPTIONS = current === '' ? option : `${current} ${option}`;
  return option;
}

installCreationRecorder();
publishChildRecorder();

/**
 * What every destructive call in a walk asks first: is the authority this removal rests on still
 * exactly what it was? A guard returns `false` and the walk stops, leaving everything standing.
 */
export type Guard = () => boolean;

/**
 * Empty one directory whose identity is already proved, depth first, and report whether it is now
 * empty.
 *
 * `false` means the walk ABORTED and the caller removes nothing further: either an identity stopped
 * matching, or a removal was refused. Both leave the remaining tree in place, on purpose.
 *
 * A RECORD FOR THE DIRECTORY AUTHORISES NOTHING INSIDE IT. A creation record can name a directory
 * this run never made — a peer that destroys a freshly created directory and stands an empty one at
 * the name defeats every check a post-hoc capture can perform, because empty is exactly the shape
 * `mkdir` produces. So the record buys only what it proves: the right to `rmdir` the directory it
 * names once that directory is empty. Nothing about the directory — not its record, not its mode,
 * not the fact that this run wrote something into it at some point — says anything about the
 * entries the run did not put there.
 *
 * SO EVERY ENTRY IS DECIDED ON ITS OWN EVIDENCE, and the listing decides nothing at all.
 *
 *   A SUBDIRECTORY is entered only when the creation ledger holds a record this run wrote for that
 *     name under this exact parent inode — or, for a tree this run made and something outside this
 *     process renamed, for that exact inode under whatever name it now answers to. The RECORDED
 *     identity is carried down, so every re-proof at every depth is against what creation wrote.
 *     A recorded name now answering to a different inode is a substitution: ABORT, remove nothing.
 *     A directory with no record is never entered and never removed, whatever it holds.
 *   ANYTHING ELSE — a file, a symlink, a device node — is removed only when this run holds a
 *     RECEIPT for that exact entry: a record taken at a successful syscall of this run's that named
 *     it, whose inode is still the inode standing there. An entry with no receipt is somebody
 *     else's, and the fact that its parent carries a record says nothing whatever about it.
 *
 * Either refusal aborts the walk, so a directory holding one unaccountable entry is left holding
 * everything, and the fixture leaks around it.
 *
 * `device` pins the walk to one filesystem. A subdirectory that reports a different device is a
 * mount that appeared underneath, and the tree on the other side of it was never this run's to
 * touch, so it is refused rather than descended into.
 *
 * Symlinks are removed with `unlinkSync`, which detaches the link and never touches its target, so
 * a link planted inside the tree cannot redirect a deletion outside it.
 */
/**
 * The first bytes of every SQLite database file, and the reason this module knows about them.
 *
 * A store's `-wal` and `-shm` sidecars are made and unmade by SQLite itself, in native code no
 * binding here ever sees. They carry no receipt and none can be invented for them: a name derived by
 * gluing a suffix onto a path this run happens to know about is a PATHNAME standing in for evidence,
 * which is the thing this module refuses everywhere else. Left behind, they are two unaccountable
 * entries that make the walk refuse — and they are left behind exactly when a connection was never
 * closed, because closing the last one is what removes them.
 *
 * SO THE ANSWER IS TO CLOSE THE CONNECTION, NOT TO NAME THE SIDECARS. The database is opened, and
 * closed, and SQLite takes its own files away. Nothing here constructs their names, and nothing here
 * removes them.
 */
const SQLITE_HEADER = 'SQLite format 3\0';

/** How the database driver is reached, resolved once and remembered as absent if it is. */
let closeDatabase: ((file: string) => void) | null | undefined;

function settleDatabase(file: string): void {
  if (closeDatabase === undefined) {
    try {
      const load = createRequire(import.meta.url);
      const Database = load('better-sqlite3') as new (
        f: string,
      ) => { pragma(s: string): unknown; close(): void };
      closeDatabase = (f: string): void => {
        const db = new Database(f);
        try {
          db.pragma('wal_checkpoint(TRUNCATE)');
        } finally {
          db.close();
        }
      };
    } catch {
      closeDatabase = null; // no driver here: the sidecars stay, and the fixture leaks
    }
  }
  if (closeDatabase === null) {
    return;
  }
  try {
    closeDatabase(file);
  } catch {
    // an unreadable or damaged store: leave it, and leave its sidecars
  }
}

/** Whether a file this run holds a receipt for is a SQLite database. */
function isDatabase(file: string): boolean {
  const fd = openForIdentity(file, fs.constants.O_RDONLY);
  if (fd === null) {
    return false;
  }
  return withDescriptor(fd, () => {
    const head = Buffer.alloc(SQLITE_HEADER.length);
    try {
      if (fs.readSync(fd, head, 0, head.length, 0) !== head.length) {
        return false;
      }
    } catch {
      return false;
    }
    return head.toString('latin1') === SQLITE_HEADER;
  });
}

/**
 * Close every database this run holds a receipt for in one directory, so SQLite takes its own
 * sidecars away.
 *
 * Only reached when the directory holds an entry the walk cannot account for, so a teardown that was
 * going to succeed anyway pays nothing for it. A database this run holds no receipt for is not
 * opened: the authority to close one is the same authority that would let it be removed.
 */
function settleDatabasesIn(
  dir: string,
  entries: readonly fs.Dirent[],
  receipts: ReadonlyMap<string, EntryReceipt> | undefined,
): void {
  if (receipts === undefined) {
    return;
  }
  for (const entry of entries) {
    const held = receipts.get(entry.name);
    if (held === undefined || held.link) {
      continue;
    }
    const child = path.join(dir, entry.name);
    let st: fs.BigIntStats;
    try {
      st = fs.lstatSync(child, { bigint: true });
    } catch {
      continue;
    }
    const standing = identityFromBigStat(st);
    if (!st.isFile() || standing === null || !sameIdentity(standing, held)) {
      continue;
    }
    if (isDatabase(child)) {
      settleDatabase(child);
    }
  }
}

/**
 * Take out of `dir` everything this run is recorded as having put there, or take out nothing.
 *
 * WHAT A LOST RACE COSTS HERE, AND THE UNIT IT IS COUNTED IN. Each entry is identified, checked
 * against the record or receipt that covers it, and then removed BY NAME — and no POSIX call makes a
 * removal conditional on an inode, so a peer sharing this uid can take the name away between the
 * check and the syscall and the removal lands on whatever is there. THAT BOUND IS PER UNLINK
 * ATTEMPT, NOT PER CALL TO THIS FUNCTION. The loop makes one attempt per entry; every attempt opens
 * its own interval, and winning one does nothing to close the next. A peer that keeps winning
 * therefore loses this run one entry EACH TIME, up to the number of unlinks attempted — three
 * staggered replacements cost three entries. What no attempt can ever do is take a TREE: directories
 * go through non-recursive `rmdir`, which refuses a directory that is not empty rather than
 * descending into it.
 *
 * The blunt replacement — swapping every name at once — is the case this loop DOES stop: the entries
 * beside the one in flight are re-checked against their own records, the replacements fail those
 * checks, and the walk returns false with everything else left standing.
 */
export function emptyProvenDir(
  dir: string,
  id: Identity,
  device: string,
  guard: Guard,
  depth = 0,
): boolean {
  if (depth > MAX_TREE_DEPTH) {
    return false;
  }
  if (!guard() || proveDir(dir, id) === null) {
    return false;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  // The names just read are only meaningful while the directory they came from is the one proved.
  // Re-prove between the listing and the first removal, so a swap that lands in that window cannot
  // make this loop operate on a stranger's entries.
  if (!guard() || proveDir(dir, id) === null) {
    return false;
  }
  // Read once, before anything is touched: the receipts this run took for entries of THIS inode.
  // A directory the run was tricked into recording has none of them, so its contents survive.
  const receipts = receiptsIn(id);

  /**
   * The first entry here this run cannot account for, or `null` when it can account for all of them.
   *
   * Accounting is the same rule the removal loop applies: a subdirectory needs a creation record for
   * that name under this parent, or for its own inode under whatever name it now answers to; a
   * non-directory needs a receipt matching the inode AND the kind standing there.
   */
  const unaccountedEntry = (): string | null => {
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      let st: fs.BigIntStats;
      try {
        st = fs.lstatSync(child, { bigint: true });
      } catch (err) {
        if (isMissing(err)) {
          continue; // gone since the listing: nothing left to account for
        }
        return entry.name;
      }
      if (st.isDirectory() && !st.isSymbolicLink()) {
        if (st.dev.toString(10) !== device || !ownedByThisUid(st)) {
          return entry.name;
        }
        const standing = identityFromBigStat(st);
        if (standing === null) {
          return entry.name;
        }
        const recorded = dirRecord(id, entry.name);
        if (recorded !== undefined) {
          if (proveDir(child, recorded) === null) {
            return entry.name;
          }
        } else if (!(createdThisRun(standing) && proveDir(child, standing) !== null)) {
          return entry.name;
        }
        continue;
      }
      if (!receiptAuthorises(id, entry.name, st)) {
        return entry.name;
      }
    }
    return null;
  };

  // A DIRECTORY THAT CANNOT BE EMPTIED IS NOT PARTIALLY EMPTIED. Deciding entry by entry as the walk
  // goes would take away everything up to the first thing it cannot account for and leave the rest,
  // which is the worst of both outcomes: the tree still leaks, and the entries that WOULD have
  // explained the leak are gone. A store is exactly that case — its `-wal` and `-shm` sidecars are
  // made and unmade by SQLite in native code, no receipt can honestly be written for them, and
  // removing the database beside them destroys the only thing that could have taken them away.
  //
  // So the accounting is settled first. Closing the connection is what makes SQLite remove its own
  // sidecars, and it is attempted only where something is in fact unaccounted for; if anything is
  // still unaccounted for afterwards, this directory is left exactly as it stands.
  if (unaccountedEntry() !== null) {
    settleDatabasesIn(dir, entries, receipts);
    if (unaccountedEntry() !== null) {
      return false;
    }
  }
  for (const entry of entries) {
    const child = path.join(dir, entry.name);
    let st: fs.BigIntStats;
    try {
      st = fs.lstatSync(child, { bigint: true });
    } catch (err) {
      if (isMissing(err)) {
        continue;
      }
      return false;
    }
    if (st.isDirectory() && !st.isSymbolicLink()) {
      if (st.dev.toString(10) !== device || !ownedByThisUid(st)) {
        return false;
      }
      // The lstat above only says "a directory is here". What may be ENTERED is decided by what
      // this run wrote down when it created a directory — first for this name in this parent, and
      // failing that, for this exact inode under whatever name it was created with.
      const standing = identityFromBigStat(st);
      if (standing === null) {
        return false;
      }
      const recorded = dirRecord(id, entry.name);
      let authority: Identity | null = null;
      if (recorded !== undefined) {
        if (proveDir(child, recorded) === null) {
          return false; // a substitution wearing a recorded name — refuse, and leave everything
        }
        authority = recorded;
      } else if (createdThisRun(standing) && proveDir(child, standing) !== null) {
        authority = standing; // this run's own directory, reached under a name it was moved to
      }
      if (authority === null) {
        return false; // nothing this run is recorded as having made — leave it, and everything else
      }
      if (!emptyProvenDir(child, authority, device, guard, depth + 1)) {
        return false;
      }
      if (!guard() || proveDir(dir, id) === null || proveDir(child, authority) === null) {
        return false;
      }
      try {
        fs.rmdirSync(child); // non-recursive: refuses rather than descend into anything unexpected
      } catch (err) {
        if (!isMissing(err)) {
          return false;
        }
      }
      forgetDirRecord(id, entry.name, authority);
      continue;
    }
    // A file or symlink goes only on its OWN receipt, checked against the inode AND the kind
    // standing here now. Without one it is somebody else's, whatever its parent's record says.
    const receipt = receipts?.get(entry.name);
    const standing = identityFromBigStat(st);
    if (
      receipt === undefined ||
      standing === null ||
      !sameIdentity(receipt, standing) ||
      receipt.link !== st.isSymbolicLink()
    ) {
      return false;
    }
    if (!guard() || proveDir(dir, id) === null) {
      return false;
    }
    try {
      fs.unlinkSync(child); // removes the entry itself; a symlink's target is never followed
    } catch (err) {
      if (!isMissing(err)) {
        return false;
      }
    }
  }
  return true;
}

/** Empty a proved directory and then remove it, or leave the whole thing standing. */
export function removeProvenDir(dir: string, id: Identity, device: string, guard: Guard): boolean {
  if (!emptyProvenDir(dir, id, device, guard)) {
    return false;
  }
  if (!guard() || proveDir(dir, id) === null) {
    return false;
  }
  try {
    fs.rmdirSync(dir); // empty by construction; refuses if anything reappeared inside it
    return true;
  } catch {
    return false; // leaked on purpose: something is in the way, and forcing it would delete blind
  }
}

// -------------------------------------------------------------------------------------------
// The run-root fixture ledger, written by allocation and read by teardown.
// -------------------------------------------------------------------------------------------

/**
 * Append one allocation to the ledger.
 *
 * A single `appendFileSync` is one `open(O_APPEND|O_CREAT|O_WRONLY)` plus one small `write`, which
 * concurrent vitest workers can interleave without tearing each other's lines.
 */
export function recordRunFixture(rootCanonical: string, name: string, id: Identity): void {
  fs.appendFileSync(
    path.join(rootCanonical, RUN_FIXTURES),
    `${IDENTITY_WIRE_VERSION} ${identityFields(id)} ${name}\n`,
    { mode: 0o600 },
  );
}

/**
 * Read the ledger as `name -> identity`. An unreadable or absent ledger registers NOTHING, which
 * makes teardown refuse every directory rather than adopt one — the safe direction.
 *
 * A name allocated more than once (a fixture removed mid-run, its name later reused) keeps its LAST
 * record, because allocations are appended in the order they happen.
 */
export function readRunFixtures(rootCanonical: string): Map<string, Identity> {
  const out = new Map<string, Identity>();
  let text: string;
  try {
    text = fs.readFileSync(path.join(rootCanonical, RUN_FIXTURES), 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    const parts = line.split(' ');
    if (parts.length < 5 || parts[0] !== IDENTITY_WIRE_VERSION) {
      continue; // a partial line names nothing, so it registers nothing
    }
    const id = identityFromFields(parts, 1);
    const name = parts.slice(4).join(' ');
    if (id === null) {
      continue;
    }
    // A ledger entry names one entry of one directory. Anything with a separator in it describes a
    // path instead, and a path is exactly what must never decide a removal here.
    if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
      continue;
    }
    out.set(name, id);
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// In-process records: what this process created, and what it may therefore remove.
// -------------------------------------------------------------------------------------------

interface Tracked {
  readonly id: Identity;
  /**
   * The run root this directory was allocated under, captured AT ALLOCATION.
   *
   * Captured rather than re-read from the environment, because the environment is a variable and a
   * removal's authority must not be. Its privacy is re-proved before every destructive call: the
   * contract is that the root stays private for the whole life of the run, teardown included.
   */
  readonly root: { readonly path: string; readonly id: Identity } | null;
  /**
   * Set once the recorded directory has been removed, and the record is kept rather than dropped.
   *
   * Dropping it would make a second `removeOwned()` on the same path indistinguishable from a path
   * nothing ever allocated, and teardown legitimately asks twice — a suite removes a fixture and its
   * `afterEach` sweeps the same list again. Keeping the record and marking it RETIRED answers that
   * second call without touching the filesystem at all, which is also what makes inode reuse
   * harmless: a retired record can never authorise a removal, however the kernel later recycles the
   * inode number it names.
   */
  removed: boolean;
}

const tracked = new Map<string, Tracked>();

/** The run root as the environment currently publishes it, or `null` when none is published. */
function publishedRunRoot(): { path: string; id: Identity } | null {
  const root = process.env[RUN_ROOT_ENV];
  const identity = decodeIdentity(process.env[RUN_IDENTITY_ENV]);
  if (root === undefined || root === '' || identity === null) {
    return null;
  }
  return { path: root, id: identity };
}

/**
 * Record the identity of a directory this process just created, and hand back the CANONICAL path —
 * the path to keep, and the one `removeOwned()` matches against.
 *
 * THE IDENTITY IS THE CALLER'S TO SUPPLY, NOT THIS FUNCTION'S TO DISCOVER. Reading the inode
 * standing at the path and calling it the tracked identity is the adoption this module exists to
 * refuse: it hands a removal permit to whatever occupies a name, which is precisely what a
 * substitution arranges. So `expected` is the identity the creating operation captured, and it is
 * CHECKED here — a name now answering to any other inode raises rather than tracks. When it is
 * omitted the receipt this process took at the creating call is used instead, and a path whose
 * creation this process never witnessed is refused outright.
 *
 * Canonical because containment is decided on resolved paths: a tracked path with a symlinked
 * component describes one directory and names another.
 */
export function trackOwned(dir: string, expected?: Identity): string {
  const canonical = fs.realpathSync(dir);
  const st = fs.lstatSync(canonical, { bigint: true });
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(`trackOwned(${dir}): only a real directory has an identity worth recording`);
  }
  const want = expected ?? creationIdentity(canonical) ?? creationIdentity(dir);
  if (want === undefined) {
    throw new Error(
      `trackOwned(${dir}): no identity was captured when this directory was created — pass the one the creating call returned, or create it through a wrapped entry point; adopting whatever occupies the path is what must not happen`,
    );
  }
  const standing = identityFromBigStat(st);
  if (standing === null || !sameIdentity(standing, want)) {
    throw new Error(
      `trackOwned(${dir}): ${canonical} is not the incarnation its creation recorded — refusing to track a replacement`,
    );
  }
  const root = publishedRunRoot();
  tracked.set(canonical, {
    id: want,
    // The root guards what sits BENEATH it; it does not guard itself.
    root: root !== null && canonical.startsWith(root.path + path.sep) ? root : null,
    removed: false,
  });
  return canonical;
}

/**
 * Mark a recorded directory as removed, so nothing it named can be removed on its authority again.
 *
 * The record stays: see {@link Tracked.removed}. A path standing back up at the same name is a NEW
 * directory with a new identity, and `trackOwned()` is what records it.
 */
export function retireOwned(dir: string): void {
  const entry = tracked.get(dir);
  if (entry !== undefined) {
    tracked.set(dir, { ...entry, removed: true });
  }
}

/** The recorded identity of a tracked directory, for tests that assert on it. */
export function trackedIdentity(dir: string): Identity | undefined {
  return tracked.get(dir)?.id;
}

/** The creation record for one entry of one directory, for tests that assert on it. */
export function recordedChildIdentity(parent: Identity, name: string): Identity | undefined {
  return dirRecord(parent, name);
}

/**
 * Whether this run still holds a creation record for the exact directory `id` names, for tests that
 * assert on it.
 *
 * The interesting answer is `false` AFTER a removal. An inode number returns to the kernel with the
 * directory that held it and may be handed to somebody else's directory next, so a record that
 * outlives its directory is authority attached to a number rather than to anything this run made.
 */
export function wasCreatedThisRun(id: Identity): boolean {
  return createdThisRun(id);
}

/** The longest tracked prefix of `target`: the allocation whose identity authorises removing it. */
function anchorFor(target: string): { path: string; entry: Tracked } | null {
  let best: string | null = null;
  for (const candidate of tracked.keys()) {
    if (target === candidate || target.startsWith(candidate + path.sep)) {
      if (best === null || candidate.length > best.length) {
        best = candidate;
      }
    }
  }
  const entry = best === null ? undefined : tracked.get(best);
  return best === null || entry === undefined ? null : { path: best, entry };
}

function guardFor(anchor: string, entry: Tracked): Guard {
  return (): boolean => {
    if (
      entry.root !== null &&
      proveDir(entry.root.path, entry.root.id, { requirePrivate: true }) === null
    ) {
      return false;
    }
    return proveDir(anchor, entry.id) !== null;
  };
}

/**
 * Detach whatever now answers to a tracked name — and only when this run holds a RECEIPT for that
 * exact object.
 *
 * A tracked name that no longer resolves to the directory it was recorded as is a name this run has
 * lost, not a name this run may clear. Something else is standing there: a directory, a symlink, or
 * a file with a stranger's bytes in it. The record that authorised the DIRECTORY says nothing about
 * any of them, and spending it on whatever inherited the name is deleting on the strength of a
 * pathname — the one thing this module exists to refuse.
 *
 * So the only entry ever removed here is one the run itself created at that name and still holds a
 * receipt for, checked against the inode and the kind standing there now. Everything else is left
 * exactly where it is and the allocation leaks around it.
 */
function detachReplacedName(target: string): void {
  const slot = entrySlot(target);
  if (slot === null) {
    return;
  }
  let st: fs.BigIntStats;
  try {
    st = fs.lstatSync(target, { bigint: true });
  } catch {
    return; // already gone, or not inspectable — either way nothing to do
  }
  if (st.isDirectory() && !st.isSymbolicLink()) {
    return; // leaked on purpose rather than removed on the strength of a matching pathname
  }
  if (!receiptAuthorises(slot.parent, slot.name, st)) {
    return; // somebody else's entry wearing a name this run used to hold
  }
  try {
    fs.unlinkSync(target); // one entry; a symlink's target is never followed
  } catch {
    // leaked rather than escalated to a forceful delete
  }
}

/**
 * Walk from a PROVED anchor down to `target`, proving every component on the way, and hand back the
 * directory the final name sits in.
 *
 * WHY A CONTAINED-LOOKING PATH IS NOT A CONTAINED PATH. `anchorFor()` matches a tracked directory
 * against the front of a string, and a string prefix is a statement about text: `anchor/link/x`
 * wears the prefix whether `link` is a directory this run made or a symlink pointing at somebody
 * else's tree, and `unlink` on the second one removes an entry that was never inside the anchor at
 * all. Text cannot answer that question, so it is not asked to — each component is lstat'd in turn,
 * a symlink or a non-directory ends the walk, and every directory stepped through has to be one the
 * creation ledger says this run made under the component above it.
 *
 * `null` is the refusal, and it leaves everything standing.
 */
function proveAnchoredEntry(
  anchor: string,
  anchorId: Identity,
  target: string,
  device: string,
): { dir: string; parent: Identity; name: string; st: fs.BigIntStats } | null {
  const rel = path.relative(anchor, target);
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return null;
  }
  const segments = rel.split(path.sep);
  if (segments.length > MAX_TREE_DEPTH) {
    return null;
  }
  let dir = anchor;
  let dirId = anchorId;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const name = segments[i] as string;
    const child = path.join(dir, name);
    let st: fs.BigIntStats;
    try {
      st = fs.lstatSync(child, { bigint: true });
    } catch {
      return null;
    }
    if (
      st.isSymbolicLink() ||
      !st.isDirectory() ||
      st.dev.toString(10) !== device ||
      !ownedByThisUid(st)
    ) {
      return null;
    }
    const standing = identityFromBigStat(st);
    if (standing === null) {
      return null;
    }
    const recorded = dirRecord(dirId, name);
    let authority: Identity | null = null;
    if (recorded !== undefined) {
      if (proveDir(child, recorded) === null) {
        return null; // a substitution wearing a recorded name
      }
      authority = recorded;
    } else if (createdThisRun(standing) && proveDir(child, standing) !== null) {
      authority = standing; // this run's own directory, reached under a name it was moved to
    }
    if (authority === null) {
      return null;
    }
    dir = child;
    dirId = authority;
  }
  const name = segments[segments.length - 1] as string;
  let st: fs.BigIntStats;
  try {
    st = fs.lstatSync(path.join(dir, name), { bigint: true });
  } catch {
    return null;
  }
  return { dir, parent: dirId, name, st };
}

/**
 * Remove a directory this process allocated — or a path beneath one — WITHOUT ever handing a
 * pathname to a recursive primitive.
 *
 * The target's authority is the nearest tracked ancestor-or-self. Removing the anchor itself uses
 * the identity recorded when it was created. Removing something beneath it uses the anchor's proved
 * identity as the gate — the anchor is private and sits inside a private run root, so no second
 * account reaches into it — and then walks entry by entry with the anchor re-proved before every
 * single syscall, entering only directories the creation ledger says this run made.
 *
 * A DIRECTORY BENEATH THE ANCHOR IS NOT REMOVABLE ON A FRESH LOOK EITHER. Asking for one names it
 * by path, and a path is what a substitution inherits; the creation record for that name under that
 * parent is what says which inode was meant, and a mismatch refuses.
 *
 * Never throws for a filesystem state: an unprovable target is LEFT STANDING. The one error it does
 * raise is a programming error — a target nothing here ever allocated, which means no identity was
 * ever recorded and there is nothing to remove it on the authority of.
 */
export function removeOwned(target: string): void {
  const found = anchorFor(target);
  if (found === null) {
    throw new Error(
      `removeOwned(${target}): no identity was ever recorded for this path — allocate it with runTempDir()/createFakeHome(), or record it with trackOwned() at creation`,
    );
  }
  const { path: anchor, entry } = found;
  if (entry.removed) {
    return; // already removed on this record's authority; asking twice removes nothing twice
  }
  syncDirLedger(); // take in what other processes recorded before deciding what may be entered
  const anchorStat = proveDir(anchor, entry.id);
  if (anchorStat === null) {
    // The allocation is gone or is no longer the directory that was recorded. Nothing beneath a
    // name in that state is removable; the name itself is detached only when a non-directory
    // occupies it.
    if (target === anchor) {
      detachReplacedName(anchor);
      retireOwned(anchor);
    }
    return;
  }
  const guard = guardFor(anchor, entry);
  if (target === anchor) {
    if (duringWalk(() => removeProvenDir(anchor, entry.id, anchorStat.dev.toString(10), guard))) {
      retireOwned(anchor);
    }
    return;
  }

  // Every component between the anchor and the target is proved before the target is even looked
  // at, so "beneath a tracked directory" means reached through directories this run made, not
  // merely spelled with a tracked prefix.
  const proven = proveAnchoredEntry(anchor, entry.id, target, anchorStat.dev.toString(10));
  if (proven === null) {
    return; // unprovable path: leave everything standing
  }
  const st = proven.st;
  if (!st.isDirectory() || st.isSymbolicLink()) {
    // ONE ENTRY, AND ONLY ON ITS OWN RECEIPT. Being inside a directory this run allocated says
    // nothing about who put this entry there; the receipt this run took at the syscall that changed
    // that exact object is the only thing that does, and an entry without one is somebody else's.
    if (!receiptAuthorises(proven.parent, proven.name, st)) {
      return;
    }
    if (!guard() || proveDir(proven.dir, proven.parent) === null) {
      return;
    }
    try {
      fs.unlinkSync(target); // one entry; a symlink's target is never followed
    } catch {
      // leaked rather than force-removed
    }
    return;
  }
  if (st.dev !== anchorStat.dev || !ownedByThisUid(st)) {
    return; // a mount appeared beneath the anchor, or the directory is not ours
  }
  // The parent's identity is only how the record is looked up; the record itself is what says which
  // inode this run created here, and the directory standing here now has to be that one.
  const recorded = dirRecord(proven.parent, proven.name);
  const standing = identityFromBigStat(st);
  if (standing === null) {
    return;
  }
  if (recorded !== undefined) {
    if (!sameIdentity(recorded, standing)) {
      return; // no longer the directory this run created here — leave it standing
    }
  } else if (!createdThisRun(standing)) {
    return; // never created by this run under any name — leave it standing
  }
  if (duringWalk(() => removeProvenDir(target, standing, anchorStat.dev.toString(10), guard))) {
    forgetDirRecord(proven.parent, proven.name, standing);
  }
}
