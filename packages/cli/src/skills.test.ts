import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { JournalService, MemoryService } from '@sthayi/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeHome, createFakeHome } from '../../../tests/helpers/fake-home.js';
import { claimToolEntry } from '../../../tests/helpers/owned-fs.js';
import { runTempDir } from '../../../tests/helpers/run-temp.js';
import { SqliteDriver } from './drivers/sqlite.js';
import { buildMcpServer } from './mcp/server.js';
import { ensureSkillsDir, getSkill, listSkills } from './skills.js';

describe('skills', () => {
  let home: FakeHome;
  beforeEach(() => {
    home = createFakeHome();
  });
  afterEach(() => home.cleanup());

  it('seeds a sample skill on first ensure', () => {
    ensureSkillsDir();
    const skills = listSkills();
    expect(skills.map((s) => s.name)).toContain('using-sthayi-memory');
    const sample = skills.find((s) => s.name === 'using-sthayi-memory');
    expect(sample?.tags).toContain('memory');
    expect(sample?.description.length).toBeGreaterThan(0);
  });

  it('filters by tag', () => {
    ensureSkillsDir();
    expect(listSkills('memory').length).toBeGreaterThan(0);
    expect(listSkills('does-not-exist')).toHaveLength(0);
  });

  it('getSkill returns full content or undefined', () => {
    ensureSkillsDir();
    const detail = getSkill('using-sthayi-memory');
    expect(detail?.content).toMatch(/# Using Sthayi memory/);
    expect(getSkill('missing')).toBeUndefined();
  });

  it('listSkills is empty before the dir is ensured', () => {
    expect(listSkills()).toHaveLength(0);
  });

  it('the seeded sample is owner-only, inside a real skills directory', () => {
    ensureSkillsDir();
    expect(fs.lstatSync(home.path('skills')).isDirectory()).toBe(true);
    const sample = home.path('skills', 'using-sthayi-memory', 'SKILL.md');
    expect(fs.lstatSync(sample).isFile()).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(sample).mode & 0o077).toBe(0);
    }
  });
});

/**
 * MCP REACHABILITY: `skill_list` / `skill_get` are the only model-facing path into this subtree, so
 * every refusal has to hold THROUGH a real server, not merely at the function. Unguarded, each
 * shape below makes `skill_list` enumerate — and `skill_get` return — an attacker's files verbatim.
 *
 * Every row plants ONE hostile shape, drives a live in-memory MCP server, and requires: no byte of
 * the outside SKILL.md in either tool result, an actionable refusal instead, and an outside tree
 * that is byte- AND mode-identical afterwards.
 */
