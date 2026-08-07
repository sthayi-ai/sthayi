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
 * SAFETY: A SAVEPOINT THAT UNWINDS RETURNS THE MIRROR EXEMPTION TO THE CHECKPOINT THE DATABASE KEPT
 * — HOWEVER MANY APPENDS IT MADE, AND HOWEVER DEEP THEY WERE NESTED.
 *
 * The external anchor is only allowed to lag while an append of the SAME open transaction is in
 * flight, and the {@link JournalService} mirror exemption is what records that. Its `minted` field
 * is the meta checkpoint that in-flight append wrote; the append gate consults it, and a value that
 * no longer matches the database drops the exemption. A dropped exemption is not merely a lost
 * tolerance: the next append of the still-open transaction then takes the HEALING branch of the
 * gate and advances the off-database anchor to a meta checkpoint the outer transaction can still
 * roll back. That is a published checkpoint for rows that may never exist — the one state the
 * anchor invariant exists to prevent, and it verifies RED forever once the outer transaction
 * unwinds.
 *
 * A savepoint may make MANY appends before it unwinds, at several depths, and it may adopt the
 * callbacks of a sibling savepoint that released into it. So the statements held here are:
 *
 *  1. THE RESTORED VALUE IS THE DATABASE'S, NOT A REMEMBERED ONE. Whatever sequence of appends the
 *     savepoint made, the exemption ends the unwind pointing at the checkpoint the database
 *     actually returned to — the settlement of one frame is a single fact about the database, so
 *     the number of appends that queued a restorer, and the order the restorers run in, cannot
 *     change the answer.
 *  2. THE ANCHOR IS BYTE-IDENTICAL FOR THE WHOLE OUTER TRANSACTION. Every step of every scenario
 *     below re-reads the checkpoint file: while the host transaction is open it holds exactly the
 *     bytes committed before it began.
 *  3. THE OUTER TRANSACTION STILL DECIDES. It commits and every surviving append is receipted and
 *     anchored; it rolls back and nothing is receipted, the anchor is untouched, and the store is
 *     immediately writable again. Verification is green either way.
 *
 * The single-inner-append shape, the released-savepoint edge and the callback framing itself are
 * covered by `journal-savepoint-settlement.test.ts`; the exemption's transaction binding by
 * `journal-tx-exemption.test.ts`.
 */
