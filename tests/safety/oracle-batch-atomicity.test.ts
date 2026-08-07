import fs from 'node:fs';
import {
  ConsolidationService,
  JournalService,
  MAX_BATCH,
  MemoryService,
  PartialOracleRunError,
  VaultService,
  committedReceipts,
  isDegradedReceipt,
} from '@sthayi/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileCheckpoint } from '../../packages/cli/src/drivers/checkpoint-file.js';
import { NodeCrypto } from '../../packages/cli/src/drivers/crypto.js';
import { SqliteDriver } from '../../packages/cli/src/drivers/sqlite.js';
import { type FakeHome, createFakeHome } from '../helpers/fake-home.js';
import { removeOwned } from '../helpers/owned-fs.js';

/**
 * SAFETY: ONE oracle batch is ONE account. Every number a run reports has to name something that
 * is actually in the database.
 *
 * THE HAZARD. A batch produces more than changes: it also produces EVIDENCE — the contradiction
 * pairs it flagged, the merge groups it discarded, the ops whose targets moved. Written as separate
 * top-level appends after the changes had already committed, each of those was an INDEPENDENT
 * durable commit that could fail on its own, while the run's counters were incremented on either
 * side of them. So a single batch could archive a memory, commit the `consolidate` entry, have the
 * contradiction append REFUSED — and report `appliedBatches=0, changed=0, contradictions=1`: three
 * numbers, all false, over a memory that is durably archived and a contradiction that was never
 * journaled. A partial report exists precisely so a caller can trust what is durable; one that
 * miscounts is worse than none.
 *
 * THE INVARIANT. All of a batch's effects AND all of its evidence commit in ONE transaction, and
 * every counter is incremented only after that transaction has settled. The consequences are
 * checkable rather than described: the run's counts, the rows in `memories`, and the entries in
 * `journal` agree EXACTLY — after a clean batch, after a batch whose anchor did not advance, and
 * after a batch that failed midway with earlier batches already durable.
 *
 * Real SQLite, a real FileCheckpoint, and the honest degraded state: a DIRECTORY at
 * `journal.checkpoint.lock`, which no O_CREAT|O_EXCL lock can ever take.
 */

/** 42 memories over MAX_BATCH = 40: two batches, with the second holding the two in-batch ids a
 *  contradiction pair needs (the runner rejects a pair that reaches outside its own batch). */
const TWO_BATCH_COUNT = MAX_BATCH + 2;

