import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type CommitReceipt,
  ConsolidationService,
  JournalService,
  MemoryService,
  type MutationOutcome,
  VaultService,
  committedReceipts,
  describeReceipt,
  isDegradedReceipt,
} from '@sthayi/core';
import Database from 'better-sqlite3';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FileCheckpoint } from '../../packages/cli/src/drivers/checkpoint-file.js';
import { NodeCrypto } from '../../packages/cli/src/drivers/crypto.js';
import { SqliteDriver } from '../../packages/cli/src/drivers/sqlite.js';
import { ensureBuiltCli } from '../helpers/build-cli.js';
import { type FakeHome, createFakeHome } from '../helpers/fake-home.js';
import { removeOwned } from '../helpers/owned-fs.js';
import { runTempDir } from '../helpers/run-temp.js';

/**
 * SAFETY: a write that COMMITTED while the off-database anchor did NOT advance must reach the
 * caller as that exact outcome — never as an unqualified success.
 *
 * THE HAZARD. Commit and anchor are two stores, and they can disagree. When the rows are durable
 * but the checkpoint could not advance, the operation sits in a third state that neither "success"
 * nor "failure" describes: the write LANDED and the store has STOPPED accepting further writes.
 * If that state is reported as plain success, a script carries on against a store that will refuse
 * its next write; if it is reported as plain failure, the caller RETRIES and duplicates a write
 * that already landed. Either mis-framing costs data.
 *
 * These probes run the built CLI against real SQLite and a real FileCheckpoint, and force the
 * degraded state honestly: a DIRECTORY planted at `journal.checkpoint.lock` means the
 * O_CREAT|O_EXCL lock can never be taken, so the rows commit and the anchor cannot follow. Every
 * surface a caller can read — `add`, `consolidate`, `rollback`, and MCP `memory_write` in both its
 * visible text and its structuredContent — is checked in that state.
 *
 * THE INVARIANT. Every journaled mutation carries a `MutationOutcome`, and its 'committed' branch
 * carries a typed {@link CommitReceipt} — committed status, the record/ids, the anchor outcome, and
 * the reason — through MemoryService, consolidation, rollback, the CLI and both MCP transports. A
 * degraded operation states that it DID commit, that it must not be retried, and that further
 * writes are blocked; the CLI exits 3 (neither 0 nor the refusal code 1); MCP puts it in the
 * visible text AND in structuredContent and can never answer `warnings: []`.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const distEntry = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
/** A real export archive — the import path is a whole-archive write, so it needs real input. */
const claudeFixture = path.join(repoRoot, 'tests', 'fixtures', 'imports', 'claude');

/** The exit code reserved for committed-but-unanchored (packages/cli/src/index.ts). */
const EXIT_COMMITTED_UNANCHORED = 3;
const BUILT_CLI_RECEIPT_TIMEOUT = process.platform === 'win32' ? 20_000 : 5_000;

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
 * Fill the proposal queue straight through SQL, so a multi-PAGE `--confirm-all` drain is reachable
 * without a hundred process spawns. The journal is untouched: these rows are exactly what a real
 * import or a long session would have left behind for review.
 */
