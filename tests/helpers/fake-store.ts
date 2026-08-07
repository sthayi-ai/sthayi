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
import { decayedWeight, queryTokens, sha256 } from '@sthayi/core';

/**
 * Deterministic MAC-capable fake for the crypto slice JournalService needs
 * (`Pick<CryptoPort, 'mac'>`). Lets browser-clean unit tests exercise the AUTHENTICATED
 * checkpoint path (verify state 'ok', rollback's checkpoint gate) without node:crypto.
 * Keyed by a fixed test string — deterministic across runs, distinct per input, and
 * unforgeable enough for tests that flip checkpoint bytes.
 */
export class FakeMacCrypto {
  constructor(private readonly key = 'fake-test-mac-key') {}

  mac(data: string): string {
    return sha256(`${this.key}\x00${data}`);
  }
}

interface FakeEdge {
  a: string;
  b: string;
  kind: string;
  weight: number;
  events: number;
  lastReinforcedAt: number;
  createdAt: number;
}

/**
 * Pure in-memory StorageDriver for browser-clean core tests (no SQLite, no fs). Faithful enough
 * to exercise the journal service and rollback planner; the real better-sqlite3 driver is
 * covered by cli + safety tests.
 */
export class FakeStore implements StorageDriver {
  private journalRows: JournalRecord[] = [];
  private memories = new Map<string, Memory>();
  private meta = new Map<string, string>();
  private edges = new Map<string, FakeEdge>();
  private seq = 0;

  migrate(): void {
    /* no-op: schema is implicit in memory */
  }

  private txOpen = false;

  /** Mirrors SqliteDriver.afterCommit: queued while a transaction is open, drained after the
   *  OUTERMOST transaction commits, discarded on rollback; immediate outside any transaction. */
  private afterCommitQueue: (() => void)[] = [];

  afterCommit(cb: () => void): void {
    if (this.txOpen) {
      this.afterCommitQueue.push(cb);
    } else {
      cb();
    }
  }

  transaction<T>(fn: () => T): T {
    if (this.txOpen) {
      return fn(); // join the enclosing transaction, mirroring the SQLite driver
    }
    const snapshot = {
      journal: [...this.journalRows],
      memories: new Map(this.memories),
      meta: new Map(this.meta),
      edges: new Map([...this.edges.entries()].map(([k, v]) => [k, { ...v }])),
      entities: this.entities.map((e) => ({ ...e })),
      seq: this.seq,
    };
    this.txOpen = true;
    let result: T;
    try {
      result = fn();
    } catch (err) {
      this.journalRows = snapshot.journal;
      this.memories = snapshot.memories;
      this.meta = snapshot.meta;
      this.edges = snapshot.edges;
      this.entities = snapshot.entities;
      this.seq = snapshot.seq;
      this.afterCommitQueue = []; // rolled back: queued callbacks must never run
      this.txOpen = false;
      throw err;
    }
    this.txOpen = false;
    const queued = this.afterCommitQueue;
    this.afterCommitQueue = [];
    for (const cb of queued) {
      cb();
    }
    return result;
  }

  writeTransaction<T>(fn: () => T): T {
    return this.transaction(fn);
  }

  inTransaction(): boolean {
    return this.txOpen;
  }

  close(): void {
    /* no-op */
  }

  getMeta(key: string): string | undefined {
    return this.meta.get(key);
  }
  setMeta(key: string, value: string): void {
    this.meta.set(key, value);
  }

  insertMemory(memory: Memory): void {
    this.memories.set(memory.id, { ...memory });
  }
  getMemory(id: string): Memory | undefined {
    const m = this.memories.get(id);
    return m ? { ...m } : undefined;
  }
  updateMemory(id: string, patch: Partial<Memory>): void {
    const existing = this.memories.get(id);
    if (existing) {
      this.memories.set(id, { ...existing, ...patch });
    }
  }
  deleteMemory(id: string): void {
    this.memories.delete(id);
  }
  /** Test hook: how many times listMemories ran — pagination tests prove the paged path
   *  never materializes the full queue through it. */
  listMemoriesCalls = 0;

  listMemories(filter?: MemoryFilter): Memory[] {
    this.listMemoriesCalls += 1;
    let rows = this.filterMemories(filter);
    if (filter?.limit != null) {
      rows = rows.slice(0, filter.limit);
    }
    return rows.map((m) => ({ ...m }));
  }
  countMemories(filter?: MemoryFilter): number {
    return this.filterMemories(filter).length;
  }

