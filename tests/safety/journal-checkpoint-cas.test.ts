import fs from 'node:fs';
import path from 'node:path';
import { type CheckpointStore, JournalService } from '@sthayi/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileCheckpoint } from '../../packages/cli/src/drivers/checkpoint-file.js';
import { NodeCrypto } from '../../packages/cli/src/drivers/crypto.js';
import { SqliteDriver } from '../../packages/cli/src/drivers/sqlite.js';
import { type FakeHome, createFakeHome } from '../helpers/fake-home.js';

/**
 * SAFETY: the external journal checkpoint must never be replaced UNCONDITIONALLY.
 *
 * Both writers of that file — the post-commit mirror (`JournalService.flushExternal`) and the
 * healing arm of `JournalService.verify()` — first READ the file and validate the bytes they got
 * back, and only then replace them. Between those two moments the destination can change. A
 * replacement that only consulted the value read EARLIER would then overwrite whatever arrived in
 * the window — and if what arrived was tamper evidence (unparseable bytes, or a checkpoint that
 * does not authenticate under the vault key), the sole record that anything happened is destroyed
 * and verification goes GREEN over the tampering.
 *
 * The defence is compare-and-swap: the replacement passes BOTH the exact expected old bytes and the
 * new bytes, and the destination is re-read under an interprocess lock and replaced ONLY while it
 * still equals the expectation. These tests drive that window with a DETERMINISTIC seam — a
 * checkpoint-store wrapper that swaps hostile bytes in after `read()` has returned and before the
 * replacement is attempted — never with timing.
 *
 * HONEST BOUNDARY, pinned by the `flushExternal` rows below: that mirror runs AFTER the write
 * transaction has committed, so the journal APPEND IS ALREADY DURABLE and no file guard can undo
 * it. What is guaranteed is that the swapped-in bytes survive BYTE-FOR-BYTE and verification stays
 * RED, so the tamper remains discoverable.
 */
