import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeLauncher } from '../../packages/cli/src/clients/launcher.js';
import { type FakeHome, createFakeHome } from '../helpers/fake-home.js';
import { PeerFixtures, peerFs, runPeerOperations } from '../helpers/peer-fixtures.js';

/**
 * SAFETY: what the FRESH-HOME creation window can and cannot be made to promise.
 *
 * THE WINDOW. A `STHAYI_HOME` that does not exist yet is built one level at a time, and each level
 * is `mkdir`'d and then looked at. `mkdir` is exclusive — when it returns, this process made an
 * inode at that name — but it hands back NO DESCRIPTOR, and portable Node exposes no `mkdirat` and
 * no directory-creating `open`. The identity that becomes the trust boundary therefore has to be
 * fetched by looking the NAME up again, and between the syscall returning and that first look a
 * peer that can write the parent can destroy the directory we made and stand its own EMPTY one at
 * the name. An empty, 0700, this-uid directory is EXACTLY the shape `mkdir` itself produces, so
 * there is nothing left for a check to disagree with, and the replacement is adopted as the home.
 *
 * NO CLAIM IS MADE THAT THIS IS CLOSED. It is not, and the first row below reproduces it end to
 * end: `writeLauncher()` returns SUCCESS and both launcher scripts land inside the replacement.
 * That row is the honest part of this file — a suite that quietly lacked it would be reporting a
 * guarantee the code does not have.
 *
 * WHAT ACTUALLY EXCLUDES AN ATTACKER IS THE PARENT, NOT THE WINDOW. Removing the directory we just
 * made requires WRITE on its parent, and the ancestor-trust invariant already requires every
 * pre-existing ancestor to be owned by this user or root and to be neither group- nor
 * world-writable unless STICKY — and sticky is precisely the bit that forbids unlinking an entry
 * you do not own. So an unprivileged peer never reaches this window at all. Whoever does reach it
 * can write the parent of the home, which means they can create, replace or fill the home outright
 * whenever they like; the race hands them nothing the direct route does not.
 *
 * AND WHAT TURNS UP IN THE WINDOW IS STILL POLICED. The second row is the load-bearing one: a
 * replacement is adopted only if it passes the same ownership and mode policy every boundary
 * passes. That is what keeps the reachable set at "this uid or root" instead of "anyone who can
 * write the parent" — a foreign peer's directory carries the peer's uid and is refused on it.
 *
 * THE PEER IS A REAL PROCESS. Every substitution below is performed by an uninstrumented Node
 * child, whose syscalls no wrapper in this process witnesses. A substitution performed with this
 * process's own `fs` is, from the inside, indistinguishable from the run rebuilding its own fixture.
 */

const posix = process.platform !== 'win32';

/** Every entry beneath `dir`, recursively — an empty array is "nothing was written here". */
function listDeep(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string): void => {
    for (const name of fs.readdirSync(d).sort()) {
      const full = path.join(d, name);
      const r = rel === '' ? name : `${rel}/${name}`;
      out.push(r);
      const st = fs.lstatSync(full);
      if (st.isDirectory() && !st.isSymbolicLink()) {
        walk(full, r);
      }
    }
  };
  walk(dir, '');
  return out;
}

