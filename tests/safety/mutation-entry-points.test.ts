import fs from 'node:fs';
import {
  ConsolidationService,
  JournalService,
  MemoryService,
  type MutationOutcome,
  VaultService,
  committedReceipts,
  isDegradedReceipt,
} from '@sthayi/core';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileCheckpoint } from '../../packages/cli/src/drivers/checkpoint-file.js';
import { NodeCrypto } from '../../packages/cli/src/drivers/crypto.js';
import { SqliteDriver } from '../../packages/cli/src/drivers/sqlite.js';
import { PII_REMASK_META_KEY, openStore, startupBlockers } from '../../packages/cli/src/store.js';
import { type FakeHome, createFakeHome } from '../helpers/fake-home.js';
import { removeOwned } from '../helpers/owned-fs.js';

/**
 * SAFETY: THE MUTATION INVENTORY — every entry point that appends to the journal, driven through
 * all three outcomes.
 *
 * WHY AN INVENTORY AND NOT A SAMPLE. The durable-but-unanchored outcome is a property of the
 * COMMIT EDGE, so it belongs to every journaled write equally — the ones a user typed, the ones a
 * loop emitted on their behalf, and the ones that ran because the store was opened. Testing the
 * obvious three (write, consolidate, rollback) and calling the property established is exactly how
 * an import, a page of confirmations, a rejected oracle batch or a startup migration keeps its own
 * quiet path back to "success, exit 0". So this file enumerates the ops the runtime can append and
 * puts each one through:
 *
 *   HEALTHY              — the anchor advances with the commit: outcome 'committed', anchor
 *                          'anchored', no degraded receipt anywhere;
 *   COMMITTED-UNANCHORED — the commit lands and the anchor does not: outcome 'committed', anchor
 *                          'unanchored', committed/doNotRetry/writesBlocked all true, and the rows
 *                          really are in the database;
 *   REFUSAL              — from that state the SAME entry point throws, and appends nothing. A
 *                          refusal must never be confusable with the degraded outcome: nothing is
 *                          durable, so retrying is safe and duplicates nothing.
 *
 * PARTIAL PROGRESS, where an entry point BATCHES, is the fourth state and lives with the loop that
 * owns it: `review --confirm-all` in journal-commit-receipt.test.ts, and the oracle batch loop in
 * oracle-batch-outcomes.test.ts.
 *
 * Real SQLite, a real FileCheckpoint, and the honest degraded state: a DIRECTORY at
 * `journal.checkpoint.lock`, which no O_CREAT|O_EXCL lock can ever take.
 */

type Stack = ReturnType<typeof buildStack>;

let home: FakeHome;
let cpFile: string;

function buildStack() {
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
    close: (): void => driver.close(),
  };
}

/** One entry point in the inventory. */
interface EntryPoint {
  /** the journal op it appends */
  op: string;
  /** rows and state it needs, laid down while the anchor is still healthy */
  setup: (s: Stack) => Promise<void> | void;
  /** perform the mutation; returns the outcomes it produced */
  run: (s: Stack) => Promise<MutationOutcome[]> | MutationOutcome[];
  /** a SECOND, independent invocation of the same entry point (defaults to `run`) — some entry
   *  points legitimately refuse a literal repeat (rollback's replay guard, import's dedupe) */
  again?: (s: Stack) => Promise<MutationOutcome[]> | MutationOutcome[];
  /**
   * How this entry point REFUSES once writes are blocked. Most throw out of `journal.append`;
   * rollback refuses one rung earlier — its ladder verifies the journal first and returns a
   * refusal report — and both are refusals in the sense that matters: nothing is durable, so the
   * caller may retry after the repair without duplicating anything.
   */
  expectRefusal?: (s: Stack) => Promise<void> | void;
}

const NOW = 1_000;
let unique = 0;
const nextContent = (label: string): string => `${label} fixture number ${unique++}`;

