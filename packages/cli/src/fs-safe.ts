import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * fs-safe — the shared hardened-filesystem discipline for Sthayi-owned state files (memory db,
 * HTTP token, client wiring ledger, logs, pack/export output). Generalized from the patterns
 * proven in clients/adapter.ts (unsafeConfigPathReason + atomicWrite), clients/launcher.ts
 * (persistLauncher) and drivers/checkpoint-file.ts (assertSafePath). Those modules keep their
 * own battle-tested copies so their semantics stay byte-identical; THIS module is the reusable
 * form for new call sites.
 *
 * Threat model: an unprivileged local attacker who plants entries at Sthayi's well-known paths —
 * a symlink or FIFO at the file path, a hard link aliasing an external victim file, a squatted
 * predictable temp name, a foreign-owned or loosened file — to steer Sthayi's reads and writes
 * at files it never intended to touch.
 *
 * Defenses: lstat validation (never follows links), O_NOFOLLOW opens where the platform has
 * them, fstat re-validation on the already-open fd (immune to path swaps), exclusive creation
 * ('wx'), RANDOM same-directory temporary names, atomic rename, and — outside an established
 * boundary — an OWNERSHIP AND WRITABILITY check on every pre-existing directory in the chain
 * (see unsafeDirContextCause).
 *
 * AND THE SAME DISCIPLINE FOR DIRECTORIES. A trust boundary is HELD OPEN
 * (`open(O_RDONLY|O_DIRECTORY|O_NOFOLLOW)`) while it is validated, its identity is read by `fstat`
 * THROUGH that descriptor, and its mode is tightened by `fchmod` on it (see holdValidatedDir). A
 * pathname looked up a second time is not evidence about the object the first lookup validated, so
 * no identity here is ever re-derived from a name: it is captured at the validation and carried to
 * the registration.
 *
 * PLATFORM SCOPE OF THE GUARANTEE — read this before relying on anything here on Windows.
 * Everything in this module that depends on POSIX semantics is SKIPPED on Windows, because
 * Windows has neither uids nor POSIX mode bits and Node exposes no equivalent that this module
 * uses. Concretely, on Windows there is NO:
 *   - ownership check (uid), NO permission-bit policy (mode), and NO hard-link (nlink) check;
 *   - creation-context / ancestor ownership+writability check;
 *   - O_NOFOLLOW (the flag does not exist; the lstat gate is the only guard);
 *   - trust-boundary IDENTITY check. A boundary root DELETED AND RECREATED at the same pathname
 *     is ACCEPTED on Windows: the dev/inode comparison that catches it elsewhere is not run, and
 *     no Windows-native directory-identity mechanism is implemented here. Sthayi therefore makes
 *     NO claim of root-replacement protection on Windows. The claims made below about a replaced,
 *     recreated or retargeted boundary being refused are POSIX (macOS/Linux) claims.
 * What survives on Windows is the path-shape discipline: symlink and non-directory refusals,
 * one-level-at-a-time creation (never a recursive mkdir through a link), exclusive-create temp
 * names, atomic rename, and the descriptor-level fstat re-validation and byte caps.
 *
 * PERMISSION-MODEL SCOPE — what "owned by you" and "not writable by others" are claims about.
 * Every ownership and writability judgement here reads exactly two fields of the stat structure:
 * the owning uid and the POSIX permission bits. That is the whole model, so every statement in this
 * module about which principals a directory excludes is a statement WITHIN it, and it does not hold
 * where the effective decision is made somewhere else:
 *   - an EXTENDED ACL (macOS `chmod +a`, Linux `setfacl`/POSIX.1e) can grant a DIFFERENT user
 *     write, add-file or delete on a directory whose uid and mode read exactly like a private 0700
 *     one — an access control list changes neither field;
 *   - on a NETWORK FILESYSTEM (NFS, SMB/CIFS, sshfs, a container or VM shared mount) the server's
 *     identity mapping, `no_root_squash`/`all_squash`-style export semantics, or a mount-wide
 *     uid/gid override decides who may write, so the uid and mode read on the client may describe
 *     no principal set at all.
 * NEITHER IS DETECTED HERE, and nothing warns about them: portable Node exposes no ACL interface,
 * no stat field reflects an ACL, and `fs.statfs` reports a platform-specific number with no
 * filesystem name, mount source or mount flags to classify a mount by. SECURITY.md ("Four intervals
 * Sthayi cannot close") carries the full scope statement.
 */

export interface FileTrustOptions {
  /**
   * POSIX permission-bit policy applied to an EXISTING file:
   * - 'no-shared-write' (default): refuse group/world-WRITABLE (mode & 0o022) — anyone who can
   *   write the file can already steer us;
   * - 'private': additionally refuse ANY group/world access (mode & 0o077) — for secret files
   *   (the HTTP token) that must be 0600;
   * - 'ignore': skip permission bits entirely — for callers that repair modes themselves
   *   (SqliteDriver chmods the db to 0600 right after open).
   */
  modePolicy?: 'no-shared-write' | 'private' | 'ignore';
}

/** O_NOFOLLOW where the platform provides it (POSIX); 0 (no-op) where it does not (Windows). */
const O_NOFOLLOW: number =
  (fs.constants as unknown as Record<string, number | undefined>).O_NOFOLLOW ?? 0;

/** O_DIRECTORY where the platform provides it (POSIX); 0 (no-op) where it does not (Windows). */
const O_DIRECTORY: number =
  (fs.constants as unknown as Record<string, number | undefined>).O_DIRECTORY ?? 0;

/**
 * Can a DIRECTORY be held open on this platform in a way that makes its identity readable from the
 * object rather than from its name? That needs both flags: O_DIRECTORY so a non-directory is
 * refused in the kernel instead of being opened, and O_NOFOLLOW so a symlink is refused there too.
 * Both are POSIX; Windows has neither, and Node exposes no directory descriptor there at all.
 */
const CAN_HOLD_DIRECTORY = O_NOFOLLOW !== 0 && O_DIRECTORY !== 0;

const WRITE_ATTEMPTS = 8;

/** Byte cap for secret files read with modePolicy 'private' (the HTTP token): secrets are tiny. */
export const PRIVATE_READ_CAP_BYTES = 4 * 1024;
/** Byte cap for owned state files (the client wiring ledger) — the default safeReadTextFile cap. */
export const DEFAULT_READ_CAP_BYTES = 1024 * 1024;

/**
 * A directory boundary validated by establishTrustedDir / assertTrustedDirReadOnly in THIS
 * process. The KEY is always the CANONICAL (realpath) form — the logical path string the caller
 * happened to type is deliberately NOT registered, because a path string is not a stable
 * identity: an attacker who retargets an ancestor symlink after establishment would otherwise
 * keep a trusted boundary while the bytes moved to a directory that was never validated.
 *
 * The identity is the canonical path PLUS the directory's EXACT BigInt device/inode — CAPTURED
 * from a descriptor held open on the directory that was validated (holdValidatedDir), never
 * re-read from the name afterwards. On POSIX that descriptor remains open for the boundary's whole
 * process lifetime. BigInt is required because Number rounds legitimate filesystem identities
 * above 2^53 and can otherwise make two different identities compare equal.
 * Keeping the object alive is essential: after the last descriptor closes, Linux may immediately
 * recycle the same device/inode pair for a replacement at the same name. Every use compares the
 * name against a fresh fstat of the retained descriptor (see trustedBoundaryFor), so a boundary
 * root that was deleted, replaced, or turned into a symlink is refused even under that reuse.
 *
 * POSIX ONLY. The dev/inode half of the identity is not compared on Windows (see the platform
 * scope note at the top of this file), so there a boundary root deleted and recreated at the same
 * pathname is accepted; only the symlink / non-directory half of the check applies.
 */
interface TrustedBoundary {
  /** Exact POSIX identity. JavaScript numbers cannot represent every dev/ino value. */
  identity: BoundaryIdentity | undefined;
  what: string;
  /** POSIX capability pin. Undefined only on Windows, whose weaker scope is documented above. */
  fd: number | undefined;
}

/**
 * The device/inode of a directory, READ FROM THE OBJECT ITSELF (an fstat on a descriptor held open
 * on it), never re-derived from its pathname afterwards.
 *
 * WHY IT IS A VALUE THAT TRAVELS RATHER THAN SOMETHING LOOKED UP. A second lookup of a pathname is
 * not evidence about the object the first one validated: between the two, the name can be made to
 * answer to a different directory, and the identity recorded is then the REPLACEMENT'S. Recording
 * that identity is worse than recording nothing, because it is the anchor every later read and
 * write is compared against — the substitute becomes the trust boundary, with full confidence, and
 * every downstream defence that binds to "the established home" binds to the attacker's directory.
 * So an identity is CAPTURED at the validation and CARRIED to the registration.
 */
interface BoundaryIdentity {
  dev: bigint;
  ino: bigint;
}

const trustedBoundaries = new Map<string, TrustedBoundary>();

/**
 * A POSIX boundary which an observational caller validated by pathname but could not pin because
 * opening the directory returned EACCES/EPERM. It is deliberately NOT a trusted boundary: no read
 * or write may use it as authority. Remembering it separately is what prevents a later call in the
 * same process from silently blessing a readable replacement at the same name. The first
 * observational call may return the canonical path so doctor/status can diagnose the locked state;
 * every later use or re-establishment fails closed and asks for a fresh process.
 */
const unpinnedBoundaries = new Map<string, string>();

type DirectoryStat = fs.Stats | fs.BigIntStats;

/** Boundary identity reads are exact on POSIX. Windows keeps its documented path-only contract. */
function lstatBoundarySync(p: fs.PathLike): DirectoryStat {
  return process.platform === 'win32' ? fs.lstatSync(p) : fs.lstatSync(p, { bigint: true });
}

/** Boundary identity reads are exact on POSIX. Windows keeps its documented path-only contract. */
function fstatBoundarySync(fd: number): DirectoryStat {
  return process.platform === 'win32' ? fs.fstatSync(fd) : fs.fstatSync(fd, { bigint: true });
}

function boundaryIdentity(
  st: DirectoryStat,
  p: string,
  what: string,
): BoundaryIdentity | undefined {
  if (process.platform === 'win32') {
    return undefined;
  }
  if (typeof st.dev !== 'bigint' || typeof st.ino !== 'bigint') {
    throw new Error(
      `${what} trust boundary ${p} did not provide an exact BigInt device/inode identity — refusing to use or establish it in this process; re-run the command`,
    );
  }
  return { dev: st.dev, ino: st.ino };
}

function sameBoundaryIdentity(a: BoundaryIdentity, b: BoundaryIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function statMode(st: DirectoryStat): bigint {
  return typeof st.mode === 'bigint' ? st.mode : BigInt(st.mode);
}

function statUid(st: DirectoryStat): bigint {
  return typeof st.uid === 'bigint' ? st.uid : BigInt(st.uid);
}

function unpinnedBoundaryFor(p: string): { canonical: string; what: string } | undefined {
  const resolved = path.resolve(p);
  let best: string | undefined;
  for (const b of unpinnedBoundaries.keys()) {
    if (
      (resolved === b || resolved.startsWith(b + path.sep)) &&
      (best === undefined || b.length > best.length)
    ) {
      best = b;
    }
  }
  return best === undefined
    ? undefined
    : { canonical: best, what: unpinnedBoundaries.get(best) as string };
}

function refuseUnpinnedBoundaryUse(p: string): void {
  const unpinned = unpinnedBoundaryFor(p);
  if (unpinned === undefined) {
    return;
  }
  throw new Error(
    `${unpinned.what} trust boundary ${unpinned.canonical} could not be pinned during an earlier read-only validation — refusing to use or re-establish it in this process; re-run the command`,
  );
}

/** Does a `path.relative()` result ESCAPE the directory it was computed from? An absolute result
 *  (no relative route exists — different roots/drives), `..`, or a `../`-prefixed result all mean
 *  "outside", and joining any of them back onto a validated root lands outside that root. */
export function relativeEscapes(rel: string): boolean {
  return (
    path.isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith(`..${path.sep}`)
  );
}

/**
 * `path.relative(from, to)` that REFUSES a result which escapes `from`. Every place Sthayi
 * re-joins a relative path onto a validated root — the trusted-boundary chain walks — must go
 * through this: an escaping relative path silently converts "beneath the validated root" into
 * "wherever that root's parent leads".
 */
export function containedRelative(from: string, to: string, what: string): string {
  const rel = path.relative(from, to);
  if (relativeEscapes(rel)) {
    throw new Error(
      `${what}: ${to} is not contained in ${from} (relative path ${JSON.stringify(rel)} escapes it) — refusing to proceed`,
    );
  }
  return rel;
}

/** Refusal raised when a canonical boundary ESTABLISHED EARLIER IN THIS PROCESS no longer denotes
 *  the same directory. Deliberately shares the "no longer the directory that was validated"
 *  wording with trustedBoundaryFor: to a caller it is the same fact, caught at a different door. */
function refuseBoundaryIdentityChange(canonical: string, what: string, detail: string): never {
  throw new Error(
    `${what} trust boundary ${canonical} is no longer the directory that was validated (${detail}) — refusing to re-establish it in this process; re-run the command`,
  );
}

/**
 * A boundary established earlier in THIS PROCESS is an identity (canonical path + device/inode),
 * never a path string. Re-validating it must COMPARE against what was registered — re-registering
 * whatever now sits at that path would silently bless a directory nobody validated.
 *
 * The concrete attack this closes: delete the established STHAYI_HOME and drop a fresh directory
 * (or a directory whose contents the attacker chose) at the same path mid-command. Every later
 * `ensureSthayiHome()` — and there are many per command: store, launcher, ledger, logger, http
 * server — passes the directory now at that path back through establishTrustedDir. A re-entry that
 * REFRESHED the registered dev/inode would re-point the binding trustedBoundaryFor checks on every
 * read and write at the replacement instead of catching it, so re-entry compares instead.
 *
 * Called BEFORE establishTrustedDir's chmod/mkdir and before the observational lstat, so a
 * replacement is refused without anything being created, modified, or read through it. The refusal
 * is PROCESS-SCOPED — nothing is persisted, so a NEW command establishes the new healthy directory
 * normally, which is exactly the "re-run the command" the message asks for.
 *
 * PLATFORM SCOPE: the delete-and-recreate case is caught by the dev/inode comparison, which is
 * POSIX ONLY. On Windows that comparison is skipped and this attack is NOT detected — only a
 * replacement by a symlink or a non-directory is. See the platform scope note at the top of this
 * file; do not describe this function as Windows root-replacement protection.
 */
function pinnedBoundaryStat(canonical: string, bound: TrustedBoundary): DirectoryStat | undefined {
  if (process.platform === 'win32') {
    return undefined;
  }
  if (bound.fd === undefined) {
    throw new Error(
      `${bound.what} trust boundary ${canonical} lost the open descriptor that pinned the directory that was validated — refusing to use or re-establish it in this process; re-run the command`,
    );
  }
  let st: DirectoryStat;
  try {
    st = fstatBoundarySync(bound.fd);
  } catch (err) {
    throw new Error(
      `${bound.what} trust boundary ${canonical} could not re-inspect the open descriptor that pinned the directory that was validated (${(err as NodeJS.ErrnoException).code ?? 'unknown error'}) — refusing to use or re-establish it in this process; re-run the command`,
    );
  }
  const identity = boundaryIdentity(st, canonical, bound.what);
  if (
    !st.isDirectory() ||
    identity === undefined ||
    bound.identity === undefined ||
    !sameBoundaryIdentity(identity, bound.identity)
  ) {
    throw new Error(
      `${bound.what} trust boundary ${canonical} no longer has the open identity that was validated — refusing to use or re-establish it in this process; re-run the command`,
    );
  }
  return st;
}

function assertEstablishedBoundaryIdentity(canonical: string, what: string): void {
  refuseUnpinnedBoundaryUse(canonical);
  const prior = trustedBoundaries.get(canonical);
  if (prior === undefined) {
    return; // nothing established here yet — the normal first-establishment path
  }
  const anchor = pinnedBoundaryStat(canonical, prior);
  let st: DirectoryStat;
  try {
    st = lstatBoundarySync(canonical);
  } catch (err) {
    refuseBoundaryIdentityChange(
      canonical,
      prior.what,
      `it could not be re-inspected: ${(err as NodeJS.ErrnoException).code ?? 'unknown error'}`,
    );
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    refuseBoundaryIdentityChange(canonical, prior.what, 'it was replaced by a non-directory entry');
  }
  if (
    process.platform !== 'win32' &&
    anchor !== undefined &&
    !sameBoundaryIdentity(
      boundaryIdentity(st, canonical, prior.what) as BoundaryIdentity,
      boundaryIdentity(anchor, canonical, prior.what) as BoundaryIdentity,
    )
  ) {
    refuseBoundaryIdentityChange(canonical, prior.what, 'it was deleted and recreated');
  }
}

/**
 * Record `canonical` (already validated, already a realpath) as a trust boundary, under the
 * identity its VALIDATION captured — passed in, never looked up here.
 *
 * THIS FUNCTION PERFORMS NO FILESYSTEM LOOKUP, and that is the whole point. Reading the identity
 * off the pathname a second time would register whatever occupies the name at THIS instant, which
 * is not necessarily the directory the caller just validated: a home moved aside and replaced by
 * another real directory in between would be adopted as the established boundary, and every later
 * operation — every read, every write, every "is this still the home we established?" proof built
 * on top of it — would then be measured against the attacker's directory. The identity must come
 * from the same inspection that decided the directory was trustworthy (see holdValidatedDir).
 *
 * Re-registering an ALREADY-ESTABLISHED boundary COMPARES against the prior identity and REFUSES a
 * replacement — it never refreshes it. (The public entry points check this earlier too, before they
 * mutate anything; this is the backstop that covers a canonical root that differs from the spelling
 * the caller passed in, and it is now a comparison of two CAPTURED identities rather than of a
 * capture against a fresh lookup.)
 * POSIX ONLY, like every dev/inode comparison here — on Windows the identity is recorded but
 * never compared, so a replacement is not caught.
 */
function registerTrustedBoundary(canonical: string, what: string, held: HeldDir): void {
  const prior = trustedBoundaries.get(canonical);
  try {
    if (prior !== undefined) {
      const anchor = pinnedBoundaryStat(canonical, prior);
      if (
        process.platform !== 'win32' &&
        anchor !== undefined &&
        !sameBoundaryIdentity(
          held.identity as BoundaryIdentity,
          boundaryIdentity(anchor, canonical, prior.what) as BoundaryIdentity,
        )
      ) {
        refuseBoundaryIdentityChange(canonical, prior.what, 'it was deleted and recreated');
      }
      return; // keep the first pin; this candidate is closed by the finally below
    }
    if (process.platform !== 'win32' && held.fd === undefined) {
      throw new Error(
        `${what} trust boundary ${canonical} could not retain an open descriptor for the directory that was validated — refusing to register a recyclable device/inode value; re-run the command`,
      );
    }
    trustedBoundaries.set(canonical, {
      identity: held.identity,
      what,
      fd: held.fd,
    });
    // Ownership moved to trustedBoundaries. releaseHeldDir must not close the retained pin.
    held.fd = undefined;
  } finally {
    releaseHeldDir(held);
  }
}

/**
 * Deepest established boundary containing `p` (path-prefix on resolved paths), if any — after
 * REVALIDATING that boundary's identity. Throws when the boundary root is gone or no longer the
 * directory that was validated (deleted and recreated, replaced by a symlink, retargeted): a
 * stale boundary must never keep blessing I/O beneath a path it no longer owns.
 *
 * PLATFORM SCOPE: "deleted and recreated" is the dev/inode half and is POSIX ONLY. On Windows only
 * "gone", "replaced by a symlink" and "replaced by a non-directory" are caught — see the platform
 * scope note at the top of this file.
 */
function trustedBoundaryFor(p: string): string | undefined {
  refuseUnpinnedBoundaryUse(p);
  const resolved = path.resolve(p);
  let best: string | undefined;
  for (const b of trustedBoundaries.keys()) {
    if (
      (resolved === b || resolved.startsWith(b + path.sep)) &&
      (best === undefined || b.length > best.length)
    ) {
      best = b;
    }
  }
  if (best === undefined) {
    return undefined;
  }
  const bound = trustedBoundaries.get(best) as TrustedBoundary;
  const anchor = pinnedBoundaryStat(best, bound);
  let st: DirectoryStat;
  try {
    st = lstatBoundarySync(best);
  } catch (err) {
    throw new Error(
      `${bound.what} trust boundary ${best} could not be re-inspected (${(err as NodeJS.ErrnoException).code ?? 'unknown error'}) — refusing to read or write through it`,
    );
  }
  const identityChanged =
    process.platform !== 'win32' &&
    anchor !== undefined &&
    !sameBoundaryIdentity(
      boundaryIdentity(st, best, bound.what) as BoundaryIdentity,
      boundaryIdentity(anchor, best, bound.what) as BoundaryIdentity,
    );
  if (st.isSymbolicLink() || !st.isDirectory() || identityChanged) {
    throw new Error(
      `${bound.what} trust boundary ${best} is no longer the directory that was validated (it was replaced, retargeted, or recreated) — refusing to read or write through it; re-run the command`,
    );
  }
  return best;
}

/** lstat-based trust checks for a DIRECTORY component. Returns a reason when untrusted. */
function untrustedDirStatReason(
  st: DirectoryStat,
  p: string,
  what: string,
  opts: { requireOwned?: boolean; refuseSharedWritable?: boolean } = {},
): string | undefined {
  if (st.isSymbolicLink()) {
    return `${what} at ${p} is a symlink (possible hijack) — refusing to use or chmod through it; replace it with a real directory`;
  }
  if (!st.isDirectory()) {
    return `${what} at ${p} is not a directory — remove whatever occupies that path`;
  }
  if (process.platform !== 'win32') {
    if (
      opts.requireOwned &&
      typeof process.getuid === 'function' &&
      statUid(st) !== BigInt(process.getuid())
    ) {
      return `${what} at ${p} is owned by uid ${st.uid}, not you — refusing to use it; restore ownership or choose a different location`;
    }
    if (opts.refuseSharedWritable) {
      // World- and GROUP-writable are both refused, never "repaired": a chmod cannot un-plant
      // what a peer may already have written inside while the directory was open to them.
      if ((statMode(st) & 0o002n) !== 0n) {
        return `${what} at ${p} is world-writable (mode ${(statMode(st) & 0o777n).toString(8)}) — refusing to use it; anything inside may already be attacker-planted. Run: chmod 700 ${p} and inspect its contents`;
      }
      if ((statMode(st) & 0o020n) !== 0n) {
        return `${what} at ${p} is group-writable (mode ${(statMode(st) & 0o777n).toString(8)}) — refusing to use or chmod it; every member of that group could already have planted entries inside. Run: chmod 700 ${p} and inspect its contents`;
      }
    }
  }
  return undefined;
}

/**
 * A directory HELD OPEN while it is validated: the descriptor, and the fstat read THROUGH that
 * descriptor. `fd` is undefined only on a platform with no directory descriptors (Windows), where
 * the lstat is all there is — see the platform scope note at the top of this file.
 */
interface HeldDir {
  fd: number | undefined;
  st: DirectoryStat;
  identity: BoundaryIdentity | undefined;
}

/** Refusal raised when the directory reached at a pathname is not the one the caller validated.
 *  Deliberately shares the "no longer the directory that was validated" wording with
 *  trustedBoundaryFor and refuseBoundaryIdentityChange: to a caller it is the same fact. */
function refuseHeldDirSubstitution(p: string, what: string): never {
  throw new Error(
    `${what} at ${p} is no longer the directory that was validated (it was replaced between the check and the open) — refusing to use it; re-run the command`,
  );
}

/** Release a held directory. A close failure is not worth surfacing over whatever the caller is
 *  already reporting, and the descriptor outlives nothing that matters. */
function releaseHeldDir(held: HeldDir): void {
  if (held.fd === undefined) {
    return;
  }
  const fd = held.fd;
  held.fd = undefined;
  try {
    fs.closeSync(fd);
  } catch {
    // already closed
  }
}

/**
 * VALIDATE A DIRECTORY BY HOLDING IT OPEN, and hand back both the descriptor and the stat read
 * through it — so the identity a caller records is the identity of the object it validated, not of
 * whatever the pathname answers to next.
 *
 * The sequence, and why each step is there:
 *
 *  1. an lstat GATE on the pathname first. Its job is the WORDING: `open` cannot tell a symlink
 *     from a plain non-directory portably (macOS reports ENOTDIR for both under O_NOFOLLOW), and
 *     "that is a symlink, replace it with a real directory" and "remove whatever occupies that
 *     path" are different instructions to the user. It also refuses a foreign owner or a
 *     shared-writable mode before anything is opened at all;
 *  2. `open(O_RDONLY|O_DIRECTORY|O_NOFOLLOW)`. O_DIRECTORY makes the kernel refuse a non-directory
 *     (a FIFO included, which is why this can never block); O_NOFOLLOW makes it refuse a symlink.
 *     From here on there is ONE object, and no rename can change which one the descriptor names;
 *  3. `fstat` on that descriptor, re-run through the SAME trust predicate. This is the
 *     authoritative validation — it describes the object, not the name;
 *  4. the descriptor's identity must EQUAL `expect` when the caller supplies one, and the gate's
 *     otherwise. `expect` is the identity read by the stat that ALREADY decided this directory was
 *     trustworthy — the caller's own validating lstat, which may be several steps back. Without it
 *     the comparison would only span this function's own gate-to-open window, and a directory
 *     substituted BEFORE that gate would be inspected, opened and registered as a perfectly
 *     consistent stranger. A substitute that happens to pass the same ownership and mode policy is
 *     still a substitute: the stated invariant is exact identity, so it is refused, never accepted.
 *
 * PLATFORM SCOPE. Without both flags there is no way to hold a directory open and read its identity
 * from the object. On Windows that is the documented state of the module (no dev/inode identity at
 * all) and the lstat gate is returned on its own. On any OTHER platform missing them, this REFUSES:
 * proceeding would mean registering a trust anchor whose identity was re-derived from a pathname,
 * which is precisely the thing this function exists to make impossible.
 *
 * A DIRECTORY THAT DENIES US ACCESS. `open` needs read permission; `lstat` does not. A home the
 * owner has chmodded 000 is therefore inspectable but not openable, and it is a state `sthayi
 * doctor` exists to DIAGNOSE — refusing it outright would replace an accurate "cannot tell whether
 * the store exists (EACCES)" report with a bare failure to look at all. On EACCES/EPERM the gate
 * stat is returned WITHOUT a descriptor, and the identity invariant is still satisfied exactly: the
 * gate is compared against `expect`, so the one observational call still diagnoses exactly the
 * directory its validating stat read. It is NEVER registered as trusted. Instead the canonical
 * root is recorded in unpinnedBoundaries, a non-authorizing process-scoped poison state: later
 * reads, writes, or re-establishment beneath the name fail closed until a new process. Without that
 * state, a readable replacement at the same name could be silently blessed by the next call.
 */
function holdValidatedDir(
  p: string,
  what: string,
  opts: {
    requireOwned?: boolean;
    refuseSharedWritable?: boolean;
    /** Identity captured by the stat that validated this directory, when the caller holds one. */
    expect?: BoundaryIdentity;
  },
): HeldDir {
  const policy = {
    requireOwned: opts.requireOwned,
    refuseSharedWritable: opts.refuseSharedWritable,
  };
  let gate: DirectoryStat;
  try {
    gate = lstatBoundarySync(p);
  } catch (err) {
    throw new Error(
      `${what} at ${p} could not be inspected (${(err as NodeJS.ErrnoException).code ?? 'unknown error'}) — refusing to use it`,
    );
  }
  const gateReason = untrustedDirStatReason(gate, p, what, policy);
  if (gateReason) {
    throw new Error(gateReason);
  }
  /** The identity that must come back out of this: the caller's validating stat when it has one. */
  const gateIdentity = boundaryIdentity(gate, p, what);
  const anchor = opts.expect ?? gateIdentity;
  /** The gate stat alone, with the anchor comparison still enforced on it. */
  const withoutDescriptor = (): HeldDir => {
    if (
      process.platform !== 'win32' &&
      (anchor === undefined ||
        gateIdentity === undefined ||
        !sameBoundaryIdentity(gateIdentity, anchor))
    ) {
      refuseHeldDirSubstitution(p, what);
    }
    return { fd: undefined, st: gate, identity: gateIdentity };
  };
  if (!CAN_HOLD_DIRECTORY) {
    if (process.platform !== 'win32') {
      throw new Error(
        `${what} at ${p}: this platform provides no O_DIRECTORY/O_NOFOLLOW directory handle, so the identity of the directory that was validated cannot be read from the directory itself — refusing to establish a trust boundary whose anchor would be a second lookup of the name`,
      );
    }
    return withoutDescriptor();
  }
  let fd: number;
  try {
    fd = fs.openSync(p, fs.constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      // Inspectable but not readable — see the note above. Only the owner (or root) can put a
      // directory in this state, and the identity invariant is still enforced on the gate stat.
      return withoutDescriptor();
    }
    throw new Error(
      `${what} at ${p} could not be opened as the directory that was just validated (${code ?? 'unknown error'}) — refusing to use it; re-run the command`,
    );
  }
  let descriptorStat: DirectoryStat;
  try {
    descriptorStat = fstatBoundarySync(fd);
  } catch (err) {
    // `held` does not exist yet, so releaseHeldDir cannot help: close the raw descriptor here.
    try {
      fs.closeSync(fd);
    } catch {
      // Preserve the authoritative fstat failure; close errors cannot make the descriptor usable.
    }
    throw err;
  }
  const held: HeldDir = {
    fd,
    st: descriptorStat,
    identity: undefined,
  };
  try {
    // Keep exact-identity extraction inside the held-descriptor cleanup region too. A platform or
    // test double that fails to return BigInt fields is a refusal, not permission to leak the pin.
    held.identity = boundaryIdentity(descriptorStat, p, what);
    const reason = untrustedDirStatReason(held.st, p, what, policy);
    if (reason) {
      throw new Error(reason);
    }
    if (
      process.platform !== 'win32' &&
      (anchor === undefined ||
        held.identity === undefined ||
        !sameBoundaryIdentity(held.identity, anchor))
    ) {
      refuseHeldDirSubstitution(p, what);
    }
    return held;
  } catch (err) {
    releaseHeldDir(held);
    throw err;
  }
}

/**
 * Tighten a held boundary's loose-but-safe bits (0755 and friends) to `mode`, on the DESCRIPTOR
 * wherever one exists: `fchmod` re-modes the very directory that was validated, so a name swapped
 * in between cannot receive the bits, and a chmod can never travel through a link to re-mode its
 * target. `canonical` is used only where no descriptor is available (see holdValidatedDir's note on
 * a directory that denies us read access, and on Windows) — that fallback is the path-based form
 * the module documents throughout, and it is what keeps a home the owner locked down from silently
 * keeping group/world bits. Group- and world-WRITABLE never reaches here: it is refused, not
 * repaired. Permission bits are meaningless on Windows, so nothing is tightened there.
 */
function tightenHeldDir(held: HeldDir, canonical: string, mode: number): void {
  if (process.platform === 'win32' || (statMode(held.st) & 0o077n) === 0n) {
    return;
  }
  if (held.fd !== undefined) {
    fs.fchmodSync(held.fd, mode);
    return;
  }
  fs.chmodSync(canonical, mode);
}

/** Every ancestor of `target`, filesystem root first, down to and including its immediate parent.
 *  Pure string work — nothing is inspected here. */
function ancestorsOf(target: string): string[] {
  const out: string[] = [];
  let current = path.resolve(target);
  for (;;) {
    const parent = path.dirname(current);
    if (parent === current) {
      return out; // reached the filesystem root
    }
    out.unshift(parent);
    current = parent;
  }
}

/**
 * THE ANCESTOR-TRUST INVARIANT. A directory Sthayi does not own and will not chmod is safe to
 * build state inside — or to resolve state through — only when BOTH of these hold. Two distinct
 * powers make such a directory a handle an attacker keeps, and symlink/non-directory status
 * detects NEITHER of them:
 *
 *  - WRITABILITY. A group- or world-writable directory WITHOUT the sticky bit lets any local peer
 *    create, rename away, or replace an entry in it. They can pre-plant the file or subdirectory
 *    we are about to create, or swap out an entire subtree our path resolves through, at any time
 *    — before our check, between our check and our open, or after we finish. Sticky is exactly the
 *    bit that removes that power (only an entry's owner may unlink or rename it), so a STICKY
 *    world-writable directory — `/tmp` and `/private/tmp`, mode 1777, uid 0 — is the normal safe
 *    case and is ALLOWED. Every macOS/Linux temp path depends on this;
 *  - OWNERSHIP. The owner of a directory may replace any descendant path regardless of the mode
 *    bits beneath it, so a directory owned by a FOREIGN UNPRIVILEGED user can steer every
 *    operation below it even at mode 0755. ROOT-owned is allowed: root already owns the machine,
 *    and `/`, `/Users`, `/var/folders`, `/tmp` are all root-owned — refusing them would refuse
 *    every real installation.
 *
 * Returns a short CAUSE clause (the callers below wrap it in their own refusal wording), or
 * undefined when the directory is a safe context. Windows has neither uids nor POSIX mode bits,
 * so the check is skipped there — see the platform scope note at the top of this file.
 */
function unsafeDirContextCause(st: DirectoryStat, p: string): string | undefined {
  if (process.platform === 'win32') {
    return undefined;
  }
  const sticky = (statMode(st) & 0o1000n) !== 0n;
  if ((statMode(st) & 0o022n) !== 0n && !sticky) {
    return `it is group- or world-writable (mode ${(statMode(st) & 0o7777n).toString(8)}) and NOT sticky, so another local user could pre-plant or replace what we create. Run: chmod 700 ${p} (or +t), or choose a location only you can write`;
  }
  if (
    typeof process.getuid === 'function' &&
    statUid(st) !== BigInt(process.getuid()) &&
    statUid(st) !== 0n
  ) {
    return `it is owned by uid ${st.uid} (neither you nor root), and that owner can replace any path beneath it; choose a location you own`;
  }
  return undefined;
}

/**
 * The invariant applied to an EXISTING ancestor of `target` — the form used when NO established
 * trust boundary vouches for the path, where the chain is only as trustworthy as its weakest
 * component. An unsafe ancestor at ANY depth is refused even when the target itself is a private
 * 0700 directory owned by us: the ancestor's owner (or any peer, when it is non-sticky
 * shared-writable) can rename that private directory away and drop their own in its place.
 */
function unsafeAncestorContextReason(
  st: DirectoryStat,
  p: string,
  what: string,
  verb: string,
): string | undefined {
  const cause = unsafeDirContextCause(st, p);
  return cause === undefined
    ? undefined
    : `${what}: ancestor directory ${p} is not a safe location for Sthayi state — ${cause}. Refusing to ${verb} through it`;
}

/**
 * NO component of the path leading to `target` may be a symlink — not the immediate parent, and
 * not an ancestor at any depth. `hop -> outside` with the boundary at `hop/sub/home` is the same
 * redirect as `hop/home`, just one level further out: every path-based operation on the boundary
 * (the mode-tightening chmod, the mkdir that creates it, every derived read and atomic write)
 * silently lands in the link's target, and retargeting `hop` afterwards moves the whole tree.
 * Validating only the immediate parent bought nothing — the attacker simply adds a level.
 *
 * So the WHOLE chain from the filesystem root down is lstat-verified, and a storage location
 * reached through ANY link is refused rather than silently followed. The consequence is
 * deliberate: a user who wants their state on another volume must name that volume's CANONICAL
 * REAL PATH (which is also what every derived path, launcher command, and client config records),
 * not a convenience symlink that can be repointed later. lstat only — nothing is followed,
 * created, or modified; a missing ancestor ends the walk (the creation path validates the deepest
 * pre-existing ancestor and every level it creates beneath it).
 *
 * Symlink status is NOT the only way an ancestor can steer us, so every pre-existing component is
 * ALSO held to the ancestor-trust invariant above (ownership + writability). This walk is the one
 * place that runs when nothing else vouches for the path, so it is where that invariant belongs:
 * establishTrustedDir, assertTrustedDirReadOnly and the no-boundary branch of ensureTrustedDirChain
 * all funnel through here before they inspect, create, chmod, read or write anything.
 */
function untrustedAncestorChainReason(
  target: string,
  what: string,
  verb: string,
): string | undefined {
  for (const c of ancestorsOf(target)) {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(c);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return undefined; // nothing below an absent ancestor exists either
      }
      return `${what}: ancestor directory ${c} could not be inspected (${code ?? 'unknown error'}) — refusing to ${verb} through it`;
    }
    if (st.isSymbolicLink()) {
      let real = 'unresolvable';
      try {
        real = fs.realpathSync(c);
      } catch {
        // dangling or unreadable link — the refusal stands either way
      }
      return `${what}: ancestor directory ${c} is a symlink (possible hijack) — refusing to ${verb} ${path.resolve(target)} through it; use the canonical real path (${real}) or replace the link with a real directory`;
    }
    if (!st.isDirectory()) {
      return `${what}: ancestor path ${c} is not a directory — remove whatever occupies that path`;
    }
    const contextReason = unsafeAncestorContextReason(st, c, what, verb);
    if (contextReason) {
      return contextReason;
    }
  }
  return undefined;
}

