import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeLauncher } from '../../packages/cli/src/clients/launcher.js';
import { type FakeHome, createFakeHome } from '../helpers/fake-home.js';

/**
 * SAFETY: a refusal's claim about the filesystem has to be TRUE of the filesystem.
 *
 * "nothing was modified" is not decoration. It is the sentence a user acts on: it says the machine
 * is exactly as it was, so there is nothing to inspect and nothing to undo before re-running. A
 * refusal that says it while a directory it created is standing on disk is teaching the user to
 * trust a statement that is sometimes false — which is worse than saying nothing, because it is the
 * hostile cases that produce these messages, and the hostile cases are when the user most needs the
 * report to match the disk.
 *
 * THE RULE. `bin/` is PROBED BEFORE IT IS CREATED, so a refusal about a `bin/` that was already
 * there really did modify nothing and says so. Creating the directory first and judging it
 * afterwards puts an empty `bin/` on disk behind every refusal that follows — the symlinked bin, the
 * replaced bin, the hijacked launcher file inside it — while the message claims in the same breath
 * that nothing was modified.
 *
 * WHERE THIS RUN DID MAKE THE DIRECTORY, the refusal names what it left behind instead. It is LEFT
 * STANDING rather than removed — nothing here can prove the directory now at that name is the one
 * this run made, and removing what it cannot prove it owns is the mistake this module refuses
 * everywhere else.
 *
 * THE PEER IS A REAL PROCESS. The plant is performed by `/bin/sh`, which loads none of this run's
 * helpers and whose syscalls no wrapper here can witness.
 */

const posix = process.platform !== 'win32';

/** Every entry beneath `dir` with what it is, recursively — the filesystem, as one comparable value. */
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

describe.skipIf(!posix)('safety: what a launcher refusal claims matches what is on disk', () => {
  let home: FakeHome;
  /** Entries a peer stood inside our tree; this process holds no authority to remove them. */
  const plantedByPeer: string[] = [];

  function quote(p: string): string {
    expect(p).not.toContain("'");
    return `'${p}'`;
  }

  function sh(script: string): void {
    const r = spawnSync('/bin/sh', ['-c', script], { encoding: 'utf8' });
    expect(r.status, `${script}\n${r.stderr ?? ''}`).toBe(0);
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

  /**
   * Fire `plant` the instant `bin/` is created — the only window in which a refusal can follow a
   * `bin/` that this run really made. `bin` is a SINGLE COMPONENT there: the write runs inside the
   * home the kernel is holding, which is why the match is on the relative name.
   */
  function plantWhenBinIsCreated(plant: () => void): { fired: () => boolean; restore: () => void } {
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
  });

  afterEach(() => {
    for (const p of plantedByPeer.splice(0)) {
      sh(`rm -rf ${quote(p)}`);
    }
    home.cleanup();
  });

  it('a refusal AFTER this run created bin/ says so, and does not claim nothing was modified', () => {
    const binPath = home.path('bin');
    const hijack = path.join(binPath, 'sthayi-mcp');
    const race = plantWhenBinIsCreated(() => {
      sh(`ln -s /etc/hosts ${quote(hijack)}`);
      plantedByPeer.push(hijack);
    });

    const message = refusalFrom(writeLauncher);
    race.restore();

    expect(race.fired()).toBe(true);
    expect(message).toMatch(/it is a symlink \(possible hijack/);
    // THE CLAIM. It must not be the false one, and it must name the directory that is now standing.
    expect(message).not.toContain('nothing was modified');
    expect(message).not.toContain('nothing was touched');
    expect(message).toContain(`${binPath} was created by this run`);
    // AND THE CLAIM MATCHES THE DISK: the bin this run made is there, holding the peer's link and
    // nothing of ours. The link target was never followed, let alone written through.
    expect(census(home.home)).toEqual({
      bin: `dir ${(fs.lstatSync(binPath).mode & 0o777).toString(8)}`,
      'bin/sthayi-mcp': 'symlink -> /etc/hosts',
    });
    expect(fs.readFileSync('/etc/hosts', 'utf8').startsWith('#!/usr/bin/env bash')).toBe(false);
  });

  it('a refusal about a bin/ that was ALREADY THERE really did modify nothing', () => {
    // The pre-existing case, where the claim is true — and has to keep being made, or the message
    // stops telling a user the one thing that lets them re-run without inspecting anything.
    const binPath = home.path('bin');
    fs.mkdirSync(binPath, { mode: 0o700 });
    const hijack = path.join(binPath, 'sthayi-mcp');
    sh(`ln -s /etc/hosts ${quote(hijack)}`);
    plantedByPeer.push(hijack);
    const before = census(home.home);

    const message = refusalFrom(writeLauncher);

    expect(message).toMatch(/it is a symlink \(possible hijack/);
    expect(message).toContain('nothing was modified');
    expect(message).not.toContain('was created by this run');
    expect(census(home.home)).toEqual(before); // byte- and mode-identical
  });

  it('a bin/ that is a SYMLINK is refused with a true claim, and the outside tree is untouched', () => {
    // The containment refusal, on a `bin` this run did not create: the same sentence, and the same
    // requirement that it be true.
    const outside = path.join(path.dirname(home.fixture), 'sthayi-refusal-outside');
    sh(`mkdir -m 700 ${quote(outside)} && printf THEIRS > ${quote(path.join(outside, 'canary'))}`);
    plantedByPeer.push(outside);
    sh(`ln -s ${quote(outside)} ${quote(home.path('bin'))}`);
    plantedByPeer.push(home.path('bin'));
    const before = census(home.home);
    const outsideBefore = census(outside);

    const message = refusalFrom(writeLauncher);

    expect(message).toMatch(/resolves to .*outside/);
    expect(message).toContain('nothing was modified');
    expect(census(home.home)).toEqual(before);
    expect(census(outside)).toEqual(outsideBefore); // not one byte through the link
  });

  it('CONTROL — an ordinary write still creates bin/ and both launchers', () => {
    // A claim strict enough to catch the false case is worthless if it also breaks the write: that
    // failure would make every row above pass for the wrong reason.
    const target = writeLauncher();

    expect(target).toBe(path.join(home.home, 'bin', 'sthayi-mcp'));
    expect(Object.keys(census(home.home)).sort()).toEqual(['bin', 'bin/sthayi', 'bin/sthayi-mcp']);
    expect(fs.lstatSync(path.join(home.home, 'bin', 'sthayi-mcp')).mode & 0o777).toBe(0o755);
  });
});
