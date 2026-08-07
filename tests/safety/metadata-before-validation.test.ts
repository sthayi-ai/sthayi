import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JOURNAL_CHECKPOINT_KEY } from '@sthayi/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { planInit, runInit } from '../../packages/cli/src/clients/commands.js';
import { runDoctor } from '../../packages/cli/src/doctor.js';
import { getSkill, listSkills, skillsSeeded } from '../../packages/cli/src/skills.js';
import { openStore } from '../../packages/cli/src/store.js';
import { type FakeHome, createFakeHome } from '../helpers/fake-home.js';
import { claimToolEntry, removeOwned } from '../helpers/owned-fs.js';
import { runTempDir } from '../helpers/run-temp.js';

/**
 * SAFETY: METADATA IS NEVER READ BEFORE THE PATH THAT HOLDS IT IS VALIDATED.
 *
 * `existsSync` and `statSync` FOLLOW symlinks. Anywhere one of them decides "does the db exist",
 * "what mode is the store", or "is this machine initialized", a link planted at that path answers
 * for its TARGET — so an outside file's existence and permission bits reach user-visible output and
 * "initialized" verdicts get computed from a tree nobody validated. ORDER is half the invariant:
 * a probe that runs BEFORE the home itself is validated reads beneath a directory the code is about
 * to refuse, and the refusal comes too late to unsay what was already disclosed.
 *
 * Every row here plants an outside CANARY (distinctive bytes AND a distinctive mode), drives the
 * real command, and requires three things: the command refuses (or reports nothing about the
 * target), the canary's bytes and mode appear NOWHERE in stdout/stderr or the returned structure,
 * and the outside tree is byte- and mode-identical afterwards. Dry-run rows additionally snapshot
 * the WHOLE probe tree before and after — a refusal must still write nothing.
 */

const posix = process.platform !== 'win32';

/** Distinctive so a leak is unmistakable: nothing else in Sthayi's output can produce these. */
const DB_CANARY = 'OUTSIDE-DB-CANARY-must-never-be-reported';
const CANARY_MODE = 0o646; // "mode 646" — a string doctor can only print by following the link
const SKILL_CANARY = 'OUTSIDE-SKILL-CANARY-must-never-be-served';

/** `{ relPath: "mode=… nlink=… <bytes>" }` — bytes AND permission bits, symlinks never followed. */
function snapshotWithModes(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of fs
      .readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const st = fs.lstatSync(full);
      const body = st.isSymbolicLink()
        ? `symlink -> ${fs.readlinkSync(full)}`
        : st.isFile()
          ? fs.readFileSync(full, 'utf8')
          : '<special>';
      out[path.relative(dir, full)] =
        `mode=${(st.mode & 0o777).toString(8)} nlink=${st.nlink} ${body}`;
    }
  };
  walk(dir);
  return out;
}

/** Run `fn`, returning its thrown message (or '' when it did not throw). */
function message(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return '';
}

/** Capture stdout+stderr without leaking either into the vitest reporter. */
function captureOutput(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  return {
    text: () => chunks.join(''),
    restore: () => {
      outSpy.mockRestore();
      errSpy.mockRestore();
    },
  };
}

