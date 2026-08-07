import { AssocService, EDGE_HALF_LIFE_DAYS, type Memory } from '@sthayi/core';
import { describe, expect, it } from 'vitest';
import { SqliteDriver } from './sqlite.js';

const DAY = 86_400_000;
const T0 = 1_700_000_000_000;

function mem(id: string, content: string, status: Memory['status'] = 'confirmed'): Memory {
  return {
    id,
    type: 'semantic',
    scope: 'user',
    content,
    provenance: { source: 'test' },
    confidence: 0.6,
    boosts: 0,
    status,
    source: 'test',
    createdAt: T0,
    updatedAt: T0,
    lastRetrievedAt: null,
    decayAt: null,
  };
}

function openDriver(): SqliteDriver {
  const driver = SqliteDriver.openMemory();
  driver.migrate();
  return driver;
}

describe('SqliteDriver assoc methods (migration 002)', () => {
  it('applyAssocDelta upserts with decay-then-add semantics', () => {
    const d = openDriver();
    d.applyAssocDelta({ a: 'a', b: 'b', kind: 'coretrieval', delta: 2, ts: T0 });
    // reinforce one half-life later: stored 2 decays to 1, +2 → 3
    d.applyAssocDelta({
      a: 'a',
      b: 'b',
      kind: 'coretrieval',
      delta: 2,
      ts: T0 + EDGE_HALF_LIFE_DAYS * DAY,
    });
    expect(d.countAssocEdges()).toBe(1);
    d.insertMemory(mem('a', 'x'));
    d.insertMemory(mem('b', 'y'));
    const [edge] = d.neighborsAssoc(['a']);
    expect(edge?.weight).toBeCloseTo(3, 10);
    d.close();
  });

  it('neighborsAssoc returns only edges whose BOTH endpoints are live', () => {
    const d = openDriver();
    d.insertMemory(mem('a', 'x'));
    d.insertMemory(mem('b', 'y'));
    d.insertMemory(mem('c', 'z', 'archived'));
    d.applyAssocDelta({ a: 'a', b: 'b', kind: 'coretrieval', delta: 1, ts: T0 });
    d.applyAssocDelta({ a: 'a', b: 'c', kind: 'coretrieval', delta: 1, ts: T0 });
    d.applyAssocDelta({ a: 'b', b: 'ghost', kind: 'coretrieval', delta: 1, ts: T0 }); // deleted id
    const edges = d.neighborsAssoc(['a', 'b']);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ a: 'a', b: 'b' });
    d.close();
  });

  it('rewireAssoc re-points mass onto the merge survivor and dissolves self-pairs', () => {
    const d = openDriver();
    for (const id of ['keep', 'loser', 'other']) {
      d.insertMemory(mem(id, id));
    }
    // loser—other and loser—keep exist; keep—other already has weight 1
    d.applyAssocDelta({ a: 'loser', b: 'other', kind: 'coretrieval', delta: 2, ts: T0 });
    d.applyAssocDelta({ a: 'keep', b: 'loser', kind: 'coretrieval', delta: 5, ts: T0 });
    d.applyAssocDelta({ a: 'keep', b: 'other', kind: 'coretrieval', delta: 1, ts: T0 });

    d.rewireAssoc('loser', 'keep', T0);

    const all = d.neighborsAssoc(['keep', 'other']);
    expect(all).toHaveLength(1); // loser—keep dissolved; loser—other folded into keep—other
    expect(all[0]).toMatchObject({ a: 'keep', b: 'other' });
    expect(all[0]?.weight).toBeCloseTo(3, 10); // 1 existing + 2 carried
    expect(d.countAssocEdges()).toBe(1);
    d.close();
  });

  it('neighborsAssoc chunks large IN-lists and dedupes cross-chunk edges', () => {
    const d = openDriver();
    const ids: string[] = [];
    for (let i = 0; i < 450; i++) {
      const id = `m${String(i).padStart(3, '0')}`;
      ids.push(id);
      d.insertMemory(mem(id, `content ${i}`));
    }
    // ring edges: m000—m001, m001—m002, … — many edges span chunk boundaries
    for (let i = 0; i < 449; i++) {
      d.applyAssocDelta({
        a: ids[i] as string,
        b: ids[i + 1] as string,
        kind: 'coretrieval',
        delta: 1,
        ts: T0,
      });
    }
    const edges = d.neighborsAssoc(ids);
    expect(edges).toHaveLength(449); // every edge exactly once — no bind-limit crash, no dupes
    d.close();
  });

  it('journalSince honors the fold-chunk limit', () => {
    const d = openDriver();
    for (let i = 0; i < 7; i++) {
      d.appendJournal({
        ts: T0 + i,
        actor: 't',
        op: 'noop',
        payload: null,
        promptVersion: null,
        model: null,
        prevHash: null,
        hash: `h${i}`,
      });
    }
    expect(d.journalSince(0, 3)).toHaveLength(3);
    expect(d.journalSince(0)).toHaveLength(7);
    expect(d.journalSince(5)).toHaveLength(2);
    d.close();
  });

  it('journalSince feeds the fold incrementally and AssocService.rebuild round-trips', () => {
    const d = openDriver();
    d.insertMemory(mem('m1', 'one'));
    d.insertMemory(mem('m2', 'two'));
    d.appendJournal({
      ts: T0,
      actor: 't',
      op: 'memory_retrieve',
      payload: { query: 'q', ids: ['m1', 'm2'] },
      promptVersion: null,
      model: null,
      prevHash: null,
      hash: 'h1',
    });
    const assoc = new AssocService(d);
    assoc.catchUp();
    expect(d.countAssocEdges()).toBe(1);
    expect(d.getMeta('assoc_cursor')).toBe('1');
    // idempotent
    assoc.catchUp();
    expect(d.countAssocEdges()).toBe(1);
    // rebuild reproduces the same table
    const before = d.neighborsAssoc(['m1']);
    expect(assoc.rebuild()).toBe(1);
    expect(d.neighborsAssoc(['m1'])).toEqual(before);
    d.close();
  });
});
