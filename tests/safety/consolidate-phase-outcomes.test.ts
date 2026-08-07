import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { distEntry, ensureBuiltCli } from '../helpers/build-cli.js';
import { removeOwned } from '../helpers/owned-fs.js';
import { runTempDir } from '../helpers/run-temp.js';

/**
 * SAFETY: `consolidate` runs TWO phases against the same store, and the first one's outcome cannot
 * wait for the second one to finish.
 *
 * THE HAZARD. The deterministic pass is always-on and it is a durable commit of its own: it
 * archives duplicates and journals a `consolidate` entry. The Oracle pass is a SEPARATE, optional
 * set of writes that follows it. Reading both phases' outcomes only at the end means a
 * deterministic pass that COMMITTED while the off-database anchor did not advance is announced
 * with its ordinary success line, and then the Oracle pass runs into the store it just blocked —
 * whose refusal (or the provider's own failure) surfaces as a generic `consolidate failed` at
 * exit 1. The caller is told the run failed, over changes that are archived and durable, and is
 * told nothing about the anchor: a refusal invites a re-run, and re-running applies the durable
 * changes a second time.
 *
 * THE INVARIANT. The deterministic phase's outcome is inspected THE MOMENT it lands — before its
 * ordinary line is printed and before a single Oracle byte leaves the machine. A degraded
 * deterministic phase reports what it actually archived, states that the Oracle pass was not
 * started, and exits with the code reserved for durable-but-unanchored (3), never 0 and never 1.
 *
 * The built CLI, real SQLite, a real FileCheckpoint, and the honest degraded state: a DIRECTORY at
 * `journal.checkpoint.lock`, which no O_CREAT|O_EXCL lock can ever take.
 */

/** The exit code reserved for committed-but-unanchored (packages/cli/src/index.ts). */
const EXIT_COMMITTED_UNANCHORED = 3;

/**
 * An oracle provider that is reachable in shape and unreachable in fact: the spec and the env key
 * validate (so the run gets past the pre-store checks and actually starts the Oracle phase), and
 * the request itself cannot connect. Port 1 on loopback is the cheapest honest connection refusal,
 * and loopback http is the one non-https base URL the provider layer accepts.
 */