describe('safety: external checkpoint replacement is compare-and-swap, not blind write', () => {
  let home: FakeHome;
  let file: string;
  let cpFile: string;

  beforeEach(() => {
    home = createFakeHome();
    file = home.path('sthayi.db');
    cpFile = home.path('journal.checkpoint');
  });
  afterEach(() => home.cleanup());

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

  /**
   * A checkpoint store that wraps the REAL FileCheckpoint and, exactly once, plants `hostile`
   * at the destination in the window between the service's `read()` and its replacement.
   *
   * The swap is installed on BOTH replacement entry points, so the seam is agnostic to which one
   * the service uses: the compare-and-swap `replace()` and the unconditional `write()` the port
   * still carries. Either way the bytes on disk at the moment the replacement is attempted are the
   * hostile ones, which is precisely the race being modelled.
   */
  class RacingCheckpoint implements CheckpointStore {
    readonly inner: FileCheckpoint;
    /** armed → the next replacement attempt is preceded by the swap (one shot) */
    armed = false;
    swaps = 0;
    constructor(
      private readonly p: string,
      private readonly hostile: string,
    ) {
      this.inner = new FileCheckpoint(p);
    }
    private swapIn(): void {
      if (!this.armed) {
        return;
      }
      this.armed = false;
      this.swaps++;
      fs.writeFileSync(this.p, this.hostile, { mode: 0o600 });
    }
    read(): string | undefined {
      return this.inner.read();
    }
    write(value: string): void {
      this.swapIn();
      this.inner.write(value);
    }
    replace(expected: string | undefined, next: string, opts?: { force?: boolean }): boolean {
      this.swapIn();
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

  /** Seal + three appends → a healthy 4-entry store whose anchor is CURRENT, and the file bytes
   *  of its authentic 3-entry ancestor (what the heal rows roll the file back to). */
  function seedAndCaptureAncestor(): string {
    const s = open();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      s.journal.append({ ts: 2, actor: 'cli', op: 'memory_write', payload: { ids: [] } });
      s.journal.append({ ts: 3, actor: 'cli', op: 'memory_write', payload: { ids: [] } });
      const ancestor = fs.readFileSync(cpFile, 'utf8');
      s.journal.append({ ts: 4, actor: 'cli', op: 'memory_write', payload: { ids: [] } });
      expect(s.journal.verify()).toMatchObject({ ok: true, length: 4, state: 'ok' });
      return ancestor;
    } finally {
      s.close();
    }
  }

  /** Roll the file back to a legitimately lagging authentic ancestor so a heal/mirror is due. */
  function setExternal(raw: string): void {
    fs.writeFileSync(cpFile, raw, { mode: 0o600 });
  }

  // ---------------------------------------------------------------------------------------------
  // (A) flushExternal: the post-commit mirror
  // ---------------------------------------------------------------------------------------------

  for (const [label, hostile] of [
    ['INVALID JSON', INVALID_JSON],
    ['BAD-MAC', BAD_MAC],
  ] as const) {
    it(`flushExternal: ${label} swapped in after read() survives byte-for-byte and leaves verify RED`, () => {
      // The file starts CURRENT — the state an ordinary append is allowed to run from, now that a
      // stale anchor refuses. The append still gives the mirror real work: it commits entry 5, so
      // the file (at 4) is exactly one behind when the post-commit mirror reads and replaces it.
      seedAndCaptureAncestor();

      const racer = new RacingCheckpoint(cpFile, hostile);
      const s = open(racer);
      try {
        racer.armed = true;
        // an ORDINARY append: the gate passes (the anchor is current), the row commits, and the
        // post-commit mirror then finds a destination that changed under it
        s.journal.append({ ts: 5, actor: 'cli', op: 'memory_write', payload: { ids: [] } });
        expect(racer.swaps).toBe(1);

        // the append IS committed — the mirror runs after commit and cannot undo it
        expect(s.driver.allJournal()).toHaveLength(5);
        // the tamper is still discoverable: verification is RED (a mirror that had overwritten
        // the evidence with a fresh authentic checkpoint would report ok/'ok' here)
        const v = s.journal.verify();
        expect(v.ok).toBe(false);
        expect(v.reason).toMatch(/external journal checkpoint tampered|checkpoint file/);
        // …and the swapped-in bytes were NEVER overwritten — not by the mirror, not by the
        // HEALING verify that just ran
        expect(fs.readFileSync(cpFile, 'utf8')).toBe(hostile);
      } finally {
        s.close();
      }
    });
  }

  it('flushExternal: an unraced mirror still advances the file (the CAS is not a freeze)', () => {
    seedAndCaptureAncestor();
    const before = fs.readFileSync(cpFile, 'utf8');
    const s = open();
    try {
      s.journal.append({ ts: 5, actor: 'cli', op: 'memory_write', payload: { ids: [] } });
      const raw = fs.readFileSync(cpFile, 'utf8');
      expect(raw).not.toBe(before);
      expect((JSON.parse(raw) as { count: number }).count).toBe(5);
      expect(s.journal.verify()).toMatchObject({ ok: true, length: 5, state: 'ok' });
    } finally {
      s.close();
    }
  });

  // ---------------------------------------------------------------------------------------------
  // (B) verify() heal
  // ---------------------------------------------------------------------------------------------

  for (const [label, hostile] of [
    ['INVALID JSON', INVALID_JSON],
    ['BAD-MAC', BAD_MAC],
  ] as const) {
    it(`verify heal: ${label} swapped in after read() survives byte-for-byte and verify stays RED`, () => {
      const ancestor = seedAndCaptureAncestor();
      setExternal(ancestor);

      const racer = new RacingCheckpoint(cpFile, hostile);
      const s = open(racer);
      try {
        racer.armed = true;
        // the healing verify authenticated the LAGGING ancestor it read, then the file changed
        const v = s.journal.verify();
        expect(racer.swaps).toBe(1);
        // a heal that could not happen must NOT be reported as a verified store
        expect(v.ok).toBe(false);
        expect(fs.readFileSync(cpFile, 'utf8')).toBe(hostile);
      } finally {
        s.close();
      }
      // a fresh reader agrees: the store no longer verifies
      const s2 = open();
      try {
        expect(s2.journal.verify().ok).toBe(false);
        expect(fs.readFileSync(cpFile, 'utf8')).toBe(hostile);
      } finally {
        s2.close();
      }
    });
  }

  it('verify heal: an unraced heal still advances the lagging file', () => {
    const ancestor = seedAndCaptureAncestor();
    setExternal(ancestor);
    const s = open();
    try {
      expect(s.journal.verify()).toMatchObject({ ok: true, length: 4, state: 'ok' });
      expect(fs.readFileSync(cpFile, 'utf8')).not.toBe(ancestor);
      expect((JSON.parse(fs.readFileSync(cpFile, 'utf8')) as { count: number }).count).toBe(4);
    } finally {
      s.close();
    }
  });

  // ---------------------------------------------------------------------------------------------
  // (C) reseal keeps its explicit trust semantics — through the SAME serialized path
  // ---------------------------------------------------------------------------------------------

  it('an ordinary append never performs the reseal trust decision, but `journal reseal` does', () => {
    seedAndCaptureAncestor();
    // unauthentic bytes at the destination: an ordinary append must leave them alone…
    setExternal(BAD_MAC);
    const s = open();
    try {
      expect(() =>
        s.journal.append({ ts: 5, actor: 'cli', op: 'memory_write', payload: { ids: [] } }),
      ).toThrow(/refusing to append/);
      expect(fs.readFileSync(cpFile, 'utf8')).toBe(BAD_MAC);
      // …while the explicit owner-authorized reseal replaces them
      expect(s.journal.seal('owner', 6).ok).toBe(true);
      const raw = fs.readFileSync(cpFile, 'utf8');
      expect(raw).not.toBe(BAD_MAC);
      expect(s.journal.verify()).toMatchObject({ ok: true, state: 'ok' });
    } finally {
      s.close();
    }
  });

  it('no lock debris is left in the home after mirroring, healing, or resealing', () => {
    seedAndCaptureAncestor();
    const s = open();
    try {
      s.journal.append({ ts: 5, actor: 'cli', op: 'memory_write', payload: { ids: [] } });
      s.journal.verify();
      expect(s.journal.seal('owner', 6).ok).toBe(true);
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
