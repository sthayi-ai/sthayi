import fs from 'node:fs';
import {
  JOURNAL_CHECKPOINT_KEY,
  JOURNAL_TX_TOKEN_KEY,
  JournalService,
  MemoryService,
  type MutationOutcome,
  VaultService,
  committedReceipts,
} from '@sthayi/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileCheckpoint } from '../../packages/cli/src/drivers/checkpoint-file.js';
import { NodeCrypto } from '../../packages/cli/src/drivers/crypto.js';
import { SqliteDriver } from '../../packages/cli/src/drivers/sqlite.js';
import { type FakeHome, createFakeHome } from '../helpers/fake-home.js';
import { removeOwned } from '../helpers/owned-fs.js';

/**
 * SAFETY: A SAVEPOINT THAT UNWINDS TAKES ITS OWN CALLBACKS WITH IT.
 *
 * A nested `transaction()` is a SAVEPOINT: it can roll back on its own while the transaction
 * hosting it CATCHES the failure, writes something else, and commits. That is the property the
 * chunked association fold depends on — a fold failure degrades instead of destroying its host's
 * work — and it is the one shape in which a mutation's writes and its callbacks can end on
 * OPPOSITE edges.
 *
 * The three statements this suite holds against the production wiring (real SQLite, real key-file
 * crypto, real checkpoint file):
 *
 *  1. A ROLLED-BACK SAVEPOINT SETTLES ITS OWN MUTATIONS, AND SETTLES THEM AS ROLLED BACK. Its
 *     after-commit callbacks never run — there is no commit of those rows for them to describe —
 *     and its settle callbacks run at the unwind, which is the moment those rows died and the only
 *     moment anything can report it.
 *  2. ONLY DURABLE ROWS RECEIVE RECEIPTS. SQLite returns a rolled-back entry's id to its allocator,
 *     so the host transaction's next append legitimately takes it. A receipt minted for the
 *     discarded entry would name that id with a DIFFERENT hash, different payload and memory ids
 *     that no row carries — two "committed #n" claims about one id, with verification green over
 *     both, and the caller told not to retry the write that never landed.
 *  3. THE HOST TRANSACTION IS UNTOUCHED. Its callbacks stay queued for its own commit, its
 *     external-mirror exemption stays the one it armed, and nothing is published while it can still
 *     roll back — so a host that unwinds after a caught inner failure leaves the off-database
 *     anchor byte-identical rather than holding a checkpoint for rows that no longer exist.
 *
 * The outermost-transaction half of the lifecycle is covered by
 * `journal-transaction-settlement.test.ts`; the exemption's transaction binding by
 * `journal-tx-exemption.test.ts`.
 */
