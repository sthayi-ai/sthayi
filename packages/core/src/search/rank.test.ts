import { compositeScore, recencyBoost } from '@sthayi/core';
import { describe, expect, it } from 'vitest';

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;
const base = { confidence: 0.5, lastRetrievedAt: null, createdAt: NOW, boosts: 0 };

describe('compositeScore', () => {
  it('THE SIGN TRAP: a stronger match (more negative bm25) scores higher', () => {
    expect(compositeScore(-5, base, NOW)).toBeGreaterThan(compositeScore(-1, base, NOW));
  });

  it('higher confidence ranks higher', () => {
    expect(compositeScore(-2, { ...base, confidence: 0.9 }, NOW)).toBeGreaterThan(
      compositeScore(-2, { ...base, confidence: 0.2 }, NOW),
    );
  });

  it('more boosts ranks higher (retrieved-and-kept rises)', () => {
    expect(compositeScore(-2, { ...base, boosts: 5 }, NOW)).toBeGreaterThan(
      compositeScore(-2, { ...base, boosts: 0 }, NOW),
    );
  });

  it('a positive-bm25 (worse) input never beats a negative-bm25 one', () => {
    expect(compositeScore(-2, base, NOW)).toBeGreaterThan(compositeScore(2, base, NOW));
  });

  it('is deterministic', () => {
    expect(compositeScore(-3, base, NOW)).toBe(compositeScore(-3, base, NOW));
  });
});

describe('recencyBoost', () => {
  it('is ~1.0 for a just-retrieved memory and decays with age', () => {
    const recent = recencyBoost({ lastRetrievedAt: NOW, createdAt: NOW, boosts: 0 }, NOW);
    const old = recencyBoost(
      { lastRetrievedAt: NOW - 400 * DAY, createdAt: NOW - 400 * DAY, boosts: 0 },
      NOW,
    );
    expect(recent).toBeCloseTo(1, 5);
    expect(recent).toBeGreaterThan(old);
    expect(old).toBeGreaterThanOrEqual(0.5);
  });

  it('falls back to createdAt when never retrieved', () => {
    const v = recencyBoost({ lastRetrievedAt: null, createdAt: NOW, boosts: 0 }, NOW);
    expect(v).toBeCloseTo(1, 5);
  });
});
