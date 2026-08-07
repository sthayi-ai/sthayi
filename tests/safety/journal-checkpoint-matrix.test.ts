import fs from 'node:fs';
import {
  JOURNAL_CHECKPOINT_KEY,
  JournalService,
  MemoryService,
  type StorageDriver,
  VaultService,
} from '@sthayi/core';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileCheckpoint } from '../../packages/cli/src/drivers/checkpoint-file.js';
import { NodeCrypto } from '../../packages/cli/src/drivers/crypto.js';
import { SqliteDriver } from '../../packages/cli/src/drivers/sqlite.js';
import { type FakeHome, createFakeHome } from '../helpers/fake-home.js';
import { removeOwned } from '../helpers/owned-fs.js';

/**
 * SAFETY: the COMPLETE checkpoint-state matrix for an ordinary write, on the real
 * better-sqlite3 driver and the real FileCheckpoint.
 *
 * The journal keeps its authenticated checkpoint twice — in the database `meta` table (written in
 * the SAME transaction as every append) and in a file outside the database. Every combination of
 * {current, absent, lagging-ancestor, divergent, unauthentic, unreadable} × {meta, external} has
 * exactly one correct outcome, and the invariant that ties them together is:
 *
 *   an ordinary write may NEVER turn a green verification red, and may never succeed on a store
 *   whose verification is not green.
 *
 * THE ASYMMETRIC CORNER the matrix exists for: a CURRENT external checkpoint beside a database meta
 * copy that is (A) divergent at a lower count, (B) a lower-count ancestor, or (C) missing.
 * Validating only the HIGHER-COUNT copy would call all three green, let the ordinary write through,
 * and then let the post-commit mirror copy the bad meta copy over the good file — REGRESSING the
 * anchor, so the write itself is what turns verification red. Hence: verify() validates BOTH copies
 * against the live chain, the append gate refuses anything it fails, and the mirror re-checks that
 * the meta copy is the live one before writing it out.
 *
 * Every REFUSED row asserts byte/state equality of all four surfaces (memories, journal rows,
 * the meta checkpoint value, the external checkpoint file bytes) across the refusal — including
 * across a full HEALING verify(), which must also leave everything untouched when it fails.
 * Every ACCEPTED row asserts verification is still green afterwards.
 */
