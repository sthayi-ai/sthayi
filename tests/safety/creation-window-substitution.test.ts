import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeHome } from '../helpers/fake-home.js';
import {
  type Identity,
  identityFromBigStat,
  recordedChildIdentity,
  removeOwned,
} from '../helpers/owned-fs.js';
import {
  PeerFixtures,
  type PeerOperation,
  peerFs,
  runPeerOperations,
} from '../helpers/peer-fixtures.js';
import { runTempDir } from '../helpers/run-temp.js';

/**
 * SAFETY: a directory the recorder was TRICKED into recording must still not have its contents
 * deleted.
 *
 * THE WINDOW THAT CANNOT BE CLOSED. `fs.mkdirSync(p)` is exclusive — when it returns, this process
 * made an inode at that name — but it hands back no descriptor, and portable Node has no `mkdirat`
 * or `O_DIRECTORY` open bound to the creating call. The identity therefore has to be fetched by
 * looking the NAME up again, and between the syscall returning and that first look a same-uid peer
 * can remove or move our directory aside and stand its own EMPTY one at the name. An empty
 * directory satisfies every leg of the freshness proof — it is a directory, it is owned by this
 * uid, its link count is 2, and its listing is empty — because that is exactly the shape `mkdir`
 * itself produces. No check performed after the fact can tell the two apart, on any platform, and
 * this suite does not pretend one can.
 *
 * WHY THE EXISTING CAPTURE TESTS DO NOT COVER IT. `creation-identity-capture.test.ts` substitutes a
 * tree that ALREADY HAS DATA IN IT, on the recorder's first `lstat`. By then the descriptor is
 * already open on the real directory, so the final identity re-check fails, and the substitution is
 * refused for free. That test proves a substitution cannot be adopted LATE and with the wrong
 * SHAPE. It says nothing about the case that matters: a substitution that is EARLY and wears the
 * right shape — empty — and is filled in afterwards.
 *
 * SO THE INVARIANT MOVED. It is no longer "a foreign directory can never be recorded"; that claim
 * is not obtainable. It is: A RECORD IS A PERMIT TO REMOVE THE DIRECTORY IT NAMES, NEVER A PERMIT
 * TO REMOVE WHAT IS INSIDE IT. Each entry inside answers for itself, on a receipt this run took at
 * the successful syscall that named that exact entry — so a peer's file, planted at a name this run
 * never mentions, is refused however the directory around it came to be recorded. The fixture leaks
 * and the peer's data survives.
 */
