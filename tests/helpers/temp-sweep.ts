import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  distIsCurrent,
  isIsolatedWindowsCiTestJob,
  prepareBuiltCliForIsolatedWindowsCi,
} from './build-cli.js';
import {
  type Guard,
  type Identity,
  RUN_DIRS,
  RUN_FIXTURES,
  RUN_IDENTITY_ENV,
  RUN_MARKER,
  RUN_ROOT_ENV,
  RUN_TOKEN_ENV,
  describeMode,
  duringWalk,
  emptyProvenDir,
  encodeIdentity,
  identityFromBigStat,
  isMissing,
  isPrivateMode,
  ownedByThisUid,
  proveDir,
  publishChildRecorder,
  readRunFixtures,
  receiptAuthorises,
  requireCreationIdentity,
  retireOwned,
  sameIdentity,
  syncDirLedger,
  trackOwned,
} from './owned-fs.js';

/**
 * Vitest globalSetup: give THIS RUN its own private temp root, and remove exactly that root
 * afterwards.
 *
 * The rule this file exists to obey: a test run may only ever delete directories it created
 * itself. Anything that decides what to delete by matching a SHARED NAME PREFIX in a SHARED temp
 * root is wrong, no matter how the set is narrowed — "entries that appeared during this run" also
 * describes a concurrent run's fixtures and a production `sthayi` process's scratch space, and
 * deleting those destroys live state belonging to someone else.
 *
 * So there is no scanning and no prefix matching here. The run gets one cryptographically named
 * root, every helper allocates beneath it (see below), and teardown removes that one tree entry by
 * entry after proving it is still the directory this process created.
 *
 * IDENTITY IS BOUND INSIDE CREATION, AND EVERYTHING ELSE IS BUILT ON IT. The wrapped exclusive
 * `mkdir` opens its result O_DIRECTORY|O_NOFOLLOW and captures the full ephemeral tuple before it
 * returns. Setup carries that receipt; it never mints authority from a later pathname lookup. On
 * POSIX setup then opens and retains its own descriptor as its first pathname operation, compares
 * it with the receipt, and keeps that object live through teardown. Workers still receive the
 * serialized tuple because they cannot inherit this descriptor.
 *
 * A NAME IS NOT A PERMIT, EVEN INSIDE THE ROOT, AND NOT AT ANY DEPTH. A directory sitting under the
 * run root proves nothing about who made it, and neither does one sitting four levels inside a
 * fixture. Fixtures are therefore RECORDED when they are allocated: `runTempDir()` writes each one's
 * full ephemeral tuple into a ledger in the root. Everything created INSIDE a fixture is recorded
 * the same way, at the call that creates it, in a second ledger keyed by the identity of the parent
 * it was made in (`RUN_DIRS`). Teardown enters a directory only when a record says this run made one
 * at that name, in that parent, with that inode. A recorded name occupied by a different inode
 * aborts teardown entirely.
 *
 * AND A RECORD IS STILL NOT A PERMIT TO EMPTY ANYTHING. `mkdir` returns no descriptor and portable
 * Node has no `mkdirat`, so a creation record is written from a NAME looked up after the syscall —
 * and a peer that destroys the new directory and stands an EMPTY one at that name in the interval
 * wears the exact shape a fresh `mkdir` produces. There is nothing left for a check to disagree
 * with, on any platform; the record then names the peer's directory, and this is reproduced
 * deterministically in `tests/safety/creation-window-substitution.test.ts` rather than argued about.
 * So the record buys the right to `rmdir` the directory it names once that directory is empty, and
 * nothing more. EVERY ENTRY INSIDE ANSWERS FOR ITSELF: a non-directory goes only on a RECEIPT this
 * run took at the successful syscall that named that exact entry, and a subdirectory only on its
 * own creation record. A directory-wide permission is never enough, because "the run wrote
 * something here" says nothing about the entries the run did not write. See `entryReceipts` in
 * owned-fs.ts.
 *
 * A PATHNAME IS NOT A CAPABILITY. The setup descriptor pins one run-root object locally, but every
 * destructive call still acts on a NAME after that pathname has been compared with the object (or
 * with its serialized receipt in another process). A same-uid process may move the name in that
 * final interval. Portable Node exposes no `openat`/`unlinkat`/`mkdirat`, so the check and pathname
 * operation are not atomic. The gap is kept narrow and its BLAST RADIUS is bounded below.
 *
 * NO RECURSIVE DELETION PRIMITIVE IS EVER INVOKED ON A PATHNAME. `fs.rmSync(p, {recursive:true})`
 * converts one lost race into the loss of an entire foreign tree, because the recursion is decided
 * inside the call, long after the last check. Teardown instead walks the tree it proved it owns and
 * removes one entry at a time: `unlinkSync` for files and symlinks (which removes the link, never
 * what it points at) and `rmdirSync` for directories it has already emptied (which fails rather
 * than descend). The root's device/inode, owner AND private mode are re-proved immediately before
 * every single removal, at every depth.
 *
 * WHAT THIS DOES AND DOES NOT PROMISE. It is not atomicity, and nothing here should be read as
 * claiming it. There are TWO residuals and they are different sizes; conflating them is how the
 * larger one stayed invisible, so they are named apart.
 *
 *   THE LAST-INSTANT RACE. A peer that wins the interval between the final re-proof and the syscall
 *     it authorised gets one SINGLE-ENTRY removal applied to whatever now answers to that name: one
 *     `unlink` of an entry this run holds a receipt for. It cannot cascade, because the walk holds
 *     no recursive primitive to cascade with.
 *   THE CAPTURE RACE, WHICH IS THE BIG ONE. A peer that substitutes an EMPTY directory in the
 *     interval between a `mkdir` returning and the recorder's first look gets a genuine creation
 *     record for its own directory — and it may then FILL that directory at leisure. Describing
 *     this as "one already-empty `rmdir`" is wrong: the record outlives the emptiness, and a walk
 *     that treated the record as content authority would empty whatever the peer put there. What
 *     stops it is that the record authorises the DIRECTORY and nothing in it, and every entry the
 *     peer adds is one this run never named and therefore never holds a receipt for.
 *
 * Entering a directory is not authorised by anything readable at teardown — not its name, not its
 * mode, not the inode standing there now — but only by a record written when this run created it,
 * and EMPTYING one is not authorised by that record either. Renaming the root aside before deleting
 * would improve on neither: the renamed tree faces the identical races, and the poisoned record was
 * written long before teardown began. So no such step pretends to.
 *
 * LEAKING BEATS DELETING SOMEONE ELSE'S DATA. Any identity mismatch, at any depth, aborts the walk
 * and leaves everything still standing exactly where it is. A stray temp directory is a nuisance a
 * human can delete; a destroyed vault key belonging to a concurrent run or a live `sthayi` process
 * is not recoverable.
 *
 * HOW EVERY HELPER LANDS INSIDE IT: the root is published in `STHAYI_TEST_RUN_ROOT`, and every
 * fixture allocates through `runTempDir()` (tests/helpers/run-temp.ts), which reads it. Workers
 * inherit the environment, so this holds across them.
 *
 * `TMPDIR` is deliberately NOT repointed. Doing so looks tidier — every `os.tmpdir()` call site
 * lands inside the root for free — but it also rewrites the temp directory for every CHILD PROCESS
 * a test spawns, and for the toolchain inside it. That is a behavioural change to the thing under
 * test, and it demonstrably hung a suite that spawns concurrent `tsx` writers. Isolation must not
 * be bought by altering the environment the tests are supposed to be observing.
 */

