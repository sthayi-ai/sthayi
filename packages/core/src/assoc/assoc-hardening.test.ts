import { describe, expect, it } from 'vitest';
import { FakeStore } from '../../../../tests/helpers/fake-store.js';
import type { Memory } from '../domain/memory.js';
import { JournalService } from '../journal/service.js';
import { MemoryService, lexNormalize } from '../memory/service.js';
import type { MemorySearchRow, SearchOptions } from '../store/driver.js';
import type { EdgeDelta } from './fold.js';
import { AssocService, FOLD_CHUNK } from './service.js';
import { spreadActivation } from './spread.js';

const T0 = 1_700_000_000_000;

function harness(store = new FakeStore()) {
  const journal = new JournalService(store);
  const assoc = new AssocService(store);
  const memory = new MemoryService(store, journal, undefined, assoc);
  return { store, journal, assoc, memory };
}

describe('Samskara hardening (adversarial edge conditions)', () => {
  it('CURSOR SKIP — an entry committed by another writer mid-search is still folded', () => {
    // Simulate the two-process race: an external memory_retrieve lands AFTER the search's
    // opening catchUp but BEFORE its bump transaction — injected from inside searchMemories.
    class RacingStore extends FakeStore {
      inject?: () => void;
      override searchMemories(query: string, opts?: SearchOptions): MemorySearchRow[] {
        this.inject?.();
        this.inject = undefined;
        return super.searchMemories(query, opts);
      }
    }
    const store = new RacingStore();
    const { journal, assoc, memory } = harness(store);
    const now = T0;
    const a = memory.add(
      { type: 'semantic', content: 'alpha payload topic' },
      { now, asProposal: false },
    );
    const b = memory.add(
      { type: 'semantic', content: 'alpha adjacent topic' },
      { now, asProposal: false },
    );
    const c = memory.add(
      { type: 'semantic', content: 'external process topic' },
      { now, asProposal: false },
    );
    store.inject = () => {
      // "process B" journals a co-retrieval the searching process has not folded yet
      journal.append({
        ts: now + 500,
        actor: 'other-process',
        op: 'memory_retrieve',
        payload: { query: 'x', ids: [b.id, c.id] },
      });
    };
    memory.search('alpha', { now: now + 1000, k: 8 }); // bump on → folds own entry via catchUp

    const live = store.snapshotEdges();
    expect(live.some((e) => (e.a === b.id && e.b === c.id) || (e.a === c.id && e.b === b.id))).toBe(
      true,
    ); // the external entry was folded, not skipped
    assoc.rebuild();
    expect(store.snapshotEdges()).toEqual(live); // live ≡ rebuild survives the race
    expect(a.id).toBeTruthy();
  });

  it('CHUNKED FOLD — a journal larger than FOLD_CHUNK folds completely and matches rebuild', () => {
    const { store, journal, assoc, memory } = harness();
    const now = T0;
    const ids = Array.from({ length: 40 }, (_, i) =>
      memory.add(
        { type: 'semantic', content: `chunk fixture note ${i}` },
        { now: now + i, asProposal: false },
      ),
    ).map((m) => m.id);
    const total = FOLD_CHUNK + 137;
    for (let i = 0; i < total; i++) {
      journal.append({
        ts: now + 1000 + i,
        actor: 'seed',
        op: 'memory_retrieve',
        payload: { query: 'q', ids: [ids[i % 40] as string, ids[(i * 7 + 1) % 40] as string] },
      });
    }
    assoc.catchUp();
    const live = store.snapshotEdges();
    expect(live.length).toBeGreaterThan(0);
    // cursor reached the tip: nothing left to fold
    journal.append({ ts: now + 99_999, actor: 'seed', op: 'noop_marker', payload: {} });
    assoc.catchUp();
    assoc.rebuild();
    expect(store.snapshotEdges()).toEqual(live);
  });

  it('ASSOC CAP — a heavily-boosted associative hit can never outrank the best lexical hit', () => {
    const { store, journal, memory } = harness();
    const now = T0;
    const lex = memory.add(
      { type: 'semantic', content: 'precise keyword target', confidence: 0.5 },
      { now, asProposal: false },
    );
    const habit = memory.add(
      { type: 'semantic', content: 'unrelated habitual note', confidence: 1.0 },
      { now, asProposal: false },
    );
    // wire them, then inflate the associative candidate's boosts multiplier far beyond GAMMA's cap
    for (let i = 0; i < 5; i++) {
      journal.append({
        ts: now + i,
        actor: 'seed',
        op: 'memory_retrieve',
        payload: { query: 'q', ids: [lex.id, habit.id] },
      });
    }
    store.updateMemory(habit.id, { boosts: 100, lastRetrievedAt: now }); // recencyBoost ≈ 21×
    const hits = memory.search('keyword', { now: now + 1000, k: 8, bump: false });
    expect(hits[0]?.memory.id).toBe(lex.id);
    expect(hits[0]?.via).toBe('lexical');
    const habitHit = hits.find((h) => h.memory.id === habit.id);
    expect(habitHit?.via).toBe('associative');
    expect(habitHit?.score).toBeLessThanOrEqual(hits[0]?.score as number);
  });

  it('TIE GUARD — float-noise bm25 spans normalize as a tie, not across the full range', () => {
    const mem = (id: string): Memory => ({
      id,
      type: 'semantic',
      scope: 'user',
      content: id,
      provenance: { source: 't' },
      confidence: 0.6,
      boosts: 0,
      status: 'confirmed',
      source: 't',
      createdAt: T0,
      updatedAt: T0,
      lastRetrievedAt: null,
      decayAt: null,
    });
    const noisy = lexNormalize([
      { memory: mem('x'), bm25: -1.0 },
      { memory: mem('y'), bm25: -1.0000000001 },
    ]);
    expect(noisy.get('x')).toBe(1);
    expect(noisy.get('y')).toBe(1);
    const real = lexNormalize([
      { memory: mem('x'), bm25: -2 },
      { memory: mem('y'), bm25: -1 },
    ]);
    expect(real.get('x')).toBe(1);
    expect(real.get('y')).toBeCloseTo(0.2, 10);
  });

  it('NO SEED ECHO — hop 2 never reflects a seed’s own activation back onto it', () => {
    const out = spreadActivation(
      new Map([['a', 1]]),
      [{ a: 'a', b: 'b', weight: 5, lastReinforcedAt: T0 }],
      T0,
    );
    expect(out.get('b')).toBeGreaterThan(0);
    expect(out.has('a')).toBe(false); // unguarded, a receives a1(b)·share(b→a) — pure echo
  });

  it('DEGRADE — a failing fold or spread falls back to lexical instead of failing the search', () => {
    class BrokenAssocStore extends FakeStore {
      override applyAssocDelta(): void {
        throw new Error('SQLITE_BUSY_SNAPSHOT (simulated)');
      }
    }
    const store = new BrokenAssocStore();
    const { journal, memory } = harness(store);
    const now = T0;
    const m = memory.add(
      { type: 'semantic', content: 'resilient lexical target' },
      { now, asProposal: false },
    );
    journal.append({
      ts: now + 1,
      actor: 'seed',
      op: 'memory_retrieve',
      payload: { query: 'q', ids: [m.id, 'ghost'] },
    });
    const hits = memory.search('resilient', { now: now + 1000, k: 8 });
    expect(hits.map((h) => h.memory.id)).toContain(m.id);
  });

  it('BUMP FOLD DEGRADE — a fold failure inside the bump transaction never voids the search', () => {
    // The DEGRADE case above fails BEFORE the search (pre-search catchUp throws → lexical-only).
    // Here the fold succeeds pre-search and breaks only when folding the search's OWN
    // memory_retrieve entry inside the bump transaction (e.g. SQLITE_BUSY arriving late). The
    // ranked hits must still be returned and the bump + retrieve entry must still commit.
    class LateBrokenStore extends FakeStore {
      breakFolds = false;
      override applyAssocDelta(d: EdgeDelta): void {
        if (this.breakFolds) {
          throw new Error('SQLITE_BUSY (simulated)');
        }
        super.applyAssocDelta(d);
      }
    }
    const store = new LateBrokenStore();
    const { memory } = harness(store);
    const now = T0;
    const a = memory.add(
      { type: 'semantic', content: 'contended fixture target' },
      { now, asProposal: false },
    );
    const b = memory.add(
      { type: 'semantic', content: 'contended fixture partner' },
      { now, asProposal: false },
    );
    store.breakFolds = true; // memory_write entries fold to nothing, so pre-search catchUp is fine

    const hits = memory.search('contended', { now: now + 1000, k: 8 });
    expect(hits.map((h) => h.memory.id).sort()).toEqual([a.id, b.id].sort());
    expect(store.allJournal().some((r) => r.op === 'memory_retrieve')).toBe(true);
    expect(store.getMemory(a.id)?.boosts).toBe(1);

    // the chunk's rollback left the cursor untouched → the next catchUp folds the stranded entry
    store.breakFolds = false;
    memory.search('contended', { now: now + 2000, k: 8, bump: false });
    const edges = store.snapshotEdges();
    expect(
      edges.some((e) => (e.a === a.id && e.b === b.id) || (e.a === b.id && e.b === a.id)),
    ).toBe(true);
  });

  it('SCOPE GATE — associative bridges never leak another scope into a scoped search', () => {
    const { journal, memory } = harness();
    const now = T0;
    const proj = memory.add(
      { type: 'semantic', content: 'atlas deploy pipeline', scope: 'project:atlas' },
      { now, asProposal: false },
    );
    const leak = memory.add(
      { type: 'semantic', content: 'personal journaling habit', scope: 'user' },
      { now, asProposal: false },
    );
    for (let i = 0; i < 3; i++) {
      journal.append({
        ts: now + i,
        actor: 'seed',
        op: 'memory_retrieve',
        payload: { query: 'q', ids: [proj.id, leak.id] },
      });
    }
    const scoped = memory.search('deploy', {
      now: now + 1000,
      k: 8,
      bump: false,
      scope: 'project:atlas',
    });
    expect(scoped.map((h) => h.memory.id)).toEqual([proj.id]);
    const unscoped = memory.search('deploy', { now: now + 1000, k: 8, bump: false });
    expect(unscoped.map((h) => h.memory.id)).toContain(leak.id); // the bridge itself still works
  });
});
