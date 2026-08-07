import fs from 'node:fs';
import {
  type CheckpointStore,
  JOURNAL_CHECKPOINT_KEY,
  JournalService,
  buildCheckpoint,
} from '@sthayi/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileCheckpoint } from '../../packages/cli/src/drivers/checkpoint-file.js';
import { NodeCrypto } from '../../packages/cli/src/drivers/crypto.js';
import { SqliteDriver } from '../../packages/cli/src/drivers/sqlite.js';
import { type FakeHome, createFakeHome } from '../helpers/fake-home.js';

/**
 * SAFETY: after a heal, the verdict describes the bytes that are ACTUALLY at the checkpoint path.
 *
 * THE HAZARD. `verify()`'s healing arm replaces the checkpoint file and then reads it back. The
 * window between the replace and the read-back is attacker-reachable: whoever can write the home
 * can swap the file in that gap. A diagnosis drawn from the in-memory copy the healer INTENDED to
 * install therefore describes bytes that may no longer be on disk — and the three interesting
 * swaps (a bad-MAC blob, a foreign but authentic checkpoint, and outright removal) would all be
 * flattened into the same benign "authentic … stopped advancing" verdict, which reads as a
 * lagging file rather than as a tamper.
 *
 * THE INVARIANT. The read-back bytes are RETAINED and AUTHENTICATED, and the verdict is
 * classified from them: unauthentic bytes, a foreign authentic checkpoint, and a removed file each
 * report their own shape. Verification stays FAIL-CLOSED throughout — every one of these is red,
 * and the bytes are left untouched because they may be the only evidence of a tamper.
 */
