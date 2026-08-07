import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type Memory, SCHEMA_VERSION_KEY, latestVersion, newId, sealEntry } from '@sthayi/core';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runTempDir } from '../../../../tests/helpers/run-temp.js';
import { SqliteDriver, setReadOnlySnapshotCapForTests } from './sqlite.js';

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  const now = 1_700_000_000_000;
  return {
    id: newId(),
    type: 'semantic',
    scope: 'user',
    content: 'Alex prefers pnpm and vitest for the widget CLI',
    provenance: { source: 'cli' },
    confidence: 0.7,
    boosts: 0,
    status: 'proposed',
    source: 'cli',
    createdAt: now,
    updatedAt: now,
    lastRetrievedAt: null,
    decayAt: null,
    ...overrides,
  };
}

describe('SqliteDriver', () => {
  let driver: SqliteDriver;
  beforeEach(() => {
    driver = SqliteDriver.openMemory();
    driver.migrate();
  });
  afterEach(() => driver.close());

  it('applies migrations and stamps schema_version', () => {
    expect(driver.getMeta(SCHEMA_VERSION_KEY)).toBe(String(latestVersion()));
  });

  it('is idempotent when migrate runs again', () => {
    expect(() => driver.migrate()).not.toThrow();
    expect(driver.getMeta(SCHEMA_VERSION_KEY)).toBe(String(latestVersion()));
  });

  it('round-trips a memory through insert/get', () => {
    const m = makeMemory();
    driver.insertMemory(m);
    const got = driver.getMemory(m.id);
    expect(got).toEqual(m);
  });

  it('updates a subset of columns', () => {
    const m = makeMemory();
    driver.insertMemory(m);
    driver.updateMemory(m.id, { status: 'confirmed', boosts: 2, updatedAt: m.updatedAt + 5 });
    const got = driver.getMemory(m.id);
    expect(got?.status).toBe('confirmed');
    expect(got?.boosts).toBe(2);
    expect(got?.content).toBe(m.content);
  });

  it('lists and counts with filters', () => {
    driver.insertMemory(makeMemory({ status: 'proposed', type: 'semantic' }));
    driver.insertMemory(makeMemory({ status: 'confirmed', type: 'episodic' }));
    driver.insertMemory(makeMemory({ status: 'confirmed', type: 'semantic' }));
    expect(driver.countMemories()).toBe(3);
    expect(driver.countMemories({ status: 'confirmed' })).toBe(2);
    expect(driver.listMemories({ type: 'semantic' })).toHaveLength(2);
  });

  it('deletes a memory', () => {
    const m = makeMemory();
    driver.insertMemory(m);
    driver.deleteMemory(m.id);
    expect(driver.getMemory(m.id)).toBeUndefined();
  });

  it('appends journal entries and reports the tip hash + ordering', () => {
    const a = sealEntry({ ts: 1, actor: 'cli', op: 'a', payload: { n: 1 } }, null);
    const first = driver.appendJournal(a);
    const b = sealEntry({ ts: 2, actor: 'cli', op: 'b', payload: { n: 2 } }, first.hash);
    const second = driver.appendJournal(b);

    expect(first.id).toBe(1);
    expect(second.id).toBe(2);
    expect(driver.lastJournalHash()).toBe(second.hash);

    const all = driver.allJournal();
    expect(all.map((r) => r.id)).toEqual([1, 2]);
    expect(all[0]?.payload).toEqual({ n: 1 });

    const recent = driver.recentJournal(1);
    expect(recent).toHaveLength(1);
    expect(recent[0]?.id).toBe(2);
  });
});

/**
 * INVARIANT: a nested `transaction()` is a SAVEPOINT, and its queued callbacks share ITS fate.
 *
 * A savepoint can unwind while the transaction hosting it goes on to commit, so the callbacks
 * queued inside one describe rows that may already be gone by the time the host commits. Held in a
 * single connection-global queue they would be drained by that commit regardless — running an
 * after-commit effect for discarded rows, and reporting a COMMITTED settlement for a mutation the
 * database threw away. Each frame therefore settles on its own edge: a released savepoint hands its
 * callbacks to the parent frame, and a rolled-back one discards its after-commit half and settles
 * the rest with `false` at the unwind.
 *
 * (tests/safety/journal-savepoint-settlement.test.ts holds the same property end to end, through
 * the journal's receipts and the off-database anchor.)
 */
