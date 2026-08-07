import fs from 'node:fs';
import {
  JOURNAL_CHECKPOINT_KEY,
  type JournalRecord,
  JournalService,
  computeHash,
} from '@sthayi/core';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileCheckpoint } from '../../packages/cli/src/drivers/checkpoint-file.js';
import { NodeCrypto } from '../../packages/cli/src/drivers/crypto.js';
import { SqliteDriver } from '../../packages/cli/src/drivers/sqlite.js';
import { openStore } from '../../packages/cli/src/store.js';
import { type FakeHome, createFakeHome } from '../helpers/fake-home.js';

/**
 * SAFETY TEST 3 (spec §7): journal hash-chain verify + tamper detection, end-to-end on the real
 * better-sqlite3 driver. Editing a persisted payload out-of-band must be detected by verify().
 */
describe('safety: journal hash chain', () => {
  let home: FakeHome;
  let file: string;

  beforeEach(() => {
    home = createFakeHome();
    file = home.path('sthayi.db');
  });
  afterEach(() => home.cleanup());

  it('verifies a chain written through the real driver', () => {
    const driver = SqliteDriver.open(file);
    driver.migrate();
    const journal = new JournalService(driver);
    journal.append({ ts: 1, actor: 'cli', op: 'memory_write', payload: { id: 'm1' } });
    journal.append({
      ts: 2,
      actor: 'mcp:claude-desktop',
      op: 'memory_retrieve',
      payload: { id: 'm1' },
    });
    journal.append({ ts: 3, actor: 'cli', op: 'consolidate', payload: { batch: 'b1' } });
    const result = journal.verify();
    expect(result.ok).toBe(true);
    expect(result.length).toBe(3);
    driver.close();
  });

  it('detects out-of-band tampering of a persisted payload', () => {
    const driver = SqliteDriver.open(file);
    driver.migrate();
    const journal = new JournalService(driver);
    journal.append({ ts: 1, actor: 'cli', op: 'memory_write', payload: { secret: 'keep' } });
    journal.append({ ts: 2, actor: 'cli', op: 'memory_write', payload: { n: 2 } });
    driver.close();

    // Tamper directly in the SQLite file, leaving the stored hash untouched.
    const raw = new Database(file);
    raw
      .prepare('UPDATE journal SET payload = ? WHERE id = 1')
      .run(JSON.stringify({ secret: 'leaked' }));
    raw.close();

    const reopened = SqliteDriver.open(file);
    const result = new JournalService(reopened).verify();
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(1);
    expect(result.reason).toMatch(/tampered/);
    reopened.close();
  });

  // Hash-what-you-persist invariant: undefined-valued keys and toJSON objects (Date) survive the SQLite
  // JSON round-trip and still verify — the hash commits to exactly what was persisted.
  it('payloads with undefined keys and Dates round-trip through the real driver and verify ok', () => {
    const driver = SqliteDriver.open(file);
    driver.migrate();
    const journal = new JournalService(driver);
    journal.append({ ts: 1, actor: 'cli', op: 'memory_write', payload: { a: undefined, b: 1 } });
    journal.append({
      ts: 2,
      actor: 'cli',
      op: 'memory_write',
      payload: { d: new Date('2026-01-02T03:04:05.000Z') },
    });
    driver.close();

    const reopened = SqliteDriver.open(file);
    const result = new JournalService(reopened).verify();
    expect(result.ok).toBe(true);
    expect(result.length).toBe(2);
    const rows = reopened.allJournal();
    expect(rows[0]?.payload).toEqual({ b: 1 });
    expect(rows[1]?.payload).toEqual({ d: '2026-01-02T03:04:05.000Z' });
    reopened.close();
  });

  it('detects a deleted middle entry', () => {
    const driver = SqliteDriver.open(file);
    driver.migrate();
    const journal = new JournalService(driver);
    journal.append({ ts: 1, actor: 'cli', op: 'a' });
    journal.append({ ts: 2, actor: 'cli', op: 'b' });
    journal.append({ ts: 3, actor: 'cli', op: 'c' });
    driver.close();

    const raw = new Database(file);
    raw.prepare('DELETE FROM journal WHERE id = 2').run();
    raw.close();

    const reopened = SqliteDriver.open(file);
    const result = new JournalService(reopened).verify();
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(3);
    reopened.close();
  });
});

/**
 * An authenticated checkpoint (keyed MAC from the vault key, stored in meta AND in a
 * file outside the db) makes verification detect what the unkeyed chain alone cannot: suffix
 * deletion, full replacement, renumbering, rewritten-and-rehashed history, and restore of an
 * older internally-valid snapshot — while distinguishing a pristine store from erased history.
 */