describe.skipIf(process.platform === 'win32')(
  'skills over MCP: outside content is unreachable',
  () => {
    let home: FakeHome;
    let external: string;
    const SECRET = 'OUTSIDE-SECRET-served-over-mcp';
    const OUTSIDE_MODE = 0o646;
    const OUTSIDE_SKILL = `---\nname: outside-skill\ndescription: ${SECRET}\n---\n\n${SECRET}\n`;

    beforeEach(() => {
      home = createFakeHome();
      external = runTempDir('sthayi-skills-mcp-');
      fs.mkdirSync(path.join(external, 'stolen'));
      fs.writeFileSync(path.join(external, 'stolen', 'SKILL.md'), OUTSIDE_SKILL);
      fs.chmodSync(path.join(external, 'stolen', 'SKILL.md'), OUTSIDE_MODE);
    });
    afterEach(() => {
      fs.rmSync(external, { recursive: true, force: true });
      home.cleanup();
    });

    /** `{ rel: "mode=… nlink=… <bytes>" }` — bytes AND permission bits, symlinks never followed. */
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
          out[path.relative(dir, full)] =
            `mode=${(st.mode & 0o777).toString(8)} nlink=${st.nlink} ${fs.readFileSync(full, 'utf8')}`;
        }
      };
      walk(dir);
      return out;
    }

    type ToolCall = (name: string, args: Record<string, unknown>) => Promise<string>;

    /** Drive a REAL server over an in-memory transport — the same path `sthayi serve` wires up. */
    async function withMcp(
      fn: (call: ToolCall) => Promise<void>,
      opts: { mask?: (s: string) => string } = {},
    ): Promise<void> {
      const driver = SqliteDriver.openMemory();
      driver.migrate();
      const journal = new JournalService(driver);
      const memory = new MemoryService(driver, journal);
      const server = buildMcpServer({ store: { driver, journal, memory }, mask: opts.mask });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'skills-trust-probe', version: '0.0.0' });
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const call: ToolCall = async (name, args) =>
        client
          .callTool({ name, arguments: args })
          .then((r) => JSON.stringify(r))
          // a refusal that escapes as a protocol error is still captured — and still asserted
          // against, so this can never quietly pass by turning a leak into a rejection
          .catch((err: unknown) => (err instanceof Error ? err.message : String(err)));
      try {
        await fn(call);
      } finally {
        await client.close();
        driver.close();
      }
    }

    /** A real, owner-only nested skill directory to hang a hostile SKILL.md off. */
    function probeDir(): string {
      const dir = home.path('skills', 'probe');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      return dir;
    }

    const rows: { what: string; plant: () => boolean; refusal: RegExp }[] = [
      {
        what: 'a symlinked skills ROOT',
        plant: () => {
          fs.symlinkSync(external, home.path('skills'));
          return true;
        },
        refusal: /symlink/i,
      },
      {
        what: 'a symlinked NESTED skill directory',
        plant: () => {
          fs.mkdirSync(home.path('skills'), { recursive: true, mode: 0o700 });
          fs.symlinkSync(path.join(external, 'stolen'), home.path('skills', 'stolen'));
          return true;
        },
        refusal: /symlink/i,
      },
      {
        what: 'a SKILL.md symlinked to an outside file',
        plant: () => {
          fs.symlinkSync(
            path.join(external, 'stolen', 'SKILL.md'),
            path.join(probeDir(), 'SKILL.md'),
          );
          return true;
        },
        refusal: /symlink/i,
      },
      {
        what: 'a FIFO SKILL.md',
        plant: () => {
          try {
            execFileSync('mkfifo', [path.join(probeDir(), 'SKILL.md')]);
          } catch {
            return false; // no mkfifo here — the other rows cover the descriptor gate
          }
          // `mkfifo` is an external binary whose syscalls no wrapper in this process sees. This
          // names the ONE entry it was asked to make, so teardown has a basis for removing that
          // entry alone.
          claimToolEntry(path.join(probeDir(), 'SKILL.md'));
          return true;
        },
        refusal: /not a regular file/i,
      },
      {
        what: 'a SKILL.md hard-linked to an outside file',
        plant: () => {
          fs.linkSync(path.join(external, 'stolen', 'SKILL.md'), path.join(probeDir(), 'SKILL.md'));
          return true;
        },
        refusal: /hard link/i,
      },
      {
        what: 'an oversize SKILL.md',
        plant: () => {
          fs.writeFileSync(path.join(probeDir(), 'SKILL.md'), `${SECRET}\n`.repeat(9000), {
            mode: 0o600,
          });
          return true;
        },
        refusal: /cap/i,
      },
      {
        what: 'a STICKY world-writable HOME (any peer could have planted the whole subtree)',
        plant: () => {
          fs.writeFileSync(
            path.join(probeDir(), 'SKILL.md'),
            `---\nname: outside-skill\ndescription: ${SECRET}\n---\n\n${SECRET}\n`,
            { mode: 0o600 },
          );
          fs.chmodSync(home.home, 0o1777);
          return true;
        },
        refusal: /writable/i,
      },
    ];

    for (const row of rows) {
      it(`skill_list and skill_get refuse ${row.what}; the outside tree is untouched`, async () => {
        if (!row.plant()) {
          return;
        }
        const before = snapshotWithModes(external);

        await withMcp(async (call) => {
          const list = await call('skill_list', {});
          expect(list).not.toContain(SECRET);
          expect(list).not.toContain('No skills installed.');
          expect(list).toMatch(row.refusal);

          const get = await call('skill_get', { name: 'outside-skill' });
          expect(get).not.toContain(SECRET);
          expect(get).toMatch(row.refusal);
        });

        expect(snapshotWithModes(external)).toEqual(before);
      }, 20_000);
    }

    // A refusal is a TOOL RESULT, so it passes the egress mask like every other byte this server
    // emits. Thrown out of the handler instead, it would leave as a protocol error the mask never
    // sees — and these messages quote the planted ENTRY NAME, which is attacker-chosen text on
    // exactly the shared-home machines this subtree is hardened against.
    it('refusals leave as MASKED tool results, never as unmasked protocol errors', async () => {
      const planted = home.path('skills', `stolen-${SECRET}`);
      fs.mkdirSync(planted, { recursive: true, mode: 0o700 });
      fs.symlinkSync(path.join(external, 'stolen', 'SKILL.md'), path.join(planted, 'SKILL.md'));

      await withMcp(
        async (call) => {
          for (const result of [
            await call('skill_list', {}),
            await call('skill_get', { name: 'outside-skill' }),
          ]) {
            expect(result).toMatch(/"isError":true/); // a tool result, not a rejected call
            expect(result).toContain('[REDACTED]');
            expect(result).not.toContain(SECRET);
          }
        },
        { mask: (s) => s.replaceAll(SECRET, '[REDACTED]') },
      );
    });

    it('the healthy path still serves real skills over MCP', async () => {
      ensureSkillsDir();
      await withMcp(async (call) => {
        const list = await call('skill_list', {});
        expect(list).toContain('using-sthayi-memory');
        const get = await call('skill_get', { name: 'using-sthayi-memory' });
        expect(get).toContain('Using Sthayi memory');
      });
    });
  },
);
