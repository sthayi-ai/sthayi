import {
  type ImportedMemory,
  JournalService,
  MemoryService,
  effectiveConfidence,
} from '@sthayi/core';
import { describe, expect, it } from 'vitest';
import { FakeStore } from '../../../../tests/helpers/fake-store.js';

const NOW = 1_700_000_000_000;

function setup() {
  const store = new FakeStore();
  const journal = new JournalService(store);
  const memory = new MemoryService(store, journal);
  return { store, journal, memory };
}

describe('MemoryService — proposals flow', () => {
  it('writes default to proposals and journal a memory_write', () => {
    const { store, memory } = setup();
    const m = memory.add(
      { type: 'semantic', content: 'Alex prefers pnpm and vitest' },
      { now: NOW },
    );
    expect(m.status).toBe('proposed');
    expect(memory.listProposals()).toHaveLength(1);
    expect(store.allJournal().map((r) => r.op)).toContain('memory_write');
  });

  it('--confirm writes a confirmed memory (no proposal)', () => {
    const { memory } = setup();
    const m = memory.add({ type: 'semantic', content: 'x' }, { now: NOW, asProposal: false });
    expect(m.status).toBe('confirmed');
    expect(memory.listProposals()).toHaveLength(0);
  });

  it('confirm transitions proposed→confirmed and journals memory_confirm', () => {
    const { store, memory } = setup();
    const m = memory.add({ type: 'semantic', content: 'y' }, { now: NOW });
    expect(memory.confirm([m.id], { now: NOW + 1 })).toEqual([m.id]);
    expect(store.getMemory(m.id)?.status).toBe('confirmed');
    expect(store.allJournal().some((r) => r.op === 'memory_confirm')).toBe(true);
    expect(memory.listProposals()).toHaveLength(0);
  });

  it('reject transitions proposed→archived', () => {
    const { store, memory } = setup();
    const m = memory.add({ type: 'semantic', content: 'z' }, { now: NOW });
    memory.reject([m.id], { now: NOW + 1 });
    expect(store.getMemory(m.id)?.status).toBe('archived');
  });

  it('confirm is a no-op on ids not currently proposed', () => {
    const { memory } = setup();
    const m = memory.add({ type: 'semantic', content: 'q' }, { now: NOW });
    memory.confirm([m.id], { now: NOW + 1 });
    expect(memory.confirm([m.id], { now: NOW + 2 })).toEqual([]);
  });
});

describe('MemoryService — retrieval', () => {
  it('search bumps retrieval (last_retrieved_at + boosts) and journals memory_retrieve', () => {
    const { store, memory } = setup();
    const m = memory.add(
      { type: 'semantic', content: 'widget cli pnpm vitest' },
      { now: NOW, asProposal: false },
    );
    const hits = memory.search('widget', { now: NOW + 1000 });
    expect(hits.map((h) => h.memory.id)).toEqual([m.id]);
    expect(store.getMemory(m.id)?.boosts).toBe(1);
    expect(store.getMemory(m.id)?.lastRetrievedAt).toBe(NOW + 1000);
    expect(store.allJournal().some((r) => r.op === 'memory_retrieve')).toBe(true);
  });

  it('search with bump:false does not mutate or journal', () => {
    const { store, memory } = setup();
    const m = memory.add({ type: 'semantic', content: 'alpha' }, { now: NOW, asProposal: false });
    memory.search('alpha', { now: NOW + 1, bump: false });
    expect(store.getMemory(m.id)?.boosts).toBe(0);
    expect(store.allJournal().some((r) => r.op === 'memory_retrieve')).toBe(false);
  });
});

