import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeHome } from '../helpers/fake-home.js';
import {
  type Identity,
  identityFromBigStat,
  recordAllocatedDir,
  recordedChildIdentity,
  removeOwned,
  requireCreationIdentity,
  trackOwned,
  wasCreatedThisRun,
} from '../helpers/owned-fs.js';
import {
  PeerFixtures,
  type PeerOperation,
  peerFs,
  runPeerOperations,
} from '../helpers/peer-fixtures.js';
import { runTempDir } from '../helpers/run-temp.js';

/**
 * SAFETY: a creation record must describe THE DIRECTORY THE CALL MADE, never the one standing at
 * the name afterwards.
 *
 * WHY THIS IS NOT A TIDINESS RULE. Teardown descends only into directories this run is recorded as
 * having created. That record is therefore a deletion permit, and the way to obtain one fraudulently
 * is to be the thing occupying a name at the instant the recorder looks. `mkdir` returns no handle
 * and `cp` reports nothing at all, so a recorder that answers "what is here now?" hands its permit
 * to whatever moved in — and the walk then empties a stranger's tree while reporting success.
 *
 * THE SECOND HARM IS TO THE EVIDENCE, AND IT IS WORSE. Nearly every hostile test in this repo
 * asserts that a foreign tree SURVIVED a teardown. An unrecorded directory is refused whether or not
 * the identity check works, so a recorder that over-records is not the only failure available: one
 * that under-records makes those assertions pass for the wrong reason and quietly converts the
 * suite's hardest tests into vacuous ones. "The failure direction is safe" is therefore not an
 * available defence here. The stated invariant is EXACT OWNERSHIP, and an inexact answer is a defect
 * in whichever direction it leans.
 *
 * INVARIANT: every record is written on an identity CAPTURED AT the creating operation and CHECKED
 * against the name before it is stored.
 *
 *   mkdir / mkdtemp — the identity is taken from a descriptor opened on the new directory, and the
 *     directory must wear the shape the call just made: empty, or, for a recursive `mkdir`, holding
 *     exactly the level below it.
 *   cp — the destinations that existed BEFORE the call are censused first, so a directory the copy
 *     merged into is never claimed as created; the rest must mirror the source tree.
 *   rename — the identity is read from the SOURCE before the move and carried across, and a
 *     directory this run never created is not given a record by being moved in.
 *   recordAllocatedDir / trackOwned — they ACCEPT an expected identity and refuse a mismatch,
 *     instead of discovering one by looking.
 *
 * THE PEER IS A REAL PROCESS. Every substitution below is performed by a fresh Node process with
 * the run's preload removed, so its `mkdir` and `rename` calls are invisible here. That is the
 * threat being modelled, and it is the only honest instrument: a substitution performed with this
 * process's own `fs` is, from the inside, indistinguishable from the run rebuilding its own fixture.
 */