describe('SqliteDriver — savepoint-scoped callback frames', () => {
  let driver: SqliteDriver;
  beforeEach(() => {
    driver = SqliteDriver.openMemory();
    driver.migrate();
  });
  afterEach(() => driver.close());

  /** Run `fn` as a savepoint and swallow the unwind, as a degrading caller does. */
  function caught(fn: () => void): void {
    try {
      driver.transaction(fn);
    } catch {
      // the host catches its nested failure and carries on — the point of a savepoint
    }
  }

  it('a released savepoint hands its callbacks to the host, in queued order, run once', () => {
    const ran: string[] = [];
    const edges: boolean[] = [];
    driver.writeTransaction(() => {
      driver.afterCommit(() => ran.push('host-before'));
      driver.transaction(() => {
        driver.afterCommit(() => ran.push('savepoint'));
        driver.onSettle((committed) => edges.push(committed));
      });
      expect(ran).toEqual([]); // a released savepoint settles nothing on its own
      expect(edges).toEqual([]);
      driver.afterCommit(() => ran.push('host-after'));
    });
    expect(ran).toEqual(['host-before', 'savepoint', 'host-after']);
    expect(edges).toEqual([true]);
  });

  it('a rolled-back savepoint discards its after-commit half and settles the rest with false', () => {
    const ran: string[] = [];
    const edges: string[] = [];
    driver.writeTransaction(() => {
      driver.afterCommit(() => ran.push('host'));
      driver.onSettle((committed) => edges.push(`host:${committed}`));
      caught(() => {
        driver.afterCommit(() => ran.push('discarded'));
        driver.onSettle((committed) => edges.push(`savepoint:${committed}`));
        driver.setMeta('savepoint', 'written');
        throw new Error('inner aborted');
      });
      // reported AT THE UNWIND — the moment those rows died
      expect(edges).toEqual(['savepoint:false']);
      expect(ran).toEqual([]);
      expect(driver.getMeta('savepoint')).toBeUndefined(); // the write went with it
      driver.setMeta('host', 'written');
    });
    expect(ran).toEqual(['host']); // the discarded callback never runs, on either edge
    expect(edges).toEqual(['savepoint:false', 'host:true']);
    expect(driver.getMeta('host')).toBe('written'); // the host committed regardless
  });

  it('nesting settles innermost-first: each level answers for its own frame', () => {
    const edges: string[] = [];
    driver.writeTransaction(() => {
      driver.onSettle((c) => edges.push(`host:${c}`));
      driver.transaction(() => {
        driver.onSettle((c) => edges.push(`middle:${c}`));
        caught(() => {
          driver.onSettle((c) => edges.push(`inner:${c}`));
          throw new Error('innermost aborted');
        });
        expect(edges).toEqual(['inner:false']);
      });
      // the middle savepoint RELEASED, so its callback is the host's now
      expect(edges).toEqual(['inner:false']);
    });
    expect(edges).toEqual(['inner:false', 'host:true', 'middle:true']);
  });

  it('a HOST rollback discards the callbacks a released savepoint handed it', () => {
    const ran: string[] = [];
    const edges: boolean[] = [];
    expect(() =>
      driver.writeTransaction(() => {
        driver.transaction(() => {
          driver.afterCommit(() => ran.push('released'));
          driver.onSettle((committed) => edges.push(committed));
        });
        throw new Error('host aborted');
      }),
    ).toThrow('host aborted');
    expect(ran).toEqual([]);
    expect(edges).toEqual([false]);
  });

  it('no savepoint callback escapes into a later transaction, on either edge', () => {
    const ran: string[] = [];
    driver.writeTransaction(() => {
      caught(() => {
        driver.afterCommit(() => ran.push('discarded'));
        throw new Error('inner aborted');
      });
      driver.transaction(() => {
        driver.afterCommit(() => ran.push('released'));
      });
    });
    expect(ran).toEqual(['released']);

    driver.writeTransaction(() => {
      driver.afterCommit(() => ran.push('later'));
    });
    expect(ran).toEqual(['released', 'later']);

    // and with no transaction open a callback runs immediately rather than joining a queue
    driver.afterCommit(() => ran.push('top-level'));
    expect(ran).toEqual(['released', 'later', 'top-level']);
    driver.writeTransaction(() => {
      driver.setMeta('probe', 'v1');
    });
    expect(ran).toEqual(['released', 'later', 'top-level']);
  });

  it('a savepoint is the SAME outermost transaction: one identity, one settlement', () => {
    const edges: boolean[] = [];
    const ids: (number | undefined)[] = [];
    driver.writeTransaction(() => {
      driver.onSettle((committed) => edges.push(committed));
      ids.push(driver.transactionId());
      caught(() => {
        ids.push(driver.transactionId());
        throw new Error('inner aborted');
      });
      driver.transaction(() => ids.push(driver.transactionId()));
      ids.push(driver.transactionId());
    });
    expect(edges).toEqual([true]); // exactly one settlement for the whole nest
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBeTypeOf('number');
    expect(driver.transactionId()).toBeUndefined(); // retired the instant it settles
  });
});

