import fs from 'node:fs';
import {
  JOURNAL_CHECKPOINT_KEY,
  JournalService,
  MemoryService,
  type MutationOutcome,
  VaultService,
  committedReceipts,
  isDegradedReceipt,
} from '@sthayi/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileCheckpoint } from '../../packages/cli/src/drivers/checkpoint-file.js';
import { NodeCrypto } from '../../packages/cli/src/drivers/crypto.js';
import { SqliteDriver } from '../../packages/cli/src/drivers/sqlite.js';
import { type FakeHome, createFakeHome } from '../helpers/fake-home.js';
import { removeOwned } from '../helpers/owned-fs.js';

/**
 * SAFETY: A RECEIPT IS THE STATEMENT "THESE ROWS ARE DURABLE", AND ONLY A COMMIT MAY MAKE IT.
 *
 * Every mutating service here appends its journal entry inside a transaction the CALLER may own,
 * and that transaction can still roll back afterwards. Three properties keep the claim honest, and
 * this suite holds all three against the production wiring — real SQLite, real key-file crypto,
 * real checkpoint file:
 *
 *  1. NOTHING CLAIMS COMMITMENT BEFORE COMMIT. Inside a caller transaction a mutation's outcome is
 *     'in-flight' and carries no receipt; if that transaction rolls back it becomes 'rolled-back'
 *     and STAYS there. A rolled-back write leaves the caller holding rows that do not exist, so a
 *     receipt for it would be the most dangerous value in the system: it says "durable, DO NOT
 *     RETRY" about rows nobody stored.
 *  2. EVERY OUTER TRANSACTION SETTLES THE SAME WAY. `transaction()` and `writeTransaction()` share
 *     one lifecycle at the outermost level, so no entry point can commit rows while leaving the
 *     off-database mirror unrun — a checkpoint frozen one entry behind while the rows advance is a
 *     store that verifies RED and keeps accepting writes.
 *  3. NO CALLBACK OUTLIVES ITS TRANSACTION. A rollback discards the after-commit queue and reports
 *     the rollback edge; nothing is left in the connection for a later, unrelated transaction to
 *     drain. SQLite returns a rolled-back entry's id to its allocator, so a surviving callback
 *     would complete a dead value against a live entry that legitimately took its id.
 *
 * The tolerated in-flight state and the frozen-anchor refusal it must never excuse are covered by
 * `journal-tx-exemption.test.ts`; the surfaces that render a degraded receipt by
 * `journal-commit-receipt.test.ts`.
 */
