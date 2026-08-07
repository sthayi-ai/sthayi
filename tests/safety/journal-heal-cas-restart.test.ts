import fs from 'node:fs';
import { type CheckpointStore, JournalService, buildCheckpoint } from '@sthayi/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileCheckpoint } from '../../packages/cli/src/drivers/checkpoint-file.js';
import { NodeCrypto } from '../../packages/cli/src/drivers/crypto.js';
import { SqliteDriver } from '../../packages/cli/src/drivers/sqlite.js';
import { type FakeHome, createFakeHome } from '../helpers/fake-home.js';

/**
 * SAFETY: a compare-and-swap conflict during a heal is re-evaluated, never rubber-stamped.
 *
 * WHAT A CONFLICT ACTUALLY SAYS. The healing arm of `verify()` reads the checkpoint file,
 * authenticates it, walks the ladder against it, and only then replaces it — passing those exact
 * bytes as the expectation, so a destination that changed in between is left BYTE-IDENTICAL and
 * the swap is refused. The refusal establishes ONE fact: the bytes the ladder judged are no longer
 * the bytes at the path. It says nothing whatsoever about what IS there now.
 *
 * WHY THAT MATTERS IN BOTH DIRECTIONS. On a shared store, cooperative writers produce conflicts as
 * a matter of course — a peer commits and mirrors as two steps, so its mirror lands inside another
 * process's heal — and answering RED there turns ordinary concurrency into refused writes on a
 * perfectly healthy store. Answering GREEN there would be far worse: it would vouch for bytes
 * nobody authenticated, which is exactly how a swapped-in anchor gets blessed.
 *
 * THE INVARIANT. A conflict causes a BOUNDED RESTART of the whole ladder from freshly read state —
 * new rows, new database checkpoint, new checkpoint file — and the verdict is whatever THAT state
 * earns. Green requires a complete, authenticated, internally consistent, current snapshot.
 * Unauthentic, divergent, non-ancestor, removed and unreadable destinations each stay RED for
 * their own reason, and a destination that will not hold still exhausts the budget and stays RED
 * too. Every row below drives the window with a deterministic seam, never with timing.
 */