describe('safety: journal authenticated checkpoint', () => {
  let home: FakeHome;
  let file: string;

  beforeEach(() => {
    home = createFakeHome();
    file = home.path('sthayi.db');
  });
  afterEach(() => home.cleanup());

  /** JournalService wired the way openStore wires it: crypto + external checkpoint file. */
  function openJournal(): { driver: SqliteDriver; journal: JournalService } {
    const driver = SqliteDriver.open(file);
    driver.migrate();
    const journal = new JournalService(driver, {
      crypto: NodeCrypto.open(home.path('key')),
      external: new FileCheckpoint(home.path('journal.checkpoint')),
    });
    return { driver, journal };
  }

  /** Seed a sealed 4-entry journal (seal entry + three appends) and close the connection. */
  function seed(): void {
    const { driver, journal } = openJournal();
    expect(journal.seal('test', 1).ok).toBe(true);
    journal.append({ ts: 2, actor: 'cli', op: 'memory_write', payload: { id: 'm1' } });
    journal.append({ ts: 3, actor: 'cli', op: 'memory_write', payload: { id: 'm2' } });
    journal.append({ ts: 4, actor: 'cli', op: 'consolidate', payload: { batch: 'b1' } });
    expect(journal.verify()).toMatchObject({ ok: true, length: 4, state: 'ok' });
    driver.close();
  }

  function rawSql(sql: string): void {
    const raw = new Database(file);
    raw.prepare(sql).run();
    raw.close();
  }

  it('a pristine never-initialized store verifies with state "pristine"', () => {
    const { driver, journal } = openJournal();
    expect(journal.verify()).toEqual({ ok: true, length: 0, state: 'pristine' });
    driver.close();
  });

  it('without MAC-capable crypto, verify reports state "checkpoint-disabled"', () => {
    const driver = SqliteDriver.open(file);
    driver.migrate();
    const journal = new JournalService(driver);
    journal.append({ ts: 1, actor: 'cli', op: 'a' });
    expect(journal.verify()).toMatchObject({ ok: true, length: 1, state: 'checkpoint-disabled' });
    driver.close();
  });

  it('detects deletion of the final row', () => {
    seed();
    rawSql('DELETE FROM journal WHERE id=(SELECT MAX(id) FROM journal)');
    const { driver, journal } = openJournal();
    const r = journal.verify();
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/truncated or restored/);
    driver.close();
  });

  it('detects deletion of the final N rows', () => {
    seed();
    rawSql('DELETE FROM journal WHERE id > 1');
    const { driver, journal } = openJournal();
    expect(journal.verify().ok).toBe(false);
    driver.close();
  });

  it('detects deletion of EVERY row (erased history is not a pristine store)', () => {
    seed();
    rawSql('DELETE FROM journal');
    const { driver, journal } = openJournal();
    const r = journal.verify();
    expect(r.ok).toBe(false);
    expect(r.state).toBeUndefined();
    expect(r.reason).toMatch(/truncated or restored/);
    driver.close();
  });

  it('detects erased history even when the meta checkpoint is erased too (external anchors it)', () => {
    seed();
    rawSql('DELETE FROM journal');
    rawSql(`DELETE FROM meta WHERE k='${JOURNAL_CHECKPOINT_KEY}'`);
    const { driver, journal } = openJournal();
    const r = journal.verify();
    expect(r.ok).toBe(false);
    expect(r.state).not.toBe('pristine');
    driver.close();
  });

  it('rows without any checkpoint fail with reseal guidance (pre-checkpoint store)', () => {
    seed();
    rawSql(`DELETE FROM meta WHERE k='${JOURNAL_CHECKPOINT_KEY}'`);
    fs.rmSync(home.path('journal.checkpoint'));
    const { driver, journal } = openJournal();
    const r = journal.verify();
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/journal reseal/);
    driver.close();
  });

  it('detects renumbered rows', () => {
    seed();
    rawSql('UPDATE journal SET id = id + 10');
    const { driver, journal } = openJournal();
    expect(journal.verify().ok).toBe(false);
    driver.close();
  });

  it('detects reordered rows (ids swapped between two entries)', () => {
    seed();
    const raw = new Database(file);
    raw.prepare('UPDATE journal SET id = 99 WHERE id = 3').run();
    raw.prepare('UPDATE journal SET id = 3 WHERE id = 4').run();
    raw.prepare('UPDATE journal SET id = 4 WHERE id = 99').run();
    raw.close();
    const { driver, journal } = openJournal();
    expect(journal.verify().ok).toBe(false);
    driver.close();
  });

  it('detects fully rewritten history even when every unkeyed hash is recomputed', () => {
    seed();
    // The attacker rewrites history from genesis and recomputes every hash — the chain itself
    // verifies, but the keyed checkpoint (which they cannot forge) does not match the new tip.
    const forged = [
      { ts: 100, actor: 'attacker', op: 'memory_write', payload: { id: 'evil1' } },
      { ts: 101, actor: 'attacker', op: 'memory_write', payload: { id: 'evil2' } },
    ];
    const raw = new Database(file);
    raw.prepare('DELETE FROM journal').run();
    let prev: string | null = null;
    let id = 1;
    for (const draft of forged) {
      const hash: string = computeHash(draft, prev);
      raw
        .prepare(
          'INSERT INTO journal (id, ts, actor, op, payload, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(id, draft.ts, draft.actor, draft.op, JSON.stringify(draft.payload), prev, hash);
      prev = hash;
      id++;
    }
    raw.close();
    const { driver, journal } = openJournal();
    const r = journal.verify();
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/truncated or restored/);
    driver.close();
  });

  it('detects restore of an older, internally-valid db snapshot; reseal explicitly accepts it', () => {
    // Build 2 entries, snapshot the db bytes, append 2 more, then restore the snapshot.
    {
      const { driver, journal } = openJournal();
      expect(journal.seal('test', 1).ok).toBe(true);
      journal.append({ ts: 2, actor: 'cli', op: 'memory_write', payload: { id: 'm1' } });
      driver.close();
    }
    const snapshot = fs.readFileSync(file);
    {
      const { driver, journal } = openJournal();
      journal.append({ ts: 3, actor: 'cli', op: 'memory_write', payload: { id: 'm2' } });
      journal.append({ ts: 4, actor: 'cli', op: 'memory_write', payload: { id: 'm3' } });
      expect(journal.verify().ok).toBe(true);
      driver.close();
    }
    fs.rmSync(`${file}-wal`, { force: true });
    fs.rmSync(`${file}-shm`, { force: true });
    fs.writeFileSync(file, snapshot);

    {
      const { driver, journal } = openJournal();
      const r = journal.verify();
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/truncated or restored/);
      expect(r.reason).toMatch(/journal reseal/);
      // the intentional-restore escape hatch: reseal accepts the restored history…
      expect(journal.seal('cli', 5).ok).toBe(true);
      expect(journal.verify()).toMatchObject({ ok: true, state: 'ok' });
      driver.close();
    }
  });

  it('detects a tampered meta checkpoint and a tampered external checkpoint', () => {
    seed();
    // meta tampered (count inflated, MAC now wrong)
    {
      const raw = new Database(file);
      const row = raw.prepare('SELECT v FROM meta WHERE k = ?').get(JOURNAL_CHECKPOINT_KEY) as {
        v: string;
      };
      const cp = JSON.parse(row.v) as { count: number };
      cp.count = 999;
      raw
        .prepare('UPDATE meta SET v = ? WHERE k = ?')
        .run(JSON.stringify(cp), JOURNAL_CHECKPOINT_KEY);
      raw.close();
      const { driver, journal } = openJournal();
      const r = journal.verify();
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/tampered or vault key changed/);
      driver.close();
    }
    // heal meta back via reseal, then tamper the external file
    {
      const { driver, journal } = openJournal();
      expect(journal.seal('cli', 9).ok).toBe(true);
      driver.close();
    }
    const cpFile = home.path('journal.checkpoint');
    const ext = JSON.parse(fs.readFileSync(cpFile, 'utf8')) as { mac: string };
    ext.mac = (ext.mac.startsWith('0') ? '1' : '0') + ext.mac.slice(1);
    fs.writeFileSync(cpFile, JSON.stringify(ext));
    {
      const { driver, journal } = openJournal();
      const r = journal.verify();
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/tampered or vault key changed/);
      driver.close();
    }
  });

  it('a vault-key change fails verification until an explicit reseal', () => {
    seed();
    fs.writeFileSync(home.path('key'), Buffer.alloc(32, 7), { mode: 0o600 });
    const { driver, journal } = openJournal();
    const r = journal.verify();
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/tampered or vault key changed/);
    expect(journal.seal('cli', 9).ok).toBe(true);
    expect(journal.verify()).toMatchObject({ ok: true, state: 'ok' });
    driver.close();
  });

  it('heals a deleted external checkpoint file on verify', () => {
    seed();
    const cpFile = home.path('journal.checkpoint');
    fs.rmSync(cpFile);
    const { driver, journal } = openJournal();
    expect(journal.verify()).toMatchObject({ ok: true, state: 'ok' });
    expect(fs.existsSync(cpFile)).toBe(true);
    driver.close();
  });

  it('heals a lagging external checkpoint whose tip is an ancestor of the chain', () => {
    // Capture the external file early, append more, then restore the OLD external file.
    const cpFile = home.path('journal.checkpoint');
    {
      const { driver, journal } = openJournal();
      expect(journal.seal('test', 1).ok).toBe(true);
      journal.append({ ts: 2, actor: 'cli', op: 'a' });
      driver.close();
    }
    const oldExternal = fs.readFileSync(cpFile, 'utf8');
    {
      const { driver, journal } = openJournal();
      journal.append({ ts: 3, actor: 'cli', op: 'b' });
      driver.close();
    }
    fs.writeFileSync(cpFile, oldExternal);
    const { driver, journal } = openJournal();
    expect(journal.verify()).toMatchObject({ ok: true, state: 'ok' });
    // healed: the file now matches the live tip again
    const healed = fs.readFileSync(cpFile, 'utf8');
    expect(healed).not.toBe(oldExternal);
    expect(journal.verify()).toMatchObject({ ok: true, state: 'ok' });
    driver.close();
  });

  it('an external checkpoint from a DIFFERENT history (swapped store) fails', () => {
    seed();
    const cpFile = home.path('journal.checkpoint');
    // Mint a checkpoint for a divergent one-entry chain with the SAME key, lower count — its tip
    // is not an ancestor of the real chain, so it must fail (not silently heal).
    const other = createFakeHome();
    try {
      const otherFile = other.path('sthayi.db');
      const driver2 = SqliteDriver.open(otherFile);
      driver2.migrate();
      const otherJournal = new JournalService(driver2, {
        crypto: NodeCrypto.open(home.path('key')), // same key — MAC verifies
        external: new FileCheckpoint(other.path('journal.checkpoint')),
      });
      otherJournal.append({ ts: 99, actor: 'other', op: 'x' });
      driver2.close();
      fs.copyFileSync(other.path('journal.checkpoint'), cpFile);
    } finally {
      other.cleanup();
    }
    const { driver, journal } = openJournal();
    const r = journal.verify();
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/does not match this journal's history/);
    driver.close();
  });

  it('openStore TOFU-seals a store exactly once and verifies with state "ok"', () => {
    {
      const store = openStore();
      try {
        expect(store.journal.verify()).toMatchObject({ ok: true, state: 'ok' });
        const seals = store.driver.allJournal().filter((r) => r.op === 'journal_seal');
        expect(seals).toHaveLength(1);
        expect(seals[0]?.actor).toBe('migrate');
      } finally {
        store.close();
      }
    }
    // reopening does NOT reseal
    const store = openStore();
    try {
      expect(store.driver.allJournal().filter((r) => r.op === 'journal_seal')).toHaveLength(1);
      expect(fs.existsSync(home.path('journal.checkpoint'))).toBe(true);
    } finally {
      store.close();
    }
  });
});

