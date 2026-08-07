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
  wasCreatedThisRun,
} from '../helpers/owned-fs.js';
import { PeerFixtures, peerFs } from '../helpers/peer-fixtures.js';
import { runTempDir } from '../helpers/run-temp.js';
import setup, {
  RUN_DIRS,
  RUN_IDENTITY_ENV,
  RUN_ROOT_ENV,
  RUN_TOKEN_ENV,
} from '../helpers/temp-sweep.js';

/**
 * SAFETY: a removal may not destroy MORE THAN IT COUNTED.
 *
 * THE SHAPE OF THE DEFECT. A recursive removal destroys a whole tree inside one call and names only
 * the top of it, so every record underneath describes an object that is about to stop existing. The
 * recorder therefore censuses the tree BEFORE the call and retires afterwards what really went. That
 * census has a ceiling — a tree wider than the ceiling is pathological either way — and the ceiling
 * was applied to the COUNTING while the DESTRUCTION went ahead in full. The result is not a slower
 * teardown or a missed tidy-up: it is authority left standing for directories that no longer exist,
 * attached to inode numbers the kernel is free to hand to the next process that asks for one. A
 * record that says "this run created the directory with this number" is what licenses a sweep to
 * WALK INTO whatever is standing there.
 *
 * RAISING THE CEILING IS NOT A FIX. It moves the same defect to a bigger number and leaves the shape
 * intact: a census that can be truncated, and a destruction that never was.
 *
 * SO THE RULE IS ABOUT COMPLETENESS, NOT SIZE. Either the recorder can account for everything the
 * call is about to destroy, or it holds nothing that could authorise anything. When the census
 * cannot be completed, the authority is INVALIDATED — every creation record, every inode, every
 * receipt, in memory and in the ledger every other process reads — and it is invalidated BEFORE the
 * destruction, so a process killed mid-removal leaves nothing behind either.
 *
 * WHY INVALIDATION RATHER THAN REFUSAL. These wrappers witness; they do not intervene. A recorder
 * that made `rm` fail on a tree the program under test is entitled to remove would change what the
 * program does and make the harness lie about the product's behaviour. Invalidation costs a LEAKED
 * FIXTURE — every later removal refuses for want of a record — which is the direction this whole
 * module errs in on purpose.
 *
 * The probe below is deterministic: a flat tree of directories one wider than the census can hold,
 * built and destroyed by a real child through the real loader, measured on the ledger it wrote and
 * read back by a process that witnessed none of it.
 */
