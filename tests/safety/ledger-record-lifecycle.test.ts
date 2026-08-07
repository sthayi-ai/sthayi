import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type Identity,
  identityFromBigStat,
  recordedChildIdentity,
  removeOwned,
  sameIdentity,
} from '../helpers/owned-fs.js';
import { runTempDir } from '../helpers/run-temp.js';
import setup, {
  RUN_DIRS,
  RUN_IDENTITY_ENV,
  RUN_ROOT_ENV,
  RUN_TOKEN_ENV,
} from '../helpers/temp-sweep.js';

/**
 * SAFETY: A CREATION RECORD MAY NOT OUTLIVE THE DIRECTORY IT NAMES.
 *
 * A record says "this run created inode I at name N inside directory P", and the walk spends it by
 * ENTERING whatever answers to N. Two ordinary operations end the fact a record asserts while
 * leaving the record itself standing, and both of them then hand that spent authority to something
 * this run never made:
 *
 *   A RECURSIVE REMOVAL destroys a whole tree inside one call. Only the TOP of that tree is named
 *     by the call; every recorded directory underneath it is destroyed without being mentioned. The
 *     inode numbers those records name go straight back to the kernel, which hands them out again —
 *     to a concurrent run's fixture, or to a peer's directory. `createdThisRun()` then answers YES
 *     for a directory this run never made, and the walk enters it.
 *   A RENAME gives a directory a second name. The destination is recorded, correctly; the SOURCE
 *     name keeps its record, and that record is now a promise about a name whose directory has
 *     moved away. What arrives at the source name next inherits an authority nobody granted it.
 *
 * The rule both halves obey is the same one the removal wrappers already state: records are read
 * BEFORE the call, while the directories they describe still exist, and retired for exactly what
 * the call really did take away or move.
 *
 * THE LEDGER IS THE THING UNDER TEST, NOT THE MAPS. Fixtures are created in vitest workers and in
 * the `sthayi` children those workers spawn, and the run root is swept in a parent that witnessed
 * none of it. A retirement kept only in the process that performed the removal is invisible exactly
 * where it matters, so the assertions below read the persisted ledger for the cross-process half.
 */