/** Throwing form of untrustedAncestorChainReason. */
function refuseUntrustedAncestorChain(target: string, what: string, verb: string): void {
  const reason = untrustedAncestorChainReason(target, what, verb);
  if (reason) {
    throw new Error(reason);
  }
}

/**
 * The ancestor-trust invariant applied to the EXISTING directory something is about to be created
 * INSIDE — the deepest pre-existing ancestor on a creation path, and the final containing
 * directory of a file we are about to write. It is not ours to chmod, so it is only checked.
 *
 * This is the SAME predicate as unsafeAncestorContextReason (see unsafeDirContextCause): the
 * distinction is only which wording fits the caller. A sticky world-writable dir (`/tmp`, mode
 * 1777) is the normal safe case and is allowed.
 */
function unsafeCreationContextReason(
  st: DirectoryStat,
  p: string,
  what: string,
): string | undefined {
  const cause = unsafeDirContextCause(st, p);
  return cause === undefined
    ? undefined
    : `${what}: refusing to create anything inside ${p} — ${cause}`;
}

/** Walk UP from `p` to the deepest ancestor that exists. `missing` lists the components (top
 *  first) that must be created to reach `p`. lstat only — nothing is followed or modified. */
function deepestExisting(p: string): {
  existing: string;
  stat: DirectoryStat;
  missing: string[];
} {
  const missing: string[] = [];
  let existing = path.resolve(p);
  for (;;) {
    try {
      return { existing, stat: lstatBoundarySync(existing), missing };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(
          `${existing} could not be inspected (${(err as NodeJS.ErrnoException).code ?? 'unknown error'}) — refusing to use it`,
        );
      }
      const parent = path.dirname(existing);
      if (parent === existing) {
        throw new Error(`${p}: no existing ancestor directory could be found — refusing to use it`);
      }
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

/**
 * Establish `dir` as a validated trust boundary (the sthayi home, the logs dir) and return its
 * CANONICAL ROOT — the realpath, which is what callers must derive every later path from
 * (paths.ts caches it for exactly that reason). What is validated:
 *
 *  - NO component of the path leading to the boundary may be a symlink — the whole chain from the
 *    filesystem root down is verified, so no ancestor link at ANY depth can steer (and later
 *    re-steer) every operation on the boundary. A location reached through a link is refused, not
 *    followed: name the canonical real path instead;
 *  - EVERY pre-existing ancestor must also satisfy the ancestor-trust invariant — not group- or
 *    world-writable unless STICKY, and owned by the current user or by root. Symlink status alone
 *    left a private 0700 boundary under a non-sticky 0777 parent looking healthy, when in fact any
 *    local peer could rename it away and leave their own directory wearing its name;
 *  - an EXISTING boundary must be a real directory, owned by the current user and neither group-
 *    nor world-writable. Loose-but-safe bits (0755) are tightened to `mode` (default 0700) on the
 *    CANONICAL path, never through the caller's logical string; group/world-WRITABLE is refused
 *    outright rather than "repaired", because a chmod cannot un-plant what a peer may already
 *    have written inside;
 *  - a MISSING boundary is created one level at a time beneath the realpath of the deepest
 *    pre-existing ancestor, each level verified after creation (a raced-in symlink, foreign owner
 *    or shared-writable mode at any level is refused, not followed). That pre-existing ancestor is
 *    itself validated first: a symlink there is refused, and so is a non-sticky group/world-
 *    writable or foreign-owned context (a sticky world-writable dir like /tmp is the normal safe
 *    case and is allowed).
 *
 * The boundary is recorded under its canonical path ONLY — never under the logical string the
 * caller typed — and bound to the directory's device/inode, re-checked on every use. So a
 * boundary whose ancestor symlink is retargeted, or whose root is deleted and recreated, stops
 * being trusted instead of silently following the bytes somewhere new. Re-establishing a canonical
 * root ALREADY established in this process COMPARES the identity rather than refreshing it (see
 * assertEstablishedBoundaryIdentity): a replacement is refused here, before any chmod or mkdir.
 * The device/inode half of that — and the ownership/mode checks above — are POSIX ONLY; on Windows
 * a root deleted and recreated at the same pathname is accepted (platform scope note, top of file).
 *
 * THE IDENTITY IS CAPTURED FROM A DESCRIPTOR, NOT FROM A SECOND LOOKUP. The boundary is HELD OPEN
 * (`open(O_RDONLY|O_DIRECTORY|O_NOFOLLOW)`) while it is validated; the fstat read through that
 * descriptor is both the authoritative check and the identity that is registered, and the mode is
 * tightened with `fchmod` on that same descriptor. So the trust anchor every later operation is
 * compared against is the very object that passed validation. Re-reading the identity off the
 * pathname would register whatever occupied the name at that instant — a directory substituted in
 * that window would BECOME the boundary, and every defence built on "still the established home"
 * would then be proving things about the attacker's directory with full confidence.
 *
 * HONEST RESIDUALS. Two windows remain here, neither closable with portable Node, and they are two
 * of the four SECURITY.md publishes for the product as a whole:
 *  - ANCESTOR RETARGETING. The ancestor chain is validated by pathname, and `realpathSync` and the
 *    `open`/`mkdir` that follow resolve those names again in the kernel. An attacker who controls a
 *    directory in the chain and retargets it AFTER the chain walk moves the boundary into a tree
 *    that was never validated; the descriptor identity is then captured, correctly, from the wrong
 *    directory. Closing this needs `openat`-relative resolution from a held ancestor handle, which
 *    Node does not expose. What excludes the unprivileged attacker is that every ancestor must
 *    already be owned by this user or root and be non-shared-writable (or sticky) — an exclusion
 *    that holds within the permission-model scope at the top of this file, and not where an
 *    extended ACL or a network filesystem decides access instead;
 *  - CREATION. `mkdir` resolves its parent name afresh and returns no handle, so the directory the
 *    call made and the directory standing at that name are different questions, and the descriptor
 *    opened immediately after answers only the second one. WHAT THAT MEANS DEPENDS ENTIRELY ON
 *    WHETHER AN IDENTITY IS ALREADY REGISTERED FOR THIS ROOT, and the two cases must not be stated
 *    as one:
 *      · re-establishing a canonical root ALREADY established in this process compares the
 *        registered identity, so a substitution is refused (assertEstablishedBoundaryIdentity);
 *      · on a FIRST establishment there is no registered identity and nothing to compare against.
 *        The directory standing at the name when the descriptor is opened is validated on its own
 *        terms and REGISTERED as the boundary, so a substitution there is adopted SILENTLY and the
 *        caller is told nothing. The create cannot be bound to a handle without `mkdirat`, so this
 *        is a stated residual and not a detection.
 * And the boundary's own limit is unchanged: 0700 excludes other UNPRIVILEGED users; it cannot
 * exclude root or the user's own compromised processes. SECURITY.md ("Four intervals Sthayi cannot
 * close") is the full statement, including the two launcher-write intervals outside this module.
 */
export function establishTrustedDir(
  dir: string,
  what: string,
  opts: { mode?: number } = {},
): string {
  const mode = opts.mode ?? 0o700;
  const target = path.resolve(dir);
  // FIRST OF ALL: if this canonical path was already established in this process, it is an
  // identity, not a name — a directory deleted and recreated there is REFUSED, never re-registered.
  assertEstablishedBoundaryIdentity(target, what);
  // Then, before any lstat of the target and long before any chmod/mkdir: the whole path leading
  // here must be real directories. A link anywhere above us would make every check below — and
  // the chmod and mkdir that follow them — act on a tree we never validated.
  refuseUntrustedAncestorChain(target, what, 'create or use');
  const { existing, stat, missing } = deepestExisting(target);
  let real: string;
  let boundaryHeld: HeldDir;
  if (missing.length === 0) {
    // dir exists — it IS the boundary: full strictness, then tighten loose bits.
    // This lstat is a GATE, not the anchor: it refuses a symlink before realpathSync would follow
    // it, and it produces the precise refusal wording. The directory is then HELD OPEN and
    // re-validated through the descriptor, and the identity registered below is the descriptor's.
    const reason = untrustedDirStatReason(stat, target, what, {
      requireOwned: true,
      refuseSharedWritable: true,
    });
    if (reason) {
      throw new Error(reason);
    }
    real = fs.realpathSync(target);
    // `stat` is the lstat that just decided this directory is trustworthy, so ITS identity is the
    // one that must survive to the registration. Passing it as the anchor makes the descriptor
    // prove it is that same directory — a home moved aside and replaced anywhere between that
    // decision and this open is refused instead of being opened, chmodded and registered as the
    // boundary. (realpathSync sits inside that window and cannot be trusted to name the same
    // object; the identity comparison is what settles it.)
    let held = holdValidatedDir(real, what, {
      requireOwned: true,
      refuseSharedWritable: true,
      expect: boundaryIdentity(stat, target, what),
    });
    try {
      tightenHeldDir(held, real, mode);
      // A 000 directory is inspectable but cannot initially be opened. If tightening changed its
      // mode, try once more to acquire the descriptor: a POSIX boundary recorded without a live
      // descriptor would fall back to a recyclable dev/ino value.
      if (process.platform !== 'win32' && held.fd === undefined) {
        const identity = held.identity;
        held = holdValidatedDir(real, what, {
          requireOwned: true,
          refuseSharedWritable: true,
          expect: identity,
        });
      }
      boundaryHeld = held;
    } catch (err) {
      releaseHeldDir(held);
      throw err;
    }
  } else {
    // Creation path: validate the pre-existing context once, then build strictly beneath it.
    if (stat.isSymbolicLink()) {
      throw new Error(
        `${what}: ancestor ${existing} is a symlink (possible hijack) — refusing to create ${target} through it; create the destination yourself, or point ${what} at the real path`,
      );
    }
    if (!stat.isDirectory()) {
      throw new Error(
        `${what}: ancestor ${existing} is not a directory — remove whatever occupies that path`,
      );
    }
    const contextReason = unsafeCreationContextReason(stat, existing, what);
    if (contextReason) {
      throw new Error(contextReason);
    }
    let current = fs.realpathSync(existing);
    let created: HeldDir | undefined;
    for (let index = 0; index < missing.length; index++) {
      const component = missing[index] as string;
      current = path.join(current, component);
      try {
        fs.mkdirSync(current, { mode });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw err;
        }
        // raced — whatever appeared is validated below exactly like a pre-existing entry
      }
      // Held open and validated through the descriptor, exactly as the existing-boundary branch
      // does it: `mkdir` returns no handle, so the level we just made and the level standing at
      // that name are only the same directory if something proves it. The LAST level's descriptor
      // identity is what the boundary is registered under.
      const held = holdValidatedDir(current, what, {
        requireOwned: true,
        refuseSharedWritable: true,
      });
      try {
        tightenHeldDir(held, current, mode);
        if (index === missing.length - 1) {
          created = held; // the final directory becomes the process-lifetime boundary pin
        }
      } catch (err) {
        releaseHeldDir(held);
        throw err;
      }
      if (index !== missing.length - 1) {
        releaseHeldDir(held);
      }
    }
    if (created === undefined) {
      // Unreachable: this branch runs only when `missing` is non-empty, so the loop above ran at
      // least once. Stated as a refusal rather than a non-null assertion — an unset identity must
      // never become "register whatever is at the name".
      throw new Error(
        `${what}: no directory identity was captured while creating ${target} — refusing to establish a trust boundary without one`,
      );
    }
    real = current;
    boundaryHeld = created;
  }
  // An owner-locked (000) directory is a legitimate state for the observational doctor/status
  // path to diagnose, but a WRITING entry point cannot establish it safely: returning a canonical
  // string here would let callers proceed without the process-lifetime descriptor that makes the
  // trust boundary non-recyclable. Preserve the owner's locked state and fail closed. Windows
  // keeps its documented path-only boundary behavior.
  if (process.platform !== 'win32' && boundaryHeld.fd === undefined) {
    releaseHeldDir(boundaryHeld);
    throw new Error(
      `${what} at ${real} could not be opened, so its validated identity cannot be pinned for writes — restore owner read/search access to the directory and re-run the command`,
    );
  }
  registerTrustedBoundary(real, what, boundaryHeld);
  return real;
}

/**
 * OBSERVATIONAL counterpart of establishTrustedDir, for callers that must not mutate anything
 * (`sthayi doctor`, `sthayi status`, openStoreReadOnly): it applies the SAME whole-path validation
 * to an existing boundary — real directory (never a symlink), no symlinked ancestor at ANY depth,
 * owned by the current user, neither group- nor world-writable — but CREATES NOTHING and CHMODS
 * NOTHING. Observation that followed a link an establishing write would refuse would report on
 * (and read out of) a tree outside the home, which is exactly what doctor exists to catch.
 * A loose-but-safe 0755 boundary is accepted as-is and left alone (the caller reports the mode);
 * only genuinely shared-WRITABLE or hijacked boundaries are refused.
 *
 * Returns the canonical root, or `undefined` when the directory does not exist — an absent home
 * is a legitimate observational state ("not initialized"), not a failure. Throws with an
 * actionable message on refusal. The validated canonical root is registered as a trust boundary
 * exactly as establishTrustedDir registers it, so hardened reads beneath it validate the whole
 * chain against the canonical identity.
 */
export function assertTrustedDirReadOnly(dir: string, what: string): string | undefined {
  const target = path.resolve(dir);
  // Same established-identity rule as establishTrustedDir: observation must not re-bless a
  // directory that replaced the one established in this process either — doctor/status reporting
  // on a swapped-in home is the same disclosure a write into it would be.
  assertEstablishedBoundaryIdentity(target, what);
  // Whole-path gate next, exactly as establishTrustedDir applies it — an ancestor link at any
  // depth is refused BEFORE the target is even inspected, so nothing is ever read through it.
  refuseUntrustedAncestorChain(target, what, 'read');
  let st: DirectoryStat;
  try {
    st = lstatBoundarySync(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined; // absent — nothing to observe, nothing to refuse
    }
    throw new Error(
      `${what} at ${target} could not be inspected (${(err as NodeJS.ErrnoException).code ?? 'unknown error'}) — refusing to use it`,
    );
  }
  const reason = untrustedDirStatReason(st, target, what, {
    requireOwned: true,
    refuseSharedWritable: true,
  });
  if (reason) {
    throw new Error(reason);
  }
  const real = fs.realpathSync(target);
  // Same identity discipline as establishTrustedDir, and for the same reason: observation
  // REGISTERS a boundary, and a boundary registered from a second lookup of the name is a boundary
  // that can be an attacker's directory. `st` is the lstat that validated this home, so it is the
  // anchor the descriptor must match. Holding it open costs nothing observationally — a read-only
  // directory descriptor creates nothing and modifies nothing.
  const held = holdValidatedDir(real, what, {
    requireOwned: true,
    refuseSharedWritable: true,
    expect: boundaryIdentity(st, target, what),
  });
  // An observational command must not chmod a 000 directory merely to acquire a handle. On POSIX,
  // returning the canonical path is still useful to doctor/status, but without a descriptor there
  // is no non-recyclable boundary identity to register. Poison the canonical root in a SEPARATE,
  // non-authorizing map so every later use in this process fails closed even if the pathname is
  // replaced by a readable, same-policy directory. Windows intentionally keeps its documented
  // path-only boundary behavior.
  if (process.platform !== 'win32' && held.fd === undefined) {
    releaseHeldDir(held);
    unpinnedBoundaries.set(real, what);
    return real;
  }
  registerTrustedBoundary(real, what, held);
  return real;
}

/**
 * Shared stat validation for both the lstat (path) and fstat (open fd) forms: the stats must
 * describe a regular, single-link file, owned by us, within the mode policy. Returns an
 * actionable reason when untrusted, undefined when clean. Exported for callers that hold their
 * own descriptor (SqliteDriver.openReadOnly re-validates on the open fd).
 */
export function untrustedStatReason(
  st: fs.Stats,
  p: string,
  what: string,
  opts: FileTrustOptions,
): string | undefined {
  if (st.isSymbolicLink()) {
    return `${what} at ${p} is a symlink (possible hijack) — refusing to follow it; replace it with a regular file or delete it`;
  }
  if (!st.isFile()) {
    return `${what} at ${p} is not a regular file — refusing to use it; remove whatever occupies that path`;
  }
  if (process.platform !== 'win32') {
    if (st.nlink > 1) {
      return `${what} at ${p} has ${st.nlink} hard links (possible hijack) — refusing to use it; delete it and let sthayi recreate it`;
    }
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
      return `${what} at ${p} is owned by uid ${st.uid}, not you — refusing to use it; restore ownership or delete the file`;
    }
    const policy = opts.modePolicy ?? 'no-shared-write';
    if (policy === 'private' && (st.mode & 0o077) !== 0) {
      return `${what} at ${p} is group- or world-accessible (mode ${(st.mode & 0o777).toString(8)}) — refusing to use it; run: chmod 600 ${p}`;
    }
    if (policy === 'no-shared-write' && (st.mode & 0o022) !== 0) {
      return `${what} at ${p} is group- or world-writable (mode ${(st.mode & 0o777).toString(8)}) — refusing to use it; run: chmod 600 ${p}`;
    }
  }
  return undefined;
}

