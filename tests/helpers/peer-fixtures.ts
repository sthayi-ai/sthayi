import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Identity, emptyProvenDir, identityFromBigStat, sameIdentity } from './owned-fs.js';

export type PeerOperation =
  | {
      readonly kind: 'mkdir';
      readonly path: string;
      readonly recursive?: boolean;
      readonly mode?: number;
    }
  | { readonly kind: 'write'; readonly path: string; readonly data: string; readonly mode?: number }
  | { readonly kind: 'unlink'; readonly path: string; readonly missingOk?: boolean }
  | { readonly kind: 'rmdir'; readonly path: string }
  | { readonly kind: 'rename'; readonly from: string; readonly to: string }
  | { readonly kind: 'chmod'; readonly path: string; readonly mode: number }
  | {
      readonly kind: 'symlink';
      readonly target: string;
      readonly path: string;
      readonly type?: 'file' | 'dir' | 'junction';
    };

export const peerFsChildPath = fileURLToPath(new URL('./peer-fs-child.mjs', import.meta.url));

/** Closed constructors keep callers on the child helper's strictly validated operation surface. */
export const peerFs = {
  mkdir(at: string, options: { recursive?: boolean; mode?: number } = {}): PeerOperation {
    return { kind: 'mkdir', path: at, ...options };
  },
  write(at: string, data: string, mode?: number): PeerOperation {
    return mode === undefined
      ? { kind: 'write', path: at, data }
      : { kind: 'write', path: at, data, mode };
  },
  unlink(at: string, missingOk = false): PeerOperation {
    return missingOk ? { kind: 'unlink', path: at, missingOk: true } : { kind: 'unlink', path: at };
  },
  rmdir(at: string): PeerOperation {
    return { kind: 'rmdir', path: at };
  },
  rename(from: string, to: string): PeerOperation {
    return { kind: 'rename', from, to };
  },
  chmod(at: string, mode: number): PeerOperation {
    return { kind: 'chmod', path: at, mode };
  },
  symlink(target: string, at: string, type?: 'file' | 'dir' | 'junction'): PeerOperation {
    return type === undefined
      ? { kind: 'symlink', target, path: at }
      : { kind: 'symlink', target, path: at, type };
  },
};

export interface PeerRunResult {
  readonly status: number | null;
  readonly stderr: string;
}

/**
 * Run mutations in a fresh Node process that inherits no child-ledger preload.
 *
 * Clearing `NODE_OPTIONS` is load-bearing: the normal test process deliberately preloads a binding
 * that records child filesystem calls, while this peer exists to model calls the run cannot see.
 */