describe('safety: a removal that cannot be counted leaves no authority behind', () => {
  const props: string[] = [];
  const peer = new PeerFixtures();

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const replayer = path.join(repoRoot, 'tests', 'helpers', 'fresh-ledger-replay.ts');
  const childRecorder = path.join(repoRoot, 'tests', 'helpers', 'child-dir-ledger.mjs');

  /** Read the mechanism's real ceiling so this load-bearing probe cannot drift to the safe side. */
  const CHILD_CENSUS_LIMIT = (() => {
    const source = fs.readFileSync(childRecorder, 'utf8');
    const raw = /const MAX_CENSUS = ([0-9_]+);/.exec(source)?.[1];
    if (raw === undefined) {
      throw new Error('child recorder no longer exposes a literal MAX_CENSUS to this probe');
    }
    const limit = Number(raw.replaceAll('_', ''));
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error(`invalid child-recorder MAX_CENSUS: ${raw}`);
    }
    return limit;
  })();

  /** This many children plus the tree's own root is one entry wider than the census can hold. */
  const OVER_CAP = CHILD_CENSUS_LIMIT;

  /**
   * Children enough to overrun `MAX_CENSUS` in `tests/helpers/owned-fs.ts`, which counts the tree's
   * own root as its first entry — so 8,192 children exactly fills it and 8,193 goes past the end.
   */
  const IN_PROCESS_OVER_CAP = 8193;

  // Both over-cap probes create and retire 8,193 directories. Hosted Windows exceeded Vitest's
  // 5 s default on those two workloads, so only those tests receive this measured headroom.
  const OVER_CAP_TEST_TIMEOUT_MS = 20_000;
  const CHILD_OVER_CAP_TEST =
    'a recursive removal WIDER THAN THE CENSUS leaves zero authority for what it destroyed';
  const IN_PROCESS_OVER_CAP_TEST =
    'the IN-PROCESS recorder past the census cap leaves the LAST child no authority';

  let saved: Record<string, string | undefined> = {};

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

  function idOf(p: string): Identity {
    const id = identityFromBigStat(fs.lstatSync(p, { bigint: true }));
    if (id === null) throw new Error(`no test identity for ${p}`);
    return id;
  }

  /**
   * A private ledger for a child, inside a fixture — never the run's own.
   *
   * The invalidation this file provokes is process-wide by design, and a worker that replayed it
   * from the run's shared ledger would lose the records for every fixture every other suite in that
   * worker is still using. The child is therefore pointed at a ledger nothing else reads. The FILE
   * is created here, by this process, so the fixture still holds a receipt for it and teardown can
   * take it away; the child only ever appends to that same inode.
   */
  function childLedger(fixture: string): string {
    const ledger = path.join(fixture, RUN_DIRS);
    fs.writeFileSync(ledger, '', { mode: 0o600 });
    return ledger;
  }

  function loaderOption(fixture: string, ledger: string): string {
    const loader = pathToFileURL(childRecorder);
    loader.searchParams.set('ledger', ledger);
    loader.searchParams.set('root', fixture);
    return `--import=${loader.href}`;
  }

  /** Ask a FRESH PROCESS what the ledger in `root` still authorises; see the replayer's own note. */
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

  /** Every directory the ledger records a creation for, in the order the lines were written. */
  function createdInLedger(ledger: string): Identity[] {
    const out: Identity[] = [];
    for (const l of fs.readFileSync(ledger, 'utf8').split('\n')) {
      const parts = l.split(' ');
      if (parts.length >= 9 && parts[1] === 'v2' && (parts[0] === '+' || parts[0] === 'A')) {
        out.push({
          dev: parts[2] as string,
          ino: parts[3] as string,
          birthtimeNs: parts[4] as string,
        });
      }
    }
    return out;
  }

  it(
    CHILD_OVER_CAP_TEST,
    () => {
      const fixture = runTempDir('sthayi-overcap-');
      props.push(fixture);
      const ledger = childLedger(fixture);

      // The child builds a flat tree one entry wider than the census can hold and removes it in ONE
      // recursive call, with its own `fs`, recording every level through the real loader.
      const childScript = [
        "import fs from 'node:fs';",
        "import path from 'node:path';",
        'if (process.versions.node !== process.env.STHAYI_EXPECT_NODE) {',
        "  console.error('child node ' + process.versions.node);",
        '  process.exit(9);',
        '}',
        'const base = process.argv[1];',
        'const count = Number(process.argv[2]);',
        "const tree = path.join(base, 'big');",
        'fs.mkdirSync(tree, { mode: 0o700 });',
        'for (let i = 0; i < count; i += 1) {',
        "  fs.mkdirSync(path.join(tree, 'd' + String(i).padStart(6, '0')), { mode: 0o700 });",
        '}',
        'fs.rmSync(tree, { recursive: true });',
        'process.stdout.write(JSON.stringify({ gone: !fs.existsSync(tree) }));',
      ].join('\n');

      const r = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', childScript, fixture, String(OVER_CAP)],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            NODE_OPTIONS: loaderOption(fixture, ledger),
            STHAYI_EXPECT_NODE: process.versions.node,
          },
        },
      );
      expect(r.stderr ?? '').toBe('');
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({ gone: true });
      expect(fs.existsSync(path.join(fixture, 'big'))).toBe(false); // the destruction really happened

      // The cap really was exceeded: more directories were recorded than one census can hold.
      const created = createdInLedger(ledger);
      expect(created.length).toBeGreaterThan(CHILD_CENSUS_LIMIT);

      // Not one of them may still authorise anything, in a process that only ever saw the file.
      const answer = replay(fixture, { inodes: created });
      const live = answer.inodes.filter((yes) => yes).length;
      expect(live).toBe(0);
    },
    OVER_CAP_TEST_TIMEOUT_MS,
  );

  /**
   * A RETIRED INODE MUST NOT COME BACK, and the way it comes back is the ledger being read as a
   * list of creations rather than as a HISTORY.
   *
   * The recorder answers "did this run create the directory that is being moved in?" by consulting
   * what it remembers and, failing that, by re-reading the ledger. A re-read that collects the
   * creation lines and ignores the retirements reinstates every number any process ever recorded —
   * including the ones a removal gave back to the kernel. An invalidation is then worth nothing: it
   * is undone by the next question anybody asks.
   *
   * THE RECYCLE IS WRITTEN OUT RATHER THAN WAITED FOR. Which inode the kernel hands back next is
   * not something a test may arrange, so the transcript is what is arranged: a directory recorded
   * as created and then retired, at the identity a PEER's directory actually has. That is exactly
   * the state a recycle produces, and it is the state the answer has to survive.
   */
  it.each([
    ['-', 'a retirement keyed by the name it was destroyed at'],
    ['D', 'a destruction stated as the identity itself'],
  ])('an inode retired by %s never authorises a directory moved in later', (op, _why) => {
    const fixture = runTempDir(`sthayi-retired-${op === '-' ? 'name' : 'id'}-`);
    props.push(fixture);
    const fixtureId = idOf(fixture);
    const ledger = childLedger(fixture);
    const outside = path.join(fixture, 'outside');

    // A directory this run did not make, made by a program it cannot witness.
    const planted = peer.run(
      [
        peerFs.mkdir(outside, { recursive: true }),
        peerFs.write(path.join(outside, 'canary'), 'PEER'),
      ],
      [outside],
    );
    expect(planted.status, planted.stderr).toBe(0);
    const outsideId = idOf(outside);

    // The transcript of a directory created, recorded and then destroyed — at the number the peer's
    // directory now wears.
    const slot = `${fixtureId.dev} ${fixtureId.ino} outside`;
    fs.appendFileSync(
      ledger,
      `+ ${outsideId.dev} ${outsideId.ino} ${slot}\n${op} ${outsideId.dev} ${outsideId.ino} ${slot}\n`,
      { mode: 0o600 },
    );

    const childScript = [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      'const base = process.argv[1];',
      "fs.renameSync(path.join(base, 'outside'), path.join(base, 'moved'));",
    ].join('\n');
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', childScript, fixture], {
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: loaderOption(fixture, ledger) },
    });
    expect(r.stderr ?? '').toBe('');
    expect(r.status).toBe(0);
    peer.adopt(path.join(fixture, 'moved')); // what the peer planted, under the name it now has

    const answer = replay(fixture, {
      inodes: [outsideId],
      children: [[fixtureId, 'moved']],
    });
    expect(answer.inodes[0]).toBe(false); // a retired number authorises nothing, ever again
    expect(answer.children[0]).toBeNull(); // and nothing was recorded at the name it moved to
    expect(fs.readFileSync(path.join(fixture, 'moved', 'canary'), 'utf8')).toBe('PEER');
  });

  /**
   * THE SAME DEFECT IN THE RECORDER THIS PROCESS USES, which the child loader's fix does not reach.
   *
   * `tests/helpers/child-dir-ledger.mjs` and `tests/helpers/owned-fs.ts` are two implementations of
   * one rule, and a fix to either says nothing about the other. The in-process census truncated
   * silently at its ceiling while `rmSync(..., { recursive: true })` went on to destroy the whole
   * tree — so the children past the cap were never counted, never retired, and went on carrying
   * creation authority for inode numbers the kernel had already taken back.
   *
   * THE LAST CHILD IS THE ONE TO ASK ABOUT. It is the furthest past the ceiling and therefore the
   * one a truncating census is guaranteed to have missed; a fix that merely raised the number would
   * leave it in exactly this state one directory further out.
   *
   * DONE IN A RUN ROOT OF ITS OWN, and last in the file. The answer to an uncountable destruction is
   * to invalidate everything, in this process and in the ledger every other process reads — so a
   * probe pointed at the suite's shared root would drop the records for every fixture every other
   * suite is still using, and the harness would leak them all.
   */
  it(
    IN_PROCESS_OVER_CAP_TEST,
    () => {
      const teardown = setup({ systemTemp: fs.realpathSync(os.tmpdir()) });
      const root = String(process.env[RUN_ROOT_ENV]);
      const tree = path.join(root, 'big');
      fs.mkdirSync(tree, { mode: 0o700 });
      const treeId = idOf(tree);
      const ids: Identity[] = [];
      for (let i = 0; i < IN_PROCESS_OVER_CAP; i += 1) {
        const child = path.join(tree, `d${String(i).padStart(6, '0')}`);
        fs.mkdirSync(child, { mode: 0o700 });
        ids.push(idOf(child));
      }
      const last = ids[ids.length - 1] as Identity;
      const lastName = `d${String(IN_PROCESS_OVER_CAP - 1).padStart(6, '0')}`;
      // A receipt keyed by the last child's inode, so the removal has one of every kind to lose.
      fs.writeFileSync(path.join(tree, lastName, 'held'), 'OURS');
      expect(wasCreatedThisRun(last)).toBe(true);
      expect(recordedChildIdentity(treeId, lastName)).toEqual(last);
      expect(entryReceipt(last, 'held')).toBeDefined();

      fs.rmSync(tree, { recursive: true });
      // Censused the moment the destruction returns: the records that would clear this root are the
      // ones under test, so an assertion that throws below must still leave nothing standing.
      peer.adopt(root);

      expect(fs.existsSync(tree)).toBe(false); // the destruction went ahead in full
      // Not one of the destroyed identities authorises anything — the ones past the cap included.
      expect(wasCreatedThisRun(last)).toBe(false);
      expect(recordedChildIdentity(treeId, lastName)).toBeUndefined();
      expect(entryReceipt(last, 'held')).toBeUndefined();
      expect(ids.filter((id) => wasCreatedThisRun(id))).toEqual([]);
      expect(wasCreatedThisRun(treeId)).toBe(false);

      // And the same question asked of a process that only ever saw the file.
      const answer = replay(root, {
        inodes: [last, treeId, ...ids.slice(0, 8)],
        children: [[treeId, lastName]],
        receipts: [[last, 'held']],
      });
      expect(answer.inodes.filter((yes) => yes)).toEqual([]);
      expect(answer.children[0]).toBeNull();
      expect(answer.receipts[0]).toBeNull();

      teardown();
    },
    OVER_CAP_TEST_TIMEOUT_MS,
  );

  /**
   * THE OTHER TWO WAYS A CENSUS STOPS EARLY, and they have to count for exactly as much as the
   * width cap does. A completeness rule that only knew about one of them would report a full census
   * for a tree it walked half of, which is the original defect wearing a different number.
   */
  it('a tree DEEPER than the census walk leaves nothing standing either', () => {
    const teardown = setup({ systemTemp: fs.realpathSync(os.tmpdir()) });
    const root = String(process.env[RUN_ROOT_ENV]);
    const tree = path.join(root, 'deep');
    fs.mkdirSync(tree, { mode: 0o700 });
    // Past `MAX_TREE_DEPTH` in `tests/helpers/owned-fs.ts`, which the walk counts from the target.
    let cur = tree;
    const ids: Identity[] = [idOf(tree)];
    for (let i = 0; i < 70; i += 1) {
      cur = path.join(cur, 'x');
      fs.mkdirSync(cur, { mode: 0o700 });
      ids.push(idOf(cur));
    }
    const deepest = ids[ids.length - 1] as Identity;
    expect(wasCreatedThisRun(deepest)).toBe(true);

    fs.rmSync(tree, { recursive: true });
    peer.adopt(root);

    expect(fs.existsSync(tree)).toBe(false);
    expect(ids.filter((id) => wasCreatedThisRun(id))).toEqual([]);
    const answer = replay(root, { inodes: [deepest, ids[0] as Identity] });
    expect(answer.inodes.filter((yes) => yes)).toEqual([]);

    teardown();
  });

  /**
   * A LEVEL THAT CANNOT BE LISTED, and the destruction that goes in regardless.
   *
   * `ENOENT` is the one listing failure that is not a gap: a directory that has already vanished
   * holds nothing left for the call to take. Everything else — a mode change, a lost permission —
   * means records may live below a level this walk will never see.
   *
   * The removal here FAILS, and that is the point: the invalidation is written before the
   * destructive call, so a removal that throws, or a process killed mid-call, has already given up
   * the authority rather than left it lying beside a half-removed tree.
   */
  it.skipIf(process.platform === 'win32')(
    'a level that cannot be LISTED invalidates before the call, even when the call fails',
    () => {
      const teardown = setup({ systemTemp: fs.realpathSync(os.tmpdir()) });
      const root = String(process.env[RUN_ROOT_ENV]);
      const tree = path.join(root, 'blind');
      const sub = path.join(tree, 'sub');
      const inner = path.join(sub, 'inner');
      fs.mkdirSync(tree, { mode: 0o700 });
      fs.mkdirSync(sub, { mode: 0o700 });
      fs.mkdirSync(inner, { mode: 0o700 }); // so the removal must LIST `sub`, not merely `rmdir` it
      const treeId = idOf(tree);
      const subId = idOf(sub);
      expect(wasCreatedThisRun(subId)).toBe(true);
      // Censused while everything is still readable: this tree SURVIVES the call by design, and the
      // records that would otherwise clear it are the ones this test invalidates.
      peer.adopt(root);

      // Unreadable to the walk, and to the removal after it. Done by a program these wrappers do not
      // witness, so nothing here is recording a mode this run did not intend to keep.
      const shut = peer.run([peerFs.chmod(sub, 0o300)], []);
      expect(shut.status, shut.stderr).toBe(0);

      expect(() => fs.rmSync(tree, { recursive: true })).toThrow();

      const open = peer.run([peerFs.chmod(sub, 0o700)], []);
      expect(open.status, open.stderr).toBe(0);

      expect(fs.existsSync(sub)).toBe(true); // the removal really did fail
      expect(wasCreatedThisRun(subId)).toBe(false); // and the authority went before it was attempted
      expect(wasCreatedThisRun(treeId)).toBe(false);
      const answer = replay(root, { inodes: [subId, treeId] });
      expect(answer.inodes.filter((yes) => yes)).toEqual([]);

      teardown();
    },
  );
});
