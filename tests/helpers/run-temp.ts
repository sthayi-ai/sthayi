import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type Identity,
  RUN_IDENTITY_ENV,
  RUN_MARKER,
  RUN_ROOT_ENV,
  RUN_TOKEN_ENV,
  creationIdentity,
  decodeIdentity,
  describeMode,
  identityFromBigStat,
  isPrivateMode,
  recordAllocatedDir,
  recordRunFixture,
  sameIdentity,
  trackOwned,
} from './owned-fs.js';

/**
 * Allocate a scratch directory that belongs to THIS test run.
 *
 * Every fixture goes through here rather than calling `fs.mkdtempSync(os.tmpdir(), …)` directly.
 * That is what makes the run's teardown safe: it removes one root it created and proved it owns,
 * instead of scanning a shared temp directory for names that look like ours — a scan that cannot
 * distinguish our fixtures from a concurrent run's, or from a live `sthayi` process's.
 *
 * FALLBACK IS NOT A RECOVERY PATH. Falling back to the system temp root is legitimate for exactly
 * one situation: no run root was ever published (a single file run without globalSetup, or this
 * helper imported outside vitest). If a run root WAS published and the directory is now missing,
 * a symlink, or a different directory wearing the same name, that is a hostile or broken state —
 * quietly writing fixtures into the shared temp root instead would scatter vault keys and
 * databases outside anything the teardown will ever clean, so it FAILS CLOSED.
 *
 * IDENTITY COMES FROM THE ENVIRONMENT, NOT FROM THE DIRECTORY. The token and the full ephemeral
 * tuple are published by globalSetup at creation time. Reading a marker out of the directory and
 * trusting it would let an ordinary replacement vouch for itself — it can carry a marker too. The
 * independently published tuple prevents that self-vouching when it differs. It is not a filesystem
 * generation: a replacement completed before the first open that collides on the entire tuple and
 * copies the token is indistinguishable. After the POSIX open, the retained descriptor pins one
 * object against the observed same-layer recycling; Windows retains a weaker path-only proof.
 *
 * VALIDATING A PATHNAME AUTHORISES NOTHING LATER. `mkdtemp` resolves the parent path again, inside
 * the call, after every check here has already returned; a same-uid process sharing the system
 * temp root can move that name onto a symlink in between, and the fixture — a vault key, a store,
 * a journal — is then created inside whatever the link points at. Portable Node has no `mkdirat`,
 * so the window cannot be closed. Substitution AFTER the POSIX descriptor is opened is made
 * detectable for the tested same-layer ABA: the root's pinned identity is re-proved after the child
 * exists, and the child is required to sit directly beneath that object. A fixture is returned only
 * when both hold. The pre-open full-tuple collision above remains an explicit residual.
 *
 * ALLOCATION IS WHAT MAKES TEARDOWN POSSIBLE. A directory sitting under the run root proves nothing
 * about who created it, so every fixture that survives the checks below is RECORDED — the full
 * identity captured inside its creating call, after comparison with the containment stat, goes into
 * a ledger inside the run root.
 * Teardown descends into a child only when its name is in that ledger and the inode standing at
 * that name is the recorded one. Without this, teardown would be back to trusting a pathname: a
 * directory swapped in at a fixture's name would be walked and emptied on the strength of the name
 * alone. The ledger lives in the run root because fixtures are allocated in vitest WORKER processes
 * and the root is torn down in the parent, so the record has to cross a process boundary; the root
 * is private, owned by this uid, and itself proved by an identity published in the environment.
 *
 * The result is REALPATH'd: on macOS the temp root is reached through `/var -> private/var`, and
 * fs-safe binds trust boundaries to canonical paths, so a non-canonical fixture would be refused
 * for the wrong reason. Canonicalising is also what makes the containment proof meaningful — the
 * check is on resolved paths and on device/inode, never on the textual path that was requested.
 */

