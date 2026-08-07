import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeLauncher } from '../../packages/cli/src/clients/launcher.js';
import { type FakeHome, createFakeHome } from '../helpers/fake-home.js';
import { removeOwned } from '../helpers/owned-fs.js';
import { PeerFixtures, type PeerOperation, peerFs } from '../helpers/peer-fixtures.js';
import { runTempDir } from '../helpers/run-temp.js';

/**
 * SAFETY: `sthayi init`/`wire` publishes TWO launchers, and a refusal has to account for both.
 *
 * `bin/sthayi-mcp` is what client configs invoke and `bin/sthayi` is the durable CLI. They are two
 * files, published by two renames, so there is no instant at which both appear at once — no
 * atomicity is claimed for the pair, and none is available: portable Node has no way to publish two
 * names as one act.
 *
 * What IS available, and is required here:
 *
 *   1. BOTH TARGETS ARE JUDGED BEFORE EITHER IS PUBLISHED. A hostile entry standing at the second
 *      target is a refusal the run can reach without writing anything, and reaching it after the
 *      first launcher is on disk turns "remove it and re-run" into advice about a machine that has
 *      already been changed.
 *   2. WHERE A REFUSAL STILL FOLLOWS A PUBLICATION — a peer that plants its entry after the
 *      judgement, which no ordering can exclude — the message states the partial result: which
 *      launcher this run wrote, and that it is standing.
 *   3. NO REFUSAL DESCRIBES A DIRECTORY THAT IS NOT THERE. A run that creates `bin/` and then finds
 *      something else at that name says exactly that, rather than claiming the directory it made is
 *      still standing.
 *
 * THE PEER IS A REAL PROCESS. Each plant is performed by an uninstrumented Node child, which loads
 * none of this run's helpers and whose syscalls no wrapper here can witness.
 */

const posix = process.platform !== 'win32';

/** Every entry beneath `dir`, with what it is — the filesystem as one comparable value. */
function census(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, rel: string): void => {
    for (const name of fs.readdirSync(d).sort()) {
      const full = path.join(d, name);
      const r = rel === '' ? name : `${rel}/${name}`;
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) {
        out[r] = `symlink -> ${fs.readlinkSync(full)}`;
        continue;
      }
      if (st.isDirectory()) {
        out[r] = `dir ${(st.mode & 0o777).toString(8)}`;
        walk(full, r);
        continue;
      }
      out[r] = `file ${(st.mode & 0o777).toString(8)} ${fs.readFileSync(full, 'utf8')}`;
    }
  };
  walk(dir, '');
  return out;
}