/**
 * Checkpoint × concurrent-append composition: tamper-then-APPEND-then-verify. Tampering and
 * verifying alone does not exercise the dangerous path — an append that rebuilt the checkpoint
 * from the current rows and mirrored it over the external file would launder a truncation or
 * snapshot restore on the very next innocent write. An append must NEVER re-bless unverified history —
 * only the explicit seal()/`journal reseal` may — and the external file must keep the
 * higher-count evidence. The deferred external flush must also actually RUN in steady state
 * (every service append sits inside a writeTransaction — afterCommit drains it).
 */
describe('safety: journal checkpoints survive tamper → append → verify (no laundering)', () => {
  let home: FakeHome;
  let file: string;

  beforeEach(() => {
    home = createFakeHome();
    file = home.path('sthayi.db');
  });
  afterEach(() => home.cleanup());

  function openJournal(): { driver: SqliteDriver; journal: JournalService } {
    const driver = SqliteDriver.open(file);
    driver.migrate();
    const journal = new JournalService(driver, {
      crypto: NodeCrypto.open(home.path('key')),
      external: new FileCheckpoint(home.path('journal.checkpoint')),
    });
    return { driver, journal };
  }

  /** Seed a sealed 4-entry journal (seal entry + three appends) and close the connection. */
  function seed(): void {
    const { driver, journal } = openJournal();
    expect(journal.seal('test', 1).ok).toBe(true);
    journal.append({ ts: 2, actor: 'cli', op: 'memory_write', payload: { id: 'm1' } });
    journal.append({ ts: 3, actor: 'cli', op: 'memory_write', payload: { id: 'm2' } });
    journal.append({ ts: 4, actor: 'cli', op: 'consolidate', payload: { batch: 'b1' } });
    expect(journal.verify()).toMatchObject({ ok: true, length: 4, state: 'ok' });
    driver.close();
  }

  function rawSql(sql: string): void {
    const raw = new Database(file);
    raw.prepare(sql).run();
    raw.close();
  }

  function externalCount(): number {
    return (
      JSON.parse(fs.readFileSync(home.path('journal.checkpoint'), 'utf8')) as {
        count: number;
      }
    ).count;
  }

  it('a truncated journal REFUSES the next innocent append (fail closed, nothing laundered)', () => {
    seed();
    rawSql('DELETE FROM journal WHERE id > 2');
    const { driver, journal } = openJournal();
    // the exact real-world trigger: the MCP server journals a memory_retrieve on first use —
    // the append gate refuses it outright rather than writing atop unverified history
    expect(() =>
      journal.append({
        ts: 9,
        actor: 'mcp:claude-desktop',
        op: 'memory_retrieve',
        payload: { q: 'x' },
      }),
    ).toThrow(/refusing to append.*truncated or restored/s);
    expect(driver.allJournal()).toHaveLength(2); // the refused append left no row
    const r = journal.verify();
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/truncated or restored/);
    // the external file still holds the pre-tamper higher count — the surviving evidence
    expect(externalCount()).toBe(4);
    driver.close();
  });

  it('truncation with the meta checkpoint erased too REFUSES an append', () => {
    seed();
    rawSql('DELETE FROM journal WHERE id > 2');
    rawSql(`DELETE FROM meta WHERE k='${JOURNAL_CHECKPOINT_KEY}'`);
    const { driver, journal } = openJournal();
    expect(() =>
      journal.append({ ts: 9, actor: 'cli', op: 'memory_write', payload: { id: 'mX' } }),
    ).toThrow(/refusing to append/);
    // no implicit re-mint: rows exist without a checkpoint → verify fails via the external copy
    const r = journal.verify();
    expect(r.ok).toBe(false);
    expect(driver.allJournal()).toHaveLength(2);
    expect(externalCount()).toBe(4);
    driver.close();
  });

  it('a whole-db older-snapshot restore is NOT laundered by the next append', () => {
    {
      const { driver, journal } = openJournal();
      expect(journal.seal('test', 1).ok).toBe(true);
      journal.append({ ts: 2, actor: 'cli', op: 'memory_write', payload: { id: 'm1' } });
      driver.close();
    }
    const snapshot = fs.readFileSync(file);
    {
      const { driver, journal } = openJournal();
      journal.append({ ts: 3, actor: 'cli', op: 'memory_write', payload: { id: 'm2' } });
      journal.append({ ts: 4, actor: 'cli', op: 'memory_write', payload: { id: 'm3' } });
      expect(journal.verify().ok).toBe(true);
      driver.close();
    }
    fs.rmSync(`${file}-wal`, { force: true });
    fs.rmSync(`${file}-shm`, { force: true });
    fs.writeFileSync(file, snapshot);

    const { driver, journal } = openJournal();
    // one innocent append on the restored snapshot — its own meta checkpoint matches its tip,
    // but the external copy records the LONGER pre-restore history: the append gate's full
    // ladder sees the mismatch and refuses before anything is written
    expect(() =>
      journal.append({ ts: 9, actor: 'cli', op: 'memory_write', payload: { id: 'mX' } }),
    ).toThrow(/refusing to append.*truncated or restored/s);
    const r = journal.verify();
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/truncated or restored/);
    expect(externalCount()).toBe(4);
    // …and reseal remains the explicit escape hatch — after it, ordinary appends work again
    expect(journal.seal('cli', 10).ok).toBe(true);
    journal.append({ ts: 11, actor: 'cli', op: 'memory_write', payload: { id: 'mY' } });
    expect(journal.verify()).toMatchObject({ ok: true, state: 'ok' });
    driver.close();
  });

  it('erased-to-empty store with a surviving external checkpoint: openStore does NOT auto-seal (TOFU is first-use only)', () => {
    {
      const store = openStore();
      try {
        store.memory.add(
          { type: 'semantic', content: 'a fact worth keeping' },
          { now: 1, asProposal: false },
        );
      } finally {
        store.close();
      }
    }
    // out-of-band erase: journal rows AND meta checkpoint gone; the external file survives
    rawSql('DELETE FROM journal');
    rawSql(`DELETE FROM meta WHERE k='${JOURNAL_CHECKPOINT_KEY}'`);
    const externalBefore = fs.readFileSync(home.path('journal.checkpoint'), 'utf8');

    const store = openStore();
    try {
      // no TOFU seal happened: no seal entry, no checkpoint minted, external untouched
      expect(store.driver.allJournal()).toHaveLength(0);
      expect(store.driver.getMeta(JOURNAL_CHECKPOINT_KEY)).toBeUndefined();
      expect(fs.readFileSync(home.path('journal.checkpoint'), 'utf8')).toBe(externalBefore);
      expect(store.journal.verify().ok).toBe(false);
      // and an innocent append is REFUSED — it can never re-bless the erased store
      expect(() =>
        store.journal.append({ ts: 9, actor: 'cli', op: 'memory_write', payload: { id: 'mX' } }),
      ).toThrow(/refusing to append/);
      expect(store.driver.allJournal()).toHaveLength(0);
      expect(store.journal.verify().ok).toBe(false);
      expect(fs.readFileSync(home.path('journal.checkpoint'), 'utf8')).toBe(externalBefore);
    } finally {
      store.close();
    }
  });

  it('a fresh pristine store still mints on the first append and verifies ok', () => {
    const { driver, journal } = openJournal();
    journal.append({ ts: 1, actor: 'cli', op: 'memory_write', payload: { id: 'm1' } });
    expect(journal.verify()).toMatchObject({ ok: true, length: 1, state: 'ok' });
    expect(fs.existsSync(home.path('journal.checkpoint'))).toBe(true);
    expect(externalCount()).toBe(1);
    driver.close();
  });

  it('service-level writes advance the external checkpoint file immediately (afterCommit drains the deferred flush)', () => {
    const store = openStore(); // TOFU seal → external count 1
    try {
      const c0 = externalCount();
      store.memory.add({ type: 'semantic', content: 'alpha fact' }, { now: 1, asProposal: false });
      // advanced by the time the service call returned — no verify()/top-level append needed
      expect(externalCount()).toBe(c0 + 1);
      store.memory.add({ type: 'semantic', content: 'beta fact' }, { now: 2, asProposal: false });
      expect(externalCount()).toBe(c0 + 2);
      expect(store.journal.verify()).toMatchObject({ ok: true, state: 'ok' });
    } finally {
      store.close();
    }
  });

  it('a rolled-back transaction runs NO queued external flush', () => {
    const store = openStore();
    try {
      const before = fs.readFileSync(home.path('journal.checkpoint'), 'utf8');
      expect(() =>
        store.driver.writeTransaction(() => {
          store.journal.append({ ts: 5, actor: 'cli', op: 'memory_write', payload: { id: 'd' } });
          throw new Error('boom');
        }),
      ).toThrow('boom');
      // the queued flush was discarded with the rollback: file byte-identical, store still ok
      expect(fs.readFileSync(home.path('journal.checkpoint'), 'utf8')).toBe(before);
      expect(store.journal.verify()).toMatchObject({ ok: true, state: 'ok' });
      // a subsequent committed write still advances it
      store.memory.add({ type: 'semantic', content: 'gamma fact' }, { now: 6, asProposal: false });
      expect(fs.readFileSync(home.path('journal.checkpoint'), 'utf8')).not.toBe(before);
      expect(store.journal.verify()).toMatchObject({ ok: true, state: 'ok' });
    } finally {
      store.close();
    }
  });
});