describe.skipIf(!posix)('safety: the fresh-home creation window, stated exactly', () => {
  let home: FakeHome;
  let newHome = '';
  /** Paths a peer stood at a name of ours; nothing in this process may remove them. */
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

  /** Where the peer parks the home this run really created, so assertions can still name it. */
  function asidePath(): string {
    return `${newHome}-established`;
  }

  /**
   * The substitution: our freshly created home is moved aside and an EMPTY directory of `mode` is
   * stood at its name, by a process this run cannot see inside.
   *
   * Moved aside rather than destroyed, because both halves are evidence here: the replacement must
   * be shown to have RECEIVED the launchers, and the directory this run actually made must be shown
   * to have received nothing.
   */
  function peerSubstitutes(mode: number): void {
    const r = runPeerOperations([
      peerFs.rename(newHome, asidePath()),
      peerFs.mkdir(newHome, { mode }),
    ]);
    expect(r.status, r.stderr).toBe(0);
    peer.adopt(newHome);
    peer.adopt(asidePath());
  }

  /**
   * Fire `swap` the instant the creating `mkdir` for the fresh home returns — the earliest point
   * any implementation could look at what it made, and therefore the whole of the window.
   *
   * The wrapper is installed on `fs.mkdirSync` and calls through FIRST, so the substitution lands
   * after the real syscall rather than in place of it. Restored by the caller.
   */
  function substituteAtCreation(swap: () => void): { fired: () => boolean; restore: () => void } {
    const real = fs.mkdirSync;
    let fired = false;
    (fs as { mkdirSync: unknown }).mkdirSync = ((p: fs.PathLike, opts?: unknown) => {
      const made = (real as unknown as (a: fs.PathLike, b?: unknown) => string | undefined)(
        p,
        opts,
      );
      if (!fired && String(p) === newHome) {
        fired = true;
        swap();
      }
      return made;
    }) as typeof fs.mkdirSync;
    return {
      fired: () => fired,
      restore: () => {
        (fs as { mkdirSync: unknown }).mkdirSync = real;
      },
    };
  }

  /** Run `body`, returning the refusal message ('' when it did not throw). */
  function refusalFrom(body: () => unknown): string {
    try {
      body();
      return '';
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  beforeEach(() => {
    home = createFakeHome();
    newHome = home.path('fresh-home');
    process.env.STHAYI_HOME = newHome;
  });

  afterEach(() => {
    // What a peer planted, the peer takes away: this process holds no creation record for it, which
    // is exactly the state the rows above describe.
    peer.clear();
    // The home this run really made goes back under the name the harness recorded it at, so the
    // fixture teardown can take it down by the identity it pinned.
    if (fs.existsSync(asidePath())) {
      fs.renameSync(asidePath(), newHome);
    }
    home.cleanup();
  });

  it('a peer that wins the mkdir→first-look window IS adopted: the launchers land in its directory', () => {
    // THE RESIDUAL, REPRODUCED. Nothing available after a `mkdir` returns can tell the directory the
    // call made from an empty directory standing at the same name, so this row asserts what really
    // happens rather than a defence that does not exist.
    const race = substituteAtCreation(() => peerSubstitutes(0o700));

    const message = refusalFrom(writeLauncher);
    race.restore();

    expect(race.fired()).toBe(true); // the window really was entered
    expect(message).toBe(''); // and the write reported success
    // Both launchers are executables every wired MCP client runs, and both are in the peer's
    // directory. This is the exposure, written down.
    expect(listDeep(newHome)).toEqual(['bin', 'bin/sthayi', 'bin/sthayi-mcp']);
    // The directory this run actually created got nothing at all.
    expect(listDeep(asidePath())).toEqual([]);
  });

  it('a replacement that is SHARED-WRITABLE is refused, and nothing is written into it', () => {
    // What keeps the window reachable only by this uid or root: whatever turns up in it still has to
    // pass the boundary's own ownership and mode policy. A foreign peer's directory carries the
    // peer's uid and fails on that; this row exercises the half a same-uid test can actually
    // manufacture, and it fails the moment the creation path stops policing what it adopts.
    const race = substituteAtCreation(() => {
      peerSubstitutes(0o777);
    });

    const message = refusalFrom(writeLauncher);
    race.restore();

    expect(race.fired()).toBe(true);
    expect(message).toMatch(/world-writable/);
    expect(listDeep(newHome)).toEqual([]);
    expect(listDeep(asidePath())).toEqual([]);
  });

  it('CONTROL — an ordinary missing home is created, established and written into', () => {
    // A window nobody enters must still produce a working home, or every row above passes for the
    // wrong reason.
    const target = writeLauncher();

    expect(target).toBe(path.join(newHome, 'bin', 'sthayi-mcp'));
    expect(fs.lstatSync(newHome).mode & 0o777).toBe(0o700);
    expect(listDeep(newHome)).toEqual(['bin', 'bin/sthayi', 'bin/sthayi-mcp']);
  });
});
