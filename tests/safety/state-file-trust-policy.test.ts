import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDoctor } from '../../packages/cli/src/doctor.js';
import { buildProgram } from '../../packages/cli/src/index.js';
import { type FakeHome, createFakeHome } from '../helpers/fake-home.js';
import { removeOwned } from '../helpers/owned-fs.js';
import { runTempDir } from '../helpers/run-temp.js';

/**
 * SAFETY: THE PRESENCE PROBES APPLY THE FULL FILE-TRUST POLICY, AND A FAILED PROBE IS NOT ABSENCE.
 *
 * Two presence probes decide the most consequential thing Sthayi ever says about a machine — "this
 * is initialized" / "this is not initialized". Each must apply the SAME trust policy the rest of
 * the codebase enforces; a probe that checks a fraction of it answers confidently about a store it
 * has not actually vouched for.
 *
 * SITE A · the bare `sthayi` command must not accept ANY REGULAR FILE at ~/.sthayi/sthayi.db and
 * ~/.sthayi/key. No-follow alone is not the check: three hostile shapes carry no symlink at all and
 * live INSIDE a perfectly healthy 0700 home, yet each would buy a confident "Sthayi is
 * initialized." plus a full status render —
 *   - a HARD LINK aliasing a file outside the home (nlink > 1) — there is no link to see, and
 *     deleting ours never detaches theirs;
 *   - a FOREIGN-OWNED file — its owner rewrites the store's bytes under us whenever they like;
 *   - a GROUP/WORLD-WRITABLE file — anyone who can write it can already steer us.
 * Every row below plants one of those, drives the real bare command, and requires a refusal that
 * NAMES what is wrong (a user who hit a hard link must be told "hard links", not "symlink or not
 * a regular file"), leaves the victim byte- and mode-identical, and never renders the initialized
 * banner.
 *
 * SITE B · `sthayi doctor` must not convert an lstat FAILURE into "absent". EACCES on the home (a
 * directory chmod'd 000 — the most ordinary way a real home becomes unreadable) and EIO from a
 * failing disk would otherwise render as doctor's HEALTHIEST verdict — "not initialized, run
 * `sthayi init`" — with the store and the key sitting right there. Presence is a TRI-STATE:
 * present / absent / unknown, and unknown is a FAILED diagnostic naming the errno.
 */

const posix = process.platform !== 'win32';
/** Ownership and permission-bit refusals are meaningless for root, who bypasses both. */
const unprivilegedPosix = posix && (process.getuid?.() ?? 0) !== 0;

const VICTIM_BYTES = 'OUTSIDE-VICTIM-must-never-be-adopted-as-a-store';
const INITIALIZED_BANNER = 'Sthayi is initialized.';