/**
 * lstat trust gate for a path Sthayi is about to read, write, or hand to a path-based opener.
 * ABSENT is fine (returns undefined — creation is the caller's healthy path). Anything present
 * must be a regular, single-hard-link file owned by the current user within `modePolicy`.
 * lstat only — nothing is followed, nothing is modified. Returns an actionable reason when the
 * path must be refused, undefined when it is safe to proceed.
 */
export function untrustedFileReason(
  p: string,
  what: string,
  opts: FileTrustOptions = {},
): string | undefined {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined; // absent — a legitimate state (caller creates it)
    }
    return `${what} at ${p} could not be inspected (${(err as NodeJS.ErrnoException).code ?? 'unknown error'}) — refusing to use it`;
  }
  return untrustedStatReason(st, p, what, opts);
}

/** Throwing form of untrustedFileReason. */
export function assertTrustedFile(p: string, what: string, opts: FileTrustOptions = {}): void {
  const reason = untrustedFileReason(p, what, opts);
  if (reason) {
    throw new Error(reason);
  }
}

export interface ReadTextOptions extends FileTrustOptions {
  /**
   * Per-caller byte cap. Defaults: PRIVATE_READ_CAP_BYTES (4 KiB) when modePolicy is 'private'
   * (secret files — the HTTP token), DEFAULT_READ_CAP_BYTES (1 MiB) otherwise (owned state
   * files — the client wiring ledger). Enforced at the DESCRIPTOR level twice: the fstat size
   * fast-fails, and the read loop itself is capped at limit+1 bytes so a file that GROWS
   * between the fstat and the read is still refused, never buffered past the cap.
   */
  maxBytes?: number;
}

