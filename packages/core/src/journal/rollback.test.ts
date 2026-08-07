import {
  AppliedChangeSchema,
  ConsolidatePayloadSchema,
  JournalService,
  memoryInsertDigest,
  planRollback,
} from '@sthayi/core';
import { describe, expect, it } from 'vitest';
import { FakeStore } from '../../../../tests/helpers/fake-store.js';

/** Shape-valid stand-in digest for planner/schema tests (real digests are sha256 hex). */
const DIGEST = 'ab'.repeat(32);

describe('planRollback', () => {
  it('inverts recorded changes in reverse order', () => {
    const store = new FakeStore();
    const journal = new JournalService(store);
    const rec = journal.append({
      ts: 100,
      actor: 'cli',
      op: 'consolidate',
      payload: {
        batch: 'b1',
        changes: [
          { kind: 'memory_status', id: 'm1', from: 'proposed', to: 'archived' },
          { kind: 'memory_insert', id: 'm2', digest: DIGEST },
        ],
      },
    }).record;

    const plan = planRollback(rec, 200, 'cli');
    expect(plan.targetId).toBe(rec.id);
    expect(plan.inverse).toEqual([
      // undoing an insert is expressed by carrying the memory_insert change (digest and all)
      // into the inverse list — the executor deletes only a digest-matching untouched proposal
      { kind: 'memory_insert', id: 'm2', digest: DIGEST },
      { kind: 'memory_status', id: 'm1', from: 'archived', to: 'proposed' },
    ]);
    expect(plan.entry.op).toBe('rollback');
    expect(plan.entry.payload).toMatchObject({ rollsBack: rec.id, originalOp: 'consolidate' });
  });

  it('produces a marker entry with empty inverse for ops without recorded changes', () => {
    const store = new FakeStore();
    const journal = new JournalService(store);
    const rec = journal.append({ ts: 1, actor: 'cli', op: 'import', payload: { count: 5 } }).record;
    const plan = planRollback(rec, 2);
    expect(plan.inverse).toEqual([]);
    expect(plan.entry.op).toBe('rollback');
  });

  it('service.planUndo returns undefined for an unknown id', () => {
    const store = new FakeStore();
    const journal = new JournalService(store);
    expect(journal.planUndo(999, 1)).toBeUndefined();
  });

  // Inversion correctness for ALL three change kinds, in reverse order.
  it('inverts every change kind correctly (status swap, content swap, insert→delete-the-insert)', () => {
    const store = new FakeStore();
    const journal = new JournalService(store);
    const rec = journal.append({
      ts: 100,
      actor: 'consolidate',
      op: 'consolidate',
      payload: {
        batch: 'b1',
        mode: 'oracle',
        changes: [
          { kind: 'memory_status', id: 'm1', from: 'confirmed', to: 'archived', mergedInto: 'm9' },
          { kind: 'memory_content', id: 'm2', from: 'old text', to: 'new text' },
          { kind: 'memory_insert', id: 'm3', digest: DIGEST, distilledFrom: ['m1'] },
        ],
      },
    }).record;
    const plan = planRollback(rec, 200, 'cli');
    expect(plan.inverse).toEqual([
      { kind: 'memory_insert', id: 'm3', digest: DIGEST, distilledFrom: ['m1'] },
      { kind: 'memory_content', id: 'm2', from: 'new text', to: 'old text' },
      { kind: 'memory_status', id: 'm1', from: 'archived', to: 'confirmed' },
    ]);
    expect(plan.entry.payload).toMatchObject({ rollsBack: rec.id, originalOp: 'consolidate' });
  });

  // The planner consumes only VALIDATED changes — one malformed item voids the list
  // (a partially-valid batch must never be partially undone).
  it('yields an empty inverse when any recorded change is malformed', () => {
    const store = new FakeStore();
    const journal = new JournalService(store);
    const rec = journal.append({
      ts: 1,
      actor: 'cli',
      op: 'consolidate',
      payload: {
        batch: 'b1',
        mode: 'deterministic',
        changes: [
          { kind: 'memory_status', id: 'm1', from: 'proposed', to: 'archived' },
          { kind: 'evil_kind', id: 'm2' },
        ],
      },
    }).record;
    expect(planRollback(rec, 2).inverse).toEqual([]);
  });
});