export {
  RUN_DIRS,
  RUN_FIXTURES,
  RUN_IDENTITY_ENV,
  RUN_MARKER,
  RUN_ROOT_ENV,
  RUN_TOKEN_ENV,
  describeMode,
  isPrivateMode,
};

/**
 * The SYSTEM temp root, captured once at import — before any run has repointed TMPDIR.
 *
 * Reading `os.tmpdir()` at setup() time would be self-referential: a second run starting while
 * this module has already repointed TMPDIR would allocate its root INSIDE the first run's root,
 * and the first teardown would then take the second run's tree with it. Roots must always be
 * siblings under the real system temp, never nested.
 *
 * realpath so the root is canonical: fs-safe binds trust boundaries to canonical paths, and a
 * non-canonical TMPDIR would make every fixture fail the ancestor check for the wrong reason.
 */
const SYSTEM_TEMP: string = (() => {
  const raw = os.tmpdir();
  try {
    return fs.realpathSync(raw);
  } catch {
    return raw;
  }
})();

/** The identity a directory must still have to be treated as this run's own. */
interface OwnedRoot extends Identity {
  token: string;
}

/**
 * Decide whether the path published as this run's root is still that directory, with no following
 * of anything: a real directory, private, owned by this process, the same full ephemeral tuple
 * recorded at creation, and carrying this run's token in its marker. `null` means "not ours" — which is also
 * the answer when it is simply already gone.
 */