/** Provider that archives whichever id it is told to, from the batch it is handed. */
function archiveProvider(pick: (ids: string[]) => string | undefined) {
  return {
    id: 'mock:test',
    complete: async (_system: string, user: string): Promise<string> => {
      const batch = JSON.parse(user) as { items: { id: string }[] };
      return JSON.stringify({
        merge: [],
        archive: [pick(batch.items.map((i) => i.id))].filter((x) => x !== undefined),
        promote: [],
        contradictions: [],
      });
    },
  };
}

const ORACLE_OPTS = {
  now: NOW,
  systemPrompt: 's',
  promptVersion: 'consolidate@v1',
  mask: (c: string) => c,
};

/** Add a confirmed memory and return its id. */
function addConfirmed(s: Stack, content: string): string {
  return s.memory.add({ type: 'semantic', content }, { now: NOW, asProposal: false }).id;
}

/**
 * Plant an exact-duplicate pair straight into the table, with NO journal entry of its own.
 * The deterministic pass needs fresh duplicates for each round, and a journaled write would be a
 * different entry point contributing its own outcome to the one under test.
 */
function plantDuplicatePair(s: Stack): void {
  const content = nextContent('deterministic duplicate');
  for (let i = 0; i < 2; i++) {
    s.driver.insertMemory({
      id: `01PLANT${String(unique++).padStart(19, '0')}`,
      type: 'semantic',
      scope: 'user',
      content,
      provenance: { source: 'fixture' },
      confidence: 0.9 - i * 0.1,
      boosts: 0,
      status: 'confirmed',
      source: 'fixture',
      createdAt: NOW,
      updatedAt: NOW,
      lastRetrievedAt: null,
      decayAt: null,
    });
  }
}

/**
 * Rewrite the store as a LEGACY unmasked build left it: plaintext PII in a memory row and the
 * migration marker cleared, so the next open owes a remask.
 */
function makeLegacy(): void {
  const raw = new Database(home.path('sthayi.db'));
  try {
    const row = raw.prepare('SELECT id FROM memories LIMIT 1').get() as { id: string };
    raw
      .prepare('UPDATE memories SET content = ? WHERE id = ?')
      .run('email me at legacy.pii@example-leak.io about the launch', row.id);
    raw.prepare('DELETE FROM meta WHERE k = ?').run(PII_REMASK_META_KEY);
  } finally {
    raw.close();
  }
}

/** A healthy store with one memory, then made to look legacy. */
function seedStoreThenMakeLegacy(): void {
  const seed = openStore();
  seed.memory.add({ type: 'semantic', content: 'placeholder fact' }, { now: NOW });
  seed.close();
  makeLegacy();
}

/** Produce a deterministic consolidate batch and return its journal id. */
function makeBatch(s: Stack): number {
  const dupe = nextContent('duplicate');
  addConfirmed(s, dupe);
  addConfirmed(s, dupe);
  const rep = s.consolidate.runDeterministic({ now: NOW });
  expect(rep.changed).toBe(1);
  const entries = s.driver.allJournal().filter((r) => r.op === 'consolidate');
  return entries[entries.length - 1]?.id ?? -1;
}

