import {
  AssocService,
  ConsolidationService,
  type InsertDigestFields,
  type JournalDraft,
  type JournalRecord,
  JournalService,
  type Memory,
  MemoryService,
  type ProviderPort,
  VaultService,
  isId,
  memoryInsertDigest,
  sha256,
} from '@sthayi/core';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileCheckpoint } from '../../packages/cli/src/drivers/checkpoint-file.js';
import { NodeCrypto } from '../../packages/cli/src/drivers/crypto.js';
import { SqliteDriver } from '../../packages/cli/src/drivers/sqlite.js';
import { type FakeHome, createFakeHome } from '../helpers/fake-home.js';

/**
 * SAFETY: the journal must never MASK its own machine fields.
 *
 * The journal is append-only and hash-chained, so a string the write-time masker rewrites is
 * corrupted at rest FOREVER — and the runtime's identifiers are exactly what a PII detector is
 * most likely to misfire on: roughly 0.9% of sha256 digests end in ten decimal digits, and a ULID
 * can too. A rewritten `changes[].digest` makes its batch permanently un-rollbackable (the strict
 * rollback schema refuses the mangled value) while journal verification stays GREEN over the
 * corruption, and a rewritten id silently corrupts the journal-derived association graph.
 *
 * Two layers are pinned here:
 *  - POLICY: which (op, path) pairs survive, proven with a masker whose damage function IS the
 *    hazard (it rewrites a terminal ten-digit run), so every branch is observable;
 *  - INTEGRATION: the real vault masker, real oracle consolidate, real journal, real rollback,
 *    real SQLite, canonical temp home — byte identity end to end.
 */

/** A structurally valid ULID (26 Crockford base32 chars) that ends in ten decimal digits. */
const HOSTILE_IDS = [
  '01ARZ3NDEKTSV4RR1234567890',
  '01BX5ZZKBKACTAV91234567890',
  '01ARZ3NDEKTSV4R09876543210',
  '01BX5ZZKBKACTAV90000000001',
] as const;

/** REAL sha256 digests that end in ten decimal digits — found by scanning
 *  `digest-corruption-probe-<n>`, recomputed here rather than hand-written. */
const HOSTILE_DIGESTS = [
  sha256('digest-corruption-probe-60'),
  sha256('digest-corruption-probe-223'),
] as const;