/**
 * INVARIANT: a BUSY `BEGIN IMMEDIATE` is retried, and each attempt is a WHOLE transaction —
 * its own identity, its own settlement, its own callback queue.
 *
 * The outermost writer opens with BEGIN IMMEDIATE, so a peer process holding the write lock makes
 * the begin itself fail before the body runs at all. The loop retries a bounded number of times,
 * and a retried attempt is a SETTLED attempt: it rolled back, so its callbacks are discarded and
 * its identity retired before the next attempt mints one. An attempt that inherited the previous
 * one's queue would run callbacks belonging to a transaction that never committed, and a reused
 * identity would let a caller-visible token minted under one attempt validate under another.
 *
 * (tests/safety/journal-commit-edge-settlement.test.ts holds the same property end to end, through
 * the journal's receipts and the off-database anchor.)
 */
describe('SqliteDriver — the retried BEGIN', () => {
  it('a contended BEGIN never runs the body, retries a bounded number of times, and writes nothing', () => {
    const dir = runTempDir('sthayi-busy-begin-');
    const file = path.join(dir, 'busy.db');
    const driver = SqliteDriver.open(file);
    try {
      driver.migrate();
      // Lowered from the 5s production busy_timeout purely for test speed — the outcome the loop
      // sees is identical, a SQLITE_BUSY out of the begin.
      (Reflect.get(driver, 'db') as Database.Database).pragma('busy_timeout = 20');
      let before: number | undefined;
      driver.writeTransaction(() => {
        before = driver.transactionId();
      });

      // A REAL second connection holding the write lock for the whole attempt window.
      const holder = new Database(file);
      holder.pragma('busy_timeout = 0');
      holder.exec('BEGIN IMMEDIATE');
      let bodies = 0;
      let contention: unknown;
      try {
        driver.writeTransaction(() => {
          bodies++;
          driver.setMeta('probe', 'v1');
        });
      } catch (err) {
        contention = err;
      } finally {
        holder.exec('ROLLBACK');
        holder.close();
      }

      // the begin itself failed: the body never ran, and nothing it would have written exists
      expect(bodies).toBe(0);
      expect(contention).toBeInstanceOf(Error);
      expect((contention as { code?: string }).code).toMatch(/^SQLITE_BUSY/);
      expect(driver.getMeta('probe')).toBeUndefined();
      expect(driver.transactionId()).toBeUndefined(); // retired even on the giving-up edge

      // THREE ATTEMPTS WERE SPENT, EACH MINTING AN IDENTITY OF ITS OWN. The counter is monotonic
      // and never rewound, so the gap the next successful transaction opens up is the count of
      // attempts the loop made — a reused identity would leave that gap short.
      let after: number | undefined;
      driver.writeTransaction(() => {
        after = driver.transactionId();
      });
      expect((after ?? 0) - (before ?? 0)).toBe(4);
      expect(driver.getMeta('probe')).toBeUndefined();
    } finally {
      driver.close();
    }
  });

  it('each retried attempt settles rolled-back, and no callback escapes into a later attempt', () => {
    const driver = SqliteDriver.openMemory();
    try {
      driver.migrate();
      /** The code a contended begin reports, out of the same call the body's failures come out of. */
      class BusyBegin extends Error {
        readonly code = 'SQLITE_BUSY';
      }
      const ran: string[] = [];
      const edges: string[] = [];
      const ids: (number | undefined)[] = [];
      let attempts = 0;

      const result = driver.writeTransaction(() => {
        const attempt = ++attempts;
        ids.push(driver.transactionId());
        driver.setMeta(`attempt-${attempt}`, 'written');
        driver.afterCommit(() => ran.push(`after:${attempt}`));
        driver.onSettle((committed) => edges.push(`settle:${attempt}:${committed}`));
        if (attempt < 3) {
          throw new BusyBegin('database is locked');
        }
        return attempt;
      });

      expect(result).toBe(3);
      expect(new Set(ids).size).toBe(3); // a fresh identity per attempt, never reused
      expect(ids.every((id) => typeof id === 'number')).toBe(true);
      expect([...ids].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(ids);
      // each attempt answered for itself, exactly once, on its own edge
      expect(edges).toEqual(['settle:1:false', 'settle:2:false', 'settle:3:true']);
      expect(ran).toEqual(['after:3']); // no abandoned attempt's work runs, in either attempt
      // and the abandoned attempts' writes went with them
      expect(driver.getMeta('attempt-1')).toBeUndefined();
      expect(driver.getMeta('attempt-2')).toBeUndefined();
      expect(driver.getMeta('attempt-3')).toBe('written');
      expect(driver.transactionId()).toBeUndefined();
    } finally {
      driver.close();
    }
  });
});

/**
 * INVARIANT: in openReadOnly's snapshot branch the fstat size is a fast-fail HINT, never the
 * bound. The cap is enforced by the read loop itself (limit+1 sentinel through the same
 * descriptor), so a file that grows after the stat is refused instead of copied into memory
 * whole — which is what an UNBOUNDED fs.readFileSync(fd) behind a size check would do.
 *
 * The cap is lowered through the documented test-only seam so the race is exercised against a
 * few KiB instead of allocating 512 MiB (the real-cap oversize case is covered, sparsely, by
 * tests/safety/file-trust.test.ts).
 */
describe.skipIf(process.platform === 'win32')(
  'SqliteDriver.openReadOnly — the snapshot cap is enforced at the DESCRIPTOR, not the fstat',
  () => {
    let dir: string;
    let file: string;

    beforeEach(() => {
      dir = runTempDir('sthayi-rocap-');
      file = path.join(dir, 'sthayi.db');
      const d = SqliteDriver.open(file);
      d.migrate();
      d.setMeta('probe', 'v1');
      d.close();
      // the snapshot branch only runs with no sidecars present (the cleanly-checkpointed case)
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    });

    afterEach(() => {
      setReadOnlySnapshotCapForTests(undefined);
      vi.restoreAllMocks();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('an honestly oversized file is refused by the fstat fast-fail, before any read', () => {
      const size = fs.statSync(file).size;
      expect(size).toBeGreaterThan(4096); // the seam below is genuinely smaller than the file
      setReadOnlySnapshotCapForTests(4096);
      expect(() => SqliteDriver.openReadOnly(file)).toThrow(/snapshot cap/);
    });

    it('a file at EXACTLY the cap is still accepted (the +1 sentinel is a ceiling, not an off-by-one)', () => {
      setReadOnlySnapshotCapForTests(fs.statSync(file).size);
      const ro = SqliteDriver.openReadOnly(file);
      try {
        expect(ro.getMeta('probe')).toBe('v1');
      } finally {
        ro.close();
      }
    });

    it('growth AFTER the fstat is refused, and no more than cap+1 bytes are ever requested', () => {
      const cap = 4096;
      setReadOnlySnapshotCapForTests(cap);
      // The fstat under-reports — exactly what a file that grows right after the stat looks
      // like. Trusting it and then reading to EOF is what the capped loop exists to prevent.
      const realFstat = fs.fstatSync.bind(fs);
      vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number) => {
        const st = realFstat(fd);
        Object.defineProperty(st, 'size', { value: cap });
        return st;
      }) as typeof fs.fstatSync);

      let requested = 0;
      const realRead = fs.readSync.bind(fs);
      vi.spyOn(fs, 'readSync').mockImplementation(((
        fd: number,
        buffer: NodeJS.ArrayBufferView,
        offset: number,
        length: number,
        position: number | null,
      ) => {
        requested += length;
        return realRead(fd, buffer, offset, length, position);
      }) as unknown as typeof fs.readSync);

      expect(() => SqliteDriver.openReadOnly(file)).toThrow(/grew while being read/);
      // the retention proof: the loop never asks for more than the +1 sentinel in total
      expect(requested).toBeLessThanOrEqual(cap + 1);
    });
  },
);
