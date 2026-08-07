import { JOURNAL_CHECKPOINT_KEY, JournalService, VaultService } from '@sthayi/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileCheckpoint } from '../../packages/cli/src/drivers/checkpoint-file.js';
import { NodeCrypto } from '../../packages/cli/src/drivers/crypto.js';
import { SqliteDriver } from '../../packages/cli/src/drivers/sqlite.js';
import { type FakeHome, createFakeHome } from '../helpers/fake-home.js';
import { removeOwned } from '../helpers/owned-fs.js';

/**
 * SAFETY: A SEAL REPORTS ONLY THE ATTEMPT THAT COMMITTED.
 *
 * THE HAZARD. `seal()` runs inside `writeTransaction`, which `SqliteDriver.runOutermost` retries
 * whole on SQLITE_BUSY. State held OUTSIDE that callback survives an attempt's rollback. The flag
 * saying "this process appended" is set on the line AFTER the append, so an append-time failure
 * never reaches it — the reachable case is a COMMIT-EDGE failure, where the body runs to its last
 * line and `run.immediate()` raises on the commit. Attempt 2 then takes the `onlyIfMissing` early
 * return, which exists precisely to tolerate another process sealing in between, and inherits the
 * stale flag: it forces an external mirror and reports a PARTIAL SEAL FAILURE — "the database was
 * resealed but the file is absent" — for work this process never performed.
 *
 * This is the first-run initialization path (`cli/src/store.ts` seals with `onlyIfMissing`), so the
 * cost of the stale flag is a healthy store reported as degraded, with the distinct do-not-retry
 * exit code, because a peer won a race.
 *
 * THE INVARIANT. Per-attempt state is minted INSIDE the attempt. A seal that appended nothing
 * mirrors nothing and claims nothing.
 */

let home: FakeHome;
let cpFile: string;

beforeEach(() => {
  home = createFakeHome();
  cpFile = home.path('journal.checkpoint');
});
afterEach(() => {
  vi.restoreAllMocks();
  removeOwned(`${cpFile}.lock`);
  home.cleanup();
});

function openStack() {
  const driver = SqliteDriver.open(home.path('sthayi.db'));
  driver.migrate();
  const crypto = NodeCrypto.open(home.path('key'));
  const vault = new VaultService(driver, crypto, { now: () => 1 });
  const journal = new JournalService(driver, {
    crypto,
    external: new FileCheckpoint(cpFile),
    masker: vault,
    warn: () => {},
  });
  return { driver, journal, close: (): void => driver.close() };
}

/**
 * Fail the FIRST attempt at its COMMIT, the way a contended writer does: the body runs to
 * completion inside a real transaction, that transaction is rolled back, and the code the driver
 * retries on is raised. Anything the body set outside itself survives; anything it wrote does not.
 */
function failFirstCommit(
  driver: SqliteDriver,
  onRolledBack: () => void,
): { attempts: () => number } {
  const db = (driver as unknown as { db: Record<string, (...a: unknown[]) => unknown> }).db;
  const realTransaction = (db.transaction as (f: unknown) => unknown).bind(db);
  let attempts = 0;
  db.transaction = ((fn: (...a: unknown[]) => unknown) => {
    const real = realTransaction(fn) as { immediate: (...a: unknown[]) => unknown };
    const wrapper = ((...a: unknown[]) =>
      (real as unknown as (...x: unknown[]) => unknown)(...a)) as {
      (...a: unknown[]): unknown;
      immediate: (...a: unknown[]) => unknown;
    };
    wrapper.immediate = (...a: unknown[]): unknown => {
      attempts += 1;
      if (attempts === 1) {
        (db.exec as (s: string) => unknown)('BEGIN IMMEDIATE');
        try {
          fn();
        } finally {
          (db.exec as (s: string) => unknown)('ROLLBACK');
        }
        onRolledBack();
        const err = new Error('injected SQLITE_BUSY at commit') as Error & { code: string };
        err.code = 'SQLITE_BUSY';
        throw err;
      }
      return real.immediate(...a);
    };
    return wrapper;
  }) as (...a: unknown[]) => unknown;
  return { attempts: (): number => attempts };
}

describe('safety: a retried seal reports only the attempt that committed', () => {
  it('a seal whose attempt rolled back at commit, then found a peer had sealed, claims nothing', () => {
    const s = openStack();
    try {
      // The peer's checkpoint becomes visible only AFTER this process aborted its first attempt —
      // if it were visible earlier, attempt 1 would take the early return and never set the flag.
      let peerSealed = false;
      const injected = failFirstCommit(s.driver, () => {
        peerSealed = true;
      });

      const realGetMeta = s.driver.getMeta.bind(s.driver);
      vi.spyOn(s.driver, 'getMeta').mockImplementation((key: string) => {
        if (key === JOURNAL_CHECKPOINT_KEY && peerSealed) {
          return 'peer-checkpoint';
        }
        return realGetMeta(key);
      });

      const mirror = vi.spyOn(
        s.journal as unknown as { mirrorExternal: (f: boolean) => unknown },
        'mirrorExternal',
      );

      const result = s.journal.seal('test', 1_000, { onlyIfMissing: true });

      expect(injected.attempts()).toBe(2); // one rolled-back attempt, then the early return
      // Nothing was appended by THIS process, so there is nothing to mirror and nothing to report.
      expect(mirror).not.toHaveBeenCalled();
      expect(result).toEqual({ ok: true });
    } finally {
      s.close();
    }
  });

  it('CONTROL — a first seal with no contention still seals, mirrors, and verifies', () => {
    const s = openStack();
    try {
      const result = s.journal.seal('test', 1_000, { onlyIfMissing: true });
      expect(result.ok).toBe(true);
      expect(result.entries).toBe(1);
      expect(s.journal.verify({ heal: false }).ok).toBe(true);
    } finally {
      s.close();
    }
  });

  it('CONTROL — a peer that already sealed, with no retry, is still a quiet success', () => {
    const s = openStack();
    try {
      expect(s.journal.seal('first', 1_000, { onlyIfMissing: true }).ok).toBe(true);
      const mirror = vi.spyOn(
        s.journal as unknown as { mirrorExternal: (f: boolean) => unknown },
        'mirrorExternal',
      );
      const again = s.journal.seal('second', 1_001, { onlyIfMissing: true });
      expect(again).toEqual({ ok: true });
      expect(mirror).not.toHaveBeenCalled();
    } finally {
      s.close();
    }
  });
});