describe('safety: a journaled mutation settles exactly once, with its transaction', () => {
  let home: FakeHome;
  let dbFile: string;
  let cpFile: string;

  beforeEach(() => {
    home = createFakeHome();
    dbFile = home.path('sthayi.db');
    cpFile = home.path('journal.checkpoint');
  });
  afterEach(() => {
    removeOwned(`${cpFile}.lock`);
    home.cleanup();
  });

  interface Stack {
    driver: SqliteDriver;
    journal: JournalService;
    memory: MemoryService;
    warnings: string[];
    close(): void;
  }

  /** Production-shaped stack: real sqlite connection, real key-file crypto, real checkpoint file. */
  function openStack(): Stack {
    const driver = SqliteDriver.open(dbFile);
    driver.migrate();
    const crypto = NodeCrypto.open(home.path('key'));
    const vault = new VaultService(driver, crypto, { now: () => 1 });
    const warnings: string[] = [];
    const journal = new JournalService(driver, {
      crypto,
      external: new FileCheckpoint(cpFile),
      masker: vault,
      warn: (m) => warnings.push(m),
    });
    return {
      driver,
      journal,
      memory: new MemoryService(driver, journal, vault),
      warnings,
      close: () => driver.close(),
    };
  }

  /** The same stack with NO off-database anchor wired — the 'not-configured' half of the matrix. */
  function openKeylessStack(): Stack {
    const driver = SqliteDriver.open(dbFile);
    driver.migrate();
    const warnings: string[] = [];
    const journal = new JournalService(driver, { warn: (m) => warnings.push(m) });
    return {
      driver,
      journal,
      memory: new MemoryService(driver, journal),
      warnings,
      close: () => driver.close(),
    };
  }

  /** Jam every checkpoint replacement, permanently and deterministically. */
  function jamLock(): void {
    fs.mkdirSync(`${cpFile}.lock`, { recursive: true });
  }

  function count(raw: string | undefined): number | undefined {
    return raw === undefined ? undefined : (JSON.parse(raw) as { count: number }).count;
  }

  /** Everything a caller could mistake for success, in one comparable value. */
  function shape(driver: SqliteDriver): {
    rows: number;
    memories: number;
    meta?: number;
    ext?: number;
  } {
    return {
      rows: driver.allJournal().length,
      memories: driver.countMemories(),
      meta: count(driver.getMeta(JOURNAL_CHECKPOINT_KEY)),
      ext: count(fs.existsSync(cpFile) ? fs.readFileSync(cpFile, 'utf8') : undefined),
    };
  }

  /** An outcome that reached commit must name a TERMINAL anchor — never "not settled yet". */
  function expectNoPendingAnchor(outcomes: readonly MutationOutcome[]): void {
    for (const r of committedReceipts(outcomes)) {
      expect(['anchored', 'unanchored', 'not-configured']).toContain(r.anchor);
    }
  }

  const fact = (content: string) => ({ type: 'semantic' as const, content });

  // ===============================================================================================
  // (1) A CALLER-OWNED writeTransaction THAT ROLLS BACK
  // ===============================================================================================

  it('a caller-owned writeTransaction rollback yields NO receipt — the rows never existed', () => {
    const s = openStack();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      let written: ReturnType<MemoryService['write']> | undefined;
      expect(() =>
        s.driver.writeTransaction(() => {
          written = s.memory.write([fact('doomed')], { now: 2 });
          // INSIDE the transaction nothing is durable yet, and the outcome says exactly that
          expect(written.outcome.state).toBe('in-flight');
          expect(committedReceipts([written.outcome])).toEqual([]);
          throw new Error('caller aborted');
        }),
      ).toThrow('caller aborted');

      // The caller is holding a Memory whose row does not exist. The outcome must say so.
      expect(written?.[0]?.id).toBeTypeOf('string');
      expect(written?.outcome.state).toBe('rolled-back');
      expect(committedReceipts(written === undefined ? [] : [written.outcome])).toEqual([]);

      // and only the seal is durable
      expect(shape(s.driver)).toEqual({ rows: 1, memories: 0, meta: 1, ext: 1 });
      expect(s.journal.verify({ heal: false })).toMatchObject({ ok: true, state: 'ok' });
    } finally {
      s.close();
    }
  });

  it('a keyless stack is no different: no off-database anchor is not a licence to settle early', () => {
    // With nothing to mirror there is no post-commit work to wait for — but the question the
    // outcome answers is about the TRANSACTION, not the wiring, and it is unanswered until it
    // settles either way.
    const s = openKeylessStack();
    try {
      let written: ReturnType<MemoryService['write']> | undefined;
      expect(() =>
        s.driver.writeTransaction(() => {
          written = s.memory.write([fact('doomed, keyless')], { now: 1 });
          expect(written.outcome.state).toBe('in-flight');
          throw new Error('caller aborted');
        }),
      ).toThrow('caller aborted');
      expect(written?.outcome.state).toBe('rolled-back');
      expect(s.driver.allJournal()).toHaveLength(0);
      expect(s.driver.countMemories()).toBe(0);

      // …and a committed keyless write settles to the honest terminal state instead
      const ok = s.memory.write([fact('keyless and durable')], { now: 2 });
      expect(ok.outcome.state).toBe('committed');
      expectNoPendingAnchor([ok.outcome]);
      expect(committedReceipts([ok.outcome])[0]?.anchor).toBe('not-configured');
    } finally {
      s.close();
    }
  });

  // ===============================================================================================
  // (2) + (3) THE PLAIN `transaction()` ENTRY POINT
  // ===============================================================================================

  it('a raw transaction() COMMIT anchors exactly like writeTransaction — no bypass', () => {
    const s = openStack();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      const written = s.driver.transaction(() => s.memory.write([fact('raw commit')], { now: 2 }));

      expect(written.outcome.state).toBe('committed');
      expectNoPendingAnchor([written.outcome]);
      const receipt = committedReceipts([written.outcome])[0];
      expect(receipt?.anchor).toBe('anchored');
      expect(isDegradedReceipt(receipt)).toBe(false);
      expect(receipt?.ids).toEqual([written[0]?.id]);

      // the off-database anchor advanced WITH the rows — not one entry behind them
      expect(shape(s.driver)).toEqual({ rows: 2, memories: 1, meta: 2, ext: 2 });
      expect(fs.readFileSync(cpFile, 'utf8')).toBe(s.driver.getMeta(JOURNAL_CHECKPOINT_KEY));
      expect(s.journal.verify({ heal: false })).toMatchObject({ ok: true, state: 'ok' });
      expect(s.warnings).toEqual([]);

      // and the store keeps accepting writes, which a frozen anchor would have stopped
      const next = s.memory.write([fact('the write after')], { now: 3 });
      expect(next.outcome.state).toBe('committed');
      expect(shape(s.driver)).toEqual({ rows: 3, memories: 2, meta: 3, ext: 3 });
    } finally {
      s.close();
    }
  });

  it('a raw transaction() ROLLBACK yields no receipt and leaves the anchor byte-identical', () => {
    const s = openStack();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      const sealed = fs.readFileSync(cpFile, 'utf8');
      let written: ReturnType<MemoryService['write']> | undefined;
      expect(() =>
        s.driver.transaction(() => {
          written = s.memory.write([fact('raw rollback')], { now: 2 });
          throw new Error('raw aborted');
        }),
      ).toThrow('raw aborted');

      expect(written?.outcome.state).toBe('rolled-back');
      expect(committedReceipts(written === undefined ? [] : [written.outcome])).toEqual([]);
      expect(fs.readFileSync(cpFile, 'utf8')).toBe(sealed);
      expect(shape(s.driver)).toEqual({ rows: 1, memories: 0, meta: 1, ext: 1 });
      expect(s.journal.verify({ heal: false })).toMatchObject({ ok: true, state: 'ok' });
    } finally {
      s.close();
    }
  });

  // ===============================================================================================
  // (4) A CALLBACK THAT OUTLIVED ITS TRANSACTION, AND THE JOURNAL ID THAT COMES BACK
  // ===============================================================================================

  it('a rolled-back entry stays rolled back when a LATER write takes the id it released', () => {
    const s = openStack();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      let doomed: ReturnType<MemoryService['write']> | undefined;
      expect(() =>
        s.driver.transaction(() => {
          doomed = s.memory.write([fact('doomed, id 2')], { now: 2 });
          throw new Error('raw aborted');
        }),
      ).toThrow('raw aborted');
      const doomedRow = doomed?.[0];
      expect(doomed?.outcome.state).toBe('rolled-back');

      // An unrelated later write. SQLite hands it the id the rollback released, so the two entries
      // are only distinguishable by their outcome — a stale callback completing the dead one here
      // would produce two "committed #2" claims with different hashes, payloads and memory ids.
      const real = s.memory.write([fact('the real entry 2')], { now: 3 });
      expect(real.outcome.state).toBe('committed');
      const realReceipt = committedReceipts([real.outcome])[0];
      expect(realReceipt?.journalId).toBe(2); // the reused id

      // the dead one did NOT move
      expect(doomed?.outcome.state).toBe('rolled-back');
      expect(committedReceipts(doomed === undefined ? [] : [doomed.outcome])).toEqual([]);

      // and #2 in the store is the LIVE entry, not the discarded one
      const stored = s.driver.allJournal().find((r) => r.id === 2);
      expect(stored?.hash).toBe(realReceipt?.record.hash);
      expect(realReceipt?.ids).toEqual([real[0]?.id]);
      expect(realReceipt?.ids).not.toContain(doomedRow?.id);
      expect(s.driver.getMemory(doomedRow?.id ?? '')).toBeUndefined();
      expect(shape(s.driver)).toEqual({ rows: 2, memories: 1, meta: 2, ext: 2 });
      expect(s.journal.verify({ heal: false })).toMatchObject({ ok: true, state: 'ok' });
    } finally {
      s.close();
    }
  });

  it('a rolled-back transaction leaves NO after-commit work for the next one to run', () => {
    const s = openStack();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      const ran: string[] = [];
      expect(() =>
        s.driver.writeTransaction(() => {
          s.driver.afterCommit(() => ran.push('doomed'));
          s.journal.append({ ts: 2, actor: 'cli', op: 'memory_write', payload: { ids: [] } });
          throw new Error('caller aborted');
        }),
      ).toThrow('caller aborted');
      expect(ran).toEqual([]);

      // A later, unrelated transaction must run its OWN work and nothing else.
      s.driver.writeTransaction(() => {
        s.driver.afterCommit(() => ran.push('live'));
        s.memory.write([fact('a real fact')], { now: 3 });
      });
      expect(ran).toEqual(['live']);
      expect(shape(s.driver)).toEqual({ rows: 2, memories: 1, meta: 2, ext: 2 });
    } finally {
      s.close();
    }
  });

  // ===============================================================================================
  // (5) NESTED COMMIT, (6) A COMMIT THAT FAILS AFTER THE BODY COMPLETED
  // ===============================================================================================

  it('nested writes settle ONCE, on the outermost commit, and every outcome is terminal', () => {
    const s = openStack();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      const written: ReturnType<MemoryService['write']>[] = [];
      s.driver.writeTransaction(() => {
        written.push(s.memory.write([fact('outer fact')], { now: 2 }));
        s.driver.writeTransaction(() => {
          written.push(s.memory.write([fact('inner fact')], { now: 3 }));
          // a plain transaction() nested inside is a SAVEPOINT of the same outermost transaction
          s.driver.transaction(() => {
            written.push(s.memory.write([fact('innermost fact')], { now: 4 }));
          });
        });
        for (const w of written) {
          expect(w.outcome.state).toBe('in-flight');
        }
      });

      const outcomes = written.map((w) => w.outcome);
      expect(outcomes.map((o) => o.state)).toEqual(['committed', 'committed', 'committed']);
      expectNoPendingAnchor(outcomes);
      expect(committedReceipts(outcomes).map((r) => r.anchor)).toEqual([
        'anchored',
        'anchored',
        'anchored',
      ]);
      // three distinct entries, and the anchor caught up with all of them at the single commit
      expect(committedReceipts(outcomes).map((r) => r.journalId)).toEqual([2, 3, 4]);
      expect(shape(s.driver)).toEqual({ rows: 4, memories: 3, meta: 4, ext: 4 });
      expect(s.journal.verify({ heal: false })).toMatchObject({ ok: true, state: 'ok' });
    } finally {
      s.close();
    }
  });

  it('an abort after every append succeeded rolls every outcome back, and the store recovers', () => {
    // Every append in the body succeeded and the transaction still ended in a rollback, so the
    // after-commit queue was discarded exactly as a forced rollback discards it and nothing outside
    // the database ever saw the batch. The abort here is the BODY's; the edge where the database
    // itself refuses the COMMIT statement is held by `journal-commit-edge-settlement.test.ts`.
    const s = openStack();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      const sealed = fs.readFileSync(cpFile, 'utf8');
      class CommitFailure extends Error {}
      const written: ReturnType<MemoryService['write']>[] = [];
      expect(() =>
        s.driver.writeTransaction(() => {
          written.push(s.memory.write([fact('batch one')], { now: 2 }));
          written.push(s.memory.write([fact('batch two')], { now: 3 }));
          throw new CommitFailure('COMMIT failed');
        }),
      ).toThrow(CommitFailure);

      expect(written.map((w) => w.outcome.state)).toEqual(['rolled-back', 'rolled-back']);
      expect(committedReceipts(written.map((w) => w.outcome))).toEqual([]);
      expect(fs.readFileSync(cpFile, 'utf8')).toBe(sealed);
      expect(shape(s.driver)).toEqual({ rows: 1, memories: 0, meta: 1, ext: 1 });

      // nothing leaked into the connection: the next write anchors normally
      const next = s.memory.write([fact('after the failure')], { now: 4 });
      expect(next.outcome.state).toBe('committed');
      expect(committedReceipts([next.outcome])[0]?.anchor).toBe('anchored');
      expect(shape(s.driver)).toEqual({ rows: 2, memories: 1, meta: 2, ext: 2 });
      expect(s.journal.verify({ heal: false })).toMatchObject({ ok: true, state: 'ok' });
    } finally {
      s.close();
    }
  });

  // ===============================================================================================
  // (7) THE TWO COMMITTED OUTCOMES: A HEALTHY ANCHOR AND A JAMMED ONE
  // ===============================================================================================

  it('a HEALTHY anchor: every mutation reports committed + anchored, on both entry points', () => {
    const s = openStack();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      const outcomes: MutationOutcome[] = [];
      const written = s.memory.write([fact('healthy fact')], { now: 2 });
      outcomes.push(written.outcome);
      outcomes.push(s.memory.search('healthy', { now: 3 }).outcome);
      outcomes.push(s.memory.confirm([written[0]?.id ?? ''], { now: 4 }).outcome);
      outcomes.push(
        s.driver.transaction(() => s.memory.write([fact('healthy raw fact')], { now: 5 })).outcome,
      );

      expect(outcomes.map((o) => o.state)).toEqual([
        'committed',
        'committed',
        'committed',
        'committed',
      ]);
      expectNoPendingAnchor(outcomes);
      const receipts = committedReceipts(outcomes);
      expect(receipts.map((r) => r.anchor)).toEqual([
        'anchored',
        'anchored',
        'anchored',
        'anchored',
      ]);
      expect(receipts.some((r) => isDegradedReceipt(r))).toBe(false);
      expect(receipts.every((r) => r.writesBlocked === false && r.doNotRetry === false)).toBe(true);
      expect(fs.readFileSync(cpFile, 'utf8')).toBe(s.driver.getMeta(JOURNAL_CHECKPOINT_KEY));
      expect(s.journal.verify({ heal: false })).toMatchObject({ ok: true, state: 'ok' });
    } finally {
      s.close();
    }
  });

  it('a JAMMED anchor: the mutation reports committed + unanchored, and the next one REFUSES', () => {
    const s = openStack();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      jamLock();

      const written = s.memory.write([fact('durable but unanchored')], { now: 2 });
      expect(written.outcome.state).toBe('committed');
      expectNoPendingAnchor([written.outcome]);
      const receipt = committedReceipts([written.outcome])[0];
      expect(isDegradedReceipt(receipt)).toBe(true);
      expect(receipt?.committed).toBe(true); // NOT a rolled-back transaction
      expect(receipt?.anchor).toBe('unanchored');
      expect(receipt?.writesBlocked).toBe(true);
      expect(receipt?.doNotRetry).toBe(true);
      expect(receipt?.ids).toEqual([written[0]?.id]);

      // the rows ARE durable while the anchor is one entry behind
      expect(shape(s.driver)).toEqual({ rows: 2, memories: 1, meta: 2, ext: 1 });
      // …and from here the store refuses, on BOTH entry points
      expect(() => s.memory.write([fact('must refuse')], { now: 3 })).toThrow(/refusing to append/);
      expect(() =>
        s.driver.transaction(() => s.memory.write([fact('must refuse too')], { now: 4 })),
      ).toThrow(/refusing to append/);
      expect(shape(s.driver)).toEqual({ rows: 2, memories: 1, meta: 2, ext: 1 });
    } finally {
      s.close();
    }
  });
});