describe('safety: a nested savepoint settles with itself, not with its host', () => {
  let home: FakeHome;
  let dbFile: string;
  let cpFile: string;

  beforeEach(() => {
    home = createFakeHome();
    dbFile = home.path('sthayi.db');
    cpFile = home.path('journal.checkpoint');
  });
  afterEach(() => {
    // Identity-aware, not recursive-by-name: the lock's on-disk shape is what the tests vary,
    // but clearing it here is teardown, and teardown never decides a walk from a pathname.
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

  /**
   * Record whether each checkpoint-file replacement happens with a transaction still open. Nothing
   * a rollback could take back may ever be published, so the answer is `false` every time.
   */
  function watchPublishes(driver: SqliteDriver, seen: boolean[]): () => void {
    const raw = FileCheckpoint.prototype.replace;
    (FileCheckpoint.prototype as { replace: typeof raw }).replace = function spy(
      this: FileCheckpoint,
      expected: string | undefined,
      next: string,
      opts?: { force?: boolean },
    ): boolean {
      seen.push(driver.inTransaction());
      return raw.call(this, expected, next, opts);
    } as typeof raw;
    return () => {
      (FileCheckpoint.prototype as { replace: typeof raw }).replace = raw;
    };
  }

  const fact = (content: string) => ({ type: 'semantic' as const, content });

  /** Run `fn` as a SAVEPOINT of the open transaction and swallow the unwind, as a degrading
   *  caller does — the host goes on to write and commit. */
  function caughtSavepoint(driver: SqliteDriver, fn: () => void): void {
    try {
      driver.transaction(fn);
    } catch {
      // the host catches its nested failure and continues, which is the point of a savepoint
    }
  }

  // ===============================================================================================
  // (1) THE CAUGHT SAVEPOINT ROLLBACK, END TO END
  // ===============================================================================================

  it('a CAUGHT savepoint rollback settles rolled-back while its host commits', () => {
    const s = openStack();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      let outerOne: ReturnType<MemoryService['write']> | undefined;
      let inner: ReturnType<MemoryService['write']> | undefined;
      let outerTwo: ReturnType<MemoryService['write']> | undefined;
      let armedToken: string | undefined;

      s.driver.writeTransaction(() => {
        outerOne = s.memory.write([fact('outer one')], { now: 2 });
        // the transaction token the host's first append wrote — the identity of ITS exemption
        armedToken = s.driver.getMeta(JOURNAL_TX_TOKEN_KEY);
        expect(armedToken).toBeTypeOf('string');

        caughtSavepoint(s.driver, () => {
          inner = s.memory.write([fact('inner, discarded')], { now: 3 });
          expect(inner.outcome.state).toBe('in-flight');
          throw new Error('inner aborted');
        });

        // the savepoint's rows are gone the moment it unwinds, and so is its claim
        expect(inner?.outcome.state).toBe('rolled-back');
        expect(s.driver.getMemory(inner?.[0]?.id ?? '')).toBeUndefined();
        // the HOST is untouched: its own row is still there and still unsettled
        expect(s.driver.getMemory(outerOne?.[0]?.id ?? '')).toBeDefined();
        expect(outerOne?.outcome.state).toBe('in-flight');

        outerTwo = s.memory.write([fact('outer two')], { now: 4 });
      });

      // THE HOST'S EXEMPTION SURVIVED THE UNWIND. A re-armed one mints a fresh token, so the token
      // still being the host's first append's is the proof that the tolerance it carries is still
      // the host's — bound to the checkpoint committed when the host began, not to an uncommitted
      // one minted midway through it.
      expect(s.driver.getMeta(JOURNAL_TX_TOKEN_KEY)).toBe(armedToken);

      expect(outerOne?.outcome.state).toBe('committed');
      expect(outerTwo?.outcome.state).toBe('committed');
      // a settled outcome is FINAL: the host's commit cannot resurrect the savepoint's rows
      expect(inner?.outcome.state).toBe('rolled-back');

      // ONLY DURABLE ROWS RECEIVE RECEIPTS
      const outcomes: MutationOutcome[] = [outerOne, inner, outerTwo].map(
        (w) => w?.outcome ?? { state: 'no-entry' },
      );
      const receipts = committedReceipts(outcomes);
      expect(receipts).toHaveLength(2);
      const stored = s.driver.allJournal();
      expect(receipts.map((r) => r.record.hash).sort()).toEqual(
        stored
          .filter((r) => r.id > 1)
          .map((r) => r.hash)
          .sort(),
      );
      for (const r of receipts) {
        expect(r.ids).not.toContain(inner?.[0]?.id);
        expect(r.anchor).toBe('anchored');
      }

      expect(shape(s.driver)).toEqual({ rows: 3, memories: 2, meta: 3, ext: 3 });
      expect(fs.readFileSync(cpFile, 'utf8')).toBe(s.driver.getMeta(JOURNAL_CHECKPOINT_KEY));
      expect(s.journal.verify({ heal: false })).toMatchObject({ ok: true, state: 'ok' });
      expect(s.warnings).toEqual([]);
    } finally {
      s.close();
    }
  });

  // ===============================================================================================
  // (2) THE JOURNAL ID THE SAVEPOINT RELEASED, TAKEN BY A REAL ROW
  // ===============================================================================================

  it('the id a rolled-back savepoint releases is taken by a real row, and only that row is receipted', () => {
    const s = openStack();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      let discarded: ReturnType<MemoryService['write']> | undefined;
      let discardedRow: { id: number; hash: string } | undefined;
      let real: ReturnType<MemoryService['write']> | undefined;

      s.driver.writeTransaction(() => {
        caughtSavepoint(s.driver, () => {
          discarded = s.memory.write([fact('discarded, id 2')], { now: 2 });
          // read the entry while it still exists — the unwind takes the row itself away
          const row = s.driver.allJournal().at(-1);
          discardedRow = row === undefined ? undefined : { id: row.id, hash: row.hash };
          throw new Error('inner aborted');
        });
        // the host's next append takes the id the unwind returned to the allocator
        real = s.memory.write([fact('the real entry 2')], { now: 3 });
      });

      const receipts = committedReceipts([
        discarded?.outcome ?? { state: 'no-entry' },
        real?.outcome ?? { state: 'no-entry' },
      ]);
      expect(discarded?.outcome.state).toBe('rolled-back');
      expect(receipts).toHaveLength(1);
      expect(discardedRow?.id).toBe(2);
      expect(receipts[0]?.journalId).toBe(2); // the SAME id, taken by the live entry
      expect(receipts[0]?.record.hash).not.toBe(discardedRow?.hash); // a DIFFERENT entry
      expect(receipts[0]?.ids).toEqual([real?.[0]?.id]);
      expect(receipts[0]?.ids).not.toContain(discarded?.[0]?.id);

      // #2 in the store is the LIVE entry, and the discarded row exists nowhere
      const stored = s.driver.allJournal().find((r) => r.id === 2);
      expect(stored?.hash).toBe(receipts[0]?.record.hash);
      expect(stored?.hash).not.toBe(discardedRow?.hash);
      expect(s.driver.getMemory(discarded?.[0]?.id ?? '')).toBeUndefined();
      expect(shape(s.driver)).toEqual({ rows: 2, memories: 1, meta: 2, ext: 2 });
      expect(s.journal.verify({ heal: false })).toMatchObject({ ok: true, state: 'ok' });
    } finally {
      s.close();
    }
  });

  // ===============================================================================================
  // (3) THE HOST CONTINUES — AND MAY STILL ROLL BACK
  // ===============================================================================================

  it('a host that continues after a caught savepoint rollback publishes nothing until it commits', () => {
    const s = openStack();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      const sealed = fs.readFileSync(cpFile, 'utf8');
      const publishedInTransaction: boolean[] = [];
      const restore = watchPublishes(s.driver, publishedInTransaction);
      try {
        s.driver.writeTransaction(() => {
          s.memory.write([fact('host one')], { now: 2 });
          caughtSavepoint(s.driver, () => {
            s.memory.write([fact('discarded')], { now: 3 });
            throw new Error('inner aborted');
          });
          // the anchor is exactly where the host found it: the host's own rows are uncommitted
          expect(fs.readFileSync(cpFile, 'utf8')).toBe(sealed);
          s.memory.write([fact('host two')], { now: 4 });
          expect(fs.readFileSync(cpFile, 'utf8')).toBe(sealed);
          s.memory.write([fact('host three')], { now: 5 });
        });
      } finally {
        restore();
      }
      // nothing was published while the transaction could still roll back
      expect(publishedInTransaction).not.toContain(true);
      expect(shape(s.driver)).toEqual({ rows: 4, memories: 3, meta: 4, ext: 4 });
      expect(fs.readFileSync(cpFile, 'utf8')).toBe(s.driver.getMeta(JOURNAL_CHECKPOINT_KEY));
      expect(s.journal.verify({ heal: false })).toMatchObject({ ok: true, state: 'ok' });
      expect(s.warnings).toEqual([]);
    } finally {
      s.close();
    }
  });

  it('a host that ROLLS BACK after a caught savepoint rollback leaves the anchor byte-identical', () => {
    // The reason nothing may be published mid-transaction: the host is still free to unwind, and
    // an anchor holding a checkpoint for rows that no longer exist verifies RED forever.
    const s = openStack();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      const sealed = fs.readFileSync(cpFile, 'utf8');
      const written: ReturnType<MemoryService['write']>[] = [];
      expect(() =>
        s.driver.writeTransaction(() => {
          written.push(s.memory.write([fact('host one')], { now: 2 }));
          caughtSavepoint(s.driver, () => {
            written.push(s.memory.write([fact('discarded')], { now: 3 }));
            throw new Error('inner aborted');
          });
          written.push(s.memory.write([fact('host two')], { now: 4 }));
          throw new Error('host aborted');
        }),
      ).toThrow('host aborted');

      expect(written.map((w) => w.outcome.state)).toEqual([
        'rolled-back',
        'rolled-back',
        'rolled-back',
      ]);
      expect(committedReceipts(written.map((w) => w.outcome))).toEqual([]);
      expect(fs.readFileSync(cpFile, 'utf8')).toBe(sealed);
      expect(shape(s.driver)).toEqual({ rows: 1, memories: 0, meta: 1, ext: 1 });
      expect(s.journal.verify({ heal: false })).toMatchObject({ ok: true, state: 'ok' });

      // and the store is still writable — the unwind left nothing behind to refuse over
      const next = s.memory.write([fact('after the unwind')], { now: 5 });
      expect(next.outcome.state).toBe('committed');
      expect(committedReceipts([next.outcome])[0]?.anchor).toBe('anchored');
      expect(shape(s.driver)).toEqual({ rows: 2, memories: 1, meta: 2, ext: 2 });
    } finally {
      s.close();
    }
  });

  // ===============================================================================================
  // (4) THE SUCCESS EDGE: A RELEASED SAVEPOINT'S CALLBACKS BECOME ITS HOST'S
  // ===============================================================================================

  it('a savepoint that RELEASES hands its callbacks to the host, which runs them at its commit', () => {
    const s = openStack();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      const ran: string[] = [];
      const edges: boolean[] = [];
      const written: ReturnType<MemoryService['write']>[] = [];

      s.driver.writeTransaction(() => {
        s.driver.afterCommit(() => ran.push('host-before'));
        written.push(s.memory.write([fact('host fact')], { now: 2 }));
        s.driver.transaction(() => {
          s.driver.afterCommit(() => ran.push('savepoint'));
          s.driver.onSettle((committed) => edges.push(committed));
          written.push(s.memory.write([fact('savepoint fact')], { now: 3 }));
        });
        // a released savepoint settles NOTHING on its own — its host still owns the edge
        expect(ran).toEqual([]);
        expect(edges).toEqual([]);
        s.driver.afterCommit(() => ran.push('host-after'));
        for (const w of written) {
          expect(w.outcome.state).toBe('in-flight');
        }
      });

      // queued order is preserved across the merge, and each callback runs exactly once
      expect(ran).toEqual(['host-before', 'savepoint', 'host-after']);
      expect(edges).toEqual([true]);
      expect(written.map((w) => w.outcome.state)).toEqual(['committed', 'committed']);
      expect(committedReceipts(written.map((w) => w.outcome)).map((r) => r.journalId)).toEqual([
        2, 3,
      ]);
      expect(shape(s.driver)).toEqual({ rows: 3, memories: 2, meta: 3, ext: 3 });
      expect(s.journal.verify({ heal: false })).toMatchObject({ ok: true, state: 'ok' });
    } finally {
      s.close();
    }
  });

  it('a rolled-back savepoint discards its after-commit work and reports its own edge at once', () => {
    const s = openStack();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      const ran: string[] = [];
      const edges: string[] = [];

      s.driver.writeTransaction(() => {
        s.driver.afterCommit(() => ran.push('host'));
        s.driver.onSettle((committed) => edges.push(`host:${committed}`));
        caughtSavepoint(s.driver, () => {
          s.driver.afterCommit(() => ran.push('discarded'));
          s.driver.onSettle((committed) => edges.push(`savepoint:${committed}`));
          s.memory.write([fact('discarded')], { now: 2 });
          throw new Error('inner aborted');
        });
        // the savepoint's edge is reported AT THE UNWIND — the only moment its rows can be
        // reported on — while its after-commit work is discarded unrun
        expect(edges).toEqual(['savepoint:false']);
        expect(ran).toEqual([]);
        s.memory.write([fact('host fact')], { now: 3 });
      });

      expect(ran).toEqual(['host']);
      expect(edges).toEqual(['savepoint:false', 'host:true']);
      expect(shape(s.driver)).toEqual({ rows: 2, memories: 1, meta: 2, ext: 2 });
      expect(s.journal.verify({ heal: false })).toMatchObject({ ok: true, state: 'ok' });
    } finally {
      s.close();
    }
  });

  // ===============================================================================================
  // (5) NOTHING CROSSES INTO A LATER TRANSACTION
  // ===============================================================================================

  it('a savepoint leaves no callback for a LATER transaction to adopt, on either edge', () => {
    const s = openStack();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      const ran: string[] = [];

      s.driver.writeTransaction(() => {
        caughtSavepoint(s.driver, () => {
          s.driver.afterCommit(() => ran.push('discarded'));
          s.memory.write([fact('discarded')], { now: 2 });
          throw new Error('inner aborted');
        });
        s.driver.transaction(() => {
          s.driver.afterCommit(() => ran.push('released'));
          s.memory.write([fact('released')], { now: 3 });
        });
      });
      expect(ran).toEqual(['released']);

      // A later, unrelated transaction runs its OWN work and nothing else.
      s.driver.writeTransaction(() => {
        s.driver.afterCommit(() => ran.push('later'));
        s.memory.write([fact('later')], { now: 4 });
      });
      expect(ran).toEqual(['released', 'later']);

      // …and so does a top-level call with no transaction open at all
      s.memory.write([fact('top level')], { now: 5 });
      expect(ran).toEqual(['released', 'later']);

      expect(shape(s.driver)).toEqual({ rows: 4, memories: 3, meta: 4, ext: 4 });
      expect(s.journal.verify({ heal: false })).toMatchObject({ ok: true, state: 'ok' });
    } finally {
      s.close();
    }
  });

  it('a HOST rollback after a released savepoint discards the savepoint work it adopted', () => {
    const s = openStack();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      const sealed = fs.readFileSync(cpFile, 'utf8');
      const ran: string[] = [];
      let released: ReturnType<MemoryService['write']> | undefined;

      expect(() =>
        s.driver.writeTransaction(() => {
          s.driver.transaction(() => {
            s.driver.afterCommit(() => ran.push('released'));
            released = s.memory.write([fact('released, then doomed')], { now: 2 });
          });
          throw new Error('host aborted');
        }),
      ).toThrow('host aborted');

      expect(ran).toEqual([]);
      expect(released?.outcome.state).toBe('rolled-back');
      expect(fs.readFileSync(cpFile, 'utf8')).toBe(sealed);
      expect(shape(s.driver)).toEqual({ rows: 1, memories: 0, meta: 1, ext: 1 });

      // the next transaction inherits none of it
      s.driver.writeTransaction(() => {
        s.driver.afterCommit(() => ran.push('later'));
        s.memory.write([fact('a real fact')], { now: 3 });
      });
      expect(ran).toEqual(['later']);
      expect(shape(s.driver)).toEqual({ rows: 2, memories: 1, meta: 2, ext: 2 });
      expect(s.journal.verify({ heal: false })).toMatchObject({ ok: true, state: 'ok' });
    } finally {
      s.close();
    }
  });
});
