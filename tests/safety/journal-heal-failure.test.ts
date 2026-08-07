import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
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
 * SAFETY: a verification whose HEAL THREW may never report the store as verified on the strength
 * of the bytes it read BEFORE the throw.
 *
 * verify() reads the external checkpoint, authenticates it, walks the ladder, and — when the file
 * merely LAGS the live chain — advances it. That advance is a compare-and-swap that can also
 * THROW: the store refuses to touch a symlink, a FIFO, an unreadable or oversized file, and fails
 * closed on a lock it cannot take. The throw carries NO information about the destination.
 *
 * WHAT THAT COSTS IF THE THROW IS SWALLOWED: catching it, warning, and falling through to
 * `{ ok: true, state: 'ok' }` reports the store as verified on the strength of bytes read before
 * the throw — while the thing now at the path may be a SYMLINK carrying attacker bytes.
 *
 * INVARIANT: after a thrown heal, RE-READ the destination WITHOUT healing and re-establish what is
 * actually there. Hostile, divergent, unreadable, symlinked, oversized or absent-when-expected is
 * RED, and each one names what it actually found.
 *
 * EXACTLY ONE state keeps the green verdict: the destination holds the LIVE checkpoint the heal was
 * installing (a cooperative writer got there first) — read back, not inferred. "Unchanged" is NOT a
 * second such state, however tempting the reading that the advance was merely deferred: under the
 * off-database anchor invariant, a file still holding an old prefix is a store nothing outside the
 * database vouches for, whether the heal was blocked, refused, or never attempted, so it is RED and
 * the reason names the STALE anchor rather than the write that failed.
 *
 * Every row below drives the window with a DETERMINISTIC seam — a hook that mutates the
 * destination, and/or a `replace` that throws on demand — never with timing.
 */
