import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { planInit, runInit } from '../../packages/cli/src/clients/commands.js';
import { ensureSkillsDir, getSkill, listSkills } from '../../packages/cli/src/skills.js';
import { type FakeHome, createFakeHome, snapshotTree } from '../helpers/fake-home.js';
import { claimToolEntry, removeOwned } from '../helpers/owned-fs.js';
import { runTempDir } from '../helpers/run-temp.js';

/**
 * SAFETY: the skills subtree is a trust boundary, not a path the code walks blindly.
 *
 * Served by raw mkdir/readdir/exists/read/write, `<home>/skills -> outside` is FOLLOWED in both
 * directions: `ensureSkillsDir` seeds the sample INTO the attacker's directory, and
 * `listSkills`/`getSkill` — reachable over MCP as `skill_list`/`skill_get` — enumerate and
 * return files from it. Every row here plants a hostile shape, requires a refusal, and proves the
 * OUTSIDE tree is byte-identical afterwards and its contents never reached the caller.
 */

const posix = process.platform !== 'win32';
const OUTSIDE_SECRET = 'OUTSIDE-SECRET-must-never-be-served';
const OUTSIDE_SKILL = `---
name: outside-skill
description: ${OUTSIDE_SECRET}
tags: [stolen]
---

${OUTSIDE_SECRET}
`;

