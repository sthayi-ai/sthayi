import {
  ConsolidationService,
  JournalService,
  MemoryService,
  type MutationOutcome,
  type RollbackReport,
  memoryInsertDigest,
} from '@sthayi/core';
import { describe, expect, it } from 'vitest';
import { FakeMacCrypto, FakeStore } from '../../../../tests/helpers/fake-store.js';

const NOW = 1_700_000_000_000;

/** MAC-capable wiring: rollback refuses an unauthenticated journal (state 'checkpoint-disabled'),
 *  so the unit stack carries a deterministic fake mac — checkpoints mint and verify for real. */
function setup() {
  const store = new FakeStore();
  const journal = new JournalService(store, { crypto: new FakeMacCrypto() });
  const memory = new MemoryService(store, journal);
  const consolidate = new ConsolidationService(store, journal);
  return { store, journal, memory, consolidate };
}

describe('ConsolidationService — deterministic + rollback', () => {
  it('archives exact duplicates and rolls back byte-for-byte', () => {
    const { store, memory, consolidate } = setup();
    memory.add(
      { type: 'semantic', content: 'The user prefers pnpm' },
      { now: NOW, asProposal: false },
    );
    memory.add(
      { type: 'semantic', content: 'the user   PREFERS pnpm' },
      { now: NOW, asProposal: false },
    );
    memory.add({ type: 'semantic', content: 'Lives in Seattle' }, { now: NOW, asProposal: false });

    const report = consolidate.runDeterministic({ now: NOW });
    expect(report.exactDupes).toBe(1);
    expect(store.listMemories({ status: 'archived' })).toHaveLength(1);

    const entry = store.allJournal().find((r) => r.op === 'consolidate');
    expect(entry).toBeDefined();

    const rb = consolidate.rollback(entry?.id ?? -1, NOW + 1);
    expect(rb.ok).toBe(true);
    expect(store.listMemories({ status: 'archived' })).toHaveLength(0);
    // the journal chain is still intact after the compensating entry
    expect(new JournalService(store).verify().ok).toBe(true);
  });

  it('archives near-duplicates via MinHash', () => {
    const { memory, consolidate, store } = setup();
    memory.add(
      {
        type: 'semantic',
        content: 'The user deploys to production on Fridays only, never Mondays',
      },
      { now: NOW, asProposal: false },
    );
    memory.add(
      {
        type: 'semantic',
        content: 'The user deploys to production on Fridays only, never Tuesdays',
      },
      { now: NOW, asProposal: false },
    );
    const report = consolidate.runDeterministic({ now: NOW, nearDupeThreshold: 0.6 });
    expect(report.nearDupes).toBeGreaterThanOrEqual(1);
    expect(store.listMemories({ status: 'archived' }).length).toBeGreaterThanOrEqual(1);
  });

  it('does nothing (no journal entry) when there is nothing to consolidate', () => {
    const { memory, consolidate, store } = setup();
    memory.add({ type: 'semantic', content: 'unique alpha' }, { now: NOW, asProposal: false });
    memory.add({ type: 'semantic', content: 'unique beta' }, { now: NOW, asProposal: false });
    const report = consolidate.runDeterministic({ now: NOW });
    expect(report.changed).toBe(0);
    expect(store.allJournal().some((r) => r.op === 'consolidate')).toBe(false);
  });

  it('rollback reports failure for an unknown journal id', () => {
    const { consolidate } = setup();
    expect(consolidate.rollback(999, NOW).ok).toBe(false);
  });

  it('journals merge-group + distill-source provenance (auditable, precisely reversible)', async () => {
    const { store, memory, consolidate } = setup();
    const a = memory.add(
      { type: 'episodic', content: 'deployed widget on friday' },
      { now: NOW, asProposal: false },
    );
    const b = memory.add(
      { type: 'episodic', content: 'shipped widget friday afternoon' },
      { now: NOW, asProposal: false },
    );
    const c = memory.add(
      { type: 'episodic', content: 'set up vitest and pnpm today' },
      { now: NOW, asProposal: false },
    );

    const provider = {
      id: 'mock:test',
      complete: async () =>
        JSON.stringify({
          merge: [[a.id, b.id]],
          archive: [],
          promote: [{ from: c.id, to_content: 'The user prefers pnpm and vitest' }],
          contradictions: [],
        }),
    };
    const rep = await consolidate.runOracle({
      now: NOW + 1,
      provider,
      systemPrompt: 's',
      promptVersion: 'consolidate@v1',
      mask: (x) => x,
    });
    expect(rep.appliedBatches).toBe(1);

    type Ch = { kind: string; id: string; mergedInto?: string; distilledFrom?: string[] };
    const entry = store
      .allJournal()
      .find((r) => r.op === 'consolidate' && (r.payload as { mode?: string }).mode === 'oracle');
    const changes = (entry?.payload as { changes: Ch[] }).changes;

    // merge provenance: b was archived, folded into a
    const merged = changes.find((ch) => ch.kind === 'memory_status' && ch.id === b.id);
    expect(merged?.mergedInto).toBe(a.id);
    // distill provenance: the new fact records the source it was distilled from
    const insert = changes.find((ch) => ch.kind === 'memory_insert');
    expect(insert?.distilledFrom).toEqual([c.id]);
    // and the distilled memory itself carries provenance.distilledFrom
    const distilled = store
      .listMemories({ type: 'semantic' })
      .find((m) => m.provenance.source === 'oracle-distill');
    expect(distilled?.provenance.distilledFrom).toEqual([c.id]);

    // the insert change records the row's post-state digest, computed over the row as inserted
    expect((insert as { digest?: string })?.digest).toBe(
      memoryInsertDigest(distilled as NonNullable<typeof distilled>),
    );

    // still precisely reversible: rollback un-archives b and deletes the distilled fact
    const rb = consolidate.rollback(entry?.id ?? -1, NOW + 2);
    expect(rb.ok).toBe(true);
    expect(store.getMemory(b.id)?.status).toBe('confirmed');
    expect(store.getMemory((insert as { id?: string })?.id ?? '')).toBeUndefined();
    expect(new JournalService(store).verify().ok).toBe(true);
  });

  it('discards oracle merge groups that span scope or type — journaled, nothing applied', async () => {
    const { store, memory, consolidate } = setup();
    const a = memory.add(
      { type: 'semantic', content: 'alpha deploy fact', scope: 'user' },
      { now: NOW, asProposal: false },
    );
    const b = memory.add(
      {
        type: 'semantic',
        content: 'alpha deploy fact for the alpha project',
        scope: 'project:alpha',
      },
      { now: NOW, asProposal: false },
    );
    const provider = {
      id: 'mock:test',
      complete: async () => JSON.stringify({ merge: [[a.id, b.id]] }),
    };
    const rep = await consolidate.runOracle({
      now: NOW + 1,
      provider,
      systemPrompt: 's',
      promptVersion: 'consolidate@v1',
      mask: (x) => x,
    });
    expect(rep.skippedGroups).toBe(1);
    expect(rep.changed).toBe(0);
    expect(store.getMemory(a.id)?.status).toBe('confirmed');
    expect(store.getMemory(b.id)?.status).toBe('confirmed');
    const rejected = store.allJournal().find((r) => r.op === 'consolidate_rejected');
    expect((rejected?.payload as { reason?: string }).reason).toMatch(/scope or type/);
  });

  it('masks secrets in oracle promote content before it reaches the store (invariant 5)', async () => {
    const store = new FakeStore();
    const journal = new JournalService(store);
    const memory = new MemoryService(store, journal);
    const canary = `sk-${'D'.repeat(24)}`;
    const masker = {
      maskSecrets: (content: string) => ({
        masked: content.split(canary).join('APIKEY_01'),
        warnings: [],
      }),
    };
    const consolidate = new ConsolidationService(store, journal, masker);
    const src = memory.add(
      { type: 'episodic', content: 'talked about the deploy key' },
      { now: NOW, asProposal: false },
    );
    const provider = {
      id: 'mock:test',
      complete: async () =>
        JSON.stringify({ promote: [{ from: src.id, to_content: `deploy key is ${canary}` }] }),
    };
    const rep = await consolidate.runOracle({
      now: NOW + 1,
      provider,
      systemPrompt: 's',
      promptVersion: 'consolidate@v1',
      mask: (x) => x,
    });
    expect(rep.changed).toBe(1);
    const minted = store
      .listMemories({ type: 'semantic' })
      .find((m) => m.provenance.source === 'oracle-distill');
    expect(minted?.content).toBe('deploy key is APIKEY_01');
  });
});

