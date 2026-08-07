import { JournalService, MemoryService, VaultService } from '@sthayi/core';
import type {
  AssocEdgeRow,
  EdgeDelta,
  Entity,
  EntityKind,
  JournalRecord,
  McpEntry,
  Memory,
  MemoryFilter,
  MemorySearchRow,
  SealedJournalEntry,
  SearchOptions,
  StorageDriver,
} from '@sthayi/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NodeCrypto } from '../../packages/cli/src/drivers/crypto.js';
import { SqliteDriver } from '../../packages/cli/src/drivers/sqlite.js';
import { type FakeHome, createFakeHome } from '../helpers/fake-home.js';

/**
 * SAFETY: A DRIVER THAT CANNOT REPORT SETTLEMENT IS TOLD SO, NOT GUESSED AT.
 *
 * THE HAZARD. `inTransaction`, `afterCommit` and `onSettle` are ALL OPTIONAL on the storage port,
 * so a driver implementing none of them is fully conforming — the port says as much, and the whole
 * point of the optionality is that `packages/core` must work against a driver that offers only the
 * required surface. A masking warning is a claim about rows that exist: a secret in what the caller
 * just wrote was replaced by a pseudonym, and the pseudonym was minted. `write()`'s own
 * `writeTransaction` JOINS whatever transaction the caller already has open, so its return says
 * nothing about whether anything committed — the transaction that decides is the caller's. A
 * hookless driver can say nothing about that transaction's fate, and a settlement test that reads
 * an ABSENT member as "no transaction is open" answers the question it could not ask: it hands the
 * caller a warning at the moment of the write, and the caller's array is not reached by the
 * rollback that then takes the memory, the vault entity and the `memory_write` entry. `sthayi add`
 * prints "a secret was masked" and the MCP server publishes it as `structuredContent.warnings`
 * over ZERO durable rows — a report of a leak that never happened, which is what a user and a model
 * both act on.
 *
 * THE INVARIANT. Publication rides on an ACTUAL settlement report — `afterCommit`, or `onSettle`'s
 * commit edge — and nothing else. Top-level settlement may be INFERRED only from a driver that
 * implements `inTransaction` and answers it explicitly with false. When no member of the port can
 * establish that the rows are durable, the warning is withheld: an unpublished warning over
 * correctly masked rows costs a report, while a published one over rows that were rolled back is
 * evidence of a write that never happened.
 *
 * Real SQLite underneath, a real vault, a real rollback: the driver below narrows the port's
 * surface without simulating any of its storage or transaction behavior.
 */

/**
 * A CONFORMING DRIVER WITH NO TRANSACTION-LIFECYCLE HOOKS.
 *
 * Every REQUIRED member of the port is delegated to a real SQLite driver, so transactions,
 * rollbacks, vault entity rows and journal rows are the database's own. The optional
 * `inTransaction` / `afterCommit` / `onSettle` / `transactionId` members are simply ABSENT — which
 * is what the port permits and what a minimal driver (an alternate backend, an early port to a new
 * storage engine) actually looks like before its lifecycle plumbing exists.
 */
class HooklessDriver implements StorageDriver {
  constructor(protected readonly inner: SqliteDriver) {}

  migrate(): void {
    this.inner.migrate();
  }
  transaction<T>(fn: () => T): T {
    return this.inner.transaction(fn);
  }
  writeTransaction<T>(fn: () => T): T {
    return this.inner.writeTransaction(fn);
  }
  close(): void {
    this.inner.close();
  }

  getMeta(key: string): string | undefined {
    return this.inner.getMeta(key);
  }
  setMeta(key: string, value: string): void {
    this.inner.setMeta(key, value);
  }