/**
 * PUBLIC, observational: validate the whole chain leading to the directory that CONTAINS `file`,
 * without creating or modifying anything. For DIRECT callers of a path-based opener that has no
 * containing trust boundary of its own (SqliteDriver.openReadOnly, NodeCrypto.loadExisting): the
 * per-file lstat gate says nothing about the directories the kernel will walk to reach it, so a
 * symlinked ancestor at ANY depth silently serves a file from a tree that was never validated.
 * Returns 'absent' when the containing directory does not exist (nothing can be read there), a
 * refusal reason, or undefined when the chain is clean.
 */
export function untrustedContainingDirReason(
  file: string,
  what: string,
): string | 'absent' | undefined {
  return untrustedReadParentReason(path.dirname(path.resolve(file)), what);
}

/** Throwing form of untrustedContainingDirReason: an ABSENT containing directory is a refusal too
 *  (a read whose directory does not exist has nothing to open). Returns the validated directory. */
export function assertTrustedContainingDirReadOnly(file: string, what: string): string {
  const dir = path.dirname(path.resolve(file));
  const reason = untrustedContainingDirReason(file, what);
  if (reason === 'absent') {
    throw new Error(`${what}: its directory ${dir} does not exist — there is nothing to read`);
  }
  if (reason) {
    throw new Error(reason);
  }
  return dir;
}