describe('ConsolidationService — status/scope/type boundaries', () => {
  it('a high-confidence proposal never displaces a low-confidence confirmed duplicate', () => {
    const { store, memory, consolidate } = setup();
    const conf = memory.add(
      { type: 'semantic', content: 'prefers pnpm over npm', confidence: 0.4 },
      { now: NOW, asProposal: false },
    );
    const prop = memory.add(
      { type: 'semantic', content: 'Prefers   PNPM over npm', confidence: 0.9 },
      { now: NOW + 1 },
    );

    const rep = consolidate.runDeterministic({ now: NOW + 2 });
    expect(rep.exactDupes).toBe(1);
    // the confirmed row survives untouched; the redundant proposal folds into it
    expect(store.getMemory(conf.id)?.status).toBe('confirmed');
    expect(store.getMemory(prop.id)?.status).toBe('archived');

    type Ch = { kind: string; id: string; from?: string; mergedInto?: string };
    const entry = store.allJournal().find((r) => r.op === 'consolidate');
    const ch = (entry?.payload as { changes: Ch[] }).changes.find((c) => c.id === prop.id);
    expect(ch?.mergedInto).toBe(conf.id);
    expect(ch?.from).toBe('proposed');
  });

  it('exact dedupe never crosses scope: identical confirmed in user vs project:alpha', () => {
    const { store, memory, consolidate } = setup();
    memory.add(
      { type: 'semantic', content: 'ship on fridays', scope: 'user' },
      { now: NOW, asProposal: false },
    );
    memory.add(
      { type: 'semantic', content: 'ship on fridays', scope: 'project:alpha' },
      { now: NOW, asProposal: false },
    );
    const rep = consolidate.runDeterministic({ now: NOW });
    expect(rep.changed).toBe(0);
    expect(store.allJournal().some((r) => r.op === 'consolidate')).toBe(false);
  });

  it('exact dedupe never crosses type: identical semantic vs procedural in the same scope', () => {
    const { store, memory, consolidate } = setup();
    memory.add(
      { type: 'semantic', content: 'run pnpm verify before pushing' },
      { now: NOW, asProposal: false },
    );
    memory.add(
      { type: 'procedural', content: 'run pnpm verify before pushing' },
      { now: NOW, asProposal: false },
    );
    const rep = consolidate.runDeterministic({ now: NOW });
    expect(rep.changed).toBe(0);
    expect(store.allJournal().some((r) => r.op === 'consolidate')).toBe(false);
  });

  it('proposed×proposed exact dupes in one scope+type fold to the best-ranked proposal', () => {
    const { store, memory, consolidate } = setup();
    const low = memory.add(
      { type: 'semantic', content: 'likes dark mode', confidence: 0.5 },
      { now: NOW },
    );
    const high = memory.add(
      { type: 'semantic', content: 'Likes  dark MODE', confidence: 0.8 },
      { now: NOW + 1 },
    );
    const rep = consolidate.runDeterministic({ now: NOW + 2 });
    expect(rep.exactDupes).toBe(1);
    expect(store.getMemory(high.id)?.status).toBe('proposed');
    expect(store.getMemory(low.id)?.status).toBe('archived');
  });

  it('near-dupe folding stays within one scope+type+status partition', () => {
    const NEAR_A = 'The user deploys to production on Fridays only, never Mondays';
    const NEAR_B = 'The user deploys to production on Fridays only, never Tuesdays';

    // different statuses → no action
    {
      const { store, memory, consolidate } = setup();
      memory.add({ type: 'semantic', content: NEAR_A }, { now: NOW, asProposal: false });
      memory.add({ type: 'semantic', content: NEAR_B }, { now: NOW + 1 });
      const rep = consolidate.runDeterministic({ now: NOW + 2, nearDupeThreshold: 0.6 });
      expect(rep.nearDupes).toBe(0);
      expect(store.listMemories({ status: 'archived' })).toHaveLength(0);
    }
    // same pair, both confirmed → archives the lower rank into the higher
    {
      const { store, memory, consolidate } = setup();
      const hi = memory.add(
        { type: 'semantic', content: NEAR_A, confidence: 0.9 },
        { now: NOW, asProposal: false },
      );
      const lo = memory.add(
        { type: 'semantic', content: NEAR_B, confidence: 0.5 },
        { now: NOW + 1, asProposal: false },
      );
      const rep = consolidate.runDeterministic({ now: NOW + 2, nearDupeThreshold: 0.6 });
      expect(rep.nearDupes).toBe(1);
      expect(store.getMemory(hi.id)?.status).toBe('confirmed');
      expect(store.getMemory(lo.id)?.status).toBe('archived');
    }
    // same pair, both confirmed, different scopes → no action
    {
      const { store, memory, consolidate } = setup();
      memory.add(
        { type: 'semantic', content: NEAR_A, scope: 'user' },
        { now: NOW, asProposal: false },
      );
      memory.add(
        { type: 'semantic', content: NEAR_B, scope: 'project:alpha' },
        { now: NOW + 1, asProposal: false },
      );
      const rep = consolidate.runDeterministic({ now: NOW + 2, nearDupeThreshold: 0.6 });
      expect(rep.nearDupes).toBe(0);
      expect(store.listMemories({ status: 'archived' })).toHaveLength(0);
    }
  });

  it('oracle merge groups never cross the status boundary: proposed+confirmed is SKIPPED', async () => {
    const { store, memory, consolidate } = setup();
    const confirmed = memory.add(
      { type: 'semantic', content: 'the user deploys on fridays' },
      { now: NOW, asProposal: false },
    );
    const proposed = memory.add(
      { type: 'semantic', content: 'user prefers friday deploys' },
      { now: NOW + 1 },
    );
    // The model picks the PROPOSAL as survivor — the exact unreviewed-absorption path.
    const provider = {
      id: 'mock:test',
      complete: async () => JSON.stringify({ merge: [[proposed.id, confirmed.id]] }),
    };
    const rep = await consolidate.runOracle({
      now: NOW + 2,
      provider,
      systemPrompt: 's',
      promptVersion: 'consolidate@v1',
      mask: (x) => x,
    });
    expect(rep.skippedGroups).toBe(1);
    expect(rep.changed).toBe(0);
    // nothing moved: the confirmed memory was NOT archived into an unreviewed proposal
    expect(store.getMemory(confirmed.id)?.status).toBe('confirmed');
    expect(store.getMemory(proposed.id)?.status).toBe('proposed');
    const rejected = store.allJournal().find((r) => r.op === 'consolidate_rejected');
    expect((rejected?.payload as { reason?: string }).reason).toMatch(/status/);
  });

  it('oracle apply re-reads inside the write lock: a mid-flight confirm is journaled as from:"confirmed"', async () => {
    const { store, memory, consolidate } = setup();
    const a = memory.add({ type: 'semantic', content: 'fact alpha deploys' }, { now: NOW });
    const b = memory.add({ type: 'semantic', content: 'alpha deploy fact too' }, { now: NOW + 1 });
    // While the LLM call is in flight, the user confirms BOTH proposals (same status → the
    // merge still applies, but `from` must reflect the state AT APPLY TIME, not the snapshot).
    const provider = {
      id: 'mock:test',
      complete: async () => {
        memory.confirm([a.id, b.id], { now: NOW + 2 });
        return JSON.stringify({ merge: [[a.id, b.id]] });
      },
    };
    const rep = await consolidate.runOracle({
      now: NOW + 3,
      provider,
      systemPrompt: 's',
      promptVersion: 'consolidate@v1',
      mask: (x) => x,
    });
    expect(rep.changed).toBe(1);
    type Ch = { kind: string; id: string; from?: string; to?: string };
    const entry = store
      .allJournal()
      .find((r) => r.op === 'consolidate' && (r.payload as { mode?: string }).mode === 'oracle');
    const ch = (entry?.payload as { changes: Ch[] }).changes.find((c) => c.id === b.id);
    // the snapshot said 'proposed'; the truth at apply time is 'confirmed' — the journal must
    // certify the truth, or a later rollback would silently revert the user's confirm
    expect(ch?.from).toBe('confirmed');
    // and rollback restores exactly that state
    const rb = consolidate.rollback(entry?.id ?? -1, NOW + 4);
    expect(rb.ok).toBe(true);
    expect(store.getMemory(b.id)?.status).toBe('confirmed');
  });

  it('oracle ops whose target was rejected mid-flight are skipped, not resurrected', async () => {
    const { store, memory, consolidate } = setup();
    const a = memory.add({ type: 'semantic', content: 'doomed fact one' }, { now: NOW });
    const src = memory.add({ type: 'episodic', content: 'doomed source two' }, { now: NOW + 1 });
    // The user rejects both while the oracle call is in flight.
    const provider = {
      id: 'mock:test',
      complete: async () => {
        memory.reject([a.id, src.id], { now: NOW + 2 });
        return JSON.stringify({
          archive: [a.id],
          promote: [{ from: src.id, to_content: 'distilled from a rejected memory' }],
        });
      },
    };
    const rep = await consolidate.runOracle({
      now: NOW + 3,
      provider,
      systemPrompt: 's',
      promptVersion: 'consolidate@v1',
      mask: (x) => x,
    });
    expect(rep.changed).toBe(0);
    expect(rep.skippedOps).toBe(2);
    // the archive op did NOT journal a bogus proposed→archived change (whose rollback would
    // resurrect the rejected memory), and the reject stands
    expect(store.getMemory(a.id)?.status).toBe('archived');
    expect(
      store
        .allJournal()
        .some((r) => r.op === 'consolidate' && (r.payload as { mode?: string }).mode === 'oracle'),
    ).toBe(false);
    // nothing was distilled from the rejected source
    expect(
      store
        .listMemories({ type: 'semantic' })
        .some((m) => m.provenance.source === 'oracle-distill'),
    ).toBe(false);
    const rejected = store.allJournal().filter((r) => r.op === 'consolidate_rejected');
    expect(
      rejected.some((r) =>
        /archived, changed, or removed/.test(String((r.payload as { reason?: string }).reason)),
      ),
    ).toBe(true);
  });

  it('deterministic pass computes inside the write lock: `from` always equals the in-tx status', () => {
    const { store, memory, consolidate } = setup();
    const keep = memory.add({ type: 'semantic', content: 'the user prefers pnpm' }, { now: NOW });
    const dupe = memory.add(
      { type: 'semantic', content: 'The User   prefers PNPM' },
      { now: NOW + 1 },
    );
    // The user confirms the survivor AFTER writing but BEFORE consolidate runs: the journaled
    // `from` for the archived dupe must be its status as seen under the write lock.
    memory.confirm([keep.id], { now: NOW + 2 });

    const rep = consolidate.runDeterministic({ now: NOW + 3 });
    expect(rep.exactDupes).toBe(1);
    expect(store.getMemory(keep.id)?.status).toBe('confirmed');
    expect(store.getMemory(dupe.id)?.status).toBe('archived');
    type Ch = { kind: string; id: string; from?: string };
    const entry = store.allJournal().find((r) => r.op === 'consolidate');
    const changes = (entry?.payload as { changes: Ch[] }).changes;
    expect(changes.find((c) => c.id === dupe.id)?.from).toBe('proposed');
    for (const c of changes) {
      expect(c.from).toBeDefined();
    }
  });

  it('rollback refuses when the journal cannot be authenticated (checkpoint-disabled)', () => {
    // No MAC-capable crypto: verify() reports 'checkpoint-disabled', and an unkeyed chain can be
    // rewritten wholesale — rollback must refuse rather than trust it.
    const store = new FakeStore();
    const journal = new JournalService(store);
    const memory = new MemoryService(store, journal);
    const consolidate = new ConsolidationService(store, journal);
    memory.add({ type: 'semantic', content: 'dupe fact' }, { now: NOW, asProposal: false });
    memory.add({ type: 'semantic', content: 'Dupe   FACT' }, { now: NOW + 1, asProposal: false });
    const rep = consolidate.runDeterministic({ now: NOW + 2 });
    expect(rep.exactDupes).toBe(1);
    const entry = store.allJournal().find((r) => r.op === 'consolidate');
    const archivedBefore = store.listMemories({ status: 'archived' }).map((m) => m.id);
    expect(archivedBefore).toHaveLength(1);

    const rb = consolidate.rollback(entry?.id ?? -1, NOW + 3);
    expect(rb.ok).toBe(false);
    expect(rb.reverted).toBe(0);
    expect(rb.reason).toMatch(/cannot be authenticated/);
    expect(rb.reason).toMatch(/checkpointing is unavailable/);
    // zero mutations, no compensating entry
    expect(store.listMemories({ status: 'archived' }).map((m) => m.id)).toEqual(archivedBefore);
    expect(store.allJournal().some((r) => r.op === 'rollback')).toBe(false);
  });

  it('rollback of a mixed batch restores scope, type, and status exactly', () => {
    const { store, memory, consolidate } = setup();
    const mems = [
      // confirmed + redundant proposal, scope user
      memory.add(
        { type: 'semantic', content: 'mixed fixture pnpm', confidence: 0.4 },
        { now: NOW, asProposal: false },
      ),
      memory.add(
        { type: 'semantic', content: 'Mixed  Fixture PNPM', confidence: 0.9 },
        { now: NOW + 1 },
      ),
      // proposed×proposed exact dupes, scope project:alpha
      memory.add(
        { type: 'procedural', content: 'run tests before pushing', scope: 'project:alpha' },
        { now: NOW + 2 },
      ),
      memory.add(
        { type: 'procedural', content: 'run tests   BEFORE pushing', scope: 'project:alpha' },
        { now: NOW + 3 },
      ),
      // confirmed near-dupe pair, scope user
      memory.add(
        {
          type: 'episodic',
          content: 'The user deploys to production on Fridays only, never Mondays',
        },
        { now: NOW + 4, asProposal: false },
      ),
      memory.add(
        {
          type: 'episodic',
          content: 'The user deploys to production on Fridays only, never Tuesdays',
        },
        { now: NOW + 5, asProposal: false },
      ),
    ];
    const before = new Map(mems.map((m) => [m.id, store.getMemory(m.id)]));

    const rep = consolidate.runDeterministic({ now: NOW + 10, nearDupeThreshold: 0.6 });
    expect(rep.changed).toBe(3);

    const entry = store.allJournal().find((r) => r.op === 'consolidate');
    const rb = consolidate.rollback(entry?.id ?? -1, NOW + 11);
    expect(rb.ok).toBe(true);
    for (const [id, orig] of before) {
      const after = store.getMemory(id);
      expect(after?.status).toBe(orig?.status);
      expect(after?.scope).toBe(orig?.scope);
      expect(after?.type).toBe(orig?.type);
    }
    expect(new JournalService(store).verify().ok).toBe(true);
  });
});