describe('safety: an EMPTY substitution inside the capture window wins no content authority', () => {
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

  afterEach(() => {
    vi.restoreAllMocks();
    // What a peer planted, the peer takes away: nothing in this process holds an authority for it,
    // which is the whole assertion above.
    peer.clear();
    for (const p of props.splice(0).reverse()) {
      removeOwned(p);
    }
  });

  function keep(dir: string): string {
    props.push(dir);
    return dir;
  }

  function runPeer(operations: readonly PeerOperation[]): void {
    const r = runPeerOperations(operations);
    expect(r.status, r.stderr).toBe(0);
  }

  function idOf(dir: string): Identity {
    const id = identityFromBigStat(fs.lstatSync(dir, { bigint: true }));
    if (id === null) throw new Error(`no test identity for ${dir}`);
    return id;
  }

  /**
   * The substitution the recorder CANNOT detect: our directory is destroyed and an EMPTY one is
   * stood at the name by an uninstrumented child, whose syscalls no wrapper here witnesses.
   *
   * Empty is the point. A tree with contents is refused by the freshness proof, which is why the
   * older capture suite passes without ever reaching the behaviour under test here.
   *
   * DESTROYED rather than moved aside, and that matters to the evidence. A peer that renames ours
   * to a sibling leaves an extra entry behind, and an extra entry is itself detectable: the level
   * ABOVE then holds a name the creating call cannot account for, and a recursive `mkdir` chain
   * refuses on that alone — passing the test for a reason that has nothing to do with the defect. A
   * peer has no need to keep our directory, so it does not, and the probe stops being flattered.
   */
  function peerSwapsEmpty(at: string): void {
    runPeer([peerFs.rmdir(at), peerFs.mkdir(at, { mode: 0o700 })]);
    peer.adopt(at);
  }

  /** Data the peer writes into the name AFTER the recorder has already written its record. */
  function peerFills(at: string): void {
    runPeer([
      peerFs.write(path.join(at, 'top-canary'), 'FOREIGN-TOP'),
      peerFs.write(path.join(at, 'second-canary'), 'FOREIGN-SECOND'),
    ]);
    peer.adopt(at); // recorded as it is planted, so it can be cleared on the same identities
  }

  function expectFilledIntact(at: string): void {
    expect(fs.readFileSync(path.join(at, 'top-canary'), 'utf8')).toBe('FOREIGN-TOP');
    expect(fs.readFileSync(path.join(at, 'second-canary'), 'utf8')).toBe('FOREIGN-SECOND');
  }

  /**
   * Substitute in the EARLIEST window there is: after the creating syscall has returned, before the
   * recorder's first look at what it made.
   *
   * POSIX captures through a descriptor, so its seam is the first `openSync` on the new path.
   * Windows has no equivalent no-follow directory descriptor and deliberately proves freshness by
   * `lstat -> listing -> lstat`, so its equivalent seam is the first `lstatSync`. Either way the
   * replacement lands in front of every leg of the platform's proof, in the window a real peer
   * wins by chance.
   */
  function substituteAtFirstIdentityRead(match: (p: string) => boolean): () => string | null {
    let hit: string | null = null;
    if (process.platform === 'win32') {
      const real = fs.lstatSync;
      vi.spyOn(fs, 'lstatSync').mockImplementation(((p: fs.PathLike, o?: unknown) => {
        const target = String(p);
        if (hit === null && match(target)) {
          hit = target;
          peerSwapsEmpty(target);
        }
        return (real as unknown as (a: fs.PathLike, b?: unknown) => fs.Stats)(p, o);
      }) as typeof fs.lstatSync);
    } else {
      const real = fs.openSync;
      vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
        const target = String(p);
        if (hit === null && match(target)) {
          hit = target;
          peerSwapsEmpty(target);
        }
        return (real as unknown as (a: fs.PathLike, ...b: unknown[]) => number)(p, ...rest);
      }) as typeof fs.openSync);
    }
    return () => hit;
  }

  it('mkdir: the peer directory is recorded, and its later contents still survive teardown', () => {
    const home = createFakeHome();
    keep(home.fixture);
    const at = home.path('made');
    const homeId = idOf(home.home);

    const fired = substituteAtFirstIdentityRead((p) => p === at);
    fs.mkdirSync(at, { mode: 0o700 });
    vi.restoreAllMocks();

    expect(fired()).toBe(at); // the race really was run, in the window that matters
    // The record NAMES THE PEER'S DIRECTORY, and nothing available after the fact could have
    // prevented that. This assertion is the honest part of the test: the defect being fixed is not
    // that the record is wrong, it is what the wrong record is allowed to authorise.
    expect(recordedChildIdentity(homeId, 'made')).toEqual(idOf(at));

    peerFills(at);

    home.cleanup();

    expectFilledIntact(at);
    expect(fs.existsSync(home.fixture)).toBe(true); // the fixture leaks around it, on purpose
  });

  it('mkdir -p: a level substituted while the chain is being recorded keeps its later contents', () => {
    const home = createFakeHome();
    keep(home.fixture);
    const deep = home.path('chain', 'mid', 'leaf');

    // The DEEPEST level is the first one a recursive create identifies, so this is the level whose
    // capture window a peer would aim at.
    const fired = substituteAtFirstIdentityRead((p) => p === deep);
    fs.mkdirSync(deep, { recursive: true, mode: 0o700 });
    vi.restoreAllMocks();

    expect(fired()).toBe(deep);
    peerFills(deep);

    home.cleanup();

    expectFilledIntact(deep);
    expect(fs.existsSync(home.fixture)).toBe(true);
  });

  it('mkdtemp: the same window, and the same refusal to empty what turned up in it', () => {
    const home = createFakeHome();
    keep(home.fixture);

    const fired = substituteAtFirstIdentityRead(
      (p) => path.dirname(p) === home.home && path.basename(p).startsWith('probe-'),
    );
    const made = fs.mkdtempSync(home.path('probe-'));
    vi.restoreAllMocks();

    expect(fired()).toBe(made);
    peerFills(made);

    home.cleanup();

    expectFilledIntact(made);
    expect(fs.existsSync(home.fixture)).toBe(true);
  });

  /**
   * `cp` reaches this window through its own directories rather than through a shape comparison.
   *
   * A copy that identified its destination by matching it against the SOURCE would hand a peer the
   * weakest proof in the module: a copied destination may hold anything the source holds, so a
   * replacement wearing the source's entry names passes on the first look and no window is even
   * needed. So the copy is not identified afterwards at all — it is PERFORMED through the run's own
   * recordable entry points, one `mkdirSync` and one `copyFileSync` at a time. Each destination
   * directory then faces exactly the proof a fresh `mkdir` faces, and this test is the same
   * substitution the `mkdir` rows run, arriving through `cp`.
   */
  it('cp: a substituted destination directory keeps everything that turns up inside it', () => {
    const home = createFakeHome();
    keep(home.fixture);
    const src = home.path('src');
    fs.mkdirSync(path.join(src, 'sub'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(src, 'sub', 'f'), 'OURS');
    const dest = home.path('dest');
    const sub = path.join(dest, 'sub');

    const fired = substituteAtFirstIdentityRead((p) => p === sub);
    fs.cpSync(src, dest, { recursive: true });
    vi.restoreAllMocks();

    expect(fired()).toBe(sub);
    // The peer owns the name now and stands its OWN objects behind it: `f` is destroyed and
    // recreated rather than rewritten, because a file whose bytes changed is still the file this
    // run copied there and is still the run's to remove. What must survive is a DIFFERENT object at
    // the name — and the two canaries, which are names nothing in this run ever mentions.
    runPeer([
      peerFs.unlink(path.join(sub, 'f'), true),
      peerFs.write(path.join(sub, 'f'), 'FOREIGN-SHAPED'),
    ]);
    peer.adopt(sub);
    peerFills(sub);

    home.cleanup();

    expect(fs.readFileSync(path.join(sub, 'f'), 'utf8')).toBe('FOREIGN-SHAPED');
    expectFilledIntact(sub);
    expect(fs.existsSync(home.fixture)).toBe(true);
  });

  it('CONTROL — a fixture the run really did fill is still emptied to the last entry', () => {
    // The refusal above is worthless if it also refuses the run's own work: that failure is silent,
    // it leaks instead of deleting, and it would make every assertion above pass for the wrong
    // reason. So the control runs the same shapes with no peer in the way at all.
    const control = runTempDir('sthayi-window-control-');
    fs.mkdirSync(path.join(control, 'a', 'b'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(control, 'a', 'b', 'store'), 'OURS');
    const src = path.join(control, 'src');
    fs.mkdirSync(path.join(src, 'sub'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(src, 'sub', 'f'), 'OURS');
    fs.cpSync(src, path.join(control, 'copied'), { recursive: true });
    const made = fs.mkdtempSync(path.join(control, 'tmp-'));
    fs.writeFileSync(path.join(made, 'f'), 'OURS');

    removeOwned(control);

    expect(fs.existsSync(control)).toBe(false);
  });
});
