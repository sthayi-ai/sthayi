import fs from 'node:fs';
import path from 'node:path';
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
 * SAFETY: a MULTI-BATCH oracle consolidation is a SEQUENCE of independent durable commits, and
 * every one of them has to be inspected the moment it lands.
 *
 * THE HAZARD. Batch 1 applies changes and commits. Batch 2 then runs against whatever batch 1 left
 * behind. If batch 1 committed while the off-database anchor did not advance, the store has stopped
 * accepting writes, so batch 2's append is REFUSED — it throws, the whole run throws, and batch 1's
 * outcome goes with it. The caller sees `consolidate failed` and exit 1 over changes that are
 * already archived in the database: the one reading that invites the one response that duplicates
 * work, re-running the command. The same loss happens for any other mid-run failure once earlier
 * batches have committed.
 *
 * THE INVARIANT. The run inspects each batch before attempting the next: a committed-unanchored
 * batch STOPS the run and RETURNS the report (`ended: 'committed-unanchored'`, `batchesRun` below
 * `batches`), with the committed outcomes intact; and a throw that arrives after anything has
 * committed is re-raised as a typed {@link PartialOracleRunError} carrying every committed outcome
 * and the exact applied counts. A throw with nothing committed yet stays an ordinary failure.
 *
 * Real SQLite, a real FileCheckpoint, and the honest degraded state: a DIRECTORY at
 * `journal.checkpoint.lock`, which no O_CREAT|O_EXCL lock can ever take.
 */

/** 41 memories over MAX_BATCH = 40 is the smallest input that is genuinely two batches. */
const TWO_BATCH_COUNT = MAX_BATCH + 1;
const ORACLE_BATCH_OUTCOME_TIMEOUT = process.platform === 'win32' ? 20_000 : 5_000;

