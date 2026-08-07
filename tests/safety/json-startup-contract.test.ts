import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildProgram } from '../../packages/cli/src/index.js';
import { PII_REMASK_META_KEY } from '../../packages/cli/src/store.js';
import { ensureBuiltCli } from '../helpers/build-cli.js';
import { removeOwned } from '../helpers/owned-fs.js';
import { runTempDir } from '../helpers/run-temp.js';

/**
 * SAFETY: a `--json` front door emits EXACTLY ONE parseable document, including when it never ran.
 *
 * THE HAZARD. Opening the store is not read-only — the first-run seal and the legacy-PII migration
 * are journaled writes that run because the store was OPENED — so a `--json` invocation can be over
 * before its own work begins: the startup mutation COMMITS, the off-database anchor does not
 * follow, the store stops accepting writes, and the command is refused. That refusal is a report
 * every human surface prints as prose. Printed on stdout beside a machine payload it is not a
 * warning at all: the consumer pipes the stream into a parser, the parser dies on the first word,
 * and the caller learns nothing — not the refusal, not the exit code's meaning, not the hits. The
 * failure mode is worse than silence, because a script that catches the parse error reports "sthayi
 * search is broken" about a store that is durable, blocked, and repairable in one command.
 *
 * THE INVARIANT. `search --json` writes ONE JSON document to stdout on every path. When startup
 * blocked the command, the document IS the report: `ran: false`, no `hits` member to be misread as
 * "no matches", and the committed / do-not-retry / writes-blocked facts as FIELDS rather than
 * sentences — at the same exit code 3 the prose surfaces use.
 *
 * Parsing the WHOLE of stdout is itself the exactly-one-document proof: a second document, or one
 * line of prose on either side of the payload, leaves trailing input that `JSON.parse` refuses.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const distEntry = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');

/** The exit code reserved for committed-but-unanchored (packages/cli/src/index.ts). */
const EXIT_COMMITTED_UNANCHORED = 3;

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(home: string, args: string[]): RunResult {
  const env: NodeJS.ProcessEnv = { ...process.env, STHAYI_HOME: home, HOME: home };
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

/**
 * Turn a healthy store into what a LEGACY unmasked build left behind: plaintext PII in a memory
 * row, and the migration marker cleared. The next open remasks the row and journals it — the
 * second startup mutation that can commit while the anchor does not advance.
 */
function makeLegacy(home: string): void {
  const db = new Database(path.join(home, 'sthayi.db'));
  try {
    const row = db.prepare('SELECT id FROM memories LIMIT 1').get() as { id: string };
    db.prepare('UPDATE memories SET content = ? WHERE id = ?').run(
      'email me at legacy.pii@example-leak.io about the launch',
      row.id,
    );
    db.prepare('DELETE FROM meta WHERE k = ?').run(PII_REMASK_META_KEY);
  } finally {
    db.close();
  }
}

interface BlockedDoc {
  ran: false;
  hits?: unknown;
  startup: {
    step: string;
    state: string;
    committed: boolean;
    doNotRetry: boolean;
    writesBlocked: boolean;
    journalId?: number;
    anchor?: string;
    message: string;
    repair: string;
  }[];
}

/**
 * Parse the ENTIRE stdout as one JSON document. `JSON.parse` rejects trailing input, so this fails
 * on a second document and on any prose printed before or after the payload — which is exactly the
 * contract under test, asserted by the same call a real consumer makes.
 */
function oneDocument(stdout: string): unknown {
  return JSON.parse(stdout);
}

/** Every fact the prose report states, read as STRUCTURE. */
function expectBlockedFacts(doc: BlockedDoc, step: string, label: string): void {
  expect(doc.ran, label).toBe(false);
  // no `hits` at all: an empty array here reads as "no matches" about a search that never ran
  expect(Object.hasOwn(doc, 'hits'), label).toBe(false);
  expect(doc.startup, label).toHaveLength(1);
  const s = doc.startup[0];
  expect(s?.step, label).toBe(step);
  expect(s?.state, label).toBe('committed-unanchored');
  expect(s?.committed, label).toBe(true);
  expect(s?.doNotRetry, label).toBe(true);
  expect(s?.writesBlocked, label).toBe(true);
  expect(s?.message, label).toMatch(/DEGRADED/);
  expect(s?.message, label).toMatch(/DO NOT RETRY/);
  expect(s?.repair, label).toMatch(/journal reseal/);
}

describe('safety: `search --json` is ONE document even when startup refused the command', () => {
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

  function freshHome(prefix: string): string {
    const home = runTempDir(prefix);
    homes.push(home);
    return home;
  }

  it('first-run seal committed unanchored: stdout parses, and the refusal IS the document', () => {
    const home = freshHome('sthayi-json-seal-');
    jam(home); // jammed BEFORE the store has ever been opened — the genuine first-run case

    const r = runCli(home, ['search', '--json', 'anything']);
    const label = `${r.stdout}\n---\n${r.stderr}`;
    expect(r.status, label).toBe(EXIT_COMMITTED_UNANCHORED);
    const doc = oneDocument(r.stdout) as BlockedDoc;
    expectBlockedFacts(doc, 'first-run-seal', label);
    expect(doc.startup[0]?.message, label).toMatch(/first-run initialization COMMITTED/);
    // NOTHING beside the payload — the prose report belongs to the human surfaces
    expect(r.stdout.trimStart().startsWith('{'), label).toBe(true);
    expect(r.stdout, label).not.toMatch(/This command did NOT run/);

    // …and the seal's database half really is durable, so the document reports rather than guesses
    const db = new Database(path.join(home, 'sthayi.db'), { readonly: true });
    try {
      const seals = db
        .prepare("SELECT count(*) AS c FROM journal WHERE op = 'journal_seal'")
        .get() as { c: number };
      expect(seals.c, label).toBe(1);
    } finally {
      db.close();
    }
    expect(fs.existsSync(path.join(home, 'journal.checkpoint')), label).toBe(false);
  });

  it('PII migration committed unanchored: one document, carrying the entry id and the anchor', () => {
    const home = freshHome('sthayi-json-mig-');
    expect(runCli(home, ['add', 'a searchable placeholder fact']).status).toBe(0);
    makeLegacy(home);
    jam(home);

    const r = runCli(home, ['search', '--json', 'launch']);
    const label = `${r.stdout}\n---\n${r.stderr}`;
    expect(r.status, label).toBe(EXIT_COMMITTED_UNANCHORED);
    const doc = oneDocument(r.stdout) as BlockedDoc;
    expectBlockedFacts(doc, 'pii-migration', label);
    // the migration appends a journal entry, so its receipt's facts travel too
    expect(doc.startup[0]?.journalId, label).toBeTypeOf('number');
    expect(doc.startup[0]?.anchor, label).toBe('unanchored');
    expect(r.stdout, label).not.toMatch(/This command did NOT run/);

    // the remask really committed — this is the durable-but-unanchored state, not a refusal
    const db = new Database(path.join(home, 'sthayi.db'), { readonly: true });
    try {
      const events = db
        .prepare("SELECT count(*) AS c FROM journal WHERE op = 'migrate_masking'")
        .get() as { c: number };
      expect(events.c, label).toBe(1);
    } finally {
      db.close();
    }
  }, 15_000);

  it('CONTROL: a healthy store is still ONE document — ran, no blockers, hits and mutation', () => {
    const home = freshHome('sthayi-json-ok-');
    expect(runCli(home, ['add', 'a searchable durable fact']).status).toBe(0);
    const r = runCli(home, ['search', '--json', 'searchable']);
    const label = `${r.stdout}\n---\n${r.stderr}`;
    expect(r.status, label).toBe(0);
    const doc = oneDocument(r.stdout) as {
      ran: boolean;
      startup: unknown[];
      hits: { memory: { content: string } }[];
      mutation: { state: string; anchor: string };
    };
    expect(doc.ran, label).toBe(true);
    expect(doc.startup, label).toEqual([]);
    expect(doc.hits, label).toHaveLength(1);
    expect(doc.hits[0]?.memory.content, label).toBe('a searchable durable fact');
    expect(doc.mutation.state, label).toBe('committed');
    expect(doc.mutation.anchor, label).toBe('anchored');
  }, 15_000);

  it('the human-readable search is UNCHANGED — the prose report is still prose, at exit 3', () => {
    // The gate settles once and each mode renders it; a `--json` fix that quietly turned the
    // default surface into JSON would break every human reader and every existing script.
    const home = freshHome('sthayi-json-prose-');
    jam(home);
    const r = runCli(home, ['search', 'anything']);
    const label = `${r.stdout}\n---\n${r.stderr}`;
    expect(r.status, label).toBe(EXIT_COMMITTED_UNANCHORED);
    expect(r.stdout, label).toMatch(/DEGRADED/);
    expect(r.stdout, label).toMatch(/This command did NOT run/);
    expect(() => JSON.parse(r.stdout)).toThrow();
  });
});

describe('safety: every `--json` surface is one that renders the startup gate structurally', () => {
  /**
   * A CENSUS, not a formality. The one-document contract is a property of each `--json` surface
   * individually: a new one that opens the store through the prose gate inherits the exact defect
   * these tests pin — the startup report lands on stdout ahead of its payload and the stream stops
   * being parseable. Adding `--json` anywhere therefore has to come here, and the failure message
   * says what the new surface owes its callers.
   */
  it('`search` is the only command declaring --json', () => {
    const withJson = buildProgram()
      .commands.filter((c) => c.options.some((o) => o.long === '--json'))
      .map((c) => c.name())
      .sort();
    expect(
      withJson,
      'a new --json surface must emit EXACTLY ONE parseable document on every path, including when a startup mutation committed unanchored and the command never ran (settleCliStore + the `ran: false` envelope in packages/cli/src/index.ts) — then add it here',
    ).toEqual(['search']);
  });
});
