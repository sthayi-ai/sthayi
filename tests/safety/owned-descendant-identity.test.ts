import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeHome } from '../helpers/fake-home.js';
import { removeOwned, trackOwned } from '../helpers/owned-fs.js';
import {
  PeerFixtures,
  type PeerOperation,
  peerFs,
  runPeerOperations,
} from '../helpers/peer-fixtures.js';
import { runTempDir } from '../helpers/run-temp.js';
import setup, { RUN_IDENTITY_ENV, RUN_ROOT_ENV, RUN_TOKEN_ENV } from '../helpers/temp-sweep.js';

/**
 * SAFETY: authority to ENTER a directory reaches all the way down, or it is worthless.
 *
 * A ledger of the fixtures a run allocated answers one question — which children of the run root
 * are ours — and it answers nothing at all about what lives inside one. That gap is where the real
 * data is: a vault key, a store, a journal, sitting three or four levels below the name that was
 * recorded. A teardown that proves the TOP of a tree and then recurses on whatever it finds is
 * doing exactly what a recursive `rm` does, one syscall at a time: it decides the whole walk from
 * pathnames, and one directory swapped in below the proved name turns the walk into the erasure of
 * a foreign tree.
 *
 * INVARIANT: every directory the walk enters must have an identity this run RECORDED WHEN IT
 * CREATED IT — under the parent it was created in, or, for a tree this run made and something else
 * later renamed, by the device/inode that names that one directory. A current `lstat` is how the
 * question is asked; it is never the answer. Concretely:
 *
 *   RECORDED, IDENTITY INTACT — entered, and entered on the RECORDED identity, so every re-proof
 *     below is against what creation wrote down.
 *   RECORDED, IDENTITY CHANGED — a substitution wearing a name this run created. The walk ABORTS.
 *     Nothing at that name is entered, listed, removed or followed, and the tree above it leaks.
 *   NOT RECORDED — never this run's. Not entered, and not removed either, whether it holds data or
 *     nothing at all: "it is empty" is a fact read from a LISTING, and a listing is the one piece of
 *     evidence a peer controls completely. The walk aborts and the tree above it leaks.
 *
 * NOT A SINGLE ENTRY OF A FOREIGN SUBTREE. The bounded, one-entry-per-lost-race exposure that the
 * removal primitives carry is real and is documented where it applies — an `unlink` of one file
 * this run holds a receipt for. It does not extend to the recursive walk: a directory this run
 * cannot show a creation record for is not entered at all, so a lost race there costs nothing
 * rather than costing a tree.
 *
 * THE PEER IS A REAL PROCESS. Several scenarios below substitute through an uninstrumented Node
 * child, not through `node:fs` in this process. That is the threat being modelled — a concurrent `pnpm test`, a live
 * `sthayi`, anything sharing this uid and this temp root — and it is also the only honest way to
 * write it: this run records the directories it creates as it creates them, so a substitution
 * performed with this process's own `fs` is, from the inside, indistinguishable from the run
 * legitimately rebuilding its own fixture. What must never be adopted is a directory THIS RUN NEVER
 * MADE, and only another process can produce one.
 */