  /** Mirrors SqliteDriver.listMemoriesPage: filtered, newest-first (id desc tiebreak), sliced —
   *  and deliberately NOT routed through listMemories (see listMemoriesCalls). */
  listMemoriesPage(
    filter: MemoryFilter | undefined,
    page: { limit: number; offset: number },
  ): { rows: Memory[]; total: number } {
    const matched = this.filterMemories(filter).sort(
      (a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    );
    return {
      rows: matched.slice(page.offset, page.offset + page.limit).map((m) => ({ ...m })),
      total: matched.length,
    };
  }

  private filterMemories(filter?: MemoryFilter): Memory[] {
    let rows = [...this.memories.values()];
    if (filter?.status) {
      rows = rows.filter((m) => m.status === filter.status);
    }
    if (filter?.type) {
      rows = rows.filter((m) => m.type === filter.type);
    }
    if (filter?.scope) {
      rows = rows.filter((m) => m.scope === filter.scope);
    }
    return rows;
  }

  searchMemories(query: string, opts?: SearchOptions): MemorySearchRow[] {
    const statuses = opts?.includeStatuses ?? ['proposed', 'confirmed'];
    const tokens = queryTokens(query);
    const rows: MemorySearchRow[] = [];
    for (const m of this.memories.values()) {
      if (!statuses.includes(m.status)) {
        continue;
      }
      if (opts?.scope !== undefined && m.scope !== opts.scope) {
        continue;
      }
      const content = m.content.toLowerCase();
      const matches = tokens.filter((t) => content.includes(t)).length;
      if (tokens.length === 0 || matches > 0) {
        // fake bm25: more token matches + shorter content => "better" (more negative)
        rows.push({ memory: { ...m }, bm25: -(matches + 1) / (1 + content.length / 100) });
      }
    }
    rows.sort((a, b) => a.bm25 - b.bm25);
    return opts?.limit != null ? rows.slice(0, opts.limit) : rows;
  }

  bumpRetrieval(ids: string[], now: number): void {
    for (const id of ids) {
      const m = this.memories.get(id);
      if (m) {
        this.memories.set(id, { ...m, lastRetrievedAt: now, boosts: m.boosts + 1 });
      }
    }
  }

  private mcp: McpEntry[] = [];
  listMcpEntries(name?: string): McpEntry[] {
    return this.mcp.filter((e) => !name || e.name === name);
  }

  private entities: Entity[] = [];
  insertEntity(entity: Entity): void {
    this.entities.push({ ...entity });
  }
  listEntities(kind?: EntityKind): Entity[] {
    return this.entities.filter((e) => !kind || e.kind === kind).map((e) => ({ ...e }));
  }

  appendJournal(entry: SealedJournalEntry): JournalRecord {
    const row: JournalRecord = { id: ++this.seq, ...entry };
    this.journalRows.push(row);
    return row;
  }
  lastJournalHash(): string | null {
    const last = this.journalRows[this.journalRows.length - 1];
    return last ? last.hash : null;
  }
  recentJournal(n: number): JournalRecord[] {
    return this.journalRows.slice(-n).reverse();
  }
  allJournal(): JournalRecord[] {
    return [...this.journalRows];
  }
  journalSince(id: number, limit?: number): JournalRecord[] {
    const rows = this.journalRows.filter((r) => r.id > id);
    return limit != null ? rows.slice(0, limit) : rows;
  }

  private edgeKey(a: string, b: string, kind: string): string {
    return `${a}\x00${b}\x00${kind}`;
  }

  applyAssocDelta(d: EdgeDelta): void {
    const key = this.edgeKey(d.a, d.b, d.kind);
    const row = this.edges.get(key);
    if (row) {
      row.weight = decayedWeight(row.weight, row.lastReinforcedAt, d.ts) + d.delta;
      row.events += 1;
      row.lastReinforcedAt = d.ts;
    } else {
      this.edges.set(key, {
        a: d.a,
        b: d.b,
        kind: d.kind,
        weight: d.delta,
        events: 1,
        lastReinforcedAt: d.ts,
        createdAt: d.ts,
      });
    }
  }

  rewireAssoc(from: string, to: string, now: number): void {
    const incident = [...this.edges.values()]
      .filter((e) => e.a === from || e.b === from)
      .sort(
        (x, y) => x.a.localeCompare(y.a) || x.b.localeCompare(y.b) || x.kind.localeCompare(y.kind),
      );
    for (const e of incident) {
      this.edges.delete(this.edgeKey(e.a, e.b, e.kind));
      const other = e.a === from ? e.b : e.a;
      if (other === to) {
        continue;
      }
      const [na, nb] = to < other ? [to, other] : [other, to];
      const carried = decayedWeight(e.weight, e.lastReinforcedAt, now);
      const key = this.edgeKey(na, nb, e.kind);
      const existing = this.edges.get(key);
      if (existing) {
        existing.weight = decayedWeight(existing.weight, existing.lastReinforcedAt, now) + carried;
        existing.events += e.events;
        existing.lastReinforcedAt = now;
      } else {
        this.edges.set(key, {
          a: na,
          b: nb,
          kind: e.kind,
          weight: carried,
          events: e.events,
          lastReinforcedAt: now,
          createdAt: e.createdAt,
        });
      }
    }
  }

  neighborsAssoc(ids: string[]): AssocEdgeRow[] {
    const idSet = new Set(ids);
    const live = (id: string): boolean => {
      const m = this.memories.get(id);
      return m !== undefined && (m.status === 'proposed' || m.status === 'confirmed');
    };
    return [...this.edges.values()]
      .filter((e) => (idSet.has(e.a) || idSet.has(e.b)) && live(e.a) && live(e.b))
      .sort(
        (x, y) => x.a.localeCompare(y.a) || x.b.localeCompare(y.b) || x.kind.localeCompare(y.kind),
      )
      .map((e) => ({
        a: e.a,
        b: e.b,
        kind: e.kind,
        weight: e.weight,
        lastReinforcedAt: e.lastReinforcedAt,
      }));
  }

  clearAssoc(): void {
    this.edges.clear();
  }

  countAssocEdges(): number {
    return this.edges.size;
  }

  /** Test hook: raw edge rows sorted canonically — for rebuild-determinism assertions. */
  snapshotEdges(): FakeEdge[] {
    return [...this.edges.values()]
      .map((e) => ({ ...e }))
      .sort(
        (x, y) => x.a.localeCompare(y.a) || x.b.localeCompare(y.b) || x.kind.localeCompare(y.kind),
      );
  }
}
