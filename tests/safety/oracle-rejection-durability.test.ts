import {
  ConsolidationService,
  JournalService,
  MAX_BATCH,
  MemoryService,
  PartialOracleRunError,
  VaultService,
  committedReceipts,
} from '@sthayi/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileCheckpoint } from '../../packages/cli/src/drivers/checkpoint-file.js';
import { NodeCrypto } from '../../packages/cli/src/drivers/crypto.js';
import { SqliteDriver } from '../../packages/cli/src/drivers/sqlite.js';
import { type FakeHome, createFakeHome } from '../helpers/fake-home.js';
import { removeOwned } from '../helpers/owned-fs.js';

/**
 * SAFETY: A REJECTED BATCH IS COUNTED WHEN ITS REJECTION IS DURABLE, not when the model said no.
 *
 * THE HAZARD. `rejectedBatches` is a DURABLE counter on a report a caller is meant to trust:
 * {@link PartialOracleRunError} exists precisely so that, after a multi-batch run dies partway, the
 * numbers it carries still describe the database. Incremented BEFORE the `consolidate_rejected`
 * append, it describes the model's verdict instead — and when that append is the thing that fails,
 * the partial report goes out saying one batch was rejected while the journal holds ZERO rejection
 * entries. The one reader who most needs the truth (someone deciding what a half-finished run left
 * behind) is handed a rejection that was never recorded and cannot be found.
 *
 * THE INVARIANT. `rejectedBatches` equals the number of `consolidate_rejected` entries this run
 * actually put in the journal — checked against the rows, the entries, the receipts and the other
 * counters at the same time, on the failing path AND on the healthy one that proves the counter
 * still counts.
 *
 * Real SQLite, a real FileCheckpoint, two real batches.
 */

/** 42 memories over MAX_BATCH = 40: two batches, so batch 1 can commit before batch 2 fails. */
const TWO_BATCH_COUNT = MAX_BATCH + 2;

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
    memory: new MemoryService(driver, journal, vault),
    consolidate: new ConsolidationService(driver, journal, vault),
    close: (): void => driver.close(),
  };
}

function seed(s: ReturnType<typeof openStack>, n: number): void {
  for (let i = 0; i < n; i++) {
    s.memory.add(
      { type: 'semantic', content: `oracle fixture memory number ${i}` },
      { now: 100 + i, asProposal: false },
    );
  }
}

/** Batch 1 archives its first item; batch 2 answers with output that cannot be applied at all. */
function twoBatchProvider() {
  let call = 0;
  return {
    id: 'mock:test',
    complete: async (_system: string, user: string): Promise<string> => {
      const batch = JSON.parse(user) as { items: { id: string }[] };
      call++;
      return call === 1
        ? JSON.stringify({
            merge: [],
            archive: [batch.items[0]?.id],
            promote: [],
            contradictions: [],
          })
        : 'this is not JSON at all';
    },
  };
}

const runOpts = {
  now: 900,
  systemPrompt: 's',
  promptVersion: 'consolidate@v1',
  mask: (c: string) => c,
};

/** Every durable counter on the report, against what the store actually holds. */
function expectAgreement(
  s: ReturnType<typeof openStack>,
  rep: {
    appliedBatches: number;
    rejectedBatches: number;
    changed: number;
    contradictions: number;
    skippedGroups: number;
    skippedOps: number;
  },
  expected: { appliedBatches: number; rejectedBatches: number; changed: number },
): void {
  expect(rep.appliedBatches).toBe(expected.appliedBatches);
  expect(rep.rejectedBatches).toBe(expected.rejectedBatches);
  expect(rep.changed).toBe(expected.changed);
  expect(rep.contradictions).toBe(0);
  expect(rep.skippedGroups).toBe(0);
  expect(rep.skippedOps).toBe(0);

  const entries = s.driver.allJournal();
  expect(s.driver.listMemories({ status: 'archived' })).toHaveLength(expected.changed);
  expect(entries.filter((r) => r.op === 'consolidate')).toHaveLength(expected.appliedBatches);
  // THE COUNTER IS THE ROW COUNT: a rejection that is counted is a rejection that is findable.
  expect(entries.filter((r) => r.op === 'consolidate_rejected')).toHaveLength(
    expected.rejectedBatches,
  );
  expect(entries.filter((r) => r.op === 'consolidate_contradictions')).toHaveLength(0);
}