describe('safety: a creation record names what the call created, not what occupies the name', () => {
  const props: string[] = [];
  /**
   * What the peer planted, recorded as it was planted, and cleared on the same identities.
   *
   * A decoy has to be created by a program this harness cannot witness, or it would carry a receipt
   * and the assertion would be vacuous. It must also be taken away again, or the fixture around it
   * leaks holding whatever the test put in it — and taking it away with a recursive shell removal
   * aimed at its pathname would be the exact hazard these tests exist to forbid, performed by the
   * tests that forbid it. See `tests/helpers/peer-fixtures.ts`.
   */
  const peer = new PeerFixtures();
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.STHAYI_HOME;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (saved === undefined) {
      // biome-ignore lint/performance/noDelete: delete is the only correct way to unset an env var; assigning undefined coerces to the string "undefined".
      delete process.env.STHAYI_HOME;
    } else {
      process.env.STHAYI_HOME = saved;
    }
    // What a peer planted, the peer takes away. Nothing in this process can remove it: it has no
    // creation record for it, which is the entire point of every assertion above.
    peer.clear();
    // Newest first: a tree standing inside a fixture has to go before the fixture does.
    for (const p of props.splice(0).reverse()) {
      removeOwned(p);
    }
  });

  /** Register a fixture so this suite's own teardown removes it by proven identity. */
  function keep(dir: string): string {
    props.push(dir);
    return dir;
  }

  function runPeer(operations: readonly PeerOperation[]): void {
    const r = runPeerOperations(operations);
    expect(r.status, r.stderr).toBe(0);
  }

  /** The identity of a directory, for asking the ledger what it recorded under a parent. */
  function idOf(dir: string): Identity {
    const id = identityFromBigStat(fs.lstatSync(dir, { bigint: true }));
    if (id === null) throw new Error(`no test identity for ${dir}`);
    return id;
  }

  /**
   * A PEER moves the directory at `at` aside and stands its own tree there.
   *
   * This is the whole attack in one line: the original survives somewhere else (which is what makes
   * a substitution different from a deletion), and the name now answers to a tree with data in it.
   */
  function peerSubstitutes(at: string): void {
    runPeer([
      peerFs.rename(at, `${at}-aside`),
      peerFs.mkdir(path.join(at, 'nested'), { recursive: true }),
      peerFs.write(path.join(at, 'nested', 'canary'), 'FOREIGN'),
      peerFs.write(path.join(at, 'top-canary'), 'FOREIGN-TOP'),
    ]);
    peer.adopt(at);
    peer.adopt(`${at}-aside`);
  }

  /** Stand a foreign tree at a name this run never used. */
  function peerPlantsAt(at: string): void {
    runPeer([
      peerFs.mkdir(path.join(at, 'nested'), { recursive: true }),
      peerFs.write(path.join(at, 'nested', 'canary'), 'FOREIGN'),
      peerFs.write(path.join(at, 'top-canary'), 'FOREIGN-TOP'),
    ]);
    peer.adopt(at);
  }

  /** Every canary a substitution planted is still exactly where it was. */
  function expectForeignIntact(at: string): void {
    expect(fs.readFileSync(path.join(at, 'nested', 'canary'), 'utf8')).toBe('FOREIGN');
    expect(fs.readFileSync(path.join(at, 'top-canary'), 'utf8')).toBe('FOREIGN-TOP');
  }

  /**
   * Substitute in the window between a creating syscall and the recorder's look at what it made.
   *
   * The seam is the recorder's first `lstat` of the new path AT WHICH SOMETHING IS STANDING THERE —
   * the earliest moment any implementation can ask "what did I just make?" and get an answer. That
   * existence condition is what makes the seam the same window whichever order the implementation
   * reads in: a look taken at a name that is still empty cannot be raced, because `peerSubstitutes`
   * moves the occupant aside before planting, and there is nothing yet to move. Without it, an
   * implementation that reads the destination BEFORE the creating call would consume the seam on an
   * absent path, the plant would silently no-op, and the test would pass while proving nothing.
   *
   * Driving the swap from inside that call puts the replacement in exactly the window a peer process
   * wins by chance — deterministically, and at the same point whether the recorder identifies by
   * name or by descriptor.
   */
  function substituteAtFirstLook(match: (p: string) => boolean): () => string | null {
    let hit: string | null = null;
    const real = fs.lstatSync;
    const standing = (p: string): boolean => {
      try {
        (real as unknown as (a: fs.PathLike, b?: unknown) => fs.Stats)(p);
        return true;
      } catch {
        return false;
      }
    };
    vi.spyOn(fs, 'lstatSync').mockImplementation(((p: fs.PathLike, o?: unknown) => {
      const target = String(p);
      if (hit === null && match(target) && standing(target)) {
        hit = target;
        peerSubstitutes(target);
      }
      return (real as unknown as (a: fs.PathLike, b?: unknown) => fs.Stats)(p, o);
    }) as typeof fs.lstatSync);
    return () => hit;
  }

  it('mkdir: a tree swapped in before the recorder looks is never recorded, and survives teardown', () => {
    const home = createFakeHome();
    keep(home.fixture);
    const at = home.path('made');
    const homeId = idOf(home.home);

    const fired = substituteAtFirstLook((p) => p === at);
    fs.mkdirSync(at, { mode: 0o700 });
    vi.restoreAllMocks();

    expect(fired()).toBe(at); // the race really was run
    // Nothing was recorded at that name, so no walk has any authority over what stands there.
    expect(recordedChildIdentity(homeId, 'made')).toBeUndefined();
    expect(wasCreatedThisRun(idOf(at))).toBe(false);

    home.cleanup();

    expectForeignIntact(at);
    expect(fs.existsSync(home.fixture)).toBe(true); // the fixture leaks around it, on purpose
  });

  it('mkdir -p: a level swapped in before the recorder looks leaves the whole chain unrecorded', () => {
    const home = createFakeHome();
    keep(home.fixture);
    const deep = home.path('chain', 'mid', 'leaf');
    const homeId = idOf(home.home);

    // The DEEPEST level is the first one a recursive create identifies, so substituting there is
    // what tests whether a chain is recorded level by level or waved through from the top.
    const fired = substituteAtFirstLook((p) => p === deep);
    fs.mkdirSync(deep, { recursive: true, mode: 0o700 });
    vi.restoreAllMocks();

    expect(fired()).toBe(deep);
    expect(recordedChildIdentity(homeId, 'chain')).toBeUndefined();
    // Refusing the deepest level leaves every level ABOVE it unrecorded too, which is the point: a
    // chain is recorded level by level or not at all. It also means the whole chain is now this
    // test's litter rather than the harness's, so the test takes it away itself.
    peer.adopt(home.path('chain'));

    home.cleanup();

    expectForeignIntact(deep);
    expect(fs.existsSync(home.fixture)).toBe(true);
  });

  it('mkdtemp: a tree swapped in before the recorder looks is never recorded either', () => {
    const home = createFakeHome();
    keep(home.fixture);
    const homeId = idOf(home.home);

    // mkdtemp picks the name itself, so the seam has to be described rather than named — which is
    // also the honest shape: nothing can pre-register the path a random name will land on.
    const fired = substituteAtFirstLook(
      (p) => path.dirname(p) === home.home && path.basename(p).startsWith('probe-'),
    );
    const made = fs.mkdtempSync(home.path('probe-'));
    vi.restoreAllMocks();

    expect(fired()).toBe(made);
    expect(recordedChildIdentity(homeId, path.basename(made))).toBeUndefined();

    home.cleanup();

    expectForeignIntact(made);
    expect(fs.existsSync(home.fixture)).toBe(true);
  });

  it('rename: a tree swapped in at the destination before the recorder looks is never recorded', () => {
    const home = createFakeHome();
    keep(home.fixture);
    const staging = home.path('staging');
    fs.mkdirSync(staging, { mode: 0o700 });
    fs.writeFileSync(path.join(staging, 'ours'), 'OURS');
    const to = home.path('moved');
    const homeId = idOf(home.home);

    const fired = substituteAtFirstLook((p) => p === to);
    fs.renameSync(staging, to);
    vi.restoreAllMocks();

    expect(fired()).toBe(to);
    // The identity was read from the SOURCE before the move, so the destination is measured against
    // what left rather than against what turned up.
    expect(recordedChildIdentity(homeId, 'moved')).toBeUndefined();
    expect(wasCreatedThisRun(idOf(to))).toBe(false);

    home.cleanup();

    expectForeignIntact(to);
    expect(fs.existsSync(home.fixture)).toBe(true);
  });

  it('cp: a tree swapped in at a copied destination before the recorder looks is never recorded', () => {
    const home = createFakeHome();
    keep(home.fixture);
    const src = home.path('src');
    fs.mkdirSync(path.join(src, 'sub'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(src, 'sub', 'f'), 'OURS');
    const dest = home.path('dest');
    const sub = path.join(dest, 'sub');

    const fired = substituteAtFirstLook((p) => p === sub);
    fs.cpSync(src, dest, { recursive: true });
    vi.restoreAllMocks();

    expect(fired()).toBe(sub);
    expect(recordedChildIdentity(idOf(dest), 'sub')).toBeUndefined();

    home.cleanup();

    expectForeignIntact(sub);
    expect(fs.existsSync(home.fixture)).toBe(true);
  });

  it('cp: a destination that ALREADY EXISTED is merged into, never claimed as created', () => {
    const home = createFakeHome();
    keep(home.fixture);
    const src = home.path('src');
    fs.mkdirSync(path.join(src, 'sub'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(src, 'sub', 'f'), 'OURS');

    // A destination this run did not make, holding data this run did not write. `cp` merges into it
    // and reports nothing, so a census taken after the call cannot tell it from a directory the copy
    // created — which is exactly why the census is taken BEFORE.
    const dest = home.path('dest');
    peerPlantsAt(dest);
    const homeId = idOf(home.home);

    fs.cpSync(src, dest, { recursive: true });

    expect(recordedChildIdentity(homeId, 'dest')).toBeUndefined();
    expect(wasCreatedThisRun(idOf(dest))).toBe(false);
    // What the copy really did create underneath it is still this run's own work.
    expect(recordedChildIdentity(idOf(dest), 'sub')).toEqual(idOf(path.join(dest, 'sub')));

    home.cleanup();

    expectForeignIntact(dest);
    expect(fs.existsSync(home.fixture)).toBe(true);
  });

  it('rename: an EXTERNAL directory moved into a tracked tree is not adopted by the move', () => {
    const home = createFakeHome();
    keep(home.fixture);
    const homeId = idOf(home.home);

    // Created entirely outside this process, so nothing here holds a creation record for it. Moving
    // it under a tracked name must not manufacture one: a rename gives a directory a NAME, and a
    // name has never been what authorises entering it.
    const outside = path.join(path.dirname(home.fixture), 'sthayi-external-probe');
    peerPlantsAt(outside);
    const arrived = home.path('arrived');
    fs.renameSync(outside, arrived);
    peer.adopt(arrived);

    expect(recordedChildIdentity(homeId, 'arrived')).toBeUndefined();

    home.cleanup();

    expectForeignIntact(arrived);
    expect(fs.existsSync(home.fixture)).toBe(true);
  });

  it('recordAllocatedDir REFUSES a name substituted between the creation and the call', () => {
    const home = createFakeHome();
    keep(home.fixture);
    const at = home.path('alloc');
    fs.mkdirSync(at, { mode: 0o700 });
    // The identity the creating call captured — the only thing that can tell the directory that was
    // made from the directory that is there now.
    const captured = requireCreationIdentity(at);
    const homeId = idOf(home.home);

    peerSubstitutes(at);

    expect(recordAllocatedDir(at, captured)).toBe(false);
    // The record that survives is the one the `mkdir` wrote, naming the directory this run really
    // made — NOT a pin on the substitute. A pin is permanent, so pinning a stranger here would be
    // the most durable form of the defect: the name would be authorised for the rest of the run.
    expect(recordedChildIdentity(homeId, 'alloc')).toEqual(captured);
    expect(wasCreatedThisRun(idOf(at))).toBe(false);

    home.cleanup();

    expectForeignIntact(at);
    expect(fs.existsSync(home.fixture)).toBe(true);
  });

  it('trackOwned REFUSES a name substituted between the creation and the call', () => {
    const home = createFakeHome();
    keep(home.fixture);
    const at = home.path('tracked');
    fs.mkdirSync(at, { mode: 0o700 });
    const captured = requireCreationIdentity(at);

    peerSubstitutes(at);

    expect(() => trackOwned(at, captured)).toThrow(/refusing to track a replacement/);
    // And with no identity supplied at all, the receipt from the creating call is what it checks
    // against — so the refusal does not depend on the caller having remembered to pass one.
    expect(() => trackOwned(at)).toThrow(/refusing to track a replacement/);

    home.cleanup();

    expectForeignIntact(at);
    expect(fs.existsSync(home.fixture)).toBe(true);
  });

  it('trackOwned REFUSES a directory whose creation this process never witnessed', () => {
    const home = createFakeHome();
    keep(home.fixture);
    const at = home.path('foreign');
    peerPlantsAt(at);

    // No receipt exists, so there is no identity to check against — and discovering one by looking
    // is the adoption the whole design refuses. It raises instead.
    expect(() => trackOwned(at)).toThrow(/no identity was captured/);

    home.cleanup();

    expectForeignIntact(at);
    expect(fs.existsSync(home.fixture)).toBe(true);
  });

  it('a RECURSIVE removal retires the records of everything it destroyed', () => {
    const home = createFakeHome();
    keep(home.fixture);
    const tree = home.path('tree');
    fs.mkdirSync(path.join(tree, 'a', 'b'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(tree, 'a', 'b', 'f'), 'OURS');
    const treeId = idOf(tree);
    const aId = idOf(path.join(tree, 'a'));
    const bId = idOf(path.join(tree, 'a', 'b'));
    expect(wasCreatedThisRun(bId)).toBe(true);

    fs.rmSync(tree, { recursive: true, force: true });

    // An inode number goes back to the kernel with the directory that held it, and may be handed to
    // somebody else's directory next. A record that outlived its directory would go on vouching for
    // whatever inherits the number — authority attached to an integer rather than to anything this
    // run made — so a recursive removal has to retire every record underneath it, not just the top.
    for (const id of [treeId, aId, bId]) {
      expect(wasCreatedThisRun(id)).toBe(false);
    }
    expect(recordedChildIdentity(idOf(home.home), 'tree')).toBeUndefined();

    home.cleanup();
    expect(fs.existsSync(home.fixture)).toBe(false);
  });

  it('teardown is total on the fixture and refuses a foreign tree inside it', () => {
    // Both halves in one test, because either half alone is worthless.
    //
    // `removeOwned()` has to satisfy two requirements that pull in opposite directions. It must take
    // a fixture down to the last entry — a teardown that quietly stops working leaks every run — and
    // it must leave standing a tree that arrived from outside, which is the whole reason removal is
    // decided per entry rather than by handing a pathname to `fs.rmSync(dir, { recursive: true })`
    // and letting that call decide its entire walk from the name.
    const control = runTempDir('sthayi-teardown-control-');
    fs.mkdirSync(path.join(control, 'a', 'b'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(control, 'a', 'b', 'store'), 'OURS');
    fs.mkdirSync(path.join(control, 'a', 'staging'), { mode: 0o700 });
    fs.renameSync(path.join(control, 'a', 'staging'), path.join(control, 'a', 'moved'));

    removeOwned(control);
    expect(fs.existsSync(control)).toBe(false); // as total as a recursive primitive would be

    const attacked = keep(runTempDir('sthayi-teardown-canary-'));
    fs.mkdirSync(path.join(attacked, 'ours'), { mode: 0o700 });
    fs.writeFileSync(path.join(attacked, 'ours', 'store'), 'OURS');
    const planted = path.join(attacked, 'planted');
    peerPlantsAt(planted);

    removeOwned(attacked);

    // The canary: a recursive primitive handed this same pathname erases every byte of it. Refusing
    // costs the fixture, which leaks; that is the trade an entry-by-entry removal exists to make.
    expectForeignIntact(planted);
    expect(fs.existsSync(attacked)).toBe(true);
  });

  it('CONTROL — everything this run really did create is still recorded, and still removed', () => {
    const home = createFakeHome();
    const deep = home.path('x', 'y', 'z');
    fs.mkdirSync(deep, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(deep, 'db'), 'OURS');
    const src = home.path('src');
    fs.mkdirSync(path.join(src, 'sub'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(src, 'sub', 'f'), 'OURS');
    fs.cpSync(src, home.path('copied'), { recursive: true });
    fs.mkdirSync(home.path('staging'), { mode: 0o700 });
    fs.renameSync(home.path('staging'), home.path('x', 'moved'));
    const made = fs.mkdtempSync(home.path('tmp-'));
    fs.writeFileSync(path.join(made, 'f'), 'OURS');

    // Every entry point the recorder supports, in one fixture. A capture strict enough to refuse a
    // substitution is worthless if it also refuses the run's own work: that failure is silent, it
    // leaks instead of deleting, and it makes every hostile assertion above pass for the wrong
    // reason. So the control is not optional decoration — it is what keeps the evidence honest.
    expect(recordedChildIdentity(idOf(home.path('x', 'y')), 'z')).toEqual(idOf(deep));
    expect(recordedChildIdentity(idOf(home.path('copied')), 'sub')).toEqual(
      idOf(home.path('copied', 'sub')),
    );
    expect(recordedChildIdentity(idOf(home.path('x')), 'moved')).toEqual(
      idOf(home.path('x', 'moved')),
    );
    expect(recordedChildIdentity(idOf(home.home), path.basename(made))).toEqual(idOf(made));

    home.cleanup();

    expect(fs.existsSync(home.fixture)).toBe(false); // nothing leaked
  });
});