/** Validate the parent chain of a path about to be READ: every component from the containing
 *  trusted boundary (when one is established) down to the final parent must be a real,
 *  non-symlink directory. WITHOUT a boundary the walk starts at the filesystem ROOT instead —
 *  never at the final parent alone. The final parent alone is not enough: a boundary established
 *  at canonical `A/sub/home` does not prefix-match the LOGICAL path `hop/sub/home/x`, so no
 *  boundary is found for it, and `hop/sub/home` lstats as an ordinary directory while the read
 *  itself resolves through `hop` into whatever that link points at. Returns 'absent' when the
 *  parent does not exist (the file is then genuinely absent), a refusal reason, or undefined
 *  when clean.
 *
 *  WITHOUT a boundary every component ALSO has to satisfy the ancestor-trust invariant
 *  (ownership + writability). Reading is not exempt: a non-sticky shared-writable or
 *  foreign-owned directory anywhere in the chain can be swapped for one the attacker filled, and
 *  the per-file trust gate downstream cannot tell the substituted tree from the real one. WITH a
 *  boundary the components live beneath a root already established as owner-only, which is what
 *  vouches for them. */
function untrustedReadParentReason(dir: string, what: string): string | 'absent' | undefined {
  const resolved = path.resolve(dir);
  const boundary = trustedBoundaryFor(resolved);
  const components: string[] = [];
  if (boundary === undefined) {
    components.push(...ancestorsOf(resolved), resolved);
  } else if (resolved !== boundary) {
    let current = boundary;
    for (const part of containedRelative(boundary, resolved, what).split(path.sep)) {
      current = path.join(current, part);
      components.push(current);
    }
  } else {
    components.push(resolved);
  }
  for (const c of components) {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(c);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return 'absent';
      }
      return `${what}: parent directory ${c} could not be inspected (${(err as NodeJS.ErrnoException).code ?? 'unknown error'}) — refusing to read through it`;
    }
    if (st.isSymbolicLink()) {
      return `${what}: parent directory ${c} is a symlink (possible hijack) — refusing to read through it; replace it with a real directory`;
    }
    if (!st.isDirectory()) {
      return `${what}: parent path ${c} is not a directory — remove whatever occupies that path`;
    }
    if (boundary === undefined) {
      const contextReason = unsafeAncestorContextReason(st, c, what, 'read');
      if (contextReason) {
        return contextReason;
      }
    }
  }
  return undefined;
}