describe('safety: the oracle rejection count describes the journal, not the model verdict', () => {
  it('a consolidate_rejected append that FAILS after an earlier batch committed is not counted', async () => {
    const s = openStack();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      seed(s, TWO_BATCH_COUNT);
      const realAppend = s.journal.append.bind(s.journal);
      vi.spyOn(s.journal, 'append').mockImplementation((draft, opts) => {
        if (draft.op === 'consolidate_rejected') {
          throw new Error('injected consolidate_rejected append failure');
        }
        return realAppend(draft, opts);
      });

      const err: unknown = await s.consolidate
        .runOracle({ ...runOpts, provider: twoBatchProvider() })
        .then(
          () => undefined,
          (e: unknown) => e,
        );

      expect(err).toBeInstanceOf(PartialOracleRunError);
      const partial = err as PartialOracleRunError;
      expect(partial.report.ended).toBe('failed');
      expect(partial.report.batches).toBe(2);
      expect(partial.report.batchesRun).toBe(2);
      // Batch 1 is durable; batch 2's rejection never reached the journal, so it is not a
      // rejection this run may claim.
      expectAgreement(s, partial.report, {
        appliedBatches: 1,
        rejectedBatches: 0,
        changed: 1,
      });
      // One append, one outcome, one receipt — the failed append contributed no handle.
      expect(partial.report.outcomes).toHaveLength(1);
      const receipts = committedReceipts(partial.report.outcomes);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]?.record.op).toBe('consolidate');
      expect(receipts[0]?.anchor).toBe('anchored');
      expect((partial.failure as Error).message).toMatch(
        /injected consolidate_rejected append failure/,
      );
    } finally {
      s.close();
    }
  }, 15_000);

  it('CONTROL: the same run with a working append counts the rejection and journals it', async () => {
    const s = openStack();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      seed(s, TWO_BATCH_COUNT);

      const rep = await s.consolidate.runOracle({ ...runOpts, provider: twoBatchProvider() });

      expect(rep.ended).toBe('complete');
      expect(rep.batchesRun).toBe(2);
      expectAgreement(s, rep, { appliedBatches: 1, rejectedBatches: 1, changed: 1 });
      const receipts = committedReceipts(rep.outcomes);
      expect(receipts).toHaveLength(2);
      expect(receipts.map((r) => r.record.op).sort()).toEqual([
        'consolidate',
        'consolidate_rejected',
      ]);
    } finally {
      s.close();
    }
  });

  it('a rejection that fails with NOTHING yet committed propagates as an ordinary failure', async () => {
    const s = openStack();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      seed(s, 3);
      const realAppend = s.journal.append.bind(s.journal);
      vi.spyOn(s.journal, 'append').mockImplementation((draft, opts) => {
        if (draft.op === 'consolidate_rejected') {
          throw new Error('injected consolidate_rejected append failure');
        }
        return realAppend(draft, opts);
      });

      const err: unknown = await s.consolidate
        .runOracle({
          ...runOpts,
          provider: { id: 'mock:test', complete: async (): Promise<string> => 'not JSON' },
        })
        .then(
          () => undefined,
          (e: unknown) => e,
        );

      // Nothing durable, so there is no partial report to carry — and nothing in the journal
      // for a counter to have described.
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(PartialOracleRunError);
      expect(s.driver.allJournal().filter((r) => r.op === 'consolidate_rejected')).toHaveLength(0);
      expect(s.driver.listMemories({ status: 'archived' })).toHaveLength(0);
    } finally {
      s.close();
    }
  });
});
