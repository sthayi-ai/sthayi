import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMMANDS, VERSION } from '../../packages/cli/src/index.js';
import { ensureBuiltCli } from '../helpers/build-cli.js';
import { snapshotTree } from '../helpers/fake-home.js';
import { removeOwned } from '../helpers/owned-fs.js';
import { runTempDir } from '../helpers/run-temp.js';

/**
 * SAFETY: the keyless matrix (RELEASE.md anti-friction gate). Spec §1 invariant 1: every command except
 * `consolidate --oracle` / `qualify` must work with zero config and zero API keys. This spawns the
 * BUILT CLI (`packages/cli/dist/index.js` — the exact artifact npm ships) across the whole command
 * surface with a scrubbed environment and a throwaway STHAYI_HOME, and asserts:
 *   - every keyless command reaches its domain outcome (no "X is not set" failures),
 *   - the two documented oracle exceptions fail FAST with an actionable env-var error,
 *   - the matrix covers every registered command (adding a command breaks this test until
 *     a matrix entry exists for it).
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliDir = path.join(repoRoot, 'packages', 'cli');
const distEntry = path.join(cliDir, 'dist', 'index.js');
const importFixture = path.join(repoRoot, 'tests', 'fixtures', 'imports', 'claude');

/** Same synthetic shape as tests/safety/vault-secrets.test.ts — never a real key. */
const CANARY_KEY = 'sk-proj-CANARYaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/** Env vars that must never leak into the matrix (keys, tokens, oracle redirects, sthayi config). */
const SCRUB_PATTERN = /API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|BASE_URL/i;

/** Home-locating env vars replaced wholesale: the matrix must be HERMETIC — it must never read
 *  (or, via a bug, write) the developer's real client configs, Downloads, or ~/.sthayi. */
const HOME_VARS = new Set(['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME']);

function scrubbedEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (SCRUB_PATTERN.test(k) || k.startsWith('STHAYI_') || HOME_VARS.has(k)) {
      continue;
    }
    env[k] = v;
  }
  env.STHAYI_HOME = home;
  env.HOME = home;
  env.USERPROFILE = home;
  env.APPDATA = path.join(home, 'AppData', 'Roaming');
  env.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
  return env;
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  all: string;
}

let home: string;
let env: NodeJS.ProcessEnv;

function runCli(args: string[]): RunResult {
  const r = spawnSync(process.execPath, [distEntry, ...args], {
    env,
    cwd: home, // neutral cwd — the CLI must not depend on running from the repo
    encoding: 'utf8',
    timeout: 60_000,
  });
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  return { status: r.status, stdout, stderr, all: stdout + stderr };
}