describe('safety: checkpoint-state matrix for ordinary writes (real driver + real file)', () => {
  let home: FakeHome;
  let file: string;
  let cpFile: string;

  beforeEach(() => {
    home = createFakeHome();
    file = home.path('sthayi.db');
    cpFile = home.path('journal.checkpoint');
  });
  afterEach(() => {
    try {
      fs.chmodSync(cpFile, 0o600); // undo chmod 000 so cleanup can remove the tree
    } catch {
      // absent, a symlink, or already removable
    }
    home.cleanup();
  });

  interface Stack {
    driver: SqliteDriver;
    journal: JournalService;
    memory: MemoryService;
    close(): void;
  }

  /** Production-shaped stack: real sqlite, real key-file crypto, real checkpoint file. */
  function openStack(base?: StorageDriver): Stack {
    const driver = SqliteDriver.open(file);
    driver.migrate();
    const store = base ?? driver;
    const crypto = NodeCrypto.open(home.path('key'));
    const vault = new VaultService(store, crypto, { now: () => 1 });
    const journal = new JournalService(store, {
      crypto,
      external: new FileCheckpoint(cpFile),
      masker: vault,
    });
    const memory = new MemoryService(store, journal, vault);
    return { driver, journal, memory, close: () => driver.close() };
  }

  /** The checkpoint bytes of the healthy chain at 4 entries, and of its 3-entry ancestor. */
  let current: string;
  let ancestor: string;

  /**
   * Seed a healthy installation: seal + three memory writes → 4 journal entries, 3 memories,
   * meta and external checkpoints both current. Captures the count-3 ancestor bytes on the way.
   */
  function seed(): void {
    const s = openStack();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      s.memory.add({ type: 'semantic', content: 'first fact' }, { now: 2, asProposal: false });
      s.memory.add({ type: 'semantic', content: 'second fact' }, { now: 3, asProposal: false });
      ancestor = fs.readFileSync(cpFile, 'utf8'); // authentic checkpoint of a genuine prefix
      s.memory.add({ type: 'semantic', content: 'third fact' }, { now: 4, asProposal: false });
      current = fs.readFileSync(cpFile, 'utf8');
      expect(s.journal.verify()).toMatchObject({ ok: true, length: 4, state: 'ok' });
      expect(s.driver.allJournal()).toHaveLength(4);
      expect(s.driver.countMemories()).toBe(3);
    } finally {
      s.close();
    }
    expect(count(ancestor)).toBe(3);
    expect(count(current)).toBe(4);
  }

  function count(raw: string): number {
    return (JSON.parse(raw) as { count: number }).count;
  }

  /**
   * An AUTHENTIC checkpoint (minted with the SAME vault key, so its MAC verifies) committing to
   * `n` entries of a DIFFERENT history — the shape of a swapped store or a divergent branch.
   */
  function divergent(n: number): string {
    const other = createFakeHome();
    try {
      const driver = SqliteDriver.open(other.path('sthayi.db'));
      driver.migrate();
      const external = new FileCheckpoint(other.path('journal.checkpoint'));
      const journal = new JournalService(driver, {
        crypto: NodeCrypto.open(home.path('key')), // the SAME key — the MAC authenticates
        external,
      });
      for (let i = 1; i <= n; i++) {
        journal.append({ ts: 1000 + i, actor: 'other', op: 'x', payload: { branch: 'B', i } });
      }
      driver.close();
      const raw = external.read() as string;
      expect(count(raw)).toBe(n);
      return raw;
    } finally {
      other.cleanup(); // restores STHAYI_HOME to the outer fake home
    }
  }

  /** Flip one MAC character: still shape-valid JSON, no longer authentic under our key. */
  function unauthentic(raw: string): string {
    const cp = JSON.parse(raw) as { mac: string };
    cp.mac = (cp.mac.startsWith('0') ? '1' : '0') + cp.mac.slice(1);
    return JSON.stringify(cp);
  }

  // ---- out-of-band mutation of the two copies (never through the service) ----

  function setMeta(raw: string | undefined): void {
    const db = new Database(file);
    if (raw === undefined) {
      db.prepare('DELETE FROM meta WHERE k = ?').run(JOURNAL_CHECKPOINT_KEY);
    } else {
      db.prepare('UPDATE meta SET v = ? WHERE k = ?').run(raw, JOURNAL_CHECKPOINT_KEY);
    }
    db.close();
  }

  function setExternal(raw: string | undefined): void {
    if (raw === undefined) {
      fs.rmSync(cpFile, { force: true });
      return;
    }
    fs.writeFileSync(cpFile, raw, { mode: 0o600 });
  }

  // ---- the four surfaces a refused write must leave untouched ----

  interface Surfaces {
    memories: unknown[];
    journal: unknown[];
    meta: string | undefined;
    external: string | null;
  }

  function surfaces(): Surfaces {
    const db = new Database(file);
    const memories = db.prepare('SELECT * FROM memories ORDER BY id').all() as unknown[];
    const journal = db.prepare('SELECT * FROM journal ORDER BY id').all() as unknown[];
    const meta = (
      db.prepare('SELECT v FROM meta WHERE k = ?').get(JOURNAL_CHECKPOINT_KEY) as
        | { v: string }
        | undefined
    )?.v;
    db.close();
    let external: string | null = null;
    try {
      external = fs.readFileSync(cpFile, 'utf8');
    } catch {
      external = null; // absent, unreadable, or a refused symlink — all "no readable bytes"
    }
    return { memories, journal, meta, external };
  }

  /**
   * The refusal contract: verification is RED, an ordinary memory.add THROWS, and all four
   * surfaces are byte-identical afterwards — the healing verify() included.
   */
  function expectRefused(reason: RegExp, base?: StorageDriver): void {
    const before = surfaces();
    const s = openStack(base);
    try {
      const v = s.journal.verify(); // HEALING mode: a failure must still write nothing
      expect(v.ok).toBe(false);
      expect(v.reason).toMatch(reason);
      expect(() =>
        s.memory.add(
          { type: 'semantic', content: 'ordinary write onto an unverifiable store' },
          { now: 900, asProposal: false },
        ),
      ).toThrow(/refusing to append/);
      expect(s.journal.verify().ok).toBe(false); // still red — nothing was re-blessed
    } finally {
      s.close();
    }
    expect(surfaces()).toEqual(before);
  }

  /**
   * The acceptance contract: the pre-write state verifies green WITHOUT healing, the ordinary
   * write commits, and verification is still green afterwards. Returns the post-write external
   * checkpoint count so callers can assert the anchor advanced rather than regressed.
   */
  function expectAccepted(): number {
    const s = openStack();
    try {
      expect(s.journal.verify({ heal: false })).toMatchObject({ ok: true, state: 'ok' });
      s.memory.add(
        { type: 'semantic', content: 'an ordinary accepted write' },
        { now: 900, asProposal: false },
      );
      expect(s.driver.allJournal()).toHaveLength(5);
      expect(s.driver.countMemories()).toBe(4);
      expect(s.journal.verify()).toMatchObject({ ok: true, length: 5, state: 'ok' });
    } finally {
      s.close();
    }
    return count(fs.readFileSync(cpFile, 'utf8'));
  }

  // ================= accepted rows =================

  it('current meta + current external (the healthy steady state): the write SUCCEEDS and stays green', () => {
    seed();
    expect(expectAccepted()).toBe(5);
  });

  // ================= refused rows: an external anchor that is not CURRENT =================
  //
  // These two rows are the tempting acceptances: "the post-commit mirror will catch the file up".
  // Nothing confirms that it does, and an anchor that is absent or behind vouches for nothing —
  // the meta copy lives inside the very database a whole-store replacement swaps, so the file is
  // the only witness that survives it. Accept them and a jammed `journal.checkpoint.lock` freezes
  // the file at count 1 while writes stay authorized all the way to count 4, after which a DB-only
  // restore to an intermediate snapshot verifies GREEN.
  //
  // So the write REFUSES — the append gate is non-healing, so it never quietly re-anchors the
  // store on its own — and the recovery is the EXPLICIT healing verify(), which advances the file
  // along the verified prefix and only then lets writes resume. Both halves are pinned here: the
  // refusal must be a refusal (zero effects), and the recovery must actually work.

  function expectRefusedByGateThenHealed(expected: RegExp): void {
    const before = surfaces();
    {
      const s = openStack();
      try {
        const v = s.journal.verify({ heal: false });
        expect(v.ok).toBe(false);
        expect(v.reason).toMatch(expected);
        expect(() =>
          s.memory.add(
            { type: 'semantic', content: 'ordinary write onto an unanchored store' },
            { now: 900, asProposal: false },
          ),
        ).toThrow(/refusing to append/);
      } finally {
        s.close();
      }
    }
    expect(surfaces()).toEqual(before); // the refusal touched nothing at all
    // recovery: the explicit HEALING verify re-establishes the anchor, and writes resume
    const s = openStack();
    try {
      expect(s.journal.verify()).toMatchObject({ ok: true, length: 4, state: 'ok' });
      expect(count(fs.readFileSync(cpFile, 'utf8'))).toBe(4);
      s.memory.add(
        { type: 'semantic', content: 'an ordinary accepted write' },
        { now: 901, asProposal: false },
      );
      expect(s.journal.verify()).toMatchObject({ ok: true, length: 5, state: 'ok' });
    } finally {
      s.close();
    }
    expect(count(fs.readFileSync(cpFile, 'utf8'))).toBe(5);
  }

  it('current meta + ABSENT external: the write REFUSES; the healing verify recreates the anchor', () => {
    seed();
    setExternal(undefined);
    expect(fs.existsSync(cpFile)).toBe(false);
    expectRefusedByGateThenHealed(/NO checkpoint file outside it/);
  });

  it('current meta + LAGGING ANCESTOR external: the gate ADVANCES the anchor, then the write lands', () => {
    seed();
    setExternal(ancestor); // authentic checkpoint of a genuine 3-entry prefix
    expect(count(fs.readFileSync(cpFile, 'utf8'))).toBe(3);
    // the state itself is NOT green — a non-healing verification says so plainly …
    {
      const s = openStack();
      try {
        const v = s.journal.verify({ heal: false });
        expect(v.ok).toBe(false);
        expect(v.reason).toMatch(/external journal checkpoint is STALE/);
      } finally {
        s.close();
      }
    }
    // … but a lag is CLOSABLE, and closing it asserts nothing new (the file already attests to
    // this exact chain), so the gate advances it and the ordinary write proceeds on a store whose
    // anchor is current. That is also what makes concurrent writers work: a peer commits and
    // mirrors in two steps, so a legitimate observer sees the file behind.
    const s = openStack();
    try {
      s.memory.add(
        { type: 'semantic', content: 'an ordinary accepted write' },
        { now: 900, asProposal: false },
      );
      expect(s.driver.allJournal()).toHaveLength(5);
      expect(s.driver.countMemories()).toBe(4);
      expect(s.journal.verify({ heal: false })).toMatchObject({ ok: true, state: 'ok' });
    } finally {
      s.close();
    }
    expect(count(fs.readFileSync(cpFile, 'utf8'))).toBe(5); // advanced, never regressed
  });

  it('LAGGING external that CANNOT be advanced (jammed lock): the write REFUSES, nothing changes', () => {
    seed();
    setExternal(ancestor);
    // a DIRECTORY at the lock path cannot be opened O_CREAT|O_EXCL — every replacement fails
    // closed, permanently, with no privilege beyond writing the home
    fs.mkdirSync(`${cpFile}.lock`, { recursive: true });
    try {
      const before = surfaces();
      const s = openStack();
      try {
        const v = s.journal.verify(); // even the HEALING verify cannot close it
        expect(v.ok).toBe(false);
        expect(v.reason).toMatch(/external journal checkpoint is STALE/);
        expect(() =>
          s.memory.add(
            { type: 'semantic', content: 'ordinary write onto a frozen anchor' },
            { now: 900, asProposal: false },
          ),
        ).toThrow(/refusing to append/);
      } finally {
        s.close();
      }
      expect(surfaces()).toEqual(before);
    } finally {
      // Identity-aware, not recursive-by-name: a `finally` is teardown, and teardown removes
      // by the identity recorded at creation rather than by whatever answers to the name.
      removeOwned(`${cpFile}.lock`);
    }
  });

  // ================= refused rows: a bad EXTERNAL copy =================

  it('current meta + DIVERGENT external at a LOWER count: refused, everything unchanged', () => {
    seed();
    setExternal(divergent(2));
    expectRefused(/does not match this journal's history/);
  });

  it('current meta + DIVERGENT external at an EQUAL count: refused, everything unchanged', () => {
    seed();
    setExternal(divergent(4));
    expectRefused(/does not match this journal's history/);
  });

  it('current meta + DIVERGENT external at a HIGHER count: refused, everything unchanged', () => {
    seed();
    setExternal(divergent(6));
    expectRefused(/truncated or restored/);
  });

  // ================= refused rows: a bad DATABASE META copy =================
  // These three are the green-verify → write → red-verify corner: the write itself is what would
  // turn the store red, so the gate has to refuse before it happens.

  it('ABSENT meta + current external: refused (meta commits with the rows — it cannot legitimately be missing)', () => {
    seed();
    setMeta(undefined);
    expectRefused(/no authenticated checkpoint in the database/);
  });

  it('LAGGING ANCESTOR meta + current external: refused (the write would have REGRESSED the file to the older count)', () => {
    seed();
    setMeta(ancestor);
    expectRefused(/truncated or restored/);
  });

  it('DIVERGENT meta at a LOWER count + current external: refused (the write would have overwritten the good anchor)', () => {
    seed();
    setMeta(divergent(3));
    expectRefused(/truncated or restored/);
  });

  it('DIVERGENT meta at an EQUAL count + current external: refused', () => {
    seed();
    setMeta(divergent(4));
    expectRefused(/truncated or restored/);
  });

  // ================= refused rows: UNAUTHENTIC copies (bad MAC) =================

  it('UNAUTHENTIC meta (bad MAC) + current external: refused', () => {
    seed();
    setMeta(unauthentic(current));
    expectRefused(/journal checkpoint tampered or vault key changed/);
  });

  it('current meta + UNAUTHENTIC external (bad MAC): refused', () => {
    seed();
    setExternal(unauthentic(current));
    expectRefused(/external journal checkpoint tampered or vault key changed/);
  });

  it('BOTH copies unauthentic (bad MAC): refused', () => {
    seed();
    setMeta(unauthentic(current));
    setExternal(unauthentic(current));
    expectRefused(/tampered or vault key changed/);
  });

  // ================= refused rows: UNREADABLE copies (fail closed) =================

  it.skipIf(process.platform === 'win32')(
    'UNREADABLE external checkpoint (chmod 000): refused, the file left exactly as found',
    () => {
      seed();
      const bytes = fs.readFileSync(cpFile);
      fs.chmodSync(cpFile, 0o000);

      expectRefused(/journal checkpoint file unreadable — refusing to verify/);

      expect(fs.lstatSync(cpFile).mode & 0o777).toBe(0o000); // never chmod'ed by us
      fs.chmodSync(cpFile, 0o600);
      expect(fs.readFileSync(cpFile).equals(bytes)).toBe(true); // and never rewritten
    },
  );

  it('external checkpoint replaced by a SYMLINK: refused, never followed, never rewritten', (ctx) => {
    seed();
    const stash = home.path('attacker-copy.checkpoint');
    fs.copyFileSync(cpFile, stash);
    const stashBytes = fs.readFileSync(stash, 'utf8');
    fs.rmSync(cpFile);
    try {
      fs.symlinkSync(stash, cpFile);
    } catch {
      ctx.skip(); // Windows without symlink privilege — the POSIX rows cover this shape
      return;
    }

    expectRefused(/journal checkpoint file unreadable — refusing to verify/);

    expect(fs.lstatSync(cpFile).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(stash, 'utf8')).toBe(stashBytes);
  });

  it('UNREADABLE database meta (the checkpoint read THROWS): refused, everything unchanged', () => {
    seed();
    // A meta read that throws (corrupt page, malformed image) is NOT "no checkpoint": treating
    // it as absent would let whoever can corrupt the meta table erase the anchor without erasing
    // it. The driver is real; only this one read is made to fail.
    const inner = SqliteDriver.open(file);
    inner.migrate();
    const wrapper = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === 'getMeta') {
          return (key: string): string | undefined => {
            if (key === JOURNAL_CHECKPOINT_KEY) {
              throw new Error('database disk image is malformed');
            }
            return target.getMeta(key);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as unknown as StorageDriver;

    expectRefused(/journal checkpoint unreadable — refusing to verify/, wrapper);
    inner.close();
  });
});