function proveOwnedRunRoot(root: string, owned: OwnedRoot): fs.BigIntStats | null {
  const st = proveDir(root, owned, { requirePrivate: true });
  if (st === null) {
    return null;
  }
  let marker: string;
  try {
    marker = fs.readFileSync(path.join(root, RUN_MARKER), 'utf8');
  } catch {
    return null;
  }
  if (!marker.includes(owned.token)) {
    return null;
  }
  return st;
}

/**
 * Empty the run root itself, one entry at a time, honouring the ledger of what this run allocated.
 *
 * The run root is the one directory whose contents are NOT all this run's work: it is a shared
 * pathname in a shared temp root, so every child is classified before it is touched.
 *
 *   REGISTERED, IDENTITY INTACT — the fixture this run allocated. Walked entry by entry under the
 *     same rule at every depth — a subdirectory is entered only when the creation ledger says this
 *     run made one there, with that inode — then removed with a non-recursive `rmdir`.
 *   REGISTERED, IDENTITY CHANGED — a substitution: another directory, a symlink or a file now wears
 *     a name this run allocated. Nothing at that name is removed, deleted or followed, and the root
 *     is kept.
 *   UNREGISTERED DIRECTORY — never allocated here, so never walked and never removed. It is left
 *     exactly where it is, and the root leaks around it.
 *   UNREGISTERED FILE OR SYMLINK — removed only if this run holds a RECEIPT for that exact entry:
 *     the marker and the two ledgers the run itself writes here do; anything else does not. A
 *     receipt authorises one `unlink`, which removes the entry and never what a link points at, and
 *     it cannot cascade.
 *
 * A REFUSAL IS ABOUT ONE CHILD AND NOT ABOUT THE OTHERS. Each fixture carries its own recorded
 * identity, so an entry the sweep will not touch says nothing whatever about the fixture beside it.
 * Stopping the whole sweep at the first refusal would leave every LATER fixture standing on the
 * strength of an unrelated one — vault keys and stores abandoned in directories the run really did
 * prove it owns. So a refusal keeps its own child and the sweep goes on to the next; the root is
 * simply never emptied, and never removed, while anything at all is still standing in it.
 */
