import { queryTokens, sanitizeFtsQuery } from '@sthayi/core';
import { describe, expect, it } from 'vitest';

describe('sanitizeFtsQuery', () => {
  it('double-quotes each token and OR-joins them', () => {
    expect(sanitizeFtsQuery('federal proposal fema')).toBe('"federal" OR "proposal" OR "fema"');
  });

  it('neutralizes FTS operators so hostile input never throws', () => {
    for (const q of ['-foo', '"bar(', 'a AND b', 'x* OR y', '(((', 'NOT z', '"']) {
      expect(() => sanitizeFtsQuery(q)).not.toThrow();
    }
    expect(sanitizeFtsQuery('-foo "bar( AND')).toBe('"foo" OR "bar" OR "and"');
  });

  it('returns empty string for punctuation-only input', () => {
    expect(sanitizeFtsQuery('!!! ??? ---')).toBe('');
  });
});

describe('queryTokens', () => {
  it('splits on non-word characters, keeps underscores, lowercases', () => {
    expect(queryTokens('Hello, World_2!')).toEqual(['hello', 'world_2']);
  });

  it('returns [] for empty/punctuation input', () => {
    expect(queryTokens('   ')).toEqual([]);
    expect(queryTokens('***')).toEqual([]);
  });
});