  insertMemory(memory: Memory): void {
    this.inner.insertMemory(memory);
  }
  getMemory(id: string): Memory | undefined {
    return this.inner.getMemory(id);
  }
  updateMemory(id: string, patch: Partial<Memory>): void {
    this.inner.updateMemory(id, patch);
  }
  deleteMemory(id: string): void {
    this.inner.deleteMemory(id);
  }
  listMemories(filter?: MemoryFilter): Memory[] {
    return this.inner.listMemories(filter);
  }
  countMemories(filter?: MemoryFilter): number {
    return this.inner.countMemories(filter);
  }
  listMemoriesPage(
    filter: MemoryFilter | undefined,
    page: { limit: number; offset: number },
  ): { rows: Memory[]; total: number } {
    return this.inner.listMemoriesPage(filter, page);
  }
  searchMemories(query: string, opts?: SearchOptions): MemorySearchRow[] {
    return this.inner.searchMemories(query, opts);
  }
  bumpRetrieval(ids: string[], now: number): void {
    this.inner.bumpRetrieval(ids, now);
  }

  insertEntity(entity: Entity): void {
    this.inner.insertEntity(entity);
  }
  listEntities(kind?: EntityKind): Entity[] {
    return this.inner.listEntities(kind);
  }

  listMcpEntries(name?: string): McpEntry[] {
    return this.inner.listMcpEntries(name);
  }

  appendJournal(entry: SealedJournalEntry): JournalRecord {
    return this.inner.appendJournal(entry);
  }
  lastJournalHash(): string | null {
    return this.inner.lastJournalHash();
  }
  recentJournal(n: number): JournalRecord[] {
    return this.inner.recentJournal(n);
  }
  allJournal(): JournalRecord[] {
    return this.inner.allJournal();
  }
  journalSince(id: number, limit?: number): JournalRecord[] {
    return this.inner.journalSince(id, limit);
  }

  applyAssocDelta(delta: EdgeDelta): void {
    this.inner.applyAssocDelta(delta);
  }
  rewireAssoc(from: string, to: string, now: number): void {
    this.inner.rewireAssoc(from, to, now);
  }
  neighborsAssoc(ids: string[]): AssocEdgeRow[] {
    return this.inner.neighborsAssoc(ids);
  }
  clearAssoc(): void {
    this.inner.clearAssoc();
  }
  countAssocEdges(): number {
    return this.inner.countAssocEdges();
  }
}

/**
 * The same driver plus `inTransaction` ALONE — the one optional member from which top-level
 * settlement may be inferred, and the shape that separates "the port could not answer" from "the
 * port answered false". It still offers neither `afterCommit` nor `onSettle`.
 */
class IntrospectionOnlyDriver extends HooklessDriver {
  inTransaction(): boolean {
    return this.inner.inTransaction();
  }
}

let home: FakeHome;

beforeEach(() => {
  home = createFakeHome();
});
afterEach(() => {
  home.cleanup();
});

interface Stack {
  driver: StorageDriver;
  memory: MemoryService;
  close: () => void;
}

/** A full write stack over a driver whose optional surface is chosen by `wrap`. */
function openStack(wrap: (inner: SqliteDriver) => StorageDriver): Stack {
  const inner = SqliteDriver.open(home.path('sthayi.db'));
  inner.migrate();
  const driver = wrap(inner);
  const crypto = NodeCrypto.open(home.path('key'));
  const vault = new VaultService(driver, crypto, { now: () => 1 });
  const journal = new JournalService(driver);
  return {
    driver,
    memory: new MemoryService(driver, journal, vault),
    close: (): void => inner.close(),
  };
}

/** The four surfaces, read together — a warning is only true if the durable ones agree. */
function surfaces(
  s: Stack,
  warnings: string[],
): { warnings: string[]; memories: number; entities: number; writes: number } {
  return {
    warnings: [...warnings],
    memories: s.driver.listMemories().length,
    entities: s.driver.listEntities().length,
    writes: s.driver.allJournal().filter((r) => r.op === 'memory_write').length,
  };
}

const NOW = 1_000;
const EMAIL_DRAFT = { type: 'semantic' as const, content: 'reach me at probe@example.com' };
const EMAIL_WARNING = 'masked a EMAIL at write → EMAIL_01';
const HELD = 'a warning the caller already held';

