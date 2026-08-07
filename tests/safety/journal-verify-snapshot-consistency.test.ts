import fs from 'node:fs';
import { JournalService, type StorageDriver } from '@sthayi/core';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileCheckpoint } from '../../packages/cli/src/drivers/checkpoint-file.js';
import { NodeCrypto } from '../../packages/cli/src/drivers/crypto.js';
import { SqliteDriver } from '../../packages/cli/src/drivers/sqlite.js';
import { type FakeHome, createFakeHome } from '../helpers/fake-home.js';

/**
 * SAFETY: a verification verdict describes ONE state of the store, or it is not a verdict.
 *
 * WHAT CAN SKEW. Verification reads three things — the journal rows, the checkpoint inside the
 * database, and the checkpoint file outside it — and on a shared store all three can move while it
 * is reading them. The rows and the database checkpoint advance in ONE transaction, so a peer's
 * commit landing between those two reads leaves a pair that never coexisted: rows from before,
 * checkpoint from after. Judged as if it were one state, that pair reads exactly like a store
 * whose journal was TRUNCATED — the checkpoint commits to more entries than the rows hold — and
 * the verdict is a fabricated snapshot-restore accusation against a store nothing is wrong with.
 * The same skew reaches the heal: a peer that commits and mirrors while the file is being advanced
 * leaves the destination holding the store's NEW checkpoint, which the read-back sees as bytes
 * neither installed nor authenticated by this verification.
 *
 * THE INVARIANT. Neither skew produces a verdict. Each is detected — the checkpoint is re-read and
 * compared across the row read, and the post-heal bytes are compared against the checkpoint the
 * database holds right then — and the ladder is RESTARTED from freshly read state, bounded. Green
 * still requires one complete, authenticated, internally consistent, current picture; every
 * genuinely broken state below still earns its own red verdict. The interleavings are FORCED here,
 * never raced.
 */
describe('safety: verification restarts rather than judging a skewed read', () => {
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
   * A PEER writer on the same store: it commits an entry — advancing the rows AND the database
   * checkpoint together — and mirrors the result only when asked, which is what lets each row below
   * place the peer's two steps exactly where it needs them.
   */
  function peerAppend(driver: SqliteDriver, ts: number, mirror: boolean): void {
    const peer = new JournalService(driver, {
      crypto,
      external: mirror ? new FileCheckpoint(cpFile) : undefined,
      warn: () => {
        // the peer's own reporting is not what these rows assert
      },
    });
    peer.append({ ts, actor: 'peer', op: 'memory_write', payload: { ids: [] } });
  }

  /**
   * The real driver with a scripted peer INSIDE the row read: `allJournal()` returns the rows as
   * they stood, and the peer commits immediately afterwards — so the checkpoint read next belongs
   * to a state one entry ahead of those rows. That is precisely the skew, made deterministic.
   */
  function skewedDriver(inner: SqliteDriver, peer: () => void): StorageDriver {
    let armed = true;
    return new Proxy(inner, {
      get(target: SqliteDriver, prop: string | symbol): unknown {
        if (prop === 'allJournal') {
          return (): unknown => {
            const rows = target.allJournal();
            if (armed) {
              armed = false;
              peer();
            }
            return rows;
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as unknown as StorageDriver;
  }

  /** A healthy 2-entry store whose anchor is current. */
  function seed(): SqliteDriver {
    const driver = SqliteDriver.open(dbFile);
    driver.migrate();
    const journal = new JournalService(driver, { crypto, external: new FileCheckpoint(cpFile) });
    expect(journal.seal('test', 1).ok).toBe(true);
    journal.append({ ts: 2, actor: 'cli', op: 'memory_write', payload: { ids: [] } });
    expect(journal.verify()).toMatchObject({ ok: true, length: 2, state: 'ok' });
    return driver;
  }

  it('a peer committing between the row read and the checkpoint read is not a truncation', () => {
    const driver = seed();
    try {
      const skewed = skewedDriver(driver, () => peerAppend(driver, 3, true));
      const journal = new JournalService(skewed, {
        crypto,
        external: new FileCheckpoint(cpFile),
        warn: () => {
          // the verdict is the contract here
        },
      });

      const v = journal.verify();
      expect(v, `a skewed read produced a verdict: ${JSON.stringify(v)}`).toMatchObject({
        ok: true,
        state: 'ok',
      });
      // the restart judged the store as it now STANDS — three entries, anchored
      expect(v.length).toBe(3);
      expect((JSON.parse(fs.readFileSync(cpFile, 'utf8')) as { count: number }).count).toBe(3);
    } finally {
      driver.close();
    }
  });

  it('a genuine truncation is still a truncation — the restart does not launder it', () => {
    // The checkpoint commits to two entries; the store now holds one. No peer, no movement — just
    // a store that lost a row, which is the shape the skew above imitates and must never excuse.
    seed().close();
    const raw = new Database(dbFile);
    raw.prepare('DELETE FROM journal WHERE id=(SELECT MAX(id) FROM journal)').run();
    raw.close();

    const driver = SqliteDriver.open(dbFile);
    try {
      const journal = new JournalService(driver, {
        crypto,
        external: new FileCheckpoint(cpFile),
        warn: () => {
          // the verdict is the contract here
        },
      });
      const v = journal.verify();
      expect(v.ok).toBe(false);
      expect(v.reason).toMatch(/truncated or restored from a different snapshot/);
    } finally {
      driver.close();
    }
  });

  it('a peer that anchors the store during the heal leaves it verified, not "replaced"', () => {
    const driver = SqliteDriver.open(dbFile);
    try {
      driver.migrate();
      const file = new FileCheckpoint(cpFile);
      const journal = new JournalService(driver, {
        crypto,
        external: file,
        warn: () => {
          // the verdict is the contract here
        },
      });
      expect(journal.seal('test', 1).ok).toBe(true);
      const atOne = fs.readFileSync(cpFile, 'utf8');
      journal.append({ ts: 2, actor: 'cli', op: 'memory_write', payload: { ids: [] } });
      fs.writeFileSync(cpFile, atOne, { mode: 0o600 }); // an authentic lagging prefix: a heal is due

      // The peer commits AND mirrors inside the window between our replacement and its read-back,
      // so what we read back is the store's brand-new checkpoint — the anchor at its most current,
      // and the one thing a "replaced anchor" verdict must never be reported for.
      let armed = true;
      const raced = {
        read: (): string | undefined => file.read(),
        write: (v: string): void => file.write(v),
        replace: (expected: string | undefined, next: string, opts?: { force?: boolean }) => {
          const settled = file.replace(expected, next, opts);
          if (settled && armed) {
            armed = false;
            peerAppend(driver, 3, true);
          }
          return settled;
        },
      };
      const healer = new JournalService(driver, {
        crypto,
        external: raced,
        warn: () => {
          // the verdict is the contract here
        },
      });

      const v = healer.verify();
      expect(armed).toBe(false); // the interleaving really happened
      expect(v, `a peer's fresh anchor was read as tampering: ${JSON.stringify(v)}`).toMatchObject({
        ok: true,
        length: 3,
        state: 'ok',
      });
      expect((JSON.parse(fs.readFileSync(cpFile, 'utf8')) as { count: number }).count).toBe(3);
    } finally {
      driver.close();
    }
  });
});