describe('safety: a heal that loses the compare-and-swap restarts from fresh state', () => {
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

  const mac = (data: string): string => crypto.mac(data);

  /**
   * The real FileCheckpoint with a SCRIPTED PEER around the compare-and-swap. `before` runs in the
   * window between the ladder's read and the replacement (which is what produces a conflict at
   * all); `after` runs once a replacement has actually CONFLICTED, i.e. in the window the restart
   * is about to read. The replacement itself is the REAL one, so every conflict here is genuine —
   * the store re-reads under its own lock, finds bytes that are not the expectation, writes
   * nothing, and reports false.
   */
  class RacedCheckpoint implements CheckpointStore {
    private readonly inner: FileCheckpoint;
    /** every replacement attempt, so the restart budget can be pinned */
    attempts = 0;
    constructor(
      p: string,
      private readonly before: (() => void)[],
      private readonly after: (() => void)[] = [],
    ) {
      this.inner = new FileCheckpoint(p);
    }
    read(): string | undefined {
      return this.inner.read();
    }
    write(value: string): void {
      this.inner.write(value);
    }
    replace(expected: string | undefined, next: string, opts?: { force?: boolean }): boolean {
      this.attempts++;
      this.before.shift()?.();
      const settled = this.inner.replace(expected, next, opts);
      if (!settled) {
        this.after.shift()?.();
      }
      return settled;
    }
  }

  /** A peer putting exactly these bytes at the checkpoint path. */
  const put =
    (raw: string): (() => void) =>
    () => {
      fs.writeFileSync(cpFile, raw, { mode: 0o600 });
    };
  /** A peer removing the checkpoint file outright. */
  const remove = (): (() => void) => () => {
    fs.rmSync(cpFile, { force: true });
  };

  interface Stack {
    driver: SqliteDriver;
    journal: JournalService;
    close(): void;
  }

  function open(external: CheckpointStore): Stack {
    const driver = SqliteDriver.open(dbFile);
    driver.migrate();
    const journal = new JournalService(driver, {
      crypto,
      external,
      warn: () => {
        // the verdict is what these rows assert; warnings are not the contract
      },
    });
    return { driver, journal, close: () => driver.close() };
  }

  /** Seal + three appends → a healthy 4-entry store, returning the authentic checkpoint bytes for
   *  every prefix along the way (index 1 = the 1-entry ancestor, …, index 4 = the live copy). */
  function seed(): string[] {
    const s = open(new FileCheckpoint(cpFile));
    const byCount: string[] = [];
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      byCount[1] = fs.readFileSync(cpFile, 'utf8');
      for (const ts of [2, 3, 4]) {
        s.journal.append({ ts, actor: 'cli', op: 'memory_write', payload: { ids: [] } });
        byCount[ts] = fs.readFileSync(cpFile, 'utf8');
      }
      expect(s.journal.verify()).toMatchObject({ ok: true, length: 4, state: 'ok' });
    } finally {
      s.close();
    }
    return byCount;
  }

  /** Roll the file back to a legitimately lagging authentic ancestor, so a heal is due. */
  function lagTo(raw: string): void {
    fs.writeFileSync(cpFile, raw, { mode: 0o600 });
  }

  /** An authentic checkpoint of a history this store is NOT in (same key, foreign tip). */
  function divergent(count: number): string {
    return buildCheckpoint(mac, count, 900 + count, 'a'.repeat(64));
  }

  // -----------------------------------------------------------------------------------------
  // The cooperative case: the restart is what keeps a healthy shared store green
  // -----------------------------------------------------------------------------------------

  it('a peer that advanced the file part-way: the restart heals from there and verifies', () => {
    const cp = seed();
    lagTo(cp[1] as string);

    // The peer installs the 2-entry ancestor inside our heal of the 1-entry one → conflict.
    const racer = new RacedCheckpoint(cpFile, [put(cp[2] as string)]);
    const s = open(racer);
    try {
      const v = s.journal.verify();
      expect(v, `a cooperative conflict must not be a verdict: ${JSON.stringify(v)}`).toMatchObject(
        {
          ok: true,
          length: 4,
          state: 'ok',
        },
      );
      // green ONLY because the second pass judged the bytes actually there and then anchored them
      expect(racer.attempts).toBe(2);
      expect(fs.readFileSync(cpFile, 'utf8')).toBe(cp[4]);
    } finally {
      s.close();
    }
  });

  it('the restart is bounded: a destination that never holds still stays RED, bytes intact', () => {
    const cp = seed();
    lagTo(cp[1] as string);

    // A different authentic ancestor on every attempt — each pass conflicts.
    const racer = new RacedCheckpoint(cpFile, [
      put(cp[2] as string),
      put(cp[3] as string),
      put(cp[1] as string),
    ]);
    const s = open(racer);
    try {
      const v = s.journal.verify();
      expect(v.ok).toBe(false);
      expect(v.reason).toMatch(/changed between the read that authenticated it and the heal/);
      expect(racer.attempts).toBe(3);
      // nothing this verification ran was ever written out
      expect(fs.readFileSync(cpFile, 'utf8')).toBe(cp[1]);
    } finally {
      s.close();
    }
  });

  // -----------------------------------------------------------------------------------------
  // Everything the restart must NOT bless — each still red for its OWN reason
  // -----------------------------------------------------------------------------------------

  const INVALID_JSON = '{"v":1,"count":9,"tipId":9,"tipHash":"deadbeef","mac":';
  const BAD_MAC = JSON.stringify({
    v: 1,
    count: 9,
    tipId: 9,
    tipHash: 'f'.repeat(64),
    mac: 'not-a-mac-this-key-ever-produced',
  });

  for (const [label, hostile, reason] of [
    ['unparseable bytes', INVALID_JSON, /tampered or vault key changed/],
    ['a bad-MAC blob', BAD_MAC, /tampered or vault key changed/],
  ] as const) {
    it(`a conflict that reveals ${label}: RED as tamper, and the bytes survive`, () => {
      const cp = seed();
      lagTo(cp[1] as string);
      const racer = new RacedCheckpoint(cpFile, [put(hostile)]);
      const s = open(racer);
      try {
        const v = s.journal.verify();
        expect(v.ok, `verify went green over ${label}: ${JSON.stringify(v)}`).toBe(false);
        expect(v.reason).toMatch(reason);
        expect(fs.readFileSync(cpFile, 'utf8')).toBe(hostile);
      } finally {
        s.close();
      }
    });
  }

  it('a conflict that reveals a DIVERGENT authentic checkpoint: RED, and the evidence survives', () => {
    const cp = seed();
    lagTo(cp[1] as string);
    const foreign = divergent(3);
    const racer = new RacedCheckpoint(cpFile, [put(foreign)]);
    const s = open(racer);
    try {
      const v = s.journal.verify();
      expect(v.ok).toBe(false);
      expect(v.reason).toMatch(/does not match this journal's history/);
      expect(fs.readFileSync(cpFile, 'utf8')).toBe(foreign);
    } finally {
      s.close();
    }
  });

  it('a conflict that reveals a NON-ANCESTOR ahead of the store: RED as truncation evidence', () => {
    const cp = seed();
    lagTo(cp[1] as string);
    const ahead = divergent(9); // more entries than this store holds
    const racer = new RacedCheckpoint(cpFile, [put(ahead)]);
    const s = open(racer);
    try {
      const v = s.journal.verify();
      expect(v.ok).toBe(false);
      expect(v.reason).toMatch(/truncated or restored from an older snapshot/);
      expect(fs.readFileSync(cpFile, 'utf8')).toBe(ahead);
    } finally {
      s.close();
    }
  });

  it('a conflict that reveals a REMOVED anchor: RED — the restart never re-creates it', () => {
    const cp = seed();
    lagTo(cp[1] as string);
    const racer = new RacedCheckpoint(cpFile, [remove()]);
    const s = open(racer);
    try {
      const v = s.journal.verify();
      expect(v.ok, `verify re-created an anchor removed under it: ${JSON.stringify(v)}`).toBe(
        false,
      );
      expect(v.reason).toMatch(/disappeared while it was being verified/);
      expect(fs.existsSync(cpFile)).toBe(false);
    } finally {
      s.close();
    }
  });

  it('a conflict that reveals an UNREADABLE anchor: RED, and the file is left alone', () => {
    const cp = seed();
    lagTo(cp[1] as string);
    // The conflict is caused by an authentic ancestor; what the RESTART then finds is a checkpoint
    // file this store refuses to read at all (over the size cap).
    const oversized = 'x'.repeat(70 * 1024);
    const racer = new RacedCheckpoint(cpFile, [put(cp[2] as string)], [put(oversized)]);
    const s = open(racer);
    try {
      const v = s.journal.verify();
      expect(v.ok).toBe(false);
      expect(v.reason).toMatch(/checkpoint file unreadable/);
      expect(fs.statSync(cpFile).size).toBe(70 * 1024);
    } finally {
      s.close();
    }
  });

  // -----------------------------------------------------------------------------------------
  // The append gate runs the same ladder, and its stricter rule survives the restart
  // -----------------------------------------------------------------------------------------

  it('the append gate still refuses to CREATE an anchor a conflict removed', () => {
    const cp = seed();
    lagTo(cp[1] as string);
    const racer = new RacedCheckpoint(cpFile, [remove()]);
    const s = open(racer);
    try {
      expect(() =>
        s.journal.append({ ts: 5, actor: 'cli', op: 'memory_write', payload: { ids: [] } }),
      ).toThrow(/refusing to append/);
      expect(fs.existsSync(cpFile)).toBe(false);
      expect(s.driver.allJournal()).toHaveLength(4); // the refusal wrote nothing
    } finally {
      s.close();
    }
  });

  it('an append whose gate hits a cooperative conflict still lands, and stays anchored', () => {
    const cp = seed();
    lagTo(cp[1] as string);
    const racer = new RacedCheckpoint(cpFile, [put(cp[2] as string)]);
    const s = open(racer);
    try {
      s.journal.append({ ts: 5, actor: 'cli', op: 'memory_write', payload: { ids: [] } });
      expect(s.driver.allJournal()).toHaveLength(5);
      expect(s.journal.verify()).toMatchObject({ ok: true, length: 5, state: 'ok' });
      expect((JSON.parse(fs.readFileSync(cpFile, 'utf8')) as { count: number }).count).toBe(5);
    } finally {
      s.close();
    }
  });
});
