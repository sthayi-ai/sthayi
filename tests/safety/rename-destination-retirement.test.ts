import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReplayAnswer, ReplayQuery } from '../helpers/fresh-ledger-replay.js';
import {
  type Identity,
  entryReceipt,
  identityFromBigStat,
  recordedChildIdentity,
  removeOwned,
  syncDirLedger,
  wasCreatedThisRun,
} from '../helpers/owned-fs.js';
import {
  PeerFixtures,
  type PeerOperation,
  peerFs,
  peerFsChildPath,
  runPeerOperations,
} from '../helpers/peer-fixtures.js';
import { runTempDir } from '../helpers/run-temp.js';
import setup, {
  RUN_DIRS,
  RUN_IDENTITY_ENV,
  RUN_ROOT_ENV,
  RUN_TOKEN_ENV,
} from '../helpers/temp-sweep.js';

const itRenameOverOccupied = it.skipIf(process.platform === 'win32');

/**
 * SAFETY: a `rename` ONTO AN OCCUPIED NAME destroys what was standing there, and the authority that
 * described it has to die with it.
 *
 * WHAT THE KERNEL DOES, AND WHY IT IS EASY TO MISS. `rename(src, dst)` where `dst` is an existing
 * EMPTY DIRECTORY succeeds: the destination directory is unlinked as part of the call, and the source
 * takes its name. One syscall, two effects — a move and a DESTRUCTION — and only the move is visible
 * in the arguments. A recorder that reads the source, performs the call and then writes the source's
 * identity down at the destination has accounted for the move and said nothing whatever about the
 * directory the kernel just destroyed.
 *
 * WHAT SURVIVES IF NOTHING IS SAID. Three things, and each one is authority over an inode number the
 * kernel has already taken back:
 *
 *   THE INODE RECORD. `createdThisRun()` goes on answering yes for the destroyed directory, so a
 *     directory that later inherits the number is walked into as one this run made — under ANY name,
 *     because that record is keyed by the number alone.
 *   THE RECEIPTS. Every entry receipt this run holds is keyed by the identity of the directory the
 *     entry sits IN. Receipts keyed by the destroyed inode outlive it, and the object that inherits
 *     the number inherits permission to have its entries removed by name.
 *   THE PERSISTED RECORD. The sweep runs in a process that witnessed none of this and knows the
 *     run's records only from the ledger. A retirement that stays in the process that performed the
 *     rename leaves every other process still holding all of the above.
 *
 * AND WHAT MUST NOT DIE WITH IT. The MOVED directory is intact at the destination and is still this
 * run's: its inode authority, and every receipt for the entries inside it, are keyed by an identity
 * the rename did not change. Retiring those as well would leave the run unable to remove its own
 * tree, and the fixture would leak.
 *
 * ORDER IS PART OF THE RECORD. The retirement and the re-record describe the SAME name under the
 * same parent, and a retirement is guarded on identity so it cannot retire a live record. Persisted
 * the wrong way round, the replaying process applies the re-record first and the retirement then
 * matches nothing — the lines are all present and the stale authority survives anyway. So the
 * retirement is written FIRST, and the assertions below are made in a process that only ever saw the
 * file.
 *
 * BOTH RECORDERS ARE PINNED HERE: the in-process wrappers in `tests/helpers/owned-fs.ts`, and the
 * loader `tests/helpers/child-dir-ledger.mjs` that records for node children, which is a separate
 * implementation of the same rule and fails in the same way for the same reason.
 */