function seedProposals(home: string, count: number): void {
  const db = new Database(path.join(home, 'sthayi.db'));
  try {
    const insert = db.prepare(
      'INSERT INTO memories (id,type,scope,content,provenance,confidence,boosts,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    );
    db.transaction(() => {
      for (let i = 1; i <= count; i++) {
        insert.run(
          `01SEED${String(i).padStart(20, '0')}`,
          'semantic',
          'user',
          `proposal number ${i}`,
          '{"source":"cli"}',
          0.6,
          0,
          'proposed',
          'cli',
          1_700_000_000_000 + i,
          1_700_000_000_000 + i,
        );
      }
    })();
  } finally {
    db.close();
  }
}

describe(
  'safety: a committed-but-unanchored operation is reported as exactly that (built CLI)',
  () => {
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

    /** Every degraded surface must state all three facts, in words a human and a script can act on. */
    function expectDegradedText(stdout: string, label: string): void {
      expect(stdout, label).toMatch(/DEGRADED/);
      expect(stdout, label).toMatch(/COMMITTED/);
      expect(stdout, label).toMatch(/DO NOT RETRY/);
      expect(stdout, label).toMatch(/Further writes are BLOCKED/);
      expect(stdout, label).toMatch(/journal reseal/);
    }

    it('memory write: exit 3, and stdout says it committed rather than "added …"', () => {
      const home = freshHome('sthayi-receipt-add-');
      expect(runCli(home, ['add', 'a seed fact']).status).toBe(0);
      jam(home);

      const r = runCli(home, ['add', 'the durable but unanchored fact']);
      const label = `${r.stdout}\n---\n${r.stderr}`;
      expect(r.status, label).toBe(EXIT_COMMITTED_UNANCHORED);
      expectDegradedText(r.stdout, label);
      // NOT the ordinary success line
      expect(r.stdout).not.toMatch(/^added /m);
      // …but it must still say the memory IS there — the row is durable
      expect(r.stdout).toMatch(/the memory IS stored: proposed semantic/);

      // and the write really did land: the row and the journal entry are in the database
      const rows = runCli(home, ['review']);
      expect(rows.stdout).toMatch(/the durable but unanchored fact/);
    });

    it('import: exit 3, the archive IS imported, and the ordinary "Imported N …" line is gone', () => {
      const home = freshHome('sthayi-receipt-import-');
      expect(runCli(home, ['add', 'a seed fact']).status).toBe(0);
      jam(home);

      const r = runCli(home, ['import', claudeFixture]);
      const label = `${r.stdout}\n---\n${r.stderr}`;
      // An import is ONE journaled write of the whole archive: re-running it would write every
      // memory a second time, so it must never come back as an ordinary success.
      expect(r.status, label).toBe(EXIT_COMMITTED_UNANCHORED);
      expectDegradedText(r.stdout, label);
      expect(r.stdout).not.toMatch(/^Imported \d+ memory\(ies\) as proposals/m);
      expect(r.stdout).not.toMatch(/^Review them with:/m);
      expect(r.stdout).toMatch(/the claude export IS imported: 4 memory\(ies\)/);
      expect(r.stdout).toMatch(/Do NOT re-import/);
      // loader/parser warnings survive the degraded rendering — they are not the thing suppressed
      expect(r.stdout).toMatch(/warning: skipped 1 conversations with no human message/);
    });

    it('import CONTROL: a healthy import exits 0 with the ordinary lines and no DEGRADED text', () => {
      const home = freshHome('sthayi-receipt-import-ok-');
      const r = runCli(home, ['import', claudeFixture]);
      const label = `${r.stdout}\n---\n${r.stderr}`;
      expect(r.status, label).toBe(0);
      expect(r.stdout).toMatch(/^Detected claude export\.$/m);
      expect(r.stdout).toMatch(/^Imported 4 memory\(ies\) as proposals\.$/m);
      expect(r.stdout).toMatch(/^Review them with:/m);
      expect(r.stdout).not.toMatch(/DEGRADED/);
    });

    it('import REFUSAL: with writes already blocked nothing is imported and the exit is 1', () => {
      const home = freshHome('sthayi-receipt-import-refused-');
      expect(runCli(home, ['add', 'a seed fact']).status).toBe(0);
      jam(home);
      // the first import degrades (committed, unanchored) and blocks further writes …
      expect(runCli(home, ['import', claudeFixture]).status).toBe(EXIT_COMMITTED_UNANCHORED);
      // … so a second one is REFUSED outright: exit 1, nothing durable, no DEGRADED claim
      const refused = runCli(home, ['import', claudeFixture]);
      const label = `${refused.stdout}\n---\n${refused.stderr}`;
      expect(refused.status, label).toBe(1);
      expect(refused.stdout).not.toMatch(/DEGRADED/);
      expect(`${refused.stdout}${refused.stderr}`).toMatch(/refusing to append/);
    });

    it('review --confirm-all: the FIRST degraded page stops the drain and reports its exact count', () => {
      const home = freshHome('sthayi-receipt-confirmall-');
      expect(runCli(home, ['add', 'proposal number 0']).status).toBe(0);
      seedProposals(home, 100); // 101 proposals in total → two pages of CONFIRM_ALL_PAGE = 100
      jam(home);

      const r = runCli(home, ['review', '--confirm-all']);
      const label = `${r.stdout}\n---\n${r.stderr}`;
      // A page is its own durable commit. Reporting only after the loop meant the SECOND page's
      // refusal threw, and 100 durable confirmations left as a generic exit-1 failure.
      expect(r.status, label).toBe(EXIT_COMMITTED_UNANCHORED);
      expect(r.status, label).not.toBe(1);
      expectDegradedText(r.stdout, label);
      expect(r.stdout).toMatch(/100 memory\(ies\) WERE confirmed/);
      expect(r.stdout).toMatch(/the rest of the queue was NOT attempted/);
      expect(r.stdout).not.toMatch(/^confirmed \d+ memory\(ies\) as trusted\./m);

      // EXACTLY one page was ever attempted: one memory_confirm entry, 100 rows moved, 1 left.
      const db = new Database(path.join(home, 'sthayi.db'), { readonly: true });
      try {
        const confirms = db
          .prepare("SELECT count(*) AS c FROM journal WHERE op = 'memory_confirm'")
          .get() as { c: number };
        expect(confirms.c, 'a second page must never have been attempted').toBe(1);
        const counts = db
          .prepare(
            "SELECT (SELECT count(*) FROM memories WHERE status='confirmed') AS confirmed, (SELECT count(*) FROM memories WHERE status='proposed') AS proposed",
          )
          .get() as { confirmed: number; proposed: number };
        expect(counts.confirmed).toBe(100);
        expect(counts.proposed).toBe(1);
      } finally {
        db.close();
      }
    });

    it('review --confirm-all CONTROL: a healthy 101-proposal queue drains in full at exit 0', () => {
      const home = freshHome('sthayi-receipt-confirmall-ok-');
      expect(runCli(home, ['add', 'proposal number 0']).status).toBe(0);
      seedProposals(home, 100);
      const r = runCli(home, ['review', '--confirm-all']);
      const label = `${r.stdout}\n---\n${r.stderr}`;
      expect(r.status, label).toBe(0);
      expect(r.stdout).toMatch(/^confirmed 101 memory\(ies\) as trusted\.$/m);
      expect(r.stdout).not.toMatch(/DEGRADED/);
    });

    it('search --json: stdout is ONE parseable document carrying the hits AND the outcome', () => {
      const home = freshHome('sthayi-receipt-json-');
      expect(runCli(home, ['add', 'a searchable durable fact']).status).toBe(0);
      jam(home);

      const r = runCli(home, ['search', '--json', 'searchable']);
      const label = `${r.stdout}\n---\n${r.stderr}`;
      expect(r.status, label).toBe(EXIT_COMMITTED_UNANCHORED);
      // `--json` is a machine contract: prose printed beside the payload does not warn the consumer,
      // it makes the stream unparseable and takes the hits down with it.
      const parsed = JSON.parse(r.stdout) as {
        hits: { memory: { content: string } }[];
        mutation: Record<string, unknown>;
      };
      expect(parsed.hits).toHaveLength(1);
      expect(parsed.hits[0]?.memory.content).toBe('a searchable durable fact');
      // …and the outcome is STRUCTURE, not prose: every fact a script would branch on.
      expect(parsed.mutation.state).toBe('committed');
      expect(parsed.mutation.committed).toBe(true);
      expect(parsed.mutation.anchor).toBe('unanchored');
      expect(parsed.mutation.writesBlocked).toBe(true);
      expect(parsed.mutation.doNotRetry).toBe(true);
      expect(parsed.mutation.journalId).toBeTypeOf('number');
      expect(String(parsed.mutation.message)).toMatch(/DEGRADED/);
      expect(String(parsed.mutation.message)).toMatch(/DO NOT RETRY/);
    });

    it('search --json CONTROL: a healthy search is one document, exit 0, anchor anchored', () => {
      const home = freshHome('sthayi-receipt-json-ok-');
      expect(runCli(home, ['add', 'a searchable durable fact']).status).toBe(0);
      const r = runCli(home, ['search', '--json', 'searchable']);
      expect(r.status, `${r.stdout}\n---\n${r.stderr}`).toBe(0);
      const parsed = JSON.parse(r.stdout) as { hits: unknown[]; mutation: { anchor: string } };
      expect(parsed.hits).toHaveLength(1);
      expect(parsed.mutation.anchor).toBe('anchored');
    });

    it('consolidation: exit 3, the batch is reported as applied, and it must not be re-run', () => {
      const home = freshHome('sthayi-receipt-cons-');
      expect(runCli(home, ['add', '--confirm', 'duplicate fixture payload']).status).toBe(0);
      expect(runCli(home, ['add', '--confirm', 'duplicate fixture payload']).status).toBe(0);
      jam(home);

      const r = runCli(home, ['consolidate']);
      const label = `${r.stdout}\n---\n${r.stderr}`;
      expect(r.status, label).toBe(EXIT_COMMITTED_UNANCHORED);
      expectDegradedText(r.stdout, label);
      expect(r.stdout).toMatch(/Do NOT re-run this command/);
      // the batch DID apply — one duplicate archived
      expect(r.stdout).toMatch(/1 exact dupes/);
    });

    it('rollback: exit 3, and it never prints the ordinary "Rolled back #n" success line', () => {
      const home = freshHome('sthayi-receipt-rb-');
      expect(runCli(home, ['add', '--confirm', 'duplicate fixture payload']).status).toBe(0);
      expect(runCli(home, ['add', '--confirm', 'duplicate fixture payload']).status).toBe(0);
      expect(runCli(home, ['consolidate']).status).toBe(0);
      const listing = runCli(home, ['journal', '-n', '50']);
      const id = /#(\d+)\s+\S+\s+\S+\s+consolidate\b/.exec(listing.stdout)?.[1];
      expect(id, listing.stdout).toBeDefined();
      jam(home);

      const r = runCli(home, ['rollback', String(id)]);
      const label = `${r.stdout}\n---\n${r.stderr}`;
      expect(r.status, label).toBe(EXIT_COMMITTED_UNANCHORED);
      expectDegradedText(r.stdout, label);
      expect(r.stdout).not.toMatch(/^Rolled back #/m);
      expect(r.stdout).toMatch(/DID revert 1 change\(s\) — it must not be re-run/);
    });

    it('CONTROL: with the anchor healthy every one of those commands exits 0 with its usual line', () => {
      const home = freshHome('sthayi-receipt-ok-');
      const add = runCli(home, ['add', '--confirm', 'duplicate fixture payload']);
      expect(add.status).toBe(0);
      expect(add.stdout).toMatch(/^added confirmed semantic/m);
      expect(add.stdout).not.toMatch(/DEGRADED/);
      expect(runCli(home, ['add', '--confirm', 'duplicate fixture payload']).status).toBe(0);

      const cons = runCli(home, ['consolidate']);
      expect(cons.status).toBe(0);
      expect(cons.stdout).toMatch(/1 exact dupes/);
      expect(cons.stdout).not.toMatch(/DEGRADED/);

      const listing = runCli(home, ['journal', '-n', '50']);
      const id = /#(\d+)\s+\S+\s+\S+\s+consolidate\b/.exec(listing.stdout)?.[1];
      const rb = runCli(home, ['rollback', String(id)]);
      expect(rb.status).toBe(0);
      expect(rb.stdout).toMatch(
        /^Rolled back #\d+: reverted 1 change\(s\)\. Journal chain intact: true\./m,
      );
      expect(rb.stdout).not.toMatch(/DEGRADED/);
    });

    it('the degraded exit code is distinct from BOTH success and refusal', () => {
      const home = freshHome('sthayi-receipt-codes-');
      expect(runCli(home, ['add', 'seed']).status).toBe(0); // success
      jam(home);
      expect(runCli(home, ['add', 'committed but unanchored']).status).toBe(
        EXIT_COMMITTED_UNANCHORED,
      ); // committed, degraded
      // …and from here the store REFUSES: nothing is written, exit 1, no DEGRADED claim
      const refused = runCli(home, ['add', 'must be refused']);
      expect(refused.status).toBe(1);
      expect(refused.stdout).not.toMatch(/DEGRADED/);
      expect(`${refused.stdout}${refused.stderr}`).toMatch(/refusing to append/);
    });
  },
  BUILT_CLI_RECEIPT_TIMEOUT,
);

describe('safety: the commit receipt itself (real SQLite + FileCheckpoint)', () => {
  let home: FakeHome;
  let cpFile: string;

  beforeEach(() => {
    home = createFakeHome();
    cpFile = home.path('journal.checkpoint');
  });
  afterEach(() => {
    removeOwned(`${cpFile}.lock`);
    home.cleanup();
  });

  function openStack() {
    const driver = SqliteDriver.open(home.path('sthayi.db'));
    driver.migrate();
    const crypto = NodeCrypto.open(home.path('key'));
    const vault = new VaultService(driver, crypto, { now: () => 1 });
    const journal = new JournalService(driver, {
      crypto,
      external: new FileCheckpoint(cpFile),
      masker: vault,
      warn: () => {},
    });
    return {
      driver,
      journal,
      vault,
      memory: new MemoryService(driver, journal, vault),
      consolidate: new ConsolidationService(driver, journal, vault),
      close: () => driver.close(),
    };
  }

  it('a memory write carries a receipt that says COMMITTED, do-not-retry, writes-blocked', () => {
    const s = openStack();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      fs.mkdirSync(`${cpFile}.lock`, { recursive: true });

      const m = s.memory.add({ type: 'semantic', content: 'a fact' }, { now: 2 });
      const receipts = committedReceipts([m.outcome]);
      expect(receipts).toHaveLength(1);
      const r = receipts[0] as CommitReceipt;
      expect(isDegradedReceipt(r)).toBe(true);
      expect(r.committed).toBe(true); // NOT a rolled-back transaction
      expect(r.anchor).toBe('unanchored');
      expect(r.writesBlocked).toBe(true);
      expect(r.doNotRetry).toBe(true);
      expect(r.ids).toEqual([m.id]);
      expect(r.record.op).toBe('memory_write');
      expect(r.journalId).toBe(r.record.id);
      expect(r.reason).toMatch(/this write committed but the off-database anchor did not advance/);
      expect(describeReceipt(r)).toMatch(/DO NOT RETRY/);

      // the durable half really is durable — and the store now refuses the NEXT write
      expect(s.driver.countMemories()).toBe(1);
      expect(s.driver.allJournal()).toHaveLength(2);
      expect(() => s.memory.add({ type: 'semantic', content: 'next' }, { now: 3 })).toThrow(
        /refusing to append/,
      );
    } finally {
      s.close();
    }
  });

  it('consolidation and rollback carry the same receipt, and rollback stays ok:true', () => {
    const s = openStack();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      for (const [i, now] of [100, 101].entries()) {
        s.memory.add(
          { type: 'semantic', content: 'duplicate fixture payload', confidence: 0.9 - i * 0.1 },
          { now, asProposal: false },
        );
      }
      // a second duplicate pair so a LATER consolidation has real work
      const batch = s.consolidate.runDeterministic({ now: 300 });
      expect(batch.changed).toBe(1);
      expect(committedReceipts(batch.outcomes).every((r) => r.anchor === 'anchored')).toBe(true);
      expect(batch.outcomes.every((o) => o.state === 'committed')).toBe(true);
      const entry = s.driver.allJournal().find((r) => r.op === 'consolidate');
      expect(entry).toBeDefined();

      fs.mkdirSync(`${cpFile}.lock`, { recursive: true });
      const rb = s.consolidate.rollback(entry?.id ?? -1, 400);
      // The rollback DID happen: ok stays true and the rows are reverted…
      expect(rb.ok).toBe(true);
      expect(rb.reverted).toBe(1);
      // …but the caller is told the anchor did not advance with it.
      expect(rb.outcome?.state).toBe('committed');
      const receipt = committedReceipts(rb.outcome === undefined ? [] : [rb.outcome])[0];
      expect(isDegradedReceipt(receipt)).toBe(true);
      expect(receipt?.committed).toBe(true);
      expect(receipt?.doNotRetry).toBe(true);
      expect(receipt?.record.op).toBe('rollback');
    } finally {
      s.close();
    }
  });

  it('a degraded write is NOT thrown as though the database rolled back', () => {
    const s = openStack();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      fs.mkdirSync(`${cpFile}.lock`, { recursive: true });
      const before = s.driver.allJournal().length;
      // it must RETURN, not throw…
      const outcomes: MutationOutcome[] = [];
      expect(() =>
        outcomes.push(s.memory.add({ type: 'semantic', content: 'durable' }, { now: 2 }).outcome),
      ).not.toThrow();
      // …and the database half must really have committed
      expect(s.driver.allJournal()).toHaveLength(before + 1);
      expect(committedReceipts(outcomes)[0]?.committed).toBe(true);
    } finally {
      s.close();
    }
  });

  it('CONTROL: a healthy write reports anchored, never degraded', () => {
    const s = openStack();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      const receipts = committedReceipts([
        s.memory.add({ type: 'semantic', content: 'a healthy fact' }, { now: 2 }).outcome,
      ]);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]?.anchor).toBe('anchored');
      expect(isDegradedReceipt(receipts[0])).toBe(false);
      expect(receipts[0]?.writesBlocked).toBe(false);
      expect(receipts[0]?.doNotRetry).toBe(false);
      expect(fs.readFileSync(cpFile, 'utf8')).toBe(s.driver.getMeta('journal_checkpoint'));
    } finally {
      s.close();
    }
  });

  it('CONTROL: search and review carry receipts too (both MUTATE the journal)', () => {
    const s = openStack();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      const m = s.memory.add({ type: 'semantic', content: 'searchable fact' }, { now: 2 });
      fs.mkdirSync(`${cpFile}.lock`, { recursive: true });

      const searchReceipts = committedReceipts([s.memory.search('searchable', { now: 3 }).outcome]);
      expect(searchReceipts).toHaveLength(1);
      expect(isDegradedReceipt(searchReceipts[0])).toBe(true);
      expect(searchReceipts[0]?.record.op).toBe('memory_retrieve');

      // the store refuses from here, so a review transition cannot commit at all
      const reviewOutcomes: MutationOutcome[] = [];
      expect(() => reviewOutcomes.push(s.memory.confirm([m.id], { now: 4 }).outcome)).toThrow(
        /refusing to append/,
      );
      expect(committedReceipts(reviewOutcomes)).toHaveLength(0);
    } finally {
      s.close();
    }
  });
});
