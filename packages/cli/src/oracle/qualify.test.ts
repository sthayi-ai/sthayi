import type { ProviderPort } from '@sthayi/core';
import { describe, expect, it } from 'vitest';
import { qualify } from './qualify.js';

/** A provider that always returns an all-empty (valid) response. */
const emptyProvider: ProviderPort = {
  id: 'mock:empty',
  complete: async () => '{"merge":[],"archive":[],"promote":[],"contradictions":[]}',
};

describe('qualify (mock provider, real prompt pack)', () => {
  it('runs every fixture and passes exactly the empty-expect ones with an empty provider', async () => {
    const results = await qualify(emptyProvider);
    expect(results).toHaveLength(9); // 3 ops × 3 fixtures
    const passing = results
      .filter((r) => r.pass)
      .map((r) => `${r.op}/${r.fixture}`)
      .sort();
    expect(passing).toEqual(['consolidate/03.json', 'contradictions/03.json']);
  });

  it('reports an actionable reason on failure', async () => {
    const results = await qualify(emptyProvider);
    const failed = results.find((r) => !r.pass);
    expect(failed?.reason).toBeTruthy();
  });
});