/**
 * POST-GATE checkpoint-file swap: the external checkpoint is replaced with unusable bytes AFTER
 * the append gate verified the store, but BEFORE the post-commit mirror runs. A mirror that
 * treated "present but unparseable / unauthentic" the same as "absent" would skip the ratchet
 * guard on a falsy `parseCheckpoint`/`verifyCheckpoint` and fall through to `external.write(raw)`,
 * overwriting the swapped bytes with a fresh authentic checkpoint — destroying the ONLY record
 * that anything had been touched, and turning a red verify() green by way of an ordinary,
 * innocent write. The mirror must WARN and REFUSE instead, leaving the swapped bytes exactly as
 * found so the tamper stays discoverable.
 *
 * HONEST BOUNDARY, and it is the point of the "already committed" wording in these test names:
 * the mirror runs after the write transaction has COMMITTED, so a swap landing in this window
 * cannot undo the database mutation — the journal row is durable by then. What is recoverable is
 * the EVIDENCE: the file keeps the attacker's bytes and verification stays RED.
 */
describe('safety: a post-gate checkpoint-file swap is never overwritten by the mirror', () => {
  let home: FakeHome;
  let file: string;
  let warnings: string[];

  beforeEach(() => {
    home = createFakeHome();
    file = home.path('sthayi.db');
    warnings = [];
  });
  afterEach(() => home.cleanup());

  function openJournal(): { driver: SqliteDriver; journal: JournalService } {
    const driver = SqliteDriver.open(file);
    driver.migrate();
    const journal = new JournalService(driver, {
      crypto: NodeCrypto.open(home.path('key')),
      external: new FileCheckpoint(home.path('journal.checkpoint')),
      warn: (m) => warnings.push(m),
    });
    return { driver, journal };
  }

  const cpPath = (): string => home.path('journal.checkpoint');
  const cpBytes = (): Buffer => fs.readFileSync(cpPath());

  /**
   * Append one entry, swapping the external file to `swapped` in the window between the gate's
   * verification and the mirror. Mechanism: the swap is queued on afterCommit FIRST, so the
   * driver drains it before the append's own mirror callback — verify → commit → swap → mirror,
   * which is exactly the concurrent-process race.
   */
  function appendWithSwapBeforeFlush(
    driver: SqliteDriver,
    journal: JournalService,
    swapped: string,
  ): void {
    driver.writeTransaction(() => {
      driver.afterCommit(() => fs.writeFileSync(cpPath(), swapped, { mode: 0o600 }));
      journal.append({ ts: 9, actor: 'cli', op: 'memory_write', payload: { ids: ['m9'] } });
    });
  }

  /** Seal + two appends → a healthy 3-entry authenticated store, connection left open. */
  function seeded(): { driver: SqliteDriver; journal: JournalService } {
    const { driver, journal } = openJournal();
    expect(journal.seal('test', 1).ok).toBe(true);
    journal.append({ ts: 2, actor: 'cli', op: 'memory_write', payload: { ids: ['m1'] } });
    journal.append({ ts: 3, actor: 'cli', op: 'memory_write', payload: { ids: ['m2'] } });
    expect(journal.verify()).toMatchObject({ ok: true, length: 3, state: 'ok' });
    warnings = [];
    return { driver, journal };
  }

  it('INVALID JSON swapped in after verification is left byte-identical (the commit itself stands)', () => {
    const { driver, journal } = seeded();
    try {
      const swapped = '{ this is not a checkpoint';
      appendWithSwapBeforeFlush(driver, journal, swapped);
      // the swapped bytes survived the mirror untouched — the evidence is intact
      expect(cpBytes().toString('utf8')).toBe(swapped);
      expect(warnings.some((w) => /refusing to overwrite it/.test(w))).toBe(true);
      // and verification stays RED on the reopened store as well as this one
      expect(journal.verify().ok).toBe(false);
      expect(journal.verify().reason).toMatch(/external journal checkpoint tampered/);
      // the honest boundary: the append had already COMMITTED before the swap landed
      expect(driver.allJournal()).toHaveLength(4);
    } finally {
      driver.close();
    }
    expect(cpBytes().toString('utf8')).toBe('{ this is not a checkpoint');
    const reopened = openJournal();
    try {
      expect(reopened.journal.verify().ok).toBe(false);
      // a further ordinary append refuses outright and still does not touch the file
      expect(() =>
        reopened.journal.append({
          ts: 10,
          actor: 'cli',
          op: 'memory_write',
          payload: { ids: ['x'] },
        }),
      ).toThrow(/refusing to append/);
      expect(cpBytes().toString('utf8')).toBe('{ this is not a checkpoint');
    } finally {
      reopened.driver.close();
    }
  });

  it('a BAD-MAC checkpoint swapped in after verification is left byte-identical (the commit itself stands)', () => {
    const { driver, journal } = seeded();
    let swapped = '';
    try {
      // shape-valid v1 checkpoint JSON for the CURRENT tip, but MAC'd by nobody
      const authentic = JSON.parse(cpBytes().toString('utf8')) as {
        v: 1;
        count: number;
        tipId: number;
        tipHash: string;
        mac: string;
      };
      swapped = JSON.stringify({ ...authentic, mac: `${authentic.mac.slice(0, -4)}dead` });
      expect(swapped).not.toBe(cpBytes().toString('utf8'));
      appendWithSwapBeforeFlush(driver, journal, swapped);
      // parseCheckpoint SUCCEEDS here; only verifyCheckpoint fails — the other fall-through arm
      expect(cpBytes().toString('utf8')).toBe(swapped);
      expect(warnings.some((w) => /refusing to overwrite it/.test(w))).toBe(true);
      expect(journal.verify().ok).toBe(false);
      expect(journal.verify().reason).toMatch(/external journal checkpoint tampered/);
      expect(driver.allJournal()).toHaveLength(4);
    } finally {
      driver.close();
    }
    expect(cpBytes().toString('utf8')).toBe(swapped);
    const reopened = openJournal();
    try {
      expect(reopened.journal.verify().ok).toBe(false);
      expect(cpBytes().toString('utf8')).toBe(swapped);
    } finally {
      reopened.driver.close();
    }
  });

  it('an ABSENT file blocks the append; the healing verify CREATES it and writes resume', () => {
    // The mirror still creates the file — but it never gets the chance from an ordinary append
    // any more, because an append onto a store with no off-database anchor is exactly the state
    // the anchor invariant refuses: nothing outside the database would vouch for the new entry.
    // Creation belongs to the explicit healing verify(), which is the recovery path.
    const { driver, journal } = seeded();
    try {
      fs.rmSync(cpPath());
      expect(fs.existsSync(cpPath())).toBe(false);
      expect(() =>
        journal.append({ ts: 4, actor: 'cli', op: 'memory_write', payload: { ids: ['m3'] } }),
      ).toThrow(/refusing to append.*NO checkpoint file outside it/s);
      // a refusal, not a half-write: no row, and still no file
      expect(driver.allJournal()).toHaveLength(3);
      expect(fs.existsSync(cpPath())).toBe(false);

      expect(journal.verify()).toMatchObject({ ok: true, length: 3, state: 'ok' });
      expect(fs.existsSync(cpPath())).toBe(true);
      expect((JSON.parse(cpBytes().toString('utf8')) as { count: number }).count).toBe(3);

      journal.append({ ts: 4, actor: 'cli', op: 'memory_write', payload: { ids: ['m3'] } });
      expect((JSON.parse(cpBytes().toString('utf8')) as { count: number }).count).toBe(4);
      expect(journal.verify()).toMatchObject({ ok: true, length: 4, state: 'ok' });
    } finally {
      driver.close();
    }
  });

  it('still ADVANCES an authenticated lagging ancestor', () => {
    const { driver, journal } = seeded();
    try {
      const lagging = cpBytes();
      journal.append({ ts: 4, actor: 'cli', op: 'memory_write', payload: { ids: ['m3'] } });
      // the mirror advanced the file past the ancestor it found
      expect(cpBytes().equals(lagging)).toBe(false);
      expect((JSON.parse(cpBytes().toString('utf8')) as { count: number }).count).toBe(4);
      expect(journal.verify()).toMatchObject({ ok: true, length: 4, state: 'ok' });
      expect(warnings).toEqual([]);
    } finally {
      driver.close();
    }
  });

  it("seal()'s explicit trust decision still replaces an unusable file", () => {
    const { driver, journal } = seeded();
    try {
      fs.writeFileSync(cpPath(), 'not a checkpoint at all', { mode: 0o600 });
      // `sthayi journal reseal` is the documented escape hatch and must still work
      expect(journal.seal('test', 5).ok).toBe(true);
      const cp = JSON.parse(cpBytes().toString('utf8')) as { count: number };
      expect(cp.count).toBe(4);
      expect(journal.verify()).toMatchObject({ ok: true, length: 4, state: 'ok' });
    } finally {
      driver.close();
    }
  });
});