describe('safety: post-heal verification classifies the bytes actually read back', () => {
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
  afterEach(() => {
    home.cleanup();
  });

  const mac = (data: string): string => crypto.mac(data);

  /**
   * A DETERMINISTIC seam: the real FileCheckpoint, with one armed hook that swaps the destination
   * immediately after `replace` returns and before the service reads it back. No timing, no
   * concurrency — the window is opened exactly once, by hand.
   */
  function seam(plant: () => void): CheckpointStore & { arm(): void } {
    const file = new FileCheckpoint(cpFile);
    let armed = false;
    return {
      arm(): void {
        armed = true;
      },
      read: () => file.read(),
      write: (v: string) => file.write(v),
      replace: (
        expected: string | undefined,
        next: string,
        opts?: { force?: boolean },
      ): boolean => {
        const result = file.replace(expected, next, opts);
        if (armed) {
          armed = false;
          plant();
        }
        return result;
      },
    };
  }

  /**
   * A 2-entry store whose checkpoint file has been rolled back to the genuine count-1 prefix — the
   * one state in which `verify()` legitimately heals, i.e. the only state in which the read-back
   * window exists at all.
   */
  function laggingStore(external: CheckpointStore): {
    driver: SqliteDriver;
    journal: JournalService;
    warnings: string[];
  } {
    const driver = SqliteDriver.open(dbFile);
    driver.migrate();
    const warnings: string[] = [];
    const journal = new JournalService(driver, {
      crypto,
      external,
      warn: (m) => warnings.push(m),
    });
    expect(journal.seal('test', 1).ok).toBe(true);
    const prefix = fs.readFileSync(cpFile, 'utf8');
    journal.append({ ts: 2, actor: 'cli', op: 'memory_write', payload: { ids: [] } });
    fs.writeFileSync(cpFile, prefix, { mode: 0o600 }); // an AUTHENTIC lagging prefix
    expect(journal.verify({ heal: false }).ok).toBe(false);
    return { driver, journal, warnings };
  }

  it('BAD MAC swapped in during the heal: reported as unauthentic, never as an authentic prefix', () => {
    const hostile = JSON.stringify({
      v: 1,
      count: 9,
      tipId: 9,
      tipHash: 'f'.repeat(64),
      mac: 'deadbeef',
    });
    const external = seam(() => fs.writeFileSync(cpFile, hostile, { mode: 0o600 }));
    const s = laggingStore(external);
    try {
      external.arm();
      const v = s.journal.verify(); // HEALING
      expect(v.ok, `hostile bytes verified green: ${JSON.stringify(v)}`).toBe(false);
      expect(v.reason).toMatch(/REPLACED between the heal and the read-back/);
      expect(v.reason).toMatch(/NOT an authentic checkpoint under this vault key/);
      // the old, no-longer-true diagnosis must be gone
      expect(v.reason).not.toMatch(/authentic part of this history/);
      expect(v.reason).not.toMatch(/records 1 entr/);
      // left untouched — it may be the only evidence
      expect(fs.readFileSync(cpFile, 'utf8')).toBe(hostile);
      // and it stays red on a second look, healing or not
      expect(s.journal.verify({ heal: false }).ok).toBe(false);
      expect(s.journal.verify().ok).toBe(false);
    } finally {
      s.driver.close();
    }
  });

  it('a DIVERGENT AUTHENTIC checkpoint swapped in during the heal is named for what it is', () => {
    const foreign = buildCheckpoint(mac, 7, 99, 'a'.repeat(64));
    const external = seam(() => fs.writeFileSync(cpFile, foreign, { mode: 0o600 }));
    const s = laggingStore(external);
    try {
      external.arm();
      const v = s.journal.verify();
      expect(v.ok, `a foreign checkpoint verified green: ${JSON.stringify(v)}`).toBe(false);
      expect(v.reason).toMatch(/REPLACED between the heal and the read-back/);
      expect(v.reason).toMatch(/NOT part of this journal's history/);
      // the ACTUAL bytes are described — count 7 ending at #99 — not the pre-heal count-1 prefix
      expect(v.reason).toMatch(/7 entries ending at #99/);
      expect(v.reason).toMatch(/store has 2 ending at #2/);
      expect(v.reason).not.toMatch(/authentic part of this history/);
      expect(fs.readFileSync(cpFile, 'utf8')).toBe(foreign);
      expect(s.journal.verify({ heal: false }).ok).toBe(false);
    } finally {
      s.driver.close();
    }
  });

  it('a MISSING file after the heal is reported as missing, not as a stale prefix', () => {
    const external = seam(() => fs.rmSync(cpFile, { force: true }));
    const s = laggingStore(external);
    try {
      external.arm();
      const v = s.journal.verify();
      expect(v.ok, `an absent anchor verified green: ${JSON.stringify(v)}`).toBe(false);
      expect(v.reason).toMatch(/REMOVED between the heal and the read-back/);
      expect(v.reason).toMatch(/nothing is at the path/);
      expect(v.reason).not.toMatch(/authentic part of this history/);
      expect(v.reason).not.toMatch(/records 1 entr/);
      expect(fs.existsSync(cpFile)).toBe(false);
    } finally {
      s.driver.close();
    }
  });

  it('a DIFFERENT authentic PREFIX of this chain swapped in during the heal is still refused', () => {
    // It parses, it authenticates, and it IS a prefix of this very history — but nothing validated
    // it during this verification and it is not the live copy, so it may not be blessed. The
    // verdict names ITS count and tip, not the pre-heal copy's.
    let atTwo = '';
    const external = seam(() => fs.writeFileSync(cpFile, atTwo, { mode: 0o600 }));
    const driver = SqliteDriver.open(dbFile);
    driver.migrate();
    const journal = new JournalService(driver, { crypto, external, warn: () => {} });
    try {
      expect(journal.seal('test', 1).ok).toBe(true); // row 1
      const atOne = fs.readFileSync(cpFile, 'utf8');
      journal.append({ ts: 2, actor: 'cli', op: 'memory_write', payload: { ids: [] } }); // row 2
      atTwo = fs.readFileSync(cpFile, 'utf8');
      journal.append({ ts: 3, actor: 'cli', op: 'memory_write', payload: { ids: [] } }); // row 3
      fs.writeFileSync(cpFile, atOne, { mode: 0o600 }); // roll the anchor back to count 1

      external.arm();
      const v = journal.verify(); // heals 1 → 3, but the count-2 prefix is swapped in first
      expect(v.ok, `an unvalidated prefix verified green: ${JSON.stringify(v)}`).toBe(false);
      expect(v.reason).toMatch(/REPLACED between the heal and the read-back/);
      expect(v.reason).toMatch(/different authenticated checkpoint of this history/);
      expect(v.reason).toMatch(/2 entries ending at #2/);
      expect(v.reason).toMatch(/store has 3 ending at #3/);
      expect(fs.readFileSync(cpFile, 'utf8')).toBe(atTwo); // left untouched
    } finally {
      driver.close();
    }
  });

  it('CONTROL: an undisturbed heal still succeeds, and the anchor ends byte-equal to meta', () => {
    const external = seam(() => {
      throw new Error('the seam must not fire in the control');
    });
    const s = laggingStore(external);
    try {
      const v = s.journal.verify(); // never armed
      expect(v).toMatchObject({ ok: true, state: 'ok' });
      expect(fs.readFileSync(cpFile, 'utf8')).toBe(s.driver.getMeta(JOURNAL_CHECKPOINT_KEY));
      expect(s.journal.verify({ heal: false })).toMatchObject({ ok: true, state: 'ok' });
    } finally {
      s.driver.close();
    }
  });

  it('CONTROL: a heal that a PEER completes first (the live copy appears) is still green', () => {
    // The one substitution that is strictly better than what the heal was installing: another
    // cooperative writer put the CURRENT live checkpoint there. Read-back equality with meta is
    // what makes it green — not the fact that the bytes changed.
    let live: string | undefined;
    const external = seam(() => {
      fs.writeFileSync(cpFile, live as string, { mode: 0o600 });
    });
    const s = laggingStore(external);
    try {
      live = s.driver.getMeta(JOURNAL_CHECKPOINT_KEY) as string;
      external.arm();
      expect(s.journal.verify()).toMatchObject({ ok: true, state: 'ok' });
      expect(fs.readFileSync(cpFile, 'utf8')).toBe(live);
    } finally {
      s.driver.close();
    }
  });
});
