import { decayedWeight } from './fold.js';

/**
 * Spreading activation over the association graph (ACT-R fan normalization). A seed's lexical
 * evidence spreads to its associates in proportion to each edge's share of the seed's total live
 * association mass: s(i→j) = w_eff(i,j) / (W_i + 1). The +1 Laplace term stops a node with one
 * weak edge from granting its neighbor a share of ~1.0; the division is the fan effect made
 * physical — hubs dilute, specific associations concentrate.
 *
 * Two hops: hop 1 finds direct associates; hop 2 finds transitive bridges (A–B under one query,
 * B–C under another ⇒ a query hitting A surfaces C). Hop-3 mass after two fan divisions is noise.
 * Total activation is capped at 1 so maximal associative evidence equals maximal lexical evidence.
 */

export interface SpreadEdge {
  a: string;
  b: string;
  weight: number;
  lastReinforcedAt: number;
}

/** Weight of associative evidence relative to lexical evidence in the fused score. 0.5 = a
 *  pure-associative candidate at full activation is worth half a top lexical hit, before
 *  confidence/recency — associative recall supplements lexical evidence, never overrides it. */
export const GAMMA = 0.5;
/** Hop-1 nodes kept as hop-2 sources (strongest first; ties broken by id for determinism). */
export const FRONTIER = 16;

interface Adjacency {
  /** neighbor id → effective weight */
  out: Map<string, Map<string, number>>;
  /** total live association mass per node */
  mass: Map<string, number>;
}

function buildAdjacency(edges: SpreadEdge[], now: number): Adjacency {
  const out = new Map<string, Map<string, number>>();
  const mass = new Map<string, number>();
  const touch = (from: string, to: string, w: number): void => {
    let m = out.get(from);
    if (!m) {
      m = new Map();
      out.set(from, m);
    }
    m.set(to, (m.get(to) ?? 0) + w);
    mass.set(from, (mass.get(from) ?? 0) + w);
  };
  for (const e of edges) {
    const w = decayedWeight(e.weight, e.lastReinforcedAt, now);
    if (w <= 0) {
      continue;
    }
    touch(e.a, e.b, w);
    touch(e.b, e.a, w);
  }
  return { out, mass };
}

function spreadFrom(
  sources: Map<string, number>,
  adj: Adjacency,
  into: Map<string, number>,
  skip?: ReadonlySet<string>,
): void {
  // Deterministic iteration: sources sorted by id (Map order is insertion order otherwise).
  for (const [id, activation] of [...sources.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    const neighbors = adj.out.get(id);
    if (!neighbors || activation <= 0) {
      continue;
    }
    const denom = (adj.mass.get(id) ?? 0) + 1;
    for (const [nb, w] of neighbors) {
      if (skip?.has(nb)) {
        continue;
      }
      into.set(nb, (into.get(nb) ?? 0) + (activation * w) / denom);
    }
  }
}

/**
 * Hop-1 activations only — used by AssocService to pick the frontier BEFORE fetching hop-2
 * edges, so the second edge query is bounded by FRONTIER, not by hop-1 fan-out.
 */
export function hop1Activation(
  seeds: Map<string, number>,
  edges: SpreadEdge[],
  now: number,
): Map<string, number> {
  const out = new Map<string, number>();
  if (seeds.size === 0 || edges.length === 0) {
    return out;
  }
  spreadFrom(seeds, buildAdjacency(edges, now), out);
  return out;
}

/**
 * seeds: memory id → lexNorm in (0,1]. edges: all live-endpoint edges incident to the seeds and
 * (for hop 2) to the hop-1 frontier. Returns id → assoc activation in [0,1] (zeros omitted).
 *
 * Hop 2 never contributes INTO a seed: an A→N→A path is pure echo of A's own lexical evidence
 * (no new information), and with fan shares it would grow with A's own mass. Seed↔seed hop-1
 * edges — genuine corroboration — still count.
 */
export function spreadActivation(
  seeds: Map<string, number>,
  edges: SpreadEdge[],
  now: number,
): Map<string, number> {
  if (seeds.size === 0 || edges.length === 0) {
    return new Map();
  }
  const adj = buildAdjacency(edges, now);

  const hop1 = new Map<string, number>();
  spreadFrom(seeds, adj, hop1);

  const frontier = new Map(
    [...hop1.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).slice(0, FRONTIER),
  );
  const hop2 = new Map<string, number>();
  spreadFrom(frontier, adj, hop2, new Set(seeds.keys()));

  const assoc = new Map<string, number>();
  for (const [id, a] of hop1) {
    assoc.set(id, a);
  }
  for (const [id, a] of hop2) {
    assoc.set(id, (assoc.get(id) ?? 0) + a);
  }
  for (const [id, a] of assoc) {
    assoc.set(id, Math.min(1, a));
  }
  return assoc;
}
