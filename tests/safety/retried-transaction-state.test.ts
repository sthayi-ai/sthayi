import {
  ConsolidationService,
  JournalService,
  MemoryService,
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
 * SAFETY: A RETRIED TRANSACTION IS A FRESH ATTEMPT, AND ONLY THE ATTEMPT THAT COMMITTED COUNTS.
 *
 * THE HAZARD. `SqliteDriver.runOutermost` retries the WHOLE body on SQLITE_BUSY — up to three
 * attempts — and every attempt before the last one ROLLED BACK: its rows are gone and its journal
 * row is gone with them. State that lives OUTSIDE the callback survives that rollback, so an array
 * the body appends to accumulates one entry per ATTEMPT rather than one per committed row. A
 * confirm of a single proposal that hits one busy retry then returns that id TWICE, journals it
 * TWICE in the `memory_confirm` payload, and puts it in the CommitReceipt twice — while exactly one
 * row is durable. Every one of those is a durable-looking receipt for a transition that happened
 * once, and the id list is what a caller replays, reconciles, or shows a user.
 *
 * THE INVARIANT. Per-attempt mutable state lives INSIDE the transaction body, so the value that
 * escapes belongs to the attempt that committed and to no other. What is returned, what is
 * journaled, what the receipt carries, and what the database holds are the same set.
 *
 * Real SQLite, a real FileCheckpoint, and a real retry: the injected failure carries the very code
 * (`SQLITE_BUSY`) the driver's retry loop keys on, thrown after a REAL append has run inside the
 * attempt, so the rollback and the re-run are the driver's own.
 */

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

/**
 * Make the next `times` appends of `op` fail the way a contended writer does: the append itself
 * runs FOR REAL (so the attempt is a complete one — rows updated, entry written) and only then
 * throws with the code `runOutermost` retries on. better-sqlite3 rolls the attempt back and the
 * driver runs the body again, which is exactly the sequence a real SQLITE_BUSY produces.
 */
function injectBusy(journal: JournalService, op: string, times: number): { count: () => number } {
  const real = journal.append.bind(journal);
  let injected = 0;
  vi.spyOn(journal, 'append').mockImplementation((draft, opts) => {
    const handle = real(draft, opts);
    if (draft.op === op && injected < times) {
      injected++;
      const err = new Error('injected SQLITE_BUSY') as Error & { code: string };
      err.code = 'SQLITE_BUSY';
      throw err;
    }
    return handle;
  });
  return { count: (): number => injected };
}

const NOW = 1_000;

/**
 * THE MASKING WARNINGS ARE PER-ATTEMPT STATE TOO, and the array they land in belongs to the
 * CALLER — `WriteOptions.warnings`, which the CLI prints under `sthayi add` and the MCP server
 * publishes as `structuredContent.warnings`. Passed INTO the transaction body, one busy retry
 * masks the same draft twice and pushes the same warning twice, over exactly one durable memory
 * and exactly one durable `memory_write` entry: the user is told a second secret was masked,
 * a second pseudonym minted, when neither happened.
 *
 * `memory_write` is the injection point that reproduces it. Masking runs BEFORE the append
 * inside `write()`, so the harness's real-then-throw append leaves a COMPLETE attempt behind it
 * — draft masked, warning pushed, row inserted, entry written — which is precisely the state a
 * real SQLITE_BUSY unwinds. An injection any EARLIER (at the vault's own `allocate` append, or
 * anywhere before the mask) would throw before the masking it is supposed to duplicate ever
 * ran, so the retry would find nothing to repeat and the probe would pass over the live defect.
 */
const EMAIL_DRAFT = { type: 'semantic' as const, content: 'reach me at probe@example.com' };
const ONE_WARNING = ['masked a EMAIL at write → EMAIL_01'];
const PHONE_DRAFT = { type: 'semantic' as const, content: 'call me on 555-123-4567' };
const PHONE_WARNING = ['masked a PHONE at write → PHONE_01'];

describe('safety: a retried write transaction reports only the attempt that committed', () => {
  for (const retries of [1, 2]) {
    it(`confirm survives ${retries} busy retr${retries === 1 ? 'y' : 'ies'} without duplicating an id`, () => {
      const s = openStack();
      try {
        expect(s.journal.seal('test', 1).ok).toBe(true);
        const m = s.memory.add({ type: 'semantic', content: 'one proposal' }, { now: NOW });
        const busy = injectBusy(s.journal, 'memory_confirm', retries);

        const ids = s.memory.confirm([m.id], { now: NOW + 1 });

        expect(busy.count()).toBe(retries);
        // ONE proposal transitioned once — the returned list says so exactly.
        expect(ids).toEqual([m.id]);
        expect(s.driver.getMemory(m.id)?.status).toBe('confirmed');
        expect(s.driver.listMemories({ status: 'confirmed' })).toHaveLength(1);

        // The rolled-back attempts left no journal row behind, and the surviving entry's payload
        // is the committed attempt's id list — not the accumulation of every attempt.
        const confirms = s.driver.allJournal().filter((r) => r.op === 'memory_confirm');
        expect(confirms).toHaveLength(1);
        expect((confirms[0]?.payload as { ids: string[] }).ids).toEqual([m.id]);

        const receipts = committedReceipts([ids.outcome]);
        expect(receipts).toHaveLength(1);
        expect(receipts[0]?.ids).toEqual([m.id]);
        expect(receipts[0]?.record.id).toBe(confirms[0]?.id);
        expect(s.memory.listProposals()).toHaveLength(0);
      } finally {
        s.close();
      }
    });

    it(`reject survives ${retries} busy retr${retries === 1 ? 'y' : 'ies'} without duplicating an id`, () => {
      const s = openStack();
      try {
        expect(s.journal.seal('test', 1).ok).toBe(true);
        const m = s.memory.add({ type: 'semantic', content: 'one proposal' }, { now: NOW });
        const busy = injectBusy(s.journal, 'memory_reject', retries);

        const ids = s.memory.reject([m.id], { now: NOW + 1 });

        expect(busy.count()).toBe(retries);
        expect(ids).toEqual([m.id]);
        expect(s.driver.getMemory(m.id)?.status).toBe('archived');
        expect(s.driver.listMemories({ status: 'archived' })).toHaveLength(1);

        const rejects = s.driver.allJournal().filter((r) => r.op === 'memory_reject');
        expect(rejects).toHaveLength(1);
        expect((rejects[0]?.payload as { ids: string[] }).ids).toEqual([m.id]);

        const receipts = committedReceipts([ids.outcome]);
        expect(receipts).toHaveLength(1);
        expect(receipts[0]?.ids).toEqual([m.id]);
        expect(receipts[0]?.record.id).toBe(rejects[0]?.id);
        expect(s.memory.listProposals()).toHaveLength(0);
      } finally {
        s.close();
      }
    });
  }

  it('the JOURNAL PAYLOAD and the RECEIPT carry the committed attempt only, not every attempt', () => {
    const s = openStack();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      const m = s.memory.add({ type: 'semantic', content: 'one proposal' }, { now: NOW });
      injectBusy(s.journal, 'memory_confirm', 1);

      const ids = s.memory.confirm([m.id], { now: NOW + 1 });

      // Asserted on the DURABLE surfaces first, independently of what the call returned: these are
      // what a later reader, a rollback and a reconciliation are driven from, and each of them
      // duplicates on its own once per-attempt state outlives the attempt.
      const confirms = s.driver.allJournal().filter((r) => r.op === 'memory_confirm');
      expect(confirms).toHaveLength(1);
      expect((confirms[0]?.payload as { ids: string[] }).ids).toEqual([m.id]);
      const receipt = committedReceipts([ids.outcome])[0];
      expect(receipt?.ids).toEqual([m.id]);
      // one durable row, one id everywhere that describes it
      expect(s.driver.listMemories({ status: 'confirmed' })).toHaveLength(1);
    } finally {
      s.close();
    }
  });

  it('a MULTI-id confirm under a busy retry returns each id exactly once', () => {
    const s = openStack();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      const ids = [0, 1, 2].map(
        (i) => s.memory.add({ type: 'semantic', content: `proposal ${i}` }, { now: NOW + i }).id,
      );
      injectBusy(s.journal, 'memory_confirm', 1);

      const applied = s.memory.confirm(ids, { now: NOW + 9 });

      expect([...applied].sort()).toEqual([...ids].sort());
      expect(applied).toHaveLength(3);
      expect(new Set(applied).size).toBe(3);
      const confirms = s.driver.allJournal().filter((r) => r.op === 'memory_confirm');
      expect(confirms).toHaveLength(1);
      expect((confirms[0]?.payload as { ids: string[] }).ids).toHaveLength(3);
      expect(committedReceipts([applied.outcome])[0]?.ids).toHaveLength(3);
      expect(s.driver.listMemories({ status: 'confirmed' })).toHaveLength(3);
    } finally {
      s.close();
    }
  });

  it('an oracle batch that busy-retries reports one outcome per SURVIVING journal entry', async () => {
    const s = openStack();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      const ids = [0, 1, 2].map(
        (i) => s.memory.add({ type: 'semantic', content: `proposal ${i}` }, { now: NOW + i }).id,
      );
      // The batch's whole transaction — its archive, its `consolidate` entry and its contradiction
      // entry — unwinds once and runs again. Its handles must go with it.
      injectBusy(s.journal, 'consolidate_contradictions', 1);

      const rep = await s.consolidate.runOracle({
        now: NOW + 9,
        systemPrompt: 's',
        promptVersion: 'consolidate@v1',
        mask: (c: string) => c,
        provider: {
          id: 'mock:test',
          complete: async (): Promise<string> =>
            JSON.stringify({
              merge: [],
              archive: [ids[0]],
              promote: [],
              contradictions: [{ a: ids[1], b: ids[2], reason: 'these two cannot both hold' }],
            }),
        },
      });

      const entries = s.driver.allJournal().filter((r) => r.op.startsWith('consolidate'));
      expect(entries.map((r) => r.op)).toEqual(['consolidate', 'consolidate_contradictions']);
      // No handle for an entry the database threw away: one outcome per surviving entry, all
      // committed, and the counts describe the same two.
      expect(rep.outcomes).toHaveLength(entries.length);
      expect(rep.outcomes.every((o) => o.state === 'committed')).toBe(true);
      expect(committedReceipts(rep.outcomes)).toHaveLength(2);
      expect(rep.appliedBatches).toBe(1);
      expect(rep.changed).toBe(1);
      expect(rep.contradictions).toBe(1);
      expect(s.driver.listMemories({ status: 'archived' })).toHaveLength(1);
    } finally {
      s.close();
    }
  });

  for (const retries of [1, 2]) {
    it(`a write that busy-retries ${retries}× reports the masking warning ONCE`, () => {
      const s = openStack();
      try {
        expect(s.journal.seal('test', 1).ok).toBe(true);
        const warnings: string[] = [];
        const busy = injectBusy(s.journal, 'memory_write', retries);

        const written = s.memory.write([EMAIL_DRAFT], { now: NOW, warnings });

        expect(busy.count()).toBe(retries);
        // ONE memory, ONE journal entry — and therefore ONE masking event to report.
        expect(written).toHaveLength(1);
        expect(s.driver.listMemories()).toHaveLength(1);
        expect(s.driver.allJournal().filter((r) => r.op === 'memory_write')).toHaveLength(1);
        expect(warnings).toEqual(ONE_WARNING);
        // the warning is TRUE of the durable row: one pseudonym, no plaintext
        const stored = s.driver.listMemories()[0]?.content ?? '';
        expect(stored).toContain('EMAIL_01');
        expect(stored).not.toContain('probe@example.com');
        // and the rolled-back attempts minted no second entity
        expect(s.driver.listEntities()).toHaveLength(1);
      } finally {
        s.close();
      }
    });
  }

  it('a write that EXHAUSTS the retry budget leaves the CALLER’s warnings untouched', () => {
    const s = openStack();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      const warnings: string[] = ['a warning the caller already held'];
      injectBusy(s.journal, 'memory_write', 3);

      expect(() => s.memory.write([EMAIL_DRAFT], { now: NOW, warnings })).toThrow(
        /injected SQLITE_BUSY/,
      );

      // Nothing committed, so there is nothing to warn about: a masking warning here describes a
      // pseudonym that was minted three times and rolled back three times.
      expect(warnings).toEqual(['a warning the caller already held']);
      expect(s.driver.listMemories()).toHaveLength(0);
      expect(s.driver.allJournal().filter((r) => r.op === 'memory_write')).toHaveLength(0);
    } finally {
      s.close();
    }
  });

  it('CONTROL: an unretried write still publishes every masking warning it earned', () => {
    const s = openStack();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      const warnings: string[] = [];
      // two DISTINCT values in one draft: the caller must still receive both
      s.memory.write(
        [{ type: 'semantic', content: 'reach me at probe@example.com or 555-123-4567' }],
        { now: NOW, warnings },
      );
      expect([...warnings].sort()).toEqual([
        'masked a EMAIL at write → EMAIL_01',
        'masked a PHONE at write → PHONE_01',
      ]);
    } finally {
      s.close();
    }
  });

  it('a transition that exhausts the retry budget throws and leaves nothing durable', () => {
    const s = openStack();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      const m = s.memory.add({ type: 'semantic', content: 'one proposal' }, { now: NOW });
      injectBusy(s.journal, 'memory_confirm', 3);

      expect(() => s.memory.confirm([m.id], { now: NOW + 1 })).toThrow(/injected SQLITE_BUSY/);

      expect(s.driver.getMemory(m.id)?.status).toBe('proposed');
      expect(s.driver.allJournal().filter((r) => r.op === 'memory_confirm')).toHaveLength(0);
    } finally {
      s.close();
    }
  });
});