describe('ConsolidationService — memory_insert post-state digests', () => {
  /** Seed one source, run an oracle batch that promotes a distilled fact, return the pieces. */
  async function oraclePromote() {
    const s = setup();
    const src = s.memory.add(
      { type: 'episodic', content: 'set up vitest and pnpm today' },
      { now: NOW, asProposal: false },
    );
    const provider = {
      id: 'mock:test',
      complete: async () =>
        JSON.stringify({ promote: [{ from: src.id, to_content: 'The user prefers pnpm' }] }),
    };
    const rep = await s.consolidate.runOracle({
      now: NOW + 1,
      provider,
      systemPrompt: 's',
      promptVersion: 'consolidate@v1',
      mask: (x) => x,
    });
    expect(rep.changed).toBe(1);
    const entry = s.store
      .allJournal()
      .find((r) => r.op === 'consolidate' && (r.payload as { mode?: string }).mode === 'oracle');
    const minted = s.store
      .listMemories({ type: 'semantic' })
      .find((m) => m.provenance.source === 'oracle-distill');
    if (!entry || !minted) {
      throw new Error('oracle promote fixture failed to seed');
    }
    return { ...s, entryId: entry.id, minted };
  }

  const edits: [string, object][] = [
    ['content', { content: 'edited by hand after the batch' }],
    ['provenance', { provenance: { source: 'oracle-distill', distilledFrom: ['forged'] } }],
    ['confidence', { confidence: 0.99 }],
    ['type', { type: 'procedural' }],
    ['scope', { scope: 'project:alpha' }],
    ['source', { source: 'cli' }],
  ];

  for (const [field, patch] of edits) {
    it(`refuses to roll back an oracle insert whose ${field} was edited (still 'proposed')`, async () => {
      const { store, consolidate, entryId, minted } = await oraclePromote();
      store.updateMemory(minted.id, patch);
      const before = store.getMemory(minted.id);

      const rb = consolidate.rollback(entryId, NOW + 5);
      expect(rb.ok).toBe(false);
      expect(rb.reverted).toBe(0);
      expect(rb.reason).toMatch(/edited after consolidation/);
      expect(rb.reason).toMatch(/content, type, scope, source, confidence, or provenance/);
      expect(rb.failedPrecondition).toEqual({
        id: minted.id,
        expected: 'recorded insert digest over {content,type,scope,source,confidence,provenance}',
        actual: 'digest mismatch — at least one of those fields changed',
      });
      // zero mutations: the edited proposal survives byte-identically, no compensating entry
      expect(store.getMemory(minted.id)).toEqual(before);
      expect(store.allJournal().some((r) => r.op === 'rollback')).toBe(false);
    });
  }

  it('a retrieval bump does NOT break rollback (volatile fields are excluded from the digest)', async () => {
    const { store, consolidate, entryId, minted } = await oraclePromote();
    store.bumpRetrieval([minted.id], NOW + 2);
    const bumped = store.getMemory(minted.id);
    expect(bumped?.boosts).toBeGreaterThan(0);

    const rb = consolidate.rollback(entryId, NOW + 5);
    expect(rb.ok).toBe(true);
    expect(store.getMemory(minted.id)).toBeUndefined(); // the untouched insert was deleted
  });

  it('a confirmed insert still refuses (status precondition is checked in addition to the digest)', async () => {
    const { store, memory, consolidate, entryId, minted } = await oraclePromote();
    expect(memory.confirm([minted.id], { now: NOW + 2 })).toEqual([minted.id]);
    const rb = consolidate.rollback(entryId, NOW + 5);
    expect(rb.ok).toBe(false);
    expect(rb.reverted).toBe(0);
    expect(rb.reason).toMatch(/reject it explicitly/);
    expect(store.getMemory(minted.id)?.status).toBe('confirmed');
  });
});

