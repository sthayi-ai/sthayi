import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { identityFromBigStat, recordedChildIdentity, removeOwned } from '../helpers/owned-fs.js';
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

/**
 * SAFETY: the creation ledger has to work between processes that share NOTHING but the filesystem.
 *
 * This is the arrangement production runs in and it is easy to fake. Fixtures are created in vitest
 * WORKER processes — and, deeper still, in the `sthayi` children those workers spawn — while the run
 * root is swept in the PARENT, which witnessed no creating call at all. A suite that drives setup,
 * creation and teardown inside ONE process proves nothing about that: the in-memory maps are already
 * populated, so a ledger that never persisted a single usable line would still look like it worked,
 * and the day the two processes are really different every fixture leaks.
 *
 * So both halves here are REAL PROCESSES. A node child builds a tree several levels deep inside a
 * fixture, using its own `fs` — nothing wrapped in this process can see any of it. Then a FRESH
 * process, with every map empty and no receipt for anything, is asked to tear the whole run root
 * down. Everything it manages to remove, it removed on persisted evidence alone: the device/inode
 * published in the environment when the root was created, and the ledger inside the root.
 *
 * WHY THE IDENTITY TRAVELS IN THE ENVIRONMENT. Reading it back out of the root would let a
 * replacement vouch for itself — a directory swapped in at the path can carry any marker it likes.
 * The published dev/ino is the one thing it cannot forge, and the last test here is the proof: a
 * fresh parent handed the wrong identity refuses and leaves the tree exactly where it is.
 */