describe('rollback payload schemas', () => {
  const validChanges = {
    status: { kind: 'memory_status', id: 'm1', from: 'proposed', to: 'archived' },
    statusMerged: {
      kind: 'memory_status',
      id: 'm1',
      from: 'confirmed',
      to: 'archived',
      mergedInto: 'm2',
    },
    content: { kind: 'memory_content', id: 'm1', from: 'a', to: 'b' },
    insert: { kind: 'memory_insert', id: 'm1', digest: DIGEST },
    insertDistilled: { kind: 'memory_insert', id: 'm1', digest: DIGEST, distilledFrom: ['m2'] },
  };

  it('accepts every well-formed change kind', () => {
    for (const [name, change] of Object.entries(validChanges)) {
      expect(AppliedChangeSchema.safeParse(change).success, `${name} should parse`).toBe(true);
    }
  });

  const rejectedChanges: [string, unknown][] = [
    ['unknown kind', { kind: 'memory_explode', id: 'm1' }],
    // 'memory_delete' was REMOVED from the vocabulary (nothing produces it; its rollback claimed
    // to restore a row it never snapshotted) — a journal edit smuggling it back in is a refusal
    ['removed kind memory_delete', { kind: 'memory_delete', id: 'm1' }],
    ['removed kind memory_delete with extra field', { kind: 'memory_delete', id: 'm1', x: 1 }],
    ['missing id', { kind: 'memory_insert', digest: DIGEST }],
    ['empty id', { kind: 'memory_insert', id: '', digest: DIGEST }],
    ['memory_insert missing digest', { kind: 'memory_insert', id: 'm1' }],
    ['memory_insert non-hex digest', { kind: 'memory_insert', id: 'm1', digest: 'Z'.repeat(64) }],
    ['memory_insert short digest', { kind: 'memory_insert', id: 'm1', digest: 'ab12' }],
    ['bad status value', { kind: 'memory_status', id: 'm1', from: 'proposed', to: 'nuked' }],
    ['missing to', { kind: 'memory_status', id: 'm1', from: 'proposed' }],
    [
      'extra field on a change',
      { kind: 'memory_content', id: 'm1', from: 'a', to: 'b', alsoDelete: 'everything' },
    ],
    ['non-string content', { kind: 'memory_content', id: 'm1', from: 1, to: 2 }],
    [
      'non-array distilledFrom',
      { kind: 'memory_insert', id: 'm1', digest: DIGEST, distilledFrom: 'm2' },
    ],
    ['null', null],
    ['string', 'memory_delete'],
  ];

  it('rejects every malformed change', () => {
    for (const [name, change] of rejectedChanges) {
      expect(AppliedChangeSchema.safeParse(change).success, `${name} should be rejected`).toBe(
        false,
      );
    }
  });

  it('accepts a well-formed consolidate payload (both modes)', () => {
    for (const mode of ['deterministic', 'oracle']) {
      const r = ConsolidatePayloadSchema.safeParse({
        batch: 'b1',
        mode,
        changes: [validChanges.status],
      });
      expect(r.success).toBe(true);
    }
  });

  const rejectedPayloads: [string, unknown][] = [
    ['missing batch', { mode: 'oracle', changes: [validChanges.status] }],
    ['unknown mode', { batch: 'b', mode: 'yolo', changes: [validChanges.status] }],
    ['empty changes', { batch: 'b', mode: 'oracle', changes: [] }],
    ['non-array changes', { batch: 'b', mode: 'oracle', changes: validChanges.status }],
    [
      'extra top-level field',
      { batch: 'b', mode: 'oracle', changes: [validChanges.status], evil: true },
    ],
    [
      'one malformed change among valid ones',
      { batch: 'b', mode: 'oracle', changes: [validChanges.status, { kind: 'nope', id: 'x' }] },
    ],
    ['null payload', null],
    ['array payload', [validChanges.status]],
  ];

  it('rejects every malformed consolidate payload', () => {
    for (const [name, payload] of rejectedPayloads) {
      expect(ConsolidatePayloadSchema.safeParse(payload).success, `${name} rejected`).toBe(false);
    }
  });
});

describe('memoryInsertDigest', () => {
  const base = {
    content: 'the user prefers pnpm',
    type: 'semantic' as const,
    scope: 'user',
    source: 'oracle',
    confidence: 0.6,
    provenance: { source: 'oracle-distill', distilledFrom: ['m1'] },
  };

  it('is a sha256 hex string, stable across field and provenance-key order', () => {
    const a = memoryInsertDigest(base);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    const reordered = {
      provenance: { distilledFrom: ['m1'], source: 'oracle-distill' },
      confidence: 0.6,
      source: 'oracle',
      scope: 'user',
      type: 'semantic' as const,
      content: 'the user prefers pnpm',
    };
    expect(memoryInsertDigest(reordered)).toBe(a);
  });

  it('changes when ANY identity field changes', () => {
    const a = memoryInsertDigest(base);
    expect(memoryInsertDigest({ ...base, content: 'edited' })).not.toBe(a);
    expect(memoryInsertDigest({ ...base, type: 'episodic' })).not.toBe(a);
    expect(memoryInsertDigest({ ...base, scope: 'project:alpha' })).not.toBe(a);
    expect(memoryInsertDigest({ ...base, source: 'cli' })).not.toBe(a);
    expect(memoryInsertDigest({ ...base, confidence: 0.61 })).not.toBe(a);
    expect(memoryInsertDigest({ ...base, provenance: { source: 'oracle-distill' } })).not.toBe(a);
  });

  it('ignores volatile retrieval state — a bump must never break rollback', () => {
    // Full Memory-shaped rows differing ONLY in boosts/lastRetrievedAt/updatedAt/status digest
    // identically: the digest is computed over the identity fields alone.
    const row = (extra: object) => ({ ...base, ...extra });
    expect(memoryInsertDigest(row({ boosts: 0, lastRetrievedAt: null, updatedAt: 1 }))).toBe(
      memoryInsertDigest(row({ boosts: 7, lastRetrievedAt: 999, updatedAt: 999 })),
    );
  });
});
