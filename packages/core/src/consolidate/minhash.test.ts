import { estimateJaccard, minhashSignature, nearDupePairs, shingles } from '@sthayi/core';
import { describe, expect, it } from 'vitest';

describe('MinHash', () => {
  it('produces k-token shingles', () => {
    expect(shingles('a b c d e f', 5)).toEqual(['a b c d e', 'b c d e f']);
  });

  it('scores near-identical text high and different text low', () => {
    const a = 'the user prefers pnpm over npm for all typescript projects always';
    const b = 'the user prefers pnpm over npm for all typescript work always';
    const c = 'weather in seattle tends to be rainy through the winter months';
    expect(estimateJaccard(minhashSignature(a), minhashSignature(b))).toBeGreaterThan(0.5);
    expect(estimateJaccard(minhashSignature(a), minhashSignature(c))).toBeLessThan(0.3);
  });

  it('gives identical content a similarity of 1', () => {
    const s = 'exact same content here for both of them to compare closely';
    expect(estimateJaccard(minhashSignature(s), minhashSignature(s))).toBe(1);
  });

  it('nearDupePairs finds the pair above threshold', () => {
    const items = [
      { c: 'alpha beta gamma delta epsilon zeta eta theta' },
      { c: 'alpha beta gamma delta epsilon zeta eta iota' },
      { c: 'completely different words with nothing in common here' },
    ];
    const pairs = nearDupePairs(items, (i) => i.c, 0.6);
    expect(pairs).toHaveLength(1);
  });
});
