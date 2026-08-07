import fs from 'node:fs';
import { type CheckpointStore, JournalService, type StorageDriver } from '@sthayi/core';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileCheckpoint } from '../../packages/cli/src/drivers/checkpoint-file.js';
import { NodeCrypto } from '../../packages/cli/src/drivers/crypto.js';
import { SqliteDriver } from '../../packages/cli/src/drivers/sqlite.js';
import { type FakeHome, createFakeHome } from '../helpers/fake-home.js';

/**
 * SAFETY: the state a verification judges must be ONE state — including the moment it steps
 * OUTSIDE the database to read the off-database anchor.
 *
 * THE WINDOW. Verification reads the rows and the database checkpoint, establishes that those two
 * describe the same moment, and only then reads the checkpoint FILE. On a shared store that last
 * read is not instantaneous: a peer holding the same store can commit its own entry — advancing
 * the rows AND the database checkpoint together — and mirror it into the file while the read is in
 * flight. What comes back is then the anchor of a state one entry AHEAD of the rows this pass
 * holds, and judged against them it looks exactly like a store whose journal was TRUNCATED: the
 * file commits to more entries than the database has. The store is at its healthiest — fully
 * anchored, one entry further on — and the verdict accuses it of a snapshot restore.
 *
 * THE INVARIANT. A verdict is only ever reported for rows, database checkpoint and checkpoint file
 * that were read from ONE state. The database checkpoint is therefore re-read AFTER the external
 * read and compared: unchanged means nothing committed for the whole span (rows and checkpoint
 * advance in one transaction), so all three belong together; changed means this pass never had one
 * picture, and the ladder RESTARTS from freshly read rows, checkpoint and file — bounded, never
 * looping on a stale comparison, and never green on a state nobody checked.
 *
 * WHAT MUST STILL BE RED. A skew is only excused when the store really did move under the pass.
 * Genuine truncation, a divergent history, unauthentic bytes, a missing anchor, an unreadable or
 * oversized one, and an anchor REMOVED under an in-progress verification each keep their own
 * verdict, for their own reason. Every interleaving below is FORCED, never raced.
 */
describe('safety: the external read belongs to the same snapshot as the rows', () => {
  let home: FakeHome;
  let dbFile: string;
  let cpFile: string;
  let crypto: NodeCrypto;

  beforeEach(() => {
    home = createFakeHome();
    dbFile = home.path('sthayi.db');
    cpFile = home.path('journal.checkpoint');
    crypto = NodeCrypto.open(home.path('key'));
  });
  afterEach(() => home.cleanup());

  const quiet = (): void => {
    // the verdict, receipt or seal result is the contract in these rows — not the warning text
  };

  /**
   * A PEER writer on the same store, driven directly rather than raced: it commits an entry
   * (rows and database checkpoint together) and mirrors the result only when asked, so each row
   * below can place the peer's two steps exactly where the window it is probing needs them.
   */
  function peerAppend(driver: SqliteDriver, ts: number, mirror: boolean): void {
    const peer = new JournalService(driver, {
      crypto,
      external: mirror ? new FileCheckpoint(cpFile) : undefined,
      warn: quiet,
    });
    peer.append({ ts, actor: 'peer', op: 'memory_write', payload: { ids: [] } });
  }

  /**
   * The real checkpoint file with a scripted peer INSIDE a read: the peer runs first, so the bytes
   * handed back are genuinely the anchor of a state the caller's rows do not yet include. `armed`
   * is one-shot — the restart must be able to read the file for real.
   */
  function racedFile(peer: () => void): {
    store: CheckpointStore;
    arm: () => void;
    fired: () => number;
  } {
    const file = new FileCheckpoint(cpFile);
    let armed = false;
    let fired = 0;
    return {
      store: {
        read: (): string | undefined => {
          if (armed) {
            armed = false;
            fired += 1;
            peer();
          }
          return file.read();
        },
        write: (value: string): void => file.write(value),
        replace: (
          expected: string | undefined,
          next: string,
          opts?: { force?: boolean },
        ): boolean => file.replace(expected, next, opts),
      },
      arm: (): void => {
        armed = true;
      },
      fired: (): number => fired,
    };
  }

  /** A healthy 2-entry store whose anchor is current in both copies. */
  function seed(): SqliteDriver {
    const driver = SqliteDriver.open(dbFile);
    driver.migrate();
    const journal = new JournalService(driver, { crypto, external: new FileCheckpoint(cpFile) });
    expect(journal.seal('test', 1).ok).toBe(true);
    journal.append({ ts: 2, actor: 'cli', op: 'memory_write', payload: { ids: [] } });
    expect(journal.verify()).toMatchObject({ ok: true, length: 2, state: 'ok' });
    return driver;
  }

  const fileCount = (): number =>
    (JSON.parse(fs.readFileSync(cpFile, 'utf8')) as { count: number }).count;

  it('a peer that commits and anchors INSIDE the external read is not a truncation', () => {
    const driver = seed();
    try {
      const raced = racedFile(() => peerAppend(driver, 3, true));
      raced.arm(); // the peer lands in the FIRST external read of the FIRST pass — the window itself
      const journal = new JournalService(driver, { crypto, external: raced.store, warn: quiet });

      const v = journal.verify();
      expect(raced.fired(), 'the interleaving never happened').toBe(1);
      expect(
        v,
        `a healthy peer advance was judged as a verdict: ${JSON.stringify(v)}`,
      ).toMatchObject({ ok: true, state: 'ok' });
      // The restart judged the store as it now STANDS: three entries, anchored in both copies.
      expect(v.length).toBe(3);
      expect(fileCount()).toBe(3);
      expect(driver.allJournal()).toHaveLength(3);
    } finally {
      driver.close();
    }
  });
});
