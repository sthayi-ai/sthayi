import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SqliteDriver } from '../../packages/cli/src/drivers/sqlite.js';
import { ensureBuiltCli } from '../helpers/build-cli.js';
import { snapshotTree } from '../helpers/fake-home.js';
import { removeOwned } from '../helpers/owned-fs.js';
import { runTempDir } from '../helpers/run-temp.js';

/**
 * SAFETY: every invalid `consolidate` invocation is rejected BEFORE the store opens —
 * exit 1, stderr names the offending flag, and ZERO state changes: a fresh machine must not even
 * gain a ~/.sthayi directory, and an initialized store's journal and memories are bit-identical
 * after the failed run.
 *
 * Requires `pnpm build` (same as keyless-matrix / multi-process-writes).
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const distEntry = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');

/** Same scrub idea as keyless-matrix: no real keys/tokens may reach these spawns. */
const SCRUB_PATTERN = /API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|BASE_URL/i;

function cleanEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (SCRUB_PATTERN.test(k) || k.startsWith('STHAYI_')) {
      continue;
    }
    env[k] = v;
  }
  env.STHAYI_HOME = home;
  return { ...env, ...extra };
}

interface InvalidCase {
  name: string;
  args: string[];
  /** stderr must name the offending flag / missing configuration */
  stderrMatch: RegExp;
  /** extra env for the spawn (e.g. a fake key so validation proceeds past the key check) */
  env?: Record<string, string>;
}

/** Synthetic key + UNREACHABLE loopback base URL: the exact hostile setup of the original repro
 *  — a spec whose only defect is its contents must fail at validation, never at request time
 *  (where the deterministic pass would already have mutated the store). Loopback http is the one
 *  cleartext form safeBaseUrl allows, and port 9 (discard) is never listening. */
const HOSTILE_ENV = {
  OPENAI_API_KEY: 'sthayi-test-not-a-real-key',
  OPENAI_BASE_URL: 'http://127.0.0.1:9',
};

const INVALID: InvalidCase[] = [
  {
    name: '--oracle without --provider',
    args: ['consolidate', '--oracle'],
    stderrMatch: /--provider/,
  },
  {
    // Hostile repro: `--provider openai:` (empty model) with a synthetic key and a loopback base
    // URL. Absent the pre-store check this combination runs the deterministic pass (archiving a
    // dupe), journals a consolidate_rejected, and exits 0. It must exit 1 naming the model
    // requirement, pre-store.
    name: '--oracle with an EMPTY model (openai:) under a synthetic key + loopback base URL',
    args: ['consolidate', '--oracle', '--provider', 'openai:'],
    stderrMatch: /missing a model.*model must be non-empty/,
    env: HOSTILE_ENV,
  },
  {
    name: '--oracle bare provider, no colon (openai) under the same hostile env',
    args: ['consolidate', '--oracle', '--provider', 'openai'],
    stderrMatch: /provider spec must be "provider:model"/,
    env: HOSTILE_ENV,
  },
  {
    name: '--oracle with an empty provider (:model) under the same hostile env',
    args: ['consolidate', '--oracle', '--provider', ':model'],
    stderrMatch: /unknown provider ""/,
    env: HOSTILE_ENV,
  },
  {
    name: '--oracle with an unknown provider (bogus:model) under the same hostile env',
    args: ['consolidate', '--oracle', '--provider', 'bogus:model'],
    stderrMatch: /unknown provider "bogus"/,
    env: HOSTILE_ENV,
  },
  {
    name: '--oracle with a malformed provider spec (no colon)',
    args: ['consolidate', '--oracle', '--provider', 'nonsense'],
    stderrMatch: /provider spec must be "provider:model"/,
  },
  {
    name: '--oracle with an unknown provider',
    args: ['consolidate', '--oracle', '--provider', 'wat:model-x'],
    stderrMatch: /provider/,
  },
  {
    name: '--oracle with a valid spec but no env key',
    args: ['consolidate', '--oracle', '--provider', 'anthropic:claude-sonnet-4-5'],
    stderrMatch: /ANTHROPIC_API_KEY is not set/,
  },
  {
    name: '--oracle with a bad --prompt op',
    args: [
      'consolidate',
      '--oracle',
      '--provider',
      'anthropic:claude-sonnet-4-5',
      '--prompt',
      '../../evil',
    ],
    stderrMatch: /unknown oracle prompt/,
    env: { ANTHROPIC_API_KEY: 'sthayi-test-not-a-real-key' },
  },
  {
    name: '--limit zero',
    args: ['consolidate', '--limit', '0'],
    stderrMatch: /--limit/,
  },
  {
    name: '--limit non-numeric',
    args: ['consolidate', '--limit', 'abc'],
    stderrMatch: /--limit/,
  },
  {
    name: '--limit negative',
    args: ['consolidate', '--limit', '-3'],
    stderrMatch: /--limit/,
  },
  {
    name: '--type outside the enum (never silently coerced)',
    args: ['consolidate', '--type', 'bogus'],
    stderrMatch: /--type must be episodic \| semantic \| procedural/,
  },
  // Oracle-only flags WITHOUT --oracle: rejected (never silently ignored), naming the flag.
  {
    name: '--provider without --oracle',
    args: ['consolidate', '--provider', 'anthropic:claude-sonnet-4-5'],
    stderrMatch: /--provider requires --oracle/,
  },
  {
    name: '--prompt without --oracle',
    args: ['consolidate', '--prompt', 'distill'],
    stderrMatch: /--prompt requires --oracle/,
  },
  {
    name: '--limit (valid value) without --oracle',
    args: ['consolidate', '--limit', '5'],
    stderrMatch: /--limit requires --oracle/,
  },
  {
    name: '--type (valid value) without --oracle',
    args: ['consolidate', '--type', 'semantic'],
    stderrMatch: /--type requires --oracle/,
  },
];

