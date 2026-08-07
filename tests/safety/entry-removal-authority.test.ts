import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeHome } from '../helpers/fake-home.js';
import {
  type Identity,
  identityFromBigStat,
  recordedChildIdentity,
  removeOwned,
} from '../helpers/owned-fs.js';
import { PeerFixtures, type PeerOperation, peerFs } from '../helpers/peer-fixtures.js';
import { runTempDir } from '../helpers/run-temp.js';
import setup, { RUN_IDENTITY_ENV, RUN_ROOT_ENV, RUN_TOKEN_ENV } from '../helpers/temp-sweep.js';

/**
 * SAFETY: what a teardown may REMOVE is decided one ENTRY at a time, and only ever by a receipt
 * this run took at the successful syscall that made that exact entry.
 *
 * WHY A DIRECTORY-WIDE PERMISSION CANNOT BE THE AUTHORITY. "This run wrote something inside this
 * directory" is a true statement about the run and a useless one about the directory's CONTENTS: it
 * says nothing whatever about the entries the run did not write, and those are precisely the entries
 * a peer plants. Any rule of the shape "the run used this directory, therefore its entries may go"
 * converts one write into blanket authority over everything that happens to be sitting there — which
 * is the same defect as trusting a pathname, moved up one level.
 *
 * THE THREE WAYS A DIRECTORY-WIDE PERMISSION IS OBTAINED, all reproduced below and none of them
 * requiring anything exotic:
 *
 *   THE CAPTURE WINDOW. `mkdirSync` returns no descriptor and portable Node has no `mkdirat`, so the
 *     identity of a new directory is fetched by looking its NAME up again. A peer that destroys what
 *     the call made and stands an EMPTY directory at the name in that interval wears exactly the
 *     shape a fresh `mkdir` produces, and is recorded. One ordinary write by the run into the name
 *     afterwards is then enough to make the peer's directory "used".
 *   A SOURCE-SHAPED COPY DESTINATION. A recursive copy reports nothing about what it made, so a
 *     destination identified after the fact is identified by comparing it against the SOURCE. A peer
 *     that reproduces the source's entry names satisfies that comparison exactly.
 *   A MUTATION THAT NEVER HAPPENED. A witness taken before the syscall it is supposed to be
 *     witnessing records a write that the syscall then refuses to perform.
 *
 * WHAT MUST HOLD IN ALL THREE. The peer's data survives, the entries the run really did create are
 * still removed, and the fixture LEAKS around whatever is left. A leaked temp directory is a
 * nuisance a human deletes; a file belonging to a concurrent run is not recoverable.
 *
 * BOTH HALVES OF THE SYSTEM ARE EXERCISED. The in-process half attacks the maps this worker holds.
 * The cross-process half attacks the PERSISTED ledger: the same attack is run against a run root
 * this test stands up, and the sweep is then performed by a FRESH process whose maps are empty and
 * whose only evidence is what is on disk. A defect that lives in the ledger format is invisible to
 * the first half and fatal in production, where fixtures are made in workers and swept in a parent.
 */
