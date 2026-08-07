import { describe, expect, it } from 'vitest';
import { FakeMacCrypto, FakeStore } from '../../../../tests/helpers/fake-store.js';
import { ConsolidationService } from '../consolidate/service.js';
import { JournalService } from '../journal/service.js';
import { MemoryService } from '../memory/service.js';
import { AssocService } from './service.js';

const T0 = 1_700_000_000_000;

function harness() {
  const store = new FakeStore();
  // MAC-capable fake: rollback refuses an unauthenticated journal (state 'checkpoint-disabled')
  const journal = new JournalService(store, { crypto: new FakeMacCrypto() });
  const assoc = new AssocService(store);
  const memory = new MemoryService(store, journal, undefined, assoc);
  return { store, journal, assoc, memory };
}

/** Append a historical co-retrieval event straight to the journal (what real usage produces). */
function retrieveTogether(journal: JournalService, ids: string[], ts: number): void {
  journal.append({ ts, actor: 'test', op: 'memory_retrieve', payload: { query: 'q', ids } });
}

describe('Samskara end-to-end: associative recall through MemoryService', () => {
  it('EVAL — surfaces a memory with ZERO query-keyword overlap via co-retrieval history', () => {
    const { journal, memory } = harness();
    const now = T0;
    const k8s = memory.add(
      { type: 'semantic', content: 'kubernetes cluster helm deploys' },
      { now, asProposal: false },
    );
    const tf = memory.add(
      { type: 'semantic', content: 'terraform modules remote state buckets' },
      { now, asProposal: false },
    );
    const distractor = memory.add(
      { type: 'semantic', content: 'sourdough starter hydration ratio' },
      { now, asProposal: false },
    );

    // history: the two infra memories were retrieved together three times
    retrieveTogether(journal, [k8s.id, tf.id], now + 1000);
    retrieveTogether(journal, [k8s.id, tf.id], now + 2000);
    retrieveTogether(journal, [k8s.id, tf.id], now + 3000);

    // "kubernetes" matches ONLY the k8s memory lexically ("terraform…" shares no token)
    const hits = memory.search('kubernetes', { now: now + 4000, k: 8, bump: false });
    const ids = hits.map((h) => h.memory.id);
    expect(ids[0]).toBe(k8s.id); // lexical hit still ranks first (GAMMA cap)
    expect(ids).toContain(tf.id); // associative recall recovered the bridge
    expect(ids).not.toContain(distractor.id);
    expect(hits.find((h) => h.memory.id === tf.id)?.via).toBe('associative');
    expect(hits.find((h) => h.memory.id === k8s.id)?.via).toBe('lexical');

    // the same query with assoc disabled is lexical-only
    const lexOnly = memory.search('kubernetes', {
      now: now + 4000,
      k: 8,
      bump: false,
      assoc: false,
    });
    expect(lexOnly.map((h) => h.memory.id)).toEqual([k8s.id]);
  });

  it('NEUTRALITY — with no association evidence, results are identical to the lexical ranking', () => {
    const { memory } = harness();
    const now = T0;
    for (const content of [
      'alpha release checklist notes',
      'alpha and beta rollout order',
      'gamma incident postmortem',
    ]) {
      memory.add({ type: 'semantic', content }, { now, asProposal: false });
    }
    const withAssoc = memory.search('alpha', { now: now + 1, k: 8, bump: false });
    const withoutAssoc = memory.search('alpha', { now: now + 1, k: 8, bump: false, assoc: false });
    expect(withAssoc).toEqual(withoutAssoc); // same memories, same SCORES, same order
  });

  it('HEBBIAN LOOP — searching wires results together; the next query benefits', () => {
    const { memory } = harness();
    const now = T0;
    const a = memory.add(
      { type: 'semantic', content: 'release pipeline gates and approvals' },
      { now, asProposal: false },
    );
    const b = memory.add(
      { type: 'semantic', content: 'pipeline rollback automation script' },
      { now, asProposal: false },
    );
    // both match "pipeline": retrieved together (bump on) → edge minted by the search itself
    memory.search('pipeline', { now: now + 1000, k: 8 });
    // a query matching only memory A now surfaces B associatively
    const hits = memory.search('gates', { now: now + 2000, k: 8, bump: false });
    expect(hits.map((h) => h.memory.id)).toContain(b.id);
    expect(hits.find((h) => h.memory.id === b.id)?.via).toBe('associative');
    expect(hits.map((h) => h.memory.id)[0]).toBe(a.id);
  });

  it('DERIVED-STATE PROOF — live accumulation ≡ rebuild-from-zero after merge AND rollback', () => {
    const { store, journal, assoc, memory } = harness();
    const now = T0;
    const keep = memory.add(
      { type: 'semantic', content: 'duplicate fact of record', confidence: 0.9 },
      { now, asProposal: false },
    );
    const dupe = memory.add(
      { type: 'semantic', content: 'duplicate fact of record' },
      { now: now + 1, asProposal: false },
    );
    const other = memory.add(
      { type: 'semantic', content: 'unrelated architectural decision' },
      { now: now + 2, asProposal: false },
    );
    retrieveTogether(journal, [dupe.id, other.id], now + 1000);
    retrieveTogether(journal, [keep.id, other.id], now + 2000);
    assoc.catchUp();

    // consolidation merges the exact dupe (archives it, mergedInto=keep) → fold rewires
    const consolidation = new ConsolidationService(store, journal);
    const report = consolidation.runDeterministic({ now: now + 3000 });
    expect(report.exactDupes).toBe(1);
    assoc.catchUp();

    // no association mass may dangle on the archived loser
    const edgesAfterMerge = store.snapshotEdges();
    expect(edgesAfterMerge.some((e) => e.a === dupe.id || e.b === dupe.id)).toBe(false);
    // ...and the loser's mass moved to the survivor
    expect(edgesAfterMerge.some((e) => e.a === keep.id || e.b === keep.id)).toBe(true);

    // roll the batch back (un-archives the dupe), fold treats it as a no-op
    const batchEntry = store.allJournal().find((r) => r.op === 'consolidate');
    expect(batchEntry).toBeDefined();
    const rb = consolidation.rollback(batchEntry?.id ?? -1, now + 4000);
    expect(rb.ok).toBe(true);
    assoc.catchUp();

    // THE invariant: rebuilding from nothing reproduces the live table exactly
    const live = store.snapshotEdges();
    assoc.rebuild();
    expect(store.snapshotEdges()).toEqual(live);

    // and folding again with nothing new is a no-op
    assoc.catchUp();
    expect(store.snapshotEdges()).toEqual(live);
  });

  it('archived neighbors are invisible: spread never resurrects an archived memory', () => {
    const { journal, assoc, memory, store } = harness();
    const now = T0;
    const a = memory.add(
      { type: 'semantic', content: 'live topic anchor memory' },
      { now, asProposal: false },
    );
    const b = memory.add(
      { type: 'semantic', content: 'ghost knowledge fragment' },
      { now, asProposal: false },
    );
    retrieveTogether(journal, [a.id, b.id], now + 1000);
    assoc.catchUp();
    store.updateMemory(b.id, { status: 'archived' });

    const hits = memory.search('anchor', { now: now + 2000, k: 8, bump: false });
    expect(hits.map((h) => h.memory.id)).not.toContain(b.id);
  });
});