describe('safety: a rename over an occupied name retires the identity it destroyed', () => {
  const props: string[] = [];
  const peer = new PeerFixtures();
  let saved: Record<string, string | undefined> = {};

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const replayer = path.join(repoRoot, 'tests', 'helpers', 'fresh-ledger-replay.ts');

  beforeEach(() => {
    saved = {
      [RUN_ROOT_ENV]: process.env[RUN_ROOT_ENV],
      [RUN_TOKEN_ENV]: process.env[RUN_TOKEN_ENV],
      [RUN_IDENTITY_ENV]: process.env[RUN_IDENTITY_ENV],
    };
  });

  afterEach(() => {
    // The root, the token and the identity are ONE published fact and are restored together.
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    peer.clear();
    for (const p of props.splice(0).reverse()) {
      removeOwned(p);
    }
  });

  function runPeer(operations: readonly PeerOperation[]): void {
    const r = runPeerOperations(operations);
    expect(r.status, r.stderr).toBe(0);
  }

  function idOf(p: string): Identity {
    const id = identityFromBigStat(fs.lstatSync(p, { bigint: true }));
    if (id === null) throw new Error(`no test identity for ${p}`);
    return id;
  }

  /**
   * Ask a FRESH PROCESS what the ledger inside `root` still authorises.
   *
   * Spawned as `process.execPath` with `--import tsx`, never through the `tsx` shim, which is a
   * shell script that runs whatever `node` PATH resolves to — a version skew underneath the very
   * behaviour being asserted, reported by nothing. The runtime is asserted inside the child.
   */
  function replay(root: string, query: ReplayQuery): ReplayAnswer {
    const file = path.join(root, 'replay-query.json');
    fs.writeFileSync(file, JSON.stringify(query), { mode: 0o600 });
    const r = spawnSync(process.execPath, ['--import', 'tsx', replayer, root, file], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        [RUN_ROOT_ENV]: '',
        [RUN_TOKEN_ENV]: '',
        [RUN_IDENTITY_ENV]: '',
        NODE_OPTIONS: '',
        STHAYI_EXPECT_NODE: process.versions.node,
      },
    });
    expect(r.stderr ?? '').toBe('');
    expect(r.status).toBe(0);
    fs.unlinkSync(file);
    return JSON.parse(r.stdout) as ReplayAnswer;
  }

  itRenameOverOccupied(
    'the IN-PROCESS recorder retires the destination it destroyed, and keeps what arrived',
    () => {
      const fixture = runTempDir('sthayi-rename-dst-');
      props.push(fixture);
      const fixtureId = idOf(fixture);
      const src = path.join(fixture, 'src');
      const dst = path.join(fixture, 'dst');
      fs.mkdirSync(src, { mode: 0o700 });
      fs.mkdirSync(dst, { mode: 0o700 });
      const srcId = idOf(src);
      const destroyedId = idOf(dst);

      // A receipt keyed by the DESTINATION's inode, taken the way every receipt is: from the
      // descriptor the run's own write went through.
      fs.writeFileSync(path.join(dst, 'held'), 'OURS');
      expect(entryReceipt(destroyedId, 'held')).toBeDefined();
      // Emptied again by a program these wrappers cannot witness, so the receipt outlives its entry
      // exactly as it does after any removal performed outside this process — which is the state the
      // destination is in when a rename lands on it.
      runPeer([peerFs.unlink(path.join(dst, 'held'), true)]);
      expect(fs.readdirSync(dst)).toEqual([]);

      // Everything the destination carried, before the call that destroys it.
      expect(wasCreatedThisRun(destroyedId)).toBe(true);
      expect(recordedChildIdentity(fixtureId, 'dst')).toEqual(destroyedId);
      expect(entryReceipt(destroyedId, 'held')).toBeDefined();

      fs.renameSync(src, dst);

      expect(idOf(dst)).toEqual(srcId); // the move landed: `dst` is the directory that was `src`
      expect(fs.existsSync(src)).toBe(false);

      // The name the directory LEFT keeps nothing.
      expect(recordedChildIdentity(fixtureId, 'src')).toBeUndefined();
      // The directory that ARRIVED keeps everything: it is intact, and it is still this run's.
      expect(recordedChildIdentity(fixtureId, 'dst')).toEqual(srcId);
      expect(wasCreatedThisRun(srcId)).toBe(true);
      // The directory the rename DESTROYED keeps nothing at all.
      expect(wasCreatedThisRun(destroyedId)).toBe(false);
      expect(entryReceipt(destroyedId, 'held')).toBeUndefined();
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'Windows refuses rename over an occupied directory and leaves both objects and records intact',
    () => {
      const fixture = runTempDir('sthayi-rename-win-refusal-');
      props.push(fixture);
      const fixtureId = idOf(fixture);
      const src = path.join(fixture, 'src');
      const dst = path.join(fixture, 'dst');
      fs.mkdirSync(src, { mode: 0o700 });
      fs.mkdirSync(dst, { mode: 0o700 });
      fs.writeFileSync(path.join(src, 'source-canary'), 'SOURCE');
      fs.writeFileSync(path.join(dst, 'held'), 'DESTINATION');
      const srcId = idOf(src);
      const dstId = idOf(dst);

      let code: string | undefined;
      try {
        fs.renameSync(src, dst);
      } catch (error) {
        code = (error as NodeJS.ErrnoException).code;
      }

      expect(code).toBe('EPERM');
      expect(idOf(src)).toEqual(srcId);
      expect(idOf(dst)).toEqual(dstId);
      expect(fs.readFileSync(path.join(src, 'source-canary'), 'utf8')).toBe('SOURCE');
      expect(fs.readFileSync(path.join(dst, 'held'), 'utf8')).toBe('DESTINATION');
      expect(recordedChildIdentity(fixtureId, 'src')).toEqual(srcId);
      expect(recordedChildIdentity(fixtureId, 'dst')).toEqual(dstId);
      expect(wasCreatedThisRun(srcId)).toBe(true);
      expect(wasCreatedThisRun(dstId)).toBe(true);
      expect(entryReceipt(dstId, 'held')).toBeDefined();
    },
  );

  /**
   * The destination reached by a move THIS PROCESS NEVER SAW — the case a destination-keyed
   * retirement cannot express.
   *
   * A directory is created as `made` and recorded there. An EXTERNAL `mv` then carries it to `dst`,
   * and no wrapper witnesses it, so the record still says `made`. The witnessed `rename(src, dst)`
   * that follows destroys that directory — but a retirement written against the DESTINATION key
   * finds nothing recorded at `dst` and leaves the older name record standing, pointing at an inode
   * the kernel has already taken back.
   *
   * Worse in memory than it first looks: a record is only in memory until the next `syncDirLedger()`
   * re-reads the file, and the `+ … made` line is still in it. The inode authority the rename
   * dropped therefore comes straight back — so the retirement has to be IDENTITY-SCOPED and has to
   * be PERSISTED that way, or the destroyed directory is authoritative again one read later.
   */
  itRenameOverOccupied(
    'a rename destroys the identity, not the destination NAME: a hidden move takes it too',
    () => {
      const fixture = runTempDir('sthayi-rename-hidden-');
      props.push(fixture);
      const fixtureId = idOf(fixture);
      const made = path.join(fixture, 'made');
      const src = path.join(fixture, 'src');
      const dst = path.join(fixture, 'dst');
      fs.mkdirSync(made, { mode: 0o700 });
      const madeId = idOf(made);
      // A receipt keyed by the identity that is about to be destroyed, taken through this run's own
      // descriptor, then emptied again by a program these wrappers cannot witness.
      fs.writeFileSync(path.join(made, 'held'), 'OURS');
      expect(entryReceipt(madeId, 'held')).toBeDefined();
      runPeer([peerFs.unlink(path.join(made, 'held'), true)]);
      fs.mkdirSync(src, { mode: 0o700 });
      const srcId = idOf(src);

      // The move no wrapper sees. The record still names `made`; the directory now answers to `dst`.
      runPeer([peerFs.rename(made, dst)]);
      expect(idOf(dst)).toEqual(madeId);
      expect(recordedChildIdentity(fixtureId, 'made')).toEqual(madeId);
      expect(recordedChildIdentity(fixtureId, 'dst')).toBeUndefined();

      fs.renameSync(src, dst); // witnessed, and it destroys the directory standing at `dst`

      expect(idOf(dst)).toEqual(srcId);
      // NOTHING that described the destroyed identity survives, under ANY name.
      expect(wasCreatedThisRun(madeId)).toBe(false);
      expect(recordedChildIdentity(fixtureId, 'made')).toBeUndefined();
      expect(entryReceipt(madeId, 'held')).toBeUndefined();
      // And it does not come back on the next read of the file this process itself wrote.
      syncDirLedger();
      expect(wasCreatedThisRun(madeId)).toBe(false);
      expect(recordedChildIdentity(fixtureId, 'made')).toBeUndefined();
      expect(entryReceipt(madeId, 'held')).toBeUndefined();
      // The directory that ARRIVED is untouched by any of it.
      expect(recordedChildIdentity(fixtureId, 'dst')).toEqual(srcId);
      expect(wasCreatedThisRun(srcId)).toBe(true);
    },
  );

  itRenameOverOccupied(
    'the in-process recorder PERSISTS the retirement, and persists it BEFORE the re-record',
    () => {
      const root = String(process.env[RUN_ROOT_ENV]);
      const ledger = path.join(root, RUN_DIRS);
      const fixture = runTempDir('sthayi-rename-order-');
      props.push(fixture);
      const fixtureId = idOf(fixture);
      const src = path.join(fixture, 'src');
      const dst = path.join(fixture, 'dst');
      fs.mkdirSync(src, { mode: 0o700 });
      fs.mkdirSync(dst, { mode: 0o700 });
      const srcId = idOf(src);
      const destroyedId = idOf(dst);

      fs.renameSync(src, dst);

      const lines = fs.readFileSync(ledger, 'utf8').split('\n');
      const retirement = `- v2 ${destroyedId.dev} ${destroyedId.ino} ${destroyedId.birthtimeNs} ${fixtureId.dev} ${fixtureId.ino} ${fixtureId.birthtimeNs} dst`;
      const rerecord = `+ v2 ${srcId.dev} ${srcId.ino} ${srcId.birthtimeNs} ${fixtureId.dev} ${fixtureId.ino} ${fixtureId.birthtimeNs} dst`;
      expect(lines).toContain(retirement);
      expect(lines).toContain(rerecord);
      // Both lines describe the same name under the same parent, and a retirement is guarded on
      // identity: written the other way round it would match nothing on replay and retire nothing.
      expect(lines.indexOf(retirement)).toBeLessThan(lines.indexOf(rerecord));

      // AND THE IDENTITY-SCOPED FORM OF THE SAME LOSS, in the same order. `D` carries the parent and
      // name only so the line stays readable and can retire the one entry receipt at that name; what a
      // reader applies it to is the identity, which is why it still bites when the destroyed directory
      // was recorded under some other name entirely.
      const destruction = `D v2 ${destroyedId.dev} ${destroyedId.ino} ${destroyedId.birthtimeNs} ${fixtureId.dev} ${fixtureId.ino} ${fixtureId.birthtimeNs} dst`;
      expect(lines).toContain(destruction);
      expect(lines.indexOf(destruction)).toBeLessThan(lines.indexOf(rerecord));
    },
  );

  it('a rename onto a name holding NOTHING retires nothing that is still standing', () => {
    // The negative half: the retirement is for a destination that was DESTROYED, and a call that
    // destroyed nothing must leave every record it did not touch exactly as it was.
    const fixture = runTempDir('sthayi-rename-free-');
    props.push(fixture);
    const fixtureId = idOf(fixture);
    const keep = path.join(fixture, 'keep');
    const src = path.join(fixture, 'src');
    fs.mkdirSync(keep, { mode: 0o700 });
    fs.mkdirSync(src, { mode: 0o700 });
    fs.writeFileSync(path.join(keep, 'held'), 'OURS');
    const keepId = idOf(keep);
    const srcId = idOf(src);

    fs.renameSync(src, path.join(fixture, 'free'));

    expect(recordedChildIdentity(fixtureId, 'free')).toEqual(srcId);
    expect(recordedChildIdentity(fixtureId, 'keep')).toEqual(keepId);
    expect(wasCreatedThisRun(keepId)).toBe(true);
    expect(entryReceipt(keepId, 'held')).toBeDefined();
  });

  /**
   * The same rename, performed by a NODE CHILD through the loader that records for children.
   *
   * The child writes into a run root this test stands up for it: pointing it at the suite's real
   * root would have it recording into, and a sweep removing, the fixtures every other worker is
   * still using. The mechanism is unchanged — the same loader file, reached the same way, with the
   * ledger and the root travelling inside the loader URL exactly as `publishChildRecorder()` sends
   * them.
   */
  itRenameOverOccupied(
    'the CHILD recorder persists the retirement, and a fresh process replays it correctly',
    () => {
      const teardown = setup({ systemTemp: fs.realpathSync(os.tmpdir()) });
      const root = String(process.env[RUN_ROOT_ENV]);
      props.push(root);
      const ledger = path.join(root, RUN_DIRS);
      const base = path.join(root, 'base');
      fs.mkdirSync(base, { mode: 0o700 });
      const baseId = idOf(base);

      const loader = pathToFileURL(path.join(repoRoot, 'tests', 'helpers', 'child-dir-ledger.mjs'));
      loader.searchParams.set('ledger', ledger);
      loader.searchParams.set('root', root);

      // The child creates both directories with its own `fs`, gives the destination a receipt, has a
      // program IT cannot witness take that entry away again, and then renames over the destination.
      const childScript = [
        // ESM, and `fs` as a DEFAULT import: a child reaches its own binding, never this module's, and
        // destructuring a wrapped name out of `fs` is what the binding rules here forbid outright.
        "import cp from 'node:child_process';",
        "import fs from 'node:fs';",
        "import path from 'node:path';",
        'if (process.versions.node !== process.env.STHAYI_EXPECT_NODE) {',
        "  console.error('child node ' + process.versions.node);",
        '  process.exit(9);',
        '}',
        'const base = process.argv[1];',
        'const peerHelper = process.argv[2];',
        "const src = path.join(base, 'src');",
        "const dst = path.join(base, 'dst');",
        'fs.mkdirSync(src, { mode: 0o700 });',
        'fs.mkdirSync(dst, { mode: 0o700 });',
        "fs.writeFileSync(path.join(dst, 'held'), 'CHILD');",
        'const ids = {',
        '  src: fs.lstatSync(src, { bigint: true }),',
        '  dst: fs.lstatSync(dst, { bigint: true }),',
        '};',
        'cp.execFileSync(process.execPath, [peerHelper, JSON.stringify([',
        "  { kind: 'unlink', path: path.join(dst, 'held'), missingOk: true },",
        "])], { env: { ...process.env, NODE_OPTIONS: '' } });",
        'fs.renameSync(src, dst);',
        'process.stdout.write(',
        '  JSON.stringify({',
        '    src: { dev: ids.src.dev.toString(), ino: ids.src.ino.toString(), birthtimeNs: ids.src.birthtimeNs.toString() },',
        '    dst: { dev: ids.dst.dev.toString(), ino: ids.dst.ino.toString(), birthtimeNs: ids.dst.birthtimeNs.toString() },',
        '  }),',
        ');',
      ].join('\n');

      const r = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', childScript, base, peerFsChildPath],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            NODE_OPTIONS: `--import=${loader.href}`,
            STHAYI_EXPECT_NODE: process.versions.node,
          },
        },
      );
      expect(r.stderr ?? '').toBe('');
      expect(r.status).toBe(0);
      // Censused now, so an assertion that throws below still leaves nothing behind: this root lives
      // outside the suite's own, and the records that would clear it are the ones under test.
      peer.adopt(root);
      const ids = JSON.parse(r.stdout) as { src: Identity; dst: Identity };
      expect(idOf(path.join(base, 'dst'))).toEqual(ids.src); // the move really landed

      // THIS process witnessed none of it, and asks a process that witnessed even less.
      const answer = replay(root, {
        inodes: [ids.dst, ids.src],
        children: [
          [baseId, 'dst'],
          [baseId, 'src'],
        ],
        receipts: [[ids.dst, 'held']],
      });
      expect(answer.inodes[0]).toBe(false); // the destroyed destination authorises nothing
      expect(answer.inodes[1]).toBe(true); // the moved directory is still this run's
      expect(answer.children[0]).toEqual(ids.src); // the destination names what arrived
      expect(answer.children[1]).toBeNull(); // the source name was released
      expect(answer.receipts[0]).toBeNull(); // no receipt survives the inode it was keyed by

      removeOwned(root);
      expect(fs.existsSync(root)).toBe(false);
      props.splice(0);
      teardown(); // idempotent: the root it published is already gone
    },
  );

  /**
   * The same hidden move, asked of a process that saw NONE of it.
   *
   * This is the half that a suite checking its own maps cannot reach. The destroyed directory's
   * `+ … made` line is sitting in the ledger, and a retirement written only against the DESTINATION
   * key matches nothing when it is replayed — so the replaying process rebuilds the inode authority,
   * the name record and the receipt for a directory that no longer exists. The destruction record
   * therefore has to name the IDENTITY and be applied by identity, independently of whatever key the
   * directory happened to answer to when it died.
   *
   * Performed in a run root of this test's own, so the lines under examination are the only ones in
   * the file and the assertions cannot be satisfied by somebody else's bookkeeping.
   */
  itRenameOverOccupied(
    'a FRESH PROCESS replaying the ledger gives the hidden-moved identity nothing',
    () => {
      const teardown = setup({ systemTemp: fs.realpathSync(os.tmpdir()) });
      const root = String(process.env[RUN_ROOT_ENV]);
      props.push(root);
      const base = path.join(root, 'base');
      fs.mkdirSync(base, { mode: 0o700 });
      const baseId = idOf(base);
      const made = path.join(base, 'made');
      const src = path.join(base, 'src');
      const dst = path.join(base, 'dst');
      fs.mkdirSync(made, { mode: 0o700 });
      const madeId = idOf(made);
      fs.writeFileSync(path.join(made, 'held'), 'OURS');
      runPeer([peerFs.unlink(path.join(made, 'held'), true)]);
      fs.mkdirSync(src, { mode: 0o700 });
      const srcId = idOf(src);
      runPeer([peerFs.rename(made, dst)]); // invisible to every wrapper here
      expect(idOf(dst)).toEqual(madeId);

      fs.renameSync(src, dst);
      expect(idOf(dst)).toEqual(srcId);

      const answer = replay(root, {
        inodes: [madeId, srcId],
        children: [
          [baseId, 'made'],
          [baseId, 'dst'],
          [baseId, 'src'],
        ],
        receipts: [[madeId, 'held']],
      });
      expect(answer.inodes[0]).toBe(false); // the destroyed identity authorises nothing
      expect(answer.inodes[1]).toBe(true); // the moved directory is still this run's
      expect(answer.children[0]).toBeNull(); // the name it was CREATED under is gone too
      expect(answer.children[1]).toEqual(srcId); // the destination names what arrived
      expect(answer.children[2]).toBeNull(); // the source name was released
      expect(answer.receipts[0]).toBeNull(); // no receipt survives the inode it was keyed by

      removeOwned(root);
      expect(fs.existsSync(root)).toBe(false);
      props.splice(0);
      teardown();
    },
  );

  /**
   * The hidden move again, performed by a NODE CHILD through the loader that records for children.
   *
   * The two recorders are separate implementations of one rule and a fix to either says nothing
   * about the other, so the child's ledger is put to the same question: a directory created under
   * one name, carried to another by a program neither recorder sees, and destroyed there by a
   * witnessed rename. The line the child writes has to say what was destroyed rather than where.
   */
  itRenameOverOccupied(
    'the CHILD recorder states a hidden-moved destruction by IDENTITY, and it replays',
    () => {
      const teardown = setup({ systemTemp: fs.realpathSync(os.tmpdir()) });
      const root = String(process.env[RUN_ROOT_ENV]);
      props.push(root);
      const ledger = path.join(root, RUN_DIRS);
      const base = path.join(root, 'base');
      fs.mkdirSync(base, { mode: 0o700 });
      const baseId = idOf(base);

      const loader = pathToFileURL(path.join(repoRoot, 'tests', 'helpers', 'child-dir-ledger.mjs'));
      loader.searchParams.set('ledger', ledger);
      loader.searchParams.set('root', root);

      const childScript = [
        "import cp from 'node:child_process';",
        "import fs from 'node:fs';",
        "import path from 'node:path';",
        'if (process.versions.node !== process.env.STHAYI_EXPECT_NODE) {',
        "  console.error('child node ' + process.versions.node);",
        '  process.exit(9);',
        '}',
        'const base = process.argv[1];',
        'const peerHelper = process.argv[2];',
        "const made = path.join(base, 'made');",
        "const src = path.join(base, 'src');",
        "const dst = path.join(base, 'dst');",
        'fs.mkdirSync(made, { mode: 0o700 });',
        "fs.writeFileSync(path.join(made, 'held'), 'CHILD');",
        'const madeSt = fs.lstatSync(made, { bigint: true });',
        'fs.mkdirSync(src, { mode: 0o700 });',
        'const srcSt = fs.lstatSync(src, { bigint: true });',
        // Both invisible to the loader: the entry goes, and then the whole directory changes name.
        'cp.execFileSync(process.execPath, [peerHelper, JSON.stringify([',
        "  { kind: 'unlink', path: path.join(made, 'held'), missingOk: true },",
        "  { kind: 'rename', from: made, to: dst },",
        "])], { env: { ...process.env, NODE_OPTIONS: '' } });",
        'fs.renameSync(src, dst);',
        'process.stdout.write(',
        '  JSON.stringify({',
        '    made: { dev: madeSt.dev.toString(), ino: madeSt.ino.toString(), birthtimeNs: madeSt.birthtimeNs.toString() },',
        '    src: { dev: srcSt.dev.toString(), ino: srcSt.ino.toString(), birthtimeNs: srcSt.birthtimeNs.toString() },',
        '  }),',
        ');',
      ].join('\n');

      const r = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', childScript, base, peerFsChildPath],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            NODE_OPTIONS: `--import=${loader.href}`,
            STHAYI_EXPECT_NODE: process.versions.node,
          },
        },
      );
      expect(r.stderr ?? '').toBe('');
      expect(r.status).toBe(0);
      peer.adopt(root);
      const ids = JSON.parse(r.stdout) as { made: Identity; src: Identity };
      expect(idOf(path.join(base, 'dst'))).toEqual(ids.src);

      const answer = replay(root, {
        inodes: [ids.made, ids.src],
        children: [
          [baseId, 'made'],
          [baseId, 'dst'],
        ],
        receipts: [[ids.made, 'held']],
      });
      expect(answer.inodes[0]).toBe(false); // the destroyed identity authorises nothing
      expect(answer.inodes[1]).toBe(true); // the moved directory is still this run's
      expect(answer.children[0]).toBeNull(); // the name it was CREATED under keeps nothing
      expect(answer.children[1]).toEqual(ids.src);
      expect(answer.receipts[0]).toBeNull();

      removeOwned(root);
      expect(fs.existsSync(root)).toBe(false);
      props.splice(0);
      teardown();
    },
  );
});
