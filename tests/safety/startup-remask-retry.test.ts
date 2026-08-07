import {
  JournalService,
  MemoryService,
  type MutationOutcome,
  VaultService,
  committedReceipts,
} from '@sthayi/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileCheckpoint } from '../../packages/cli/src/drivers/checkpoint-file.js';
import { NodeCrypto } from '../../packages/cli/src/drivers/crypto.js';
import { SqliteDriver } from '../../packages/cli/src/drivers/sqlite.js';
import {
  PII_REMASK_META_KEY,
  PII_REMASK_ROWS_DONE,
  remaskLegacyRows,
} from '../../packages/cli/src/store.js';
import { type FakeHome, createFakeHome } from '../helpers/fake-home.js';
import { removeOwned } from '../helpers/owned-fs.js';

/**
 * SAFETY: the STARTUP migration reports the attempt that committed, and no other.
 *
 * THE HAZARD. `SqliteDriver.writeTransaction` retries the whole body on SQLITE_BUSY, and every
 * attempt before the last one ROLLED BACK — its remasked rows and its `migrate_masking` row are
 * gone with them. The legacy-PII row pass holds an append HANDLE, and a handle kept in a variable
 * outside the callback survives that rollback. The second attempt then has a genuinely reachable
 * early return — another process finishing the migration between the two attempts leaves the state
 * marker past 'rows-pending' — and it writes nothing at all. Attempt 1's handle escapes anyway, so
 * the startup channel describes an entry the database threw away: 'rolled-back' where the truth is
 * 'no-entry'.
 *
 * Nothing is claimed DURABLE that is not, so this is an honesty defect rather than a false success.
 * It is still a defect: this is the startup path whose entire job is stating exactly what opening
 * the store achieved, and a report that names a discarded entry is not that.
 *
 * THE INVARIANT. Per-attempt state — the count, the needles, and the append handle — is minted
 * inside the attempt and returned from it, so only the committed attempt's handle escapes.
 *
 * Real SQLite, a real FileCheckpoint, and a real retry: the injected failure carries the very code
 * (`SQLITE_BUSY`) the driver's retry loop keys on, thrown after a REAL append has run inside the
 * attempt, so the rollback and the re-run are the driver's own.
 */

let home: FakeHome;

beforeEach(() => {
  home = createFakeHome();
});
afterEach(() => {
  vi.restoreAllMocks();
  removeOwned(home.path('journal.checkpoint.lock'));
  home.cleanup();
});

function openStack() {
  const driver = SqliteDriver.open(home.path('sthayi.db'));
  driver.migrate();
  const crypto = NodeCrypto.open(home.path('key'));
  const vault = new VaultService(driver, crypto, { terms: [], now: () => 1 });
  const journal = new JournalService(driver, {
    crypto,
    external: new FileCheckpoint(home.path('journal.checkpoint')),
    masker: vault,
    warn: () => {},
  });
  return {
    driver,
    journal,
    vault,
    memory: new MemoryService(driver, journal, vault),
    close: (): void => driver.close(),
  };
}

const LEGACY_PII = 'email me at legacy.pii@example-leak.io about the launch';

/**
 * Plant what a LEGACY unmasked build left behind: a memory row holding plaintext PII. Written
 * through the driver on purpose — routing it through MemoryService would mask it at write time,
 * and then there would be nothing for the migration's row pass to change.
 */
function plantLegacyRow(s: ReturnType<typeof openStack>): void {
  const m = s.memory.add({ type: 'semantic', content: 'placeholder fact' }, { now: 1 });
  s.driver.updateMemory(m.id, { content: LEGACY_PII });
}

/**
 * Fail the first attempt the way a contended writer does — at the LAST statement of the body, the
 * write of the migration marker, so the attempt is a COMPLETE one: rows remasked, the
 * `migrate_masking` entry appended and its handle already in hand. That is the only injection point
 * that reproduces the hazard; failing at the append itself throws before any handle exists and
 * leaks nothing. The marker write runs for real first, then throws with the code
 * `writeTransaction` retries on, so better-sqlite3 rolls the whole attempt back — entry included —
 * and the driver runs the body again. Exactly the sequence a real SQLITE_BUSY produces.
 */