/**
 * Read a trusted text file, or undefined when absent. Two-layer TOCTOU discipline: the lstat
 * gate refuses anything already hostile, then the open itself uses O_NOFOLLOW (where available)
 * and the checks are REPEATED via fstat on the open fd — a path swapped between lstat and open
 * cannot redirect the read, because what we validate is the very inode we hold open.
 *
 * The parent chain is validated too (up to the containing establishTrustedDir boundary when one
 * exists, from the filesystem ROOT otherwise): a symlinked ancestor must not steer the read
 * outside, at any depth.
 * HONEST RESIDUAL: intermediate components are checked by path-based lstat, so a directory
 * swapped between that check and the open can still redirect ONE lookup — the fstat re-check on
 * the open fd then refuses anything that fails the file trust policy, but a same-policy external
 * file reached that way is not distinguishable. The 0700 home boundary is what excludes the
 * unprivileged attacker who could attempt that swap.
 *
 * Reads are byte-capped (see ReadTextOptions.maxBytes): fstat size fast-fail AND a capped
 * fd-read loop with a limit+1 sentinel, so growth after the fstat is refused as well.
 */
export function safeReadTextFile(
  p: string,
  what: string,
  opts: ReadTextOptions = {},
): string | undefined {
  const parentReason = untrustedReadParentReason(path.dirname(path.resolve(p)), what);
  if (parentReason === 'absent') {
    return undefined; // no parent directory — the file is genuinely absent
  }
  if (parentReason) {
    throw new Error(parentReason);
  }
  assertTrustedFile(p, what, opts);
  let fd: number;
  try {
    fd = fs.openSync(p, fs.constants.O_RDONLY | O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return undefined; // raced away after the lstat — genuinely absent
    }
    if (code === 'ELOOP') {
      throw new Error(
        `${what} at ${p} is a symlink (possible hijack) — refusing to follow it; replace it with a regular file or delete it`,
      );
    }
    throw err;
  }
  try {
    const st = fs.fstatSync(fd);
    const reason = untrustedStatReason(st, p, what, opts);
    if (reason) {
      throw new Error(reason);
    }
    const cap =
      opts.maxBytes ??
      (opts.modePolicy === 'private' ? PRIVATE_READ_CAP_BYTES : DEFAULT_READ_CAP_BYTES);
    if (st.size > cap) {
      throw new Error(
        `${what} at ${p} is ${st.size} bytes — over the ${cap}-byte cap for this file; refusing to read it (repair or delete the file)`,
      );
    }
    // Capped fd-read with the +1 sentinel: never trust the fstat size for the loop bound.
    const buf = Buffer.alloc(Math.min(64 * 1024, cap + 1));
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, cap + 1 - total), null);
      if (n === 0) {
        break;
      }
      total += n;
      if (total > cap) {
        throw new Error(
          `${what} at ${p} produced more than the ${cap}-byte cap (it grew while being read) — refusing to read it`,
        );
      }
      chunks.push(Buffer.from(buf.subarray(0, n)));
    }
    return Buffer.concat(chunks, total).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/** Refusal helpers shared by the write/create parent-chain walk. `refusal` is the caller's message
 *  prefix ("refusing to write /x", "refusing to open the memory database"). */
