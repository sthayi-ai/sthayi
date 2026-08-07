import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeLauncher } from '../../packages/cli/src/clients/launcher.js';
import { type FakeHome, createFakeHome } from '../helpers/fake-home.js';
import { removeOwned } from '../helpers/owned-fs.js';
import { PeerFixtures, type PeerOperation, peerFs } from '../helpers/peer-fixtures.js';
import { runTempDir } from '../helpers/run-temp.js';

/**
 * SAFETY: what a refusal says about `bin/` has to be one of THREE states, and it has to be the one
 * that actually happened.
 *
 * `mkdir` hands back no descriptor and portable Node has no `mkdirat`, so a run that creates `bin/`
 * can only learn what it made by looking the NAME up again afterwards. That look-up has three
 * outcomes, not two:
 *
 *   (i)   A VALID DIRECTORY IDENTITY WAS CAPTURED AND STILL MATCHES. The most that can honestly be
 *         said — and it is still a statement about a name read twice, so the message says so.
 *   (ii)  A VALID IDENTITY WAS CAPTURED AND LATER CHANGED. "It was replaced" is the truth here:
 *         there was a reading, and the entry standing now is demonstrably not it.
 *   (iii) THE FIRST READING WAS ALREADY UNTRUSTED — missing, a non-directory, a symlink. No identity
 *         was ever captured, so there is nothing for the entry to have changed FROM.
 *
 * COLLAPSING (iii) INTO (ii) IS THE BUG THIS FILE EXISTS FOR. A peer that removes the new directory
 * and stands its own symlink at the name wins the instant before the first read, and reporting that
 * as "the entry now standing is not the one read immediately after the create" asserts a transition
 * that never occurred: it tells a user the name held a good directory and then changed hands, when
 * the name never held one at all. These messages are printed in exactly the situations where the
 * substitution is the thing that happened, which is when a false account of it costs the most.
 *
 * THE PEER IS A REAL PROCESS. Each plant runs through an uninstrumented Node child, which loads none
 * of this run's helpers and whose syscalls no wrapper here can witness.
 */

const posix = process.platform !== 'win32';

/** The sentence that may only be printed when a valid reading really was captured and changed. */
const CHANGED_SENTENCE = /the entry now standing at that name is not the one read there/;
/** The sentence that belongs to a first reading which was already untrusted. */
const FIRST_READING_SENTENCE =
  /the FIRST reading taken at that name after the create already found/;