describe('safety: consolidate validates everything before opening the store (built CLI)', () => {
  let base: string;

  beforeAll(() => {
    ensureBuiltCli(); // shared build-once lock — never race another file's rebuild of dist
  }, 300_000);

  beforeEach(() => {
    expect(fs.existsSync(distEntry), `missing ${distEntry} — run \`pnpm build\` first`).toBe(true);
    // realpath: os.tmpdir() is reached through /var -> private/var on macOS, and every home
    // below is derived from `base` — a STHAYI_HOME reached through a symlink is refused.
    base = runTempDir('sthayi-precheck-');
  });

  afterEach(() => {
    removeOwned(base);
  });

  function run(home: string, args: string[], extra?: Record<string, string>) {
    const r = spawnSync(process.execPath, [distEntry, ...args], {
      env: cleanEnv(home, extra),
      cwd: base,
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }

  for (const c of INVALID) {
    it(`${c.name}: exit 1, actionable stderr, and NO ~/.sthayi created on a fresh machine`, () => {
      const home = path.join(base, 'never-created');
      const r = run(home, c.args, c.env);
      const label = `--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`;
      expect(r.status, label).toBe(1);
      expect(r.stderr, label).toMatch(c.stderrMatch);
      // The failure mode being excluded: the deterministic pass running (and mutating) before
      // validation.
      expect(r.stdout, label).not.toMatch(/Deterministic:/);
      expect(fs.existsSync(home), 'a failed validation must not create the store').toBe(false);
    });
  }

  it('on an initialized store: a failed invocation changes NOTHING (journal, memories, bytes)', () => {
    const home = path.join(base, 'seeded');
    // Seed an exact duplicate — the bait an unchecked run would archive before failing.
    expect(run(home, ['add', '--confirm', 'duplicate', 'fact']).status).toBe(0);
    expect(run(home, ['add', '--confirm', 'duplicate', 'fact']).status).toBe(0);

    // counts FIRST (the read-write inspection connection creates transient WAL sidecars that
    // vanish on close), THEN the byte snapshot the failed runs must preserve
    const countsBefore = (() => {
      const d = SqliteDriver.open(path.join(home, 'sthayi.db'));
      try {
        return { memories: d.countMemories(), journal: d.allJournal().length };
      } finally {
        d.close();
      }
    })();
    const before = snapshotTree(home);

    for (const c of INVALID) {
      const r = run(home, c.args, c.env);
      expect(r.status, `${c.name}\n${r.stderr}`).toBe(1);
    }

    expect(snapshotTree(home)).toEqual(before);
    const d = SqliteDriver.open(path.join(home, 'sthayi.db'));
    try {
      expect(d.countMemories()).toBe(countsBefore.memories);
      expect(d.allJournal().length).toBe(countsBefore.journal);
      // both duplicates still present — nothing was archived by the failed runs
      expect(d.countMemories({ status: 'confirmed' })).toBe(2);
    } finally {
      d.close();
    }
  }, 30_000);
});