function emptyOwnedRunRoot(root: string, id: Identity, device: string, guard: Guard): boolean {
  // Read BEFORE the listing: the ledger decides what the listing is allowed to mean.
  const fixtures = readRunFixtures(root);
  if (!guard()) {
    return false;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return false;
  }
  // The names just read are only meaningful while the directory they came from is the one proved
  // owned. Re-prove between the listing and the first removal, so a swap that lands in that window
  // cannot make this loop operate on a stranger's entries.
  if (!guard()) {
    return false;
  }
  let intact = true;
  for (const entry of entries) {
    const child = path.join(root, entry.name);
    const registered = fixtures.get(entry.name);

    if (registered !== undefined) {
      const proved = proveDir(child, registered);
      if (proved === null || proved.dev.toString(10) !== device) {
        intact = false; // a substitution wearing an allocated name — refuse, and keep it
        continue;
      }
      if (!emptyProvenDir(child, registered, device, guard, 1)) {
        intact = false;
        continue;
      }
      if (!guard()) {
        return false; // the ROOT's own authority is gone: stop, and touch nothing further
      }
      if (proveDir(child, registered) === null) {
        intact = false;
        continue;
      }
      try {
        fs.rmdirSync(child); // emptied above; refuses if anything reappeared inside it
      } catch (err) {
        if (!isMissing(err)) {
          intact = false;
        }
      }
      continue;
    }

    let st: fs.BigIntStats;
    try {
      st = fs.lstatSync(child, { bigint: true });
    } catch (err) {
      if (isMissing(err)) {
        continue;
      }
      intact = false;
      continue;
    }
    if (!guard()) {
      return false;
    }
    if (st.isDirectory() && !st.isSymbolicLink()) {
      intact = false; // never allocated here, so never removed here; the root leaks with it
      continue;
    }
    // A file or symlink goes only on its OWN receipt, checked against the inode AND the kind
    // standing here now.
    if (!receiptAuthorises(id, entry.name, st)) {
      intact = false;
      continue;
    }
    try {
      fs.unlinkSync(child); // one entry; a symlink's target is never followed
    } catch (err) {
      if (!isMissing(err)) {
        intact = false;
      }
    }
  }
  return intact;
}

/**
 * Remove this run's own root, or nothing at all.
 *
 * Filesystem-state refusals return without escalating to forceful cleanup. A lower-level descriptor
 * close may still throw; lifecycle callers guard it so an unwind failure cannot replace the setup
 * error and teardown still closes the long-lived root pin.
 *
 * WHAT A LOST RACE HERE COSTS, AND THE UNIT IT IS COUNTED IN. Every removal is one non-recursive
 * `unlink`/`rmdir` of one name, issued after that name's identity has been re-proved, so a
 * replacement that lands in the interval between the proof and the syscall costs the single entry
 * that call was aimed at. THE BOUND IS PER UNLINK ATTEMPT AND NOT PER SWEEP: this walk makes one
 * attempt per entry, each opens its own interval, and a peer sharing this uid can win every one of
 * them — so the loss over a whole sweep reaches the number of attempted unlinks. What no single
 * attempt can ever do is take a TREE: `rmdir` refuses a directory that is not empty rather than
 * descending into it, and nothing on this path reaches for a recursive delete.
 */
function removeOwnedRunRoot(root: string, owned: OwnedRoot): void {
  const st = proveOwnedRunRoot(root, owned);
  if (st === null) {
    return;
  }
  // Fixtures are created in worker processes and this runs in the parent, so the records of what
  // those workers created are read in from the root's ledger before anything is entered. Read once,
  // here: an unread record makes the sweep refuse a directory, never adopt one.
  syncDirLedger(root);
  // Inode, owner and private mode, immediately before every destructive call at every depth: the
  // contract is that the root stays private for the WHOLE life of the run, teardown included, and a
  // root that turns group- or world-accessible mid-walk can no longer vouch for what is inside it.
  const guard: Guard = () => proveDir(root, owned, { requirePrivate: true }) !== null;
  duringWalk(() => {
    if (!emptyOwnedRunRoot(root, owned, st.dev.toString(10), guard)) {
      return;
    }
    if (!guard()) {
      return;
    }
    try {
      fs.rmdirSync(root); // empty by construction; refuses if anything reappeared inside it
      retireOwned(root);
    } catch {
      // Leaked on purpose: something is in the way, and forcing it would mean deleting blind.
    }
  });
}