describe('ConsolidationService — oracle contradictions are journaled, never applied', () => {
  it('a batch returning contradictions journals them, changes nothing, and reports the count', async () => {
    const { store, memory, consolidate } = setup();
    const a = memory.add(
      { type: 'semantic', content: 'the user deploys on fridays' },
      { now: NOW, asProposal: false },
    );
    const b = memory.add(
      { type: 'semantic', content: 'the user never deploys on fridays' },
      { now: NOW + 1, asProposal: false },
    );
    const provider = {
      id: 'mock:test',
      complete: async () =>
        JSON.stringify({
          contradictions: [{ a: a.id, b: b.id, reason: 'friday deploy policies conflict' }],
        }),
    };
    const rep = await consolidate.runOracle({
      now: NOW + 2,
      provider,
      systemPrompt: 's',
      promptVersion: 'consolidate@v1',
      mask: (x) => x,
    });
    expect(rep.contradictions).toBe(1);
    expect(rep.changed).toBe(0);
    expect(rep.appliedBatches).toBe(0);
    expect(rep.rejectedBatches).toBe(0);

    // NEVER auto-modifies memory: both rows byte-identical, no consolidate batch entry
    expect(store.getMemory(a.id)?.status).toBe('confirmed');
    expect(store.getMemory(b.id)?.status).toBe('confirmed');
    expect(store.getMemory(a.id)?.content).toBe('the user deploys on fridays');
    expect(store.getMemory(b.id)?.content).toBe('the user never deploys on fridays');
    expect(
      store
        .allJournal()
        .some((r) => r.op === 'consolidate' && (r.payload as { mode?: string }).mode === 'oracle'),
    ).toBe(false);

    // journaled ONCE for the batch, pairs with ids + reason
    const entries = store.allJournal().filter((r) => r.op === 'consolidate_contradictions');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.payload).toEqual({
      pairs: [{ a: a.id, b: b.id, reason: 'friday deploy policies conflict' }],
    });
    expect(entries[0]?.actor).toBe('oracle:mock:test');
  });

  it('contradictions ride along with applied ops: merge applies, pairs journal separately', async () => {
    const { store, memory, consolidate } = setup();
    const a = memory.add(
      { type: 'semantic', content: 'alpha deploy fact' },
      { now: NOW, asProposal: false },
    );
    const b = memory.add(
      { type: 'semantic', content: 'alpha deploy fact too' },
      { now: NOW + 1, asProposal: false },
    );
    const c = memory.add(
      { type: 'semantic', content: 'deploys are forbidden' },
      { now: NOW + 2, asProposal: false },
    );
    const provider = {
      id: 'mock:test',
      complete: async () =>
        JSON.stringify({
          merge: [[a.id, b.id]],
          contradictions: [{ a: a.id, b: c.id, reason: 'deploy policy conflict' }],
        }),
    };
    const rep = await consolidate.runOracle({
      now: NOW + 3,
      provider,
      systemPrompt: 's',
      promptVersion: 'consolidate@v1',
      mask: (x) => x,
    });
    expect(rep.appliedBatches).toBe(1);
    expect(rep.changed).toBe(1);
    expect(rep.contradictions).toBe(1);
    expect(store.getMemory(b.id)?.status).toBe('archived'); // the merge applied
    expect(store.getMemory(c.id)?.status).toBe('confirmed'); // the contradiction did NOT
    expect(store.allJournal().filter((r) => r.op === 'consolidate_contradictions')).toHaveLength(1);
  });

  it('masks and bounds the model-authored reason before it enters the journal', async () => {
    const store = new FakeStore();
    const journal = new JournalService(store, { crypto: new FakeMacCrypto() });
    const memory = new MemoryService(store, journal);
    const canary = `sk-${'E'.repeat(24)}`;
    const masker = {
      maskSecrets: (content: string) => ({
        masked: content.split(canary).join('APIKEY_02'),
        warnings: [],
      }),
    };
    const consolidate = new ConsolidationService(store, journal, masker);
    const a = memory.add(
      { type: 'semantic', content: 'fact one' },
      { now: NOW, asProposal: false },
    );
    const b = memory.add(
      { type: 'semantic', content: 'fact two' },
      { now: NOW + 1, asProposal: false },
    );
    const provider = {
      id: 'mock:test',
      complete: async () =>
        JSON.stringify({
          contradictions: [{ a: a.id, b: b.id, reason: `leaked ${canary} ${'x'.repeat(500)}` }],
        }),
    };
    const rep = await consolidate.runOracle({
      now: NOW + 2,
      provider,
      systemPrompt: 's',
      promptVersion: 'consolidate@v1',
      mask: (x) => x,
    });
    expect(rep.contradictions).toBe(1);
    const entry = store.allJournal().find((r) => r.op === 'consolidate_contradictions');
    const reason = (entry?.payload as { pairs: { reason: string }[] }).pairs[0]?.reason ?? '';
    expect(reason).not.toContain(canary);
    expect(reason).toContain('APIKEY_02');
    expect(reason.length).toBeLessThanOrEqual(281); // 280 + truncation ellipsis
  });
});