const ENTRY_POINTS: Record<string, EntryPoint> = {
  'memory_write (MemoryService.write / CLI add / MCP memory_write)': {
    op: 'memory_write',
    setup: () => {},
    run: (s) => [
      s.memory.add({ type: 'semantic', content: nextContent('write') }, { now: NOW }).outcome,
    ],
  },
  'memory_retrieve (MemoryService.search / CLI search / MCP memory_search)': {
    op: 'memory_retrieve',
    setup: (s) => {
      addConfirmed(s, 'a searchable shibboleth fact');
    },
    run: (s) => [s.memory.search('shibboleth', { now: NOW }).outcome],
  },
  'import (MemoryService.importMemories / CLI import)': {
    op: 'import',
    setup: () => {},
    run: (s) => [
      s.memory.importMemories(
        [
          {
            type: 'semantic',
            content: nextContent('imported'),
            scope: 'user',
            confidence: 0.6,
            provenance: { source: 'claude' },
          },
        ],
        { now: NOW, source: 'claude' },
      ).outcome,
    ],
  },
  'memory_confirm (MemoryService.confirm / CLI review --confirm / MCP memory_review)': {
    op: 'memory_confirm',
    setup: (s) => {
      s.memory.write(
        [
          { type: 'semantic', content: nextContent('to confirm') },
          { type: 'semantic', content: nextContent('to confirm') },
          { type: 'semantic', content: nextContent('to confirm') },
        ],
        { now: NOW },
      );
    },
    run: (s) => [
      s.memory.confirm([s.driver.listMemories({ status: 'proposed' })[0]?.id ?? ''], { now: NOW })
        .outcome,
    ],
  },
  'memory_reject (MemoryService.reject / CLI review --reject / MCP memory_review)': {
    op: 'memory_reject',
    setup: (s) => {
      s.memory.write(
        [
          { type: 'semantic', content: nextContent('to reject') },
          { type: 'semantic', content: nextContent('to reject') },
          { type: 'semantic', content: nextContent('to reject') },
        ],
        { now: NOW },
      );
    },
    run: (s) => [
      s.memory.reject([s.driver.listMemories({ status: 'proposed' })[0]?.id ?? ''], { now: NOW })
        .outcome,
    ],
  },
  'consolidate — deterministic pass (ConsolidationService.runDeterministic / CLI consolidate)': {
    op: 'consolidate',
    setup: (s) => {
      plantDuplicatePair(s);
    },
    run: (s) => s.consolidate.runDeterministic({ now: NOW }).outcomes,
    // One pass archives every duplicate it can see, so the repeat needs a fresh pair — planted
    // straight into the table, because a journaled write here would be a different entry point.
    again: (s) => {
      plantDuplicatePair(s);
      return s.consolidate.runDeterministic({ now: NOW }).outcomes;
    },
  },
  'consolidate — oracle pass (ConsolidationService.runOracle / CLI consolidate --oracle)': {
    op: 'consolidate',
    setup: (s) => {
      for (let i = 0; i < 4; i++) {
        addConfirmed(s, nextContent('oracle target'));
      }
    },
    run: async (s) =>
      (
        await s.consolidate.runOracle({
          ...ORACLE_OPTS,
          provider: archiveProvider((ids) => ids[0]),
        })
      ).outcomes,
  },
  'consolidate_rejected — invalid oracle output (runOracle)': {
    op: 'consolidate_rejected',
    setup: (s) => {
      addConfirmed(s, nextContent('rejected batch'));
    },
    run: async (s) =>
      (
        await s.consolidate.runOracle({
          ...ORACLE_OPTS,
          provider: { id: 'mock:test', complete: async (): Promise<string> => 'not json' },
        })
      ).outcomes,
  },
  'consolidate_rejected — merge group across a trust boundary (runOracle skippedGroups)': {
    op: 'consolidate_rejected',
    setup: (s) => {
      s.memory.add(
        { type: 'semantic', scope: 'user', content: nextContent('scope a') },
        { now: NOW, asProposal: false },
      );
      s.memory.add(
        { type: 'semantic', scope: 'project:x', content: nextContent('scope b') },
        { now: NOW, asProposal: false },
      );
    },
    run: async (s) =>
      (
        await s.consolidate.runOracle({
          ...ORACLE_OPTS,
          provider: {
            id: 'mock:test',
            complete: async (_system: string, user: string): Promise<string> => {
              const batch = JSON.parse(user) as { items: { id: string }[] };
              // a merge spanning two scopes — discarded WHOLE and journaled
              return JSON.stringify({
                merge: [batch.items.map((i) => i.id)],
                archive: [],
                promote: [],
                contradictions: [],
              });
            },
          },
        })
      ).outcomes,
  },
  'consolidate_rejected — op whose target changed mid-flight (runOracle skippedOps)': {
    op: 'consolidate_rejected',
    setup: (s) => {
      for (let i = 0; i < 4; i++) {
        addConfirmed(s, nextContent('vanishing target'));
      }
    },
    run: async (s) =>
      (
        await s.consolidate.runOracle({
          ...ORACLE_OPTS,
          provider: {
            id: 'mock:test',
            complete: async (_system: string, user: string): Promise<string> => {
              const batch = JSON.parse(user) as { items: { id: string }[] };
              const target = batch.items[0]?.id ?? '';
              // a concurrent decision WHILE the model call is in flight: the store, not the
              // snapshot, decides — the op is skipped and journaled
              s.driver.updateMemory(target, { status: 'archived', updatedAt: NOW });
              return JSON.stringify({
                merge: [],
                archive: [target],
                promote: [],
                contradictions: [],
              });
            },
          },
        })
      ).outcomes,
  },
  'consolidate_contradictions — review evidence, never a mutation (runOracle)': {
    op: 'consolidate_contradictions',
    setup: (s) => {
      addConfirmed(s, nextContent('contradiction a'));
      addConfirmed(s, nextContent('contradiction b'));
    },
    run: async (s) =>
      (
        await s.consolidate.runOracle({
          ...ORACLE_OPTS,
          provider: {
            id: 'mock:test',
            complete: async (_system: string, user: string): Promise<string> => {
              const batch = JSON.parse(user) as { items: { id: string }[] };
              return JSON.stringify({
                merge: [],
                archive: [],
                promote: [],
                contradictions: [
                  {
                    a: batch.items[0]?.id,
                    b: batch.items[1]?.id,
                    reason: 'these two cannot both hold',
                  },
                ],
              });
            },
          },
        })
      ).outcomes,
  },
  'rollback — compensating entry (ConsolidationService.rollback / CLI rollback)': {
    op: 'rollback',
    setup: (s) => {
      // three independent batches: the replay guard refuses a literal repeat, so each round
      // targets its own batch
      s.driver.setMeta('inventory_batch_a', String(makeBatch(s)));
      s.driver.setMeta('inventory_batch_b', String(makeBatch(s)));
      s.driver.setMeta('inventory_batch_c', String(makeBatch(s)));
    },
    run: (s) => {
      const r = s.consolidate.rollback(Number(s.driver.getMeta('inventory_batch_a')), NOW + 1);
      expect(r.ok, r.reason).toBe(true);
      return r.ok ? [r.outcome] : [];
    },
    again: (s) => {
      const r = s.consolidate.rollback(Number(s.driver.getMeta('inventory_batch_b')), NOW + 2);
      // Narrowing on `ok` is the ONLY way to reach `outcome`: the success branch of the union
      // requires it, so there is no report shape here whose outcome could go unread.
      expect(r.ok, r.reason).toBe(true);
      return r.ok ? [r.outcome] : [];
    },
    expectRefusal: (s) => {
      // Rollback refuses one rung earlier than an append: its ladder verifies the journal FIRST,
      // and a stale off-database anchor fails that verification — so the refusal arrives as a
      // report rather than a throw. It is still a refusal: zero mutations, zero appends.
      const r = s.consolidate.rollback(Number(s.driver.getMeta('inventory_batch_c')), NOW + 3);
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/journal failed verification/);
      expect(r.reverted).toBe(0);
      expect(r.outcome).toBeUndefined();
    },
  },
};