describe('safety: a creation record dies with the directory it named', () => {
  const props: string[] = [];
  let saved: Record<string, string | undefined> = {};

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

  beforeEach(() => {
    saved = {
      [RUN_ROOT_ENV]: process.env[RUN_ROOT_ENV],
      [RUN_TOKEN_ENV]: process.env[RUN_TOKEN_ENV],
      [RUN_IDENTITY_ENV]: process.env[RUN_IDENTITY_ENV],
    };
  });

  afterEach(() => {
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
    for (const p of props.splice(0).reverse()) {
      removeOwned(p);
    }
  });

  const systemTemp = (): string => fs.realpathSync(os.tmpdir());

  function identify(dir: string): Identity {
    const id = identityFromBigStat(fs.lstatSync(dir, { bigint: true }));
    if (id === null) throw new Error(`no test identity for ${dir}`);
    return id;
  }

  /**
   * The loader option a run hands its children, aimed at the root THIS TEST published.
   *
   * Built here rather than inherited: the option a worker carries was baked when `owned-fs.ts` was
   * imported and names the run root that existed then, so pointing a child at it would have the
   * child recording into fixtures every other worker is still using.
   */
  function childLoaderOption(root: string): string {
    const loader = pathToFileURL(path.join(repoRoot, 'tests', 'helpers', 'child-dir-ledger.mjs'));
    loader.searchParams.set('ledger', path.join(root, RUN_DIRS));
    loader.searchParams.set('root', root);
    return `--import=${loader.href}`;
  }

  function runChild(root: string, script: string, ...args: string[]): void {
    const r = spawnSync(process.execPath, ['-e', script, ...args], {
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

  /**
   * The identity a ledger still grants to one name in one directory, or `null` when every claim for
   * it has been released.
   *
   * Replayed in append order and by the same rules the sweep replays them with: `A` pins and is
   * never overwritten, `+` records the latest directory made at the name, and `-` and `M` release
   * only when they name the identity currently held — a stale or replayed line must not be able to
   * knock out a live record.
   */
  function liveRecord(ledger: string, parent: Identity, name: string): Identity | null {
    let pinned: Identity | null = null;
    let created: Identity | null = null;
    const same = (a: Identity | null, b: Identity): boolean => a !== null && sameIdentity(a, b);
    for (const line of fs.readFileSync(ledger, 'utf8').split('\n')) {
      const parts = line.split(' ');
      if (parts.length < 9 || parts[1] !== 'v2' || parts.slice(8).join(' ') !== name) {
        continue;
      }
      const op = parts[0];
      const ledgerParent: Identity = {
        dev: parts[5] as string,
        ino: parts[6] as string,
        birthtimeNs: parts[7] as string,
      };
      if (!sameIdentity(ledgerParent, parent)) {
        continue;
      }
      const id: Identity = {
        dev: parts[2] as string,
        ino: parts[3] as string,
        birthtimeNs: parts[4] as string,
      };
      if (op === 'A') {
        pinned ??= id;
      } else if (op === '+') {
        if (pinned === null) {
          created = id;
        }
      } else if (op === '-') {
        if (same(pinned, id)) {
          pinned = null;
        }
        if (same(created, id)) {
          created = null;
        }
      } else if (op === 'M' && same(created, id)) {
        created = null; // a move releases the name it left; a pin outlives it
      }
    }
    return pinned ?? created;
  }

  /**
   * A child that builds a recorded tree three levels deep and then destroys ALL of it with one
   * recursive call — the shape a CLI takes when it wipes the home it was pointed at.
   */
  const recursiveChild = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    'if (process.versions.node !== process.env.STHAYI_EXPECT_NODE) {',
    "  console.error('child node ' + process.versions.node);",
    '  process.exit(9);',
    '}',
    'const base = process.argv[1];',
    "const top = path.join(base, 'top');",
    "fs.mkdirSync(path.join(top, 'mid', 'leaf'), { recursive: true, mode: 0o700 });",
    'fs.rmSync(top, { recursive: true });',
  ].join('\n');

  it('a CHILD that recursively removes a tree retires the record for every level of it', () => {
    const teardown = setup({ systemTemp: systemTemp() });
    const root = String(process.env[RUN_ROOT_ENV]);
    props.push(root);
    const fixture = runTempDir('sthayi-ledgerrm-');
    const fixtureId = identify(fixture);

    runChild(root, recursiveChild, fixture);
    expect(fs.existsSync(path.join(fixture, 'top'))).toBe(false);

    const ledger = path.join(root, RUN_DIRS);
    const topId = liveRecord(ledger, fixtureId, 'top');
    expect(topId).toBeNull(); // the level the call named

    // AND EVERY LEVEL BENEATH IT. These were recorded on the way in, destroyed inside a single call,
    // and never mentioned by it. A record still standing here is authority attached to an inode
    // number the kernel is already free to hand to somebody else's directory, held by a process that
    // has exited and cannot be asked to reconsider.
    const midParent = liveRecord(ledger, fixtureId, 'top');
    expect(midParent).toBeNull();
    const stale: string[] = [];
    for (const line of fs.readFileSync(ledger, 'utf8').split('\n')) {
      const parts = line.split(' ');
      if (parts.length < 9 || parts[1] !== 'v2' || (parts[0] !== '+' && parts[0] !== 'A')) {
        continue;
      }
      const name = parts.slice(8).join(' ');
      if (name !== 'mid' && name !== 'leaf') {
        continue;
      }
      const parent: Identity = {
        dev: parts[5] as string,
        ino: parts[6] as string,
        birthtimeNs: parts[7] as string,
      };
      if (liveRecord(ledger, parent, name) !== null) {
        stale.push(`${name} under ${parent.dev}:${parent.ino}`);
      }
    }
    expect(stale, 'a live creation record survived the tree it described').toEqual([]);

    teardown();
    props.splice(0);
  });

  /** A child that gives a recorded directory a SECOND name and leaves the first one vacant. */
  const renamingChild = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    'if (process.versions.node !== process.env.STHAYI_EXPECT_NODE) {',
    "  console.error('child node ' + process.versions.node);",
    '  process.exit(9);',
    '}',
    'const base = process.argv[1];',
    "fs.mkdirSync(path.join(base, 'src'), { mode: 0o700 });",
    "fs.renameSync(path.join(base, 'src'), path.join(base, 'dst'));",
  ].join('\n');

  it('a CHILD that renames a directory retires the record for the name it left', () => {
    const teardown = setup({ systemTemp: systemTemp() });
    const root = String(process.env[RUN_ROOT_ENV]);
    props.push(root);
    const fixture = runTempDir('sthayi-ledgermv-');
    const fixtureId = identify(fixture);

    runChild(root, renamingChild, fixture);
    const moved = identify(path.join(fixture, 'dst'));

    const ledger = path.join(root, RUN_DIRS);
    // The destination is recorded, and on the identity that LEFT the source: a rename preserves the
    // inode, so the directory that arrives is the directory that went away.
    expect(liveRecord(ledger, fixtureId, 'dst')).toEqual(moved);
    // And the source name grants nothing any more. Its directory is not there; whatever takes the
    // name next was made by somebody else, and a record left standing would let the sweep walk in.
    expect(
      liveRecord(ledger, fixtureId, 'src'),
      'the source name kept the authority its directory took with it',
    ).toBeNull();

    teardown();
    props.splice(0);
  });

  it('THIS PROCESS retires the source record when it renames a directory', () => {
    const fixture = runTempDir('sthayi-ledgermvlocal-');
    props.push(fixture);
    const fixtureId = identify(fixture);

    const src = path.join(fixture, 'src');
    fs.mkdirSync(src, { mode: 0o700 });
    const moved = identify(src);
    expect(recordedChildIdentity(fixtureId, 'src')).toEqual(moved);

    fs.renameSync(src, path.join(fixture, 'dst'));

    expect(recordedChildIdentity(fixtureId, 'dst')).toEqual(moved);
    expect(
      recordedChildIdentity(fixtureId, 'src'),
      'the source name kept the authority its directory took with it',
    ).toBeUndefined();
  });

  it('THIS PROCESS retires every level a recursive removal destroys', () => {
    const fixture = runTempDir('sthayi-ledgerrmlocal-');
    props.push(fixture);
    const fixtureId = identify(fixture);

    const top = path.join(fixture, 'top');
    fs.mkdirSync(path.join(top, 'mid'), { recursive: true, mode: 0o700 });
    const topId = identify(top);
    const midId = identify(path.join(top, 'mid'));
    expect(recordedChildIdentity(topId, 'mid')).toEqual(midId);

    fs.rmSync(top, { recursive: true });

    expect(recordedChildIdentity(fixtureId, 'top')).toBeUndefined();
    expect(recordedChildIdentity(topId, 'mid')).toBeUndefined();
  });
});