describe('safety: a driver that cannot report settlement never has settlement inferred for it', () => {
  it('the hookless driver is a COMPLETE driver: every optional lifecycle member is absent', () => {
    const s = openStack((inner) => new HooklessDriver(inner));
    try {
      expect(s.driver.afterCommit).toBeUndefined();
      expect(s.driver.onSettle).toBeUndefined();
      expect(s.driver.inTransaction).toBeUndefined();
      expect(s.driver.transactionId).toBeUndefined();
      // and it is a working store, so what follows is a settlement question and nothing else
      s.memory.write([{ type: 'semantic', content: 'a plain note' }], { now: NOW });
      expect(s.driver.listMemories()).toHaveLength(1);
      expect(s.driver.allJournal().filter((r) => r.op === 'memory_write')).toHaveLength(1);
    } finally {
      s.close();
    }
  });

  it('publishes NOTHING when the caller transaction carrying the write ROLLS BACK', () => {
    const s = openStack((inner) => new HooklessDriver(inner));
    try {
      const warnings = [HELD];

      expect(() =>
        s.driver.writeTransaction(() => {
          s.memory.write([EMAIL_DRAFT], { now: NOW, warnings });
          throw new Error('the caller abandons its transaction');
        }),
      ).toThrow(/the caller abandons its transaction/);

      // The row, the pseudonym and the entry went with the rollback. A masking warning that
      // outlived them would be the only surviving evidence of a write that never happened — and
      // the driver never said the transaction committed, because it cannot say anything at all.
      expect(surfaces(s, warnings)).toEqual({
        warnings: [HELD],
        memories: 0,
        entities: 0,
        writes: 0,
      });
    } finally {
      s.close();
    }
  });

  it('withholds on a TOP-LEVEL write too: the mask still runs, only the report is withheld', () => {
    const s = openStack((inner) => new HooklessDriver(inner));
    try {
      const warnings = [HELD];

      s.memory.write([EMAIL_DRAFT], { now: NOW, warnings });

      // Nothing in the port can establish that these rows are durable, so nothing is claimed about
      // them. The COST is a report, not protection: the row that landed holds the pseudonym and
      // never the raw value, which is what the at-rest policy is for.
      expect(surfaces(s, warnings)).toEqual({
        warnings: [HELD],
        memories: 1,
        entities: 1,
        writes: 1,
      });
      const stored = s.driver.listMemories()[0]?.content ?? '';
      expect(stored).toContain('EMAIL_01');
      expect(stored).not.toContain('probe@example.com');
    } finally {
      s.close();
    }
  });

  it('a driver with inTransaction ALONE publishes at top level — false is an ANSWER', () => {
    const s = openStack((inner) => new IntrospectionOnlyDriver(inner));
    try {
      expect(s.driver.afterCommit).toBeUndefined();
      expect(s.driver.onSettle).toBeUndefined();
      expect(s.driver.inTransaction?.()).toBe(false);
      const warnings: string[] = [];

      s.memory.write([EMAIL_DRAFT], { now: NOW, warnings });

      // Withholding is for the case the port cannot answer. A driver that answers "no transaction
      // is open" has reported that the write settled, and the warning describes durable rows.
      expect(surfaces(s, warnings)).toEqual({
        warnings: [EMAIL_WARNING],
        memories: 1,
        entities: 1,
        writes: 1,
      });
    } finally {
      s.close();
    }
  });

  it('a driver with inTransaction ALONE still publishes nothing across a caller ROLLBACK', () => {
    const s = openStack((inner) => new IntrospectionOnlyDriver(inner));
    try {
      const warnings = [HELD];

      expect(() =>
        s.driver.writeTransaction(() => {
          s.memory.write([EMAIL_DRAFT], { now: NOW, warnings });
          throw new Error('the caller abandons its transaction');
        }),
      ).toThrow(/the caller abandons its transaction/);

      expect(surfaces(s, warnings)).toEqual({
        warnings: [HELD],
        memories: 0,
        entities: 0,
        writes: 0,
      });
    } finally {
      s.close();
    }
  });
});