/**
 * SAFETY: A MASKING WARNING IS A CLAIM ABOUT ROWS, AND IT IS PUBLISHED ONLY WHEN THEY ARE DURABLE.
 *
 * THE HAZARD. `write()`'s own `writeTransaction` JOINS whatever transaction the caller already has
 * open — that is the composition rule the whole service is built on — so the moment it returns
 * says nothing about whether anything committed. The transaction that DECIDES is the caller's: an
 * outer transaction that rolls back takes the memory, the vault pseudonym and the `memory_write`
 * entry with it, and a savepoint that unwinds does the same to its own. A warning handed to the
 * caller's array before that edge survives the rollback that erased everything it describes,
 * because the array is the caller's and no rollback reaches it. `sthayi add` then prints "a secret
 * was masked" and the MCP server publishes it as `structuredContent.warnings` over ZERO durable
 * rows: the user is told a pseudonym was minted for a memory that does not exist, and the model
 * reading that field acts on it.
 *
 * THE INVARIANT. The four surfaces are read TOGETHER and always agree: the caller's warnings, the
 * durable memory rows, the vault entities, and the `memory_write` journal entries. One warning
 * means one row, one pseudonym and one entry; no rows means no warning.
 *
 * Real SQLite, a real vault, real transactions: the rollbacks below are the driver's own, and the
 * retry cases use the same real-then-throw `SQLITE_BUSY` injection as the suite above.
 */
