import fs from 'node:fs';
import { type CheckpointStore, JournalService } from '@sthayi/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileCheckpoint } from '../../packages/cli/src/drivers/checkpoint-file.js';
import { NodeCrypto } from '../../packages/cli/src/drivers/crypto.js';
import { SqliteDriver } from '../../packages/cli/src/drivers/sqlite.js';
import { type FakeHome, createFakeHome } from '../helpers/fake-home.js';

/**
 * SAFETY: a seal reports PARTIAL for a store that is not anchored — never for one that moved on.
 *
 * THE OUTCOME BEING PROTECTED. `seal()` has two halves that cannot be made atomic: the seal entry
 * and the database checkpoint commit transactionally, and the checkpoint file outside the database
 * is a separate write. When the second half does not land, the result is `partial` — a durable
 * database change with nothing off-database vouching for it, further writes blocked, and a nonzero
 * exit that tells the operator to repair the file. That verdict has to keep firing.
 *
 * THE VERDICT IT MUST NOT FIRE ON. The confirmation reads the database checkpoint and the
 * checkpoint file back and compares them, and on a shared store BOTH can move between the mirror
 * and that read: a peer commits its own entry, which advances the database checkpoint past the one
 * this seal minted, and mirrors it as a second step. The comparison then catches the pair
 * mid-advance and calls a perfectly anchored store a failed reseal — reporting a trust decision
 * that DID land as one that did not, and sending the operator to repair a file that is fine.
 *
 * THE INVARIANT. A shortfall is re-tested against what the next write will actually apply: the
 * store is anchored, or it is not. Superseded is not unanchored. Every row below forces the
 * interleaving with a deterministic seam.
 */
describe('safety: a seal that was superseded is not a partial seal', () => {
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

  /**
   * The real FileCheckpoint with a PEER scripted into the window the CONFIRMATION reads.
   *
   * `arm()` before a seal, and the peer commits once the mirror has landed and the post-commit
   * anchor check has already read the file — i.e. after everything that could legitimately advance
   * the anchor has run and found nothing to do, and immediately before the seal reads both copies
   * back to decide whether it is only partial. That is exactly where a real peer's commit lands
   * when it arrives one step behind this one.
   */
  class SupersededCheckpoint implements CheckpointStore {
    private readonly inner: FileCheckpoint;
    private pending = false;
    private due = false;
    fired = 0;
    constructor(
      p: string,
      private readonly peer: () => void,
    ) {
      this.inner = new FileCheckpoint(p);
    }
    arm(): void {
      this.pending = true;
    }
    read(): string | undefined {
      const value = this.inner.read();
      if (this.due) {
        this.due = false;
        this.fired++;
        this.peer();
      }
      return value;
    }
    write(value: string): void {
      this.inner.write(value);
    }
    replace(expected: string | undefined, next: string, opts?: { force?: boolean }): boolean {
      const settled = this.inner.replace(expected, next, opts);
      if (settled && this.pending) {
        this.pending = false;
        this.due = true;
      }
      return settled;
    }
  }

  function openDriver(): SqliteDriver {
    const driver = SqliteDriver.open(dbFile);
    driver.migrate();
    return driver;
  }

  /**
   * A PEER writer on the same store whose own off-database mirror has not run yet: it advances the
   * database checkpoint and leaves the checkpoint file exactly where it is, which is precisely the
   * gap a real peer occupies between its commit and its mirror.
   */
  function peerAppendWithoutMirroring(driver: SqliteDriver, ts: number): void {
    const peer = new JournalService(driver, { crypto });
    peer.append({ ts, actor: 'peer', op: 'memory_write', payload: { ids: [] } });
  }

  it(
    'a peer that advances the store during the reseal does not turn it into a partial seal',
    () => {
      const driver = openDriver();
      try {
        const external = new SupersededCheckpoint(cpFile, () =>
          peerAppendWithoutMirroring(driver, 9),
        );
        const journal = new JournalService(driver, { crypto, external });
        expect(journal.seal('cli', 1).ok).toBe(true);
        journal.append({ ts: 2, actor: 'cli', op: 'memory_write', payload: { ids: [] } });

        const ours = fs.readFileSync(cpFile, 'utf8');
        external.arm();
        const resealed = journal.seal('owner', 3);

        expect(external.fired).toBe(1); // the interleaving really happened
        expect(
          resealed,
          `a superseded seal was reported as partial: ${JSON.stringify(resealed)}`,
        ).toMatchObject({ ok: true });
        expect(resealed.partial).toBeUndefined();
        // the store is anchored at where it now STANDS, which is past the checkpoint we minted
        expect(journal.verify()).toMatchObject({ ok: true, length: 4, state: 'ok' });
        expect(fs.readFileSync(cpFile, 'utf8')).not.toBe(ours);
        expect((JSON.parse(fs.readFileSync(cpFile, 'utf8')) as { count: number }).count).toBe(4);
      } finally {
        driver.close();
      }
    },
    process.platform === 'win32' ? 20_000 : 5_000,
  );

  it('the peer entry is still there afterwards — nothing was rolled back to make the seal green', () => {
    const driver = openDriver();
    try {
      const external = new SupersededCheckpoint(cpFile, () =>
        peerAppendWithoutMirroring(driver, 9),
      );
      const journal = new JournalService(driver, { crypto, external });
      expect(journal.seal('cli', 1).ok).toBe(true);
      external.arm();
      expect(journal.seal('owner', 2).ok).toBe(true);

      const ops = driver.allJournal().map((r) => r.op);
      expect(ops).toEqual(['journal_seal', 'journal_seal', 'memory_write']);
    } finally {
      driver.close();
    }
  });

  it('a seal whose file half genuinely cannot land is STILL partial, and writes stay blocked', () => {
    // A directory at the lock path blocks every write of the checkpoint file — the database half
    // commits and nothing outside it can be made to hold the new checkpoint.
    const driver = openDriver();
    try {
      const journal = new JournalService(driver, {
        crypto,
        external: new FileCheckpoint(cpFile),
        warn: () => {
          // the returned result is the contract these rows assert
        },
      });
      fs.mkdirSync(`${cpFile}.lock`, { recursive: true });
      const sealed = journal.seal('cli', 1);

      expect(sealed.ok).toBe(false);
      expect(sealed.partial).toBe(true);
      expect(sealed.reason).toMatch(/checkpoint file/);
      // the database half IS durable, and the store refuses further writes until it is repaired
      expect(driver.allJournal()).toHaveLength(1);
      expect(fs.existsSync(cpFile)).toBe(false);
      expect(journal.verify().ok).toBe(false);
      expect(() =>
        journal.append({ ts: 2, actor: 'cli', op: 'memory_write', payload: { ids: [] } }),
      ).toThrow(/refusing to append/);
    } finally {
      driver.close();
    }
  });
});