/**
 * The run root as validated: its canonical path and the inode that path resolved to.
 *
 * On POSIX `fd` pins that inode until the allocation, both ledger writes and the in-process record
 * are complete. Keeping it open matters even though every check also compares the full ephemeral
 * identity: the tested Linux overlayfs can recycle dev, ino AND birthtimeNs immediately after the
 * last handle disappears. A live descriptor pins one object and blocks that observed same-layer
 * delete/recreate ABA during this allocation. It does not turn overlayfs identifiers into a
 * universal filesystem generation guarantee. Windows cannot open a directory this way through
 * portable Node and therefore retains the documented path-only proof.
 */
interface ValidatedRoot {
  canonical: string;
  id: Identity;
  fd?: number;
}

const O_DIRECTORY = (fs.constants as unknown as Record<string, number | undefined>).O_DIRECTORY;
const O_NOFOLLOW = (fs.constants as unknown as Record<string, number | undefined>).O_NOFOLLOW;

function closeRootPin(fd: number | undefined): void {
  if (fd === undefined) return;
  try {
    fs.closeSync(fd);
  } catch {
    // A failed validation must keep its original refusal. The OS still closes the descriptor when
    // this short-lived test worker exits; there is no pathname operation to attempt as a fallback.
  }
}

function assertCurrentRunRoot(root: string): ValidatedRoot {
  const expectedToken = process.env[RUN_TOKEN_ENV];
  const expectedIdentity = decodeIdentity(process.env[RUN_IDENTITY_ENV]);
  if (!expectedToken || expectedIdentity === null) {
    throw new Error(
      `${RUN_ROOT_ENV} is set to ${root} but ${RUN_TOKEN_ENV}/${RUN_IDENTITY_ENV} are not — refusing to allocate a fixture against a run root whose identity was never published`,
    );
  }

  // POSIX: bind the proof to one object BEFORE trusting any pathname-derived state. The open is
  // both O_DIRECTORY (a non-directory is refused in the kernel) and O_NOFOLLOW (a final symlink is
  // refused rather than resolved). Its fstat supplies the authoritative identity, ownership and
  // privacy facts, and the descriptor remains live until runTempDir's finally block.
  let fd: number | undefined;
  let held: fs.BigIntStats | undefined;
  let heldIdentity: Identity | undefined;
  try {
    if (process.platform !== 'win32') {
      if (O_DIRECTORY === undefined || O_NOFOLLOW === undefined) {
        throw new Error(
          `test run root ${root} cannot be pinned because this POSIX runtime exposes no O_DIRECTORY/O_NOFOLLOW — refusing path-only allocation`,
        );
      }
      try {
        fd = fs.openSync(root, fs.constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
        held = fs.fstatSync(fd, { bigint: true });
      } catch (err) {
        closeRootPin(fd);
        fd = undefined;
        // This lookup authorises nothing; it only preserves the precise refusal for an already
        // visible symlink/non-directory. No allocation follows an unsuccessful descriptor open.
        const visible = fs.lstatSync(root, { bigint: true, throwIfNoEntry: false });
        if (visible?.isSymbolicLink() === true) {
          throw new Error(`test run root ${root} is a symlink — refusing to follow it`);
        }
        if (visible !== undefined && !visible.isDirectory()) {
          throw new Error(`test run root ${root} is not a directory — refusing to use it`);
        }
        throw new Error(
          `${RUN_ROOT_ENV} is set to ${root} but it could not be inspected and pinned (${(err as NodeJS.ErrnoException).code ?? 'unknown'}) — refusing to fall back to the shared temp root`,
        );
      }
      const descriptorIdentity = identityFromBigStat(held);
      if (
        !held.isDirectory() ||
        descriptorIdentity === null ||
        !sameIdentity(descriptorIdentity, expectedIdentity)
      ) {
        throw new Error(
          `test run root ${root} is no longer the directory this run created (its incarnation changed) — refusing to use it`,
        );
      }
      heldIdentity = descriptorIdentity;
      if (typeof process.getuid === 'function' && Number(held.uid) !== process.getuid()) {
        throw new Error(
          `test run root ${root} is owned by uid ${held.uid}, not this process — refusing to use it`,
        );
      }
      if (!isPrivateMode(Number(held.mode))) {
        throw new Error(
          `test run root ${root} is mode ${describeMode(Number(held.mode))} — refusing to allocate fixtures in a group- or world-accessible run root`,
        );
      }
    }

    // lstat, never stat: the pathname must still name the object the descriptor pins. On Windows
    // this remains the primary (weaker) path-only validation because the portable
    // O_DIRECTORY|O_NOFOLLOW descriptor proof is unavailable.
    let st: fs.BigIntStats;
    try {
      st = fs.lstatSync(root, { bigint: true });
    } catch (err) {
      throw new Error(
        `${RUN_ROOT_ENV} is set to ${root} but it could not be inspected (${(err as NodeJS.ErrnoException).code ?? 'unknown'}) — refusing to fall back to the shared temp root`,
      );
    }
    if (st.isSymbolicLink()) {
      throw new Error(`test run root ${root} is a symlink — refusing to follow it`);
    }
    if (!st.isDirectory()) {
      throw new Error(`test run root ${root} is not a directory — refusing to use it`);
    }
    if (typeof process.getuid === 'function' && Number(st.uid) !== process.getuid()) {
      throw new Error(
        `test run root ${root} is owned by uid ${st.uid}, not this process — refusing to use it`,
      );
    }
    const standing = identityFromBigStat(st);
    if (
      standing === null ||
      !sameIdentity(standing, expectedIdentity) ||
      (heldIdentity !== undefined && !sameIdentity(standing, heldIdentity))
    ) {
      throw new Error(
        `test run root ${root} is no longer the directory this run created (its incarnation changed) — refusing to use it`,
      );
    }
    // Fixtures hold vault keys and stores. A group- or world-accessible root exposes them and lets a
    // second account plant entries this run would treat as its own, so privacy is a precondition of
    // allocation, not a property assumed from however the root was first created.
    if (!isPrivateMode(Number(st.mode))) {
      throw new Error(
        `test run root ${root} is mode ${describeMode(Number(st.mode))} — refusing to allocate fixtures in a group- or world-accessible run root`,
      );
    }
    // Secondary only: the descriptor/environment identity checks already excluded a replacement
    // during this allocation. A replacement completed before the descriptor open that collides on
    // the entire ephemeral tuple remains indistinguishable; the token cannot repair that because a
    // same-uid peer can copy it. The allocation test pins that residual explicitly.
    let marker: string;
    try {
      marker = fs.readFileSync(path.join(root, RUN_MARKER), 'utf8');
    } catch {
      throw new Error(`test run root ${root} has no run marker — refusing to use it`);
    }
    if (!marker.includes(expectedToken)) {
      throw new Error(`test run root ${root} carries a different run's token — refusing to use it`);
    }

    // Allocation targets the CANONICAL root, and the canonical path must resolve to the same inode
    // held by the descriptor (POSIX) or checked above (Windows). A symlinked ancestor may choose the
    // spelling, but it cannot change the object that this allocation accepts.
    let canonical: string;
    try {
      canonical = fs.realpathSync(root);
    } catch (err) {
      throw new Error(
        `test run root ${root} could not be canonicalised (${(err as NodeJS.ErrnoException).code ?? 'unknown'}) — refusing to use it`,
      );
    }
    const canonicalStat = fs.lstatSync(canonical, { bigint: true });
    const canonicalIdentity = identityFromBigStat(canonicalStat);
    if (
      canonicalIdentity === null ||
      !sameIdentity(canonicalIdentity, standing) ||
      (heldIdentity !== undefined && !sameIdentity(canonicalIdentity, heldIdentity))
    ) {
      throw new Error(
        `test run root ${root} canonicalises to ${canonical}, which is a different directory — refusing to use it`,
      );
    }
    return { canonical, id: standing, fd };
  } catch (err) {
    closeRootPin(fd);
    throw err;
  }
}

/**
 * Re-prove the object pinned at the beginning and the pathname that all recording used.
 *
 * This runs after both ledgers and the in-process ownership record are complete. The descriptor
 * keeps one object alive and blocks the ordinary same-layer recycling reproduced on the tested
 * Linux overlayfs. The final fstat/path comparison still depends on that filesystem's reported
 * identifiers; this is not a universal generation guarantee.
 */
function assertPinnedRootStillPublished(root: ValidatedRoot): void {
  let held: fs.BigIntStats | undefined;
  let standing: fs.BigIntStats;
  try {
    if (root.fd !== undefined) {
      held = fs.fstatSync(root.fd, { bigint: true });
    }
    standing = fs.lstatSync(root.canonical, { bigint: true });
  } catch (err) {
    throw new Error(
      `test run root ${root.canonical} could not be re-proved after recording an allocation (${(err as NodeJS.ErrnoException).code ?? 'unknown'}) — refusing to return the fixture`,
    );
  }
  const heldIdentity = held === undefined ? undefined : identityFromBigStat(held);
  const standingIdentity = identityFromBigStat(standing);
  const ownerOkay =
    typeof process.getuid !== 'function' ||
    (Number(standing.uid) === process.getuid() &&
      (held === undefined || Number(held.uid) === process.getuid()));
  if (
    (held !== undefined && !held.isDirectory()) ||
    (held !== undefined &&
      (heldIdentity === null ||
        heldIdentity === undefined ||
        !sameIdentity(heldIdentity, root.id))) ||
    standing.isSymbolicLink() ||
    !standing.isDirectory() ||
    standingIdentity === null ||
    !sameIdentity(standingIdentity, root.id) ||
    (heldIdentity !== undefined &&
      heldIdentity !== null &&
      !sameIdentity(standingIdentity, heldIdentity)) ||
    !ownerOkay ||
    (held !== undefined && !isPrivateMode(Number(held.mode))) ||
    !isPrivateMode(Number(standing.mode))
  ) {
    throw new Error(
      `test run root ${root.canonical} changed while its allocation was being recorded — refusing to return the fixture`,
    );
  }
}

/**
 * Remove one refused fixture only while both its carried identity and its pinned parent still hold.
 *
 * Recording can fail after mkdtemp succeeds. Returning is forbidden, but leaving an empty directory
 * on every ordinary I/O error is unnecessary. This is deliberately one non-recursive rmdir: a
 * substituted non-empty directory is not entered, and a parent substitution suppresses the call.
 */
function unwindRefusedFixture(fixture: { path: string; id: Identity }, root: ValidatedRoot): void {
  try {
    assertPinnedRootStillPublished(root);
  } catch {
    return; // the parent path no longer names the pinned root; delete nothing through it
  }
  if (path.dirname(fixture.path) !== root.canonical) return;
  let st: fs.BigIntStats;
  try {
    st = fs.lstatSync(fixture.path, { bigint: true });
  } catch {
    return; // already gone or unreadable
  }
  const standing = identityFromBigStat(st);
  if (
    st.isSymbolicLink() ||
    !st.isDirectory() ||
    standing === null ||
    !sameIdentity(standing, fixture.id) ||
    (typeof process.getuid === 'function' && Number(st.uid) !== process.getuid()) ||
    !isPrivateMode(Number(st.mode))
  ) {
    return; // not the empty directory this allocation proved; leak rather than touch it
  }
  try {
    assertPinnedRootStillPublished(root);
  } catch {
    return; // the parent changed after the child proof; do not redirect even this bounded rmdir
  }
  try {
    // Never descends. A non-empty substitute is refused; an empty substitute that wins after the
    // final proofs can still lose this one entry, the documented last-instant residual.
    fs.rmdirSync(fixture.path);
  } catch {
    // leaked rather than escalated to any forceful cleanup
  }
}

/**
 * Prove the freshly created child really is a child of the root that was validated, and hand back
 * its canonical path.
 *
 * Two independent statements, both required:
 *   1. the run-root pathname STILL matches the retained POSIX object — same full ephemeral tuple,
 *      still a real directory, ours and private. This detects the tested same-layer substitution
 *      after the descriptor opened; Windows has only the weaker path check and exact ABA residual;
 *   2. the child's CANONICAL path is directly beneath the root's canonical path, and the directory
 *      that canonical parent names is that same inode. Comparing resolved paths defeats a symlink
 *      swapped in at the root name (the child then canonicalises into the link's target, not under
 *      the root), and comparing device/inode defeats a directory swapped in at the root name.
 *
 * A failure REFUSES. Cleanup is centralised in `unwindRefusedFixture`, which carries the identity
 * captured inside mkdtemp and re-proves both the pinned parent and that exact child immediately
 * before one non-recursive rmdir. When either proof is lost, the empty stray is left deliberately.
 */
function assertChildOfRunRoot(child: string, root: ValidatedRoot): { path: string; id: Identity } {
  let rootNow: fs.BigIntStats;
  try {
    rootNow = fs.lstatSync(root.canonical, { bigint: true });
  } catch (err) {
    throw new Error(
      `test run root ${root.canonical} could not be re-inspected after allocating ${child} (${(err as NodeJS.ErrnoException).code ?? 'unknown'}) — refusing to use the fixture`,
    );
  }
  const rootIdentity = identityFromBigStat(rootNow);
  const rootIntact =
    !rootNow.isSymbolicLink() &&
    rootNow.isDirectory() &&
    rootIdentity !== null &&
    sameIdentity(rootIdentity, root.id) &&
    isPrivateMode(Number(rootNow.mode)) &&
    (typeof process.getuid !== 'function' || Number(rootNow.uid) === process.getuid());
  if (!rootIntact) {
    throw new Error(
      `test run root ${root.canonical} was replaced while ${child} was being allocated — refusing to use a fixture whose parent changed under it`,
    );
  }

  const refuse = (message: string): never => {
    throw new Error(message);
  };

  let realChild: string;
  try {
    realChild = fs.realpathSync(child);
  } catch (err) {
    return refuse(
      `fixture ${child} could not be canonicalised (${(err as NodeJS.ErrnoException).code ?? 'unknown'}) — refusing to use it`,
    );
  }
  const parent = path.dirname(realChild);
  if (parent !== root.canonical) {
    return refuse(
      `fixture ${child} resolved to ${realChild}, which is not directly beneath the run root ${root.canonical} — refusing to use a fixture allocated outside the validated root`,
    );
  }
  // Both of these describe paths that were readable moments ago, so a failure here is an ordinary
  // error rather than an attack — and it must still unwind, not strand a fixture nothing sweeps.
  let parentStat: fs.BigIntStats;
  let childStat: fs.BigIntStats;
  try {
    parentStat = fs.lstatSync(parent, { bigint: true });
    childStat = fs.lstatSync(realChild, { bigint: true });
  } catch (err) {
    return refuse(
      `fixture ${realChild} and its parent could not be re-inspected (${(err as NodeJS.ErrnoException).code ?? 'unknown'}) — refusing to use it`,
    );
  }
  const parentIdentity = identityFromBigStat(parentStat);
  if (parentIdentity === null || !sameIdentity(parentIdentity, root.id)) {
    return refuse(
      `fixture ${child} resolved to ${realChild}, whose parent is not the validated run-root incarnation — refusing to use a fixture allocated outside the validated root`,
    );
  }
  if (childStat.isSymbolicLink() || !childStat.isDirectory()) {
    return refuse(`fixture ${realChild} is not a real directory — refusing to use it`);
  }
  if (typeof process.getuid === 'function' && Number(childStat.uid) !== process.getuid()) {
    return refuse(
      `fixture ${realChild} is owned by uid ${childStat.uid.toString()}, not this process — refusing to use it`,
    );
  }
  if (!isPrivateMode(Number(childStat.mode))) {
    return refuse(
      `fixture ${realChild} is mode ${describeMode(Number(childStat.mode))} — refusing to use a group- or world-accessible fixture`,
    );
  }
  // Return the identity from the containment stat so the caller can compare it with the identity
  // captured inside mkdtemp. Only the carried creation identity is written into the ledgers.
  const childIdentity = identityFromBigStat(childStat);
  if (childIdentity === null) {
    return refuse(
      `fixture ${realChild} has no stable creation-time discriminator — refusing cleanup authority`,
    );
  }
  return { path: realChild, id: childIdentity };
}

/** Canonicalise a directory just created here, removing it if that fails rather than leaking it. */
function canonicaliseOrUnwind(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch (err) {
    try {
      fs.rmdirSync(dir); // still empty: mkdtemp only just made it
    } catch {
      // leaked rather than force-removed
    }
    throw err;
  }
}

export function runTempDir(prefix: string): string {
  const root = process.env[RUN_ROOT_ENV];
  if (root === undefined || root === '') {
    // Genuinely no run root published — the only case the shared temp root is acceptable. There is
    // no run root to hold a ledger, so the record is kept in this process only; that is enough,
    // because without a run root there is no cross-process teardown either.
    return trackOwned(canonicaliseOrUnwind(fs.mkdtempSync(path.join(os.tmpdir(), prefix))));
  }
  const validated = assertCurrentRunRoot(root); // throws BEFORE any mkdtemp
  let allocated: { path: string; id: Identity } | undefined;
  try {
    const child = fs.mkdtempSync(path.join(validated.canonical, prefix));
    // Carry the identity captured inside the wrapped mkdtemp call. If any later proof or recording
    // throws, cleanup must describe what the creating call saw, not re-mint authority from the name.
    const created = creationIdentity(child);
    if (created === undefined) {
      throw new Error(
        `fixture ${child} has no identity captured by its creating call — refusing to record or return it`,
      );
    }
    allocated = { path: child, id: created };
    const proven = assertChildOfRunRoot(child, validated);
    if (!sameIdentity(proven.id, created)) {
      throw new Error(
        `fixture ${child} is no longer the directory its creating call identified — refusing to record or return it`,
      );
    }
    const fixture = { path: proven.path, id: created };
    allocated = fixture; // canonical spelling of the same carried identity
    // Recorded only after containment is proved, so the ledger never names anything that was
    // refused. The POSIX descriptor remains live across this append and the creation-ledger pin.
    recordRunFixture(validated.canonical, path.basename(fixture.path), fixture.id);
    // PINNED in the creation ledger as well, so a walk that reaches this fixture from ABOVE — a
    // teardown of the run root itself, rather than of this one allocation — enters it on the
    // identity recorded here and not on whatever inode later answers to the name. A pin is never
    // retired, so no directory standing at this name afterwards can inherit its authority.
    //
    // `fixture.id` is the identity captured inside mkdtemp and compared with the containment stat;
    // it is CARRIED into both records rather than looked up again. A second look-up would describe
    // whatever occupies the name by then, and a directory swapped in between proof and record could
    // otherwise be pinned as this run's own. Both calls check the carried value, and a mismatch is
    // fatal — a fixture that cannot be recorded is one teardown could never enter.
    if (!recordAllocatedDir(fixture.path, fixture.id)) {
      throw new Error(
        `fixture ${fixture.path} is no longer the directory that was just allocated there — refusing to record or return it`,
      );
    }
    // Nothing is claimed about what a fixture will come to HOLD. Allocating it says the run made
    // this directory; every entry that later appears inside it stands or falls on a receipt of its
    // own, so a fixture filled by a program this process cannot witness is refused at teardown and
    // leaks. Re-prove the descriptor/path pair only after every allocation record is complete.
    const tracked = trackOwned(fixture.path, fixture.id);
    assertPinnedRootStillPublished(validated);
    return tracked;
  } catch (err) {
    if (allocated !== undefined) {
      unwindRefusedFixture(allocated, validated);
    }
    throw err;
  } finally {
    // Closing only here keeps one root object alive through the whole allocation and blocks the
    // ordinary same-layer tuple recycling reproduced by the Linux overlayfs regression.
    closeRootPin(validated.fd);
  }
}
