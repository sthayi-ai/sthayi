import type { JournalRecord } from '../domain/journal.js';

/**
 * Samskara — the associative layer's fold. The edge table is DERIVED state: every mutation is a
 * pure function of journal entries, applied in journal order behind a cursor (`meta.assoc_cursor`).
 * Nothing writes an edge except this fold, which is what makes "rebuild from zero produces an
 * identical table" a testable invariant rather than a slogan (see assoc integration tests).
 *
 * Sources folded:
 *  - `memory_retrieve` {ids}: memories returned together for one query wire together (Hebbian
 *    co-retrieval). Per-event mass is bounded: each pair gets δ = 1/(k−1), so one retrieval
 *    contributes at most 1 unit of new association mass per participating memory, however big k is.
 *  - `consolidate` changes with `mergedInto`: the archived memory's association mass is re-pointed
 *    to the merge survivor (rewire), so consolidation never strands edge weight on dead nodes.
 *  - `rollback`: a deliberate no-op. Un-archived memories revive with whatever edges they still
 *    have; edges to rolled-back (deleted) inserts are invisible at read time because every read
 *    joins against live memory status. Treating rollback as a no-op keeps the fold total and
 *    order-deterministic — no scoped re-fold, no special recovery path.
 */

/** Half-life of an association edge. 3× the 30-day item-recency half-life: associative structure
 *  should consolidate slower than item salience and survive usage gaps (ACT-R base-level decay). */
export const EDGE_HALF_LIFE_DAYS = 90;
const DAY_MS = 86_400_000;

export type AssocKind = 'coretrieval';

export interface EdgeDelta {
  /** canonical undirected pair: a < b lexicographically */
  a: string;
  b: string;
  kind: AssocKind;
  delta: number;
  ts: number;
}

export interface Rewire {
  from: string;
  to: string;
  ts: number;
}

export interface FoldStep {
  deltas: EdgeDelta[];
  rewires: Rewire[];
}

/** Decay a stored weight from when it was last reinforced to `now`. Pure — no SQL math funcs. */
export function decayedWeight(weight: number, lastReinforcedAt: number, now: number): number {
  const days = Math.max(0, (now - lastReinforcedAt) / DAY_MS);
  return weight * 2 ** (-days / EDGE_HALF_LIFE_DAYS);
}

/** Pairwise deltas for one co-retrieval event, δ = 1/(k−1) per pair, pairs canonicalized a < b. */
export function coRetrievalDeltas(ids: string[], ts: number): EdgeDelta[] {
  const unique = [...new Set(ids)].sort();
  const k = unique.length;
  if (k < 2) {
    return [];
  }
  const delta = 1 / (k - 1);
  const out: EdgeDelta[] = [];
  for (let i = 0; i < k; i++) {
    for (let j = i + 1; j < k; j++) {
      // biome-ignore lint/style/noNonNullAssertion: i/j bounded by k
      out.push({ a: unique[i]!, b: unique[j]!, kind: 'coretrieval', delta, ts });
    }
  }
  return out;
}

interface RetrievePayload {
  ids?: unknown;
}

interface ConsolidatePayload {
  changes?: unknown;
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** Fold one journal record into edge deltas + rewires. Total: unknown ops fold to nothing. */
export function foldRecord(record: JournalRecord): FoldStep {
  if (record.op === 'memory_retrieve') {
    const ids = stringArray((record.payload as RetrievePayload | null)?.ids);
    return { deltas: coRetrievalDeltas(ids, record.ts), rewires: [] };
  }
  if (record.op === 'consolidate') {
    const changes = (record.payload as ConsolidatePayload | null)?.changes;
    const rewires: Rewire[] = [];
    if (Array.isArray(changes)) {
      for (const c of changes) {
        if (
          c &&
          typeof c === 'object' &&
          (c as { kind?: unknown }).kind === 'memory_status' &&
          typeof (c as { id?: unknown }).id === 'string' &&
          typeof (c as { mergedInto?: unknown }).mergedInto === 'string'
        ) {
          rewires.push({
            from: (c as { id: string }).id,
            to: (c as { mergedInto: string }).mergedInto,
            ts: record.ts,
          });
        }
      }
    }
    return { deltas: [], rewires };
  }
  return { deltas: [], rewires: [] };
}
