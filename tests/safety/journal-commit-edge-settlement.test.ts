import fs from 'node:fs';
import {
  JOURNAL_CHECKPOINT_KEY,
  JournalService,
  MemoryService,
  VaultService,
  committedReceipts,
} from '@sthayi/core';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileCheckpoint } from '../../packages/cli/src/drivers/checkpoint-file.js';
import { NodeCrypto } from '../../packages/cli/src/drivers/crypto.js';
import { SqliteDriver } from '../../packages/cli/src/drivers/sqlite.js';
import { type FakeHome, createFakeHome } from '../helpers/fake-home.js';
import { removeOwned } from '../helpers/owned-fs.js';

/**
 * SAFETY: THE COMMIT ITSELF IS AN EDGE THAT CAN FAIL, AND A BEGIN IS AN EDGE THAT CAN BE RETRIED.
 *
 * Every append in this workspace settles at the outermost transaction's edge, and both ends of that
 * edge are places where the body has already run to completion and the database still says no:
 *
 *  - A DEFERRED CONSTRAINT IS CHECKED BY THE `COMMIT` STATEMENT. Every statement of the body
 *    succeeds, the body returns, and SQLite then rejects the commit. The after-commit queue — where
 *    the off-database mirror lives — must be discarded exactly as a forced rollback discards it,
 *    every handle must settle 'rolled-back', and the anchor must be byte-identical afterwards. A
 *    body that throws is not this shape: it never reaches the commit statement at all, so it cannot
 *    show what happens when the database refuses one.
 *  - A BUSY `BEGIN IMMEDIATE` IS RETRIED, AND EACH ATTEMPT IS A WHOLE TRANSACTION. A retried
 *    attempt is a SETTLED attempt: it minted its own identity, it rolled back, and its callbacks
 *    and its handles are finished with. An attempt that inherited the previous one's queue would
 *    run callbacks belonging to a transaction that never committed and hand a receipt to an append
 *    the database threw away.
 *
 * The body-throws shape and the ordinary outcome matrix are covered by
 * `journal-transaction-settlement.test.ts`; savepoint framing by
 * `journal-savepoint-settlement.test.ts` and `journal-savepoint-anchor.test.ts`.
 */