describe('safety: a fresh process sweeps on persisted evidence alone', () => {
  const props: string[] = [];
  /**
   * What a child's peer planted, recorded as it was planted and cleared on the same identities.
   *
   * The decoy has to come from a program nothing here witnesses, and it has to go again or the run
   * root leaks around it — but not by aiming a recursive shell removal at its pathname, which is the
   * hazard the whole ledger exists to make unnecessary. See `tests/helpers/peer-fixtures.ts`.
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
    // The root, the token and the identity are ONE published fact and are restored together: a
    // simulated run's identity left next to the real run's path describes a root that does not
    // exist, and every later allocation in this worker would refuse it.
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

  const systemTemp = (): string => fs.realpathSync(os.tmpdir());

  /**
   * A child that creates a deep tree with its OWN `fs`.
   *
   * It asserts its own runtime version rather than assuming the parent's was inherited: a child on
   * a different node has different `fs` internals, and a recorder that silently did nothing there
   * would look exactly like a recorder that worked.
   */
  const childScript = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    'if (process.versions.node !== process.env.STHAYI_EXPECT_NODE) {',
    "  console.error('child node ' + process.versions.node + ' expected ' + process.env.STHAYI_EXPECT_NODE);",
    '  process.exit(9);',
    '}',
    'const base = process.argv[1];',
    "fs.mkdirSync(path.join(base, 'deep', 'a', 'b', 'c'), { recursive: true, mode: 0o700 });",
    "fs.writeFileSync(path.join(base, 'deep', 'a', 'b', 'c', 'db'), 'CHILD-STORE');",
    "fs.mkdirSync(path.join(base, 'deep', 'solo'), { mode: 0o700 });",
    "fs.writeFileSync(path.join(base, 'deep', 'solo', 'key'), 'CHILD-KEY');",
  ].join('\n');

  /** Direct copyFileSync matrix for the duplicate recorder installed in Node children. */
  const childCopyScript = [
    "const cp = require('node:child_process');",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    'const base = process.argv[1];',
    'const peerHelper = process.argv[2];',
    'const peer = (ops) => cp.execFileSync(process.execPath, [peerHelper, JSON.stringify(ops)], {',
    "  env: { ...process.env, NODE_OPTIONS: '' },",
    '});',
    'const at = (name) => path.join(base, name);',
    'const show = (name) => {',
    '  const file = at(name);',
    '  const st = fs.lstatSync(file);',
    "  return `mode=0${(st.mode & 0o7777).toString(8)} content=${fs.readFileSync(file, 'utf8')}`;",
    '};',
    'const showMode = (name) => {',
    '  const st = fs.lstatSync(at(name));',
    '  return `mode=0${(st.mode & 0o7777).toString(8)}`;',
    '};',
    'peer([',
    "  { kind: 'write', path: at('writable-src'), data: 'W' },",
    "  { kind: 'write', path: at('writable-dest'), data: 'OLD-LONG-TAIL' },",
    "  { kind: 'write', path: at('readonly-src'), data: 'READONLY' },",
    "  { kind: 'chmod', path: at('readonly-src'), mode: 0o444 },",
    "  { kind: 'write', path: at('readonly-dest'), data: 'OLD' },",
    "  { kind: 'write', path: at('umask-src'), data: 'UMASK' },",
    "  { kind: 'write', path: at('same'), data: 'SAME' },",
    "  { kind: 'write', path: at('chmod-file'), data: 'CHMOD' },",
    ']);',
    'let result;',
    'try {',
    "  fs.copyFileSync(at('writable-src'), at('writable-dest'));",
    "  fs.copyFileSync(at('readonly-src'), at('readonly-dest'));",
    '  const previous = process.umask(0o222);',
    '  try {',
    "    fs.copyFileSync(at('umask-src'), at('umask-dest'));",
    '  } finally {',
    '    process.umask(previous);',
    '  }',
    "  fs.copyFileSync(at('same'), at('same'));",
    "  fs.mkdirSync(at('chmod-dir'));",
    "  fs.chmodSync(at('chmod-dir'), 0o751);",
    "  fs.chmodSync(at('chmod-file'), 0o444);",
    '  result = {',
    "    writable: show('writable-dest'),",
    "    readonly: show('readonly-dest'),",
    "    umask: show('umask-dest'),",
    "    same: show('same'),",
    "    chmodDir: showMode('chmod-dir'),",
    "    chmodFile: show('chmod-file'),",
    '  };',
    '} finally {',
    '  peer([',
    "    { kind: 'chmod', path: at('readonly-src'), mode: 0o666 },",
    "    { kind: 'chmod', path: at('readonly-dest'), mode: 0o666 },",
    "    { kind: 'chmod', path: at('umask-dest'), mode: 0o666 },",
    "    { kind: 'chmod', path: at('chmod-file'), mode: 0o666 },",
    '  ]);',
    '}',
    'process.stdout.write(JSON.stringify(result));',
  ].join('\n');

  /**
   * The loader option a run hands its children, aimed at the root THIS TEST published.
   *
   * Built here rather than inherited because the option a worker carries was baked when
   * `owned-fs.ts` was imported, and it names the run root that existed then. These tests stand up
   * their own root — pointing a child at the suite's real one would have it recording into, and a
   * sweep removing, the fixtures every other worker is still using. The mechanism under test is
   * unchanged: the same loader file, reached the same way, with the ledger and root travelling
   * inside the URL exactly as `publishChildRecorder()` sends them.
   */
  function childLoaderOption(root: string): string {
    const loader = pathToFileURL(path.join(repoRoot, 'tests', 'helpers', 'child-dir-ledger.mjs'));
    loader.searchParams.set('ledger', path.join(root, RUN_DIRS));
    loader.searchParams.set('root', root);
    return `--import=${loader.href}`;
  }

  function runChild(root: string, fixture: string): void {
    const r = spawnSync(process.execPath, ['-e', childScript, fixture], {
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_OPTIONS: childLoaderOption(root),
        STHAYI_EXPECT_NODE: process.versions.node,
      },
    });
    expect(r.stderr ?? '').toBe('');
    expect(r.status).toBe(0);
  }

  function runPeer(operations: readonly PeerOperation[]): void {
    const r = runPeerOperations(operations);
    expect(r.status, r.stderr).toBe(0);
  }

  /**
   * A FRESH process asked to sweep: empty maps, no receipts, only what is on disk and in env.
   *
   * SPAWNED AS `process.execPath`, NEVER AS THE `tsx` SHIM. `node_modules/.bin/tsx` is a shell
   * script that runs whatever `node` PATH resolves to, so the sweep would silently be performed by
   * some other runtime the moment PATH differed from the one running this suite — a version skew
   * that changes `fs` internals and `readdir` order underneath the very behaviour being asserted,
   * and that no assertion here would report. The interpreter is therefore named explicitly and
   * TypeScript support is loaded into it with `--import tsx`, which is the same loader the shim
   * would have used with none of its PATH lookup. The sweeper is told which runtime it is supposed
   * to be and exits 9 if it is any other, so the claim is checked inside the child rather than
   * assumed by the parent.
   *
   * `NODE_OPTIONS` carries only that loader: a sweep is not a creating process and has no business
   * recording anything anywhere, so the run's child recorder is deliberately not passed on.
   */
  function freshParentSweep(env: NodeJS.ProcessEnv): { status: number | null; err: string } {
    const r = spawnSync(process.execPath, ['--import', 'tsx', sweeper], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...env, NODE_OPTIONS: '', STHAYI_EXPECT_NODE: process.versions.node },
    });
    return { status: r.status, err: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  }

  it('the sweeper runs on THIS runtime, and says so rather than being taken on trust', () => {
    // The negative half of the rule above: a sweeper handed a version it is not gets no further
    // than the check, and the version it reports is the one this suite is running on.
    const r = spawnSync(process.execPath, ['--import', 'tsx', sweeper], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '', STHAYI_EXPECT_NODE: '0.0.0-not-a-node' },
    });
    expect(r.status).toBe(9);
    expect(r.stderr).toContain(`sweeper node ${process.versions.node} expected 0.0.0-not-a-node`);
  });

  it('a CHILD builds a deep tree and a FRESH PARENT removes the whole root', () => {
    const teardown = setup({ systemTemp: systemTemp() });
    const root = String(process.env[RUN_ROOT_ENV]);
    props.push(root);
    const fixture = runTempDir('sthayi-xproc-');
    const fixtureId = identityFromBigStat(fs.lstatSync(fixture, { bigint: true }));
    if (fixtureId === null) throw new Error('fixture has no test identity');

    runChild(root, fixture);
    expect(fs.readFileSync(path.join(fixture, 'deep', 'a', 'b', 'c', 'db'), 'utf8')).toBe(
      'CHILD-STORE',
    );

    // THIS process has no record of any of it: the child's `mkdir` happened in another process with
    // another `fs`, so whatever the sweep below manages to do, it does not do from memory.
    expect(recordedChildIdentity(fixtureId, 'deep')).toBeUndefined();
    // The evidence exists, and it exists on disk.
    expect(fs.readFileSync(path.join(root, RUN_DIRS), 'utf8')).toContain(' deep\n');

    const swept = freshParentSweep({ ...process.env });

    expect(swept.err).toBe('');
    expect(swept.status).toBe(0);
    expect(fs.existsSync(root)).toBe(false); // root, fixture and the child's tree, all of it

    teardown(); // idempotent: the root it published is already gone
    props.splice(0);
  });

  it('the child copy recorder matches native copy semantics and records only exact shapes', () => {
    const teardown = setup({ systemTemp: systemTemp() });
    const root = String(process.env[RUN_ROOT_ENV]);
    props.push(root);
    const bare = runTempDir('sthayi-xproccopy-bare-');
    const wrapped = runTempDir('sthayi-xproccopy-wrapped-');

    const run = (base: string, recorded: boolean) =>
      spawnSync(process.execPath, ['-e', childCopyScript, base, peerFsChildPath], {
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_OPTIONS: recorded ? childLoaderOption(root) : '',
        },
      });

    const nativeResult = run(bare, false);
    const recordedResult = run(wrapped, true);

    // Restore independently too: even a copy failure must not leave READONLY fixtures that defeat
    // the identity-based peer cleanup below.
    for (const base of [bare, wrapped]) {
      runPeer([
        peerFs.chmod(path.join(base, 'readonly-src'), 0o666),
        peerFs.chmod(path.join(base, 'readonly-dest'), 0o666),
        peerFs.chmod(path.join(base, 'umask-dest'), 0o666),
        peerFs.chmod(path.join(base, 'chmod-file'), 0o666),
      ]);
      peer.adopt(base);
    }

    expect(nativeResult.stderr ?? '').toBe('');
    expect(nativeResult.status).toBe(0);
    expect(recordedResult.stderr ?? '').toBe('');
    expect(recordedResult.status).toBe(0);
    const nativeParsed = JSON.parse(nativeResult.stdout ?? '') as Record<string, string>;
    const recordedParsed = JSON.parse(recordedResult.stdout ?? '') as Record<string, string>;
    expect(recordedParsed).toEqual(nativeParsed);
    expect(nativeParsed.chmodDir).toMatch(/^mode=0/);
    expect(nativeParsed.chmodFile).toContain('content=CHMOD');

    const receiptNames = fs
      .readFileSync(path.join(root, RUN_DIRS), 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('F v2 '))
      .map((line) => line.split(' ').slice(8).join(' '));

    expect(receiptNames).toContain('writable-dest');
    expect(receiptNames).toContain('chmod-file');
    expect(receiptNames).not.toContain('same');
    expect(receiptNames).not.toContain('chmod-dir');
    if (process.platform === 'win32') {
      expect(receiptNames).not.toContain('readonly-dest');
      expect(receiptNames).not.toContain('umask-dest');
    } else {
      expect(receiptNames).toContain('readonly-dest');
      expect(receiptNames).toContain('umask-dest');
    }

    peer.clear();
    teardown();
    props.splice(0);
  });

  it.skipIf(process.platform !== 'win32')(
    'a Windows child owns its CRT umask independently of its parent',
    () => {
      const teardown = setup({ systemTemp: systemTemp() });
      const root = String(process.env[RUN_ROOT_ENV]);
      props.push(root);

      const previous = process.umask(0o222);
      let nativeChild: ReturnType<typeof spawnSync> | undefined;
      let recordedChild: ReturnType<typeof spawnSync> | undefined;
      try {
        const script = 'process.stdout.write(String(process.umask(0)))';
        nativeChild = spawnSync(process.execPath, ['-e', script], {
          encoding: 'utf8',
          env: { ...process.env, NODE_OPTIONS: '' },
        });
        recordedChild = spawnSync(process.execPath, ['-e', script], {
          encoding: 'utf8',
          env: { ...process.env, NODE_OPTIONS: childLoaderOption(root) },
        });
      } finally {
        process.umask(previous);
      }

      expect(nativeChild?.stderr ?? '').toBe('');
      expect(recordedChild?.stderr ?? '').toBe('');
      expect(nativeChild?.status).toBe(0);
      expect(recordedChild?.status).toBe(0);
      expect(nativeChild?.stdout).toBe('0');
      expect(recordedChild?.stdout).toBe(nativeChild?.stdout);

      teardown();
      props.splice(0);
    },
  );

  /**
   * A child that is SUBSTITUTED AGAINST in the window between its own `mkdir` and its own record.
   *
   * The seam is driven from inside the child, on the recorder's first `lstat` of the new path — the
   * same window the parent's recorder has, in a process where nothing the parent wraps applies. The
   * substitution itself is performed by an uninstrumented Node child, so it is invisible to the
   * creating child's wrappers too.
   */
  const hostileChildScript = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const cp = require('node:child_process');",
    'if (process.versions.node !== process.env.STHAYI_EXPECT_NODE) {',
    "  console.error('child node ' + process.versions.node + ' expected ' + process.env.STHAYI_EXPECT_NODE);",
    '  process.exit(9);',
    '}',
    'const at = path.join(process.argv[1], MADE);',
    'const peerHelper = process.argv[2];',
    'let fired = false;',
    'const real = fs.lstatSync;',
    'fs.lstatSync = (p, o) => {',
    '  if (!fired && String(p) === at) {',
    '    fired = true;',
    '    cp.execFileSync(process.execPath, [peerHelper, JSON.stringify([',
    "      { kind: 'rename', from: at, to: at + '-aside' },",
    "      { kind: 'mkdir', path: path.join(at, 'nested'), recursive: true },",
    "      { kind: 'write', path: path.join(at, 'nested', 'canary'), data: 'FOREIGN' },",
    "    ])], { env: { ...process.env, NODE_OPTIONS: '' } });",
    '  }',
    '  return real(p, o);',
    '};',
    'fs.mkdirSync(at, { mode: 0o700 });',
    'fs.lstatSync = real;',
    'if (!fired) { process.exit(8); }',
  ].join('\n');

  it('a CHILD substituted against between its mkdir and its record writes no line for it', () => {
    const teardown = setup({ systemTemp: systemTemp() });
    const root = String(process.env[RUN_ROOT_ENV]);
    props.push(root);
    const fixture = runTempDir('sthayi-xprochostile-');
    const made = 'made';

    const r = spawnSync(
      process.execPath,
      ['-e', hostileChildScript.replace('MADE', JSON.stringify(made)), fixture, peerFsChildPath],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_OPTIONS: childLoaderOption(root),
          STHAYI_EXPECT_NODE: process.versions.node,
        },
      },
    );
    expect(r.stderr ?? '').toBe('');
    expect(r.status).toBe(0); // exit 8 would mean the race never actually ran

    const at = path.join(fixture, made);
    // The plant happened inside the child, so this is the first instant the parent can record what
    // stands there — and it is recorded before anything else in this test touches it.
    peer.adopt(at);
    peer.adopt(`${at}-aside`);
    expect(fs.readFileSync(path.join(at, 'nested', 'canary'), 'utf8')).toBe('FOREIGN');
    // A child records on the identity its own `mkdir` captured, so the tree that turned up at the
    // name gets no line — and a line is the only thing that would ever let a sweep enter it.
    expect(fs.readFileSync(path.join(root, RUN_DIRS), 'utf8')).not.toContain(` ${made}\n`);

    // The sweep therefore refuses: an unrecorded, nonempty directory takes the whole walk down and
    // the run root leaks around it, which is the trade this design makes on purpose.
    const swept = freshParentSweep({ ...process.env });
    expect(swept.status).toBe(3);
    expect(fs.readFileSync(path.join(at, 'nested', 'canary'), 'utf8')).toBe('FOREIGN');

    teardown();
  });

  /**
   * A child substituted against in the EARLIEST window there is, by an EMPTY directory.
   *
   * POSIX captures through a descriptor, so its seam is the first `openSync` on the new path.
   * Windows has no equivalent no-follow directory descriptor and deliberately proves freshness by
   * `lstat -> listing -> lstat`, so its equivalent seam is the first `lstatSync`. Either seam puts
   * the replacement in front of every leg of the platform's proof.
   *
   * And the replacement is EMPTY, which is the shape a fresh `mkdir` produces. There is nothing
   * left for a check to disagree with, so the child records the peer's inode — deliberately, and
   * the assertion below says so. What must not follow is a sweep that then empties it.
   */
  const emptyWindowChildScript = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const cp = require('node:child_process');",
    'if (process.versions.node !== process.env.STHAYI_EXPECT_NODE) {',
    "  console.error('child node ' + process.versions.node + ' expected ' + process.env.STHAYI_EXPECT_NODE);",
    '  process.exit(9);',
    '}',
    'const at = path.join(process.argv[1], MADE);',
    'const peerHelper = process.argv[2];',
    'let fired = false;',
    'const realOpen = fs.openSync;',
    'const realLstat = fs.lstatSync;',
    'const swap = () => {',
    '  if (!fired) {',
    '    fired = true;',
    // The directory being displaced was made by the `mkdir` this fires inside, so it is empty and
    // one `rmdir` takes it. Nothing here hands a pathname to a recursive removal.
    '    cp.execFileSync(process.execPath, [peerHelper, JSON.stringify([',
    "      { kind: 'rmdir', path: at },",
    "      { kind: 'mkdir', path: at, mode: 0o700 },",
    "    ])], { env: { ...process.env, NODE_OPTIONS: '' } });",
    '  }',
    '};',
    "if (process.platform === 'win32') {",
    '  fs.lstatSync = (p, o) => {',
    '    if (String(p) === at) swap();',
    '    return realLstat(p, o);',
    '  };',
    '} else {',
    '  fs.openSync = (p, f, m) => {',
    '    if (String(p) === at) swap();',
    '    return realOpen(p, f, m);',
    '  };',
    '}',
    'fs.mkdirSync(at, { mode: 0o700 });',
    'fs.openSync = realOpen;',
    'fs.lstatSync = realLstat;',
    'if (!fired) { process.exit(8); }',
  ].join('\n');

  it('a CHILD tricked by an EMPTY substitution records it — and the sweep still will not empty it', () => {
    const teardown = setup({ systemTemp: systemTemp() });
    const root = String(process.env[RUN_ROOT_ENV]);
    props.push(root);
    const fixture = runTempDir('sthayi-xprocempty-');
    const made = 'made';

    const r = spawnSync(
      process.execPath,
      [
        '-e',
        emptyWindowChildScript.replace('MADE', JSON.stringify(made)),
        fixture,
        peerFsChildPath,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_OPTIONS: childLoaderOption(root),
          STHAYI_EXPECT_NODE: process.versions.node,
        },
      },
    );
    expect(r.stderr ?? '').toBe('');
    expect(r.status).toBe(0); // exit 8 would mean the race never actually ran

    const at = path.join(fixture, made);
    // The line IS written, for the peer's directory. That is the honest state of the art: no check
    // available after a `mkdir` returns can separate the directory it made from an empty one
    // standing at the same name, so the record is wrong and the design has to survive it being
    // wrong rather than promise it never is.
    expect(fs.readFileSync(path.join(root, RUN_DIRS), 'utf8')).toContain(` ${made}\n`);
    // And not one RECEIPT line naming an entry INSIDE it: the child made the directory and put
    // nothing in it, so the sweep has authority over the directory and over nothing it holds. A
    // receipt carries the parent's identity in its fourth and fifth fields, which is what makes
    // "no entry of this inode was ever claimed" a question the ledger can answer.
    const madeIdentity = identityFromBigStat(fs.lstatSync(at, { bigint: true }));
    if (madeIdentity === null) throw new Error('replacement has no test identity');
    const receiptsInside = fs
      .readFileSync(path.join(root, RUN_DIRS), 'utf8')
      .split('\n')
      .filter(
        (l) =>
          l.startsWith('F ') &&
          l.split(' ').slice(5, 8).join(' ') ===
            `${madeIdentity.dev} ${madeIdentity.ino} ${madeIdentity.birthtimeNs}`,
      );
    expect(receiptsInside).toEqual([]);

    // The peer fills the name it now owns, after the record was already written.
    runPeer([
      peerFs.write(path.join(at, 'top-canary'), 'FOREIGN-TOP'),
      peerFs.write(path.join(at, 'second-canary'), 'FOREIGN-SECOND'),
    ]);
    peer.adopt(at);

    const swept = freshParentSweep({ ...process.env });

    expect(swept.status).toBe(3); // refused, and the root leaks around it on purpose
    expect(fs.readFileSync(path.join(at, 'top-canary'), 'utf8')).toBe('FOREIGN-TOP');
    expect(fs.readFileSync(path.join(at, 'second-canary'), 'utf8')).toBe('FOREIGN-SECOND');

    teardown();
  });

  it('a fresh parent handed the WRONG published identity refuses and removes nothing', () => {
    const teardown = setup({ systemTemp: systemTemp() });
    const root = String(process.env[RUN_ROOT_ENV]);
    props.push(root);
    const fixture = runTempDir('sthayi-xprocid-');
    runChild(root, fixture);

    // The path is right, the ledger inside is right, the marker is right. Only the identity
    // published when the root was created disagrees — and that alone is disqualifying, because it is
    // the one thing a directory swapped in at the path cannot reproduce.
    const swept = freshParentSweep({
      ...process.env,
      [RUN_IDENTITY_ENV]: JSON.stringify({ v: 3, dev: '1', ino: '2', birthtimeNs: '1' }),
    });

    expect(swept.status).toBe(3);
    expect(fs.existsSync(root)).toBe(true);
    expect(fs.readFileSync(path.join(fixture, 'deep', 'a', 'b', 'c', 'db'), 'utf8')).toBe(
      'CHILD-STORE',
    );

    teardown();
    props.splice(0);
  });

  /**
   * A child that writes four entries and then takes every one of them away again, by each of the
   * routes a program has for doing it.
   *
   * The entries are gone from the filesystem when it exits; what matters is what the LEDGER still
   * says about them.
   */
  const retiringChildScript = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    'if (process.versions.node !== process.env.STHAYI_EXPECT_NODE) {',
    "  console.error('child node ' + process.versions.node + ' expected ' + process.env.STHAYI_EXPECT_NODE);",
    '  process.exit(9);',
    '}',
    'const base = process.argv[1];',
    'const at = (n) => path.join(base, n);',
    "fs.writeFileSync(at('unlinked'), 'CHILD');",
    "fs.unlinkSync(at('unlinked'));",
    "fs.writeFileSync(at('removed'), 'CHILD');",
    "fs.rmSync(at('removed'));",
    "fs.writeFileSync(at('source'), 'CHILD');",
    "fs.renameSync(at('source'), at('destination'));",
    "fs.unlinkSync(at('destination'));",
  ].join('\n');

  it('a child RETIRES the receipt for every entry it takes away again', () => {
    const teardown = setup({ systemTemp: systemTemp() });
    const root = String(process.env[RUN_ROOT_ENV]);
    props.push(root);
    const fixture = runTempDir('sthayi-xprocretire-');

    const r = spawnSync(process.execPath, ['-e', retiringChildScript, fixture], {
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_OPTIONS: childLoaderOption(root),
        STHAYI_EXPECT_NODE: process.versions.node,
      },
    });
    expect(r.stderr ?? '').toBe('');
    expect(r.status).toBe(0);
    expect(fs.readdirSync(fixture)).toEqual([]); // every one of them really is gone

    // AN INODE NUMBER GOES BACK TO THE KERNEL WITH THE OBJECT THAT HELD IT, and the kernel hands
    // numbers out again. A receipt that outlives its entry is authority attached to an integer: the
    // next object to inherit that number, at that name, in a directory this run may still walk,
    // would satisfy it exactly — and the process that could have said otherwise has already exited.
    // So the ledger has to carry the retirement, not just the claim.
    const lines = fs.readFileSync(path.join(root, RUN_DIRS), 'utf8').split('\n');
    const live = (name: string): number => {
      let held = 0;
      for (const line of lines) {
        const parts = line.split(' ');
        if (parts.slice(8).join(' ') !== name) {
          continue;
        }
        if (parts[0] === 'F' || parts[0] === 'L') {
          held += 1;
        } else if (parts[0] === '-') {
          held -= 1;
        }
      }
      return held;
    };
    for (const name of ['unlinked', 'removed', 'source', 'destination']) {
      expect(
        live(name),
        `a receipt for ${name} outlived the entry it described`,
      ).toBeLessThanOrEqual(0);
    }
    // And the claims really were made, so the assertion above is not passing on an empty ledger.
    expect(lines.some((l) => l.startsWith('F ') && l.endsWith(' unlinked'))).toBe(true);
    expect(lines.some((l) => l.startsWith('F ') && l.endsWith(' destination'))).toBe(true);

    // A FRESH parent, holding nothing but the ledger, must not act on any of it: it removes the
    // fixture because the fixture is recorded, and it never needed a receipt for an entry that is
    // not there.
    const swept = freshParentSweep({ ...process.env });
    expect(swept.err).toBe('');
    expect(swept.status).toBe(0);
    expect(fs.existsSync(root)).toBe(false);

    teardown();
    props.splice(0);
  });

  it('a fresh parent refuses an entry that took a retired name after the fact', () => {
    const teardown = setup({ systemTemp: systemTemp() });
    const root = String(process.env[RUN_ROOT_ENV]);
    props.push(root);
    const fixture = runTempDir('sthayi-xprocstale-');

    const r = spawnSync(process.execPath, ['-e', retiringChildScript, fixture], {
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_OPTIONS: childLoaderOption(root),
        STHAYI_EXPECT_NODE: process.versions.node,
      },
    });
    expect(r.status).toBe(0);

    // Somebody else takes one of the vacated names. The child's claim named a different object, and
    // the retirement says so; nothing about the name is inherited by what arrives next.
    const taken = path.join(fixture, 'destination');
    runPeer([peerFs.write(taken, 'STRANGER')]);
    peer.adopt(taken);

    const swept = freshParentSweep({ ...process.env });

    expect(swept.err).toBe('');
    expect(swept.status).toBe(3); // refused, and the root leaks around it on purpose
    expect(fs.readFileSync(taken, 'utf8')).toBe('STRANGER');

    teardown();
  });
});