describe('ConsolidationService — rollback runs entirely inside one write transaction', () => {
  it('journal verification (and every later read) happens inside the transaction — no inconsistent-view window', () => {
    // Instrumented FakeStore: log inTransaction() at every allJournal read during rollback.
    // FakeStore.writeTransaction (like SqliteDriver's BEGIN IMMEDIATE) opens the transaction
    // before the body's first read, so a `false` here would mean verify() escaped the
    // transaction — the exact inconsistent-view window this restructure removed.
    const store = new FakeStore();
    const journal = new JournalService(store, { crypto: new FakeMacCrypto() });
    const memory = new MemoryService(store, journal);
    const consolidate = new ConsolidationService(store, journal);
    memory.add({ type: 'semantic', content: 'dupe fact' }, { now: NOW, asProposal: false });
    memory.add({ type: 'semantic', content: 'DUPE  fact' }, { now: NOW + 1, asProposal: false });
    expect(consolidate.runDeterministic({ now: NOW + 2 }).exactDupes).toBe(1);
    const entry = store.allJournal().find((r) => r.op === 'consolidate');

    const observed: boolean[] = [];
    let recording = false;
    const original = store.allJournal.bind(store);
    store.allJournal = () => {
      if (recording) {
        observed.push(store.inTransaction());
      }
      return original();
    };

    recording = true;
    const rb = consolidate.rollback(entry?.id ?? -1, NOW + 3);
    recording = false;

    expect(rb.ok).toBe(true);
    expect(observed.length).toBeGreaterThanOrEqual(3); // verify + target lookup + replay scan
    expect(observed[0]).toBe(true); // the FIRST journal read (verify's walk) was in-transaction
    expect(observed.every(Boolean)).toBe(true);
  });

  it('rollback verifies in NON-HEALING mode: a refusal writes nothing to the external checkpoint store', () => {
    // Rollback's atomicity guarantee covers database reads and mutations; external-file effects
    // are only coordinated via the post-commit flush. So a rollback that REFUSES must leave the
    // external checkpoint byte-identical — the healing verify() would have rewritten a lagging
    // copy before the refusal.
    //
    // The refusal driven here is the LAGGING ANCHOR itself, which is a refusal in its own
    // right: a rollback is a mutation, and a mutation may not proceed while nothing outside the
    // database vouches for the store. (The stale-target precondition refusal is pinned separately
    // below, on a store whose anchor is current, so the two reasons stay distinguishable.)
    const store = new FakeStore();
    const external: { value?: string; read(): string | undefined; write(v: string): void } = {
      value: undefined,
      read() {
        return this.value;
      },
      write(v: string) {
        this.value = v;
      },
    };
    const journal = new JournalService(store, { crypto: new FakeMacCrypto(), external });
    const memory = new MemoryService(store, journal);
    const consolidate = new ConsolidationService(store, journal);
    memory.add({ type: 'semantic', content: 'dupe fact' }, { now: NOW, asProposal: false });
    memory.add({ type: 'semantic', content: 'DUPE  fact' }, { now: NOW + 1, asProposal: false });
    expect(consolidate.runDeterministic({ now: NOW + 2 }).exactDupes).toBe(1);
    const entry = store.allJournal().find((r) => r.op === 'consolidate');
    const archived = store.listMemories({ status: 'archived' })[0];
    const lagging = external.value as string;
    // the store moves on (external advances), then the OLDER ancestor copy is restored
    memory.add({ type: 'semantic', content: 'later fact' }, { now: NOW + 3, asProposal: false });
    external.value = lagging;

    const rb = consolidate.rollback(entry?.id ?? -1, NOW + 5);
    expect(rb.ok).toBe(false);
    expect(rb.reverted).toBe(0);
    expect(rb.reason).toMatch(/refusing rollback.*external journal checkpoint is STALE/s);
    expect(external.value).toBe(lagging); // refusal had ZERO external-store effects
    expect(store.listMemories({ status: 'archived' })).toHaveLength(1); // and zero db effects

    // the heal still happens where it belongs: the explicit healing verify
    expect(journal.verify()).toMatchObject({ ok: true, state: 'ok' });
    expect(external.value).not.toBe(lagging);
    // …and with the anchor current again, the SAME rollback reaches its real preconditions:
    // one stale target row → a refusal at the precondition, still with zero effects
    store.updateMemory(archived?.id ?? '', { status: 'confirmed', updatedAt: NOW + 4 });
    const after = consolidate.rollback(entry?.id ?? -1, NOW + 6);
    expect(after.ok).toBe(false);
    expect(after.reverted).toBe(0);
    expect(after.failedPrecondition).toBeDefined();
  });
});

