import fs from 'node:fs';
import {
  ConsolidationService,
  type JournalRecord,
  JournalService,
  type Memory,
  MemoryService,
  type StorageDriver,
  VaultService,
} from '@sthayi/core';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileCheckpoint } from '../../packages/cli/src/drivers/checkpoint-file.js';
import { NodeCrypto } from '../../packages/cli/src/drivers/crypto.js';
import { SqliteDriver } from '../../packages/cli/src/drivers/sqlite.js';
import { type FakeHome, createFakeHome } from '../helpers/fake-home.js';

/**
 * SAFETY: rollback must be authentic, strict, replay-safe, preconditioned, and
 * atomic — on the REAL driver with full checkpoint wiring. A tampered journal, a malformed
 * payload, a replayed rollback, or a single stale row must produce ZERO mutations; a mid-flight
 * failure must unwind the mutations AND the compensating entry together.
 */
describe('safety: rollback is authentic, atomic, preconditioned, replay-safe', () => {
  let home: FakeHome;
  let file: string;

  beforeEach(() => {
    home = createFakeHome();
    file = home.path('sthayi.db');
  });
  afterEach(() => home.cleanup());

  interface Stack {
    driver: SqliteDriver;
    journal: JournalService;
    memory: MemoryService;
    consolidate: ConsolidationService;
    close(): void;
  }

  /** Full production-shaped stack: real sqlite, real crypto, checkpoints, journal masking. */
  function openStack(base?: StorageDriver): Stack {
    const driver = SqliteDriver.open(file);
    driver.migrate();
    const store = base ?? driver;
    const crypto = NodeCrypto.open(home.path('key'));
    const vault = new VaultService(store, crypto, { now: () => 1 });
    const journal = new JournalService(store, {
      crypto,
      external: new FileCheckpoint(home.path('journal.checkpoint')),
      masker: vault,
    });
    const memory = new MemoryService(store, journal, vault);
    const consolidate = new ConsolidationService(store, journal, vault);
    return { driver, journal, memory, consolidate, close: () => driver.close() };
  }

  /** Seed `n` exact-dupe confirmed memories plus one distinct row; consolidate; return ids. */
  function seedAndConsolidate(
    s: Stack,
    n: number,
    opts?: { asProposal?: boolean },
  ): { batchId: number; archived: string[]; survivor: string } {
    const mems: Memory[] = [];
    for (let i = 0; i < n; i++) {
      mems.push(
        s.memory.add(
          { type: 'semantic', content: 'duplicate fixture payload', confidence: 0.9 - i * 0.1 },
          { now: 100 + i, asProposal: opts?.asProposal ?? false },
        ),
      );
    }
    s.memory.add(
      { type: 'semantic', content: 'unrelated distinct row' },
      { now: 200, asProposal: false },
    );
    const rep = s.consolidate.runDeterministic({ now: 300 });
    expect(rep.exactDupes).toBe(n - 1);
    const entry = s.driver.allJournal().find((r) => r.op === 'consolidate');
    expect(entry).toBeDefined();
    const archived = s.driver
      .listMemories({ status: 'archived' })
      .map((m) => m.id)
      .sort();
    const survivor = mems.find((m) => !archived.includes(m.id))?.id ?? '';
    return { batchId: entry?.id ?? -1, archived, survivor };
  }

  function statuses(driver: SqliteDriver): Map<string, string> {
    return new Map(driver.listMemories().map((m) => [m.id, m.status]));
  }

  it('refuses when the target payload was tampered (hash untouched); zero rows change', () => {
    const s = openStack();
    const { batchId, archived, survivor } = seedAndConsolidate(s, 2);
    s.close();

    // tamper the consolidate payload in place — redirect the rollback at the SURVIVOR
    const raw = new Database(file);
    raw.prepare('UPDATE journal SET payload = ? WHERE id = ?').run(
      JSON.stringify({
        batch: 'b',
        mode: 'deterministic',
        changes: [{ kind: 'memory_status', id: survivor, from: 'confirmed', to: 'archived' }],
      }),
      batchId,
    );
    raw.close();

    const s2 = openStack();
    const before = statuses(s2.driver);
    const r = s2.consolidate.rollback(batchId, 999);
    expect(r.ok).toBe(false);
    expect(r.reverted).toBe(0);
    expect(r.reason).toMatch(/journal failed verification/);
    expect(statuses(s2.driver)).toEqual(before); // zero mutations — survivor untouched
    expect(s2.driver.getMemory(archived[0] ?? '')?.status).toBe('archived');
    expect(s2.driver.allJournal().some((x) => x.op === 'rollback')).toBe(false);
    s2.close();
  });

  it('refuses on a truncated chain (fails closed)', () => {
    const s = openStack();
    const { batchId } = seedAndConsolidate(s, 2);
    // append one more entry AFTER the batch, then delete it out-of-band (suffix truncation)
    s.memory.add({ type: 'semantic', content: 'later entry' }, { now: 400, asProposal: false });
    s.close();

    const raw = new Database(file);
    raw.prepare('DELETE FROM journal WHERE id=(SELECT MAX(id) FROM journal)').run();
    raw.close();

    const s2 = openStack();
    const before = statuses(s2.driver);
    const r = s2.consolidate.rollback(batchId, 999);
    expect(r.ok).toBe(false);
    expect(r.reverted).toBe(0);
    expect(r.reason).toMatch(/journal failed verification/);
    expect(statuses(s2.driver)).toEqual(before);
    s2.close();
  });

  it('refuses malformed payloads (bad kind, non-array changes, extra fields); no mutation', () => {
    const s = openStack();
    seedAndConsolidate(s, 2);
    const malformed: unknown[] = [
      { batch: 'b', mode: 'deterministic', changes: [{ kind: 'evil', id: 'x' }] },
      { batch: 'b', mode: 'deterministic', changes: 'not-an-array' },
      {
        batch: 'b',
        mode: 'deterministic',
        changes: [{ kind: 'memory_delete', id: 'x', extra: 1 }],
      },
      { batch: 'b', mode: 'nonsense', changes: [{ kind: 'memory_delete', id: 'x' }] },
      { batch: 'b', mode: 'oracle', changes: [{ kind: 'memory_delete', id: 'x' }], evil: true },
    ];
    const ids = malformed.map(
      (payload) =>
        // legitimately appended (valid chain!) — strictness must come from the schema, not
        // from tamper detection
        s.journal.append({ ts: 500, actor: 'cli', op: 'consolidate', payload }).journalId,
    );
    const before = statuses(s.driver);
    for (const id of ids) {
      const r = s.consolidate.rollback(id, 999);
      expect(r.ok).toBe(false);
      expect(r.reverted).toBe(0);
      expect(r.reason).toMatch(/strict validation/);
    }
    expect(statuses(s.driver)).toEqual(before);
    expect(s.driver.allJournal().some((x) => x.op === 'rollback')).toBe(false);
    s.close();
  });

  it('names the failure for a wrong-op target and an unknown id', () => {
    const s = openStack();
    const written = s.memory.add(
      { type: 'semantic', content: 'plain write' },
      { now: 1, asProposal: false },
    );
    expect(written).toBeDefined();
    const writeEntry = s.driver.allJournal().find((r) => r.op === 'memory_write');
    const wrongOp = s.consolidate.rollback(writeEntry?.id ?? -1, 999);
    expect(wrongOp.ok).toBe(false);
    expect(wrongOp.reason).toMatch(/'memory_write' entry, not a consolidate batch/);

    const unknown = s.consolidate.rollback(99_999, 999);
    expect(unknown.ok).toBe(false);
    expect(unknown.reason).toMatch(/no journal entry #99999/);
    s.close();
  });

  it('refuses a REPLAYED rollback after an intervening confirm; the confirm survives', () => {
    const s = openStack();
    // proposals so the restored loser can be confirmed afterwards
    const { batchId, archived } = seedAndConsolidate(s, 2, { asProposal: true });
    expect(archived).toHaveLength(1);
    const loser = archived[0] ?? '';

    const first = s.consolidate.rollback(batchId, 400);
    expect(first.ok).toBe(true);
    expect(first.reverted).toBe(1);
    expect(s.driver.getMemory(loser)?.status).toBe('proposed'); // restored proposal

    // the user reviews the restored proposal and confirms it — a NEWER decision
    expect(s.memory.confirm([loser], { now: 500 })).toEqual([loser]);

    const again = s.consolidate.rollback(batchId, 600);
    expect(again.ok).toBe(false);
    expect(again.reverted).toBe(0);
    expect(again.reason).toMatch(/already rolled back by entry #\d+/);
    // the newer confirmed decision is untouched
    expect(s.driver.getMemory(loser)?.status).toBe('confirmed');
    expect(s.journal.verify()).toMatchObject({ ok: true, state: 'ok' });
    s.close();
  });

  it('one stale row in a 3-change batch → ZERO mutations, and the report names the row', () => {
    const s = openStack();
    const { batchId, archived } = seedAndConsolidate(s, 4); // 3 archived + survivor
    expect(archived).toHaveLength(3);
    const stale = archived[1] ?? '';
    // intervening out-of-band state change: one archived row is manually un-archived/confirmed
    s.driver.updateMemory(stale, { status: 'confirmed', updatedAt: 350 });

    const before = statuses(s.driver);
    const r = s.consolidate.rollback(batchId, 400);
    expect(r.ok).toBe(false);
    expect(r.reverted).toBe(0);
    expect(r.reason).toContain(stale); // names the stale row
    expect(r.reason).toMatch(/expected status 'archived'/);
    expect(r.failedPrecondition).toEqual({
      id: stale,
      expected: "status 'archived'",
      actual: "status 'confirmed'",
    });
    // ZERO mutations: the other two archived rows did NOT flip back
    expect(statuses(s.driver)).toEqual(before);
    expect(s.driver.allJournal().some((x) => x.op === 'rollback')).toBe(false);
    expect(s.journal.verify()).toMatchObject({ ok: true, state: 'ok' });
    s.close();
  });

  it('failure injection: a throw mid-apply unwinds mutations AND the compensating entry', () => {
    // seed + consolidate through the normal stack
    {
      const s = openStack();
      seedAndConsolidate(s, 3); // 2 archived → rollback makes 2 updateMemory calls
      s.close();
    }

    // wrapper driver whose updateMemory throws on the 2nd call
    const inner = SqliteDriver.open(file);
    inner.migrate();
    let updates = 0;
    const failing = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === 'updateMemory') {
          return (id: string, patch: Partial<Memory>): void => {
            updates++;
            if (updates === 2) {
              throw new Error('injected updateMemory failure');
            }
            target.updateMemory(id, patch);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as unknown as StorageDriver;

    const crypto = NodeCrypto.open(home.path('key'));
    const vault = new VaultService(failing, crypto, { now: () => 1 });
    const journal = new JournalService(failing, {
      crypto,
      external: new FileCheckpoint(home.path('journal.checkpoint')),
      masker: vault,
    });
    const consolidate = new ConsolidationService(failing, journal, vault);

    const batchId = inner.allJournal().find((r) => r.op === 'consolidate')?.id ?? -1;
    const before = new Map(inner.listMemories().map((m) => [m.id, m.status]));
    const journalLenBefore = inner.allJournal().length;

    expect(() => consolidate.rollback(batchId, 999)).toThrow(/injected updateMemory failure/);

    // no partial mutations: neither archived row flipped (the 1st update rolled back too)
    expect(new Map(inner.listMemories().map((m) => [m.id, m.status]))).toEqual(before);
    // no compensating entry
    expect(inner.allJournal()).toHaveLength(journalLenBefore);
    expect(inner.allJournal().some((r) => r.op === 'rollback')).toBe(false);
    // chain AND checkpoint still verify
    expect(journal.verify()).toMatchObject({ ok: true, state: 'ok' });
    inner.close();
  });

  it('a successful rollback still round-trips: statuses restored, chain + checkpoint intact', () => {
    const s = openStack();
    const { batchId, archived, survivor } = seedAndConsolidate(s, 3);
    const r = s.consolidate.rollback(batchId, 400);
    expect(r.ok).toBe(true);
    expect(r.reverted).toBe(2);
    for (const id of archived) {
      expect(s.driver.getMemory(id)?.status).toBe('confirmed');
    }
    expect(s.driver.getMemory(survivor)?.status).toBe('confirmed');
    const rb = s.driver.allJournal().find((x) => x.op === 'rollback');
    expect((rb?.payload as { rollsBack?: number })?.rollsBack).toBe(batchId);
    expect(s.journal.verify()).toMatchObject({ ok: true, state: 'ok' });
    s.close();
  });

  /** Seed one episodic source, run an oracle batch that promotes a distilled proposal from it. */
  async function seedOraclePromote(s: Stack): Promise<{ batchId: number; mintedId: string }> {
    const src = s.memory.add(
      { type: 'episodic', content: 'talked through the pnpm setup today' },
      { now: 100, asProposal: false },
    );
    const provider = {
      id: 'mock:test',
      complete: async () =>
        JSON.stringify({ promote: [{ from: src.id, to_content: 'The user prefers pnpm' }] }),
    };
    const rep = await s.consolidate.runOracle({
      now: 200,
      provider,
      systemPrompt: 's',
      promptVersion: 'consolidate@v1',
      mask: (x) => x,
    });
    expect(rep.changed).toBe(1);
    const entry = s.driver
      .allJournal()
      .find((r) => r.op === 'consolidate' && (r.payload as { mode?: string }).mode === 'oracle');
    const minted = s.driver
      .listMemories({ type: 'semantic' })
      .find((m) => m.provenance.source === 'oracle-distill');
    expect(entry).toBeDefined();
    expect(minted).toBeDefined();
    return { batchId: entry?.id ?? -1, mintedId: minted?.id ?? '' };
  }

  // Rollback authenticity: the memory_insert change records the row's post-state DIGEST at
  // creation; rolling back must refuse to delete a proposal whose identity fields were edited
  // since — even though its status is still 'proposed'.
  const proposalEdits: [string, object][] = [
    ['content', { content: 'edited by hand after the batch' }],
    ['provenance', { provenance: { source: 'oracle-distill', distilledFrom: ['forged-id'] } }],
    ['confidence', { confidence: 0.99 }],
  ];
  for (const [field, patch] of proposalEdits) {
    it(`refuses to roll back an oracle insert whose ${field} was edited (still 'proposed'); zero mutations`, async () => {
      const s = openStack();
      const { batchId, mintedId } = await seedOraclePromote(s);
      s.driver.updateMemory(mintedId, patch);
      const before = statuses(s.driver);
      const editedRow = s.driver.getMemory(mintedId);

      const r = s.consolidate.rollback(batchId, 999);
      expect(r.ok).toBe(false);
      expect(r.reverted).toBe(0);
      expect(r.reason).toMatch(/edited after consolidation/);
      expect(r.failedPrecondition).toBeDefined();
      expect(r.failedPrecondition?.id).toBe(mintedId);
      expect(r.failedPrecondition?.actual).toMatch(/digest mismatch/);
      // zero mutations: the edited proposal survives exactly as edited, nothing else moved
      expect(statuses(s.driver)).toEqual(before);
      expect(s.driver.getMemory(mintedId)).toEqual(editedRow);
      expect(s.driver.allJournal().some((x) => x.op === 'rollback')).toBe(false);
      expect(s.journal.verify()).toMatchObject({ ok: true, state: 'ok' });
      s.close();
    });
  }

  it('a retrieval bump does NOT break oracle-insert rollback (volatile fields excluded from the digest)', async () => {
    const s = openStack();
    const { batchId, mintedId } = await seedOraclePromote(s);
    s.driver.bumpRetrieval([mintedId], 300);
    expect(s.driver.getMemory(mintedId)?.boosts).toBeGreaterThan(0);

    const r = s.consolidate.rollback(batchId, 999);
    expect(r.ok).toBe(true);
    expect(s.driver.getMemory(mintedId)).toBeUndefined(); // the untouched insert was deleted
    expect(s.journal.verify()).toMatchObject({ ok: true, state: 'ok' });
    s.close();
  });

  it('refuses when the journal cannot be authenticated (checkpoint-disabled), on the real driver', () => {
    // No MAC-capable crypto wired: an unkeyed chain can be rewritten wholesale by whoever can
    // edit the db file, so rollback must refuse rather than trust it.
    const driver = SqliteDriver.open(file);
    driver.migrate();
    const journal = new JournalService(driver);
    const memory = new MemoryService(driver, journal);
    const consolidate = new ConsolidationService(driver, journal);
    memory.add({ type: 'semantic', content: 'dupe fact' }, { now: 1, asProposal: false });
    memory.add({ type: 'semantic', content: 'Dupe   FACT' }, { now: 2, asProposal: false });
    expect(consolidate.runDeterministic({ now: 3 }).exactDupes).toBe(1);
    const entry = driver.allJournal().find((r) => r.op === 'consolidate');
    const before = statuses(driver);

    const r = consolidate.rollback(entry?.id ?? -1, 999);
    expect(r.ok).toBe(false);
    expect(r.reverted).toBe(0);
    expect(r.reason).toMatch(/cannot be authenticated/);
    expect(r.reason).toMatch(/checkpointing is unavailable/);
    expect(statuses(driver)).toEqual(before);
    expect(driver.allJournal().some((x) => x.op === 'rollback')).toBe(false);
    driver.close();
  });

  // ---- single-transaction rollback: no inconsistent-view window ------------------------------
  //
  // rollback() runs its ENTIRE ladder — journal verify, target lookup, strict validation,
  // replay scan, preconditions, inverse mutations, compensating append — inside one
  // writeTransaction. SqliteDriver.writeTransaction opens with BEGIN IMMEDIATE, which acquires
  // the writer lock when the transaction OPENS, before the body's first read; better-sqlite3's
  // `inTransaction` is true exactly between that BEGIN and the COMMIT on this connection. Those
  // two facts give the tests below their observables:
  //  (a) a mutation smuggled in on the SAME connection during the in-transaction verify is
  //      visible to the later precondition re-read (same locked view) and must refuse — and
  //      because the refusal throws inside the transaction, even the smuggled write unwinds;
  //  (b) recording `inTransaction()` at every journal read during a rollback proves BY
  //      CONSTRUCTION that verification ran after the write lock was taken: if verify() ever
  //      moves back outside the transaction, its allJournal read observes `inTransaction()
  //      === false` and the assertion fails.

  it('a same-connection mutation injected during the in-transaction verify is SEEN by the precondition; zero net mutations', () => {
    {
      const s = openStack();
      seedAndConsolidate(s, 2); // 1 archived + survivor
      s.close();
    }

    const inner = SqliteDriver.open(file);
    inner.migrate();
    const batchId = inner.allJournal().find((r) => r.op === 'consolidate')?.id ?? -1;
    const archivedId = inner.listMemories({ status: 'archived' })[0]?.id ?? '';
    expect(archivedId).not.toBe('');

    // Wrapper driver: the FIRST allJournal read that happens INSIDE the rollback transaction
    // (verify()'s chain walk) sneakily flips the rollback target through the underlying store —
    // a same-connection write landing after "verification started". The precondition re-read
    // later in the SAME transaction must see it and refuse.
    let injected = false;
    const wrapper = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === 'allJournal') {
          return (): JournalRecord[] => {
            if (!injected && target.inTransaction()) {
              injected = true;
              target.updateMemory(archivedId, { status: 'confirmed', updatedAt: 998 });
            }
            return target.allJournal();
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as unknown as StorageDriver;

    const crypto = NodeCrypto.open(home.path('key'));
    const vault = new VaultService(wrapper, crypto, { now: () => 1 });
    const journal = new JournalService(wrapper, {
      crypto,
      external: new FileCheckpoint(home.path('journal.checkpoint')),
      masker: vault,
    });
    const consolidate = new ConsolidationService(wrapper, journal, vault);

    const before = statuses(inner);
    const r = consolidate.rollback(batchId, 999);

    expect(injected).toBe(true); // the injection really fired inside the rollback transaction
    expect(r.ok).toBe(false);
    expect(r.reverted).toBe(0);
    expect(r.reason).toMatch(/changed after consolidation/);
    expect(r.failedPrecondition).toEqual({
      id: archivedId,
      expected: "status 'archived'",
      actual: "status 'confirmed'",
    });
    // ZERO NET mutations: the refusal threw inside the transaction, so even the smuggled
    // same-connection write unwound with it — the target is back to 'archived'
    expect(statuses(inner)).toEqual(before);
    expect(inner.getMemory(archivedId)?.status).toBe('archived');
    expect(inner.allJournal().some((x) => x.op === 'rollback')).toBe(false);
    expect(journal.verify()).toMatchObject({ ok: true, state: 'ok' });
    inner.close();
  });

  it('by construction: every journal read of a rollback — verify() included — happens INSIDE the write transaction', () => {
    {
      const s = openStack();
      seedAndConsolidate(s, 3); // 2 archived → a real rollback with 2 inverse mutations
      s.close();
    }

    const inner = SqliteDriver.open(file);
    inner.migrate();
    const batchId = inner.allJournal().find((r) => r.op === 'consolidate')?.id ?? -1;

    // Instrumented wrapper: while `recording`, log `inTransaction()` at every allJournal call.
    // Observable (documented above): BEGIN IMMEDIATE takes the writer lock at transaction open,
    // and inTransaction() is true only between BEGIN and COMMIT — so a read that logs `true`
    // provably executed after the lock was taken. The FIRST logged read is verify()'s chain
    // walk; the later ones are the target lookup and the replay scan.
    let recording = false;
    const observed: boolean[] = [];
    const wrapper = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === 'allJournal') {
          return (): JournalRecord[] => {
            if (recording) {
              observed.push(target.inTransaction());
            }
            return target.allJournal();
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as unknown as StorageDriver;

    const crypto = NodeCrypto.open(home.path('key'));
    const vault = new VaultService(wrapper, crypto, { now: () => 1 });
    const journal = new JournalService(wrapper, {
      crypto,
      external: new FileCheckpoint(home.path('journal.checkpoint')),
      masker: vault,
    });
    const consolidate = new ConsolidationService(wrapper, journal, vault);

    recording = true;
    const r = consolidate.rollback(batchId, 400);
    recording = false;

    expect(r.ok).toBe(true);
    expect(r.reverted).toBe(2);
    // verify()'s journal read ran under the write lock, and so did every later read
    expect(observed.length).toBeGreaterThanOrEqual(3); // verify + target lookup + replay scan
    expect(observed[0]).toBe(true); // the FIRST read (verify's chain walk) was in-transaction
    expect(observed.every(Boolean)).toBe(true); // no read escaped the transaction
    expect(journal.verify()).toMatchObject({ ok: true, state: 'ok' });
    inner.close();
  });

  // ---- rollback guarantee boundary: db reads/mutations atomic; external file post-commit only.
  //
  // Rollback's transaction covers ALL DATABASE reads and mutations. External-file effects (the
  // journal checkpoint mirror) are outside SQLite's atomicity and are only coordinated via the
  // post-commit flush: rollback verifies in NON-HEALING mode, so a refusal must leave the
  // checkpoint file byte-identical — even when the file legitimately lags and the healing
  // verify() would have rewritten it.

  it('a REFUSED rollback performs zero external-file writes even when the external checkpoint lags (non-healing verification)', () => {
    const s = openStack();
    const { batchId, archived } = seedAndConsolidate(s, 2);
    const cpFile = home.path('journal.checkpoint');
    const lagging = fs.readFileSync(cpFile, 'utf8');
    // the installation moves on, then the OLDER (ancestor-tip) checkpoint file is restored
    s.memory.add({ type: 'semantic', content: 'later fact' }, { now: 400, asProposal: false });
    fs.writeFileSync(cpFile, lagging);

    // The lagging anchor is itself the refusal now: a rollback MUTATES, and a mutation may not
    // proceed while the only copy that survives a whole-database replacement is behind the store.
    const r = s.consolidate.rollback(batchId, 500);
    expect(r.ok).toBe(false);
    expect(r.reverted).toBe(0);
    expect(r.reason).toMatch(/refusing rollback.*external journal checkpoint is STALE/s);
    // A refusal must have ZERO external-file effects: rollback's gate runs the NON-HEALING
    // verification, so the lagging bytes are still exactly as the caller left them
    expect(fs.readFileSync(cpFile, 'utf8')).toBe(lagging);
    // the heal still exists where it belongs: the explicit (healing) verify
    expect(s.journal.verify()).toMatchObject({ ok: true, state: 'ok' });
    expect(fs.readFileSync(cpFile, 'utf8')).not.toBe(lagging);

    // …and with the anchor current again the ladder reaches its real preconditions: one stale
    // target row → a refusal at the precondition, still with zero external-file effects
    const healed = fs.readFileSync(cpFile, 'utf8');
    s.driver.updateMemory(archived[0] ?? '', { status: 'confirmed', updatedAt: 450 });
    const after = s.consolidate.rollback(batchId, 550);
    expect(after.ok).toBe(false);
    expect(after.reverted).toBe(0);
    expect(after.failedPrecondition).toBeDefined();
    expect(fs.readFileSync(cpFile, 'utf8')).toBe(healed);
    s.close();
  });

  it('a second real SqliteDriver connection attempting a write mid-rollback busy-fails instead of interleaving', () => {
    {
      const s = openStack();
      seedAndConsolidate(s, 3); // 2 archived → the rollback makes 2 updateMemory calls
      s.close();
    }
    const inner = SqliteDriver.open(file);
    inner.migrate();
    const batchId = inner.allJournal().find((r) => r.op === 'consolidate')?.id ?? -1;

    // A REAL second connection on the same database file. Its busy_timeout is lowered from 5s
    // purely for test speed — the contention outcome is identical: rollback's writeTransaction
    // opens with BEGIN IMMEDIATE and holds the write lock for the whole ladder, so the second
    // writer can never acquire it while the rollback is in flight.
    const second = SqliteDriver.open(file);
    (Reflect.get(second, 'db') as Database.Database).pragma('busy_timeout = 25');

    let contention: unknown;
    const wrapper = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === 'updateMemory') {
          return (id: string, patch: Partial<Memory>): void => {
            if (contention === undefined && target.inTransaction()) {
              // mid-rollback, write lock held: the second connection attempts a write
              try {
                second.writeTransaction(() => second.setMeta('intruder', 'interleaved'));
                contention = null; // the write went through — interleaving (assertions fail)
              } catch (err) {
                contention = err;
              }
            }
            target.updateMemory(id, patch);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as unknown as StorageDriver;

    const crypto = NodeCrypto.open(home.path('key'));
    const vault = new VaultService(wrapper, crypto, { now: () => 1 });
    const journal = new JournalService(wrapper, {
      crypto,
      external: new FileCheckpoint(home.path('journal.checkpoint')),
      masker: vault,
    });
    const consolidate = new ConsolidationService(wrapper, journal, vault);

    const r = consolidate.rollback(batchId, 400);
    expect(r.ok).toBe(true); // the rollback itself is untouched by the contention
    expect(r.reverted).toBe(2);
    // the second writer BLOCKED and busy-failed — it never interleaved into the transaction
    expect(contention).toBeInstanceOf(Error);
    expect((contention as { code?: string }).code).toMatch(/^SQLITE_BUSY/);
    // and its write never landed
    expect(inner.getMeta('intruder')).toBeUndefined();
    expect(journal.verify()).toMatchObject({ ok: true, state: 'ok' });
    second.close();
    inner.close();
  });
});
