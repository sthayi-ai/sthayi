import { DEFAULT_DECAY, effectiveConfidence, shouldArchive } from '@sthayi/core';
import { describe, expect, it } from 'vitest';

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

describe('decay', () => {
  it('keeps a fresh, confident memory', () => {
    expect(
      shouldArchive({ confidence: 0.6, boosts: 0, lastRetrievedAt: null, createdAt: NOW }, NOW),
    ).toBe(false);
  });

  it('archives an old, never-retrieved, low-confidence memory', () => {
    const m = { confidence: 0.2, boosts: 0, lastRetrievedAt: null, createdAt: NOW - 400 * DAY };
    expect(effectiveConfidence(m, NOW)).toBeLessThan(DEFAULT_DECAY.floor);
    expect(shouldArchive(m, NOW)).toBe(true);
  });

  it('lets boosts offset decay', () => {
    const base = { confidence: 0.2, boosts: 0, lastRetrievedAt: null, createdAt: NOW - 200 * DAY };
    expect(effectiveConfidence({ ...base, boosts: 5 }, NOW)).toBeGreaterThan(
      effectiveConfidence(base, NOW),
    );
  });

  it('decays from last retrieval, not creation', () => {
    const old = NOW - 400 * DAY;
    const stale = { confidence: 0.5, boosts: 0, lastRetrievedAt: null, createdAt: old };
    const recentlyUsed = { confidence: 0.5, boosts: 0, lastRetrievedAt: NOW, createdAt: old };
    expect(effectiveConfidence(recentlyUsed, NOW)).toBeGreaterThan(effectiveConfidence(stale, NOW));
  });
});