describe('safety: the commit edge and the retried begin settle like any other transaction end', () => {
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

  /** The off-database anchor exactly as it stands on disk. */
  function anchor(): string | undefined {
    return fs.existsSync(cpFile) ? fs.readFileSync(cpFile, 'utf8') : undefined;
  }

  const fact = (content: string) => ({ type: 'semantic' as const, content });

  type Write = ReturnType<MemoryService['write']>;

  function raw(driver: SqliteDriver): Database.Database {
    return Reflect.get(driver, 'db') as Database.Database;
  }

  /**
   * Give the connection a constraint the COMMIT statement enforces: a foreign key declared
   * DEFERRABLE INITIALLY DEFERRED is not checked as rows are written, only when the transaction
   * asks to become durable. `foreign_keys` is ON for every production open, which is what makes the
   * deferred declaration bite at all.
   */
  function armDeferredConstraint(driver: SqliteDriver): void {
    const db = raw(driver);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.exec(
      'CREATE TABLE commit_edge_parent (id INTEGER PRIMARY KEY);' +
        'CREATE TABLE commit_edge_child (' +
        '  id INTEGER PRIMARY KEY,' +
        '  parent INTEGER NOT NULL REFERENCES commit_edge_parent(id) DEFERRABLE INITIALLY DEFERRED' +
        ');',
    );
  }

  /** A row naming a parent that does not exist: accepted by the statement, refused by the COMMIT. */
  function violateAtCommit(driver: SqliteDriver, id: number): void {
    raw(driver).prepare('INSERT INTO commit_edge_child (id, parent) VALUES (?, ?)').run(id, 404);
  }

  // ===============================================================================================
  // (1) THE DATABASE REFUSES THE COMMIT AFTER THE BODY HAS RETURNED
  // ===============================================================================================

  it('a COMMIT the database refuses settles every append rolled-back and leaves the anchor byte-identical', () => {
    const s = openStack();
    try {
      armDeferredConstraint(s.driver);
      expect(s.journal.seal('test', 1).ok).toBe(true);
      const sealed = fs.readFileSync(cpFile, 'utf8');
      const written: Write[] = [];
      const ran: string[] = [];
      const edges: boolean[] = [];
      let bodyReturned = false;
      let failure: unknown;

      try {
        s.driver.writeTransaction(() => {
          s.driver.afterCommit(() => ran.push('mirror-shaped work'));
          s.driver.onSettle((committed) => edges.push(committed));
          written.push(s.memory.write([fact('batch one')], { now: 2 }));
          written.push(s.memory.write([fact('batch two')], { now: 3 }));
          violateAtCommit(s.driver, 1);
          // every statement of the body succeeded, including the one the COMMIT will reject
          for (const w of written) {
            expect(w.outcome.state).toBe('in-flight');
          }
          bodyReturned = true;
        });
      } catch (err) {
        failure = err;
      }

      // THE FAILURE IS THE COMMIT STATEMENT'S, not the body's: the body ran to its last line
      expect(bodyReturned).toBe(true);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as { code?: string }).code).toMatch(/^SQLITE_CONSTRAINT/);

      expect(edges).toEqual([false]);
      expect(ran).toEqual([]); // the after-commit queue is discarded, mirror included
      expect(written.map((w) => w.outcome.state)).toEqual(['rolled-back', 'rolled-back']);
      expect(committedReceipts(written.map((w) => w.outcome))).toEqual([]);
      for (const w of written) {
        expect(s.driver.getMemory(w[0]?.id ?? '')).toBeUndefined();
      }
      expect(anchor()).toBe(sealed);
      expect(shape(s.driver)).toEqual({ rows: 1, memories: 0, meta: 1, ext: 1 });
      expect(s.journal.verify({ heal: false })).toMatchObject({ ok: true, state: 'ok' });

      // nothing leaked into the connection: the next write commits and anchors normally
      const next = s.memory.write([fact('after the refused commit')], { now: 4 });
      expect(next.outcome.state).toBe('committed');
      expect(committedReceipts([next.outcome])[0]?.anchor).toBe('anchored');
      expect(shape(s.driver)).toEqual({ rows: 2, memories: 1, meta: 2, ext: 2 });
      expect(fs.readFileSync(cpFile, 'utf8')).toBe(s.driver.getMeta(JOURNAL_CHECKPOINT_KEY));
      expect(s.warnings).toEqual([]);
    } finally {
      s.close();
    }
  });

  it('a refused COMMIT takes the callbacks a RELEASED savepoint handed the host down with it', () => {
    const s = openStack();
    try {
      armDeferredConstraint(s.driver);
      expect(s.journal.seal('test', 1).ok).toBe(true);
      const sealed = fs.readFileSync(cpFile, 'utf8');
      const written: Write[] = [];
      const ran: string[] = [];
      const edges: string[] = [];
      let bodyReturned = false;
      let failure: unknown;

      try {
        s.driver.writeTransaction(() => {
          written.push(s.memory.write([fact('host fact')], { now: 2 }));
          // RELEASES: its appends and its callbacks become the host's, and the host's commit is
          // the edge they now depend on
          s.driver.transaction(() => {
            s.driver.afterCommit(() => ran.push('released'));
            s.driver.onSettle((committed) => edges.push(`released:${committed}`));
            written.push(s.memory.write([fact('released fact')], { now: 3 }));
          });
          expect(edges).toEqual([]); // a released savepoint settles nothing on its own
          violateAtCommit(s.driver, 1);
          bodyReturned = true;
        });
      } catch (err) {
        failure = err;
      }

      expect(bodyReturned).toBe(true); // the failure belongs to the COMMIT, not to the body
      expect((failure as { code?: string }).code).toMatch(/^SQLITE_CONSTRAINT/);
      expect(edges).toEqual(['released:false']);
      expect(ran).toEqual([]);
      expect(written.map((w) => w.outcome.state)).toEqual(['rolled-back', 'rolled-back']);
      expect(committedReceipts(written.map((w) => w.outcome))).toEqual([]);
      expect(anchor()).toBe(sealed);
      expect(shape(s.driver)).toEqual({ rows: 1, memories: 0, meta: 1, ext: 1 });
      expect(s.journal.verify({ heal: false })).toMatchObject({ ok: true, state: 'ok' });
      expect(s.warnings).toEqual([]);
    } finally {
      s.close();
    }
  });

  // ===============================================================================================
  // (2) THE RETRIED BEGIN: EVERY ATTEMPT IS A WHOLE TRANSACTION, AND ONLY ONE OF THEM COMMITS
  // ===============================================================================================

  /**
   * A contended `BEGIN IMMEDIATE` reports SQLITE_BUSY out of the same call the body's own failures
   * come out of, so an error carrying that code drives the retry loop exactly as a busy begin does
   * — with the body having run, which is what makes each attempt's settlement observable from
   * inside it. The real begin-side contention (the body never runs at all) is held by
   * `packages/cli/src/drivers/sqlite.test.ts`.
   */
  class BusyBegin extends Error {
    readonly code = 'SQLITE_BUSY';
  }

  it('a retried transaction settles EVERY attempt, and only the committed one is receipted', () => {
    const s = openStack();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      const sealed = fs.readFileSync(cpFile, 'utf8');
      const perAttempt: { id: number | undefined; write: Write; anchor: string | undefined }[] = [];
      const ran: string[] = [];
      const edges: string[] = [];
      let attempts = 0;

      const result = s.driver.writeTransaction(() => {
        const attempt = ++attempts;
        const observed = {
          id: s.driver.transactionId(),
          anchor: anchor(),
          write: s.memory.write([fact(`attempt ${attempt}`)], { now: 1 + attempt }),
        };
        perAttempt.push(observed);
        s.driver.afterCommit(() => ran.push(`after:${attempt}`));
        s.driver.onSettle((committed) => edges.push(`settle:${attempt}:${committed}`));
        if (attempt < 3) {
          throw new BusyBegin('database is locked');
        }
        return attempt;
      });

      expect(result).toBe(3);
      expect(attempts).toBe(3);

      // A FRESH TRANSACTION IDENTITY PER ATTEMPT — never a reused one, and never undefined
      const ids = perAttempt.map((a) => a.id);
      expect(ids.every((id) => typeof id === 'number')).toBe(true);
      expect(new Set(ids).size).toBe(3);
      expect([...ids].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(ids);
      expect(s.driver.transactionId()).toBeUndefined(); // retired the instant the last one settles

      // EACH ATTEMPT SETTLED EXACTLY ONCE, ON ITS OWN EDGE, IN ITS OWN ATTEMPT
      expect(edges).toEqual(['settle:1:false', 'settle:2:false', 'settle:3:true']);
      // and no failed attempt's after-commit work ever ran
      expect(ran).toEqual(['after:3']);

      // ONLY THE COMMITTED ATTEMPT HAS A RECEIPT
      expect(perAttempt.map((a) => a.write.outcome.state)).toEqual([
        'rolled-back',
        'rolled-back',
        'committed',
      ]);
      const receipts = committedReceipts(perAttempt.map((a) => a.write.outcome));
      expect(receipts).toHaveLength(1);
      expect(receipts[0]?.anchor).toBe('anchored');
      expect(receipts[0]?.ids).toEqual([perAttempt[2]?.write[0]?.id]);
      // the id the abandoned attempts released is the one the committed attempt took, and the row
      // standing at it is the committed attempt's — not a rerun of an earlier one
      expect(receipts[0]?.journalId).toBe(2);
      expect(s.driver.allJournal().find((r) => r.id === 2)?.hash).toBe(receipts[0]?.record.hash);

      // the discarded attempts left no rows, and the anchor stood still until one of them committed
      for (const a of perAttempt.slice(0, 2)) {
        expect(s.driver.getMemory(a.write[0]?.id ?? '')).toBeUndefined();
        expect(a.anchor).toBe(sealed);
      }
      expect(perAttempt[2]?.anchor).toBe(sealed);
      expect(s.driver.getMemory(perAttempt[2]?.write[0]?.id ?? '')).toBeDefined();
      expect(shape(s.driver)).toEqual({ rows: 2, memories: 1, meta: 2, ext: 2 });
      expect(fs.readFileSync(cpFile, 'utf8')).toBe(s.driver.getMeta(JOURNAL_CHECKPOINT_KEY));
      expect(s.journal.verify({ heal: false })).toMatchObject({ ok: true, state: 'ok' });
      expect(s.warnings).toEqual([]);
    } finally {
      s.close();
    }
  });

  it('a retry that exhausts its attempts settles them all rolled-back and publishes nothing', () => {
    const s = openStack();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      const sealed = fs.readFileSync(cpFile, 'utf8');
      const written: Write[] = [];
      const ran: string[] = [];
      const edges: string[] = [];
      let attempts = 0;

      expect(() =>
        s.driver.writeTransaction(() => {
          const attempt = ++attempts;
          written.push(s.memory.write([fact(`attempt ${attempt}`)], { now: 1 + attempt }));
          s.driver.afterCommit(() => ran.push(`after:${attempt}`));
          s.driver.onSettle((committed) => edges.push(`settle:${attempt}:${committed}`));
          throw new BusyBegin('database is locked');
        }),
      ).toThrow(BusyBegin);

      expect(attempts).toBe(3); // bounded, and every attempt answered for itself
      expect(edges).toEqual(['settle:1:false', 'settle:2:false', 'settle:3:false']);
      expect(ran).toEqual([]);
      expect(written.map((w) => w.outcome.state)).toEqual([
        'rolled-back',
        'rolled-back',
        'rolled-back',
      ]);
      expect(committedReceipts(written.map((w) => w.outcome))).toEqual([]);
      expect(anchor()).toBe(sealed);
      expect(shape(s.driver)).toEqual({ rows: 1, memories: 0, meta: 1, ext: 1 });
      expect(s.journal.verify({ heal: false })).toMatchObject({ ok: true, state: 'ok' });

      // and the store is writable again, with nothing of the abandoned attempts in it
      const next = s.memory.write([fact('after the retries')], { now: 9 });
      expect(next.outcome.state).toBe('committed');
      expect(committedReceipts([next.outcome])[0]?.anchor).toBe('anchored');
      expect(shape(s.driver)).toEqual({ rows: 2, memories: 1, meta: 2, ext: 2 });
      expect(s.warnings).toEqual([]);
    } finally {
      s.close();
    }
  });
});
