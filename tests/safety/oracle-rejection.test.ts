import { runOracleBatch, validateOracleOutput } from '@sthayi/core';
import { describe, expect, it } from 'vitest';

/**
 * SAFETY TEST 4 (spec §7): the oracle runner must apply NOTHING for malformed, extra-field,
 * out-of-batch, or prose-wrapped output. The model proposes; the runtime disposes — malformed
 * output is discarded, never repaired (invariant 2).
 */
const batch = new Set(['a', 'b', 'c']);

const REJECT: [string, string][] = [
  ['truncated JSON', '{"merge":[["a","b"'],
  ['prose-wrapped JSON (not extracted)', 'Sure! Here is the result:\n{"merge":[["a","b"]]}'],
  ['prose after a fence', '```json\n{"merge":[]}\n```\nHope that helps!'],
  [
    'extra top-level field',
    '{"merge":[],"archive":[],"promote":[],"contradictions":[],"evil":true}',
  ],
  ['nested extra field', '{"promote":[{"from":"a","to_content":"x","sneaky":1}]}'],
  ['id not in batch (archive)', '{"archive":["not-in-batch"]}'],
  ['id not in batch (merge)', '{"merge":[["a","zzz"]]}'],
  ['wrong type', '{"archive":"a"}'],
  [
    'oversized promote content (>4000 chars — no unbounded mints)',
    JSON.stringify({ promote: [{ from: 'a', to_content: 'x'.repeat(4001) }] }),
  ],
  // contradictions follow the SAME discipline: strict shape, in-batch ids, bounded reason —
  // one malformed pair rejects the whole batch (nothing is journaled, nothing applied)
  [
    'id not in batch (contradictions.a)',
    '{"contradictions":[{"a":"not-in-batch","b":"b","reason":"conflict"}]}',
  ],
  [
    'id not in batch (contradictions.b)',
    '{"contradictions":[{"a":"a","b":"zzz","reason":"conflict"}]}',
  ],
  ['contradiction missing reason', '{"contradictions":[{"a":"a","b":"b"}]}'],
  [
    'contradiction extra field',
    '{"contradictions":[{"a":"a","b":"b","reason":"conflict","apply":true}]}',
  ],
  ['contradiction wrong shape', '{"contradictions":["a b conflict"]}'],
  [
    'oversized contradiction reason (>2000 chars — no unbounded journal mints)',
    JSON.stringify({ contradictions: [{ a: 'a', b: 'b', reason: 'r'.repeat(2001) }] }),
  ],
];

