import { describe, expect, it } from 'vitest';
import type { JournalRecord } from '../domain/journal.js';
import { EDGE_HALF_LIFE_DAYS, coRetrievalDeltas, decayedWeight, foldRecord } from './fold.js';

const DAY = 86_400_000;

function record(op: string, payload: unknown, id = 1, ts = 1000): JournalRecord {
  return {
    id,
    ts,
    actor: 't',
    op,
    payload,
    promptVersion: null,
    model: null,
    prevHash: null,
    hash: 'h',
  };
}

describe('assoc fold (Samskara)', () => {
  it('co-retrieval mass is bounded: δ = 1/(k−1) per pair, canonical a < b', () => {
    const deltas = coRetrievalDeltas(['m3', 'm1', 'm2'], 5);
    expect(deltas).toHaveLength(3); // C(3,2)
    for (const d of deltas) {
      expect(d.a < d.b).toBe(true);
      expect(d.delta).toBeCloseTo(0.5, 10); // 1/(3-1)
      expect(d.ts).toBe(5);
    }
    // each memory participates in (k−1) pairs → contributes exactly 1 unit of mass per event
    const perNode = new Map<string, number>();
    for (const d of deltas) {
      perNode.set(d.a, (perNode.get(d.a) ?? 0) + d.delta);
      perNode.set(d.b, (perNode.get(d.b) ?? 0) + d.delta);
    }
    for (const total of perNode.values()) {
      expect(total).toBeCloseTo(1, 10);
    }
  });

  it('a single-id or duplicate-id retrieval mints no edges', () => {
    expect(coRetrievalDeltas(['m1'], 1)).toHaveLength(0);
    expect(coRetrievalDeltas(['m1', 'm1'], 1)).toHaveLength(0);
    expect(coRetrievalDeltas([], 1)).toHaveLength(0);
  });

  it('decayedWeight halves at the edge half-life and never grows', () => {
    expect(decayedWeight(2, 0, EDGE_HALF_LIFE_DAYS * DAY)).toBeCloseTo(1, 10);
    expect(decayedWeight(2, 0, 0)).toBe(2);
    // clock skew (now < lastReinforced) clamps to no decay rather than amplifying
    expect(decayedWeight(2, 1000, 0)).toBe(2);
  });

  it('foldRecord: memory_retrieve → deltas; consolidate mergedInto → rewires; rollback → nothing', () => {
    const retrieve = foldRecord(record('memory_retrieve', { ids: ['a', 'b'] }));
    expect(retrieve.deltas).toHaveLength(1);
    expect(retrieve.rewires).toHaveLength(0);

    const consolidate = foldRecord(
      record('consolidate', {
        changes: [
          {
            kind: 'memory_status',
            id: 'loser',
            from: 'confirmed',
            to: 'archived',
            mergedInto: 'winner',
          },
          { kind: 'memory_status', id: 'decayed', from: 'confirmed', to: 'archived' }, // no mergedInto
          { kind: 'memory_insert', id: 'new1', distilledFrom: ['loser'] },
        ],
      }),
    );
    expect(consolidate.deltas).toHaveLength(0);
    expect(consolidate.rewires).toEqual([{ from: 'loser', to: 'winner', ts: 1000 }]);

    // rollback is deliberately a no-op: live-status joins hide rolled-back nodes at read time,
    // and a total, order-deterministic fold is what makes rebuild-from-zero byte-identical.
    expect(foldRecord(record('rollback', { rollsBack: 3, inverse: [] }))).toEqual({
      deltas: [],
      rewires: [],
    });
    expect(foldRecord(record('memory_write', { ids: ['x'] }))).toEqual({ deltas: [], rewires: [] });
  });

  it('foldRecord tolerates malformed payloads (never throws)', () => {
    expect(foldRecord(record('memory_retrieve', null))).toEqual({ deltas: [], rewires: [] });
    expect(foldRecord(record('memory_retrieve', { ids: 'nope' }))).toEqual({
      deltas: [],
      rewires: [],
    });
    expect(foldRecord(record('memory_retrieve', { ids: [1, 2] }))).toEqual({
      deltas: [],
      rewires: [],
    });
    expect(foldRecord(record('consolidate', { changes: 'nope' }))).toEqual({
      deltas: [],
      rewires: [],
    });
    expect(foldRecord(record('consolidate', { changes: [null, 42, {}] }))).toEqual({
      deltas: [],
      rewires: [],
    });
  });
});
