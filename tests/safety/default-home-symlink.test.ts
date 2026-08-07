import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertReadOnlySthayiHome,
  ensureSthayiHome,
  sthayiHome,
} from '../../packages/cli/src/paths.js';
import { removeOwned } from '../helpers/owned-fs.js';
import { runTempDir } from '../helpers/run-temp.js';

/**
 * SAFETY: the whole-path policy is DELIBERATE for the DEFAULT home too.
 *
 * `~/.sthayi` derived from a home directory reached through a symlink (`/home -> /usr/home` on some
 * BSDs, or a corporate `/Users/x -> /net/home/x`) is REFUSED, exactly like an explicit STHAYI_HOME
 * through a link: every derived path, the launcher command baked into client configs, and every
 * atomic write would otherwise follow a link that can be repointed later.
 *
 * The refusal has to be SELF-FIXING — it must name the resolved REAL path, so the user can set
 * STHAYI_HOME to the canonical location the README documents. That is what this pins.
 */

const posix = process.platform !== 'win32';

describe.skipIf(!posix)('safety: a default HOME reached through a symlink is refused', () => {
  let root: string;
  let realHome: string;
  let linkedHome: string;
  let previousSthayiHome: string | undefined;

  beforeEach(() => {
    root = runTempDir('sthayi-defaulthome-');
    // <root>/real/user is the canonical home; <root>/link -> <root>/real is the convenience link
    // the platform (or the admin) hands the user as $HOME.
    realHome = path.join(root, 'real', 'user');
    fs.mkdirSync(realHome, { recursive: true, mode: 0o700 });
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'link'));
    linkedHome = path.join(root, 'link', 'user');

    previousSthayiHome = process.env.STHAYI_HOME;
    // biome-ignore lint/performance/noDelete: unsetting an env var; assigning undefined coerces to "undefined".
    delete process.env.STHAYI_HOME; // the DEFAULT (os.homedir()-derived) home is the subject here
    vi.spyOn(os, 'homedir').mockReturnValue(linkedHome);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousSthayiHome === undefined) {
      // biome-ignore lint/performance/noDelete: unsetting an env var; assigning undefined coerces to "undefined".
      delete process.env.STHAYI_HOME;
    } else {
      process.env.STHAYI_HOME = previousSthayiHome;
    }
    removeOwned(root);
  });

  it('the default home is derived from os.homedir(), link and all', () => {
    expect(sthayiHome()).toBe(path.join(linkedHome, '.sthayi'));
  });

  it('ensureSthayiHome REFUSES and names the resolved real path — nothing is created', () => {
    let message = '';
    try {
      ensureSthayiHome();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/symlink/i);
    expect(message).toContain('canonical real path');
    expect(message).toContain(path.join(root, 'real')); // self-fixing: the real path is spelled out
    expect(fs.existsSync(path.join(realHome, '.sthayi'))).toBe(false);
    expect(fs.readdirSync(realHome)).toEqual([]);
  });

  it('the OBSERVATIONAL check refuses the same way (doctor / status / dry-run)', () => {
    fs.mkdirSync(path.join(realHome, '.sthayi'), { mode: 0o700 });
    let message = '';
    try {
      assertReadOnlySthayiHome();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/symlink/i);
    expect(message).toContain(path.join(root, 'real'));
  });

  it('the documented fix works: STHAYI_HOME set to the canonical real path is accepted', () => {
    // README troubleshooting: name the real path (realpath / readlink -f / `cd ~ && pwd -P`).
    process.env.STHAYI_HOME = path.join(realHome, '.sthayi');
    const established = ensureSthayiHome();
    expect(established).toBe(path.join(realHome, '.sthayi'));
    expect(fs.statSync(established).mode & 0o777).toBe(0o700);
  });

  it('a RELATIVE STHAYI_HOME is still refused (it must be absolute)', () => {
    process.env.STHAYI_HOME = './sthayi-state';
    expect(() => sthayiHome()).toThrow(/absolute path/i);
  });
});
