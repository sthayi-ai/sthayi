import type { Memory } from '../domain/memory.js';

const DAY_MS = 86_400_000;
/** Half-life (days) of the recency component. */
const RECENCY_HALF_LIFE_DAYS = 30;
/** Per-boost multiplier — retrieved-and-kept memories rank higher over time. */
const BOOST_WEIGHT = 0.2;

/**
 * recencyBoost(last_retrieved_at, boosts) — spec §3. Combines a decaying recency term
 * (1.0 just retrieved → 0.5 long ago) with a boost multiplier. Never-retrieved memories fall back
 * to their creation time. Always ≥ 0.5, so a stale-but-relevant hit is dampened, never erased.
 */
export function recencyBoost(
  memory: Pick<Memory, 'lastRetrievedAt' | 'createdAt' | 'boosts'>,
  now: number,
): number {
  const reference = memory.lastRetrievedAt ?? memory.createdAt;
  const days = Math.max(0, (now - reference) / DAY_MS);
  const recency = 0.5 + 0.5 * Math.exp((-Math.LN2 * days) / RECENCY_HALF_LIFE_DAYS);
  const boostFactor = 1 + Math.max(0, memory.boosts) * BOOST_WEIGHT;
  return recency * boostFactor;
}

/**
 * Composite ranking score (spec §3): `bm25 × confidence × recencyBoost`. THE SIGN TRAP
 * (sqlite-fts5 skill): `bm25()` returns lower = better (typically negative), so we negate it first —
 * otherwise the multiplication inverts the ranking. Higher composite score = better hit.
 */
export function compositeScore(
  bm25: number,
  memory: Pick<Memory, 'confidence' | 'lastRetrievedAt' | 'createdAt' | 'boosts'>,
  now: number,
): number {
  return -bm25 * memory.confidence * recencyBoost(memory, now);
}