function refuseSymlinkParent(refusal: string, component: string): never {
  throw new Error(
    `${refusal}: parent directory ${component} is a symlink (possible hijack) — replace it with a real directory (nothing was modified)`,
  );
}
function refuseNonDirParent(refusal: string, component: string): never {
  throw new Error(
    `${refusal}: parent path ${component} is not a directory — remove whatever occupies that path (nothing was modified)`,
  );
}

/**
 * STRICT validation of a chain component we JUST CREATED — or that RACED IN at that level between
 * our `mkdir` and this check (the EEXIST branch, and the swap window after a successful mkdir).
 * A created level is one we are entitled to be strict about: a healthy one is ours and owner-only
 * (or at worst umask-loose 0755), so anything owned by someone else, or group/world-writable, is
 * an entry we did not make. Symlink and non-directory keep their existing dedicated wording
 * (tests and users key on it); ownership and shared-writability are the additions.
 */
function refuseUntrustedCreatedComponent(refusal: string, component: string, st: fs.Stats): void {
  if (st.isSymbolicLink()) {
    refuseSymlinkParent(refusal, component);
  }
  if (!st.isDirectory()) {
    refuseNonDirParent(refusal, component);
  }
  const reason = untrustedDirStatReason(st, component, `${refusal}: parent directory`, {
    requireOwned: true,
    refuseSharedWritable: true,
  });
  if (reason) {
    throw new Error(`${reason} (nothing was written inside it)`);
  }
}

/**
 * Validate (and create where missing) the chain leading to `dir` — see the numbered discipline on
 * safeWriteFileAtomic. Beneath an establishTrustedDir boundary every component below the boundary
 * is lstat-verified (existing) or created one level at a time and verified (missing). WITHOUT a
 * boundary the WHOLE chain from the filesystem root is verified FIRST — before anything is created
 * — not just the final parent: a LOGICAL path through a repointed ancestor (`hop/sub/home/x`,
 * boundary established at canonical `A/sub/home`) does not prefix-match the boundary, so none is
 * found for it, and a final-parent-only check would write into the link's target.
 *
 * Nothing is EVER created through an intermediate symlink: a recursive mkdir would resolve the
 * whole chain in the kernel and happily materialize the tail inside a link's target, so missing
 * levels are made one at a time and each one is lstat-verified after creation (a level raced in
 * between the mkdir and the check is refused, not followed).
 *
 * WITHOUT a boundary the ancestor-trust invariant applies to the whole pre-existing chain (the
 * walk above enforces it) AND to the FINAL containing directory itself, whether it already exists
 * or is the deepest pre-existing ancestor of a chain we are about to build. That final check is
 * the one that stops the plain "the parent is already there, mode 0777, non-sticky" case, where a
 * symlink/non-directory check alone sees nothing wrong and the database, the vault key and the
 * journal checkpoint would be created inside it. Every level this call CREATES (or that races in)
 * is then held to the strict owner-only rule above.
 */