describe('safety: teardown enters only directories this run recorded creating', () => {
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
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = {
      [RUN_ROOT_ENV]: process.env[RUN_ROOT_ENV],
      [RUN_TOKEN_ENV]: process.env[RUN_TOKEN_ENV],
      [RUN_IDENTITY_ENV]: process.env[RUN_IDENTITY_ENV],
      STHAYI_HOME: process.env.STHAYI_HOME,
    };
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    // What a peer planted, the peer takes away. Nothing in this process can remove it: it has no
    // creation record for it, which is the entire point of every assertion above.
    peer.clear();
    // Newest first: a tree standing inside a fixture has to go before the fixture does.
    for (const p of props.splice(0).reverse()) {
      removeOwned(p);
    }
  });

  /** Record a directory this test created, so its own cleanup removes it by proven identity. */
  function keep(dir: string): string {
    const canonical = trackOwned(dir);
    props.push(canonical);
    return canonical;
  }

  /**
   * Act as a genuinely FOREIGN process.
   *
   * The peer child is not this run: it loads none of this run's helpers, writes nothing to its
   * ledger, and its `rename`/`mkdir` are invisible here. That is what makes it the right instrument
   * — a substitution it performs is one this run has no record of, which is precisely the case the
   * invariant is about.
   */
  function runPeer(operations: readonly PeerOperation[]): void {
    const r = runPeerOperations(operations);
    expect(r.status, r.stderr).toBe(0);
  }

  /** Stand a foreign tree, with canaries, at a name a peer has just emptied. */
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

  const systemTemp = (): string => fs.realpathSync(os.tmpdir());

  it('a fake HOME replaced at its own name is not entered, and the fixture leaks around it', () => {
    const home = createFakeHome();
    fs.writeFileSync(home.path('ours'), 'OURS');
    const fixture = home.fixture;
    const at = home.home;

    // The exact shape the ledger-of-fixtures-only version could not see: the ALLOCATION is
    // untouched and still proves out, and the substitution happens one level below it, at the
    // mutable home. Moving the real home aside is what a substitution does — it keeps the original
    // intact somewhere else — and it is also what makes the swap observable afterwards.
    const aside = path.join(fixture, 'home-aside');
    fs.renameSync(at, aside);
    peerPlantsAt(at);
    expect(fs.readFileSync(path.join(at, 'nested', 'canary'), 'utf8')).toBe('FOREIGN');

    home.cleanup();

    // Four facts, and all four are the opposite of what a walk authorised by the fixture alone did.
    expectForeignIntact(at);
    expect(fs.existsSync(at)).toBe(true); // the replacement is still standing
    expect(fs.existsSync(fixture)).toBe(true); // and the fixture leaks rather than take it with it
    expect(fs.readFileSync(path.join(aside, 'ours'), 'utf8')).toBe('OURS');
    keep(fixture);
  });

  it('a fake HOME replaced by a PEER, with the allocation untouched, is not entered either', () => {
    const home = createFakeHome();
    const fixture = home.fixture;
    const at = home.home;
    // Move and replace entirely outside this process, so nothing this run does is even involved.
    runPeer([peerFs.rename(at, `${at}-aside`)]);
    peer.adopt(`${at}-aside`);
    peerPlantsAt(at);

    home.cleanup();

    expectForeignIntact(at);
    expect(fs.existsSync(fixture)).toBe(true);
    keep(fixture);
  });

  it('a DEEPER nested child replaced by a peer is not entered, at any depth', () => {
    const home = createFakeHome();
    const fixture = home.fixture;
    const deep = home.path('a', 'b', 'c');
    fs.mkdirSync(deep, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(deep, 'keep.txt'), 'OURS-DEEP');

    // Three levels below the allocation and two below the home: the mid-tree directory is what
    // gets swapped, so entering it would mean the walk had authorised itself from an ancestor.
    const at = home.path('a', 'b');
    runPeer([peerFs.rename(at, `${at}-aside`)]);
    peer.adopt(`${at}-aside`);
    peerPlantsAt(at);

    home.cleanup();

    expectForeignIntact(at);
    expect(fs.existsSync(fixture)).toBe(true);
    expect(fs.readFileSync(path.join(`${at}-aside`, 'c', 'keep.txt'), 'utf8')).toBe('OURS-DEEP');
    keep(fixture);
  });

  it('an UNREGISTERED directory a peer moves in is neither entered nor removed', () => {
    const home = createFakeHome();
    const fixture = home.fixture;
    // Not a substitution at all: a name this run never used, holding a tree it never made. There is
    // no record to mismatch, and the absence of a record is itself the refusal.
    const at = home.path('arrived');
    peerPlantsAt(at);

    home.cleanup();

    expectForeignIntact(at);
    expect(fs.existsSync(fixture)).toBe(true);
    keep(fixture);
  });

  it('an unregistered EMPTY directory is left standing, and the fixture leaks around it', () => {
    const home = createFakeHome();
    const fixture = home.fixture;
    const empty = home.path('empty-stray');
    runPeer([peerFs.mkdir(empty, { recursive: true })]);

    home.cleanup();

    // An empty directory looks like it holds nothing to lose, and clearing it on that basis is a
    // decision made from a LISTING — the one piece of evidence a peer controls completely. A
    // directory can be filled between the listing and the `rmdir`, and the run has no record saying
    // it made this one at all. So it stays, and the fixture stays with it.
    expect(fs.existsSync(empty)).toBe(true);
    expect(fs.existsSync(fixture)).toBe(true);
    keep(fixture);
    peer.adopt(empty);
  });

  it('CONTROL — a deep tree this run created is still removed to the last entry', () => {
    const home = createFakeHome();
    const fixture = home.fixture;
    const deep = home.path('x', 'y', 'z');
    fs.mkdirSync(deep, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(deep, 'db'), 'OURS');
    fs.writeFileSync(home.path('x', 'key'), 'OURS');
    // A directory that acquired its name from a RENAME rather than a mkdir — the shape the launcher
    // uses to swap a runtime into place — is still this run's own and must still be removable.
    fs.mkdirSync(home.path('staging'), { mode: 0o700 });
    fs.writeFileSync(home.path('staging', 'f'), 'OURS');
    fs.renameSync(home.path('staging'), home.path('x', 'moved'));

    home.cleanup();

    expect(fs.existsSync(fixture)).toBe(false); // nothing leaked: the invariant is not a stop switch
  });

  it('the GLOBAL SWEEP applies the same rule inside a fixture it did not walk itself', () => {
    // The sweep of a run root goes through a different entry point from removeOwned() — it
    // classifies each child against the allocation ledger first — and this asserts that the same
    // refusal holds there.
    //
    // WHAT IT DOES NOT PROVE, STATED PLAINLY. setup(), the creation and teardown() all happen in
    // THIS process, so the in-memory records are already populated and a ledger that never
    // persisted a usable line would still look like it worked. The cross-process behaviour — a
    // child creating a tree and a FRESH parent, with every map empty, tearing it down on persisted
    // evidence alone — is what tests/safety/cross-process-ledger.test.ts exists to establish, and it
    // cannot be established from inside one process.
    const teardown = setup({ systemTemp: systemTemp() });
    const root = keep(String(process.env[RUN_ROOT_ENV]));
    const fixture = runTempDir('sthayi-descprobe-');
    const inner = path.join(fixture, 'inner');
    fs.mkdirSync(inner, { mode: 0o700 });
    fs.writeFileSync(path.join(inner, 'ours'), 'OURS');

    runPeer([peerFs.rename(inner, `${inner}-aside`)]);
    peer.adopt(`${inner}-aside`);
    peerPlantsAt(inner);

    teardown();

    expectForeignIntact(inner);
    expect(fs.existsSync(root)).toBe(true); // refusing one directory leaks the root, on purpose
    expect(fs.readFileSync(path.join(`${inner}-aside`, 'ours'), 'utf8')).toBe('OURS');
  });
});
