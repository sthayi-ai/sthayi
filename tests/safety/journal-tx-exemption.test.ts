import fs from 'node:fs';
import {
  JOURNAL_CHECKPOINT_KEY,
  JOURNAL_TX_TOKEN_KEY,
  JournalService,
  MemoryService,
  type StorageDriver,
} from '@sthayi/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileCheckpoint } from '../../packages/cli/src/drivers/checkpoint-file.js';
import { NodeCrypto } from '../../packages/cli/src/drivers/crypto.js';
import { SqliteDriver } from '../../packages/cli/src/drivers/sqlite.js';
import { type FakeHome, createFakeHome } from '../helpers/fake-home.js';
import { removeOwned } from '../helpers/owned-fs.js';

/**
 * SAFETY: the external-mirror exemption belongs to ONE transaction and dies with it.
 *
 * THE HAZARD. The exemption is the ONE tolerance in the off-database anchor invariant: while an
 * append is in flight inside a transaction, the mirror is allowed not to have advanced yet. Any
 * exemption held at INSTANCE scope rather than TRANSACTION scope can be inherited across a
 * rollback boundary — a rolled-back transaction discards its afterCommit queue, so nothing on that
 * path would clear it — and a stale exemption excuses a permanently frozen anchor. That is exactly
 * the state that must never authorize a write.
 *
 * These probes exercise production wiring (real SQLite, real key-file crypto, real checkpoint file,
 * two connections) and jam the anchor with no privilege beyond writing the home: a DIRECTORY at
 * `journal.checkpoint.lock` makes the O_CREAT|O_EXCL lock impossible to take, permanently. The
 * hostile sequence is arm-inside-an-outer-transaction, force a rollback, jam the lock, let a second
 * connection burn the one post-gate write whose mirror may fail, then append again from the first.
 *
 * THE INVARIANT. The exemption is bound to the EXACT transaction that armed it and is cleared
 * on BOTH edges:
 *  - the driver's TRANSACTION IDENTITY (`StorageDriver.transactionId()`) when it has one, and its
 *    `onSettle` hook clears the exemption on commit AND on rollback (the SQLite driver implements
 *    both);
 *  - otherwise a TOKEN written into the meta table INSIDE that transaction. A rollback reverts the
 *    token with every other write of the transaction, so the surviving in-memory copy can never
 *    match again; a commit is closed by the afterCommit callback. A driver offering NEITHER hook
 *    gets no tolerance at all — its exemption is armed only for its strict effect (never publish a
 *    checkpoint for uncommitted rows), so its batched second append refuses.
 *  - plus the uncommitted meta checkpoint our own in-flight append minted, so the tolerance cannot
 *    outlive the append it describes.
 * Legitimate batched, nested and multi-process writes keep working; the third append of the
 * hostile sequence is refused and the store ends at 2/2/1.
 */