describe('safety: removal authority is per ENTRY, never per directory', () => {
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

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const sweeper = path.join(repoRoot, 'tests', 'helpers', 'fresh-parent-sweep.ts');

  beforeEach(() => {
    saved = {
      [RUN_ROOT_ENV]: process.env[RUN_ROOT_ENV],
      [RUN_TOKEN_ENV]: process.env[RUN_TOKEN_ENV],
      [RUN_IDENTITY_ENV]: process.env[RUN_IDENTITY_ENV],
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // The root, the token and the identity are ONE published fact and are restored together: a
    // simulated run's identity left beside the real run's path describes a root that does not exist,
    // and every later allocation in this worker would refuse it.
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    // What a peer planted, the peer takes away: nothing in this process holds an authority for it,
    // which is the whole assertion. It goes before the fixtures do, because a fixture still holding
    // an unaccountable entry is one teardown correctly refuses to empty.
    peer.clear();
    for (const p of props.splice(0).reverse()) {
      removeOwned(p);
    }
  });

  function keep(dir: string): string {
    props.push(dir);
    return dir;
  }

  /** A peer action, with what it leaves behind recorded the instant it finishes. */
  function peerRun(operations: readonly PeerOperation[], ...roots: string[]): void {
    const r = peer.run(operations, roots);
    expect(r.status, r.stderr).toBe(0);
  }

  function idOf(dir: string): Identity {
    const id = identityFromBigStat(fs.lstatSync(dir, { bigint: true }));
    if (id === null) throw new Error(`no test identity for ${dir}`);
    return id;
  }

  const systemTemp = (): string => fs.realpathSync(os.tmpdir());

  /**
   * A FRESH process asked to sweep the published root: empty maps, no receipts, nothing but the
   * environment and the ledger on disk.
   *
   * Spawned as `process.execPath` rather than through the `tsx` shim, which resolves whatever `node`
   * is on PATH — a version skew there would change `fs` internals underneath the behaviour being
   * asserted and no assertion here would report it. The sweeper is told which runtime it is supposed
   * to be and refuses to be any other.
   */
  function freshParentSweep(): { status: number | null; err: string } {
    const r = spawnSync(process.execPath, ['--import', 'tsx', sweeper], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '', STHAYI_EXPECT_NODE: process.versions.node },
    });
    return { status: r.status, err: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  }

  /**
   * Destroy what the run just made and stand an EMPTY directory at the name through an
   * uninstrumented child, whose syscalls no wrapper in this process witnesses.
   *
   * Empty is the point: it is the one shape a fresh `mkdir` produces, so there is nothing left for a
   * check performed afterwards to disagree with.
   *
   * The directory being displaced was made by the creating call this fires inside, so it is empty
   * and one `rmdir` takes it. A recursive removal is not needed here and is not used: it would
   * decide a whole recursion from a pathname, which is the hazard under test.
   */
  function peerSwapsEmpty(at: string): void {
    peerRun([peerFs.rmdir(at), peerFs.mkdir(at, { mode: 0o700 })], at);
  }

  /** The same substitution, wearing the entry names a copy's SOURCE offers. */
  function peerSwapsShaped(at: string, names: readonly string[]): void {
    peerRun(
      [
        peerFs.rmdir(at),
        peerFs.mkdir(at, { mode: 0o700 }),
        ...names.map((name) => peerFs.write(path.join(at, name), 'SHAPED')),
      ],
      at,
    );
  }

  /** Data the peer writes into the name it now owns, after any record has already been taken. */
  function peerFills(at: string): void {
    peerRun(
      [
        peerFs.write(path.join(at, 'top-canary'), 'FOREIGN-TOP'),
        peerFs.write(path.join(at, 'second-canary'), 'FOREIGN-SECOND'),
      ],
      at,
    );
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
  function substituteAtFirstIdentityRead(
    match: (p: string) => boolean,
    swap: (at: string) => void = peerSwapsEmpty,
  ): () => string | null {
    let hit: string | null = null;
    if (process.platform === 'win32') {
      const real = fs.lstatSync;
      vi.spyOn(fs, 'lstatSync').mockImplementation(((p: fs.PathLike, o?: unknown) => {
        const target = String(p);
        if (hit === null && match(target)) {
          hit = target;
          swap(target);
        }
        return (real as unknown as (a: fs.PathLike, b?: unknown) => fs.Stats)(p, o);
      }) as typeof fs.lstatSync);
    } else {
      const real = fs.openSync;
      vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
        const target = String(p);
        if (hit === null && match(target)) {
          hit = target;
          swap(target);
        }
        return (real as unknown as (a: fs.PathLike, ...b: unknown[]) => number)(p, ...rest);
      }) as typeof fs.openSync);
    }
    return () => hit;
  }

  // -------------------------------------------------------------------------------------------
  // (a) A substituted directory the run then writes into.
  // -------------------------------------------------------------------------------------------

  /**
   * Stand the peer's directory at a name the run created, let the peer fill it, then have the run
   * perform one ordinary write of its own inside it — the shape any test takes when it makes a
   * directory and puts a file in it.
   *
   * The run's own file is genuinely the run's and may go. Everything the peer put there is not, and
   * the run's write says nothing about it.
   */
  function mkdirSubstitutionAttack(home: ReturnType<typeof createFakeHome>): string {
    const at = home.path('made');
    const homeId = idOf(home.home);
    const fired = substituteAtFirstIdentityRead((p) => p === at);
    fs.mkdirSync(at, { mode: 0o700 });
    vi.restoreAllMocks();

    expect(fired()).toBe(at); // the race really was run, in the window that matters
    // The record NAMES THE PEER'S DIRECTORY, and nothing available after the fact could have
    // prevented that. What must not follow is the peer's data being removed on the strength of it.
    expect(recordedChildIdentity(homeId, 'made')).toEqual(idOf(at));

    peerFills(at);
    fs.writeFileSync(path.join(at, 'ours'), 'OURS', { mode: 0o600 });
    return at;
  }

  it('mkdir: a write into a substituted directory removes the write, never the peer entries', () => {
    const home = createFakeHome();
    keep(home.fixture);

    const at = mkdirSubstitutionAttack(home);

    home.cleanup();

    expectFilledIntact(at);
    expect(fs.existsSync(home.fixture)).toBe(true); // the fixture leaks around it, on purpose
  });

  it('mkdir: the same write, swept by a FRESH process reading only the ledger', () => {
    const teardown = setup({ systemTemp: systemTemp() });
    const root = String(process.env[RUN_ROOT_ENV]);
    props.push(root);
    const home = createFakeHome();

    const at = mkdirSubstitutionAttack(home);

    const swept = freshParentSweep();

    expect(swept.err).toBe('');
    expect(swept.status).toBe(3); // refused, and the root leaks around it on purpose
    expectFilledIntact(at);
    expect(fs.existsSync(root)).toBe(true);

    teardown();
  });

  // -------------------------------------------------------------------------------------------
  // (b) A copy destination substituted by a directory wearing the SOURCE's entry names.
  // -------------------------------------------------------------------------------------------

  /**
   * A recursive copy whose destination is replaced, inside the window, by a directory holding
   * EXACTLY the names the source holds.
   *
   * The source is one file called `allowed`, so the replacement needs one file called `allowed` —
   * a far smaller thing to ask of a peer than reproducing a whole tree, and enough to satisfy any
   * rule that identifies a copy destination by comparing it against its source.
   */
  function copySubstitutionAttack(home: ReturnType<typeof createFakeHome>): string {
    const src = home.path('src');
    fs.mkdirSync(src, { mode: 0o700 });
    fs.writeFileSync(path.join(src, 'allowed'), 'OURS', { mode: 0o600 });
    const dest = home.path('dest');

    const fired = substituteAtFirstIdentityRead(
      (p) => p === dest,
      (at) => peerSwapsShaped(at, ['allowed']),
    );
    fs.cpSync(src, dest, { recursive: true });
    vi.restoreAllMocks();

    expect(fired()).toBe(dest);
    // The peer owns the name now, and writes through it once the copy has finished with it.
    peerRun(
      [
        peerFs.write(path.join(dest, 'allowed'), 'FOREIGN-SHAPED'),
        peerFs.write(path.join(dest, 'later'), 'FOREIGN-LATER'),
      ],
      dest,
    );
    return dest;
  }

  function expectCopyCanariesIntact(dest: string): void {
    expect(fs.readFileSync(path.join(dest, 'allowed'), 'utf8')).toBe('FOREIGN-SHAPED');
    expect(fs.readFileSync(path.join(dest, 'later'), 'utf8')).toBe('FOREIGN-LATER');
  }

  it('cp: a source-shaped replacement wins no authority over what is inside it', () => {
    const home = createFakeHome();
    keep(home.fixture);

    const dest = copySubstitutionAttack(home);

    home.cleanup();

    expectCopyCanariesIntact(dest);
    expect(fs.existsSync(home.fixture)).toBe(true);
  });

  it('cp: the same replacement, swept by a FRESH process reading only the ledger', () => {
    const teardown = setup({ systemTemp: systemTemp() });
    const root = String(process.env[RUN_ROOT_ENV]);
    props.push(root);
    const home = createFakeHome();

    const dest = copySubstitutionAttack(home);

    const swept = freshParentSweep();

    expect(swept.err).toBe('');
    expect(swept.status).toBe(3);
    expectCopyCanariesIntact(dest);
    expect(fs.existsSync(root)).toBe(true);

    teardown();
  });

  // -------------------------------------------------------------------------------------------
  // (c) A mutation that was witnessed but never performed.
  // -------------------------------------------------------------------------------------------

  /**
   * A copy that fails before it writes a single byte.
   *
   * The source does not exist, so the call raises and the destination is untouched. A witness taken
   * BEFORE the call records a write that never happened; a witness taken after a SUCCESSFUL call
   * records nothing at all here, which is the correct answer.
   */
  function failedCopyAttack(home: ReturnType<typeof createFakeHome>): string {
    const at = home.path('made');
    const fired = substituteAtFirstIdentityRead((p) => p === at);
    fs.mkdirSync(at, { mode: 0o700 });
    vi.restoreAllMocks();
    expect(fired()).toBe(at);

    peerFills(at);

    const absent = home.path('absent-source');
    expect(fs.existsSync(absent)).toBe(false);
    expect(() => fs.cpSync(absent, path.join(at, 'copied'), { recursive: true })).toThrow();
    // Nothing arrived: the failure is total, so no evidence of a write should exist either.
    expect(fs.existsSync(path.join(at, 'copied'))).toBe(false);
    return at;
  }

  it('a FAILED copy leaves the peer entries exactly where they are', () => {
    const home = createFakeHome();
    keep(home.fixture);

    const at = failedCopyAttack(home);

    home.cleanup();

    expectFilledIntact(at);
    expect(fs.existsSync(home.fixture)).toBe(true);
  });

  it('a FAILED copy, swept by a FRESH process reading only the ledger', () => {
    const teardown = setup({ systemTemp: systemTemp() });
    const root = String(process.env[RUN_ROOT_ENV]);
    props.push(root);
    const home = createFakeHome();

    const at = failedCopyAttack(home);

    const swept = freshParentSweep();

    expect(swept.err).toBe('');
    expect(swept.status).toBe(3);
    expectFilledIntact(at);
    expect(fs.existsSync(root)).toBe(true);

    teardown();
  });

  /**
   * A failed mutation that NAMES A PEER'S ENTRY, which is the sharpest form the ordering rule takes.
   *
   * The source does not exist, so the copy raises before it opens the destination and the peer's
   * file is not touched by so much as a truncation. A record taken before the call would name that
   * file — the run would hold a receipt for an object it never wrote a byte of — and teardown would
   * then remove it. Taken after the call returns, there is no record at all, because there was no
   * successful mutation to record.
   *
   * The peer plants ONE entry here, so the outcome cannot come out of whichever order a listing
   * happens to produce.
   */
  function failedNamedWriteAttack(home: ReturnType<typeof createFakeHome>): string {
    const at = home.path('named');
    const fired = substituteAtFirstIdentityRead((p) => p === at);
    fs.mkdirSync(at, { mode: 0o700 });
    vi.restoreAllMocks();
    expect(fired()).toBe(at);

    const canary = path.join(at, 'sole-canary');
    peerRun([peerFs.write(canary, 'FOREIGN-SOLE')], at);

    const absent = home.path('absent-source');
    expect(fs.existsSync(absent)).toBe(false);
    expect(() => fs.copyFileSync(absent, canary)).toThrow();
    expect(fs.readFileSync(canary, 'utf8')).toBe('FOREIGN-SOLE'); // not even truncated
    return canary;
  }

  it('a FAILED write that names a peer entry does not make that entry removable', () => {
    const home = createFakeHome();
    keep(home.fixture);

    const canary = failedNamedWriteAttack(home);

    home.cleanup();

    expect(fs.readFileSync(canary, 'utf8')).toBe('FOREIGN-SOLE');
    expect(fs.existsSync(home.fixture)).toBe(true);
  });

  it('a FAILED write that names a peer entry, swept by a FRESH process', () => {
    const teardown = setup({ systemTemp: systemTemp() });
    const root = String(process.env[RUN_ROOT_ENV]);
    props.push(root);
    const home = createFakeHome();

    const canary = failedNamedWriteAttack(home);

    const swept = freshParentSweep();

    expect(swept.err).toBe('');
    expect(swept.status).toBe(3);
    expect(fs.readFileSync(canary, 'utf8')).toBe('FOREIGN-SOLE');
    expect(fs.existsSync(root)).toBe(true);

    teardown();
  });

  // -------------------------------------------------------------------------------------------
  // CONTROLS — a refusal that also refuses the run's own work is not a fix.
  // -------------------------------------------------------------------------------------------

  /** Every shape a fixture is built out of, with no peer anywhere near it. */
  function buildOwnedTree(base: string): void {
    fs.mkdirSync(path.join(base, 'a', 'b'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(base, 'a', 'b', 'store'), 'OURS', { mode: 0o600 });
    fs.appendFileSync(path.join(base, 'a', 'appended'), 'OURS', { mode: 0o600 });
    const src = path.join(base, 'src');
    fs.mkdirSync(path.join(src, 'sub'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(src, 'sub', 'f'), 'OURS', { mode: 0o600 });
    fs.writeFileSync(path.join(src, 'top'), 'OURS', { mode: 0o600 });
    fs.cpSync(src, path.join(base, 'copied'), { recursive: true });
    const made = fs.mkdtempSync(path.join(base, 'tmp-'));
    fs.writeFileSync(path.join(made, 'f'), 'OURS', { mode: 0o600 });
    fs.symlinkSync(path.join(made, 'f'), path.join(base, 'link'));
    fs.copyFileSync(path.join(src, 'top'), path.join(base, 'copied-file'));
    const fd = fs.openSync(path.join(base, 'opened'), 'w', 0o600);
    fs.closeSync(fd);
    const moved = path.join(base, 'moved');
    fs.renameSync(made, moved);
    fs.writeFileSync(path.join(moved, 'after-move'), 'OURS', { mode: 0o600 });
  }

  it('CONTROL: a tree the run really did build is emptied to the last entry', () => {
    const control = runTempDir('sthayi-entryauth-control-');
    buildOwnedTree(control);

    removeOwned(control);

    expect(fs.existsSync(control)).toBe(false);
  });

  it('CONTROL: the same tree, removed by a FRESH process reading only the ledger', () => {
    const teardown = setup({ systemTemp: systemTemp() });
    const root = String(process.env[RUN_ROOT_ENV]);
    props.push(root);
    const control = runTempDir('sthayi-entryauth-xproc-');
    buildOwnedTree(control);

    const swept = freshParentSweep();

    expect(swept.err).toBe('');
    expect(swept.status).toBe(0);
    expect(fs.existsSync(root)).toBe(false);

    teardown();
    props.splice(0);
  });

  it('CONTROL: a fake home the run filled is removed, allocation and all', () => {
    const home = createFakeHome();
    const fixture = home.fixture;
    fs.mkdirSync(home.path('skills', 'one'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(home.path('skills', 'one', 'SKILL.md'), 'OURS', { mode: 0o600 });
    fs.writeFileSync(home.path('key'), 'OURS', { mode: 0o600 });

    home.cleanup();

    expect(fs.existsSync(fixture)).toBe(false);
  });
});