describe.skipIf(!posix)(
  'safety: skills subtree refuses to follow anything outside the home',
  () => {
    let home: FakeHome;
    let external: string;
    let userHome: string;
    let previousHome: string | undefined;

    beforeEach(() => {
      home = createFakeHome();
      external = runTempDir('sthayi-skills-ext-');
      userHome = runTempDir('sthayi-skills-hm-');
      previousHome = process.env.HOME; // client DETECTION must never read the real user's configs
      process.env.HOME = userHome;
    });

    afterEach(() => {
      if (previousHome === undefined) {
        // biome-ignore lint/performance/noDelete: unsetting an env var; assigning undefined coerces to "undefined".
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      removeOwned(external);
      removeOwned(userHome);
      home.cleanup();
    });

    /** An outside skill tree, plus a before-snapshot for byte-identical assertions. */
    function plantOutsideSkill(): { before: Record<string, string>; file: string } {
      const dir = path.join(external, 'stolen');
      fs.mkdirSync(dir);
      const file = path.join(dir, 'SKILL.md');
      fs.writeFileSync(file, OUTSIDE_SKILL);
      fs.chmodSync(file, 0o644);
      return { before: snapshotTree(external), file };
    }
    function assertOutsideIntact(before: Record<string, string>): void {
      expect(snapshotTree(external)).toEqual(before);
    }
    function message(fn: () => unknown): string {
      try {
        fn();
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      return '';
    }

    describe('a symlinked skills ROOT', () => {
      it('ensureSkillsDir refuses — the sample is NOT seeded into the outside directory', () => {
        const before = snapshotTree(external);
        fs.symlinkSync(external, home.path('skills'));

        expect(() => ensureSkillsDir()).toThrow(/symlink/i);
        assertOutsideIntact(before);
        expect(fs.readdirSync(external)).toEqual([]);
        expect(fs.lstatSync(home.path('skills')).isSymbolicLink()).toBe(true);
      });

      it('listSkills refuses — the outside skill is never enumerated', () => {
        const { before } = plantOutsideSkill();
        fs.symlinkSync(external, home.path('skills'));

        const msg = message(() => listSkills());
        expect(msg).toMatch(/symlink/i);
        expect(msg).not.toContain(OUTSIDE_SECRET);
        assertOutsideIntact(before);
      });

      it('getSkill refuses — the outside body is never returned', () => {
        const { before } = plantOutsideSkill();
        fs.symlinkSync(external, home.path('skills'));

        const msg = message(() => getSkill('outside-skill'));
        expect(msg).toMatch(/symlink/i);
        expect(msg).not.toContain(OUTSIDE_SECRET);
        assertOutsideIntact(before);
      });

      it('planInit (init --dry-run) refuses and still writes nothing', () => {
        const { before } = plantOutsideSkill();
        fs.symlinkSync(external, home.path('skills'));
        const homeBefore = fs.readdirSync(home.home).sort();

        const msg = message(() => planInit());
        expect(msg).toMatch(/symlink/i);
        expect(msg).not.toContain(OUTSIDE_SECRET);
        assertOutsideIntact(before);
        expect(fs.readdirSync(home.home).sort()).toEqual(homeBefore);
      });

      it('runInit (the EXECUTING path) refuses too — nothing lands outside', async () => {
        const before = snapshotTree(external);
        fs.symlinkSync(external, home.path('skills'));

        await expect(runInit({ yes: false })).rejects.toThrow(/symlink/i);
        assertOutsideIntact(before);
        expect(fs.readdirSync(external)).toEqual([]);
      });
    });

    describe('a symlinked NESTED skill directory', () => {
      beforeEach(() => {
        fs.mkdirSync(home.path('skills'), { recursive: true, mode: 0o700 });
      });

      it('listSkills refuses instead of quietly skipping it', () => {
        const { before } = plantOutsideSkill();
        fs.symlinkSync(path.join(external, 'stolen'), home.path('skills', 'stolen'));

        const msg = message(() => listSkills());
        expect(msg).toMatch(/symlink/i);
        expect(msg).not.toContain(OUTSIDE_SECRET);
        assertOutsideIntact(before);
      });

      it('ensureSkillsDir refuses rather than seeding beside it', () => {
        const { before } = plantOutsideSkill();
        fs.symlinkSync(path.join(external, 'stolen'), home.path('skills', 'stolen'));

        expect(() => ensureSkillsDir()).toThrow(/symlink/i);
        assertOutsideIntact(before);
        expect(fs.readdirSync(home.path('skills'))).toEqual(['stolen']);
      });

      it('planInit refuses', () => {
        const { before } = plantOutsideSkill();
        fs.symlinkSync(path.join(external, 'stolen'), home.path('skills', 'stolen'));

        expect(() => planInit()).toThrow(/symlink/i);
        assertOutsideIntact(before);
      });
    });

    describe('an untrusted SKILL.md', () => {
      let skillDir: string;
      beforeEach(() => {
        skillDir = home.path('skills', 'probe');
        fs.mkdirSync(skillDir, { recursive: true, mode: 0o700 });
      });

      it('symlinked to an outside file: refused, and the outside bytes are never served', () => {
        const { before, file } = plantOutsideSkill();
        fs.symlinkSync(file, path.join(skillDir, 'SKILL.md'));

        const msg = message(() => listSkills());
        expect(msg).toMatch(/symlink/i);
        expect(msg).not.toContain(OUTSIDE_SECRET);
        assertOutsideIntact(before);
      });

      it('a FIFO: refused promptly, never blocks', () => {
        try {
          execFileSync('mkfifo', [path.join(skillDir, 'SKILL.md')]);
        } catch {
          return; // no mkfifo here — the symlink/hard-link rows cover the gate
        }
        // `mkfifo` is an external binary this process cannot witness. This names the ONE entry it
        // was asked to make, so teardown has a basis for removing that entry alone.
        claimToolEntry(path.join(skillDir, 'SKILL.md'));
        expect(() => listSkills()).toThrow(/not a regular file/i);
        expect(fs.lstatSync(path.join(skillDir, 'SKILL.md')).isFIFO()).toBe(true);
      }, 10_000);

      it('hard-linked to an outside file: refused; the victim is byte- and mode-identical', () => {
        const { before, file } = plantOutsideSkill();
        fs.linkSync(file, path.join(skillDir, 'SKILL.md'));

        const msg = message(() => listSkills());
        expect(msg).toMatch(/hard link/i);
        expect(msg).not.toContain(OUTSIDE_SECRET);
        expect(fs.readFileSync(file, 'utf8')).toBe(OUTSIDE_SKILL);
        expect(fs.statSync(file).mode & 0o777).toBe(0o644);
        expect(fs.lstatSync(file).nlink).toBe(2);
        expect(before['stolen/SKILL.md']).toBe(OUTSIDE_SKILL);
      });

      it('oversize: refused by the cap, and its bytes are never echoed', () => {
        const p = path.join(skillDir, 'SKILL.md');
        fs.writeFileSync(p, `${OUTSIDE_SECRET}\n`.repeat(9000), { mode: 0o600 });
        expect(fs.statSync(p).size).toBeGreaterThan(256 * 1024);

        const msg = message(() => listSkills());
        expect(msg).toMatch(/cap/i);
        expect(msg).not.toContain(OUTSIDE_SECRET);
      });

      it('group/world-writable: refused', () => {
        const p = path.join(skillDir, 'SKILL.md');
        fs.writeFileSync(p, OUTSIDE_SKILL);
        fs.chmodSync(p, 0o666);
        expect(() => listSkills()).toThrow(/writable/i);
      });
    });

    // MCP reachability (`skill_list` / `skill_get` over a live server) is proven in
    // packages/cli/src/skills.test.ts — the MCP SDK resolves only inside that package.

    it('the healthy path still works: a real skills dir seeds, lists and gets', () => {
      ensureSkillsDir();
      expect(fs.lstatSync(home.path('skills')).isDirectory()).toBe(true);
      expect(listSkills().map((s) => s.name)).toContain('using-sthayi-memory');
      expect(getSkill('using-sthayi-memory')?.content).toMatch(/# Using Sthayi memory/);
      expect(planInit().skillsSample.wouldCreate).toBe(false);
    });
  },
);