describe('RollbackReport is a discriminated union, and success REQUIRES the outcome', () => {
  /**
   * COMPILE-TIME, deliberately. The hazard is a surface rendering a successful rollback without
   * ever looking at the compensating entry's outcome — a degraded rollback then reads exactly like
   * a clean one, at exit 0. An optional field beside a boolean makes that omission legal; a union
   * whose success branch requires the outcome makes the omission UNCONSTRUCTIBLE. `@ts-expect-error`
   * is the assertion: if the union is ever relaxed back to an optional field these lines stop
   * erroring, and the unused directive fails the build.
   */
  it('a success report without an outcome does not typecheck', () => {
    // @ts-expect-error — `ok: true` structurally requires `outcome`
    const missingOutcome: RollbackReport = { ok: true, reverted: 1 };
    expect(missingOutcome.ok).toBe(true);
  });

  it('a refusal cannot carry an outcome, and cannot claim reverted rows', () => {
    const noEntry: MutationOutcome = { state: 'no-entry' };
    // @ts-expect-error — a refusal appended nothing, so there is no outcome it could report
    const withOutcome: RollbackReport = { ok: false, reason: 'r', reverted: 0, outcome: noEntry };
    expect(withOutcome.ok).toBe(false);
    // @ts-expect-error — rollback is all-or-nothing: a refusal reverted exactly 0
    const bogusCount: RollbackReport = { ok: false, reason: 'refused', reverted: 2 };
    expect(bogusCount.ok).toBe(false);
  });

  it('at runtime every successful rollback really does carry it', () => {
    const { store, memory, consolidate } = setup();
    memory.add({ type: 'semantic', content: 'union fixture' }, { now: NOW, asProposal: false });
    memory.add({ type: 'semantic', content: 'union fixture' }, { now: NOW, asProposal: false });
    expect(consolidate.runDeterministic({ now: NOW }).changed).toBe(1);
    const entry = store.allJournal().find((r) => r.op === 'consolidate');

    const rb = consolidate.rollback(entry?.id ?? -1, NOW + 1);
    expect(rb.ok).toBe(true);
    // Narrowing on `ok` is what reaches it — there is no `!== undefined` guard to forget.
    if (rb.ok) {
      expect(rb.outcome).toBeDefined();
      expect(rb.outcome.state).toBe('committed');
      expect(rb.reason).toBeUndefined();
    }
  });
});