const DEAD_PROVIDER_ENV = {
  ANTHROPIC_API_KEY: 'test-key-not-used',
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:1/',
};
const ORACLE_ARGS = ['consolidate', '--oracle', '--provider', 'anthropic:claude-sonnet-4-5'];
const CONSOLIDATE_PHASE_OUTCOME_TIMEOUT = process.platform === 'win32' ? 20_000 : 5_000;

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(home: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): RunResult {
  const env: NodeJS.ProcessEnv = { ...process.env, STHAYI_HOME: home, HOME: home, ...extraEnv };
  const r = spawnSync(process.execPath, [distEntry, ...args], {
    env,
    cwd: home,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Jam every checkpoint replacement in `home`, permanently and deterministically. */
function jam(home: string): void {
  fs.mkdirSync(path.join(home, 'journal.checkpoint.lock'), { recursive: true });
}

/** All three facts a durable-but-unanchored report must state, in words a human and a script act on. */
function expectDegradedText(text: string, label: string): void {
  expect(text, label).toMatch(/DEGRADED/);
  expect(text, label).toMatch(/COMMITTED/);
  expect(text, label).toMatch(/DO NOT RETRY/);
  expect(text, label).toMatch(/Further writes are BLOCKED/);
  expect(text, label).toMatch(/journal reseal/);
}

/** What the store actually holds, as counts a report can be checked against. */
function storeFacts(home: string): { archived: number; ops: string[] } {
  const db = new Database(path.join(home, 'sthayi.db'), { readonly: true });
  try {
    const archived = db
      .prepare("SELECT count(*) AS c FROM memories WHERE status = 'archived'")
      .get() as { c: number };
    const ops = db.prepare('SELECT op FROM journal ORDER BY id').all() as { op: string }[];
    return { archived: archived.c, ops: ops.map((r) => r.op) };
  } finally {
    db.close();
  }
}

describe('safety: consolidate settles its deterministic phase before it starts the Oracle one', () => {
  const homes: string[] = [];
  beforeAll(() => {
    ensureBuiltCli();
  }, 300_000);
  afterEach(() => {
    for (const h of homes.splice(0)) {
      removeOwned(path.join(h, 'journal.checkpoint.lock'));
      removeOwned(h);
    }
  });

  /** A store holding exactly one exact-duplicate pair, healthy and anchored. */
  function seededHome(prefix: string): string {
    const home = runTempDir(prefix);
    homes.push(home);
    for (let i = 0; i < 2; i++) {
      const r = runCli(home, ['add', '--confirm', 'the exact same duplicated fact']);
      expect(r.status, `${r.stdout}\n---\n${r.stderr}`).toBe(0);
    }
    return home;
  }

  it(
    'a DEGRADED deterministic phase exits 3, states what it archived, and never starts the Oracle pass',
    () => {
      const home = seededHome('sthayi-consolidate-det-');
      jam(home);

      const r = runCli(home, ORACLE_ARGS, DEAD_PROVIDER_ENV);
      const label = `${r.stdout}\n---\n${r.stderr}`;

      // NOT 1: a refusal invites a re-run, and the archive is already durable. NOT 0 either.
      expect(r.status, label).toBe(EXIT_COMMITTED_UNANCHORED);
      expectDegradedText(r.stdout, label);
      expect(r.stdout, label).toMatch(/Do NOT re-run this command/);
      // the EXACT deterministic progress, not a bare "something committed"
      expect(r.stdout, label).toMatch(/1 exact dupes, 0 near-dupes, 0 decayed → 1 archived/);
      // the ordinary success line is NOT printed
      expect(r.stdout, label).not.toMatch(/^Deterministic: /m);
      // the Oracle phase is named as NOT STARTED, and it left no trace
      expect(r.stdout, label).toMatch(/Oracle pass was NOT started/);
      expect(r.stdout, label).not.toMatch(/batches applied/);
      expect(r.stderr, label).not.toMatch(/consolidate failed/);
      expect(r.stderr, label).not.toMatch(/consolidate stopped after committed work/);

      // The store agrees: the deterministic archive is durable, and nothing the Oracle phase would
      // have written exists — no rejection entry, no second consolidate entry.
      const facts = storeFacts(home);
      expect(facts.archived, label).toBe(1);
      expect(
        facts.ops.filter((op) => op === 'consolidate'),
        label,
      ).toHaveLength(1);
      expect(
        facts.ops.filter((op) => op === 'consolidate_rejected'),
        label,
      ).toHaveLength(0);
    },
    CONSOLIDATE_PHASE_OUTCOME_TIMEOUT,
  );

  it(
    'the same degraded deterministic phase is reported with NO oracle requested at all',
    () => {
      const home = seededHome('sthayi-consolidate-detonly-');
      jam(home);

      const r = runCli(home, ['consolidate']);
      const label = `${r.stdout}\n---\n${r.stderr}`;
      expect(r.status, label).toBe(EXIT_COMMITTED_UNANCHORED);
      expectDegradedText(r.stdout, label);
      expect(r.stdout, label).toMatch(/1 exact dupes, 0 near-dupes, 0 decayed → 1 archived/);
      expect(r.stdout, label).not.toMatch(/^Deterministic: /m);
      // nothing to say about a pass that was never requested
      expect(r.stdout, label).not.toMatch(/Oracle/);
      expect(storeFacts(home).archived, label).toBe(1);
    },
    CONSOLIDATE_PHASE_OUTCOME_TIMEOUT,
  );

  it(
    'CONTROL: a healthy anchor prints the ordinary line, runs the Oracle pass, and exits 0',
    () => {
      const home = seededHome('sthayi-consolidate-ok-');

      const r = runCli(home, ORACLE_ARGS, DEAD_PROVIDER_ENV);
      const label = `${r.stdout}\n---\n${r.stderr}`;
      expect(r.status, label).toBe(0);
      expect(r.stdout, label).toMatch(/^Deterministic: 1 exact dupes, .* → 1 archived\.$/m);
      expect(r.stdout, label).not.toMatch(/DEGRADED/);
      // the Oracle phase DID start — the provider failure is journaled as a rejected batch
      expect(r.stdout, label).toMatch(/batches applied/);
      const facts = storeFacts(home);
      expect(facts.archived, label).toBe(1);
      expect(
        facts.ops.filter((op) => op === 'consolidate_rejected'),
        label,
      ).toHaveLength(1);
    },
    CONSOLIDATE_PHASE_OUTCOME_TIMEOUT,
  );

  it(
    'CONTROL: a jam with NOTHING for the deterministic phase to do leaves the Oracle pass reachable',
    () => {
      // Nothing is archived, so nothing commits, so the deterministic phase has no outcome to
      // report — the gate must not fire on a pass that wrote nothing.
      const home = runTempDir('sthayi-consolidate-noop-');
      homes.push(home);
      expect(runCli(home, ['add', '--confirm', 'a single unduplicated fact']).status).toBe(0);
      jam(home);

      const r = runCli(home, ORACLE_ARGS, DEAD_PROVIDER_ENV);
      const label = `${r.stdout}\n---\n${r.stderr}`;
      expect(r.stdout, label).toMatch(/^Deterministic: 0 exact dupes, .* → 0 archived\.$/m);
      expect(r.stdout, label).not.toMatch(/Oracle pass was NOT started/);
      expect(storeFacts(home).archived, label).toBe(0);
    },
    CONSOLIDATE_PHASE_OUTCOME_TIMEOUT,
  );
});