/** Jam every checkpoint replacement, permanently and deterministically. */
function jam(): void {
  fs.mkdirSync(`${cpFile}.lock`, { recursive: true });
}

describe('safety: every journal mutation entry point, in all three outcomes', () => {
  beforeEach(() => {
    home = createFakeHome();
    cpFile = home.path('journal.checkpoint');
  });
  afterEach(() => {
    removeOwned(`${cpFile}.lock`);
    home.cleanup();
  });

  for (const [name, entry] of Object.entries(ENTRY_POINTS)) {
    it(`${name} → healthy / committed-unanchored / refusal`, async () => {
      const s = buildStack();
      try {
        expect(s.journal.seal('test', 1).ok).toBe(true);
        await entry.setup(s);

        // HEALTHY: the anchor advances with the commit.
        const healthy = committedReceipts(await entry.run(s));
        expect(healthy.length, `${name}: healthy run appended nothing`).toBeGreaterThan(0);
        expect(
          healthy.some((r) => r.record.op === entry.op),
          `${name}: expected a ${entry.op} entry`,
        ).toBe(true);
        for (const r of healthy) {
          expect(r.anchor, `${name}: healthy anchor`).toBe('anchored');
          expect(isDegradedReceipt(r)).toBe(false);
          expect(r.writesBlocked).toBe(false);
          expect(r.doNotRetry).toBe(false);
        }
        const afterHealthy = s.driver.allJournal().length;

        // COMMITTED-UNANCHORED: the commit lands, the anchor cannot follow.
        jam();
        const degraded = committedReceipts(await (entry.again ?? entry.run)(s));
        expect(degraded.length, `${name}: degraded run appended nothing`).toBeGreaterThan(0);
        expect(
          degraded.some((r) => isDegradedReceipt(r)),
          `${name}: expected a degraded receipt`,
        ).toBe(true);
        for (const r of degraded.filter((x) => isDegradedReceipt(x))) {
          expect(r.committed, `${name}: a degraded receipt still says COMMITTED`).toBe(true);
          expect(r.doNotRetry).toBe(true);
          expect(r.writesBlocked).toBe(true);
          expect(r.reason).toBeTypeOf('string');
        }
        // the rows really are durable — this is not a rolled-back transaction
        const afterDegraded = s.driver.allJournal().length;
        expect(afterDegraded, `${name}: the degraded run must have committed`).toBeGreaterThan(
          afterHealthy,
        );

        // REFUSAL: from here the same entry point refuses, and appends nothing.
        if (entry.expectRefusal) {
          await entry.expectRefusal(s);
        } else {
          await expect(
            (async () => (entry.again ?? entry.run)(s))(),
            `${name}: the next mutation must be refused`,
          ).rejects.toThrow(/refusing to append/);
        }
        expect(s.driver.allJournal().length, `${name}: a refusal appends nothing`).toBe(
          afterDegraded,
        );
      } finally {
        s.close();
      }
    });
  }

  it('journal_seal — explicit reseal (JournalService.seal / CLI journal reseal)', () => {
    const s = buildStack();
    try {
      // HEALTHY: both copies rewritten, and seal() confirms the file by reading it back.
      const healthy = s.journal.seal('cli', 1);
      expect(healthy.ok).toBe(true);
      expect(healthy.partial).toBeUndefined();
      expect(fs.readFileSync(cpFile, 'utf8')).toBe(s.driver.getMeta('journal_checkpoint'));

      // COMMITTED-UNANCHORED: the database half commits, the file half cannot — reported as
      // PARTIAL rather than as either a success or a refusal.
      jam();
      const partial = s.journal.seal('cli', 2);
      expect(partial.ok).toBe(false);
      expect(partial.partial).toBe(true);
      expect(partial.reason).toMatch(/the database was resealed but the file/);
      expect(s.driver.allJournal().filter((r) => r.op === 'journal_seal')).toHaveLength(2);

      // REFUSAL: a seal over a broken chain writes nothing at all, and says so without any
      // partial claim — nothing committed, so a retry after the repair is safe.
      const raw = new Database(home.path('sthayi.db'));
      raw.prepare('UPDATE journal SET hash = ? WHERE id = 1').run('0'.repeat(64));
      raw.close();
      const reopened = buildStack();
      try {
        const refused = reopened.journal.seal('cli', 3);
        expect(refused.ok).toBe(false);
        expect(refused.partial).toBeUndefined();
        expect(refused.reason).toMatch(/refusing to seal: the hash chain itself is broken/);
        expect(
          reopened.driver.allJournal().filter((r) => r.op === 'journal_seal'),
          'a refused seal appends nothing',
        ).toHaveLength(2);
      } finally {
        reopened.close();
      }
    } finally {
      s.close();
    }
  });

  it('journal_seal — automatic first-run seal (openStore startup)', () => {
    // HEALTHY: a fresh store initializes cleanly and blocks nothing.
    const clean = openStore();
    try {
      expect(startupBlockers(clean.startup)).toHaveLength(0);
      expect(clean.startup.some((o) => o.state === 'clean')).toBe(true);
    } finally {
      clean.close();
    }

    // COMMITTED-UNANCHORED and REFUSAL for this entry point are the startup channel's own
    // states, driven end-to-end in startup-mutation-outcome.test.ts; what belongs here is that
    // the automatic seal is INVENTORIED — it is a journal mutation like every other row above.
    expect(
      new Database(home.path('sthayi.db'), { readonly: true })
        .prepare("SELECT count(*) AS c FROM journal WHERE op = 'journal_seal'")
        .get(),
    ).toEqual({ c: 1 });
  });

  it('migrate_masking — automatic PII migration, HEALTHY (openStore startup)', () => {
    seedStoreThenMakeLegacy();
    const healthy = openStore();
    try {
      expect(startupBlockers(healthy.startup)).toHaveLength(0);
      expect(healthy.startup.some((o) => o.step === 'pii-migration' && o.state === 'clean')).toBe(
        true,
      );
      expect(healthy.driver.allJournal().filter((r) => r.op === 'migrate_masking')).toHaveLength(1);
      const row = healthy.driver.listMemories()[0];
      expect(row?.content).not.toContain('legacy.pii@example-leak.io');
    } finally {
      healthy.close();
    }
  });

  it('migrate_masking — automatic PII migration, COMMITTED-UNANCHORED (openStore startup)', () => {
    seedStoreThenMakeLegacy();
    jam();
    const degraded = openStore();
    try {
      const blocked = startupBlockers(degraded.startup);
      expect(blocked).toHaveLength(1);
      expect(blocked[0]?.step).toBe('pii-migration');
      expect(blocked[0]?.receipt?.committed).toBe(true);
      expect(blocked[0]?.receipt?.anchor).toBe('unanchored');
      expect(blocked[0]?.receipt?.doNotRetry).toBe(true);
      expect(blocked[0]?.receipt?.record.op).toBe('migrate_masking');
      // the migration really committed — this is not a rolled-back transaction
      expect(degraded.driver.allJournal().filter((r) => r.op === 'migrate_masking')).toHaveLength(
        1,
      );
    } finally {
      degraded.close();
    }
  });

  it('migrate_masking — automatic PII migration, REFUSAL (openStore startup)', () => {
    // A store whose writes are ALREADY blocked, by an ordinary write that committed unanchored…
    const seed = openStore();
    seed.memory.add({ type: 'semantic', content: 'placeholder fact' }, { now: NOW });
    seed.close();
    jam();
    const blocker = openStore();
    blocker.memory.add({ type: 'semantic', content: 'the unanchored write' }, { now: NOW });
    blocker.close();

    // …then a legacy store's pending migration on top of it. It must REFUSE, not quietly report a
    // migration that never appended: nothing is durable here, so the retry after the repair is safe.
    makeLegacy();
    expect(() => openStore().close()).toThrow(/refusing to append/);
    const raw = new Database(home.path('sthayi.db'), { readonly: true });
    try {
      expect(
        raw.prepare("SELECT count(*) AS c FROM journal WHERE op = 'migrate_masking'").get(),
        'a refused migration appends nothing',
      ).toEqual({ c: 0 });
    } finally {
      raw.close();
    }
  });
});