function injectBusyAtMarkerWrite(driver: SqliteDriver): { count: () => number } {
  const real = driver.setMeta.bind(driver);
  let injected = 0;
  vi.spyOn(driver, 'setMeta').mockImplementation((key: string, value: string) => {
    real(key, value);
    if (key === PII_REMASK_META_KEY && injected < 1) {
      injected++;
      const err = new Error('injected SQLITE_BUSY') as Error & { code: string };
      err.code = 'SQLITE_BUSY';
      throw err;
    }
  });
  return { count: (): number => injected };
}

/**
 * A racing peer that finishes the migration BETWEEN the two attempts: from `when()` onwards the
 * migration marker reads as phase-1-complete, which is what the second attempt sees when it
 * re-checks the state machine inside the write lock. Only the migration's own key is intercepted —
 * every other meta read is the database's.
 */
function peerFinishesMigration(driver: SqliteDriver, when: () => boolean): void {
  const real = driver.getMeta.bind(driver);
  vi.spyOn(driver, 'getMeta').mockImplementation((key: string) => {
    if (key === PII_REMASK_META_KEY && when()) {
      return PII_REMASK_ROWS_DONE;
    }
    return real(key);
  });
}

describe('safety: the legacy-PII row pass survives a busy retry without reporting a discarded entry', () => {
  it("a peer finishing between the attempts yields 'no-entry', never the rolled-back handle", () => {
    const s = openStack();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      plantLegacyRow(s);
      const busy = injectBusyAtMarkerWrite(s.driver);
      // the marker flips exactly when the first attempt has been rolled back
      peerFinishesMigration(s.driver, () => busy.count() > 0);

      const rows = remaskLegacyRows(s.driver, s.journal, s.vault);

      expect(busy.count()).toBe(1);
      // The attempt that COMMITTED took the early return: it changed nothing and appended nothing.
      expect(rows.remasked).toBe(0);
      expect(rows.needles).toEqual([]);
      const outcome: MutationOutcome = rows.outcome;
      expect(outcome.state).toBe('no-entry');
      // …and no receipt describes the entry the rollback discarded
      expect(committedReceipts([outcome])).toEqual([]);
      expect(s.driver.allJournal().filter((r) => r.op === 'migrate_masking')).toHaveLength(0);
    } finally {
      s.close();
    }
  });

  it('CONTROL: without a racing peer the retry re-runs the pass and reports ITS entry', () => {
    // The invariant is "only the committed attempt escapes", not "nothing escapes": a retry that
    // goes on to do the work must still report the entry it actually left in the database.
    const s = openStack();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      plantLegacyRow(s);
      const busy = injectBusyAtMarkerWrite(s.driver);

      const rows = remaskLegacyRows(s.driver, s.journal, s.vault);

      expect(busy.count()).toBe(1);
      expect(rows.remasked).toBe(1);
      const outcome: MutationOutcome = rows.outcome;
      expect(outcome.state).toBe('committed');
      // exactly ONE entry survives the rollback, and it is the one the receipt names
      const entries = s.driver.allJournal().filter((r) => r.op === 'migrate_masking');
      expect(entries).toHaveLength(1);
      const receipts = committedReceipts([outcome]);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]?.record.id).toBe(entries[0]?.id);
      expect(s.driver.getMeta(PII_REMASK_META_KEY)).toBe(PII_REMASK_ROWS_DONE);
    } finally {
      s.close();
    }
  });

  it('CONTROL: an unretried pass is unchanged — one entry, committed, rows remasked', () => {
    const s = openStack();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      plantLegacyRow(s);

      const rows = remaskLegacyRows(s.driver, s.journal, s.vault);

      expect(rows.remasked).toBe(1);
      expect(rows.needles).toContain(LEGACY_PII);
      expect(rows.outcome.state).toBe('committed');
      expect(s.driver.allJournal().filter((r) => r.op === 'migrate_masking')).toHaveLength(1);
    } finally {
      s.close();
    }
  });
});