describe('safety: oracle rejection matrix', () => {
  for (const [name, raw] of REJECT) {
    it(`rejects and applies nothing: ${name}`, () => {
      expect(validateOracleOutput(raw, batch).applied).toBe(false);
    });
  }

  it('accepts a valid, strictly-shaped, in-batch response', () => {
    const r = validateOracleOutput('{"merge":[["a","b"]],"archive":["c"]}', batch);
    expect(r.applied).toBe(true);
    if (r.applied) {
      expect(r.ops.merge).toEqual([['a', 'b']]);
      expect(r.ops.archive).toEqual(['c']);
    }
  });

  it('accepts promote content at the 4000-char cap', () => {
    const raw = JSON.stringify({ promote: [{ from: 'a', to_content: 'y'.repeat(4000) }] });
    expect(validateOracleOutput(raw, batch).applied).toBe(true);
  });

  it('accepts valid in-batch contradictions and carries them through as ops (never mutations)', () => {
    const r = validateOracleOutput(
      '{"contradictions":[{"a":"a","b":"b","reason":"these conflict"}]}',
      batch,
    );
    expect(r.applied).toBe(true);
    if (r.applied) {
      expect(r.ops.contradictions).toEqual([{ a: 'a', b: 'b', reason: 'these conflict' }]);
      // and flags nothing that would mutate memory
      expect(r.ops.merge).toEqual([]);
      expect(r.ops.archive).toEqual([]);
      expect(r.ops.promote).toEqual([]);
    }
  });

  it('accepts a contradiction reason at the 2000-char cap', () => {
    const raw = JSON.stringify({ contradictions: [{ a: 'a', b: 'b', reason: 'r'.repeat(2000) }] });
    expect(validateOracleOutput(raw, batch).applied).toBe(true);
  });

  it('accepts JSON wrapped in a full markdown code fence (DEV-8 normalization)', () => {
    expect(validateOracleOutput('```json\n{"merge":[["a","b"]]}\n```', batch).applied).toBe(true);
    expect(validateOracleOutput('```\n{"archive":["c"]}\n```', batch).applied).toBe(true);
  });

  it('rejects a malformed fence with adversarial whitespace in linear time', () => {
    // Keep a non-whitespace sentinel after the tabs so trim() cannot erase the hostile run. The
    // former optional-whitespace fence regex backtracked quadratically when no opening newline or
    // closing fence arrived; the deterministic wrapper scanner must reject it promptly.
    const raw = `\`\`\`json${'\t'.repeat(400_000)}x`;
    const started = performance.now();
    expect(validateOracleOutput(raw, batch)).toMatchObject({
      applied: false,
      reason: 'response is not valid JSON',
    });
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('runOracleBatch rejects a provider that returns prose', async () => {
    const proseProvider = { id: 'mock', complete: async () => 'I think you should merge a and b.' };
    const result = await runOracleBatch(
      [
        { id: 'a', content: 'x' },
        { id: 'b', content: 'x' },
      ],
      proseProvider,
      'system',
    );
    expect(result.applied).toBe(false);
  });

  it('runOracleBatch accepts valid JSON from a provider', async () => {
    const goodProvider = { id: 'mock', complete: async () => '{"merge":[["a","b"]]}' };
    const result = await runOracleBatch(
      [
        { id: 'a', content: 'x' },
        { id: 'b', content: 'x' },
      ],
      goodProvider,
      'system',
    );
    expect(result.applied).toBe(true);
  });
});

/**
 * Resource bounds on oracle output: every op array's length, every id's
 * length, the TOTAL reference count across the whole output, and duplicate references are bounded
 * in zod — one violation rejects the whole batch (discard, never repair). Every limit is tested
 * at limit+1 (reject) and at the limit (accept).
 */
describe('safety: oracle op bounds — limit+1 rejects, at-limit accepts', () => {
  /** n distinct ids, batch-registered so the ONLY possible failure is the bound under test. */
  const ids = (n: number, prefix = 'm'): string[] =>
    Array.from({ length: n }, (_, i) => `${prefix}${i}`);
  // every id any bounds case references is registered, so the ONLY failure is the bound itself
  const bigBatch = new Set([
    ...ids(700, 'm'),
    ...ids(300, 'a'),
    ...ids(300, 'p'),
    ...ids(300, 'c'),
    ...ids(10, 'x'),
  ]);
  const pairs = (n: number, prefix: string) =>
    Array.from({ length: n }, (_, i) => ({
      a: `${prefix}${2 * i}`,
      b: `${prefix}${2 * i + 1}`,
      reason: 'r',
    }));
  const groups = (n: number, prefix: string) =>
    Array.from({ length: n }, (_, i) => [`${prefix}${2 * i}`, `${prefix}${2 * i + 1}`]);

  const BOUNDS_REJECT: [string, string][] = [
    ['51 merge groups (max 50)', JSON.stringify({ merge: groups(51, 'm') })],
    ['merge group of 21 members (max 20)', JSON.stringify({ merge: [ids(21)] })],
    ['merge group of 1 member (min 2 — a solo "merge" is incoherent)', '{"merge":[["m0"]]}'],
    ['201 archive ids (max 200)', JSON.stringify({ archive: ids(201) })],
    [
      '101 promote ops (max 100)',
      JSON.stringify({ promote: ids(101).map((id) => ({ from: id, to_content: 'x' })) }),
    ],
    ['101 contradictions (max 100)', JSON.stringify({ contradictions: pairs(101, 'm') })],
    ['a 65-char id (max 64)', JSON.stringify({ archive: ['x'.repeat(65)] })],
    ['an empty-string id', '{"archive":[""]}'],
    [
      '501 total references across ops (max 500: 199 archive + 100 promote + 100 pairs + 1 merge pair)',
      JSON.stringify({
        archive: ids(199, 'a'),
        promote: ids(100, 'p').map((id) => ({ from: id, to_content: 'x' })),
        contradictions: pairs(100, 'c'),
        merge: [['x0', 'x1']],
      }),
    ],
    ['duplicate id within one op array (archive twice)', '{"archive":["a","a"]}'],
    ['duplicate id across ops (merged AND archived)', '{"merge":[["a","b"]],"archive":["a"]}'],
    [
      'duplicate id across ops (merged AND promoted)',
      JSON.stringify({ merge: [['a', 'b']], promote: [{ from: 'b', to_content: 'x' }] }),
    ],
    [
      'a contradiction pairing an id with itself (a === b)',
      '{"contradictions":[{"a":"a","b":"a","reason":"x"}]}',
    ],
    [
      'the same unordered contradiction pair flagged twice',
      '{"contradictions":[{"a":"a","b":"b","reason":"x"},{"a":"b","b":"a","reason":"y"}]}',
    ],
    ['duplicate id in two merge groups', '{"merge":[["a","b"],["a","c"]]}'],
  ];

  for (const [name, raw] of BOUNDS_REJECT) {
    it(`rejects and applies nothing: ${name}`, () => {
      expect(validateOracleOutput(raw, bigBatch).applied).toBe(false);
      // and the small batch of the main matrix rejects identically (schema runs before batch checks)
      expect(validateOracleOutput(raw, batch).applied).toBe(false);
    });
  }

  const BOUNDS_ACCEPT: [string, string][] = [
    ['exactly 50 merge groups', JSON.stringify({ merge: groups(50, 'm') })],
    ['a merge group of exactly 20 members', JSON.stringify({ merge: [ids(20)] })],
    ['exactly 200 archive ids', JSON.stringify({ archive: ids(200) })],
    [
      'exactly 100 promote ops',
      JSON.stringify({ promote: ids(100).map((id) => ({ from: id, to_content: 'x' })) }),
    ],
    ['exactly 100 contradictions', JSON.stringify({ contradictions: pairs(100, 'm') })],
    [
      'exactly 500 total references (198 archive + 100 promote + 100 pairs + 1 merge pair)',
      JSON.stringify({
        archive: ids(198, 'a'),
        promote: ids(100, 'p').map((id) => ({ from: id, to_content: 'x' })),
        contradictions: pairs(100, 'c'),
        merge: [['x0', 'x1']],
      }),
    ],
  ];

  for (const [name, raw] of BOUNDS_ACCEPT) {
    it(`accepts at the limit: ${name}`, () => {
      expect(validateOracleOutput(raw, bigBatch).applied).toBe(true);
    });
  }

  it('accepts an id of exactly 64 chars (when it is in the batch)', () => {
    const id64 = 'x'.repeat(64);
    const r = validateOracleOutput(JSON.stringify({ archive: [id64] }), new Set([id64]));
    expect(r.applied).toBe(true);
  });

  it('accepts a contradiction referencing a merged id — pairs are observations, not mutations', () => {
    // mirrors the ride-along protocol behavior: merge a+b while flagging a-vs-c
    const raw = '{"merge":[["a","b"]],"contradictions":[{"a":"a","b":"c","reason":"conflict"}]}';
    expect(validateOracleOutput(raw, batch).applied).toBe(true);
  });

  it('accepts the same id in two DIFFERENT contradiction pairs', () => {
    const raw =
      '{"contradictions":[{"a":"a","b":"b","reason":"x"},{"a":"a","b":"c","reason":"y"}]}';
    expect(validateOracleOutput(raw, batch).applied).toBe(true);
  });
});