describe('safety: a rolled-back savepoint returns the exemption to the database checkpoint', () => {
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

  type Write = ReturnType<MemoryService['write']>;

  /** One scenario's observations: every anchor reading taken inside the host transaction, the
   *  writes the host kept, the writes the savepoints discarded, and the host's exemption token. */
  interface Run {
    sealed: string;
    anchors: (string | undefined)[];
    publishedInTransaction: boolean[];
    kept: Write[];
    discarded: Write[];
    tokenAtArm: string | undefined;
    tokenAfterUnwind: string | undefined;
  }

  /**
   * Seal a fresh store, then run `body` inside ONE host `writeTransaction` with the anchor watched
   * at every step. `body` receives a recorder it uses to mark each step; `ending` decides whether
   * the host commits or unwinds.
   */
  function runHost(
    s: Stack,
    ending: 'commit' | 'rollback',
    body: (run: Run, step: () => void) => void,
  ): Run {
    expect(s.journal.seal('test', 1).ok).toBe(true);
    const sealed = fs.readFileSync(cpFile, 'utf8');
    const run: Run = {
      sealed,
      anchors: [],
      publishedInTransaction: [],
      kept: [],
      discarded: [],
      tokenAtArm: undefined,
      tokenAfterUnwind: undefined,
    };
    const step = (): void => {
      run.anchors.push(anchor());
    };
    const restore = watchPublishes(s.driver, run.publishedInTransaction);
    try {
      const host = (): void => {
        step();
        body(run, step);
        step();
        if (ending === 'rollback') {
          throw new Error('host aborted');
        }
      };
      if (ending === 'rollback') {
        expect(() => s.driver.writeTransaction(host)).toThrow('host aborted');
      } else {
        s.driver.writeTransaction(host);
      }
    } finally {
      restore();
    }
    return run;
  }

  /** The three statements every scenario makes about the host transaction itself. */
  function expectHostIntact(s: Stack, run: Run): void {
    // (2) the anchor never moved while the host could still roll back
    expect(run.anchors).toEqual(run.anchors.map(() => run.sealed));
    expect(run.publishedInTransaction).not.toContain(true);
    // (1) the host's exemption is still the one its FIRST append armed: a re-armed exemption mints
    // a fresh token, so an unchanged token is the proof that the savepoints handed the host back
    // its own tolerance rather than a fresh one bound to an uncommitted checkpoint.
    expect(run.tokenAtArm).toBeTypeOf('string');
    expect(run.tokenAfterUnwind).toBe(run.tokenAtArm);
    // every savepoint append died with its savepoint, and stayed dead
    expect(run.discarded.map((w) => w.outcome.state)).toEqual(
      run.discarded.map(() => 'rolled-back'),
    );
    for (const w of run.discarded) {
      expect(s.driver.getMemory(w[0]?.id ?? '')).toBeUndefined();
    }
    expect(s.journal.verify({ heal: false })).toMatchObject({ ok: true, state: 'ok' });
    expect(s.warnings).toEqual([]);
  }

  /** (3) the host COMMITTED: every kept append is durable, receipted and anchored. */
  function expectHostCommitted(s: Stack, run: Run): void {
    expectHostIntact(s, run);
    expect(run.kept.map((w) => w.outcome.state)).toEqual(run.kept.map(() => 'committed'));
    const outcomes: MutationOutcome[] = [...run.kept, ...run.discarded].map((w) => w.outcome);
    const receipts = committedReceipts(outcomes);
    expect(receipts).toHaveLength(run.kept.length);
    for (const r of receipts) {
      expect(r.anchor).toBe('anchored');
      for (const w of run.discarded) {
        expect(r.ids).not.toContain(w[0]?.id);
      }
    }
    // one row for the seal plus one per surviving append; the anchor caught up with all of them
    const rows = run.kept.length + 1;
    expect(shape(s.driver)).toEqual({
      rows,
      memories: run.kept.length,
      meta: rows,
      ext: rows,
    });
    expect(fs.readFileSync(cpFile, 'utf8')).toBe(s.driver.getMeta(JOURNAL_CHECKPOINT_KEY));
  }

  /** (3) the host ROLLED BACK: nothing is durable, nothing is receipted, the anchor is untouched
   *  — and the store is immediately writable again. */
  function expectHostRolledBack(s: Stack, run: Run): void {
    expectHostIntact(s, run);
    expect(run.kept.map((w) => w.outcome.state)).toEqual(run.kept.map(() => 'rolled-back'));
    expect(committedReceipts([...run.kept, ...run.discarded].map((w) => w.outcome))).toEqual([]);
    expect(anchor()).toBe(run.sealed);
    expect(shape(s.driver)).toEqual({ rows: 1, memories: 0, meta: 1, ext: 1 });

    const next = s.memory.write([fact('after the unwind')], { now: 99 });
    expect(next.outcome.state).toBe('committed');
    expect(committedReceipts([next.outcome])[0]?.anchor).toBe('anchored');
    expect(shape(s.driver)).toEqual({ rows: 2, memories: 1, meta: 2, ext: 2 });
    expect(s.journal.verify({ heal: false })).toMatchObject({ ok: true, state: 'ok' });
  }

  /** `n` appends inside ONE savepoint that then unwinds, with the anchor read after each. */
  function batchSavepoint(s: Stack, run: Run, step: () => void, n: number, base: number): void {
    caughtSavepoint(s.driver, () => {
      for (let i = 0; i < n; i++) {
        run.discarded.push(s.memory.write([fact(`discarded ${base + i}`)], { now: base + i }));
        step();
      }
      throw new Error('savepoint aborted');
    });
    run.tokenAfterUnwind = s.driver.getMeta(JOURNAL_TX_TOKEN_KEY);
    step();
  }

  /** The host's first append, which is what arms the exemption the savepoints must hand back. */
  function hostArms(s: Stack, run: Run, step: () => void): void {
    run.kept.push(s.memory.write([fact('host one')], { now: 2 }));
    run.tokenAtArm = s.driver.getMeta(JOURNAL_TX_TOKEN_KEY);
    step();
  }

  // ===============================================================================================
  // (1) TWO APPENDS IN ONE SAVEPOINT — THE SMALLEST SHAPE A SINGLE-APPEND TEST CANNOT SEE
  // ===============================================================================================

  it('TWO appends in one rolled-back savepoint, then another host append, then COMMIT', () => {
    const s = openStack();
    try {
      const run = runHost(s, 'commit', (r, step) => {
        hostArms(s, r, step);
        batchSavepoint(s, r, step, 2, 10);
        r.kept.push(s.memory.write([fact('host two')], { now: 20 }));
        step();
      });
      expectHostCommitted(s, run);
      expect(committedReceipts(run.kept.map((w) => w.outcome)).map((r) => r.journalId)).toEqual([
        2, 3,
      ]);
    } finally {
      s.close();
    }
  });

  it('TWO appends in one rolled-back savepoint, then another host append, then ROLLBACK', () => {
    const s = openStack();
    try {
      const run = runHost(s, 'rollback', (r, step) => {
        hostArms(s, r, step);
        batchSavepoint(s, r, step, 2, 10);
        r.kept.push(s.memory.write([fact('host two')], { now: 20 }));
        step();
      });
      expectHostRolledBack(s, run);
    } finally {
      s.close();
    }
  });

  // ===============================================================================================
  // (2) THREE APPENDS — ONE MORE RESTORER THAN THERE ARE CHECKPOINTS TO GO BACK TO
  // ===============================================================================================

  it('THREE appends in one rolled-back savepoint, then another host append, then COMMIT', () => {
    const s = openStack();
    try {
      const run = runHost(s, 'commit', (r, step) => {
        hostArms(s, r, step);
        batchSavepoint(s, r, step, 3, 10);
        r.kept.push(s.memory.write([fact('host two')], { now: 20 }));
        step();
        r.kept.push(s.memory.write([fact('host three')], { now: 21 }));
        step();
      });
      expectHostCommitted(s, run);
      expect(committedReceipts(run.kept.map((w) => w.outcome)).map((r) => r.journalId)).toEqual([
        2, 3, 4,
      ]);
    } finally {
      s.close();
    }
  });

  it('THREE appends in one rolled-back savepoint, then another host append, then ROLLBACK', () => {
    const s = openStack();
    try {
      const run = runHost(s, 'rollback', (r, step) => {
        hostArms(s, r, step);
        batchSavepoint(s, r, step, 3, 10);
        r.kept.push(s.memory.write([fact('host two')], { now: 20 }));
        step();
      });
      expectHostRolledBack(s, run);
    } finally {
      s.close();
    }
  });

  // ===============================================================================================
  // (3) SEVERAL SAVEPOINTS IN A ROW — EACH UNWIND HANDS THE HOST THE SAME EXEMPTION BACK
  // ===============================================================================================

  it('two SEPARATE multi-append savepoints unwind in turn and the host still commits anchored', () => {
    const s = openStack();
    try {
      const run = runHost(s, 'commit', (r, step) => {
        hostArms(s, r, step);
        batchSavepoint(s, r, step, 2, 10);
        r.kept.push(s.memory.write([fact('host two')], { now: 20 }));
        step();
        batchSavepoint(s, r, step, 3, 30);
        r.kept.push(s.memory.write([fact('host three')], { now: 40 }));
        step();
      });
      expectHostCommitted(s, run);
    } finally {
      s.close();
    }
  });

  // ===============================================================================================
  // (4) NESTED SAVEPOINT LEVELS — THE INNER ONE UNWINDS, THEN THE OUTER ONE
  // ===============================================================================================

  it('MULTIPLE savepoint levels unwind innermost-first and the host commits anchored', () => {
    const s = openStack();
    try {
      const run = runHost(s, 'commit', (r, step) => {
        hostArms(s, r, step);
        caughtSavepoint(s.driver, () => {
          r.discarded.push(s.memory.write([fact('level one, a')], { now: 10 }));
          step();
          caughtSavepoint(s.driver, () => {
            r.discarded.push(s.memory.write([fact('level two, a')], { now: 11 }));
            step();
            r.discarded.push(s.memory.write([fact('level two, b')], { now: 12 }));
            step();
            throw new Error('level two aborted');
          });
          step();
          // the level-two unwind left level one holding ITS OWN checkpoint, so this append is an
          // ordinary continuation of the host transaction rather than a fresh arming
          r.discarded.push(s.memory.write([fact('level one, b')], { now: 13 }));
          step();
          throw new Error('level one aborted');
        });
        r.tokenAfterUnwind = s.driver.getMeta(JOURNAL_TX_TOKEN_KEY);
        step();
        r.kept.push(s.memory.write([fact('host two')], { now: 20 }));
        step();
      });
      expectHostCommitted(s, run);
      expect(run.discarded).toHaveLength(4);
    } finally {
      s.close();
    }
  });

  it('MULTIPLE savepoint levels unwind innermost-first and the host may still ROLL BACK', () => {
    const s = openStack();
    try {
      const run = runHost(s, 'rollback', (r, step) => {
        hostArms(s, r, step);
        caughtSavepoint(s.driver, () => {
          r.discarded.push(s.memory.write([fact('level one, a')], { now: 10 }));
          step();
          caughtSavepoint(s.driver, () => {
            r.discarded.push(s.memory.write([fact('level two, a')], { now: 11 }));
            step();
            r.discarded.push(s.memory.write([fact('level two, b')], { now: 12 }));
            step();
            throw new Error('level two aborted');
          });
          step();
          r.discarded.push(s.memory.write([fact('level one, b')], { now: 13 }));
          step();
          throw new Error('level one aborted');
        });
        r.tokenAfterUnwind = s.driver.getMeta(JOURNAL_TX_TOKEN_KEY);
        step();
        r.kept.push(s.memory.write([fact('host two')], { now: 20 }));
        step();
      });
      expectHostRolledBack(s, run);
      expect(run.discarded).toHaveLength(4);
    } finally {
      s.close();
    }
  });

  // ===============================================================================================
  // (5) A RELEASED SAVEPOINT'S APPENDS, ADOPTED BY A FRAME THAT THEN UNWINDS
  // ===============================================================================================

  it('a savepoint that ADOPTS a released child and then unwinds still hands the host its exemption', () => {
    const s = openStack();
    try {
      const run = runHost(s, 'commit', (r, step) => {
        hostArms(s, r, step);
        caughtSavepoint(s.driver, () => {
          r.discarded.push(s.memory.write([fact('doomed parent, a')], { now: 10 }));
          step();
          // RELEASES: its appends and its callbacks become the enclosing savepoint's, which then
          // unwinds and takes the adopted work down with its own
          s.driver.transaction(() => {
            r.discarded.push(s.memory.write([fact('released child, a')], { now: 11 }));
            step();
            r.discarded.push(s.memory.write([fact('released child, b')], { now: 12 }));
            step();
          });
          step();
          r.discarded.push(s.memory.write([fact('doomed parent, b')], { now: 13 }));
          step();
          throw new Error('parent savepoint aborted');
        });
        r.tokenAfterUnwind = s.driver.getMeta(JOURNAL_TX_TOKEN_KEY);
        step();
        r.kept.push(s.memory.write([fact('host two')], { now: 20 }));
        step();
      });
      expectHostCommitted(s, run);
      expect(run.discarded).toHaveLength(4);
    } finally {
      s.close();
    }
  });
});
