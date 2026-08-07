import { JournalService, MemoryService } from '@sthayi/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteDriver } from './sqlite.js';

const NOW = 1_700_000_000_000;

function setup() {
  const driver = SqliteDriver.openMemory();
  driver.migrate();
  const journal = new JournalService(driver);
  const memory = new MemoryService(driver, journal);
  return { driver, journal, memory };
}

describe('FTS5 search (real SQLite driver)', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });
  afterEach(() => ctx.driver.close());

  it('finds by token and keeps FTS in sync on UPDATE and DELETE (triggers)', () => {
    const m = ctx.memory.add(
      { type: 'semantic', content: 'Alex prefers pnpm and vitest' },
      { now: NOW, asProposal: false },
    );
    expect(
      ctx.memory.search('vitest', { now: NOW + 1, bump: false }).map((h) => h.memory.id),
    ).toContain(m.id);

    ctx.driver.updateMemory(m.id, { content: 'Alex now uses jest only' });
    expect(ctx.memory.search('vitest', { now: NOW + 2, bump: false })).toHaveLength(0);
    expect(
      ctx.memory.search('jest', { now: NOW + 2, bump: false }).map((h) => h.memory.id),
    ).toContain(m.id);

    ctx.driver.deleteMemory(m.id);
    expect(ctx.memory.search('jest', { now: NOW + 3, bump: false })).toHaveLength(0);
  });

  it('ranks the stronger match first (bm25 sign, end-to-end)', () => {
    ctx.memory.add(
      { type: 'semantic', content: 'the quick brown fox jumps' },
      { now: NOW, asProposal: false },
    );
    const target = ctx.memory.add(
      { type: 'semantic', content: 'federal proposal for fema flood mitigation grant' },
      { now: NOW, asProposal: false },
    );
    const hits = ctx.memory.search('federal fema proposal', { now: NOW + 1, bump: false });
    expect(hits[0]?.memory.id).toBe(target.id);
    expect(hits[0]?.score).toBeGreaterThan(0);
  });

  it('does not throw on hostile FTS input (sanitize + LIKE fallback)', () => {
    ctx.memory.add(
      { type: 'semantic', content: 'contains foo and bar' },
      { now: NOW, asProposal: false },
    );
    expect(() => ctx.memory.search('-foo "bar( AND', { now: NOW + 1, bump: false })).not.toThrow();
    expect(
      ctx.memory.search('-foo "bar(', { now: NOW + 1, bump: false }).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('searches proposals but excludes archived memories', () => {
    const m = ctx.memory.add({ type: 'semantic', content: 'zebra crossing' }, { now: NOW }); // proposed
    expect(ctx.memory.search('zebra', { now: NOW + 1, bump: false })).toHaveLength(1);
    ctx.memory.reject([m.id], { now: NOW + 2 }); // → archived
    expect(ctx.memory.search('zebra', { now: NOW + 3, bump: false })).toHaveLength(0);
  });

  it('retrieval bumps boosts on repeat', () => {
    const a = ctx.memory.add(
      { type: 'semantic', content: 'shared keyword alpha' },
      { now: NOW, asProposal: false },
    );
    const b = ctx.memory.add(
      { type: 'semantic', content: 'shared keyword beta' },
      { now: NOW, asProposal: false },
    );
    const hits = ctx.memory.search('shared keyword', { now: NOW + 1 });
    expect(hits).toHaveLength(2);
    expect(ctx.driver.getMemory(a.id)?.boosts).toBe(1);
    expect(ctx.driver.getMemory(b.id)?.boosts).toBe(1);
    expect(ctx.driver.getMemory(a.id)?.lastRetrievedAt).toBe(NOW + 1);
  });

  it('scope filter restricts results to an exact scope (cross-scope disclosure fix)', () => {
    const u = ctx.memory.add(
      { type: 'semantic', content: 'deploy widget preferences', scope: 'user' },
      { now: NOW, asProposal: false },
    );
    const p = ctx.memory.add(
      { type: 'semantic', content: 'deploy widget preferences', scope: 'project:x' },
      { now: NOW, asProposal: false },
    );
    // no scope → both
    const all = ctx.memory.search('widget', { now: NOW + 1, bump: false }).map((h) => h.memory.id);
    expect(all).toContain(u.id);
    expect(all).toContain(p.id);
    // scoped → only that scope (a scope filter that is accepted but ignored is global disclosure)
    const scoped = ctx.memory
      .search('widget', { now: NOW + 2, bump: false, scope: 'project:x' })
      .map((h) => h.memory.id);
    expect(scoped).toEqual([p.id]);
  });

  it('scope filters the FTS path in SQL (spec §4 memory_search scope)', () => {
    const user = ctx.memory.add(
      { type: 'semantic', content: 'shared keyword alpha', scope: 'user' },
      { now: NOW, asProposal: false },
    );
    const proj = ctx.memory.add(
      { type: 'semantic', content: 'shared keyword beta', scope: 'project:atlas' },
      { now: NOW, asProposal: false },
    );

    const scoped = ctx.driver.searchMemories('keyword', { scope: 'project:atlas' });
    expect(scoped.map((r) => r.memory.id)).toEqual([proj.id]);
    const userScoped = ctx.driver.searchMemories('keyword', { scope: 'user' });
    expect(userScoped.map((r) => r.memory.id)).toEqual([user.id]);
    const all = ctx.driver.searchMemories('keyword');
    expect(all.map((r) => r.memory.id).sort()).toEqual([user.id, proj.id].sort());
    // an unknown scope matches nothing rather than falling back to everything
    expect(ctx.driver.searchMemories('keyword', { scope: 'project:nope' })).toHaveLength(0);
  });
});