function ensureTrustedDirChain(dir: string, refusal: string, mode?: number): void {
  const mkdirOpts = mode === undefined ? undefined : { mode };
  const boundary = trustedBoundaryFor(dir);
  if (boundary !== undefined) {
    let current = boundary;
    const parts = dir === boundary ? [] : containedRelative(boundary, dir, refusal).split(path.sep);
    for (const part of parts) {
      current = path.join(current, part);
      let st: fs.Stats | undefined;
      try {
        st = fs.lstatSync(current);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw err;
        }
      }
      if (st === undefined) {
        try {
          fs.mkdirSync(current, mkdirOpts);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw err;
          }
          // raced — validated below like any pre-existing entry
        }
        st = fs.lstatSync(current);
        // Created (or raced in) just now: strict — see refuseUntrustedCreatedComponent.
        refuseUntrustedCreatedComponent(refusal, current, st);
        continue;
      }
      if (st.isSymbolicLink()) {
        refuseSymlinkParent(refusal, current);
      }
      if (!st.isDirectory()) {
        refuseNonDirParent(refusal, current);
      }
    }
    return;
  }
  // No established boundary: validate the ENTIRE chain from the filesystem root before anything
  // is created or written, so a symlinked ancestor at any depth is refused rather than followed.
  const chainReason = untrustedAncestorChainReason(dir, refusal, 'write');
  if (chainReason) {
    throw new Error(`${chainReason} (nothing was modified)`);
  }
  const { existing, stat, missing } = deepestExisting(dir);
  if (missing.length === 0) {
    if (stat.isSymbolicLink()) {
      refuseSymlinkParent(refusal, dir);
    }
    if (!stat.isDirectory()) {
      refuseNonDirParent(refusal, dir);
    }
    // The directory ALREADY EXISTS and is where the caller's file is about to be created. It is
    // not ours to chmod, so it is checked: this is the "existing 0777 non-sticky parent" case.
    const contextReason = unsafeCreationContextReason(stat, dir, refusal);
    if (contextReason) {
      throw new Error(`${contextReason} (nothing was modified)`);
    }
    return;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(
      `${refusal}: ancestor directory ${existing} is a symlink (possible hijack) — create the destination directory yourself and retry (nothing was modified)`,
    );
  }
  if (!stat.isDirectory()) {
    refuseNonDirParent(refusal, existing);
  }
  // BEFORE the first mkdir: the context the missing levels would be created inside must be safe.
  const contextReason = unsafeCreationContextReason(stat, existing, refusal);
  if (contextReason) {
    throw new Error(`${contextReason} (nothing was modified)`);
  }
  let current = existing;
  for (const part of missing) {
    current = path.join(current, part);
    try {
      fs.mkdirSync(current, mkdirOpts);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }
    }
    refuseUntrustedCreatedComponent(refusal, current, fs.lstatSync(current));
  }
}

/** The write-target form: `dir` is the parent of `target`, created with the platform default mode
 *  (the same bits a plain `mkdir` produces). */
function ensureTrustedParentChain(dir: string, target: string): void {
  ensureTrustedDirChain(dir, `refusing to write ${target}`);
}

/**
 * PUBLIC, for DIRECT callers of a path-based opener that must ensure the file's containing
 * directory exists themselves (SqliteDriver.open, NodeCrypto.open). It is the creating counterpart
 * of assertTrustedContainingDirReadOnly, and it exists so those call sites never reach for
 * `fs.mkdirSync(dir, { recursive: true })`: a recursive mkdir resolves the whole chain in the
 * kernel, so a symlinked ancestor at any depth would have the directory — and then the database or
 * the vault key inside it — materialized in a tree that was never validated.
 *
 * `refusal` prefixes every message ("refusing to open the memory database"); `opts.mode` is the
 * mode for levels this call creates. Returns the validated containing directory.
 */
export function ensureTrustedContainingDir(
  file: string,
  refusal: string,
  opts: { mode?: number } = {},
): string {
  const dir = path.dirname(path.resolve(file));
  ensureTrustedDirChain(dir, refusal, opts.mode);
  return dir;
}

/**
 * Write `content` to `target` with the full hardened-write discipline (the same family as
 * clients/adapter.ts atomicWrite and clients/launcher.ts persistLauncher):
 *
 * 1. the parent chain must be REAL directories (lstat — a symlinked parent OR EARLIER ANCESTOR
 *    would land the temp file and the rename in an attacker-chosen tree). Beneath an
 *    establishTrustedDir boundary (the home) EVERY component below the boundary is validated;
 *    outside a boundary the WHOLE chain from the filesystem root is validated, and every level
 *    created beneath the deepest existing ancestor is verified after creation. HONEST RESIDUAL: these are path-based lstat checks — a
 *    component swapped for a symlink between its check and the moment the kernel resolves the
 *    temp-file open or the rename can still redirect one operation; the 0700 boundary is what
 *    excludes the unprivileged attacker who could attempt that;
 * 2. the target must be absent or a regular, single-hard-link file owned by us that is not
 *    group/world-writable — NEVER a symlink (nothing is followed, nothing external can be
 *    reached through the path);
 * 3. the bytes go into an exclusive-create ('wx') RANDOM temp name in the SAME directory — a
 *    preplanted file or symlink at any predictable temp path is moot, and an actual collision
 *    regenerates the name rather than reusing the squatter;
 * 4. the temp file is atomically renamed over the target — rename replaces the path and never
 *    follows a link, so even a target swapped in after validation cannot redirect the write
 *    into an external file.
 *
 * Mode: `opts.mode` when given; otherwise an existing target keeps its current permission bits
 * and a NEW file is created 0600 (owner-only — callers that want a shareable file, e.g. pack
 * exports meant for other tools, pass an explicit mode). Pinned via fchmod on the open fd
 * (POSIX; skipped on Windows where modes are meaningless).
 *
 * Throws with an actionable message on any refusal; on failure the target is untouched and the
 * temp file is best-effort removed.
 */
export function safeWriteFileAtomic(
  target: string,
  content: string,
  opts: { mode?: number } = {},
): void {
  const dir = path.dirname(path.resolve(target));
  ensureTrustedParentChain(dir, target);
  // ONE lstat: it both validates the target and supplies the mode an existing file keeps. Asking
  // the pathname a second time for the mode would read it off whatever occupies the name at that
  // instant — a file swapped in between the two carries bits nothing validated, and the mode is
  // exactly what decides who can read the vault key, the token or the ledger we are about to
  // write. Absent is the healthy creation case and yields the owner-only default.
  let present: fs.Stats | undefined;
  try {
    present = fs.lstatSync(target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw new Error(
        `refusing to write: write target at ${target} could not be inspected (${code ?? 'unknown error'}) — refusing to use it`,
      );
    }
  }
  if (present !== undefined) {
    const reason = untrustedStatReason(present, target, 'write target', {});
    if (reason) {
      throw new Error(`refusing to write: ${reason}`);
    }
  }
  // An existing file keeps the bits that were just validated; a new file is owner-only.
  const mode = opts.mode ?? (present === undefined ? 0o600 : present.mode & 0o777);
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    const tmp = path.join(
      dir,
      `.${path.basename(target)}.${crypto.randomBytes(6).toString('hex')}.sthayi-tmp`,
    );
    let fd: number | undefined;
    try {
      fd = fs.openSync(tmp, 'wx', mode);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        continue; // collision with a squatting file/symlink — regenerate, never reuse
      }
      throw err;
    }
    try {
      fs.writeSync(fd, content);
      if (process.platform !== 'win32') {
        fs.fchmodSync(fd, mode); // openSync mode is umask-filtered; pin it exactly
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
 * Open `p` for APPEND (creating it `mode`, default 0600) without ever following a symlink:
 * O_NOFOLLOW where the platform has it, an lstat gate where it does not (Windows), and the
 * trust checks repeated via fstat ON THE OPEN FD — a hard-linked or foreign-owned file is
 * refused even if it was swapped in after any path-based check. Returns the fd; the caller
 * writes and closes. Throws on refusal (callers like the logger deliberately swallow — a
 * refused log target means the line is dropped, never written through the link).
 */
export function openAppendNoFollow(p: string, mode = 0o600): number {
  if (O_NOFOLLOW === 0) {
    // no O_NOFOLLOW on this platform — the lstat gate is the best available guard
    assertTrustedFile(p, 'append target', { modePolicy: 'ignore' });
  }
  let fd: number;
  try {
    fd = fs.openSync(
      p,
      fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | O_NOFOLLOW,
      mode,
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error(
        `append target at ${p} is a symlink (possible hijack) — refusing to follow it; replace it with a regular file or delete it`,
      );
    }
    throw err;
  }
  try {
    // Mode policy 'ignore': loosened permission bits on an existing log are repaired territory,
    // not a redirect vector — the symlink/hard-link/ownership checks are what stop a hijack.
    const reason = untrustedStatReason(fs.fstatSync(fd), p, 'append target', {
      modePolicy: 'ignore',
    });
    if (reason) {
      throw new Error(reason);
    }
    return fd;
  } catch (err) {
    try {
      fs.closeSync(fd);
    } catch {
      // already closed
    }
    throw err;
  }
}