describe('MemoryService — journal never records raw search queries', () => {
  const CANARY = `sk-${'C'.repeat(24)}`;
  const masker = {
    maskSecrets: (content: string) => ({
      masked: content.split(CANARY).join('APIKEY_01'),
      warnings: content.includes(CANARY) ? ['masked a secret at write → APIKEY_01'] : [],
    }),
  };

  it('masks secrets in the query before journaling memory_retrieve', () => {
    const store = new FakeStore();
    const memory = new MemoryService(store, new JournalService(store), masker);
    memory.add(
      { type: 'semantic', content: 'widget deploy notes' },
      { now: NOW, asProposal: false },
    );
    memory.search(`widget ${CANARY}`, { now: NOW + 1 });
    const entry = store.allJournal().find((r) => r.op === 'memory_retrieve');
    const journaled = (entry?.payload as { query: string }).query;
    expect(journaled).toBe('widget APIKEY_01');
    expect(journaled.includes(CANARY)).toBe(false);
  });

  it('clips oversized queries before they enter the append-only journal', () => {
    const store = new FakeStore();
    const memory = new MemoryService(store, new JournalService(store), masker);
    memory.add({ type: 'semantic', content: 'widget notes' }, { now: NOW, asProposal: false });
    memory.search(`widget ${'x'.repeat(600)}`, { now: NOW + 1 });
    const entry = store.allJournal().find((r) => r.op === 'memory_retrieve');
    const journaled = (entry?.payload as { query: string }).query;
    expect(journaled.length).toBe(257); // 256 chars + the truncation marker
    expect(journaled.endsWith('…')).toBe(true);
  });
});

describe('MemoryService — provenance is masked at rest (no plaintext secret, invariant 5)', () => {
  const CANARY = `sk-${'C'.repeat(24)}`;
  const masker = {
    maskSecrets: (content: string) => ({
      masked: content.split(CANARY).join('APIKEY_01'),
      warnings: content.includes(CANARY) ? ['masked a secret at write → APIKEY_01'] : [],
    }),
  };

  it('masks secrets in string values of provenance (incl. nested) before storage', () => {
    const store = new FakeStore();
    const memory = new MemoryService(store, new JournalService(store), masker);
    const m = memory.add(
      {
        type: 'semantic',
        content: 'harmless note',
        provenance: { source: 'test', note: `leaked ${CANARY}`, nested: { token: CANARY }, n: 7 },
      },
      { now: NOW, asProposal: false },
    );
    const prov = JSON.stringify(store.getMemory(m.id)?.provenance);
    expect(prov.includes(CANARY)).toBe(false);
    expect(prov).toContain('APIKEY_01');
    expect(prov).toContain('"n":7'); // non-string values pass through untouched
  });

  it('masks provenance on the import path too', () => {
    const store = new FakeStore();
    const memory = new MemoryService(store, new JournalService(store), masker);
    memory.importMemories(
      [
        {
          type: 'semantic',
          content: 'x',
          scope: 'user',
          confidence: 0.6,
          provenance: { source: 'test', src: CANARY },
        },
      ],
      { now: NOW, source: 'test' },
    );
    const stored = store.listMemories()[0];
    expect(JSON.stringify(stored?.provenance).includes(CANARY)).toBe(false);
  });
});

describe('MemoryService — import dedupe honors scope/type boundaries', () => {
  const item = (over: Partial<ImportedMemory>): ImportedMemory => ({
    type: 'semantic',
    content: 'ships on fridays',
    scope: 'user',
    confidence: 0.6,
    provenance: { source: 'test' },
    ...over,
  });

  it('imports the same content when the scope differs', () => {
    const { memory } = setup();
    memory.add(
      { type: 'semantic', content: 'ships on fridays', scope: 'user' },
      { now: NOW, asProposal: false },
    );
    const r = memory.importMemories([item({ scope: 'project:alpha' })], {
      now: NOW + 1,
      source: 'test',
    });
    expect(r).toEqual({ imported: 1, skipped: 0 });
  });

  it('imports the same content when the type differs (same scope)', () => {
    const { memory } = setup();
    memory.add({ type: 'semantic', content: 'ships on fridays' }, { now: NOW, asProposal: false });
    const r = memory.importMemories([item({ type: 'procedural' })], {
      now: NOW + 1,
      source: 'test',
    });
    expect(r).toEqual({ imported: 1, skipped: 0 });
  });

  it('skips a duplicate of an archived (rejected) row in the same scope+type — reject stays sticky', () => {
    const { memory } = setup();
    const m = memory.add({ type: 'semantic', content: 'ships on fridays' }, { now: NOW });
    memory.reject([m.id], { now: NOW + 1 });
    const r = memory.importMemories([item({})], { now: NOW + 2, source: 'test' });
    expect(r).toEqual({ imported: 0, skipped: 1 });
  });

  it('skips in-batch duplicates in the same scope+type', () => {
    const { memory } = setup();
    const r = memory.importMemories([item({}), item({ content: 'Ships  ON Fridays' })], {
      now: NOW,
      source: 'test',
    });
    expect(r).toEqual({ imported: 1, skipped: 1 });
  });

  it('imports in-batch rows with identical content but differing scopes', () => {
    const { store, memory } = setup();
    const r = memory.importMemories([item({}), item({ scope: 'project:alpha' })], {
      now: NOW,
      source: 'test',
    });
    expect(r).toEqual({ imported: 2, skipped: 0 });
    expect(
      store
        .listMemories()
        .map((m) => m.scope)
        .sort(),
    ).toEqual(['project:alpha', 'user']);
  });
});