function expectKeyless(args: string[], expectOut?: RegExp, expectExit = 0): RunResult {
  const r = runCli(args);
  const label = `sthayi ${args.join(' ')}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`;
  expect(r.status, label).toBe(expectExit);
  // The keyless invariant: no command may fail (or complain) for a missing env var.
  expect(r.all, label).not.toMatch(/is not set/);
  if (expectOut) {
    expect(r.all, label).toMatch(expectOut);
  }
  return r;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Self-enforcement ledger: command → the matrix invocation that proves it keyless. */
const COVERED_BY: Record<string, string> = {
  init: 'init --dry-run',
  serve: 'spawn + stays-alive probe',
  wire: 'wire --dry-run',
  unwire: 'unwire --dry-run',
  status: 'status',
  add: 'add (proposal, confirmed, and canary-secret variants)',
  search: 'search duplicate fact',
  review: 'review',
  import: 'import <claude fixture dir>',
  consolidate: 'consolidate (deterministic) + --oracle actionable-failure exception',
  pack: 'pack',
  entities: 'entities',
  journal: 'journal -n 50 / journal --verify',
  index: 'index status + index rebuild (graph re-derived from the journal)',
  rollback: 'rollback <consolidate batch id>',
  qualify: 'qualify actionable-failure exception (documented key-requiring command)',
  doctor: 'doctor',
};

describe('safety: keyless command matrix (built CLI, scrubbed env)', () => {
  beforeAll(() => {
    // Shared build-once lock: other safety files spawn the same dist concurrently, and a rebuild
    // racing those spawns produces bogus failures (half-written chunks). See helpers/build-cli.
    ensureBuiltCli();
    if (!fs.existsSync(distEntry)) {
      throw new Error(`build produced no ${distEntry}`);
    }
    // realpath: os.tmpdir() is reached through /var -> private/var on macOS, and a STHAYI_HOME
    // reached through any symlink is refused — homes are named by their canonical real path.
    home = runTempDir('sthayi-keyless-');
    env = scrubbedEnv(home);
  }, 300_000);

  afterAll(() => {
    if (home) {
      removeOwned(home);
    }
  });

  it('covers every registered CLI command', () => {
    for (const c of COMMANDS) {
      expect(
        COVERED_BY[c.name],
        `no keyless-matrix entry for "sthayi ${c.name}" — add one to COVERED_BY + the matrix`,
      ).toBeTruthy();
    }
    for (const name of Object.keys(COVERED_BY)) {
      expect(
        COMMANDS.some((c) => c.name === name),
        `COVERED_BY lists unknown command "${name}"`,
      ).toBe(true);
    }
  });

  it('scrubs every key-ish env var from the spawn environment', () => {
    const saved = { ...process.env };
    process.env.ANTHROPIC_API_KEY = 'x';
    process.env.OPENAI_API_KEY = 'x';
    process.env.GEMINI_API_KEY = 'x';
    process.env.GOOGLE_API_KEY = 'x';
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1';
    process.env.STHAYI_PROMPTS_DIR = '/nope';
    try {
      const e = scrubbedEnv('/tmp/x');
      for (const k of Object.keys(e)) {
        expect(SCRUB_PATTERN.test(k), `scrubbed env still contains ${k}`).toBe(false);
      }
      expect(e.STHAYI_PROMPTS_DIR).toBeUndefined();
      expect(e.STHAYI_HOME).toBe('/tmp/x');
      // hermetic: the spawned CLI can never see the developer's real home or client configs
      expect(e.HOME).toBe('/tmp/x');
      expect(e.USERPROFILE).toBe('/tmp/x');
    } finally {
      process.env = saved;
    }
  });

  it('--version prints the package version', () => {
    const r = expectKeyless(['--version']);
    expect(r.stdout.trim()).toBe(VERSION);
  });

  it.skipIf(process.platform === 'win32')(
    '--version works through a bin-style symlink (how npm installs the CLI)',
    () => {
      // Why this case exists: node_modules/.bin/sthayi is a SYMLINK to dist/index.js, so argv[1] is the
      // link while import.meta.url is the realpath — the direct-run guard must compare realpaths
      // or every npm-installed invocation no-ops with exit 0 and no output.
      const link = path.join(home, 'sthayi-bin-link.js');
      fs.rmSync(link, { force: true });
      fs.symlinkSync(distEntry, link);
      const r = spawnSync(process.execPath, [link, '--version'], {
        env,
        cwd: home,
        encoding: 'utf8',
        timeout: 60_000,
      });
      const label = `--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`;
      expect(r.stdout.trim(), label).toBe(VERSION);
      expect(r.status, label).toBe(0);
    },
  );

  it('--help lists the whole command surface', () => {
    const r = expectKeyless(['--help']);
    for (const c of COMMANDS) {
      expect(r.stdout, `--help is missing "${c.name}"`).toContain(c.name);
    }
  });

  it('init --dry-run prints the plan and writes NOTHING — not even ~/.sthayi contents', () => {
    // Runs before any store-touching command: a true dry-run must leave the home exactly as it
    // found it — no db, no key, no launcher, no skills. Creating any of them while PRINTING a plan
    // is the failure this pins: the owner asked what WOULD happen, not for it to happen.
    const before = snapshotTree(home);
    const r = expectKeyless(['init', '--dry-run'], /Dry run — would initialize/);
    expect(r.all).toMatch(/create db/);
    expect(r.all).toMatch(/create launcher/);
    expect(snapshotTree(home)).toEqual(before);
    for (const entry of ['sthayi.db', 'key', 'bin', 'skills']) {
      expect(fs.existsSync(path.join(home, entry)), `dry-run created ${entry}`).toBe(false);
    }
  });

  it('add stores a proposal', () => {
    expectKeyless(['add', 'the', 'keyless', 'matrix', 'proposal'], /added proposed/);
  });

  it('add --confirm stores confirmed memories (twice, to seed an exact-dupe)', () => {
    expectKeyless(['add', '--confirm', 'duplicate', 'fact', 'for', 'rollback'], /added confirmed/);
    expectKeyless(['add', '--confirm', 'duplicate', 'fact', 'for', 'rollback'], /added confirmed/);
  });

  it('add masks a canary secret at write time — masking works keyless (spec §1 invariant 5)', () => {
    const r = expectKeyless(['add', '--confirm', 'ci', 'canary', CANARY_KEY], /added confirmed/);
    expect(r.all).not.toContain(CANARY_KEY);
  });

  it('search finds the confirmed memory', () => {
    expectKeyless(['search', 'duplicate', 'fact'], /duplicate/);
  });

  it('review lists the proposal queue', () => {
    expectKeyless(['review'], /proposal/);
  });

  it('import ingests a Claude export fixture', () => {
    expect(fs.existsSync(importFixture), `fixture missing: ${importFixture}`).toBe(true);
    expectKeyless(['import', importFixture], /Imported \d+ memor/);
  });

  it('consolidate (deterministic) archives the exact dupe — no oracle, no key', () => {
    expectKeyless(['consolidate'], /Deterministic: .*→ [1-9]\d* archived/);
  });

  let consolidateBatchId: number | undefined;

  it('journal lists entries and shows the consolidate batch', () => {
    const r = expectKeyless(['journal', '-n', '50'], /#\d+/);
    for (const line of r.stdout.split('\n')) {
      const m = /^#(\d+)\s/.exec(line);
      if (m?.[1] && line.trimEnd().endsWith(' consolidate')) {
        const id = Number.parseInt(m[1], 10);
        if (consolidateBatchId === undefined || id > consolidateBatchId) {
          consolidateBatchId = id;
        }
      }
    }
    expect(consolidateBatchId, `no consolidate batch in journal:\n${r.stdout}`).toBeDefined();
  });

  it('rollback reverts the consolidate batch via compensating entries', () => {
    expect(consolidateBatchId).toBeDefined();
    expectKeyless(
      ['rollback', String(consolidateBatchId)],
      /Rolled back #\d+: .*chain intact: true/,
    );
  });

  it('journal --verify: the chain survives consolidate + rollback', () => {
    expectKeyless(['journal', '--verify'], /journal OK/);
  });

  it('index status + rebuild: the association graph re-derives from the journal keyless', () => {
    expectKeyless(['index', 'status'], /association graph: \d+ edge\(s\), folded through journal/);
    expectKeyless(
      ['index', 'rebuild'],
      /association graph rebuilt from the journal: \d+ edge\(s\)/,
    );
  });

  it('pack exports a masked context.md under the fake home', () => {
    const r = expectKeyless(['pack'], /Wrote masked memory pack/);
    expect(r.all).not.toContain(CANARY_KEY);
  });

  it('entities lists the local pseudonym mapping (canary was vaulted)', () => {
    expectKeyless(['entities'], /APIKEY_01/);
  });

  it('status reports per-client wiring read-only', () => {
    expectKeyless(['status'], /client/);
  });

  it('wire --dry-run leaves the whole home byte-for-byte unchanged', () => {
    const before = snapshotTree(home);
    expectKeyless(['wire', '--dry-run'], /Dry run|No detected clients/);
    expect(snapshotTree(home)).toEqual(before);
  });

  it('unwire --dry-run leaves the whole home byte-for-byte unchanged', () => {
    const before = snapshotTree(home);
    expectKeyless(['unwire', '--dry-run'], /Dry run/);
    expect(snapshotTree(home)).toEqual(before);
  });

  it('doctor passes on the initialized fake home', () => {
    expectKeyless(['doctor'], /All checks passed\./);
  });

  it('serve: the stdio MCP server starts keyless and stays up', async () => {
    const child = spawn(process.execPath, [distEntry, 'serve'], {
      env,
      cwd: home,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdoutData = '';
    let stderrData = '';
    child.stdout.on('data', (d: Buffer) => {
      stdoutData += String(d);
    });
    child.stderr.on('data', (d: Buffer) => {
      stderrData += String(d);
    });
    const exited = new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code));
    });
    const first = await Promise.race([exited, delay(700).then(() => 'alive' as const)]);
    expect(
      first,
      `serve exited early\n--- stdout ---\n${stdoutData}\n--- stderr ---\n${stderrData}`,
    ).toBe('alive');
    // A stdio MCP server must stay silent on stdout until the client speaks (JSON-RPC channel).
    expect(stdoutData).toBe('');
    child.kill('SIGTERM');
    await Promise.race([exited, delay(3_000)]);
    if (child.exitCode === null) {
      child.kill('SIGKILL');
    }
  }, 15_000);

  it('consolidate --provider WITHOUT --oracle is rejected pre-store: exit 1, fresh home never created', () => {
    // Oracle-only flags must be rejected, not silently ignored — and the rejection happens
    // before openStore, so on a fresh machine not even ~/.sthayi appears.
    const freshHome = fs.realpathSync(runTempDir('sthayi-keyless-oracleflag-'));
    fs.rmSync(freshHome, { recursive: true, force: true }); // must NOT be recreated
    const r = spawnSync(
      process.execPath,
      [distEntry, 'consolidate', '--provider', 'anthropic:claude-sonnet-4-5'],
      { env: scrubbedEnv(freshHome), cwd: os.tmpdir(), encoding: 'utf8', timeout: 60_000 },
    );
    const label = `--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`;
    expect(r.status, label).toBe(1);
    expect(r.stderr, label).toMatch(/--provider/);
    expect(r.stderr, label).toMatch(/--oracle/);
    expect(r.stdout ?? '', label).not.toMatch(/Deterministic:/);
    expect(fs.existsSync(freshHome), 'rejected invocation must not create the home').toBe(false);
  });

  it('consolidate --oracle is the documented exception: fails FAST with the env var named', () => {
    const r = runCli(['consolidate', '--oracle', '--provider', 'anthropic:claude-sonnet-4-5']);
    const label = `--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`;
    expect(r.status, label).toBe(1);
    expect(r.all, label).toMatch(/ANTHROPIC_API_KEY is not set/);
  });

  it('qualify is the other documented exception: fails FAST with the env var named', () => {
    const r = runCli(['qualify', 'openai:gpt-5']);
    const label = `--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`;
    expect(r.status, label).toBe(1);
    expect(r.all, label).toMatch(/OPENAI_API_KEY is not set/);
  });
});
