import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type Identity,
  identityFromBigStat,
  removeOwned,
  sameIdentity,
} from '../helpers/owned-fs.js';
import { PeerFixtures, peerFs } from '../helpers/peer-fixtures.js';
import { runTempDir } from '../helpers/run-temp.js';

/**
 * SAFETY: what a LOST RACE AT THE FINAL UNLINK COSTS — stated as a bound, because it cannot be
 * stated as zero.
 *
 * THE INTERVAL IS NOT CLOSED, AND THIS FILE DOES NOT PRETEND IT IS. Every removal here ends the same
 * way: an identity is checked, and then `unlink` is called ON A NAME. Between those two acts a
 * process running as this same uid can take the name away from the object that was checked and give
 * it to one of its own, and the `unlink` removes whatever it finds. There is no POSIX call that
 * makes a removal conditional on an inode — `unlinkat` binds the DIRECTORY a name is resolved in and
 * says nothing about what the name resolves to — so this is not a gap portable Node happens to have
 * and a native helper would close. It is a property of the interface, and the honest thing to state
 * about it is its BLAST RADIUS.
 *
 * THE BOUND, and it is the whole safety argument:
 *
 *   AT MOST ONE ENTRY PER UNLINK ATTEMPT. Removal is one non-recursive syscall per re-proved
 *     identity, so a single lost race costs the single entry that call was aimed at.
 *   AND THE UNIT IS THE ATTEMPT, NOT THE CLEANUP. A walk makes one attempt per entry; each one
 *     opens its own interval, and winning one closes none of the others. UNDER REPEATED
 *     SAME-UID INTERFERENCE THE LOSS REACHES THE NUMBER OF ATTEMPTED UNLINKS — three staggered
 *     replacements cost three entries, on both surfaces, and this file proves it rather than
 *     asserting a cleanup-wide ceiling that does not exist. There is no "≤1 per cleanup" claim
 *     here, in `SECURITY.md`, or in the helpers.
 *   WHAT THE BLUNT ATTACK STILL COSTS. Replacing every name AT ONCE is a different case and is
 *     bounded: the entries beside the one in flight are re-checked against their own receipts, the
 *     replacements fail those checks, and the loss is one entry. That case is pinned too, so the
 *     staggered result cannot be mistaken for the walk having no checks at all.
 *   NEVER A DIRECTORY, AND NEVER A TREE. Directories go only through non-recursive `rmdir`, which
 *     REFUSES a directory that is not empty rather than descending into it. A replacement tree
 *     planted in the same window is left standing entire, and the directory holding it is left
 *     standing too.
 *   AND THE FIXTURE LEAKS AROUND WHAT SURVIVED. That is the intended outcome: a stray temp
 *     directory is something a human deletes, and a concurrent run's data is not recoverable.
 *
 * THE SAME-UID PEER IS OUTSIDE THE PROTECTION CLAIM IN THE FIRST PLACE — `SECURITY.md` scopes the
 * reachable principals to root and this uid — so the honest response is to state the residual, not
 * to reach for a native `unlinkat` addon that would not close it either.
 *
 * Both surfaces that end in a bare `unlink` are pinned here — the harness's own `removeOwned`, and
 * the helper that clears what a hostile fixture planted. The swap is driven from INSIDE the removal
 * call, which is the hardest position it can occupy: after every check any implementation could
 * make. Nothing wins that race; what this file asserts is what losing it costs.
 */