describe.skipIf(!posix)('safety: a bin/ refusal names which of the three states occurred', () => {
  let home: FakeHome;
  let external: string;
  const peer = new PeerFixtures();

  function runPeer(operations: readonly PeerOperation[], ...roots: string[]): void {
    const r = peer.run(operations, roots);
    expect(r.status, r.stderr).toBe(0);
  }

  function refusalFrom(body: () => unknown): string {
    try {
      body();
      return '';
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  /** Fire `plant` the instant `bin/` is created — `bin` is a SINGLE COMPONENT there, because the
   *  write runs inside the home the kernel is holding. */
  function whenBinCreated(plant: () => void): { fired: () => boolean; restore: () => void } {
    const real = fs.mkdirSync;
    let fired = false;
    (fs as { mkdirSync: unknown }).mkdirSync = ((p: fs.PathLike, opts?: unknown) => {
      const made = (real as unknown as (a: fs.PathLike, b?: unknown) => string | undefined)(
        p,
        opts,
      );
      if (!fired && String(p) === 'bin') {
        fired = true;
        plant();
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

  beforeEach(() => {
    home = createFakeHome();
    external = runTempDir('sthayi-bin-states-');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    peer.clear();
    removeOwned(external);
    home.cleanup();
  });

  it('(iii) a first reading that is ALREADY a symlink is not reported as a change', () => {
    // The peer removes the directory this run just made and stands its own link at the name, before
    // anything here has read it. There was never a valid reading, so "it was replaced" would be a
    // claim about a transition that did not happen.
    const decoy = path.join(external, 'decoy');
    runPeer([peerFs.mkdir(decoy, { mode: 0o700 })], decoy);
    const binPath = home.path('bin');

    const race = whenBinCreated(() => {
      runPeer([peerFs.rmdir(binPath), peerFs.symlink(decoy, binPath, 'dir')], binPath);
    });
    const message = refusalFrom(writeLauncher);
    race.restore();

    expect(race.fired()).toBe(true);
    expect(message).toContain(`${binPath} was created by this run`);
    // THE THREE-WAY CLAIM: the first reading is described as what it was, and the change sentence
    // — which would be false here — is absent.
    expect(message, message).toMatch(FIRST_READING_SENTENCE);
    expect(message).toContain('a symlink');
    expect(message, message).not.toMatch(CHANGED_SENTENCE);
    expect(message).not.toContain('nothing was modified');
    // AND THE CLAIM MATCHES THE DISK: nothing of ours reached the decoy through the link.
    expect(fs.lstatSync(binPath).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(decoy)).toEqual([]);
  });

  it('(i) a valid reading that STILL MATCHES is reported as an observation, never an identity', () => {
    // The peer moves this run's directory aside and stands its own empty 0700 one at the name, then
    // hijacks a launcher inside it. The first reading is a real directory, so an identity IS
    // captured — and it still matches at the refusal, because the peer changed nothing afterwards.
    // The honest sentence is therefore (i), and it must keep saying that the reading identifies the
    // NAME rather than the directory `mkdir` made.
    const binPath = home.path('bin');
    const asidePath = home.path('bin-moved-aside');
    const hijack = path.join(binPath, 'sthayi-mcp');

    const race = whenBinCreated(() => {
      runPeer(
        [
          peerFs.rename(binPath, asidePath),
          peerFs.mkdir(binPath, { mode: 0o700 }),
          peerFs.symlink('/etc/hosts', hijack, 'file'),
        ],
        binPath,
        asidePath,
      );
    });
    const message = refusalFrom(writeLauncher);
    race.restore();

    expect(race.fired()).toBe(true);
    expect(message).toContain(`${binPath} was created by this run`);
    expect(message, message).toMatch(/still matches the reading taken there/);
    expect(message, message).toMatch(/no handle|no descriptor/);
    // Neither of the other two states may be claimed.
    expect(message, message).not.toMatch(CHANGED_SENTENCE);
    expect(message, message).not.toMatch(FIRST_READING_SENTENCE);
    expect(fs.readFileSync('/etc/hosts', 'utf8').startsWith('#!/usr/bin/env bash')).toBe(false);
  });

  it('(ii) a valid reading that LATER CHANGED is reported as the change it is', () => {
    // The middle state, and the only one "it was replaced" belongs to. The peer lets the first
    // reading succeed — a real directory, so an identity is captured — and swaps the name for a
    // link only afterwards. The refusal then compares against a reading that genuinely existed.
    //
    // The swap is timed to land IMMEDIATELY AFTER the post-create read of `bin` — the very call
    // whose result becomes the captured identity. Planting at the create instead would land before
    // that read and produce state (iii), which is the row above; this row is the one where the
    // reading genuinely existed first.
    const decoy = path.join(external, 'decoy-late');
    runPeer([peerFs.mkdir(decoy, { mode: 0o700 })], decoy);
    const binPath = home.path('bin');

    const realLstat = fs.lstatSync;
    let swapped = false;
    (fs as { lstatSync: unknown }).lstatSync = ((p: fs.PathLike, opts?: unknown) => {
      const st = (realLstat as unknown as (a: fs.PathLike, b?: unknown) => fs.Stats | undefined)(
        p,
        opts,
      );
      // only the reading that CAPTURES an identity: the single relative name, holding a directory
      if (!swapped && String(p) === 'bin' && st?.isDirectory() === true && !st.isSymbolicLink()) {
        swapped = true;
        runPeer([peerFs.rmdir(binPath), peerFs.symlink(decoy, binPath, 'dir')], binPath);
      }
      return st;
    }) as typeof fs.lstatSync;

    const message = refusalFrom(writeLauncher);
    (fs as { lstatSync: unknown }).lstatSync = realLstat;

    expect(swapped, 'the bin path was never realpathed, so nothing was swapped').toBe(true);
    expect(message).toContain(`${binPath} was created by this run`);
    // THE MIDDLE STATE: a reading existed, and what stands there now is not it.
    expect(message, message).toMatch(CHANGED_SENTENCE);
    expect(message, message).not.toMatch(FIRST_READING_SENTENCE);
    expect(message).not.toContain('nothing was modified');
    // AND THE CLAIM MATCHES THE DISK: nothing of ours went through the link.
    expect(fs.lstatSync(binPath).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(decoy)).toEqual([]);
  });

  it('CONTROL — an ordinary write still creates bin/ and both launchers', () => {
    // Three claims strict enough to catch the rows above are worthless if they also break the
    // write: that failure would make every row here pass for the wrong reason.
    const target = writeLauncher();

    expect(target).toBe(home.path('bin', 'sthayi-mcp'));
    expect(fs.readdirSync(home.path('bin')).sort()).toEqual(['sthayi', 'sthayi-mcp']);
  });
});
