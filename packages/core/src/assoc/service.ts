import type { StorageDriver } from '../store/driver.js';
import { type FoldStep, foldRecord } from './fold.js';
import { FRONTIER, type SpreadEdge, hop1Activation, spreadActivation } from './spread.js';

/** Journal cursor key in the `meta` k/v table: the last journal id folded into the edge table. */
export const ASSOC_CURSOR_KEY = 'assoc_cursor';

/** Journal entries folded per transaction. Bounds write-lock hold time so a cold fold of a large
 *  journal (the first search after upgrading an old store) never starves concurrent writers. */
export const FOLD_CHUNK = 500;

/**
 * The associative layer's service: keeps the derived edge table caught up with the journal and
 * runs spreading activation for the ranker. ALL edge writes flow through `catchUp` — including
 * a search's own just-appended retrieve entry, which is folded by calling catchUp again inside
 * the bump transaction (the entry is visible to the connection, and any entries another process
 * committed in between are folded too — the cursor can never jump past unfolded history).
 * `rebuild` drops the table and re-folds the full journal; because the fold is total and
 * deterministic, rebuild-from-zero and live accumulation produce identical tables.
 */
export class AssocService {
  constructor(private readonly store: StorageDriver) {}

  private cursor(): number {
    return Number(this.store.getMeta(ASSOC_CURSOR_KEY) ?? '0');
  }

  private apply(step: FoldStep): void {
    for (const d of step.deltas) {
      this.store.applyAssocDelta(d);
    }
    for (const r of step.rewires) {
      this.store.rewireAssoc(r.from, r.to, r.ts);
    }
  }

  /**
   * Fold all journal entries past the cursor, in bounded chunks (one transaction each — inside
   * an outer transaction they become savepoints). Cheap when caught up: one indexed query.
   */
  catchUp(): void {
    for (;;) {
      const done = this.store.transaction(() => {
        const from = this.cursor();
        const entries = this.store.journalSince(from, FOLD_CHUNK);
        if (entries.length === 0) {
          return true;
        }
        for (const e of entries) {
          this.apply(foldRecord(e));
        }
        const last = entries[entries.length - 1];
        if (last) {
          this.store.setMeta(ASSOC_CURSOR_KEY, String(last.id));
        }
        return entries.length < FOLD_CHUNK;
      });
      if (done) {
        return;
      }
    }
  }

  /** Drop and re-derive the whole edge table from the journal. Returns edges after rebuild. */
  rebuild(): number {
    // writeTransaction at the top; the catchUp chunks inside stay plain transaction() ON PURPOSE —
    // nested they become savepoints, which is what lets a chunk failure degrade without rolling
    // back the host transaction (a fold failure inside a host transaction must degrade, never
    // roll back the host).
    return this.store.writeTransaction(() => {
      this.store.clearAssoc();
      this.store.setMeta(ASSOC_CURSOR_KEY, '0');
      this.catchUp();
      return this.store.countAssocEdges();
    });
  }

  /**
   * Spreading activation for one query: seeds are the FTS hits (id → lexNorm). Fetches
   * live-endpoint edges for the seeds, picks the hop-1 frontier from those edges alone, then
   * fetches ONLY the frontier's edges — both queries bounded (≤ seeds, ≤ FRONTIER ids).
   */
  spread(seeds: Map<string, number>, now: number): Map<string, number> {
    if (seeds.size === 0) {
      return new Map();
    }
    const seedIds = [...seeds.keys()];
    const hop1Edges = this.store.neighborsAssoc(seedIds);
    if (hop1Edges.length === 0) {
      return new Map();
    }
    const a1 = hop1Activation(seeds, hop1Edges, now);
    const frontierIds = [...a1.entries()]
      .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
      .slice(0, FRONTIER)
      .map(([id]) => id)
      .filter((id) => !seeds.has(id));
    const hop2Edges = frontierIds.length > 0 ? this.store.neighborsAssoc(frontierIds) : [];
    const seen = new Set<string>();
    const edges: SpreadEdge[] = [];
    for (const e of [...hop1Edges, ...hop2Edges]) {
      const key = `${e.a} ${e.b} ${e.kind}`;
      if (!seen.has(key)) {
        seen.add(key);
        edges.push(e);
      }
    }
    return spreadActivation(seeds, edges, now);
  }
}