describe.skipIf(!posix)('safety: state-file presence probes enforce the full trust policy', () => {
  let home: FakeHome;
  let outside: string;
  let clientHome: string;
  let stdout: string[];
  let stderr: string[];

  beforeEach(() => {
    home = createFakeHome();
    outside = runTempDir('sthayi-trustpolicy-out-');
    // Client detection resolves from os.homedir(); isolate it so the healthy row can never read
    // (or report on) the dev machine's real client configs.
    clientHome = runTempDir('sthayi-trustpolicy-hm-');
    vi.spyOn(os, 'homedir').mockReturnValue(clientHome);
    stdout = [];
    stderr = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    removeOwned(outside);
    removeOwned(clientHome);
    home.cleanup();
  });

  /** A 32-byte key file, so the db row under test is the only thing the probe can object to. */
  function plantHealthyKey(): void {
    fs.writeFileSync(home.path('key'), Buffer.alloc(32, 7), { mode: 0o600 });
  }

  /** A file OUTSIDE the home with distinctive bytes and a distinctive mode. */
  function plantVictim(name: string, mode = 0o600): string {
    const file = path.join(outside, name);
    fs.writeFileSync(file, VICTIM_BYTES, { mode });
    fs.chmodSync(file, mode);
    return file;
  }

  async function runBare(): Promise<void> {
    await buildProgram().parseAsync(['node', 'sthayi']);
  }

  /** Refused, exit 1, and NOT ONE WORD of the initialized branch. */
  function expectRefusedAsUninitializable(): void {
    expect(stdout.join('')).not.toContain(INITIALIZED_BANNER);
    expect(stdout.join('')).not.toContain('Sthayi initialized'); // nor did it init over the entry
    expect(process.exitCode).toBe(1);
  }

  // ── SITE A · the bare command ───────────────────────────────────────────────────────────────
  describe('site A · bare `sthayi` refuses every shape fs-safe refuses', () => {
    it.skipIf(!unprivilegedPosix)(
      'a HARD-LINKED db (nlink 2, aliasing an outside file) is refused and NAMED as a hard link',
      async () => {
        const victim = plantVictim('victim.db');
        fs.linkSync(victim, home.path('sthayi.db'));
        plantHealthyKey();
        expect(fs.lstatSync(victim).nlink).toBe(2);

        await runBare();

        expectRefusedAsUninitializable();
        // The whole point of the wording requirement: "hard links" must appear, with the count.
        expect(stderr.join('')).toMatch(/memory database at .*sthayi\.db has 2 hard links/);
        expect(stderr.join('')).toMatch(/possible hijack/);
        // …and the policy line enumerates the refusal types, so the user learns the rule too.
        expect(stderr.join('')).toMatch(/an extra hard link/);
        expect(stderr.join('')).toMatch(/refusing to initialize over it/);
        // the victim is untouched: same bytes, same mode, still linked (nothing was unlinked)
        expect(fs.readFileSync(victim, 'utf8')).toBe(VICTIM_BYTES);
        expect(fs.lstatSync(victim).mode & 0o777).toBe(0o600);
        expect(fs.lstatSync(victim).nlink).toBe(2);
      },
    );

    it.skipIf(!unprivilegedPosix)(
      'a FOREIGN-OWNED db is refused and NAMED as foreign-owned (never adopted as a store)',
      async () => {
        fs.writeFileSync(home.path('sthayi.db'), 'planted by someone else', { mode: 0o600 });
        plantHealthyKey();
        const dbFile = home.path('sthayi.db');
        const foreignUid = (process.getuid?.() ?? 0) + 4242;
        // chown(2) to a foreign uid is root-only, so the FOREIGN OWNER is injected on the stats
        // the probe actually reads — deterministic, and it exercises the real code path.
        const realLstat = fs.lstatSync;
        vi.spyOn(fs, 'lstatSync').mockImplementation(((p: fs.PathLike, o?: never) => {
          const st = realLstat(p, o) as fs.Stats;
          if (String(p) === dbFile) {
            Object.defineProperty(st, 'uid', { value: foreignUid });
          }
          return st;
        }) as never);

        await runBare();

        expectRefusedAsUninitializable();
        expect(stderr.join('')).toMatch(
          new RegExp(`memory database at .*sthayi\\.db is owned by uid ${foreignUid}, not you`),
        );
        expect(stderr.join('')).toMatch(/a foreign owner/); // the policy line names the type
        expect(stderr.join('')).toMatch(/refusing to initialize over it/);
      },
    );

    it.skipIf(!unprivilegedPosix)(
      'a GROUP/WORLD-WRITABLE db (mode 666) is refused and NAMED as shared-writable',
      async () => {
        fs.writeFileSync(home.path('sthayi.db'), 'planted', { mode: 0o600 });
        fs.chmodSync(home.path('sthayi.db'), 0o666);
        plantHealthyKey();

        await runBare();

        expectRefusedAsUninitializable();
        expect(stderr.join('')).toMatch(
          /memory database at .*sthayi\.db is group- or world-writable \(mode 666\)/,
        );
        expect(stderr.join('')).toMatch(/group\/world-writable permission bits/);
        // the refusal did NOT "repair" the file behind the user's back
        expect(fs.lstatSync(home.path('sthayi.db')).mode & 0o777).toBe(0o666);
      },
    );

    it.skipIf(!unprivilegedPosix)(
      'the KEY path is held to the same policy: a group-writable key is refused and named',
      async () => {
        fs.writeFileSync(home.path('sthayi.db'), 'planted', { mode: 0o600 });
        fs.writeFileSync(home.path('key'), Buffer.alloc(32, 7), { mode: 0o600 });
        fs.chmodSync(home.path('key'), 0o620);

        await runBare();

        expectRefusedAsUninitializable();
        expect(stderr.join('')).toMatch(
          /vault key at .*key is group- or world-writable \(mode 620\)/,
        );
        expect(fs.lstatSync(home.path('key')).mode & 0o777).toBe(0o620);
      },
    );

    it.skipIf(!unprivilegedPosix)(
      'a HARD-LINKED key is refused too (the key probe is not the weaker one)',
      async () => {
        fs.writeFileSync(home.path('sthayi.db'), 'planted', { mode: 0o600 });
        const victim = plantVictim('victim.key');
        fs.linkSync(victim, home.path('key'));

        await runBare();

        expectRefusedAsUninitializable();
        expect(stderr.join('')).toMatch(/vault key at .*key has 2 hard links/);
        expect(fs.readFileSync(victim, 'utf8')).toBe(VICTIM_BYTES);
      },
    );

    it('a db that CANNOT BE INSPECTED at all is refused, never treated as absent', async () => {
      fs.writeFileSync(home.path('sthayi.db'), 'planted', { mode: 0o600 });
      plantHealthyKey();
      const dbFile = home.path('sthayi.db');
      const realLstat = fs.lstatSync;
      vi.spyOn(fs, 'lstatSync').mockImplementation(((p: fs.PathLike, o?: never) => {
        if (String(p) === dbFile) {
          const err = new Error('EIO: i/o error') as NodeJS.ErrnoException;
          err.code = 'EIO';
          throw err;
        }
        return realLstat(p, o) as fs.Stats;
      }) as never);

      await runBare();

      expectRefusedAsUninitializable();
      expect(stderr.join('')).toMatch(/could not be inspected \(EIO\)/);
      expect(stderr.join('')).toMatch(/cannot be inspected at all/); // named in the policy line
    });

    it('the healthy path is unchanged: private 0600 db + key still report "initialized"', async () => {
      fs.writeFileSync(home.path('sthayi.db'), 'not really sqlite', { mode: 0o600 });
      plantHealthyKey();

      await runBare();

      expect(stdout.join('')).toContain(INITIALIZED_BANNER);
      expect(stderr.join('')).toBe('');
      expect(process.exitCode).toBeUndefined();
    });

    it('the first-run path is unchanged: an empty home still routes into init', async () => {
      await runBare();

      expect(stdout.join('')).toContain('Sthayi initialized');
      expect(stdout.join('')).not.toContain(INITIALIZED_BANNER);
      expect(fs.existsSync(home.path('sthayi.db'))).toBe(true);
      expect(process.exitCode).toBeUndefined();
    });
  });

  // ── SITE B · doctor's tri-state ─────────────────────────────────────────────────────────────
  describe('site B · doctor never renders an uninspectable home as a healthy "not initialized"', () => {
    /** Every check that renders "not initialized" as a HEALTHY verdict — the false all-clear. */
    function healthyNotInitializedChecks(checks: ReturnType<typeof runDoctor>) {
      return checks.filter((c) => c.ok && /not initialized/.test(c.detail));
    }

    it.skipIf(!unprivilegedPosix)(
      'EACCES · a home directory chmod 000 (store + key inside) is a FAILED diagnostic',
      () => {
        const locked = path.join(outside, 'locked-home');
        fs.mkdirSync(locked, { mode: 0o700 });
        fs.writeFileSync(path.join(locked, 'sthayi.db'), 'planted', { mode: 0o600 });
        fs.writeFileSync(path.join(locked, 'key'), Buffer.alloc(32, 7), { mode: 0o600 });
        const previous = process.env.STHAYI_HOME;
        process.env.STHAYI_HOME = locked;

        let checks: ReturnType<typeof runDoctor> = [];
        fs.chmodSync(locked, 0o000);
        try {
          checks = runDoctor();
        } finally {
          fs.chmodSync(locked, 0o700);
          if (previous === undefined) {
            // biome-ignore lint/performance/noDelete: unsetting an env var; assigning undefined coerces to "undefined".
            delete process.env.STHAYI_HOME;
          } else {
            process.env.STHAYI_HOME = previous;
          }
        }

        // An unreadable home must never render as the healthy "not initialized … run `sthayi init`"
        // Initialization check: that verdict claims knowledge the probe does not have.
        expect(healthyNotInitializedChecks(checks)).toEqual([]);
        expect(checks.find((c) => c.name === 'Initialization')).toBeUndefined();
        const store = checks.find((c) => c.name === 'Store');
        expect(store?.ok).toBe(false);
        expect(store?.detail).toMatch(/could not be inspected \(EACCES\)/);
        expect(store?.detail).toMatch(/cannot tell whether it exists/);
        const key = checks.find((c) => c.name === 'Vault key');
        expect(key?.ok).toBe(false);
        expect(key?.detail).toMatch(/could not be inspected \(EACCES\)/);
        // and doctor stayed observational: the locked home was not repaired for us
        expect(checks.some((c) => !c.ok)).toBe(true);
      },
    );

    it('EIO · a generic non-ENOENT lstat failure on the db is a FAILED diagnostic, not absence', () => {
      fs.writeFileSync(home.path('sthayi.db'), 'planted', { mode: 0o600 });
      fs.writeFileSync(home.path('key'), Buffer.alloc(32, 7), { mode: 0o600 });
      const dbFile = home.path('sthayi.db');
      const realLstat = fs.lstatSync;
      vi.spyOn(fs, 'lstatSync').mockImplementation(((p: fs.PathLike, o?: never) => {
        if (String(p) === dbFile) {
          const err = new Error(`EIO: i/o error, lstat '${dbFile}'`) as NodeJS.ErrnoException;
          err.code = 'EIO';
          throw err;
        }
        return realLstat(p, o) as fs.Stats;
      }) as never);

      const checks = runDoctor();

      expect(healthyNotInitializedChecks(checks)).toEqual([]);
      expect(checks.find((c) => c.name === 'Initialization')).toBeUndefined();
      const store = checks.find((c) => c.name === 'Store');
      expect(store?.ok).toBe(false);
      expect(store?.detail).toMatch(/could not be inspected \(EIO\)/);
      // ONLY the db is named uninspectable — the key probed fine and must not be smeared with it
      expect(
        checks.filter((c) => /could not be inspected/.test(c.detail)).map((c) => c.name),
      ).toEqual(['Store']);
      // …and no check anywhere claims health
      expect(checks.filter((c) => c.ok).map((c) => c.name)).toEqual(['Node version']);
    });

    it('EIO on the KEY alone is a FAILED diagnostic too (both probes are tri-state)', () => {
      fs.writeFileSync(home.path('sthayi.db'), 'planted', { mode: 0o600 });
      fs.writeFileSync(home.path('key'), Buffer.alloc(32, 7), { mode: 0o600 });
      const keyFile = home.path('key');
      const realLstat = fs.lstatSync;
      vi.spyOn(fs, 'lstatSync').mockImplementation(((p: fs.PathLike, o?: never) => {
        if (String(p) === keyFile) {
          const err = new Error(`EIO: i/o error, lstat '${keyFile}'`) as NodeJS.ErrnoException;
          err.code = 'EIO';
          throw err;
        }
        return realLstat(p, o) as fs.Stats;
      }) as never);

      const checks = runDoctor();

      expect(healthyNotInitializedChecks(checks)).toEqual([]);
      expect(checks.find((c) => c.name === 'Initialization')).toBeUndefined();
      expect(checks.find((c) => c.name === 'Vault key')?.ok).toBe(false);
      expect(checks.find((c) => c.name === 'Vault key')?.detail).toMatch(
        /could not be inspected \(EIO\)/,
      );
    });

    it('ENOENT is still ABSENCE: an empty home keeps its healthy "not initialized" verdict', () => {
      const checks = runDoctor();
      const init = checks.find((c) => c.name === 'Initialization');
      expect(init?.ok).toBe(true);
      expect(init?.detail).toMatch(/not initialized/);
      expect(checks.some((c) => !c.ok)).toBe(false);
    });
  });
});