describe.skipIf(!posix)(
  'safety: no metadata is read before the path holding it is validated',
  () => {
    let home: FakeHome;
    let external: string;
    let userHome: string;

    beforeEach(() => {
      home = createFakeHome();
      external = runTempDir('sthayi-mbv-ext-');
      // Client DETECTION resolves from os.homedir() — isolate it so the dev machine's real wiring
      // can never leak into these assertions (and so no real client config is ever read).
      userHome = runTempDir('sthayi-mbv-hm-');
      vi.spyOn(os, 'homedir').mockReturnValue(userHome);
    });

    afterEach(() => {
      vi.restoreAllMocks();
      removeOwned(external);
      removeOwned(userHome);
      home.cleanup();
    });

    /** An outside "database" with distinctive bytes AND a distinctive mode. */
    function plantOutsideDb(name = 'db-canary'): string {
      const file = path.join(external, name);
      fs.writeFileSync(file, DB_CANARY);
      fs.chmodSync(file, CANARY_MODE);
      return file;
    }

    /** Nothing the command produced may contain the canary bytes or the canary mode. */
    function expectNoCanary(text: string): void {
      expect(text).not.toContain(DB_CANARY);
      // The outside file's permission bits as doctor renders them: `… (mode 646)`. Anchored to the
      // rendered form, because a bare `646` is also a substring of ordinary temp-path names and a
      // hit there would be a false alarm rather than a disclosure.
      expect(text).not.toMatch(/\bmode 646\b/);
    }

    // ── SITE 1 — clients/commands.ts planInit(): `existsSync` on the FINAL db/key paths ──────────
    describe('site 1 · init --dry-run must not report a symlink TARGET as the store', () => {
      it('a db symlinked to an outside file: refused; "keep existing db" is never printed', async () => {
        const victim = plantOutsideDb();
        fs.symlinkSync(victim, home.path('sthayi.db'));
        const outsideBefore = snapshotWithModes(external);
        const homeBefore = snapshotWithModes(home.home);

        const msg = message(() => planInit());
        expect(msg).toMatch(/symlink/i);
        expectNoCanary(msg);

        const cap = captureOutput();
        let rejected = '';
        try {
          await runInit({ dryRun: true });
        } catch (err) {
          rejected = err instanceof Error ? err.message : String(err);
        } finally {
          cap.restore();
        }
        expect(rejected).toMatch(/symlink/i);
        expect(cap.text()).not.toMatch(/keep existing db/);
        expectNoCanary(cap.text());

        // the dry-run wrote nothing, on the refusal path included
        expect(snapshotWithModes(external)).toEqual(outsideBefore);
        expect(snapshotWithModes(home.home)).toEqual(homeBefore);
      });

      it('a key symlinked to an outside file: refused; "keep existing key" is never printed', async () => {
        const victim = plantOutsideDb('key-canary');
        fs.symlinkSync(victim, home.path('key'));
        const outsideBefore = snapshotWithModes(external);
        const homeBefore = snapshotWithModes(home.home);

        const msg = message(() => planInit());
        expect(msg).toMatch(/symlink/i);
        expectNoCanary(msg);

        const cap = captureOutput();
        await runInit({ dryRun: true }).catch(() => undefined);
        cap.restore();
        expect(cap.text()).not.toMatch(/keep existing key/);
        expectNoCanary(cap.text());

        expect(snapshotWithModes(external)).toEqual(outsideBefore);
        expect(snapshotWithModes(home.home)).toEqual(homeBefore);
      });

      it('a DANGLING db symlink: refused, never reported as "create db" (nothing is there)', () => {
        fs.symlinkSync(path.join(external, 'never-existed'), home.path('sthayi.db'));
        const msg = message(() => planInit());
        expect(msg).toMatch(/symlink/i);
      });

      it('a FIFO at the db path: refused promptly, never reported as an existing store', () => {
        try {
          execFileSync('mkfifo', [home.path('sthayi.db')]);
        } catch {
          return; // no mkfifo here — the symlink rows cover the gate
        }
        // `mkfifo` is an external binary whose syscalls no wrapper in this process sees. This names
        // the ONE entry it was asked to make, so teardown has a basis for removing that entry alone.
        claimToolEntry(home.path('sthayi.db'));
        const started = Date.now();
        const msg = message(() => planInit());
        expect(Date.now() - started).toBeLessThan(20_000);
        expect(msg).toMatch(/not a regular file/i);
        expect(fs.lstatSync(home.path('sthayi.db')).isFIFO()).toBe(true);
      }, 30_000);

      it('a db HARD-LINKED to an outside file: refused; the victim is byte- and mode-identical', () => {
        const victim = plantOutsideDb();
        fs.linkSync(victim, home.path('sthayi.db'));
        const outsideBefore = snapshotWithModes(external);

        const msg = message(() => planInit());
        expect(msg).toMatch(/hard link/i);
        expectNoCanary(msg);
        expect(snapshotWithModes(external)).toEqual(outsideBefore);
        expect(fs.readFileSync(victim, 'utf8')).toBe(DB_CANARY);
        expect(fs.lstatSync(victim).mode & 0o777).toBe(CANARY_MODE);
      });

      it('the healthy path is unchanged: real db/key files are reported as existing', () => {
        fs.writeFileSync(home.path('sthayi.db'), 'not really sqlite', { mode: 0o600 });
        fs.writeFileSync(home.path('key'), crypto.randomBytes(32), { mode: 0o600 });
        const plan = planInit();
        expect(plan.homeExists).toBe(true);
        expect(plan.db.exists).toBe(true);
        expect(plan.key.exists).toBe(true);
      });
    });

    // ── SITE 2 — doctor.ts: `statSync` FOLLOWS a db it just REFUSED ──────────────────────────────
    describe('site 2 · doctor must never report a refused db through its symlink TARGET', () => {
      function doctorJson(): string {
        return JSON.stringify(runDoctor());
      }

      it('a symlinked db: the outside target\'s MODE is never rendered as "Store file permissions"', () => {
        const victim = plantOutsideDb();
        fs.symlinkSync(victim, home.path('sthayi.db'));
        fs.writeFileSync(home.path('key'), crypto.randomBytes(32), { mode: 0o600 });
        const outsideBefore = snapshotWithModes(external);

        const checks = runDoctor();
        const json = JSON.stringify(checks);
        expectNoCanary(json);
        // doctor refuses the db in BOTH places that speak about it
        expect(checks.find((c) => c.name === 'Store')?.ok).toBe(false);
        const perms = checks.find((c) => c.name === 'Store file permissions');
        expect(perms?.ok).toBe(false);
        expect(perms?.detail).toMatch(/symlink/i);
        expect(perms?.detail).not.toMatch(/mode 646/);

        expect(snapshotWithModes(external)).toEqual(outsideBefore);
      });

      // The canary is the RENDERED bits — `(mode 646)` — and not the three digits on their own.
      // Doctor prints the home path verbatim, so a run whose scratch directory happens to be named
      // with those digits puts them in the output every time without anything having been
      // disclosed. This row makes that case deterministic rather than leaving it to whatever name
      // the temp allocator produces.
      it('digits inside a printed PATH are not a disclosure: doctor names it, the canary holds', () => {
        const fixture = runTempDir('sthayi-mbv-tmp646-');
        const digitHome = path.join(fixture, 'home');
        fs.mkdirSync(digitHome, { mode: 0o700 });
        process.env.STHAYI_HOME = digitHome;
        try {
          const json = doctorJson();
          expect(json).toContain('tmp646'); // the digits really do reach the output
          expectNoCanary(json); // and the canary does not fire on them
        } finally {
          process.env.STHAYI_HOME = home.home; // back to the fixture afterEach tears down
          removeOwned(fixture);
        }
      });

      it('a symlinked db and NO key: the outside file never buys an "initialized" verdict', () => {
        const victim = plantOutsideDb();
        fs.symlinkSync(victim, home.path('sthayi.db'));
        const outsideBefore = snapshotWithModes(external);

        const json = doctorJson();
        expectNoCanary(json);
        expect(snapshotWithModes(external)).toEqual(outsideBefore);
      });

      it('a DANGLING key symlink is PRESENT, not "not initialized"', () => {
        fs.symlinkSync(path.join(external, 'never-existed'), home.path('key'));
        const checks = runDoctor();
        // existsSync said "nothing here" for a link that is plainly planted, so doctor answered
        // "not initialized" and stopped. lstat sees the entry, and the key check names it.
        expect(checks.map((c) => c.detail).join('\n')).not.toMatch(/not initialized/);
        expect(checks.find((c) => c.name === 'Vault key')?.ok).toBe(false);
        expect(checks.some((c) => !c.ok)).toBe(true);
      });

      it('the healthy path is unchanged: a real 0600 store reports its own mode', () => {
        openStore().close();
        const checks = runDoctor();
        expect(checks.find((c) => c.name === 'Store file permissions')?.ok).toBe(true);
        expect(checks.find((c) => c.name === 'Store file permissions')?.detail).toMatch(/mode 600/);
      });
    });

    // ── SITE 3 — store.ts: priorInstallEvidence() probes markers under the home ──────────────────
    describe('site 3 · openStore validates the home BEFORE probing prior-install markers', () => {
      let probeRoot: string;
      let previousHome: string | undefined;

      beforeEach(() => {
        probeRoot = runTempDir('sthayi-mbv-store-');
        previousHome = process.env.STHAYI_HOME;
      });

      afterEach(() => {
        if (previousHome === undefined) {
          // biome-ignore lint/performance/noDelete: unsetting an env var; assigning undefined coerces to "undefined".
          delete process.env.STHAYI_HOME;
        } else {
          process.env.STHAYI_HOME = previousHome;
        }
        removeOwned(probeRoot);
      });

      it('a home reached through a symlinked ANCESTOR: the markers are never probed through it', () => {
        // <probe>/outside/home holds all three prior-install markers; <probe>/hop points at it.
        const outsideHome = path.join(probeRoot, 'outside', 'home');
        fs.mkdirSync(outsideHome, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(outsideHome, 'key'), crypto.randomBytes(32), { mode: 0o600 });
        fs.writeFileSync(path.join(outsideHome, 'clients-state.json'), '{}\n', { mode: 0o600 });
        fs.writeFileSync(path.join(outsideHome, 'journal.checkpoint'), DB_CANARY, { mode: 0o600 });
        fs.symlinkSync(path.join(probeRoot, 'outside'), path.join(probeRoot, 'hop'));
        process.env.STHAYI_HOME = path.join(probeRoot, 'hop', 'home');
        const before = snapshotWithModes(path.join(probeRoot, 'outside'));

        const seen = vi.spyOn(fs, 'lstatSync');
        let msg = '';
        try {
          msg = message(() => openStore().close());
        } finally {
          const probed = seen.mock.calls
            .map((c) => String(c[0]))
            .filter((p) => /(key|clients-state\.json|journal\.checkpoint)$/.test(p));
          seen.mockRestore();
          // NOT ONE marker beneath the unvalidated home was inspected before the refusal.
          expect(probed).toEqual([]);
        }
        expect(msg).toMatch(/symlink/i);
        expect(snapshotWithModes(path.join(probeRoot, 'outside'))).toEqual(before);
      });

      it('prior-install evidence still means what it meant: a virgin home seals, a marked one does not', () => {
        // Virgin: no marker → first-run TOFU seal happens.
        const virgin = path.join(probeRoot, 'virgin');
        process.env.STHAYI_HOME = virgin;
        const fresh = openStore();
        try {
          expect(fresh.driver.getMeta(JOURNAL_CHECKPOINT_KEY)).toBeDefined();
        } finally {
          fresh.close();
        }

        // Marked: a wiring ledger proves a prior install → NO auto-seal, even though the store
        // itself is brand new. The ordering is load-bearing: reading priorInstallEvidence AFTER
        // the key/db creation would fabricate the evidence and flip the first assertion above.
        const marked = path.join(probeRoot, 'marked');
        fs.mkdirSync(marked, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(marked, 'clients-state.json'), '{}\n', { mode: 0o600 });
        process.env.STHAYI_HOME = marked;
        const cap = captureOutput();
        const store = openStore();
        try {
          cap.restore();
          expect(store.driver.getMeta(JOURNAL_CHECKPOINT_KEY)).toBeUndefined();
        } finally {
          cap.restore();
          store.close();
        }
      });
    });

    // ── SITE 4 — skills.ts: the HOME above the skills DIRECTORY must be validated too ────────────
    describe('site 4 · the skills read paths validate the HOME before probing beneath it', () => {
      beforeEach(() => {
        fs.mkdirSync(home.path('skills', 'probe'), { recursive: true, mode: 0o700 });
        fs.writeFileSync(
          home.path('skills', 'probe', 'SKILL.md'),
          `---\nname: probe-skill\ndescription: ${SKILL_CANARY}\n---\n\n${SKILL_CANARY}\n`,
          { mode: 0o600 },
        );
      });

      // STICKY world-writable (mode 1777) is the shape that isolates this fix. The skills root's own
      // ancestor walk deliberately FORGIVES a sticky world-writable directory — right for a path
      // that merely passes through /tmp, wrong for the home itself, because sticky only stops a peer
      // from deleting OUR entries, never from creating THEIRS. Validating just `skills/` therefore
      // enumerated and served a subtree any local user could have planted.
      it('a STICKY world-writable home: listSkills/getSkill/skillsSeeded refuse instead of serving through it', () => {
        fs.chmodSync(home.home, 0o1777);

        const list = message(() => listSkills());
        expect(list).toMatch(/writable/i);
        expect(list).not.toContain(SKILL_CANARY);

        const get = message(() => getSkill('probe-skill'));
        expect(get).toMatch(/writable/i);
        expect(get).not.toContain(SKILL_CANARY);

        expect(message(() => skillsSeeded())).toMatch(/writable/i);
        // and the refusal must not have "repaired" the home behind the user's back
        expect(fs.lstatSync(home.home).mode & 0o7777).toBe(0o1777);
      });

      it('a GROUP-WRITABLE home: the same refusal, and nothing beneath it is enumerated', () => {
        fs.chmodSync(home.home, 0o770);
        expect(message(() => listSkills())).toMatch(/writable/i);
        expect(message(() => listSkills())).not.toContain(SKILL_CANARY);
        expect(fs.lstatSync(home.home).mode & 0o777).toBe(0o770);
      });

      it('a STICKY world-writable home: init --dry-run refuses and prints no skill state', async () => {
        fs.chmodSync(home.home, 0o1777);
        const before = snapshotWithModes(home.home);

        const cap = captureOutput();
        let rejected = '';
        try {
          await runInit({ dryRun: true });
        } catch (err) {
          rejected = err instanceof Error ? err.message : String(err);
        } finally {
          cap.restore();
        }
        expect(rejected).toMatch(/writable/i);
        expect(cap.text()).not.toContain(SKILL_CANARY);
        expect(snapshotWithModes(home.home)).toEqual(before);
        expect(fs.lstatSync(home.home).mode & 0o7777).toBe(0o1777);
      });

      it('the healthy path is unchanged: an owner-only home lists its skills', () => {
        expect(listSkills().map((s) => s.name)).toContain('probe-skill');
        expect(getSkill('probe-skill')?.content).toContain(SKILL_CANARY);
        expect(skillsSeeded()).toBe(true);
      });
    });
  },
);