describe('safety: a masking warning reaches the caller only after the OUTER transaction settles', () => {
  /** The four surfaces, read together — a warning is only true if the durable ones agree. */
  function surfaces(
    s: ReturnType<typeof openStack>,
    warnings: string[],
  ): { warnings: string[]; memories: number; entities: number; writes: number } {
    return {
      warnings: [...warnings],
      memories: s.driver.listMemories().length,
      entities: s.driver.listEntities().length,
      writes: s.driver.allJournal().filter((r) => r.op === 'memory_write').length,
    };
  }

  for (const retries of [0, 1, 2]) {
    it(`a TOP-LEVEL write with ${retries} busy retr${retries === 1 ? 'y' : 'ies'} publishes one warning over one durable row`, () => {
      const s = openStack();
      try {
        expect(s.journal.seal('test', 1).ok).toBe(true);
        const warnings: string[] = [];
        const busy = injectBusy(s.journal, 'memory_write', retries);

        s.memory.write([EMAIL_DRAFT], { now: NOW, warnings });

        expect(busy.count()).toBe(retries);
        // Nothing is left to settle when a top-level write returns, so the warning is the
        // caller's immediately — and it describes exactly what the database now holds.
        expect(surfaces(s, warnings)).toEqual({
          warnings: ONE_WARNING,
          memories: 1,
          entities: 1,
          writes: 1,
        });
      } finally {
        s.close();
      }
    });
  }

  it('a write that EXHAUSTS the retry budget publishes nothing over nothing durable', () => {
    const s = openStack();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      const held = ['a warning the caller already held'];
      const warnings = [...held];
      injectBusy(s.journal, 'memory_write', 3);

      expect(() => s.memory.write([EMAIL_DRAFT], { now: NOW, warnings })).toThrow(
        /injected SQLITE_BUSY/,
      );

      expect(surfaces(s, warnings)).toEqual({
        warnings: held,
        memories: 0,
        entities: 0,
        writes: 0,
      });
    } finally {
      s.close();
    }
  });

  it('a write inside a caller transaction that COMMITS publishes at the OUTER edge, not before', () => {
    const s = openStack();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      const warnings: string[] = [];

      s.driver.writeTransaction(() => {
        s.memory.write([EMAIL_DRAFT], { now: NOW, warnings });
        // Still in flight: this transaction can still roll back, so nothing about it is the
        // caller's yet.
        expect(warnings).toEqual([]);
      });

      expect(surfaces(s, warnings)).toEqual({
        warnings: ONE_WARNING,
        memories: 1,
        entities: 1,
        writes: 1,
      });
    } finally {
      s.close();
    }
  });

  it('a write inside a caller transaction that ROLLS BACK publishes nothing', () => {
    const s = openStack();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      const held = ['a warning the caller already held'];
      const warnings = [...held];

      expect(() =>
        s.driver.writeTransaction(() => {
          s.memory.write([EMAIL_DRAFT], { now: NOW, warnings });
          throw new Error('the caller abandons its transaction');
        }),
      ).toThrow(/the caller abandons its transaction/);

      // The row, the pseudonym and the entry went with the rollback. A warning that outlived them
      // would be the only surviving evidence of a write that never happened.
      expect(surfaces(s, warnings)).toEqual({
        warnings: held,
        memories: 0,
        entities: 0,
        writes: 0,
      });
    } finally {
      s.close();
    }
  });

  it('a write in a savepoint the host CATCHES publishes nothing, while the host’s own write does', () => {
    const s = openStack();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      const unwound: string[] = [];
      const kept: string[] = [];

      s.driver.writeTransaction(() => {
        // A nested `transaction` opens a SAVEPOINT: it can unwind on its own without taking the
        // host down, which is exactly the case where the host commits and the inner rows do not.
        expect(() =>
          s.driver.transaction(() => {
            s.memory.write([EMAIL_DRAFT], { now: NOW, warnings: unwound });
            throw new Error('the savepoint unwinds');
          }),
        ).toThrow(/the savepoint unwinds/);
        // …and the host carries on and commits a write of its own.
        s.memory.write([PHONE_DRAFT], { now: NOW + 1, warnings: kept });
      });

      expect(unwound).toEqual([]);
      expect(surfaces(s, kept)).toEqual({
        warnings: PHONE_WARNING,
        memories: 1,
        entities: 1,
        writes: 1,
      });
      // the surviving row is the host's, and it holds a pseudonym rather than the raw value
      const stored = s.driver.listMemories()[0]?.content ?? '';
      expect(stored).toContain('PHONE_01');
      expect(stored).not.toContain('555-123-4567');
    } finally {
      s.close();
    }
  });
});
