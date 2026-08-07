import type { Memory } from '../domain/memory.js';

const DAY_MS = 86_400_000;

export interface DecayConfig {
  /** decay rate per day (spec §6) */
  lambda: number;
  /** below this effective confidence a memory is archived */
  floor: number;
  /** each retained retrieval offsets decay a little */
  boostOffset: number;
}

export const DEFAULT_DECAY: DecayConfig = { lambda: 0.02, floor: 0.12, boostOffset: 0.05 };

/**
 * Effective confidence after forgetting (spec §6): `confidence · e^(−λ·daysSinceRetrieval)` plus a
 * small per-boost offset. Never-retrieved memories decay from their creation time. This is policy
 * math — deterministic, keyless, runs in milliseconds.
 */
export function effectiveConfidence(
  memory: Pick<Memory, 'confidence' | 'boosts' | 'lastRetrievedAt' | 'createdAt'>,
  now: number,
  config: DecayConfig = DEFAULT_DECAY,
): number {
  const reference = memory.lastRetrievedAt ?? memory.createdAt;
  const days = Math.max(0, (now - reference) / DAY_MS);
  const decayed = memory.confidence * Math.exp(-config.lambda * days);
  return decayed + Math.max(0, memory.boosts) * config.boostOffset;
}

/** True when a memory has decayed below the floor and should be archived. */
export function shouldArchive(
  memory: Pick<Memory, 'confidence' | 'boosts' | 'lastRetrievedAt' | 'createdAt'>,
  now: number,
  config: DecayConfig = DEFAULT_DECAY,
): boolean {
  return effectiveConfidence(memory, now, config) < config.floor;
}