describe('safety: a thrown checkpoint heal never leaves verify() green over unchecked bytes', () => {
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
      fs.chmodSync(cpFile, 0o600); // undo chmod 000 so the tree can be removed
    } catch {
      // absent, a symlink, a FIFO, or already removable
    }
    home.cleanup();
  });

  /** Bytes that are not JSON at all — `parseCheckpoint` refuses them outright. */
  const INVALID_JSON = '{"v":1,"count":9,"tipId":9,"tipHash":"deadbeef","mac":';
  /** Shape-valid v1 checkpoint JSON whose MAC was never minted under this vault's key. */
  const BAD_MAC = JSON.stringify({
    v: 1,
    count: 9,
    tipId: 9,
    tipHash: 'f'.repeat(64),
    mac: 'not-a-mac-this-key-ever-produced',
  });

  /** Simulated lock/I-O failure: the exact shape `FileCheckpoint` fails closed with. */
  const LOCK_HELD = 'journal checkpoint lock is held by another writer';

  interface Seam {
    /** runs INSIDE the replacement, after the service read + authenticated the destination */
    beforeReplace?: () => void;
    /** when set, the replacement THROWS with this message instead of reaching the real store */
    throws?: string;
  }

  /**
   * The real FileCheckpoint with a deterministic seam around `replace`: the destination is mutated
   * (and/or the replacement is forced to throw) at exactly the moment the service attempts it —
   * i.e. strictly after the read whose bytes the verdict was reached over.
   */
  class SeamCheckpoint implements CheckpointStore {
    readonly inner: FileCheckpoint;
    attempts = 0;
    constructor(
      p: string,
      private readonly seam: Seam,
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
      this.seam.beforeReplace?.();
      if (this.seam.throws !== undefined) {
        throw new Error(this.seam.throws);
      }
      return this.inner.replace(expected, next, opts);
    }
  }

  interface Stack {
    driver: SqliteDriver;
    journal: JournalService;
    warnings: string[];
    close(): void;
  }

  function open(external?: CheckpointStore): Stack {
    const driver = SqliteDriver.open(file);
    driver.migrate();
    const warnings: string[] = [];
    const journal = new JournalService(driver, {
      crypto: NodeCrypto.open(home.path('key')),
      external: external ?? new FileCheckpoint(cpFile),
      warn: (m) => warnings.push(m),
    });
    return { driver, journal, warnings, close: () => driver.close() };
  }

  /** Seal + appends, then roll the file back to an authentic LAGGING ancestor so a heal is due. */
  function seedLaggingExternal(): { ancestor: string; live: string } {
    const s = open();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      s.journal.append({ ts: 2, actor: 'cli', op: 'memory_write', payload: { ids: [] } });
      const ancestor = fs.readFileSync(cpFile, 'utf8');
      s.journal.append({ ts: 3, actor: 'cli', op: 'memory_write', payload: { ids: [] } });
      expect(s.journal.verify()).toMatchObject({ ok: true, length: 3, state: 'ok' });
      const live = s.driver.getMeta(JOURNAL_CHECKPOINT_KEY) as string;
      fs.writeFileSync(cpFile, ancestor, { mode: 0o600 });
      return { ancestor, live };
    } finally {
      s.close();
    }
  }

  /** An authentic checkpoint of a DIFFERENT history: minted under our key, foreign tip. */
  function divergentAuthentic(): string {
    const crypto = NodeCrypto.open(home.path('key'));
    const mac = (crypto.mac as (d: string) => string).bind(crypto);
    return buildCheckpoint(mac, 2, 2, 'a'.repeat(64));
  }

  // -----------------------------------------------------------------------------------------
  // RED: the destination is no longer the state that was verified
  // -----------------------------------------------------------------------------------------

  it('(a) a SYMLINK planted at the destination: the heal throws and verify is RED, link intact', () => {
    seedLaggingExternal();
    const planted = home.path('attacker-planted');
    fs.writeFileSync(planted, 'ATTACKER OWNED THIS PATH', { mode: 0o600 });
    const racer = new SeamCheckpoint(cpFile, {
      beforeReplace: () => {
        fs.rmSync(cpFile, { force: true });
        fs.symlinkSync(planted, cpFile);
      },
    });

    const s = open(racer);
    try {
      const v = s.journal.verify();
      expect(racer.attempts).toBe(1);
      expect(v.ok, `verify went green over a symlink: ${JSON.stringify(v)}`).toBe(false);
      expect(v.reason).toMatch(/could not be re-read after a failed heal/);
      // the heal really did fail, and the link was never followed or overwritten
      expect(s.warnings.some((w) => /heal failed/.test(w))).toBe(true);
      expect(fs.lstatSync(cpFile).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(planted, 'utf8')).toBe('ATTACKER OWNED THIS PATH');
    } finally {
      s.close();
    }
    // a fresh reader agrees — the verdict is a property of the store, not of this instance
    const s2 = open();
    try {
      expect(s2.journal.verify().ok).toBe(false);
    } finally {
      s2.close();
    }
  });

  for (const [label, hostile] of [
    ['INVALID JSON', INVALID_JSON],
    ['BAD-MAC', BAD_MAC],
  ] as const) {
    it(`(b) ${label} at the destination + a thrown replacement: verify is RED, bytes intact`, () => {
      seedLaggingExternal();
      const racer = new SeamCheckpoint(cpFile, {
        beforeReplace: () => fs.writeFileSync(cpFile, hostile, { mode: 0o600 }),
        throws: LOCK_HELD,
      });
      const s = open(racer);
      try {
        const v = s.journal.verify();
        expect(v.ok, `verify went green over ${label}: ${JSON.stringify(v)}`).toBe(false);
        expect(v.reason).toMatch(/changed while it was being verified/);
        expect(fs.readFileSync(cpFile, 'utf8')).toBe(hostile);
      } finally {
        s.close();
      }
    });
  }

  it.runIf(process.platform !== 'win32')(
    '(c) a FIFO at the destination: the heal throws and verify is RED',
    () => {
      seedLaggingExternal();
      const racer = new SeamCheckpoint(cpFile, {
        beforeReplace: () => {
          fs.rmSync(cpFile, { force: true });
          execFileSync('mkfifo', [cpFile]);
        },
      });
      const s = open(racer);
      try {
        const v = s.journal.verify();
        expect(v.ok, `verify went green over a FIFO: ${JSON.stringify(v)}`).toBe(false);
        expect(v.reason).toMatch(/could not be re-read after a failed heal/);
        expect(fs.lstatSync(cpFile).isFIFO()).toBe(true);
      } finally {
        s.close();
        fs.rmSync(cpFile, { force: true }); // never leave a FIFO behind for the cleanup
      }
    },
  );

  it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)(
    '(c) an UNREADABLE (chmod 000) destination: the heal throws and verify is RED',
    () => {
      seedLaggingExternal();
      const racer = new SeamCheckpoint(cpFile, {
        beforeReplace: () => fs.chmodSync(cpFile, 0o000),
      });
      const s = open(racer);
      try {
        const v = s.journal.verify();
        expect(v.ok, `verify went green over an unreadable file: ${JSON.stringify(v)}`).toBe(false);
        expect(v.reason).toMatch(/could not be re-read after a failed heal/);
      } finally {
        s.close();
      }
    },
  );

  it('(c) an OVERSIZED destination: the heal throws and verify is RED', () => {
    seedLaggingExternal();
    const racer = new SeamCheckpoint(cpFile, {
      beforeReplace: () => fs.writeFileSync(cpFile, 'x'.repeat(70 * 1024), { mode: 0o600 }),
    });
    const s = open(racer);
    try {
      const v = s.journal.verify();
      expect(v.ok, `verify went green over an oversized file: ${JSON.stringify(v)}`).toBe(false);
      expect(v.reason).toMatch(/could not be re-read after a failed heal/);
      expect(fs.statSync(cpFile).size).toBe(70 * 1024);
    } finally {
      s.close();
    }
  });

  it('(d) a SIMULATED LOCK failure with a DIVERGENT authentic copy swapped in: verify is RED', () => {
    seedLaggingExternal();
    const divergent = divergentAuthentic();
    const racer = new SeamCheckpoint(cpFile, {
      beforeReplace: () => fs.writeFileSync(cpFile, divergent, { mode: 0o600 }),
      throws: LOCK_HELD,
    });
    const s = open(racer);
    try {
      const v = s.journal.verify();
      expect(v.ok, `verify went green over a divergent copy: ${JSON.stringify(v)}`).toBe(false);
      expect(v.reason).toMatch(/changed while it was being verified/);
      expect(fs.readFileSync(cpFile, 'utf8')).toBe(divergent);
    } finally {
      s.close();
    }
  });

  it('(e) the destination DISAPPEARS during a thrown heal: verify is RED, not "no external copy"', () => {
    seedLaggingExternal();
    const racer = new SeamCheckpoint(cpFile, {
      beforeReplace: () => fs.rmSync(cpFile, { force: true }),
      throws: LOCK_HELD,
    });
    const s = open(racer);
    try {
      const v = s.journal.verify();
      expect(v.ok, `verify went green over a vanished file: ${JSON.stringify(v)}`).toBe(false);
      expect(v.reason).toMatch(/disappeared while it was being verified/);
      expect(fs.existsSync(cpFile)).toBe(false);
    } finally {
      s.close();
    }
  });

  // -----------------------------------------------------------------------------------------
  // A HEAL IS GREEN ONLY ON READ-BACK. The tempting reading of these two rows is "a heal that could
  // not be ATTEMPTED is merely a deferred advance, so leave the verdict alone" — but the anchor
  // invariant does not allow it: an unchanged old prefix is a store with no CURRENT off-database
  // anchor, and it does not matter whether the file stayed behind because a lock was held, because
  // the mirror refused, or because nobody ever tried — the guarantee the second copy exists to
  // provide is not in place either way. So (f) is RED, with the reason naming the STALE anchor
  // rather than the failed write, and (g) — where the destination really does hold the live
  // checkpoint when it is read back — is the one that is GREEN.
  // -----------------------------------------------------------------------------------------

  it('(f) a SIMULATED LOCK failure with the destination UNCHANGED is RED (the anchor is stale)', () => {
    const { ancestor } = seedLaggingExternal();
    const racer = new SeamCheckpoint(cpFile, { throws: LOCK_HELD });
    const s = open(racer);
    try {
      const v = s.journal.verify();
      expect(
        v.ok,
        `verify went green over an anchor the heal never advanced: ${JSON.stringify(v)}`,
      ).toBe(false);
      expect(v.reason).toMatch(/external journal checkpoint is STALE/);
      // it names what the file actually holds, and what the store actually is
      expect(v.reason).toMatch(/records 2 entries ending at #2/);
      expect(v.reason).toMatch(/database is at 3 ending at #3/);
      expect(s.warnings.some((w) => /heal failed/.test(w))).toBe(true);
      expect(fs.readFileSync(cpFile, 'utf8')).toBe(ancestor); // byte-identical, nothing written
      // and the store is CLOSED to writes until the anchor catches up
      expect(() =>
        s.journal.append({ ts: 9, actor: 'cli', op: 'memory_write', payload: { ids: [] } }),
      ).toThrow(/refusing to append.*STALE/s);
    } finally {
      s.close();
    }
  });

  it('(g) a cooperative writer that installed the LIVE checkpoint first stays GREEN', () => {
    const { live } = seedLaggingExternal();
    const racer = new SeamCheckpoint(cpFile, {
      beforeReplace: () => fs.writeFileSync(cpFile, live, { mode: 0o600 }),
      throws: LOCK_HELD,
    });
    const s = open(racer);
    try {
      expect(s.journal.verify()).toMatchObject({ ok: true, length: 3, state: 'ok' });
      expect(fs.readFileSync(cpFile, 'utf8')).toBe(live);
    } finally {
      s.close();
    }
  });

  it('the NON-HEALING verify never attempts a replacement at all — and reports the lag instead', () => {
    const { ancestor } = seedLaggingExternal();
    const racer = new SeamCheckpoint(cpFile, { throws: LOCK_HELD });
    const s = open(racer);
    try {
      const v = s.journal.verify({ heal: false });
      // zero side effects is still the contract — but so is an honest verdict: a non-healing
      // verification reports the stale anchor rather than assuming a later heal will fix it.
      expect(racer.attempts).toBe(0);
      expect(fs.readFileSync(cpFile, 'utf8')).toBe(ancestor);
      expect(v.ok).toBe(false);
      expect(v.length).toBe(3);
      expect(v.reason).toMatch(/external journal checkpoint is STALE/);
    } finally {
      s.close();
    }
  });

  it('no lock or tmp debris survives any of the failed heals', () => {
    seedLaggingExternal();
    const racer = new SeamCheckpoint(cpFile, {
      beforeReplace: () => fs.writeFileSync(cpFile, BAD_MAC, { mode: 0o600 }),
      throws: LOCK_HELD,
    });
    const s = open(racer);
    try {
      expect(s.journal.verify().ok).toBe(false);
    } finally {
      s.close();
    }
    const debris = fs
      .readdirSync(home.home)
      .filter((n) => n.includes('.lock') || n.endsWith('.tmp'))
      .map((n) => path.join(home.home, n));
    expect(debris).toEqual([]);
  });
});
