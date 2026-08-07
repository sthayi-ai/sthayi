import fs from 'node:fs';
import { type CheckpointStore, JournalService, committedReceipts } from '@sthayi/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileCheckpoint } from '../../packages/cli/src/drivers/checkpoint-file.js';
import { NodeCrypto } from '../../packages/cli/src/drivers/crypto.js';
import { SqliteDriver } from '../../packages/cli/src/drivers/sqlite.js';
import { type FakeHome, createFakeHome } from '../helpers/fake-home.js';

/**
 * SAFETY: a HEALTHY PEER moving the store forward is not a degraded outcome, on any surface that
 * reports one.
 *
 * THE HAZARD. Commit and anchor are two stores, so a write that committed re-reads the checkpoint
 * file to confirm the anchor followed. On a shared store that read-back can catch a peer
 * mid-advance, and the honest re-test for that — re-verify, exactly as the next write would — is
 * itself not instantaneous: the peer can commit AND mirror again inside the re-verification's own
 * external read. Judged against rows read a moment earlier, the file then commits to MORE entries
 * than the database has, which reads as TRUNCATION. The two verdicts that ride on that re-test
 * would then be wrong in the most expensive direction: an append receipted as
 * committed-but-UNANCHORED (writes blocked, do not retry) and a reseal reported as PARTIAL — a
 * durable trust decision rendered as a failure — about a store that is fully anchored and one
 * entry further on.
 *
 * THE INVARIANT. The re-test is a verification, and a verification only ever reports a verdict for
 * rows, database checkpoint and checkpoint file read from ONE state; a store that moved underneath
 * it restarts the ladder instead of producing a verdict. So a peer advance — however it is
 * interleaved — leaves the receipt ANCHORED and the reseal COMPLETE, and 'unanchored'/'partial'
 * keep meaning what they say: nothing outside the database vouches for this store.
 *
 * Every interleaving below is FORCED, never raced: the peer is driven from inside the external
 * read itself, at the exact call site being probed.
 */
describe('safety: a peer advance is not a degraded commit or a partial reseal', () => {
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
    // the receipt and the seal result are the contract in these rows — not the warning text
  };

  /** A PEER writer on the same store: it commits an entry AND mirrors it, as a real peer does. */
  function peerAppend(driver: SqliteDriver, ts: number): void {
    const peer = new JournalService(driver, {
      crypto,
      external: new FileCheckpoint(cpFile),
      warn: quiet,
    });
    peer.append({ ts, actor: 'peer', op: 'memory_write', payload: { ids: [] } });
  }

  /**
   * The real checkpoint file that runs a scripted peer INSIDE a read, at a NAMED call site.
   *
   * A trigger fires when every frame it names is on the stack of the read in flight, and it fires
   * ONCE — the restart must be able to read the file for real. Naming the site rather than counting
   * reads is what keeps each row below pinned to the window it claims to probe: a trigger that no
   * longer matches never fires, and `fired` (asserted in every row) says so.
   */
  function racedFile(triggers: { frames: string[]; peer: () => void }[]): {
    store: CheckpointStore;
    fired: () => number;
  } {
    const file = new FileCheckpoint(cpFile);
    const spent = new Set<number>();
    return {
      store: {
        read: (): string | undefined => {
          const stack = new Error().stack ?? '';
          for (const [i, t] of triggers.entries()) {
            if (!spent.has(i) && t.frames.every((f) => stack.includes(f))) {
              spent.add(i);
              t.peer();
              break;
            }
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
      fired: (): number => spent.size,
    };
  }

  /** A healthy 1-entry store whose anchor is current in both copies. */
  function seed(): SqliteDriver {
    const driver = SqliteDriver.open(dbFile);
    driver.migrate();
    const journal = new JournalService(driver, { crypto, external: new FileCheckpoint(cpFile) });
    expect(journal.seal('test', 1).ok).toBe(true);
    expect(journal.verify()).toMatchObject({ ok: true, length: 1, state: 'ok' });
    return driver;
  }

  const fileCount = (): number =>
    (JSON.parse(fs.readFileSync(cpFile, 'utf8')) as { count: number }).count;

  it('a peer advance inside the post-commit re-check is not a committed-but-unanchored receipt', () => {
    const driver = seed();
    try {
      // (1) the post-commit READ-BACK catches a peer mid-advance — the shortfall that sends the
      //     classification to its honest re-test; (2) the RE-TEST's own external read catches the
      //     next one — the window this row exists for.
      const raced = racedFile([
        { frames: ['externalShortfall'], peer: () => peerAppend(driver, 3) },
        { frames: ['verifyPass', 'classifyAnchor'], peer: () => peerAppend(driver, 4) },
      ]);
      const journal = new JournalService(driver, { crypto, external: raced.store, warn: quiet });

      const written = journal.append({
        ts: 2,
        actor: 'cli',
        op: 'memory_write',
        payload: { ids: [] },
      });
      expect(raced.fired(), 'the interleaving never happened').toBe(2);
      expect(written.outcome.state).toBe('committed');
      const receipt = committedReceipts([written.outcome])[0];
      expect(
        receipt?.anchor,
        `a healthy peer advance was receipted as degraded: ${receipt?.reason}`,
      ).toBe('anchored');
      // The three facts a degraded receipt promises must NOT be asserted about a healthy store.
      expect(receipt?.writesBlocked).toBe(false);
      expect(receipt?.doNotRetry).toBe(false);
      expect(receipt?.reason).toBeUndefined();
      // The store the receipt vouches for: this write plus both peers, anchored in both copies.
      expect(driver.allJournal()).toHaveLength(4);
      expect(fileCount()).toBe(4);
      expect(journal.verify()).toMatchObject({ ok: true, length: 4, state: 'ok' });
    } finally {
      driver.close();
    }
  });

  it('a peer advance inside the post-reseal re-check is not a partial reseal', () => {
    const driver = seed();
    try {
      const raced = racedFile([
        { frames: ['confirmExternalSealed'], peer: () => peerAppend(driver, 3) },
        { frames: ['verifyPass', 'JournalService.seal'], peer: () => peerAppend(driver, 4) },
      ]);
      const journal = new JournalService(driver, { crypto, external: raced.store, warn: quiet });

      const result = journal.seal('test', 2);
      expect(raced.fired(), 'the interleaving never happened').toBe(2);
      expect(result.ok, `a healthy peer advance was reported as: ${result.reason}`).toBe(true);
      // `partial` is the durable-trust-decision-reported-as-failure outcome — it must stay unset.
      expect(result.partial).toBeUndefined();
      expect(result.reason).toBeUndefined();
      expect(driver.allJournal()).toHaveLength(4);
      expect(fileCount()).toBe(4);
      expect(journal.verify()).toMatchObject({ ok: true, length: 4, state: 'ok' });
    } finally {
      driver.close();
    }
  });
});
