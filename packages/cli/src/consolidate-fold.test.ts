import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeHome, createFakeHome } from '../../../tests/helpers/fake-home.js';
import { buildProgram } from './index.js';
import { openStore } from './store.js';

/**
 * Invariant: consolidate/rollback must fold the merge rewires they journal — otherwise
 * associative bridges to archived merge losers vanish until the next search's catchUp. The CLI
 * commands themselves must leave the association graph caught up.
 */
describe('consolidate/rollback fold the association graph', () => {
  let home: FakeHome;
  beforeEach(() => {
    home = createFakeHome();
  });
  afterEach(() => home.cleanup());

  it('CLI consolidate folds merge rewires immediately — no search needed to heal', async () => {
    const now = Date.now();
    let survivorId = '';
    let bridgeId = '';
    {
      const store = openStore();
      const survivor = store.memory.add(
        { type: 'semantic', content: 'duplicate payload fixture', confidence: 0.9 },
        { now, asProposal: false },
      );
      const loser = store.memory.add(
        { type: 'semantic', content: 'duplicate payload fixture', confidence: 0.5 },
        { now: now + 1, asProposal: false },
      );
      const bridge = store.memory.add(
        { type: 'semantic', content: 'associated bridge fixture', confidence: 0.9 },
        { now: now + 2, asProposal: false },
      );
      survivorId = survivor.id;
      bridgeId = bridge.id;
      // Hebbian edge loser–bridge, folded so it pre-dates the merge
      store.journal.append({
        ts: now + 3,
        actor: 'seed',
        op: 'memory_retrieve',
        payload: { query: 'q', ids: [loser.id, bridge.id] },
      });
      store.assoc.catchUp();
      store.close();
    }

    await buildProgram().parseAsync(['consolidate'], { from: 'user' });

    const store = openStore();
    try {
      const tip = store.journal.recent(1)[0];
      expect(tip?.op).toBe('consolidate');
      // cursor at the tip: the command folded its own journal entries
      expect(store.driver.getMeta('assoc_cursor')).toBe(String(tip?.id));
      // the loser's association mass lives on the survivor and is visible at read time
      const edges = store.driver.neighborsAssoc([survivorId]);
      expect(
        edges.some(
          (e) =>
            (e.a === survivorId && e.b === bridgeId) || (e.a === bridgeId && e.b === survivorId),
        ),
      ).toBe(true);
    } finally {
      store.close();
    }
  });

  it('CLI rollback folds its compensating entries (cursor back at the tip)', async () => {
    const now = Date.now();
    {
      const store = openStore();
      store.memory.add(
        { type: 'semantic', content: 'rollback dupe fixture', confidence: 0.9 },
        { now, asProposal: false },
      );
      store.memory.add(
        { type: 'semantic', content: 'rollback dupe fixture', confidence: 0.5 },
        { now: now + 1, asProposal: false },
      );
      store.close();
    }
    await buildProgram().parseAsync(['consolidate'], { from: 'user' });

    let batchJournalId: number | undefined;
    {
      const store = openStore();
      batchJournalId = store.journal.recent(5).find((r) => r.op === 'consolidate')?.id;
      store.close();
    }
    expect(batchJournalId).toBeDefined();

    await buildProgram().parseAsync(['rollback', String(batchJournalId)], { from: 'user' });

    const store = openStore();
    try {
      const tip = store.journal.recent(1)[0];
      expect(tip?.op).toBe('rollback');
      expect(store.driver.getMeta('assoc_cursor')).toBe(String(tip?.id));
    } finally {
      store.close();
    }
  });
});
