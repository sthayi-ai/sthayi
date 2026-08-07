import { describe, expect, it } from 'vitest';
import { FRONTIER, type SpreadEdge, spreadActivation } from './spread.js';

const NOW = 1_000_000;

function edge(a: string, b: string, weight: number): SpreadEdge {
  const [x, y] = a < b ? [a, b] : [b, a];
  return { a: x, b: y, weight, lastReinforcedAt: NOW };
}

describe('spreading activation (ACT-R fan normalization)', () => {
  it('spreads seed activation in proportion to each edge share of live mass', () => {
    // seed s has two associates: strong (3) and weak (1); W_s = 4, so shares are 3/5 and 1/5.
    const out = spreadActivation(
      new Map([['s', 1]]),
      [edge('s', 'strong', 3), edge('s', 'weak', 1)],
      NOW,
    );
    expect(out.get('strong')).toBeCloseTo(3 / 5, 10);
    expect(out.get('weak')).toBeCloseTo(1 / 5, 10);
  });

  it('the fan effect: a hub with many associates grants each a smaller share', () => {
    const hubEdges = [
      edge('s', 'n1', 1),
      edge('s', 'n2', 1),
      edge('s', 'n3', 1),
      edge('s', 'n4', 1),
    ];
    const focused = spreadActivation(new Map([['s', 1]]), [edge('s', 'only', 1)], NOW);
    const fanned = spreadActivation(new Map([['s', 1]]), hubEdges, NOW);
    expect(focused.get('only')).toBeCloseTo(1 / 2, 10); // 1/(1+1)
    expect(fanned.get('n1')).toBeCloseTo(1 / 5, 10); // 1/(4+1)
    expect((fanned.get('n1') as number) < (focused.get('only') as number)).toBe(true);
  });

  it('two hops surface a transitive bridge; activation is capped at 1', () => {
    // a—b wired under one query, b—c under another: seeding a must surface c.
    const edges = [edge('a', 'b', 5), edge('b', 'c', 5)];
    const out = spreadActivation(new Map([['a', 1]]), edges, NOW);
    expect(out.get('b')).toBeGreaterThan(0);
    expect(out.get('c')).toBeGreaterThan(0);
    expect(out.get('c') as number).toBeLessThan(out.get('b') as number);
    for (const v of out.values()) {
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('hop-2 sources are limited to the strongest FRONTIER hop-1 nodes', () => {
    // seed s → many mid nodes; each mid → one leaf. Leaves past the frontier get nothing.
    const edges: SpreadEdge[] = [];
    const n = FRONTIER + 8;
    for (let i = 0; i < n; i++) {
      const mid = `mid${String(i).padStart(2, '0')}`;
      edges.push(edge('s', mid, n - i)); // descending strength
      edges.push(edge(mid, `leaf${String(i).padStart(2, '0')}`, 10));
    }
    const out = spreadActivation(new Map([['s', 1]]), edges, NOW);
    expect(out.get('leaf00')).toBeGreaterThan(0);
    expect(out.get(`leaf${String(n - 1).padStart(2, '0')}`)).toBeUndefined();
  });

  it('is deterministic regardless of edge input order', () => {
    const edges = [edge('s', 'x', 2), edge('s', 'y', 3), edge('x', 'y', 1), edge('y', 'z', 4)];
    const seeds = new Map([
      ['s', 1],
      ['x', 0.4],
    ]);
    const a = spreadActivation(seeds, edges, NOW);
    const b = spreadActivation(seeds, [...edges].reverse(), NOW);
    expect([...a.entries()].sort()).toEqual([...b.entries()].sort());
  });

  it('returns empty for no seeds or no edges', () => {
    expect(spreadActivation(new Map(), [edge('a', 'b', 1)], NOW).size).toBe(0);
    expect(spreadActivation(new Map([['a', 1]]), [], NOW).size).toBe(0);
  });
});