export function runPeerOperations(operations: readonly PeerOperation[]): PeerRunResult {
  const result = spawnSync(process.execPath, [peerFsChildPath, JSON.stringify(operations)], {
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  return {
    status: result.status,
    stderr: `${result.error?.message ?? ''}${result.stderr ?? ''}`,
  };
}

/**
 * Entries a hostile fixture plants THROUGH A PROGRAM THE HARNESS CANNOT SEE — and the only way they
 * are ever taken away again.
 *
 * WHY THE PLANTING HAS TO BE INVISIBLE. The property these fixtures exist to prove is that an entry
 * this run did not create is never removed by teardown. Creating the decoy through `fs` would defeat
 * the experiment before it started: the wrappers in `owned-fs.ts` would take a receipt for it, the
 * walk would remove it on that receipt, and the test would pass while proving nothing. So the decoy
 * is created by an uninstrumented Node child, whose syscalls no binding here witnesses, and it is
 * unaccountable — which is exactly why teardown leaves it standing, and exactly why teardown cannot
 * be the thing that takes it away afterwards.
 *
 * WHY `rm -rf` IS NOT THE ANSWER EITHER. Reaching for a recursive shell removal to tidy up hands a
 * PATHNAME to a primitive that decides the whole recursion inside the call, from that name alone —
 * the precise failure the rest of this harness exists to refuse, performed by the tests that assert
 * it must not happen. A decoy stands at a name in a shared temp root, and between the moment it is
 * planted and the moment it is cleared, anything sharing this uid can move a directory of its own to
 * that name. `rm -rf` would then take that directory and everything in it.
 *
 * SO THE DECOY IS REMOVED THE SAME WAY EVERYTHING ELSE HERE IS: ON A RECORDED IDENTITY. The census
 * is taken the moment the planting program returns, one line per entry, each carrying the
 * device/inode it had then. Clearing walks that census — deepest first, never a listing taken at
 * removal time — and removes an entry only while the name still answers to the recorded inode and
 * the recorded kind. A third-party replacement has a different inode, fails that check, and is left
 * exactly where it is; the directories above it are left too, because they are no longer empty.
 *
 * NO RECURSIVE PRIMITIVE IS INVOKED, at any point, by any of this: single `unlink` calls for
 * non-directories, single non-recursive `rmdir` calls for directories the census emptied.
 */

/** One entry as it stood the instant the planting program returned. */
interface PlantedEntry {
  readonly path: string;
  readonly id: Identity;
  readonly directory: boolean;
  /** Depth below the planted root, so the census is cleared deepest first. */
  readonly depth: number;
}

/** Ceiling on the census: a decoy deeper or wider than this is not a decoy. */
const MAX_DEPTH = 16;
const MAX_ENTRIES = 4096;

function census(root: string, depth: number, into: PlantedEntry[]): void {
  if (depth > MAX_DEPTH || into.length >= MAX_ENTRIES) {
    return;
  }
  let st: fs.BigIntStats;
  try {
    st = fs.lstatSync(root, { bigint: true });
  } catch {
    return; // nothing stood there when the program finished, so there is nothing to clear
  }
  const id = identityFromBigStat(st);
  if (id === null) {
    return; // unsupported birth-time metadata grants no cleanup authority
  }
  const directory = st.isDirectory() && !st.isSymbolicLink();
  into.push({ path: root, id, directory, depth });
  if (!directory) {
    return;
  }
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    census(path.join(root, name), depth + 1, into);
  }
}

/**
 * A place to record what a test planted, cleared by the test that planted it.
 *
 * One of these per suite. It holds identities, never bare pathnames, and it is the only thing the
 * clearing walk consults.
 */
export class PeerFixtures {
  private planted: PlantedEntry[] = [];

  /**
   * Run structured operations in an uninstrumented child, then record what it left standing.
   *
   * The child's exit status is handed back rather than asserted here, so the caller decides what a
   * failure means; a child that failed still gets whatever it managed to create recorded, because
   * that is what has to be cleared.
   */
  run(operations: readonly PeerOperation[], roots: readonly string[]): PeerRunResult {
    const result = runPeerOperations(operations);
    for (const root of roots) {
      this.adopt(root);
    }
    return result;
  }

  /** Record what stands at `root` right now, so exactly that can be cleared later. */
  adopt(root: string): void {
    census(path.resolve(root), 0, this.planted);
  }

  /**
   * Take away everything the census recorded that is still the object it recorded.
   *
   * Deepest first, so a directory is only ever reached once the entries the census saw inside it are
   * gone. Anything that no longer matches is left, and so is everything above it — a `rmdir` on a
   * directory that still holds a stranger's entry fails, and failing is the intended outcome.
   *
   * A DECOY DIRECTORY IS OFTEN FILLED BY THE RUN AFTERWARDS, and that is the point of several of
   * these scenarios: the peer wins a name and the code under test then writes into it. Those entries
   * are the RUN'S, recorded by the run when it made them, so they are removed on the run's own
   * records through the same identity-proving walk teardown uses — never on a listing, and never on
   * a pathname. What neither record covers is left, and the `rmdir` above it then fails, which is
   * how an unaccountable entry keeps its whole enclosing tree.
   *
   * WHAT A LOST RACE COSTS, AND THE UNIT IT IS COUNTED IN. The identity check and the `unlink` are
   * two syscalls, and nothing binds the second to what the first saw, so a process sharing this uid
   * can take the name away in between and the removal lands on its entry instead. THE BOUND IS PER
   * UNLINK ATTEMPT AND NOT PER CALL TO `clear()`: this walk makes one attempt per censused entry,
   * each opens its own interval, and a mismatch merely SKIPS that entry rather than stopping the
   * walk — so a peer that keeps winning costs one entry each time, up to the number of attempts.
   * Three staggered replacements cost three entries. What no attempt takes is a tree: directories go
   * through a non-recursive `rmdir` that refuses rather than descends.
   */
  clear(): void {
    const entries = this.planted.splice(0).sort((a, b) => b.depth - a.depth);
    for (const entry of entries) {
      let st: fs.BigIntStats;
      try {
        st = fs.lstatSync(entry.path, { bigint: true });
      } catch {
        continue; // already gone
      }
      const standing = identityFromBigStat(st);
      if (standing === null || !sameIdentity(standing, entry.id)) {
        continue; // something else wears the name now, and it is not this test's to remove
      }
      if ((st.isDirectory() && !st.isSymbolicLink()) !== entry.directory) {
        continue; // same number, different kind: not the object that was recorded
      }
      try {
        if (entry.directory) {
          emptyProvenDir(entry.path, entry.id, entry.id.dev, () => true);
          fs.rmdirSync(entry.path); // non-recursive: refuses rather than descend
        } else {
          fs.unlinkSync(entry.path); // one entry; a symlink's target is never followed
        }
      } catch {
        // left standing rather than escalated to a forceful delete
      }
    }
  }
}