/**
 * Vitest invokes this with its own GlobalSetupContext, which carries no `systemTemp`. The override
 * exists for the isolation test, which simulates two concurrent RUNS inside one process: there,
 * this module was imported by a worker whose TMPDIR is already a run root, so `SYSTEM_TEMP` would
 * nest the simulated roots instead of making them siblings. Production never passes it.
 */
interface SetupInvocation {
  systemTemp?: string;
  /** Vitest's GlobalSetupContext carries this function; direct fixture tests do not. */
  provide?: unknown;
}

export default function setup(invocation?: SetupInvocation): () => void {
  const isVitestGlobalSetup = typeof invocation?.provide === 'function';
  const base =
    typeof invocation?.systemTemp === 'string' && invocation.systemTemp.length > 0
      ? invocation.systemTemp
      : SYSTEM_TEMP;
  const token = crypto.randomBytes(12).toString('hex');
  const root = path.join(base, `sthayi-run-${process.pid}-${token}`);
  const previousRunRoot = process.env[RUN_ROOT_ENV];
  const previousToken = process.env[RUN_TOKEN_ENV];
  const previousIdentity = process.env[RUN_IDENTITY_ENV];
  const previousNodeOptions = process.env.NODE_OPTIONS;
  const restore = (key: string, prev: string | undefined): void => {
    if (prev === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prev;
    }
  };
  const restorePublishedEnvironment = (): void => {
    restore(RUN_ROOT_ENV, previousRunRoot);
    restore(RUN_TOKEN_ENV, previousToken);
    restore(RUN_IDENTITY_ENV, previousIdentity);
    restore('NODE_OPTIONS', previousNodeOptions);
  };

  // State is deliberately established inside ONE try. Any ordinary synchronous failure after the
  // exclusive mkdir restores the three-part environment, unwinds only entries whose receipts still
  // match, and closes the POSIX pin LAST. A replacement is leaked, never adopted or cleaned.
  let identity: Identity | undefined;
  let rootFd: number | undefined;
  let realRoot: string | undefined;

  const closePin = (): void => {
    if (rootFd === undefined) return;
    try {
      fs.closeSync(rootFd);
    } catch {
      // Neither setup failure nor teardown has a useful recovery from a close failure. The process
      // exit still releases it, and no pathname operation is attempted as a substitute.
    }
    rootFd = undefined;
  };

  /**
   * Prove both the pinned object and the pathname currently used to reach it.
   *
   * The descriptor keeps one object alive and blocks the ordinary same-layer recycling reproduced
   * on the tested Linux overlayfs. It is not a universal filesystem-generation guarantee. Windows
   * has no directory descriptor in portable Node, so it keeps the explicitly weaker path proof
   * while still comparing against the identity captured inside the mkdir wrapper.
   */
  const proveSetupRoot = (allowReceiptOnly = false): fs.BigIntStats | null => {
    if (identity === undefined) return null;
    const at = realRoot ?? root;
    const standing = proveDir(at, identity, { requirePrivate: true });
    if (standing === null) return null;
    if (rootFd === undefined) {
      // Normal POSIX setup never proceeds path-only. Failure unwind may use the identity captured
      // inside the mkdir wrapper when the subsequent open itself failed; that is real cleanup
      // authority, though it retains the explicitly documented pre-open full-tuple ABA residual.
      return process.platform === 'win32' || allowReceiptOnly ? standing : null;
    }
    try {
      const held = fs.fstatSync(rootFd, { bigint: true });
      const heldIdentity = identityFromBigStat(held);
      if (
        !held.isDirectory() ||
        !ownedByThisUid(held) ||
        !isPrivateMode(Number(held.mode)) ||
        heldIdentity === null ||
        !sameIdentity(heldIdentity, identity)
      ) {
        return null;
      }
      const standingIdentity = identityFromBigStat(standing);
      return standingIdentity !== null && sameIdentity(standingIdentity, heldIdentity)
        ? standing
        : null;
    } catch {
      return null;
    }
  };

  const replaced = (): Error =>
    new Error(
      `test run root ${root} was replaced while this run was creating it — refusing to adopt it`,
    );

  /**
   * Bounded setup unwind. The ordinary teardown handles a complete marker/ledger history. If setup
   * failed before that history became readable, only exact receipt-authorised harness entries are
   * unlinked, one at a time, while the root proof and POSIX descriptor still hold.
   */
  const unwind = (): void => {
    if (identity === undefined || proveSetupRoot(true) === null) return;
    const at = realRoot ?? root;

    // A valid marker lets the normal ownership-aware teardown do the whole job, including ledgers.
    removeOwnedRunRoot(at, { ...identity, token });
    if (proveSetupRoot(true) === null) return; // removed, or replaced while removal was attempted

    duringWalk(() => {
      for (const name of [RUN_MARKER, RUN_FIXTURES, RUN_DIRS]) {
        if (proveSetupRoot(true) === null) return;
        const child = path.join(at, name);
        let st: fs.BigIntStats;
        try {
          st = fs.lstatSync(child, { bigint: true });
        } catch (err) {
          if (isMissing(err)) continue;
          return;
        }
        if (!receiptAuthorises(identity as Identity, name, st) || proveSetupRoot(true) === null) {
          return; // a partial/unreceipted entry is not ours to remove
        }
        try {
          fs.unlinkSync(child);
        } catch (err) {
          if (!isMissing(err)) return;
        }
      }
      if (proveSetupRoot(true) === null) return;
      try {
        fs.rmdirSync(at); // empty by construction; refuses rather than descend
        retireOwned(at);
      } catch {
        // A foreign/unreceipted entry keeps the root standing, deliberately.
      }
    });
  };

  try {
    // Exclusive create: if this path somehow exists we must not adopt it. The wrapped mkdir captures
    // its identity from an O_DIRECTORY|O_NOFOLLOW descriptor before returning; carry that receipt
    // rather than minting authority from a later pathname lookup.
    fs.mkdirSync(root, { recursive: false, mode: 0o700 });
    identity = requireCreationIdentity(root);

    const directoryFlag = (fs.constants as unknown as Record<string, number | undefined>)
      .O_DIRECTORY;
    const noFollowFlag = (fs.constants as unknown as Record<string, number | undefined>).O_NOFOLLOW;
    let created: fs.BigIntStats;
    if (process.platform !== 'win32') {
      if (directoryFlag === undefined || noFollowFlag === undefined) {
        throw new Error(
          `test run root ${root} cannot be pinned because this POSIX runtime exposes no O_DIRECTORY/O_NOFOLLOW — refusing path-only setup`,
        );
      }
      // FIRST pathname operation after mkdir returns: open and hold exactly one directory object.
      rootFd = fs.openSync(root, fs.constants.O_RDONLY | directoryFlag | noFollowFlag);
      created = fs.fstatSync(rootFd, { bigint: true });
    } else {
      // Explicit weaker branch: Windows cannot open a directory through portable Node.
      created = fs.lstatSync(root, { bigint: true });
    }
    const createdIdentity = identityFromBigStat(created);
    if (
      created.isSymbolicLink() ||
      !created.isDirectory() ||
      !ownedByThisUid(created) ||
      createdIdentity === null ||
      !sameIdentity(createdIdentity, identity)
    ) {
      throw replaced();
    }
    if (!isPrivateMode(Number(created.mode))) {
      throw new Error(
        `test run root ${root} is mode ${describeMode(Number(created.mode))} — a run root must not be group- or world-accessible`,
      );
    }

    // A directory this process just created exclusively is EMPTY. Anything inside it means the name
    // now answers to a different directory. Re-prove after the listing so the listing cannot be
    // consumed after its parent name was swapped.
    if (fs.readdirSync(root).length > 0 || proveSetupRoot() === null) {
      throw replaced();
    }

    // mkdir's mode is masked by umask. On POSIX change the pinned object itself; Windows retains the
    // path operation and re-proves immediately afterwards.
    if (rootFd === undefined) {
      fs.chmodSync(root, 0o700);
    } else {
      fs.fchmodSync(rootFd, 0o700);
    }
    if (proveSetupRoot() === null) {
      throw replaced();
    }

    realRoot = fs.realpathSync(root);
    if (proveSetupRoot() === null) {
      throw new Error(
        `test run root ${root} canonicalises to ${realRoot}, which is a different directory — refusing to adopt it`,
      );
    }

    process.env[RUN_ROOT_ENV] = realRoot;
    process.env[RUN_TOKEN_ENV] = token;
    process.env[RUN_IDENTITY_ENV] = encodeIdentity(identity);

    // THE MARKER IS WRITTEN ONCE THE ROOT IS PUBLISHED, and the order is the point. A receipt for
    // this entry is persisted into the root's own ledger, so a fresh-process sweeper can prove it.
    fs.writeFileSync(path.join(realRoot, RUN_MARKER), `${process.pid}\n${token}\n`, {
      mode: 0o600,
    });
    if (proveSetupRoot() === null) {
      throw replaced();
    }

    // Carry the mkdir receipt; trackOwned must not discover authority from whatever stands here now.
    trackOwned(realRoot, identity);
    if (proveSetupRoot() === null) {
      throw replaced();
    }

    if (isVitestGlobalSetup && isIsolatedWindowsCiTestJob()) {
      // WINDOWS HAS NO flock/lockf. This is not a pathname-lock fallback: the workflow grants the
      // narrow flag only to one isolated Windows Actions Test step, and Vitest runs global setup
      // synchronously before dispatching collection to a worker. Publish the REAL child-recorder option
      // first so the build marker hashes the exact NODE_OPTIONS every worker inherits; recording a
      // build from the pre-setup environment would be stale on the first product test and would
      // send ensureBuiltCli() back to the unavailable POSIX lock path.
      const recorderOption = publishChildRecorder();
      const publishedOptions = (process.env.NODE_OPTIONS ?? '').split(/\s+/);
      if (recorderOption === undefined || !publishedOptions.includes(recorderOption)) {
        throw new Error(
          'isolated Windows CI setup could not publish the exact child recorder before preparing the CLI build',
        );
      }

      // The guarded helper runs the SAME contracted bundler and exact input/output marker path as
      // the POSIX locked child. It is safe without a lock only at this pre-worker point in the
      // isolated job. The helper consumes its one-shot authority before entering the section, so
      // a worker cannot inherit it and invoke the lock-free entry point later.
      prepareBuiltCliForIsolatedWindowsCi();
      if (!distIsCurrent()) {
        throw new Error(
          'isolated Windows CI setup prepared the CLI but its exact build record is not current',
        );
      }
    }
  } catch (err) {
    // Restore first so no caller can observe a half-published run, then unwind with explicit local
    // authority while the descriptor remains live. Close LAST and preserve the initiating error.
    restorePublishedEnvironment();
    try {
      unwind();
    } catch {
      // Unwind is best-effort. A cleanup syscall failure leaks the proved root, but it must not
      // replace the setup error that explains why no teardown callback was returned.
    } finally {
      closePin();
    }
    throw err;
  }

  return function teardown(): void {
    restorePublishedEnvironment();

    try {
      removeOwnedRunRoot(realRoot as string, { ...(identity as Identity), token });
    } catch {
      // Teardown cannot recover from a bookkeeping/descriptor error. Leak the root rather than
      // turning cleanup into a destructive fallback or replacing the suite's actual result.
    } finally {
      closePin();
    }
  };
}