describe.skipIf(!posix)('safety: a two-launcher write reports what it really did', () => {
  let home: FakeHome;
  let external: string;
  /**
   * What the peer stood inside our tree, recorded as it was planted and cleared on those same
   * identities.
   *
   * A decoy has to be created by a program this harness cannot witness, or it would carry a receipt
   * and the refusal being asserted would be vacuous. It must also be taken away again, or the
   * fixture around it leaks holding whatever the test wrote beside it — and taking it away with a
   * recursive shell removal aimed at its pathname would be the exact hazard these tests exist to
   * forbid, performed by the tests that forbid it. See `tests/helpers/peer-fixtures.ts`.
   */
  const peer = new PeerFixtures();

  /** Plant through an uninstrumented child, recording what stands at `roots` when it returns. */
  function runPeer(operations: readonly PeerOperation[], ...roots: string[]): void {
    const r = peer.run(operations, roots);
    expect(r.status, r.stderr).toBe(0);
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

  function mcpPath(): string {
    return home.path('bin', 'sthayi-mcp');
  }
  function cliPath(): string {
    return home.path('bin', 'sthayi');
  }

  beforeEach(() => {
    home = createFakeHome();
    external = runTempDir('sthayi-two-target-');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    peer.clear(); // each decoy on its recorded identity, one entry at a time
    removeOwned(external); // teardown: the recorded allocation, never a pathname walk
    home.cleanup();
  });

  it('a hostile CLI target is refused BEFORE the MCP launcher is published', () => {
    // The MCP target is clean and would be written happily. The second one is not, and that is a
    // refusal this run can reach with the disk untouched.
    fs.mkdirSync(home.path('bin'), { mode: 0o700 });
    runPeer([peerFs.symlink('/etc/hosts', cliPath(), 'file')], cliPath());
    const before = census(home.home);

    const message = refusalFrom(writeLauncher);

    expect(message).toMatch(/it is a symlink \(possible hijack/);
    expect(message).toContain(cliPath());
    // NOTHING was published — including the launcher whose own target was fine.
    expect(fs.existsSync(mcpPath()), 'the MCP launcher was published before the refusal').toBe(
      false,
    );
    expect(message).toContain('nothing was modified');
    expect(census(home.home)).toEqual(before);
    // The link target was never followed, let alone written through.
    expect(fs.readFileSync('/etc/hosts', 'utf8').startsWith('#!/usr/bin/env bash')).toBe(false);
  });

  it('a target planted AFTER the judgement leaves a refusal that names what was written', () => {
    // No ordering excludes a peer that plants its entry between the judgement and the write, so the
    // one thing left is to say what is on disk: the MCP launcher, written by this run.
    fs.mkdirSync(home.path('bin'), { mode: 0o700 });
    const realRename = fs.renameSync.bind(fs);
    let fired = false;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      const result = realRename(from, to);
      if (!fired && path.basename(String(to)) === 'sthayi-mcp') {
        fired = true;
        runPeer([peerFs.symlink('/etc/hosts', cliPath(), 'file')], cliPath());
      }
      return result;
    });

    const message = refusalFrom(writeLauncher);
    vi.restoreAllMocks();

    expect(fired).toBe(true);
    expect(message).toMatch(/it is a symlink \(possible hijack/);
    // THE CLAIM. One launcher IS on disk, so the false sentence must not be there and the true one
    // must name the file this run published.
    expect(message).not.toContain('nothing was modified');
    expect(message).not.toContain('nothing was touched');
    expect(message).toContain(mcpPath());
    expect(message).toMatch(/was written by this run/);
    // AND THE CLAIM MATCHES THE DISK.
    expect(fs.readFileSync(mcpPath(), 'utf8')).toContain('serve');
    expect(fs.lstatSync(cliPath()).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync('/etc/hosts', 'utf8').startsWith('#!/usr/bin/env bash')).toBe(false);
  });

  it('a bin/ created by this run and then REPLACED is not reported as still standing', () => {
    // The directory this run made is removed by a peer and its name made to lead outside, before
    // anything has inspected it. "Created by this run and left standing" would describe a directory
    // that is not there — the refusal has to describe the entry that IS.
    const decoy = path.join(external, 'decoy');
    runPeer([peerFs.mkdir(decoy, { mode: 0o700 })], decoy);
    const binPath = home.path('bin');

    const realMkdir = fs.mkdirSync;
    let fired = false;
    (fs as { mkdirSync: unknown }).mkdirSync = ((p: fs.PathLike, opts?: unknown) => {
      const made = (realMkdir as unknown as (a: fs.PathLike, b?: unknown) => string | undefined)(
        p,
        opts,
      );
      if (!fired && String(p) === 'bin') {
        fired = true;
        runPeer([peerFs.rmdir(binPath), peerFs.symlink(decoy, binPath, 'dir')], binPath);
      }
      return made;
    }) as typeof fs.mkdirSync;

    const message = refusalFrom(writeLauncher);
    (fs as { mkdirSync: unknown }).mkdirSync = realMkdir;

    expect(fired).toBe(true);
    // The claim about `bin/` must match what stands at that name — which is a link, not the
    // directory this run made.
    expect(message).toContain(`${binPath} was created by this run`);
    expect(message).not.toContain('was left standing');
    expect(message).toMatch(/not the directory (?:it|this run) created|it was replaced/);
    // Nothing of ours reached the decoy the link points at.
    expect(census(decoy)).toEqual({});
  });

  it('a bin/ SUBSTITUTED BY A REAL DIRECTORY is never claimed as the one this run created', () => {
    // The hard shape, and the one no check performed afterwards can separate from the honest case:
    // `mkdir` returns no descriptor, so the identity behind it has to be fetched by looking the NAME
    // up again — and in that interval a same-uid peer can move the new directory aside and stand its
    // own empty 0700 one at the name. Empty is exactly the shape `mkdir` produces, so the
    // substitute satisfies every leg of a freshness test there is; only the fact that the reading is
    // POST HOC separates it from the directory this run made, and that fact never goes away.
    //
    // So the refusal may state the ACT ("this run created a directory at that name") and it may
    // state what it OBSERVED ("what is there now still matches what was read there afterwards"). It
    // may not state the IDENTITY — "the directory this run created is the one standing there" — and
    // here that statement would be false: this run's directory is the one moved aside, and the
    // entry wearing the name is the peer's, holding the peer's hijack.
    const binPath = home.path('bin');
    const asidePath = home.path('bin-moved-aside');
    const hijack = path.join(binPath, 'sthayi-mcp');

    const realMkdir = fs.mkdirSync;
    let fired = false;
    (fs as { mkdirSync: unknown }).mkdirSync = ((p: fs.PathLike, opts?: unknown) => {
      const made = (realMkdir as unknown as (a: fs.PathLike, b?: unknown) => string | undefined)(
        p,
        opts,
      );
      if (!fired && String(p) === 'bin') {
        fired = true;
        // one peer process, between the create returning and anything here reading the name back
        runPeer(
          [
            peerFs.rename(binPath, asidePath),
            peerFs.mkdir(binPath, { mode: 0o700 }),
            peerFs.symlink('/etc/hosts', hijack, 'file'),
          ],
          binPath,
          asidePath,
        );
      }
      return made;
    }) as typeof fs.mkdirSync;

    const message = refusalFrom(writeLauncher);
    (fs as { mkdirSync: unknown }).mkdirSync = realMkdir;

    expect(fired).toBe(true);
    // The write still refuses, on the hijacked launcher inside the substitute.
    expect(message).toMatch(/it is a symlink \(possible hijack/);
    // THE CLAIM. The act is still reported — a run that made a directory may not say it modified
    // nothing — but the entry standing at the name is never called the one this run created.
    expect(message).toContain(`${binPath} was created by this run`);
    expect(message).not.toContain('was left standing');
    expect(message).toMatch(/no handle|no descriptor/);
    // AND THE CLAIM MATCHES THE DISK: this run's directory is the empty one moved aside, and the
    // peer's is the one wearing the name, holding the peer's link and nothing of ours.
    expect(census(asidePath)).toEqual({});
    expect(census(binPath)).toEqual({ 'sthayi-mcp': 'symlink -> /etc/hosts' });
    expect(fs.readFileSync('/etc/hosts', 'utf8').startsWith('#!/usr/bin/env bash')).toBe(false);
  });

  it('CONTROL — an ordinary write still publishes both launchers', () => {
    // A claim strict enough to catch the rows above is worthless if it also breaks the write.
    const target = writeLauncher();

    expect(target).toBe(mcpPath());
    expect(Object.keys(census(home.home)).sort()).toEqual(['bin', 'bin/sthayi', 'bin/sthayi-mcp']);
    expect(fs.readFileSync(mcpPath(), 'utf8')).toContain('serve');
    expect(fs.readFileSync(cliPath(), 'utf8')).not.toContain(' serve ');
  });
});