describe('safety: multi-batch oracle consolidation never loses a committed batch', () => {
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

  /** A provider that archives the FIRST memory of whichever batch it is handed. */
  const archiveFirstOfBatch = {
    id: 'mock:test',
    complete: async (_system: string, user: string): Promise<string> => {
      const batch = JSON.parse(user) as { items: { id: string }[] };
      return JSON.stringify({
        merge: [],
        archive: [batch.items[0]?.id],
        promote: [],
        contradictions: [],
      });
    },
  };

  function seed(s: ReturnType<typeof openStack>): void {
    for (let i = 0; i < TWO_BATCH_COUNT; i++) {
      s.memory.add(
        { type: 'semantic', content: `oracle fixture memory number ${i}` },
        { now: 100 + i, asProposal: false },
      );
    }
  }

  const runOpts = {
    now: 900,
    systemPrompt: 's',
    promptVersion: 'consolidate@v1',
    mask: (c: string) => c,
  };

  it(
    'a committed-unanchored FIRST batch stops the run and returns it — the second is never attempted',
    async () => {
      const s = openStack();
      try {
        expect(s.journal.seal('test', 1).ok).toBe(true);
        seed(s);
        fs.mkdirSync(`${cpFile}.lock`, { recursive: true });

        const rep = await s.consolidate.runOracle({ ...runOpts, provider: archiveFirstOfBatch });

        // It RETURNED. Throwing here would have erased the batch that just became durable.
        expect(rep.ended).toBe('committed-unanchored');
        expect(rep.batches).toBe(2);
        expect(rep.batchesRun).toBe(1);
        expect(rep.appliedBatches).toBe(1);
        expect(rep.changed).toBe(1);

        // …carrying the outcome, with all three facts a caller acts on
        const receipts = committedReceipts(rep.outcomes);
        expect(receipts).toHaveLength(1);
        expect(isDegradedReceipt(receipts[0])).toBe(true);
        expect(receipts[0]?.committed).toBe(true);
        expect(receipts[0]?.doNotRetry).toBe(true);
        expect(receipts[0]?.writesBlocked).toBe(true);

        // exactly ONE consolidate entry, and exactly one row archived: the second batch's
        // transaction never opened
        expect(s.driver.allJournal().filter((r) => r.op === 'consolidate')).toHaveLength(1);
        expect(s.driver.listMemories({ status: 'archived' })).toHaveLength(1);
      } finally {
        s.close();
      }
    },
    ORACLE_BATCH_OUTCOME_TIMEOUT,
  );

  it(
    'CONTROL: with a healthy anchor both batches run and the report says complete',
    async () => {
      const s = openStack();
      try {
        expect(s.journal.seal('test', 1).ok).toBe(true);
        seed(s);

        const rep = await s.consolidate.runOracle({ ...runOpts, provider: archiveFirstOfBatch });
        expect(rep.ended).toBe('complete');
        expect(rep.batches).toBe(2);
        expect(rep.batchesRun).toBe(2);
        expect(rep.appliedBatches).toBe(2);
        expect(rep.changed).toBe(2);
        expect(committedReceipts(rep.outcomes).every((r) => r.anchor === 'anchored')).toBe(true);
        expect(s.driver.listMemories({ status: 'archived' })).toHaveLength(2);
      } finally {
        s.close();
      }
    },
    ORACLE_BATCH_OUTCOME_TIMEOUT,
  );

  it(
    'a failure AFTER a batch committed throws the TYPED partial result, not a bare error',
    async () => {
      const s = openStack();
      try {
        expect(s.journal.seal('test', 1).ok).toBe(true);
        seed(s);
        // Batch 1 applies its archive; batch 2's store mutation fails. Everything batch 1 made
        // durable must survive the exception — it is already in the database.
        let updates = 0;
        const real = s.driver.updateMemory.bind(s.driver);
        vi.spyOn(s.driver, 'updateMemory').mockImplementation((id, patch) => {
          updates++;
          if (updates > 1) {
            throw new Error('injected updateMemory failure');
          }
          return real(id, patch);
        });

        const err: unknown = await s.consolidate
          .runOracle({ ...runOpts, provider: archiveFirstOfBatch })
          .then(
            () => undefined,
            (e: unknown) => e,
          );

        expect(err).toBeInstanceOf(PartialOracleRunError);
        const partial = err as PartialOracleRunError;
        // The typed result carries the run, not just the failure.
        expect(partial.report.ended).toBe('failed');
        expect(partial.report.batchesRun).toBe(2);
        expect(partial.report.batches).toBe(2);
        expect(partial.report.appliedBatches).toBe(1);
        expect(partial.report.changed).toBe(1);
        expect(committedReceipts(partial.report.outcomes)).toHaveLength(1);
        expect(committedReceipts(partial.report.outcomes)[0]?.record.op).toBe('consolidate');
        // the underlying cause is preserved, and the message states the durable half up front
        expect((partial.failure as Error).message).toMatch(/injected updateMemory failure/);
        expect(partial.message).toMatch(/1 change\(s\) already COMMITTED/);

        // and the durable half really is durable
        expect(s.driver.allJournal().filter((r) => r.op === 'consolidate')).toHaveLength(1);
        expect(s.driver.listMemories({ status: 'archived' })).toHaveLength(1);
      } finally {
        s.close();
      }
    },
    ORACLE_BATCH_OUTCOME_TIMEOUT,
  );

  it(
    'a failure with NOTHING committed yet stays an ordinary error — no false partial claim',
    async () => {
      const s = openStack();
      try {
        expect(s.journal.seal('test', 1).ok).toBe(true);
        seed(s);
        vi.spyOn(s.driver, 'updateMemory').mockImplementation(() => {
          throw new Error('injected updateMemory failure');
        });

        const err: unknown = await s.consolidate
          .runOracle({ ...runOpts, provider: archiveFirstOfBatch })
          .then(
            () => undefined,
            (e: unknown) => e,
          );

        // Claiming a partial result here would tell the caller that changes are durable when the
        // run archived nothing at all.
        expect(err).not.toBeInstanceOf(PartialOracleRunError);
        expect((err as Error).message).toMatch(/injected updateMemory failure/);
        expect(s.driver.allJournal().filter((r) => r.op === 'consolidate')).toHaveLength(0);
        expect(s.driver.listMemories({ status: 'archived' })).toHaveLength(0);
      } finally {
        s.close();
      }
    },
    ORACLE_BATCH_OUTCOME_TIMEOUT,
  );

  it(
    'a REJECTED batch that commits unanchored stops the run too — a rejection is still an append',
    async () => {
      const s = openStack();
      try {
        expect(s.journal.seal('test', 1).ok).toBe(true);
        seed(s);
        fs.mkdirSync(`${cpFile}.lock`, { recursive: true });
        // Invalid output applies nothing, but the `consolidate_rejected` entry it journals is a
        // write like any other — and its commit can be the unanchored one.
        const rep = await s.consolidate.runOracle({
          ...runOpts,
          provider: { id: 'mock:test', complete: async (): Promise<string> => 'not json at all' },
        });

        expect(rep.ended).toBe('committed-unanchored');
        expect(rep.batchesRun).toBe(1);
        expect(rep.rejectedBatches).toBe(1);
        expect(rep.changed).toBe(0);
        expect(isDegradedReceipt(committedReceipts(rep.outcomes)[0])).toBe(true);
        expect(s.driver.allJournal().filter((r) => r.op === 'consolidate_rejected')).toHaveLength(
          1,
        );
      } finally {
        s.close();
      }
    },
    ORACLE_BATCH_OUTCOME_TIMEOUT,
  );
});