describe('safety: a lost unlink race costs one entry PER ATTEMPT, never a tree', () => {
  const props: string[] = [];
  const peer = new PeerFixtures();

  afterEach(() => {
    vi.restoreAllMocks();
    peer.clear();
    for (const p of props.splice(0).reverse()) {
      removeOwned(p);
    }
  });

  /**
   * Stand a foreign tree inside `dir`: a replacement for each name that was there, plus a NESTED
   * subtree that no single-entry removal can reach. Planted by an uninstrumented Node child, so
   * nothing in this process witnessed it and nothing here holds a receipt for any of it — and
   * recorded as it is planted, so the peer that planted it is the only thing that takes it away.
   */
  function plantForeign(dir: string, names: readonly string[]): string[] {
    const nested = path.join(dir, 'sub');
    const r = peer.run(
      [
        ...names.map((name) => peerFs.unlink(path.join(dir, name), true)),
        ...names.map((name) => peerFs.write(path.join(dir, name), 'FOREIGN')),
        peerFs.mkdir(nested, { recursive: true }),
        peerFs.write(path.join(nested, 'deep'), 'FOREIGN-DEEP'),
      ],
      [...names.map((name) => path.join(dir, name)), nested],
    );
    expect(r.status, r.stderr).toBe(0);
    return [nested];
  }

  /** How many of `names` the removal actually took away. */
  function lost(dir: string, names: readonly string[]): string[] {
    return names.filter((n) => !fs.existsSync(path.join(dir, n)));
  }

  /**
   * Replace ONE name, the one the removal is about to unlink, and do it again for the next.
   *
   * This is the shape the honest bound is stated in. A blunt attacker swaps every name at once and
   * the walk's own checks stop it after one entry; a patient one replaces each entry only when that
   * entry's identity has already been checked and its `unlink` is the very next thing to happen. No
   * check any implementation could add would see it — the object under the name at check time really
   * was the recorded one — so the loss is one entry for every attempt the walk makes.
   *
   * Planted by an uninstrumented Node child, so nothing here witnessed it and nothing holds a
   * receipt for any of it, and censused as it is planted so the peer that planted it is the only
   * thing that takes it away again. The identity is read back here, before the real `unlink` runs, so the
   * assertion afterwards is about the REPLACEMENT having been removed and not merely about a name
   * being absent.
   */
  function replaceInFlight(target: string): Identity {
    const r = peer.run([peerFs.unlink(target, true), peerFs.write(target, 'FOREIGN')], [target]);
    expect(r.status, r.stderr).toBe(0);
    const id = identityFromBigStat(fs.lstatSync(target, { bigint: true }));
    if (id === null) throw new Error(`no test identity for ${target}`);
    return id;
  }

  it('removeOwned: ONE blunt swap of every name costs one entry, never the subtree', () => {
    const fixture = runTempDir('sthayi-interval-owned-');
    props.push(fixture);
    const ours = path.join(fixture, 'ours');
    fs.mkdirSync(ours, { mode: 0o700 });
    const names = ['a', 'b', 'c'];
    for (const n of names) {
      fs.writeFileSync(path.join(ours, n), 'OURS');
    }

    let swapped = false;
    const realUnlink = fs.unlinkSync;
    vi.spyOn(fs, 'unlinkSync').mockImplementation(((p: fs.PathLike) => {
      if (!swapped && path.dirname(String(p)) === ours) {
        swapped = true;
        plantForeign(ours, names);
      }
      return (realUnlink as unknown as (a: fs.PathLike) => void)(p);
    }) as typeof fs.unlinkSync);

    removeOwned(ours);
    vi.restoreAllMocks();

    expect(swapped).toBe(true); // the race really was run
    expect(lost(ours, names).length).toBeLessThanOrEqual(1);
    // The nested tree is what a recursive primitive would have taken in the same call.
    expect(fs.readFileSync(path.join(ours, 'sub', 'deep'), 'utf8')).toBe('FOREIGN-DEEP');
    expect(fs.existsSync(ours)).toBe(true); // `rmdir` refused rather than descend

    // The peer takes back what the peer planted, and the directory goes once it is empty again.
    peer.clear();
    peer.adopt(ours);
  });

  it('PeerFixtures.clear: ONE blunt swap of every name costs one entry, never the subtree', () => {
    const fixture = runTempDir('sthayi-interval-peer-');
    props.push(fixture);
    const decoy = path.join(fixture, 'decoy');
    const names = ['a', 'b', 'c'];
    const planted = peer.run(
      [
        peerFs.mkdir(decoy, { recursive: true }),
        ...names.map((name) => peerFs.write(path.join(decoy, name), 'DECOY')),
      ],
      [decoy],
    );
    expect(planted.status, planted.stderr).toBe(0);

    let swapped = false;
    const realUnlink = fs.unlinkSync;
    vi.spyOn(fs, 'unlinkSync').mockImplementation(((p: fs.PathLike) => {
      if (!swapped && path.dirname(String(p)) === decoy) {
        swapped = true;
        plantForeign(decoy, names);
      }
      return (realUnlink as unknown as (a: fs.PathLike) => void)(p);
    }) as typeof fs.unlinkSync);

    peer.clear();
    vi.restoreAllMocks();

    expect(swapped).toBe(true);
    expect(lost(decoy, names).length).toBeLessThanOrEqual(1);
    expect(fs.readFileSync(path.join(decoy, 'sub', 'deep'), 'utf8')).toBe('FOREIGN-DEEP');
    expect(fs.existsSync(decoy)).toBe(true); // left standing, holding a stranger's tree

    peer.clear(); // the foreign entries the spy planted, on the identities recorded for them
    peer.adopt(decoy); // now empty, and removable on a census taken of what is really there
  });

  /** A foreign subtree inside `dir`, planted where no single-entry removal can reach it. */
  function plantNestedForeign(dir: string): string {
    const nested = path.join(dir, 'sub');
    const r = peer.run(
      [
        peerFs.mkdir(nested, { recursive: true }),
        peerFs.write(path.join(nested, 'deep'), 'FOREIGN-DEEP'),
      ],
      [nested],
    );
    expect(r.status, r.stderr).toBe(0);
    return nested;
  }

  it('removeOwned loses ALL THREE entries to three staggered replacements', () => {
    const fixture = runTempDir('sthayi-stagger-owned-');
    props.push(fixture);
    const ours = path.join(fixture, 'ours');
    fs.mkdirSync(ours, { mode: 0o700 });
    const names = ['a', 'b', 'c'];
    const mine = new Map<string, Identity>();
    for (const n of names) {
      fs.writeFileSync(path.join(ours, n), 'OURS');
      const id = identityFromBigStat(fs.lstatSync(path.join(ours, n), { bigint: true }));
      if (id === null) throw new Error(`no test identity for ${n}`);
      mine.set(n, id);
    }

    // One replacement per unlink ATTEMPT, each landing after that entry's own identity check.
    const foreign = new Map<string, Identity>();
    const realUnlink = fs.unlinkSync;
    vi.spyOn(fs, 'unlinkSync').mockImplementation(((p: fs.PathLike) => {
      const target = String(p);
      const name = path.basename(target);
      if (path.dirname(target) === ours && names.includes(name) && !foreign.has(name)) {
        if (foreign.size === 0) {
          plantNestedForeign(ours); // and a tree beside them, for the same window
        }
        foreign.set(name, replaceInFlight(target));
      }
      return (realUnlink as unknown as (a: fs.PathLike) => void)(p);
    }) as typeof fs.unlinkSync);

    removeOwned(ours);
    vi.restoreAllMocks();

    // Every attempt was raced, and every replacement really was a different object.
    expect([...foreign.keys()].sort()).toEqual(names);
    for (const n of names) {
      expect(sameIdentity(foreign.get(n) as Identity, mine.get(n) as Identity)).toBe(false);
    }
    // ALL THREE FOREIGN ENTRIES ARE GONE. This is the honest bound: one per attempt, three attempts.
    expect(lost(ours, names)).toEqual(names);
    // And still never a tree: the subtree planted in the same window is untouched, and the
    // directory holding it is left standing because `rmdir` refused rather than descended.
    expect(fs.readFileSync(path.join(ours, 'sub', 'deep'), 'utf8')).toBe('FOREIGN-DEEP');
    expect(fs.existsSync(ours)).toBe(true);

    peer.clear();
    peer.adopt(ours);
  });

  it('PeerFixtures.clear loses ALL THREE entries to three staggered replacements', () => {
    const fixture = runTempDir('sthayi-stagger-peer-');
    props.push(fixture);
    const decoy = path.join(fixture, 'decoy');
    const names = ['a', 'b', 'c'];
    const planted = peer.run(
      [
        peerFs.mkdir(decoy, { recursive: true }),
        ...names.map((name) => peerFs.write(path.join(decoy, name), 'DECOY')),
      ],
      [decoy],
    );
    expect(planted.status, planted.stderr).toBe(0);
    const mine = new Map<string, Identity>();
    for (const n of names) {
      const id = identityFromBigStat(fs.lstatSync(path.join(decoy, n), { bigint: true }));
      if (id === null) throw new Error(`no test identity for ${n}`);
      mine.set(n, id);
    }

    const foreign = new Map<string, Identity>();
    const realUnlink = fs.unlinkSync;
    vi.spyOn(fs, 'unlinkSync').mockImplementation(((p: fs.PathLike) => {
      const target = String(p);
      const name = path.basename(target);
      if (path.dirname(target) === decoy && names.includes(name) && !foreign.has(name)) {
        if (foreign.size === 0) {
          plantNestedForeign(decoy);
        }
        foreign.set(name, replaceInFlight(target));
      }
      return (realUnlink as unknown as (a: fs.PathLike) => void)(p);
    }) as typeof fs.unlinkSync);

    peer.clear();
    vi.restoreAllMocks();

    expect([...foreign.keys()].sort()).toEqual(names);
    for (const n of names) {
      expect(sameIdentity(foreign.get(n) as Identity, mine.get(n) as Identity)).toBe(false);
    }
    expect(lost(decoy, names)).toEqual(names);
    expect(fs.readFileSync(path.join(decoy, 'sub', 'deep'), 'utf8')).toBe('FOREIGN-DEEP');
    expect(fs.existsSync(decoy)).toBe(true);

    peer.clear();
    peer.adopt(decoy);
  });
});