describe('MemoryService — imported source time', () => {
  const SIX_MONTHS_MS = 182 * 86_400_000;
  const item = (over: Partial<ImportedMemory>): ImportedMemory => ({
    type: 'episodic',
    content: 'deployment retro notes from the widget project',
    scope: 'user',
    confidence: 0.6,
    provenance: { source: 'test' },
    ...over,
  });

  it('createdAt is the validated source time; provenance.importedAt is the import run', () => {
    const { store, memory } = setup();
    const sourceCreatedAt = NOW - SIX_MONTHS_MS;
    memory.importMemories([item({ sourceCreatedAt })], { now: NOW, source: 'claude' });
    const stored = store.listMemories()[0];
    expect(stored?.createdAt).toBe(sourceCreatedAt);
    expect(stored?.updatedAt).toBe(NOW);
    expect(stored?.provenance.importedAt).toBe(NOW);
  });

  it('without a source time, createdAt falls back to the import time', () => {
    const { store, memory } = setup();
    memory.importMemories([item({})], { now: NOW, source: 'claude' });
    const stored = store.listMemories()[0];
    expect(stored?.createdAt).toBe(NOW);
    expect(stored?.provenance.importedAt).toBe(NOW);
  });

  it('a memory imported as 6 months old ranks and decays as old next to a fresh one', () => {
    const { memory } = setup();
    memory.importMemories(
      [item({ sourceCreatedAt: NOW - SIX_MONTHS_MS, content: 'widget deployment notes (old)' })],
      { now: NOW, source: 'claude' },
    );
    const fresh = memory.add(
      { type: 'episodic', content: 'widget deployment notes (new)', confidence: 0.6 },
      { now: NOW },
    );
    const hits = memory.search('widget deployment notes', { now: NOW + 1, bump: false });
    expect(hits).toHaveLength(2);
    // identical confidence and near-identical lexical evidence: recencyBoost (which reads
    // createdAt for never-retrieved rows) must put the fresh memory first
    expect(hits[0]?.memory.id).toBe(fresh.id);
    const old = hits.find((h) => h.memory.id !== fresh.id);
    expect(old).toBeDefined();
    if (old) {
      expect(old.score).toBeLessThan(hits[0]?.score ?? 0);
      // decay reads createdAt too: the imported memory is measurably more decayed
      expect(effectiveConfidence(old.memory, NOW)).toBeLessThan(effectiveConfidence(fresh, NOW));
    }
  });
});

describe('MemoryService — scoped search (spec §4 memory_search scope)', () => {
  it('scope filters hits to the requested scope; omitted scope searches everything', () => {
    const { memory } = setup();
    const u = memory.add(
      { type: 'semantic', content: 'deploy target notes', scope: 'user' },
      { now: NOW, asProposal: false },
    );
    const p = memory.add(
      { type: 'semantic', content: 'deploy target runbook', scope: 'project:atlas' },
      { now: NOW, asProposal: false },
    );
    const scoped = memory.search('deploy', { now: NOW + 1, bump: false, scope: 'project:atlas' });
    expect(scoped.map((h) => h.memory.id)).toEqual([p.id]);
    const all = memory.search('deploy', { now: NOW + 1, bump: false });
    expect(all.map((h) => h.memory.id).sort()).toEqual([u.id, p.id].sort());
  });
});