describe('safety: journal masking preserves validated machine fields', () => {
  let home: FakeHome;
  let file: string;

  beforeEach(() => {
    home = createFakeHome();
    file = home.path('sthayi.db');
  });
  afterEach(() => home.cleanup());

  it('the hostile fixtures really are valid machine values ending in ten digits', () => {
    for (const id of HOSTILE_IDS) {
      expect(isId(id), id).toBe(true);
      expect(id, id).toMatch(/\d{10}$/);
    }
    for (const d of HOSTILE_DIGESTS) {
      expect(d).toMatch(/^[0-9a-f]{64}$/);
      expect(d).toMatch(/\d{10}$/);
    }
  });

  // ---------------------------------------------------------------------------------------------
  // POLICY: dispatch, proven with the hazard's own damage function
  // ---------------------------------------------------------------------------------------------

  /**
   * A masker that inflicts exactly the damage a phone detector inflicts on machine fields: it
   * rewrites a terminal ten-digit run (~0.9% of sha256 digests end in one, and a ULID can too).
   * It is a NO-OP on every payload key name and on every runtime literal
   * (`consolidate`, `memory_status`, `proposed`, …), so anything that comes back rewritten was
   * masked and anything that comes back verbatim was preserved — the dispatch itself is visible,
   * which the real detector pack (correctly a no-op on ids and digests) cannot show.
   */
  const TEN_DIGIT_RUN = /\d{10}\b/g;
  const brand = {
    maskSecrets: (s: string) => ({ masked: s.replace(TEN_DIGIT_RUN, 'PHONE_01'), warnings: [] }),
  };
  /** What `brand` would do to a value — i.e. what "this field got masked" looks like. */
  const damaged = (s: string): string => s.replace(TEN_DIGIT_RUN, 'PHONE_01');

  interface Probe {
    driver: SqliteDriver;
    journal: JournalService;
    /** append `draft`, then read the row back OUT OF SQLITE (never the in-memory draft) */
    stored(draft: JournalDraft): JournalRecord;
    close(): void;
  }

  function openProbe(masker: { maskSecrets(s: string): { masked: string; warnings: string[] } }) {
    const driver = SqliteDriver.open(file);
    driver.migrate();
    const crypto = NodeCrypto.open(home.path('key'));
    const journal = new JournalService(driver, {
      crypto,
      external: new FileCheckpoint(home.path('journal.checkpoint')),
      masker,
    });
    const probe: Probe = {
      driver,
      journal,
      stored(draft: JournalDraft): JournalRecord {
        const rec = journal.append(draft).record;
        const row = driver.allJournal().find((r) => r.id === rec.id);
        expect(row).toBeDefined();
        return row as JournalRecord;
      },
      close: () => driver.close(),
    };
    return probe;
  }

  it("preserves a 'consolidate' batch id, changes[].id/.digest/.mergedInto/.distilledFrom", () => {
    const p = openProbe(brand);
    try {
      const payload = {
        batch: HOSTILE_IDS[0],
        mode: 'deterministic',
        changes: [
          {
            kind: 'memory_status',
            id: HOSTILE_IDS[1],
            from: 'confirmed',
            to: 'archived',
            mergedInto: HOSTILE_IDS[2],
          },
          {
            kind: 'memory_insert',
            id: HOSTILE_IDS[3],
            digest: HOSTILE_DIGESTS[0],
            distilledFrom: [HOSTILE_IDS[1], HOSTILE_IDS[2]],
          },
          // free text at a NON-declared path inside the same declared object: still masked
          {
            kind: 'memory_content',
            id: HOSTILE_IDS[1],
            from: 'old number 5551234567',
            to: 'new number 5559876543',
          },
        ],
      };
      const row = p.stored({ ts: 1, actor: 'consolidate', op: 'consolidate', payload });
      expect(row.payload).toEqual({
        batch: HOSTILE_IDS[0],
        mode: 'deterministic',
        changes: [
          {
            kind: 'memory_status',
            id: HOSTILE_IDS[1],
            from: 'confirmed',
            to: 'archived',
            mergedInto: HOSTILE_IDS[2],
          },
          {
            kind: 'memory_insert',
            id: HOSTILE_IDS[3],
            digest: HOSTILE_DIGESTS[0],
            distilledFrom: [HOSTILE_IDS[1], HOSTILE_IDS[2]],
          },
          {
            kind: 'memory_content',
            id: HOSTILE_IDS[1],
            from: 'old number PHONE_01',
            to: 'new number PHONE_01',
          },
        ],
      });
      expect(p.journal.verify()).toMatchObject({ ok: true, state: 'ok' });
    } finally {
      p.close();
    }
  });

  it('preserves memory_write / memory_retrieve ids while masking the retrieve query', () => {
    const p = openProbe(brand);
    try {
      const write = p.stored({
        ts: 1,
        actor: 'cli',
        op: 'memory_write',
        payload: { ids: [HOSTILE_IDS[0], HOSTILE_IDS[1]], status: 'proposed' },
      });
      expect(write.payload).toEqual({
        ids: [HOSTILE_IDS[0], HOSTILE_IDS[1]],
        status: 'proposed',
      });
      const retrieve = p.stored({
        ts: 2,
        actor: 'cli',
        op: 'memory_retrieve',
        payload: { query: 'who is 5551234567', ids: [HOSTILE_IDS[2], HOSTILE_IDS[3]] },
      });
      expect(retrieve.payload).toEqual({
        query: 'who is PHONE_01',
        ids: [HOSTILE_IDS[2], HOSTILE_IDS[3]],
      });
    } finally {
      p.close();
    }
  });

  /**
   * `memory_confirm` and `memory_reject` are emitted by MemoryService.transition()
   * (confirm() → 'memory_confirm', reject() → 'memory_reject') with a payload of `{ ids }` — the
   * SAME machine-id family as memory_write/memory_retrieve — so they MUST carry a declaration.
   * Omit either and every review decision falls into the undeclared fail-closed branch and has
   * its ids masked wholesale at rest, permanently, whenever one of them trips the detector.
   *
   * The assertions here are DETECTOR-INDEPENDENT: they do not lean on any real detector being
   * lenient about ULIDs. The masker in play rewrites a terminal ten-digit run and the fixtures
   * END IN ONE, so preservation is proven by BYTE IDENTITY of the id itself (`toBe`), and a
   * non-validating sibling in the very same `ids` array is proven to have been rewritten.
   */
  for (const op of ['memory_confirm', 'memory_reject'] as const) {
    it(`preserves ${op} ids byte-for-byte while masking non-machine values in the same field`, () => {
      const p = openProbe(brand);
      try {
        const row = p.stored({
          ts: 1,
          actor: 'cli',
          op,
          payload: { ids: [HOSTILE_IDS[0], 'call 5551234567', `${HOSTILE_IDS[1]}5551234567`] },
        });
        const ids = (row.payload as { ids: string[] }).ids;
        // byte identity, asserted directly — not "the detector happened not to match"
        expect(ids[0]).toBe(HOSTILE_IDS[0]);
        expect(ids[0]).toHaveLength(26);
        // …and the masker really would have damaged it had the op stayed undeclared
        expect(damaged(HOSTILE_IDS[0])).not.toBe(HOSTILE_IDS[0]);
        // preservation is still (declared path AND validating value), never the path alone
        expect(ids[1]).toBe('call PHONE_01');
        // a ULID with ten characters too many is NOT a ULID — declared path, invalid value
        expect(ids[2]).toBe(damaged(`${HOSTILE_IDS[1]}5551234567`));
        expect(ids[2]).not.toBe(`${HOSTILE_IDS[1]}5551234567`);
        expect(p.journal.verify()).toMatchObject({ ok: true, state: 'ok' });
      } finally {
        p.close();
      }
    });
  }

  it('preserves contradiction pair ids while masking the model-authored reason', () => {
    const p = openProbe(brand);
    try {
      const row = p.stored({
        ts: 1,
        actor: 'oracle:stub',
        op: 'consolidate_contradictions',
        payload: {
          pairs: [{ a: HOSTILE_IDS[0], b: HOSTILE_IDS[1], reason: 'both claim 5551234567' }],
        },
      });
      expect(row.payload).toEqual({
        pairs: [{ a: HOSTILE_IDS[0], b: HOSTILE_IDS[1], reason: 'both claim PHONE_01' }],
      });
    } finally {
      p.close();
    }
  });

  it("preserves rollback inverse ids/digests while masking the recorded 'originalOp' string", () => {
    const p = openProbe(brand);
    try {
      const row = p.stored({
        ts: 1,
        actor: 'cli',
        op: 'rollback',
        payload: {
          rollsBack: 7,
          // read back out of a database anyone on the machine can edit — free text, masked
          originalOp: 'consolidate 5551234567',
          inverse: [
            { kind: 'memory_insert', id: HOSTILE_IDS[0], digest: HOSTILE_DIGESTS[1] },
            { kind: 'memory_status', id: HOSTILE_IDS[1], from: 'archived', to: 'confirmed' },
          ],
        },
      });
      expect(row.payload).toEqual({
        rollsBack: 7,
        originalOp: 'consolidate PHONE_01',
        inverse: [
          { kind: 'memory_insert', id: HOSTILE_IDS[0], digest: HOSTILE_DIGESTS[1] },
          { kind: 'memory_status', id: HOSTILE_IDS[1], from: 'archived', to: 'confirmed' },
        ],
      });
    } finally {
      p.close();
    }
  });

  it('masks the free text of ops that declare no machine fields, and passes numbers through', () => {
    const p = openProbe(brand);
    try {
      expect(
        p.stored({
          ts: 1,
          actor: 'import',
          op: 'import',
          payload: { source: '/tmp/export-5551234567.json', imported: 3, skipped: 1 },
        }).payload,
      ).toEqual({ source: '/tmp/export-PHONE_01.json', imported: 3, skipped: 1 });
      expect(
        p.stored({
          ts: 2,
          actor: 'oracle:stub',
          op: 'consolidate_rejected',
          payload: { reason: 'model echoed 5551234567' },
        }).payload,
      ).toEqual({ reason: 'model echoed PHONE_01' });
      expect(
        p.stored({
          ts: 3,
          actor: 'migrate',
          op: 'migrate_masking',
          payload: { remasked: 2, scope: 'memory-rows' },
        }).payload,
      ).toEqual({ remasked: 2, scope: 'memory-rows' });
      expect(
        p.stored({ ts: 4, actor: 'cli', op: 'journal_seal', payload: { entries: 4 } }).payload,
      ).toEqual({ entries: 4 });
    } finally {
      p.close();
    }
  });

  it('masks actor, model and promptVersion — all three are caller-influenced free text', () => {
    const p = openProbe(brand);
    try {
      const row = p.stored({
        ts: 1,
        actor: 'mcp:client-5551234567',
        op: 'consolidate_rejected',
        payload: { reason: 'no' },
        model: 'provider-5551234567',
        promptVersion: 'v1-5551234567',
      });
      expect(row.actor).toBe('mcp:client-PHONE_01');
      expect(row.model).toBe('provider-PHONE_01');
      expect(row.promptVersion).toBe('v1-PHONE_01');
    } finally {
      p.close();
    }
  });

  /**
   * The preservation rule is NOT "a key called `id`/`digest` is exempt". Exempting names would be
   * an at-rest masking BYPASS: an attacker-influenced free-text value stored under a key called
   * `id` would never be masked. Preservation needs the (op, path) pair DECLARED *and* the value
   * to validate as that machine grammar.
   */
  it('is not a name-based bypass: undeclared paths named id/digest are still masked', () => {
    const p = openProbe(brand);
    try {
      const row = p.stored({
        ts: 1,
        actor: 'consolidate',
        op: 'consolidate',
        payload: {
          batch: HOSTILE_IDS[0],
          mode: 'oracle',
          changes: [],
          // `consolidate` declares no TOP-LEVEL id/digest — these are free text
          id: 'reach me on 5551234567',
          digest: 'or on 5559876543',
          nested: { id: 'and on 5550001111', digest: 'and 5552223333' },
        },
      });
      expect(row.payload).toEqual({
        batch: HOSTILE_IDS[0],
        mode: 'oracle',
        changes: [],
        id: 'reach me on PHONE_01',
        digest: 'or on PHONE_01',
        nested: { id: 'and on PHONE_01', digest: 'and PHONE_01' },
      });
    } finally {
      p.close();
    }
  });

  it('is not a name-based bypass: a DECLARED path holding a non-machine value is masked', () => {
    const p = openProbe(brand);
    try {
      const row = p.stored({
        ts: 1,
        actor: 'consolidate',
        op: 'consolidate',
        payload: {
          batch: 'batch 5551234567', // declared 'id' shape, but not a ULID
          mode: 'oracle',
          changes: [
            {
              kind: 'memory_insert',
              id: 'call 5551234567', // declared 'id' shape, but not a ULID
              digest: 'digest 5559876543', // declared 'digest' shape, but not 64 lowercase hex
              distilledFrom: [HOSTILE_IDS[0], 'not-an-id 5550001111'],
            },
            {
              kind: 'memory_status',
              // a ULID with one character too many is NOT a ULID
              id: `${HOSTILE_IDS[1]}5551234567`,
              // a digest with one hex nibble missing is NOT a digest
              digest: HOSTILE_DIGESTS[0].slice(1),
              from: 'confirmed',
              to: 'archived',
            },
          ],
        },
      });
      expect(row.payload).toEqual({
        batch: 'batch PHONE_01',
        mode: 'oracle',
        changes: [
          {
            kind: 'memory_insert',
            id: 'call PHONE_01',
            digest: 'digest PHONE_01',
            // per-element validation: the real ULID survives, its neighbour does not
            distilledFrom: [HOSTILE_IDS[0], 'not-an-id PHONE_01'],
          },
          {
            kind: 'memory_status',
            id: damaged(`${HOSTILE_IDS[1]}5551234567`),
            digest: damaged(HOSTILE_DIGESTS[0].slice(1)),
            from: 'confirmed',
            to: 'archived',
          },
        ],
      });
      // the over-long id and the 63-nibble digest really were rewritten
      expect(row.payload).not.toEqual(expect.objectContaining({ batch: HOSTILE_IDS[1] }));
      expect(JSON.stringify(row.payload)).not.toContain(HOSTILE_DIGESTS[0].slice(1));
    } finally {
      p.close();
    }
  });

  it('is not a name-based bypass: a declared machine field holding an OBJECT is masked deeply', () => {
    const p = openProbe(brand);
    try {
      const row = p.stored({
        ts: 1,
        actor: 'consolidate',
        op: 'consolidate',
        payload: {
          batch: { smuggled: 'call 5551234567' },
          mode: 'oracle',
          changes: [{ kind: 'memory_insert', id: [HOSTILE_IDS[0], { x: '5551234567' }] }],
        },
      });
      expect(row.payload).toEqual({
        batch: { smuggled: 'call PHONE_01' },
        mode: 'oracle',
        changes: [{ kind: 'memory_insert', id: [HOSTILE_IDS[0], { x: 'PHONE_01' }] }],
      });
    } finally {
      p.close();
    }
  });

  it('falls back to FULL masking for an op with no declared shape (fail-closed)', () => {
    const p = openProbe(brand);
    try {
      const payload = {
        batch: HOSTILE_IDS[0],
        mode: 'oracle',
        changes: [
          { kind: 'memory_insert', id: HOSTILE_IDS[1], digest: HOSTILE_DIGESTS[0] },
          { kind: 'memory_status', id: HOSTILE_IDS[2], mergedInto: HOSTILE_IDS[3] },
        ],
        ids: [HOSTILE_IDS[0]],
      };
      // a plausible FUTURE op nobody has declared yet: nothing in it is trusted
      const row = p.stored({ ts: 1, actor: 'cli', op: 'consolidate_v2', payload });
      expect(row.payload).toEqual({
        batch: damaged(HOSTILE_IDS[0]),
        mode: 'oracle',
        changes: [
          {
            kind: 'memory_insert',
            id: damaged(HOSTILE_IDS[1]),
            digest: damaged(HOSTILE_DIGESTS[0]),
          },
          {
            kind: 'memory_status',
            id: damaged(HOSTILE_IDS[2]),
            mergedInto: damaged(HOSTILE_IDS[3]),
          },
        ],
        ids: [damaged(HOSTILE_IDS[0])],
      });
      // and the damage really is damage — none of the originals survived
      for (const id of HOSTILE_IDS) {
        expect(JSON.stringify(row.payload)).not.toContain(id);
      }
    } finally {
      p.close();
    }
  });

  /**
   * COVERAGE PIN for the claim `OP_PAYLOAD_SHAPES` makes about itself ("every op the runtime
   * emits"). Every op below is one an actual `journal.append` call site emits; each is driven with
   * a hostile ULID at the path that op declares, and a survivor proves the op is declared while a
   * rewritten value proves it fell into the undeclared fail-closed branch. The ops with no machine
   * fields at all (`import`, `journal_seal`, `consolidate_rejected`, `migrate_masking`) carry no
   * identifiers to lose and are covered by the free-text row above.
   */
  const ID_BEARING_RUNTIME_OPS: [op: string, payload: unknown, probe: (p: unknown) => unknown][] = [
    ['consolidate', { batch: HOSTILE_IDS[0] }, (p) => (p as { batch: string }).batch],
    [
      'consolidate_contradictions',
      { pairs: [{ a: HOSTILE_IDS[0], b: HOSTILE_IDS[1] }] },
      (p) => (p as { pairs: { a: string }[] }).pairs[0]?.a,
    ],
    ['memory_confirm', { ids: [HOSTILE_IDS[0]] }, (p) => (p as { ids: string[] }).ids[0]],
    ['memory_reject', { ids: [HOSTILE_IDS[0]] }, (p) => (p as { ids: string[] }).ids[0]],
    ['memory_retrieve', { ids: [HOSTILE_IDS[0]] }, (p) => (p as { ids: string[] }).ids[0]],
    ['memory_write', { ids: [HOSTILE_IDS[0]] }, (p) => (p as { ids: string[] }).ids[0]],
    [
      'rollback',
      { inverse: [{ kind: 'memory_status', id: HOSTILE_IDS[0] }] },
      (p) => (p as { inverse: { id: string }[] }).inverse[0]?.id,
    ],
  ];

  it('every id-bearing op the runtime emits is DECLARED (none falls into the fail-closed branch)', () => {
    const p = openProbe(brand);
    try {
      let ts = 0;
      for (const [op, payload, probe] of ID_BEARING_RUNTIME_OPS) {
        ts++;
        const row = p.stored({ ts, actor: 'cli', op, payload });
        expect(probe(row.payload), `${op} lost its declared machine id`).toBe(HOSTILE_IDS[0]);
      }
      expect(p.journal.verify()).toMatchObject({ ok: true, state: 'ok' });
    } finally {
      p.close();
    }
  });

  it('an op or a payload key named after an Object.prototype member does not inherit a shape', () => {
    const p = openProbe(brand);
    try {
      // op 'constructor' must resolve to "undeclared", not to Object.prototype.constructor
      const opRow = p.stored({
        ts: 1,
        actor: 'cli',
        op: 'constructor',
        payload: { ids: [HOSTILE_IDS[0]] },
      });
      expect(opRow.payload).toEqual({ ids: [damaged(HOSTILE_IDS[0])] });
      // key 'constructor'/'toString' under a DECLARED op likewise resolves to undeclared
      const keyRow = p.stored({
        ts: 2,
        actor: 'cli',
        op: 'memory_retrieve',
        payload: { ids: [HOSTILE_IDS[1]], constructor: HOSTILE_IDS[2], toString: HOSTILE_IDS[3] },
      });
      expect(keyRow.payload).toEqual({
        ids: [HOSTILE_IDS[1]],
        constructor: damaged(HOSTILE_IDS[2]),
        toString: damaged(HOSTILE_IDS[3]),
      });
    } finally {
      p.close();
    }
  });

  // ---------------------------------------------------------------------------------------------
  // INTEGRATION: real vault, real oracle consolidate, real journal, real rollback, real SQLite
  // ---------------------------------------------------------------------------------------------

  interface Stack {
    driver: SqliteDriver;
    vault: VaultService;
    journal: JournalService;
    memory: MemoryService;
    consolidate: ConsolidationService;
    close(): void;
  }

  /** Production-shaped stack: real sqlite, real AES crypto, real checkpoints, real vault masker. */
  function openStack(): Stack {
    const driver = SqliteDriver.open(file);
    driver.migrate();
    const crypto = NodeCrypto.open(home.path('key'));
    const vault = new VaultService(driver, crypto, { now: () => 1 });
    const journal = new JournalService(driver, {
      crypto,
      external: new FileCheckpoint(home.path('journal.checkpoint')),
      masker: vault,
    });
    return {
      driver,
      vault,
      journal,
      memory: new MemoryService(driver, journal, vault),
      consolidate: new ConsolidationService(driver, journal, vault),
      close: () => driver.close(),
    };
  }

  /**
   * Search for distilled content whose `memoryInsertDigest` ends in ten decimal digits, so the
   * probe is DETERMINISTIC in the only sense that matters: the digest this batch records is
   * guaranteed to be one the unbounded phone pattern rewrote. Roughly 1 in 110 digests qualify,
   * and the content is letters-only so the vault masker is a provable no-op on it.
   */
  function contentWhoseDigestEndsInTenDigits(fixed: Omit<InsertDigestFields, 'content'>): {
    content: string;
    digest: string;
  } {
    for (let n = 0; n < 20_000; n++) {
      const content = `distilled fact variant ${'x'.repeat(n)}`;
      const digest = memoryInsertDigest({ ...fixed, content });
      if (/\d{10}$/.test(digest)) {
        return { content, digest };
      }
    }
    throw new Error('no candidate digest ended in ten digits');
  }

  it('an oracle consolidate digest ending in ten digits survives byte-identically and rolls back', async () => {
    const s = openStack();
    let batchEntryId = -1;
    let insertedId = '';
    let expectedDigest = '';
    let source: Memory;
    try {
      source = s.memory.add(
        { type: 'episodic', content: 'notes from the widget latency review call' },
        { now: 100, asProposal: false },
      );
      // exactly what ConsolidationService.applyOracleOps will materialize for a promote of `source`
      const { content, digest } = contentWhoseDigestEndsInTenDigits({
        type: 'semantic',
        scope: source.scope,
        source: 'oracle',
        confidence: Math.max(source.confidence, 0.6),
        provenance: {
          source: 'oracle-distill',
          distilledFrom: [source.id],
          conversationId: source.id,
        },
      });
      expectedDigest = digest;
      expect(expectedDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(expectedDigest, 'the probe must end in ten digits or it proves nothing').toMatch(
        /\d{10}$/,
      );

      const provider: ProviderPort = {
        id: 'stub',
        complete: () =>
          Promise.resolve(JSON.stringify({ promote: [{ from: source.id, to_content: content }] })),
      };
      const report = await s.consolidate.runOracle({
        now: 300,
        provider,
        systemPrompt: 'consolidate',
        promptVersion: 'v1',
        mask: (c) => c,
      });
      expect(report).toMatchObject({ appliedBatches: 1, changed: 1, rejectedBatches: 0 });

      const entry = s.driver.allJournal().find((r) => r.op === 'consolidate');
      expect(entry).toBeDefined();
      batchEntryId = entry?.id ?? -1;
      const payload = entry?.payload as {
        batch: string;
        mode: string;
        changes: { kind: string; id: string; digest: string; distilledFrom: string[] }[];
      };
      const change = payload.changes[0] as (typeof payload.changes)[number];
      insertedId = change.id;

      // (a) the stored digest and ids are BYTE-IDENTICAL to what was computed
      expect(change.digest).toBe(expectedDigest);
      expect(change.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(memoryInsertDigest(s.driver.getMemory(insertedId) as Memory)).toBe(change.digest);
      expect(isId(change.id)).toBe(true);
      expect(isId(payload.batch)).toBe(true);
      expect(change.distilledFrom).toEqual([source.id]);

      // (b) NO vault mapping/entity was minted for any of them
      expect(s.driver.listEntities()).toHaveLength(0);
      expect(s.vault.listMappings()).toHaveLength(0);
      expect(JSON.stringify(payload)).not.toMatch(/PHONE_\d\d|CARD_\d\d|SSN_\d\d/);

      // (c) journal verification is GREEN
      expect(s.journal.verify()).toMatchObject({ ok: true, state: 'ok' });
    } finally {
      s.close();
    }

    // (d) rollback SUCCEEDS on a fresh stack and REMOVES the untouched proposal
    const s2 = openStack();
    try {
      expect(s2.driver.getMemory(insertedId)?.status).toBe('proposed');
      const r = s2.consolidate.rollback(batchEntryId, 400);
      expect(r).toMatchObject({ ok: true, reverted: 1 });
      expect(r.reason).toBeUndefined();
      expect(s2.driver.getMemory(insertedId)).toBeUndefined();
      expect(s2.driver.getMemory(source.id)?.status).toBe('confirmed');
      expect(s2.journal.verify()).toMatchObject({ ok: true, state: 'ok' });
    } finally {
      s2.close();
    }
  });

  it('real-vault masking of a hostile digest/ULID payload mints no entity and stays verbatim', () => {
    const s = openStack();
    try {
      const payload = {
        batch: HOSTILE_IDS[0],
        mode: 'deterministic',
        changes: [
          {
            kind: 'memory_status',
            id: HOSTILE_IDS[1],
            from: 'confirmed',
            to: 'archived',
            mergedInto: HOSTILE_IDS[2],
          },
          {
            kind: 'memory_insert',
            id: HOSTILE_IDS[3],
            digest: HOSTILE_DIGESTS[0],
            distilledFrom: [HOSTILE_IDS[1]],
          },
        ],
      };
      const rec = s.journal.append({
        ts: 1,
        actor: 'consolidate',
        op: 'consolidate',
        payload,
      }).record;
      const row = s.driver.allJournal().find((r) => r.id === rec.id);
      expect(row?.payload).toEqual(payload);
      expect(s.driver.listEntities()).toHaveLength(0);

      // …while genuine PII in the SAME payload family is still masked to a real pseudonym
      const retrieve = s.journal.append({
        ts: 2,
        actor: 'cli',
        op: 'memory_retrieve',
        payload: { query: 'who is 555-123-4567 / alex@example.com', ids: [HOSTILE_IDS[0]] },
      }).record;
      const retrieveRow = s.driver.allJournal().find((r) => r.id === retrieve.id);
      const stored = retrieveRow?.payload as { query: string; ids: string[] };
      expect(stored.query).toMatch(/PHONE_\d\d/);
      expect(stored.query).toMatch(/EMAIL_\d\d/);
      expect(stored.query).not.toContain('555-123-4567');
      expect(stored.ids).toEqual([HOSTILE_IDS[0]]);
      expect(
        s.driver
          .listEntities()
          .map((e) => e.kind)
          .sort(),
      ).toEqual(['EMAIL', 'PHONE']);
      expect(s.journal.verify()).toMatchObject({ ok: true, state: 'ok' });
    } finally {
      s.close();
    }
  });

  /**
   * The declaration and the EMITTER must not drift: this drives the real MemoryService review
   * path, so the op strings under test are the ones `confirm()`/`reject()` actually append rather
   * than strings a test author retyped. The ids they journal are what the association graph and
   * `sthayi journal` read back, so they must land byte-identical with the real vault masker wired.
   */
  it('MemoryService.confirm/reject journal memory_confirm/memory_reject with verbatim ids', () => {
    const s = openStack();
    try {
      const keep = s.memory.add({ type: 'semantic', content: 'a fact to keep' }, { now: 100 });
      const drop = s.memory.add({ type: 'semantic', content: 'a fact to drop' }, { now: 101 });
      expect(s.memory.confirm([keep.id], { now: 102 })).toEqual([keep.id]);
      expect(s.memory.reject([drop.id], { now: 103 })).toEqual([drop.id]);

      const rows = s.driver.allJournal();
      const confirmed = rows.find((r) => r.op === 'memory_confirm');
      const rejected = rows.find((r) => r.op === 'memory_reject');
      expect(confirmed, 'confirm() must journal a memory_confirm entry').toBeDefined();
      expect(rejected, 'reject() must journal a memory_reject entry').toBeDefined();
      expect((confirmed?.payload as { ids: string[] }).ids).toEqual([keep.id]);
      expect((rejected?.payload as { ids: string[] }).ids).toEqual([drop.id]);
      expect(isId(keep.id) && isId(drop.id)).toBe(true);
      // no pseudonym was minted for either id — they are machine values, not PII
      expect(s.vault.listMappings()).toHaveLength(0);
      expect(s.journal.verify()).toMatchObject({ ok: true, state: 'ok' });
    } finally {
      s.close();
    }
  });

  it('association folding derives edges for the REAL ids the journal recorded', () => {
    const s = openStack();
    const ids = [HOSTILE_IDS[0], HOSTILE_IDS[1], HOSTILE_IDS[2]];
    try {
      s.journal.append({
        ts: 1,
        actor: 'cli',
        op: 'memory_retrieve',
        payload: { query: 'ring 555-123-4567', ids },
      });
      s.journal.append({
        ts: 2,
        actor: 'consolidate',
        op: 'consolidate',
        payload: {
          batch: HOSTILE_IDS[3],
          mode: 'deterministic',
          changes: [
            {
              kind: 'memory_status',
              id: HOSTILE_IDS[0],
              from: 'confirmed',
              to: 'archived',
              mergedInto: HOSTILE_IDS[1],
            },
          ],
        },
      });
      new AssocService(s.driver).catchUp();
      // 3 co-retrieved ids → 3 pairs, then the rewire folds a-b onto b (a self-pair is dropped)
      expect(s.driver.countAssocEdges()).toBeGreaterThan(0);
    } finally {
      s.close();
    }
    // read the derived edge table with a throwaway raw connection — no service code involved
    const raw = new Database(file);
    const edges = raw.prepare('SELECT a, b FROM assoc_edges ORDER BY a, b').all() as {
      a: string;
      b: string;
    }[];
    raw.close();
    const endpoints = new Set(edges.flatMap((e) => [e.a, e.b]));
    expect(endpoints.size).toBeGreaterThan(0);
    for (const ep of endpoints) {
      // every endpoint is one of the ids we recorded — a masked id would appear here instead
      expect(ids, ep).toContain(ep);
    }
    // and the rewired survivor really is the id `mergedInto` named
    expect(endpoints.has(HOSTILE_IDS[1])).toBe(true);
    expect(endpoints.has(HOSTILE_IDS[0])).toBe(false);
  });
});