describe('safety: one oracle batch commits as one account — counts, rows and entries agree', () => {
  let home: FakeHome;
  let cpFile: string;

  beforeEach(() => {
    home = createFakeHome();
    cpFile = home.path('journal.checkpoint');
  });
  afterEach(() => {
    vi.restoreAllMocks();
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

  /** `n` confirmed memories, plus `proposed` proposals after them — ids come back in seed order. */
  function seed(s: ReturnType<typeof openStack>, n: number, proposed = 0): string[] {
    const ids: string[] = [];
    for (let i = 0; i < n + proposed; i++) {
      ids.push(
        s.memory.add(
          { type: 'semantic', content: `oracle fixture memory number ${i}` },
          { now: 100 + i, asProposal: i >= n },
        ).id,
      );
    }
    return ids;
  }

  /** A provider that replies with one fixed op set, whatever batch it is handed. */
  function fixedProvider(ops: unknown, before?: () => void) {
    return {
      id: 'mock:test',
      complete: async (): Promise<string> => {
        // Runs BETWEEN the batch snapshot and the write transaction — the real window in which
        // the store can move under a batch.
        before?.();
        return JSON.stringify(ops);
      },
    };
  }

  const runOpts = {
    now: 900,
    systemPrompt: 's',
    promptVersion: 'consolidate@v1',
    mask: (c: string) => c,
  };

  /** Every count in the report, checked against what the store actually holds. */
  function expectAgreement(
    s: ReturnType<typeof openStack>,
    rep: {
      appliedBatches: number;
      changed: number;
      contradictions: number;
      skippedGroups: number;
      skippedOps: number;
    },
    expected: {
      changed: number;
      contradictions: number;
      skippedGroups: number;
      skippedOps: number;
      appliedBatches: number;
    },
  ): void {
    expect(rep.appliedBatches).toBe(expected.appliedBatches);
    expect(rep.changed).toBe(expected.changed);
    expect(rep.contradictions).toBe(expected.contradictions);
    expect(rep.skippedGroups).toBe(expected.skippedGroups);
    expect(rep.skippedOps).toBe(expected.skippedOps);

    const journal = s.driver.allJournal();
    // `changed` counts APPLIED changes, and every applied change is an archived row here.
    expect(s.driver.listMemories({ status: 'archived' })).toHaveLength(expected.changed);
    // one `consolidate` entry per batch that applied anything — never one without changes
    expect(journal.filter((r) => r.op === 'consolidate')).toHaveLength(expected.appliedBatches);
    // the contradiction evidence is journaled iff it was counted
    expect(journal.filter((r) => r.op === 'consolidate_contradictions')).toHaveLength(
      expected.contradictions > 0 ? 1 : 0,
    );
    // one `consolidate_rejected` per skipped-group tranche and per skipped-op tranche
    expect(journal.filter((r) => r.op === 'consolidate_rejected')).toHaveLength(
      (expected.skippedGroups > 0 ? 1 : 0) + (expected.skippedOps > 0 ? 1 : 0),
    );
  }

  it('applied changes + CONTRADICTIONS under a jammed anchor: both entries are durable, and the counts say so', async () => {
    const s = openStack();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      const ids = seed(s, 3);
      fs.mkdirSync(`${cpFile}.lock`, { recursive: true });

      const rep = await s.consolidate.runOracle({
        ...runOpts,
        provider: fixedProvider({
          merge: [],
          archive: [ids[0]],
          promote: [],
          contradictions: [{ a: ids[1], b: ids[2], reason: 'these two cannot both hold' }],
        }),
      });

      // The anchor never advanced, so the run stopped — but everything the batch produced is in
      // the database, and the report describes exactly that.
      expect(rep.ended).toBe('committed-unanchored');
      expect(rep.batchesRun).toBe(1);
      expectAgreement(s, rep, {
        appliedBatches: 1,
        changed: 1,
        contradictions: 1,
        skippedGroups: 0,
        skippedOps: 0,
      });

      // BOTH entries settled together: one transaction, one commit edge, one anchor verdict.
      const receipts = committedReceipts(rep.outcomes);
      expect(receipts).toHaveLength(2);
      expect(receipts.map((r) => r.record.op).sort()).toEqual([
        'consolidate',
        'consolidate_contradictions',
      ]);
      expect(receipts.every((r) => isDegradedReceipt(r))).toBe(true);
    } finally {
      s.close();
    }
  });

  it('applied changes + SKIPPED GROUPS under a jammed anchor: the discard is journaled with the change', async () => {
    const s = openStack();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      // two confirmed + one proposal: a merge group across that status boundary is discarded whole
      const ids = seed(s, 2, 1);
      fs.mkdirSync(`${cpFile}.lock`, { recursive: true });

      const rep = await s.consolidate.runOracle({
        ...runOpts,
        provider: fixedProvider({
          merge: [[ids[1], ids[2]]],
          archive: [ids[0]],
          promote: [],
          contradictions: [],
        }),
      });

      expect(rep.ended).toBe('committed-unanchored');
      expectAgreement(s, rep, {
        appliedBatches: 1,
        changed: 1,
        contradictions: 0,
        skippedGroups: 1,
        skippedOps: 0,
      });
      const receipts = committedReceipts(rep.outcomes);
      expect(receipts).toHaveLength(2);
      expect(receipts.every((r) => isDegradedReceipt(r))).toBe(true);
    } finally {
      s.close();
    }
  });

  it('applied changes + SKIPPED OPS under a jammed anchor: the skip is journaled with the change', async () => {
    const s = openStack();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      const ids = seed(s, 3);
      fs.mkdirSync(`${cpFile}.lock`, { recursive: true });

      const rep = await s.consolidate.runOracle({
        ...runOpts,
        // the third memory is REMOVED while the provider call is in flight, so the op that
        // targets it is skipped by the in-transaction re-read
        provider: fixedProvider(
          {
            merge: [],
            archive: [ids[0], ids[2]],
            promote: [],
            contradictions: [],
          },
          () => s.driver.deleteMemory(ids[2] as string),
        ),
      });

      expect(rep.ended).toBe('committed-unanchored');
      expectAgreement(s, rep, {
        appliedBatches: 1,
        changed: 1,
        contradictions: 0,
        skippedGroups: 0,
        skippedOps: 1,
      });
      const receipts = committedReceipts(rep.outcomes);
      expect(receipts).toHaveLength(2);
      expect(receipts.every((r) => isDegradedReceipt(r))).toBe(true);
    } finally {
      s.close();
    }
  });

  it('CONTROL: a healthy anchor applies changes and evidence together, anchored, with agreeing counts', async () => {
    const s = openStack();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      const ids = seed(s, 3);

      const rep = await s.consolidate.runOracle({
        ...runOpts,
        provider: fixedProvider({
          merge: [],
          archive: [ids[0]],
          promote: [],
          contradictions: [{ a: ids[1], b: ids[2], reason: 'these two cannot both hold' }],
        }),
      });

      expect(rep.ended).toBe('complete');
      expectAgreement(s, rep, {
        appliedBatches: 1,
        changed: 1,
        contradictions: 1,
        skippedGroups: 0,
        skippedOps: 0,
      });
      expect(committedReceipts(rep.outcomes).every((r) => r.anchor === 'anchored')).toBe(true);
    } finally {
      s.close();
    }
  });

  it('an EVIDENCE append that fails after an earlier batch committed unwinds its own batch WHOLE', async () => {
    const s = openStack();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      seed(s, TWO_BATCH_COUNT);
      // Batch 1 archives its first memory and commits. Batch 2 archives one and flags a
      // contradiction — and the contradiction entry is the append that fails. Batch 2 therefore
      // produced NOTHING durable, and the partial report must not credit it with anything.
      const realAppend = s.journal.append.bind(s.journal);
      vi.spyOn(s.journal, 'append').mockImplementation((draft, opts) => {
        if (draft.op === 'consolidate_contradictions') {
          throw new Error('injected contradiction append failure');
        }
        return realAppend(draft, opts);
      });
      let call = 0;
      const provider = {
        id: 'mock:test',
        complete: async (_system: string, user: string): Promise<string> => {
          const batch = JSON.parse(user) as { items: { id: string }[] };
          call++;
          return JSON.stringify(
            call === 1
              ? { merge: [], archive: [batch.items[0]?.id], promote: [], contradictions: [] }
              : {
                  merge: [],
                  archive: [batch.items[0]?.id],
                  promote: [],
                  contradictions: [
                    {
                      a: batch.items[0]?.id,
                      b: batch.items[1]?.id,
                      reason: 'flagged by the oracle',
                    },
                  ],
                },
          );
        },
      };

      const err: unknown = await s.consolidate.runOracle({ ...runOpts, provider }).then(
        () => undefined,
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(PartialOracleRunError);
      const partial = err as PartialOracleRunError;
      expect(partial.report.ended).toBe('failed');
      expect(partial.report.batchesRun).toBe(2);
      // ONLY batch 1 is durable: batch 2's archive, its `consolidate` entry and its contradiction
      // entry all unwound together.
      expectAgreement(s, partial.report, {
        appliedBatches: 1,
        changed: 1,
        contradictions: 0,
        skippedGroups: 0,
        skippedOps: 0,
      });
      expect(committedReceipts(partial.report.outcomes)).toHaveLength(1);
      expect(committedReceipts(partial.report.outcomes)[0]?.record.op).toBe('consolidate');
      expect((partial.failure as Error).message).toMatch(/injected contradiction append failure/);
    } finally {
      s.close();
    }
  });

  it('a batch whose contradiction reference is the ONLY output journals evidence with no consolidate entry', async () => {
    const s = openStack();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      const ids = seed(s, 3);

      const rep = await s.consolidate.runOracle({
        ...runOpts,
        provider: fixedProvider({
          merge: [],
          archive: [],
          promote: [],
          contradictions: [{ a: ids[0], b: ids[1], reason: 'observed, never applied' }],
        }),
      });

      // Nothing was applied, so there is no `consolidate` entry to hang the evidence off — the
      // contradiction is still journaled, and still counted exactly once.
      expect(rep.ended).toBe('complete');
      expectAgreement(s, rep, {
        appliedBatches: 0,
        changed: 0,
        contradictions: 1,
        skippedGroups: 0,
        skippedOps: 0,
      });
    } finally {
      s.close();
    }
  });
});
