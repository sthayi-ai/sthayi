import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { containedRelative } from '../../packages/cli/src/fs-safe.js';
import { recordAllocatedDir, removeOwned, requireCreationIdentity } from './owned-fs.js';
import { runTempDir } from './run-temp.js';

export interface FakeHome {
  home: string;
  /**
   * The ALLOCATION the home was cut from: the directory whose device/inode `runTempDir()` recorded,
   * and the only thing `cleanup()` removes on the strength of. Exposed so hostile tests can attack
   * the identity cleanup actually relies on rather than the mutable home beneath it.
   */
  fixture: string;
  /** Absolute path under the fake home. */
  path(...segments: string[]): string;
  /** Copy a fixture file into the fake home (e.g. a client config) and return its absolute path. */
  plant(fixtureAbsPath: string, ...destSegments: string[]): string;
  cleanup(): void;
}

/**
 * Fake-home harness: a throwaway temp dir wired up as `STHAYI_HOME`, with helpers to plant
 * fixtures and snapshot trees for byte-exact assertions. Powers the journal/driver tests (B1)
 * and the client-adapter wire/unwire safety tests (B4).
 *
 * The mkdtemp result is REALPATH'd: on macOS `os.tmpdir()` is itself reached through a symlink
 * (`/var -> private/var`), and Sthayi derives every state path from the CANONICAL root of the
 * home (paths.ts). Realpathing here makes the fake home canonical, so `home.path(...)` keeps
 * comparing byte-for-byte against the paths production actually uses instead of forcing those
 * assertions to be loosened. It is not a hole: hostile tests still plant their own symlinks
 * explicitly, and those are what the trust boundary is asserted against.
 *
 * CLEANUP GOES THROUGH THE OWNERSHIP-AWARE HELPER, never through a recursive primitive. A fake home
 * is a pathname in a shared temp root that holds vault keys, stores and journals; handing that name
 * to `fs.rmSync(…, { recursive: true })` lets one substituted directory turn a routine teardown
 * into the erasure of a foreign tree, because the recursion is decided inside the call from the
 * name alone. `removeOwned()` removes the allocation only while it is still the inode
 * `runTempDir()` recorded, one entry at a time, and leaves it standing otherwise.
 *
 * THE HOME SITS INSIDE THE ALLOCATION RATHER THAN BEING IT. `runTempDir()` records a device/inode
 * at allocation, and that record is the only authority cleanup ever has. The home itself is the
 * surface tests attack: several of them delete it and stand a DIFFERENT directory at the same path
 * on purpose, to prove that a stale trust boundary is not reused. If the home were the allocation,
 * that deliberate substitution would destroy the one identity teardown holds, and the whole tree
 * would have to be leaked — indistinguishable, from the filesystem's side, from a hostile peer
 * swapping a directory in. Keeping the home one level down means the identity cleanup relies on is
 * a directory NOTHING replaces, while everything inside it stays free to be replaced, chmodded or
 * deleted by the tests.
 *
 * AND THE HOME IS RECORDED IN ITS OWN RIGHT. Being one level down is what keeps the tracked
 * allocation stable; it is NOT what makes the home safe to walk. The allocation's identity says
 * only that the allocation is still the allocation — it says nothing about which directory answers
 * to `home` inside it, and a tree swapped in at that name would otherwise be entered and emptied on
 * the strength of the allocation's record alone. So the home's own device/inode is PINNED here, at
 * the `mkdir` that makes it: a different directory standing at the name is refused, and the fixture
 * leaks around it rather than the replacement being deleted.
 */
export function createFakeHome(): FakeHome {
  const fixture = runTempDir('sthayi-test-');
  const home = path.join(fixture, 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  // The identity comes from the `mkdir` above — captured inside that call, against the empty
  // directory it had just made — and is CHECKED against the name here. Asking the filesystem afresh
  // would pin whatever occupies `home` at this instant, so a peer that moved the new home aside and
  // stood its own tree at the name would have its tree pinned as the harness's own and walked at
  // teardown. A refusal is fatal: an unpinned home is one cleanup could never enter.
  if (!recordAllocatedDir(home, requireCreationIdentity(home))) {
    throw new Error(
      `fake home ${home} is no longer the directory that was just created there — refusing to record it`,
    );
  }
  const previous = process.env.STHAYI_HOME;
  process.env.STHAYI_HOME = home;
  return {
    home,
    fixture,
    path(...segments: string[]): string {
      return path.join(home, ...segments);
    },
    plant(fixtureAbsPath: string, ...destSegments: string[]): string {
      const dest = path.join(home, ...destSegments);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(fixtureAbsPath, dest);
      return dest;
    },
    cleanup(): void {
      if (previous === undefined) {
        // biome-ignore lint/performance/noDelete: delete is the only correct way to unset an env var; assigning undefined coerces to the string "undefined".
        delete process.env.STHAYI_HOME;
      } else {
        process.env.STHAYI_HOME = previous;
      }
      // The ALLOCATION goes, not just the home: it is the directory whose identity was recorded,
      // and removing it takes whatever the test left inside with it.
      removeOwned(fixture);
    },
  };
}

/** Read a file as UTF-8 text (throws if absent) — for byte-exact restore assertions. */
export function readText(absPath: string): string {
  return fs.readFileSync(absPath, 'utf8');
}

/**
 * Snapshot a directory tree as `{ relativePath: contents }`, sorted, for exact-equality assertions
 * (e.g. "wire then unwire leaves the config dir identical"). Skips nothing — bytes are the point.
 */
export function snapshotTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of fs
      .readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        // containedRelative, not path.relative: a key that escaped `dir` would silently compare
        // two different trees, so an escape is an error rather than a surprising snapshot key.
        out[containedRelative(dir, full, 'snapshotTree')] = fs.readFileSync(full, 'utf8');
      }
    }
  };
  walk(dir);
  return out;
}