describe('safety: an external-mirror exemption never survives its transaction', () => {
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
  function openStack(driver: SqliteDriver = SqliteDriver.open(dbFile)): Stack {
    driver.migrate();
    const crypto = NodeCrypto.open(home.path('key'));
    const warnings: string[] = [];
    const journal = new JournalService(driver, {
      crypto,
      external: new FileCheckpoint(cpFile),
      warn: (m) => warnings.push(m),
    });
    return {
      driver,
      journal,
      memory: new MemoryService(driver, journal),
      warnings,
      close: () => driver.close(),
    };
  }

  /** A second JournalService over the SAME connection — a fresh instance must inherit nothing. */
  function secondJournal(driver: StorageDriver): JournalService {
    return new JournalService(driver, {
      crypto: NodeCrypto.open(home.path('key')),
      external: new FileCheckpoint(cpFile),
      warn: () => {},
    });
  }

  /** Jam every checkpoint replacement, permanently and deterministically. */
  function jamLock(): void {
    fs.mkdirSync(`${cpFile}.lock`, { recursive: true });
  }

  function count(raw: string | undefined): number | undefined {
    return raw === undefined ? undefined : (JSON.parse(raw) as { count: number }).count;
  }
  function extCount(): number | undefined {
    return count(fs.existsSync(cpFile) ? fs.readFileSync(cpFile, 'utf8') : undefined);
  }
  function metaCount(driver: SqliteDriver): number | undefined {
    return count(driver.getMeta(JOURNAL_CHECKPOINT_KEY));
  }

  const draft = (ts: number, tag = 'x') => ({
    ts,
    actor: 'cli',
    op: 'memory_write',
    payload: { ids: [] as string[], tag },
  });

  /** State of the whole store as one triple: database rows, meta checkpoint, external anchor. */
  function shape(driver: SqliteDriver): { rows: number; meta?: number; ext?: number } {
    return { rows: driver.allJournal().length, meta: metaCount(driver), ext: extCount() };
  }

  // =============================================================================================
  // THE HOSTILE SEQUENCE
  // =============================================================================================

  it('a FORCE-ROLLED-BACK transaction leaves no exemption: the later transaction REFUSES (2/2/1)', () => {
    const a = openStack();
    expect(a.journal.seal('test', 1).ok).toBe(true);
    const sealToken = a.driver.getMeta(JOURNAL_TX_TOKEN_KEY);
    expect(sealToken).toBeTypeOf('string');
    const b = openStack();
    try {
      // A appends inside an OUTER transaction that is then forcibly rolled back.
      expect(() =>
        a.driver.writeTransaction(() => {
          a.journal.append(draft(2, 'doomed'));
          throw new Error('forced rollback');
        }),
      ).toThrow('forced rollback');
      expect(a.driver.allJournal()).toHaveLength(1);
      // The token that identified the rolled-back transaction went away WITH it: the meta cell
      // still holds the SEAL's token, never the doomed transaction's.
      expect(a.driver.getMeta(JOURNAL_TX_TOKEN_KEY)).toBe(sealToken);

      jamLock();

      // B: the single post-gate committed write whose mirror the jam defeats.
      b.journal.append(draft(3, 'peer'));
      expect(shape(b.driver)).toEqual({ rows: 2, meta: 2, ext: 1 });

      // A's NEW outer transaction must NOT inherit the exemption.
      expect(() =>
        a.driver.writeTransaction(() => {
          a.journal.append(draft(4, 'must refuse'));
        }),
      ).toThrow(/refusing to append.*external journal checkpoint is STALE/s);

      expect(shape(a.driver)).toEqual({ rows: 2, meta: 2, ext: 1 });
      // and it stays refused, however many times it is retried
      for (const ts of [5, 6]) {
        expect(() =>
          a.driver.writeTransaction(() => {
            a.journal.append(draft(ts));
          }),
        ).toThrow(/refusing to append/);
      }
      expect(shape(a.driver)).toEqual({ rows: 2, meta: 2, ext: 1 });
    } finally {
      a.close();
      b.close();
    }
  });

  it('a BYTE-IDENTICAL peer replay of the rolled-back entry does not resurrect the exemption', () => {
    // The binding is not "the checkpoint looks like the one my append minted": a peer that commits
    // the very same entry produces the very same checkpoint bytes. Only the transaction token
    // (reverted by the rollback) separates the two, which is why the token exists.
    const a = openStack();
    expect(a.journal.seal('test', 1).ok).toBe(true);
    const b = openStack();
    try {
      const identical = { ts: 2, actor: 'cli', op: 'memory_write', payload: { ids: [] } };
      expect(() =>
        a.driver.writeTransaction(() => {
          a.journal.append(identical);
          throw new Error('forced rollback');
        }),
      ).toThrow('forced rollback');
      jamLock();
      b.journal.append(identical); // same draft ⇒ same hash ⇒ same checkpoint bytes
      expect(shape(b.driver)).toEqual({ rows: 2, meta: 2, ext: 1 });

      expect(() =>
        a.driver.writeTransaction(() => {
          a.journal.append(draft(3));
        }),
      ).toThrow(/refusing to append.*external journal checkpoint is STALE/s);
      expect(shape(a.driver)).toEqual({ rows: 2, meta: 2, ext: 1 });
    } finally {
      a.close();
      b.close();
    }
  });

  it('a FRESH JournalService on the same connection inherits nothing after a rollback', () => {
    const a = openStack();
    expect(a.journal.seal('test', 1).ok).toBe(true);
    const b = openStack();
    try {
      expect(() =>
        a.driver.writeTransaction(() => {
          a.journal.append(draft(2, 'doomed'));
          throw new Error('forced rollback');
        }),
      ).toThrow('forced rollback');
      jamLock();
      b.journal.append(draft(3, 'peer'));

      const fresh = secondJournal(a.driver);
      expect(() =>
        a.driver.writeTransaction(() => {
          fresh.append(draft(4));
        }),
      ).toThrow(/refusing to append.*external journal checkpoint is STALE/s);
      expect(shape(a.driver)).toEqual({ rows: 2, meta: 2, ext: 1 });
    } finally {
      a.close();
      b.close();
    }
  });

  it('a COMMIT that fails after the body completed leaves no reusable exemption', () => {
    // Observationally the commit-failure case: every append in the body succeeded, and the
    // transaction still rolled back — so the afterCommit queue was discarded exactly as a forced
    // rollback discards it, and nothing outside the database ever saw the batch.
    const a = openStack();
    expect(a.journal.seal('test', 1).ok).toBe(true);
    const b = openStack();
    try {
      class CommitFailure extends Error {}
      expect(() =>
        a.driver.writeTransaction(() => {
          a.journal.append(draft(2, 'one'));
          a.journal.append(draft(3, 'two'));
          throw new CommitFailure('COMMIT failed');
        }),
      ).toThrow(CommitFailure);
      expect(a.driver.allJournal()).toHaveLength(1);
      jamLock();
      b.journal.append(draft(4, 'peer'));

      expect(() =>
        a.driver.writeTransaction(() => {
          a.journal.append(draft(5));
        }),
      ).toThrow(/refusing to append.*external journal checkpoint is STALE/s);
      expect(shape(a.driver)).toEqual({ rows: 2, meta: 2, ext: 1 });
    } finally {
      a.close();
      b.close();
    }
  });

  it('a rolled-back NESTED transaction is no different: the outer rollback kills the exemption', () => {
    const a = openStack();
    expect(a.journal.seal('test', 1).ok).toBe(true);
    const b = openStack();
    try {
      expect(() =>
        a.driver.writeTransaction(() => {
          // an inner writeTransaction JOINS the outer one — its appends are the outer's appends
          a.driver.writeTransaction(() => {
            a.memory.add({ type: 'semantic', content: 'nested fact' }, { now: 2 });
          });
          a.journal.append(draft(3, 'outer'));
          throw new Error('outer aborted');
        }),
      ).toThrow('outer aborted');
      expect(a.driver.allJournal()).toHaveLength(1);
      expect(a.driver.countMemories()).toBe(0);

      jamLock();
      b.journal.append(draft(4, 'peer'));

      expect(() =>
        a.driver.writeTransaction(() =>
          a.driver.writeTransaction(() => {
            a.journal.append(draft(5));
          }),
        ),
      ).toThrow(/refusing to append.*external journal checkpoint is STALE/s);
      expect(shape(a.driver)).toEqual({ rows: 2, meta: 2, ext: 1 });
    } finally {
      a.close();
      b.close();
    }
  });

  it('an open transaction buys nothing: with the anchor already frozen the FIRST append refuses', () => {
    const a = openStack();
    expect(a.journal.seal('test', 1).ok).toBe(true);
    const b = openStack();
    try {
      jamLock();
      b.journal.append(draft(2, 'peer')); // freezes the anchor one behind, across a commit
      expect(shape(b.driver)).toEqual({ rows: 2, meta: 2, ext: 1 });
      expect(() =>
        a.driver.writeTransaction(() => {
          a.journal.append(draft(3, 'first of a batch'));
          a.journal.append(draft(4, 'never reached'));
        }),
      ).toThrow(/refusing to append.*external journal checkpoint is STALE/s);
      expect(shape(a.driver)).toEqual({ rows: 2, meta: 2, ext: 1 });
    } finally {
      a.close();
      b.close();
    }
  });

  // =============================================================================================
  // CONTROLS — the exemption must still do its job for legitimate work
  // =============================================================================================

  it('CONTROL: many appends in ONE transaction succeed and the anchor ends exactly current', () => {
    const s = openStack();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      const publishedInTransaction: boolean[] = [];
      const raw = FileCheckpoint.prototype.replace;
      (FileCheckpoint.prototype as { replace: typeof raw }).replace = function spy(
        this: FileCheckpoint,
        expected: string | undefined,
        next: string,
        opts?: { force?: boolean },
      ): boolean {
        publishedInTransaction.push(s.driver.inTransaction());
        return raw.call(this, expected, next, opts);
      } as typeof raw;
      try {
        s.driver.writeTransaction(() => {
          for (const ts of [2, 3, 4, 5, 6, 7]) {
            s.memory.add({ type: 'semantic', content: `batched fact ${ts}` }, { now: ts });
          }
        });
      } finally {
        (FileCheckpoint.prototype as { replace: typeof raw }).replace = raw;
      }
      expect(s.driver.countMemories()).toBe(6);
      expect(shape(s.driver)).toEqual({ rows: 7, meta: 7, ext: 7 });
      expect(fs.readFileSync(cpFile, 'utf8')).toBe(s.driver.getMeta(JOURNAL_CHECKPOINT_KEY));
      expect(s.journal.verify({ heal: false })).toMatchObject({ ok: true, state: 'ok' });
      // nothing was published while the transaction could still roll back
      expect(publishedInTransaction).not.toContain(true);
      // and the transaction token did not outlive the batch as a reusable exemption
      expect(s.journal.verify()).toMatchObject({ ok: true, state: 'ok' });
    } finally {
      s.close();
    }
  });

  it('CONTROL: NESTED transactions commit, and writes keep working afterwards', () => {
    const s = openStack();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      s.driver.writeTransaction(() => {
        s.memory.add({ type: 'semantic', content: 'outer fact' }, { now: 2 });
        s.driver.writeTransaction(() => {
          s.memory.add({ type: 'semantic', content: 'inner fact' }, { now: 3 });
          s.driver.writeTransaction(() => {
            s.memory.add({ type: 'semantic', content: 'innermost fact' }, { now: 4 });
          });
        });
      });
      expect(shape(s.driver)).toEqual({ rows: 4, meta: 4, ext: 4 });
      s.memory.add({ type: 'semantic', content: 'after the batch' }, { now: 5 });
      expect(shape(s.driver)).toEqual({ rows: 5, meta: 5, ext: 5 });
      expect(s.journal.verify({ heal: false })).toMatchObject({ ok: true, state: 'ok' });
    } finally {
      s.close();
    }
  });

  it('CONTROL: a rolled-back batch on a HEALTHY anchor leaves the store writable', () => {
    const s = openStack();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      const before = fs.readFileSync(cpFile, 'utf8');
      expect(() =>
        s.driver.writeTransaction(() => {
          s.memory.add({ type: 'semantic', content: 'doomed' }, { now: 2 });
          throw new Error('caller aborted');
        }),
      ).toThrow('caller aborted');
      expect(fs.readFileSync(cpFile, 'utf8')).toBe(before);
      s.memory.add({ type: 'semantic', content: 'a real fact' }, { now: 3 });
      expect(shape(s.driver)).toEqual({ rows: 2, meta: 2, ext: 2 });
      expect(s.journal.verify({ heal: false })).toMatchObject({ ok: true, state: 'ok' });
    } finally {
      s.close();
    }
  });

  // =============================================================================================
  // THE PORT: the driver's transaction lifecycle/identity
  // =============================================================================================

  /**
   * Record the settlement edge the driver reports for ONE outermost transaction. Registered from
   * INSIDE the body, because `onSettle` outside a transaction has nothing to wait for and answers
   * `true` immediately.
   */
  function watchSettlement(driver: SqliteDriver, edges: boolean[]): void {
    driver.onSettle((committed) => edges.push(committed));
  }

  it('the driver reports the ROLLBACK edge, and the exemption dies with the transaction', () => {
    const a = openStack();
    expect(a.journal.seal('test', 1).ok).toBe(true);
    const b = openStack();
    try {
      const edges: boolean[] = [];
      const doomedId = { value: undefined as number | undefined };
      expect(() =>
        a.driver.writeTransaction(() => {
          watchSettlement(a.driver, edges);
          doomedId.value = a.driver.transactionId();
          a.journal.append(draft(2, 'doomed'));
          throw new Error('forced rollback');
        }),
      ).toThrow('forced rollback');
      // the ROLLBACK edge — the edge afterCommit cannot report at all
      expect(edges).toEqual([false]);
      // identity is retired the instant the transaction settles
      expect(doomedId.value).toBeTypeOf('number');
      expect(a.driver.transactionId()).toBeUndefined();

      jamLock();
      b.journal.append(draft(3, 'peer'));

      const laterId = { value: undefined as number | undefined };
      expect(() =>
        a.driver.writeTransaction(() => {
          laterId.value = a.driver.transactionId();
          a.journal.append(draft(4));
        }),
      ).toThrow(/refusing to append.*external journal checkpoint is STALE/s);
      // a NEW transaction is a DIFFERENT transaction: the identity never repeats, which is what
      // makes an exemption minted by the dead one unmatchable rather than merely unlikely
      expect(laterId.value).toBeTypeOf('number');
      expect(laterId.value).not.toBe(doomedId.value);
      expect(shape(a.driver)).toEqual({ rows: 2, meta: 2, ext: 1 });
    } finally {
      a.close();
      b.close();
    }
  });

  it('the driver reports the COMMIT edge once for a whole batch, and batching still works', () => {
    const s = openStack();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      const edges: boolean[] = [];
      const outerId = { value: undefined as number | undefined };
      const innerIds: (number | undefined)[] = [];
      s.driver.writeTransaction(() => {
        watchSettlement(s.driver, edges);
        outerId.value = s.driver.transactionId();
        for (const ts of [2, 3, 4]) {
          s.driver.writeTransaction(() => {
            // a JOINED write is the SAME transaction — same identity, no second settlement
            innerIds.push(s.driver.transactionId());
            s.memory.add({ type: 'semantic', content: `lifecycle fact ${ts}` }, { now: ts });
          });
        }
      });
      expect(edges).toEqual([true]);
      expect(innerIds).toEqual([outerId.value, outerId.value, outerId.value]);
      expect(s.driver.transactionId()).toBeUndefined();
      expect(shape(s.driver)).toEqual({ rows: 4, meta: 4, ext: 4 });
      expect(s.journal.verify({ heal: false })).toMatchObject({ ok: true, state: 'ok' });
    } finally {
      s.close();
    }
  });

  it('a driver with NO settle hook at all gets no exemption — it fails closed, never open', () => {
    // Nothing would clear an exemption at the commit edge on such a driver, so it is never armed:
    // its batched appends refuse rather than ride on a token that outlived its transaction.
    const bare = SqliteDriver.open(dbFile);
    const stripped = bare as unknown as { afterCommit?: unknown; onSettle?: unknown };
    stripped.afterCommit = undefined;
    stripped.onSettle = undefined;
    const s = openStack(bare);
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      expect(() =>
        s.driver.writeTransaction(() => {
          s.journal.append(draft(2, 'first'));
          s.journal.append(draft(3, 'second'));
        }),
      ).toThrow(/refusing to append/);
      expect(s.driver.allJournal()).toHaveLength(1);
    } finally {
      s.close();
    }
  });
});