/**
 * Trust-anchor completion: an INITIALIZED installation (the key file, clients ledger, or
 * external checkpoint existed before open) whose database is erased or replaced must NEVER
 * verify as pristine — whatever was done to the external checkpoint file: deleted, made
 * unreadable, symlinked away, or replaced with an attacker's file. Every variant fails
 * verification with ZERO journal/checkpoint writes (no TOFU seal, no minted checkpoint, the
 * external file untouched); a genuinely fresh machine still initializes; and the explicit
 * `sthayi journal reseal` remains the only escape hatch.
 */
describe('safety: erased installation is never pristine (prior-install evidence)', () => {
  let home: FakeHome;

  beforeEach(() => {
    home = createFakeHome();
  });
  afterEach(() => {
    try {
      fs.chmodSync(home.path('journal.checkpoint'), 0o600); // undo chmod 000 so cleanup can rm
    } catch {
      // absent or already removable
    }
    home.cleanup();
  });

  /** Initialize a real installation: key + db + TOFU seal + external checkpoint + one memory. */
  function initInstall(): void {
    const store = openStore();
    try {
      store.memory.add(
        { type: 'semantic', content: 'a fact worth keeping' },
        { now: 1, asProposal: false },
      );
      expect(store.journal.verify()).toMatchObject({ ok: true, state: 'ok' });
    } finally {
      store.close();
    }
  }

  /** Erase the database wholesale (db + wal + shm) — the erased/replaced-DB axis. */
  function eraseDb(): void {
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(home.path(`sthayi.db${suffix}`), { force: true });
    }
  }

  /** Open the store, assert verification FAILS with the given reason and ZERO writes. */
  function expectFailClosed(reasonRe: RegExp): void {
    const store = openStore();
    try {
      const r = store.journal.verify();
      expect(r.ok).toBe(false);
      expect(r.state).toBeUndefined(); // never 'pristine'
      expect(r.reason).toMatch(reasonRe);
      // zero writes: no TOFU seal entry, no journal rows, no minted meta checkpoint
      expect(store.driver.allJournal()).toHaveLength(0);
      expect(store.driver.getMeta(JOURNAL_CHECKPOINT_KEY)).toBeUndefined();
    } finally {
      store.close();
    }
  }

  it('erased DB + MISSING external checkpoint fails (not pristine); reseal is the escape hatch', () => {
    initInstall();
    eraseDb();
    fs.rmSync(home.path('journal.checkpoint'));

    expectFailClosed(/initialized installation with erased journal history/);
    // and the refusal did not recreate the checkpoint file
    expect(fs.existsSync(home.path('journal.checkpoint'))).toBe(false);

    // the explicit trust decision still works: reseal accepts the reset, then all is well
    const store = openStore();
    try {
      expect(store.journal.seal('cli', 9).ok).toBe(true);
      expect(store.journal.verify()).toMatchObject({ ok: true, state: 'ok' });
      expect(fs.existsSync(home.path('journal.checkpoint'))).toBe(true);
    } finally {
      store.close();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'erased DB + UNREADABLE external checkpoint (chmod 000) fails closed with zero writes',
    () => {
      initInstall();
      eraseDb();
      const cpFile = home.path('journal.checkpoint');
      fs.chmodSync(cpFile, 0o000);

      expectFailClosed(/journal checkpoint file unreadable — refusing to verify/);
      // the unreadable file was left exactly as found — still present, still mode 000
      expect(fs.lstatSync(cpFile).mode & 0o777).toBe(0o000);
    },
  );

  it('erased DB + SYMLINKED external checkpoint is refused, never followed, zero writes', (ctx) => {
    initInstall();
    const cpFile = home.path('journal.checkpoint');
    const stash = home.path('attacker-copy.checkpoint');
    fs.copyFileSync(cpFile, stash);
    const attackerBytes = fs.readFileSync(stash, 'utf8');
    eraseDb();
    fs.rmSync(cpFile);
    try {
      fs.symlinkSync(stash, cpFile);
    } catch {
      ctx.skip(); // e.g. Windows without symlink privilege — the POSIX matrix covers this row
      return;
    }

    expectFailClosed(/journal checkpoint file unreadable — refusing to verify/);
    // the symlink was neither followed for a read nor replaced by a write
    expect(fs.lstatSync(cpFile).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(stash, 'utf8')).toBe(attackerBytes);
  });

  it('erased DB + external checkpoint REPLACED with an attacker file fails, zero writes', () => {
    initInstall();
    eraseDb();
    const cpFile = home.path('journal.checkpoint');
    const forged = JSON.stringify({ v: 1, count: 1, tipId: 1, tipHash: 'forged', mac: 'forged' });
    fs.writeFileSync(cpFile, forged, { mode: 0o600 });

    expectFailClosed(/tampered or vault key changed/);
    // the attacker file was not overwritten, healed, or deleted
    expect(fs.readFileSync(cpFile, 'utf8')).toBe(forged);
  });

  it('a genuinely fresh machine still initializes: TOFU seal runs once and verifies ok', () => {
    const store = openStore();
    try {
      expect(store.journal.verify()).toMatchObject({ ok: true, state: 'ok' });
      expect(store.driver.allJournal().filter((r) => r.op === 'journal_seal')).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('a fresh empty store without prior-install evidence still reports pristine', () => {
    const driver = SqliteDriver.open(home.path('sthayi.db'));
    driver.migrate();
    const journal = new JournalService(driver, {
      crypto: NodeCrypto.open(home.path('key')),
      external: new FileCheckpoint(home.path('journal.checkpoint')),
      priorInstall: false,
    });
    expect(journal.verify()).toEqual({ ok: true, length: 0, state: 'pristine' });
    driver.close();
  });
});

/**
 * NO automatic TOFU sealing for rows-bearing stores: the auto-seal at open is for a genuinely
 * EMPTY first-run store ONLY. A store with rows but no authentic checkpoint anywhere is the
 * shape of BOTH a legitimate pre-checkpoint upgrade AND a truncated/replaced database whose
 * checkpoints were erased — indistinguishable, so openStore must FAIL CLOSED: verify() fails
 * with reseal guidance, ZERO automatic writes (db bytes untouched, no checkpoint file appears),
 * and the explicit `sthayi journal reseal` is the only blessing path.
 */
describe('safety: openStore never auto-seals a rows-bearing checkpoint-less store', () => {
  let home: FakeHome;
  let file: string;

  beforeEach(() => {
    home = createFakeHome();
    file = home.path('sthayi.db');
  });
  afterEach(() => home.cleanup());

  function rawSql(sql: string): void {
    const raw = new Database(file);
    raw.prepare(sql).run();
    raw.close();
  }

  /** id+hash of every journal row via a throwaway raw connection (no service code involved). */
  function rawJournal(): { id: number; hash: string }[] {
    const raw = new Database(file);
    const rows = raw.prepare('SELECT id, hash FROM journal ORDER BY id').all() as {
      id: number;
      hash: string;
    }[];
    raw.close();
    return rows;
  }

  /** Initialize a real installation with a few memories, then close (WAL folds back into the db). */
  function initInstall(contents: string[]): void {
    const store = openStore();
    try {
      let now = 1;
      for (const content of contents) {
        store.memory.add({ type: 'semantic', content }, { now: now++, asProposal: false });
      }
      expect(store.journal.verify()).toMatchObject({ ok: true, state: 'ok' });
    } finally {
      store.close();
    }
  }

  /**
   * Reopen via the REAL openStore path and prove it wrote NOTHING: journal rows identical
   * (ids + hashes), no meta checkpoint minted, the external checkpoint file still absent,
   * verify() FAILS with reseal guidance — and after close, the db file is byte-identical to
   * the pre-open snapshot (a no-op open leaves no trace, not even a re-minted checkpoint).
   */
  function expectZeroWriteFailClosed(): void {
    const rowsBefore = rawJournal();
    expect(rowsBefore.length).toBeGreaterThan(0); // precondition: this is a rows-bearing store
    expect(fs.existsSync(home.path('journal.checkpoint'))).toBe(false);
    const bytesBefore = fs.readFileSync(file);

    const store = openStore();
    try {
      const r = store.journal.verify();
      expect(r.ok).toBe(false);
      expect(r.state).toBeUndefined(); // never pristine, never ok
      expect(r.reason).toMatch(/no authenticated checkpoint/);
      expect(r.reason).toMatch(/journal reseal/);
      // zero automatic writes: rows untouched (same ids AND hashes — no TOFU seal entry
      // appended), no meta checkpoint minted, no external checkpoint file created
      expect(store.driver.allJournal().map(({ id, hash }) => ({ id, hash }))).toEqual(rowsBefore);
      expect(store.driver.getMeta(JOURNAL_CHECKPOINT_KEY)).toBeUndefined();
      expect(fs.existsSync(home.path('journal.checkpoint'))).toBe(false);
    } finally {
      store.close();
    }

    // byte-identical database after close, and still no checkpoint file
    expect(fs.readFileSync(file).equals(bytesBefore)).toBe(true);
    expect(fs.existsSync(home.path('journal.checkpoint'))).toBe(false);
  }

  it('truncated rows + erased meta checkpoint + deleted external file: reopen is zero-write and fails; reseal is the only blessing', () => {
    initInstall(['first fact', 'second fact', 'third fact']);
    rawSql('DELETE FROM journal WHERE id > 2'); // truncate — rows survive (rows-bearing store)
    rawSql(`DELETE FROM meta WHERE k='${JOURNAL_CHECKPOINT_KEY}'`);
    fs.rmSync(home.path('journal.checkpoint'));

    expectZeroWriteFailClosed();
    // the refusal is stable across reopens, not a once-only grace
    expectZeroWriteFailClosed();

    // `sthayi journal reseal` (seal WITHOUT onlyIfMissing — exactly what the CLI command runs)
    // remains the explicit escape hatch
    const store = openStore();
    try {
      expect(store.journal.seal('cli', 99).ok).toBe(true);
      expect(store.journal.verify()).toMatchObject({ ok: true, state: 'ok' });
      expect(fs.existsSync(home.path('journal.checkpoint'))).toBe(true);
    } finally {
      store.close();
    }
  });

  it('whole-db replacement with a checkpoint-less OLDER snapshot: reopen is zero-write and verify fails', () => {
    initInstall(['early fact']);
    const snapshot = fs.readFileSync(file);
    // the installation moves on…
    {
      const store = openStore();
      try {
        store.memory.add(
          { type: 'semantic', content: 'newer fact' },
          { now: 50, asProposal: false },
        );
      } finally {
        store.close();
      }
    }
    // …then the whole db is swapped for the older snapshot, stripped of every checkpoint
    fs.rmSync(`${file}-wal`, { force: true });
    fs.rmSync(`${file}-shm`, { force: true });
    fs.writeFileSync(file, snapshot);
    rawSql(`DELETE FROM meta WHERE k='${JOURNAL_CHECKPOINT_KEY}'`);
    fs.rmSync(home.path('journal.checkpoint'));

    expectZeroWriteFailClosed();
  });

  it('a genuinely fresh empty store still initializes normally (one seal, checkpoints minted)', () => {
    {
      const store = openStore();
      try {
        expect(store.journal.verify()).toMatchObject({ ok: true, state: 'ok' });
        expect(store.driver.allJournal().filter((r) => r.op === 'journal_seal')).toHaveLength(1);
        expect(store.driver.getMeta(JOURNAL_CHECKPOINT_KEY)).toBeDefined();
        expect(fs.existsSync(home.path('journal.checkpoint'))).toBe(true);
      } finally {
        store.close();
      }
    }
    // a reopen neither reseals nor appends anything
    const store = openStore();
    try {
      expect(store.driver.allJournal().filter((r) => r.op === 'journal_seal')).toHaveLength(1);
      expect(store.journal.verify()).toMatchObject({ ok: true, state: 'ok' });
    } finally {
      store.close();
    }
  });
});

/**
 * Append-gate invariant: ordinary writes must never LAUNDER a failed authenticity state.
 * Two laundering shapes that must stay impossible:
 *  A. erased prior installation (db + external checkpoint removed, key kept): verify fails
 *     correctly, and an ordinary memory.add must NOT mint a fresh checkpoint — a first-entry
 *     mint path that checks only the external file, not priorInstall, would turn verification
 *     green;
 *  B. an authentic same-key external checkpoint from a DIVERGENT branch at the SAME count:
 *     verify fails on divergence, and an ordinary write must NOT overwrite the external file —
 *     a mirror ratchet that guards only LOWER counts would destroy the evidence.
 * Enforcement: appendEntry runs a fail-closed NON-HEALING verification inside its write
 * transaction before anything is written — a failing state THROWS, aborting the whole caller
 * transaction with zero db and zero external-file effects — and the external mirror refuses to
 * overwrite any authentic checkpoint whose tip is not an ancestor of the current chain.
 * Steady-state writes stay O(1) (no allJournal). Only the explicit `journal reseal` accepts an
 * untrusted history.
 */
describe('safety: append gate — failed authenticity states refuse ordinary writes', () => {
  let home: FakeHome;
  let file: string;

  beforeEach(() => {
    home = createFakeHome();
    file = home.path('sthayi.db');
  });
  afterEach(() => home.cleanup());

  function openJournal(): { driver: SqliteDriver; journal: JournalService } {
    const driver = SqliteDriver.open(file);
    driver.migrate();
    const journal = new JournalService(driver, {
      crypto: NodeCrypto.open(home.path('key')),
      external: new FileCheckpoint(home.path('journal.checkpoint')),
    });
    return { driver, journal };
  }

  it('erased installation (db + external gone, key kept) — verify fails, an ordinary add THROWS with zero writes, reseal unlocks', () => {
    // 1. a real installation: key + db + TOFU seal + external checkpoint + history
    {
      const store = openStore();
      try {
        store.memory.add(
          { type: 'semantic', content: 'first fact' },
          { now: 1, asProposal: false },
        );
        store.memory.add(
          { type: 'semantic', content: 'second fact' },
          { now: 2, asProposal: false },
        );
        expect(store.journal.verify()).toMatchObject({ ok: true, state: 'ok' });
      } finally {
        store.close();
      }
    }
    // 2. erase the installation out-of-band: db (+sidecars) AND external checkpoint; key kept
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(home.path(`sthayi.db${suffix}`), { force: true });
    }
    fs.rmSync(home.path('journal.checkpoint'));

    // 3. reopen through the real services: verify fails, and the laundering write — one
    //    ordinary memory.add that would mint a fresh checkpoint — THROWS with zero effects
    {
      const store = openStore();
      try {
        const r = store.journal.verify();
        expect(r.ok).toBe(false);
        expect(r.reason).toMatch(/initialized installation with erased journal history/);
        expect(() =>
          store.memory.add(
            { type: 'semantic', content: 'laundering attempt' },
            { now: 9, asProposal: false },
          ),
        ).toThrow(/refusing to append.*erased journal history/s);
        // the aborted transaction left nothing: no memory row, no journal row, no checkpoint
        expect(store.driver.countMemories()).toBe(0);
        expect(store.driver.allJournal()).toHaveLength(0);
        expect(store.driver.getMeta(JOURNAL_CHECKPOINT_KEY)).toBeUndefined();
        expect(fs.existsSync(home.path('journal.checkpoint'))).toBe(false);
        expect(store.journal.verify().ok).toBe(false); // still failing — nothing re-blessed
      } finally {
        store.close();
      }
    }

    // 4. byte-level: db bytes and external absence identical before/after a refused write
    const bytesBefore = fs.readFileSync(file);
    {
      const store = openStore();
      try {
        expect(() =>
          store.memory.add(
            { type: 'semantic', content: 'second laundering attempt' },
            { now: 10, asProposal: false },
          ),
        ).toThrow(/refusing to append/);
      } finally {
        store.close();
      }
    }
    expect(fs.readFileSync(file).equals(bytesBefore)).toBe(true);
    expect(fs.existsSync(home.path('journal.checkpoint'))).toBe(false);

    // 5. the explicit trust decision (`sthayi journal reseal`) unlocks writes again
    {
      const store = openStore();
      try {
        expect(store.journal.seal('cli', 20).ok).toBe(true);
        store.memory.add(
          { type: 'semantic', content: 'post-reseal fact' },
          { now: 21, asProposal: false },
        );
        expect(store.journal.verify()).toMatchObject({ ok: true, state: 'ok' });
        expect(fs.existsSync(home.path('journal.checkpoint'))).toBe(true);
      } finally {
        store.close();
      }
    }
  });

  it('authentic same-key DIVERGENT external checkpoint at EQUAL count — verify fails, an ordinary write is refused, the file survives byte-identical', () => {
    // 1. branch A: a real installation with 4 journal entries (TOFU seal + 3 writes)
    {
      const store = openStore();
      try {
        for (let i = 1; i <= 3; i++) {
          store.memory.add(
            { type: 'semantic', content: `branch A fact ${i}` },
            { now: i, asProposal: false },
          );
        }
        expect(store.driver.allJournal()).toHaveLength(4);
        expect(store.journal.verify()).toMatchObject({ ok: true, state: 'ok' });
      } finally {
        store.close();
      }
    }
    // 2. branch B: same vault key, separate store, FOUR entries → an authentic checkpoint at
    //    the SAME count whose tip is not an ancestor of branch A
    const other = createFakeHome();
    try {
      const driver2 = SqliteDriver.open(other.path('sthayi.db'));
      driver2.migrate();
      const otherJournal = new JournalService(driver2, {
        crypto: NodeCrypto.open(home.path('key')), // the SAME key — its MAC verifies
        external: new FileCheckpoint(other.path('journal.checkpoint')),
      });
      for (let i = 1; i <= 4; i++) {
        otherJournal.append({ ts: 100 + i, actor: 'other', op: 'x', payload: { i } });
      }
      driver2.close();
      fs.copyFileSync(other.path('journal.checkpoint'), home.path('journal.checkpoint'));
    } finally {
      other.cleanup();
    }
    const divergent = fs.readFileSync(home.path('journal.checkpoint'), 'utf8');
    // equal count — exactly the case a lower-count-only ratchet would let through
    expect((JSON.parse(divergent) as { count: number }).count).toBe(4);

    // 3. verify fails on divergence; one ordinary write is REFUSED; the divergent external
    //    file (the surviving evidence) is byte-identical after the refusal
    {
      const store = openStore();
      try {
        const r = store.journal.verify();
        expect(r.ok).toBe(false);
        expect(r.reason).toMatch(/does not match this journal's history/);
        expect(() =>
          store.memory.add(
            { type: 'semantic', content: 'laundering attempt' },
            { now: 9, asProposal: false },
          ),
        ).toThrow(/refusing to append.*does not match this journal's history/s);
        expect(store.driver.allJournal()).toHaveLength(4);
        expect(store.journal.verify().ok).toBe(false);
      } finally {
        store.close();
      }
    }
    expect(fs.readFileSync(home.path('journal.checkpoint'), 'utf8')).toBe(divergent);
  });

  /**
   * A tampered INTERIOR journal row, with the authenticated TIP and BOTH checkpoint copies left
   * intact (real driver, real SQLite). An append gate that authenticates only the checkpoints and
   * the tip never walks the interior, so `journal.verify()` shows a mid-chain break while an
   * ordinary `memory.add` still commits — rows 3→4, memories 2→3, meta and the checkpoint file
   * advanced, verification still false. A store that cannot verify must accept NO writes at all.
   */
  it('a tampered INTERIOR row (tip + both checkpoints intact) REFUSES an ordinary memory.add with zero effects', () => {
    // 1. a real installation: TOFU seal + two memories → 3 journal rows
    {
      const store = openStore();
      try {
        store.memory.add(
          { type: 'semantic', content: 'first fact' },
          { now: 1, asProposal: false },
        );
        store.memory.add(
          { type: 'semantic', content: 'second fact' },
          { now: 2, asProposal: false },
        );
        expect(store.journal.verify()).toMatchObject({ ok: true, state: 'ok' });
        expect(store.driver.allJournal()).toHaveLength(3);
        expect(store.driver.countMemories()).toBe(2);
      } finally {
        store.close();
      }
    }

    /** Every column of every journal row, via a throwaway raw connection (no service code). */
    const rawJournalRows = (): unknown[] => {
      const raw = new Database(file);
      const rows = raw.prepare('SELECT * FROM journal ORDER BY id').all() as unknown[];
      raw.close();
      return rows;
    };
    /** Every column of every memory row, likewise. */
    const rawMemoryRows = (): unknown[] => {
      const raw = new Database(file);
      const rows = raw.prepare('SELECT * FROM memories ORDER BY id').all() as unknown[];
      raw.close();
      return rows;
    };
    const rawMeta = (): string | undefined => {
      const raw = new Database(file);
      const row = raw.prepare('SELECT v FROM meta WHERE k = ?').get(JOURNAL_CHECKPOINT_KEY) as
        | { v: string }
        | undefined;
      raw.close();
      return row?.v;
    };

    // 2. tamper the INTERIOR row (#2), leaving its stored hash, the tip row (#3), the meta
    //    checkpoint and the external checkpoint file all authentic and untouched
    const cpFile = home.path('journal.checkpoint');
    const tipBefore = rawJournalRows()[2] as { id: number; hash: string };
    const metaBefore = rawMeta();
    const externalBefore = fs.readFileSync(cpFile);
    {
      const raw = new Database(file);
      raw
        .prepare('UPDATE journal SET payload = ? WHERE id = 2')
        .run(JSON.stringify({ id: 'tampered-interior' }));
      raw.close();
    }
    const journalAfterTamper = rawJournalRows();
    const memoriesAfterTamper = rawMemoryRows();
    // the tip row and both checkpoint copies survived the tamper untouched
    expect(journalAfterTamper[2]).toMatchObject({ id: tipBefore.id, hash: tipBefore.hash });
    expect(rawMeta()).toBe(metaBefore);
    expect(fs.readFileSync(cpFile).equals(externalBefore)).toBe(true);

    // 3. verification is RED at a mid-chain entry (not at the tip)…
    const store = openStore();
    try {
      const before = store.journal.verify();
      expect(before.ok).toBe(false);
      expect(before.brokenAt).toBe(2);
      expect(before.brokenAt).toBeLessThan(tipBefore.id); // genuinely mid-chain
      expect(before.reason).toMatch(/tampered entry 2/);

      // …so an ordinary write must THROW, not append on top of unverifiable history
      expect(() =>
        store.memory.add(
          { type: 'semantic', content: 'write onto a broken chain' },
          { now: 9, asProposal: false },
        ),
      ).toThrow(/refusing to append.*tampered entry 2/s);

      // 4. zero effects — every surface byte-for-byte as it was before the refused write
      expect(store.driver.countMemories()).toBe(2);
      expect(store.driver.allJournal()).toHaveLength(3);
      expect(store.journal.verify().ok).toBe(false); // still red — nothing re-blessed
    } finally {
      store.close();
    }
    expect(rawMemoryRows()).toEqual(memoriesAfterTamper);
    expect(rawJournalRows()).toEqual(journalAfterTamper);
    expect(rawMeta()).toBe(metaBefore);
    expect(fs.readFileSync(cpFile).equals(externalBefore)).toBe(true);
  });

  // The append gate deliberately has NO O(1) fast path. Authenticating the checkpoints and the
  // TIP alone would leave a tampered INTERIOR row invisible to it — verify() red while ordinary
  // appends keep succeeding — so correctness beats cost here, and this test pins that contract:
  // EVERY ordinary append reads the whole journal and walks the whole chain before writing
  // anything.
  it('every steady-state append performs the FULL chain verification (allJournal IS consulted)', () => {
    // seed a healthy checkpointed store
    {
      const { driver, journal } = openJournal();
      expect(journal.seal('test', 1).ok).toBe(true);
      journal.append({ ts: 2, actor: 'cli', op: 'memory_write', payload: { id: 'm1' } });
      driver.close();
    }
    const inner = SqliteDriver.open(file);
    let allJournalCalls = 0;
    const inTransactionAtGate: boolean[] = [];
    const spied = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === 'allJournal') {
          return (): JournalRecord[] => {
            allJournalCalls++;
            inTransactionAtGate.push(target.inTransaction());
            return target.allJournal();
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as unknown as SqliteDriver;
    const journal = new JournalService(spied, {
      crypto: NodeCrypto.open(home.path('key')),
      external: new FileCheckpoint(home.path('journal.checkpoint')),
    });
    journal.append({ ts: 3, actor: 'cli', op: 'memory_write', payload: { id: 'm2' } });
    expect(allJournalCalls).toBeGreaterThanOrEqual(1);
    // …and it is per-append, not once per process: the second write verifies again
    const afterFirst = allJournalCalls;
    journal.append({ ts: 4, actor: 'cli', op: 'memory_write', payload: { id: 'm3' } });
    expect(allJournalCalls).toBeGreaterThan(afterFirst);
    // the gate's chain walk runs UNDER THE WRITER LOCK (inside the append transaction), so no
    // concurrent writer can slip a row in between the verification and the append
    expect(inTransactionAtGate[0]).toBe(true);
    expect(journal.verify()).toMatchObject({ ok: true, length: 4, state: 'ok' });
    inner.close();
  });
});

/**
 * DOCUMENTED LIMITATION (SECURITY.md "Journal integrity"): replaying a database together with
 * a matching previously valid external checkpoint from the same earlier state is locally
 * undetectable; the vault key does NOT need to be replaced — the key is static signing
 * material, so every checkpoint it ever minted keeps verifying under it. This test DEMONSTRATES
 * the boundary (it is not a bug to fix locally): detection of a coordinated same-state replay
 * requires an anchor outside the machine.
 */
describe('safety: documented limitation — coordinated db + checkpoint replay is locally undetectable', () => {
  let home: FakeHome;
  let file: string;

  beforeEach(() => {
    home = createFakeHome();
    file = home.path('sthayi.db');
  });
  afterEach(() => home.cleanup());

  function openJournal(): { driver: SqliteDriver; journal: JournalService } {
    const driver = SqliteDriver.open(file);
    driver.migrate();
    const journal = new JournalService(driver, {
      crypto: NodeCrypto.open(home.path('key')),
      external: new FileCheckpoint(home.path('journal.checkpoint')),
    });
    return { driver, journal };
  }

  it('an older db + its matching older external checkpoint pass verification under the CURRENT (unreplaced) key', () => {
    // history at count 2: seal + m1 — snapshot BOTH the db and the external checkpoint
    {
      const { driver, journal } = openJournal();
      expect(journal.seal('test', 1).ok).toBe(true);
      journal.append({ ts: 2, actor: 'cli', op: 'memory_write', payload: { id: 'm1' } });
      driver.close();
    }
    const dbSnapshot = fs.readFileSync(file);
    const cpSnapshot = fs.readFileSync(home.path('journal.checkpoint'));
    const keyBefore = fs.readFileSync(home.path('key'));
    // the installation moves on
    {
      const { driver, journal } = openJournal();
      journal.append({ ts: 3, actor: 'cli', op: 'memory_write', payload: { id: 'm2' } });
      journal.append({ ts: 4, actor: 'cli', op: 'memory_write', payload: { id: 'm3' } });
      expect(journal.verify()).toMatchObject({ ok: true, length: 4, state: 'ok' });
      driver.close();
    }
    // coordinated replay of the SAME earlier state: db AND external checkpoint together,
    // key untouched
    fs.rmSync(`${file}-wal`, { force: true });
    fs.rmSync(`${file}-shm`, { force: true });
    fs.writeFileSync(file, dbSnapshot);
    fs.writeFileSync(home.path('journal.checkpoint'), cpSnapshot);
    expect(fs.readFileSync(home.path('key')).equals(keyBefore)).toBe(true); // current key

    const { driver, journal } = openJournal();
    // the documented boundary: verification PASSES — the replay is locally undetectable
    expect(journal.verify()).toMatchObject({ ok: true, length: 2, state: 'ok' });
    driver.close();
  });
});
