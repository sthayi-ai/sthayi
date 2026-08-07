import fs from 'node:fs';
import path from 'node:path';
import {
  type CheckpointStore,
  ConsolidationService,
  JOURNAL_CHECKPOINT_KEY,
  JournalService,
  type Memory,
  MemoryService,
  VaultService,
} from '@sthayi/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDoctor } from '../../packages/cli/src/doctor.js';
import { FileCheckpoint } from '../../packages/cli/src/drivers/checkpoint-file.js';
import { NodeCrypto } from '../../packages/cli/src/drivers/crypto.js';
import { SqliteDriver } from '../../packages/cli/src/drivers/sqlite.js';
import { type FakeHome, createFakeHome } from '../helpers/fake-home.js';
import { removeOwned } from '../helpers/owned-fs.js';

/**
 * SAFETY: an external checkpoint that is ABSENT or LAGGING may not authorize a mutation, and may
 * not be reported as a verified store.
 *
 * The journal keeps its authenticated checkpoint twice. The meta copy lives INSIDE the database,
 * so it is worthless against the one attack the second copy exists for: replacing the whole
 * database with an older, internally-consistent one. Only the file outside it survives that, and
 * only while it actually tracks the live chain.
 *
 * THE HAZARD. Accepting any authentic PREFIX of the current chain as 'ok' — on the theory that the
 * post-commit mirror will catch the file up — makes the anchor's own advance unverified. An
 * attacker who can write the home can freeze the file permanently at an old count (a DIRECTORY at
 * `journal.checkpoint.lock` is enough, and needs no other privilege), and from then on every write
 * is authorized by an anchor vouching for a store several entries in the past. That is precisely
 * the window in which the database can be rolled back to a matching older copy and still verify
 * green — on the append/rollback gate `verify({heal:false})`, after a failed heal that left the old
 * prefix byte-identical, and on doctor's read-only integrity check.
 *
 * THE INVARIANT. With an external store CONFIGURED, state 'ok' requires its authenticated
 * bytes to EQUAL the live meta checkpoint. Beyond reporting it, the append gate SYNCHRONIZES:
 *  - a LAG (an authentic prefix of this chain) is advanced by the gate before the entry is
 *    written — advancing a prefix asserts nothing the file does not already attest to, and
 *    refusing instead would break legitimate concurrency, since a peer process commits and
 *    mirrors as two steps. If the advance cannot complete, the write REFUSES;
 *  - an ABSENT anchor is never created by an ordinary write: creating one asserts "this history is
 *    the real one" with nothing outside the database to corroborate it. The explicit healing
 *    verify() does that, and writes resume afterwards;
 *  - the only untouched lag is the IN-FLIGHT one — an earlier append of ours sitting uncommitted
 *    in the same transaction, with the file still holding exactly the checkpoint committed when
 *    that transaction began. Batched and nested writes keep working; a frozen anchor does not
 *    become tolerable just because a transaction happens to be open.
 *
 * Every seam below is deterministic — a directory planted at the lock path, an out-of-band file
 * copy, a checkpoint store whose write throws — never timing.
 */
describe('safety: an absent or lagging external anchor never authorizes a mutation', () => {
  let home: FakeHome;
  let dbFile: string;
  let cpFile: string;

  beforeEach(() => {
    home = createFakeHome();
    dbFile = home.path('sthayi.db');
    cpFile = home.path('journal.checkpoint');
  });
  afterEach(() => {
    removeOwned(`${cpFile}.lock`);
    home.cleanup();
  });

  interface Stack {
    driver: SqliteDriver;
    journal: JournalService;
    memory: MemoryService;
    consolidate: ConsolidationService;
    warnings: string[];
    close(): void;
  }

  /** Production-shaped stack: real sqlite, real key-file crypto, real checkpoint file. */
  function openStack(external?: CheckpointStore): Stack {
    const driver = SqliteDriver.open(dbFile);
    driver.migrate();
    const crypto = NodeCrypto.open(home.path('key'));
    const vault = new VaultService(driver, crypto, { now: () => 1 });
    const warnings: string[] = [];
    const journal = new JournalService(driver, {
      crypto,
      external: external ?? new FileCheckpoint(cpFile),
      masker: vault,
      warn: (m) => warnings.push(m),
    });
    return {
      driver,
      journal,
      memory: new MemoryService(driver, journal, vault),
      consolidate: new ConsolidationService(driver, journal, vault),
      warnings,
      close: () => driver.close(),
    };
  }

  /**
   * Doctor's read-only wiring, mirrored exactly: every checkpoint write refuses by construction
   * and `externalReadOnly` says so. It must suppress BLAME, never the verdict.
   */
  function openReadOnlyJournal(driver: SqliteDriver): JournalService {
    const file = new FileCheckpoint(cpFile);
    return new JournalService(driver, {
      crypto: NodeCrypto.open(home.path('key')),
      external: {
        read: () => file.read(),
        write: () => {
          throw new Error('read-only session — refusing to write the journal checkpoint file');
        },
      },
      externalReadOnly: true,
      warn: () => {},
    });
  }

  /**
   * Jam every checkpoint replacement, permanently and deterministically: the lock is taken with
   * O_CREAT|O_EXCL, and a DIRECTORY at that path can never be created that way. It needs no
   * privilege beyond writing the home, and nothing reclaims it on a timer.
   */
  function jamLock(): void {
    fs.mkdirSync(`${cpFile}.lock`, { recursive: true });
  }

  function clearLock(): void {
    removeOwned(`${cpFile}.lock`);
  }

  function extCount(): number | undefined {
    try {
      return (JSON.parse(fs.readFileSync(cpFile, 'utf8')) as { count: number }).count;
    } catch {
      return undefined;
    }
  }

  function metaCount(driver: SqliteDriver): number | undefined {
    const raw = driver.getMeta(JOURNAL_CHECKPOINT_KEY);
    return raw === undefined ? undefined : (JSON.parse(raw) as { count: number }).count;
  }

  /** A sealed 1-entry store with both copies current. */
  function sealed(): Stack {
    const s = openStack();
    expect(s.journal.seal('test', 1).ok).toBe(true);
    expect(extCount()).toBe(1);
    return s;
  }

  // ===========================================================================================
  // ABSENT ANCHOR
  // ===========================================================================================

  it('absent external + blocked lock: verify({heal:false}) is RED and names the missing anchor', () => {
    const s = sealed();
    try {
      fs.rmSync(cpFile, { force: true });
      jamLock();
      const v = s.journal.verify({ heal: false });
      expect(v.ok, `non-healing verify went green with no anchor: ${JSON.stringify(v)}`).toBe(
        false,
      );
      expect(v.reason).toMatch(/NO checkpoint file outside it/);
      expect(v.reason).toMatch(/would not be detectable/);
      // the non-healing verdict is reached with ZERO side effects
      expect(fs.existsSync(cpFile)).toBe(false);
      expect(fs.lstatSync(`${cpFile}.lock`).isDirectory()).toBe(true);
    } finally {
      s.close();
    }
  });

  it('absent external + ordinary append: REFUSED, and the anchor is not minted by the write', () => {
    const s = sealed();
    try {
      fs.rmSync(cpFile, { force: true });
      const before = s.driver.allJournal().length;
      expect(() =>
        s.memory.add({ type: 'semantic', content: 'a fact' }, { now: 2, asProposal: false }),
      ).toThrow(/refusing to append.*NO checkpoint file outside it/s);
      // zero effects, and specifically: the gate did NOT create the anchor. Minting one asserts
      // that this history is the real one with nothing outside the database to corroborate it —
      // the trust decision TOFU guards, which an ordinary write may not make.
      expect(s.driver.allJournal()).toHaveLength(before);
      expect(s.driver.countMemories()).toBe(0);
      expect(fs.existsSync(cpFile)).toBe(false);

      // the EXPLICIT healing verify is the recovery path, and writes resume behind it
      expect(s.journal.verify()).toMatchObject({ ok: true, state: 'ok' });
      expect(extCount()).toBe(1);
      s.memory.add({ type: 'semantic', content: 'a fact' }, { now: 3, asProposal: false });
      expect(extCount()).toBe(2);
      expect(s.journal.verify({ heal: false })).toMatchObject({ ok: true, state: 'ok' });
    } finally {
      s.close();
    }
  });

  it('doctor with an absent external reports a RED journal-integrity check, not a green one', () => {
    const s = sealed();
    s.close();
    // control: with the anchor present, doctor is green — the read-only flag must not turn every
    // observation of a healthy store into a failure
    const healthy = runDoctor().find((c) => c.name === 'Journal integrity');
    expect(healthy?.ok, JSON.stringify(healthy)).toBe(true);

    fs.rmSync(cpFile, { force: true });
    const checks = runDoctor();
    const integrity = checks.find((c) => c.name === 'Journal integrity');
    expect(integrity, 'doctor did not run the journal-integrity check at all').toBeDefined();
    expect(
      integrity?.ok,
      `doctor rendered a green integrity check: ${JSON.stringify(integrity)}`,
    ).toBe(false);
    expect(integrity?.detail).toMatch(/NO checkpoint file outside it/);
    // observation stayed observation: doctor created nothing and blamed nothing on itself
    expect(fs.existsSync(cpFile)).toBe(false);
    expect(integrity?.detail).not.toMatch(/could not be written/);
  });

  it('a read-only session sees the same missing anchor as a writable one', () => {
    const s = sealed();
    try {
      fs.rmSync(cpFile, { force: true });
      jamLock();
      const ro = openReadOnlyJournal(s.driver).verify();
      const rw = s.journal.verify();
      expect(ro.ok).toBe(false);
      expect(rw.ok).toBe(false);
      // the FACT is identical; only the blame differs — the writable session is told what is
      // blocking the write it could have made, the read-only one is not blamed for a write it
      // could never make
      expect(ro.reason).toMatch(/NO checkpoint file outside it/);
      expect(rw.reason).toMatch(/absent and could not be written/);
      expect(rw.reason).toMatch(/journal\.checkpoint\.lock/);
      expect(fs.existsSync(cpFile)).toBe(false);
    } finally {
      s.close();
    }
  });

  // ===========================================================================================
  // A FROZEN ANCHOR
  // ===========================================================================================

  it('persistent lock + repeated appends: the anchor freezes at 1 and the SECOND write refuses', () => {
    const s = sealed();
    try {
      jamLock();
      // write 1: the anchor is still current (count 1 = count 1), so this is allowed — and its
      // post-commit mirror is the one the jam defeats
      s.memory.add({ type: 'semantic', content: 'first fact' }, { now: 2, asProposal: false });
      expect(metaCount(s.driver)).toBe(2);
      expect(extCount()).toBe(1); // frozen
      expect(s.warnings.some((w) => /further writes will refuse/.test(w))).toBe(true);

      // every write from here refuses — the divergence between the two copies cannot GROW, which
      // is what keeps a count-1-vs-count-4 store out of reach of an ordinary run
      for (const now of [3, 4, 5]) {
        expect(() =>
          s.memory.add({ type: 'semantic', content: `fact ${now}` }, { now, asProposal: false }),
        ).toThrow(/refusing to append.*external journal checkpoint is STALE/s);
      }
      expect(metaCount(s.driver)).toBe(2);
      expect(extCount()).toBe(1);
      expect(s.driver.countMemories()).toBe(1);
      expect(s.journal.verify({ heal: false }).ok).toBe(false);
      expect(s.journal.verify().ok).toBe(false); // the healing verify cannot close it either
    } finally {
      s.close();
    }
  });

  it('a successful heal restores the EXACT current bytes, and only then do writes resume', () => {
    const s = sealed();
    try {
      jamLock();
      s.memory.add({ type: 'semantic', content: 'first fact' }, { now: 2, asProposal: false });
      expect(extCount()).toBe(1);
      expect(s.journal.verify().ok).toBe(false);

      clearLock();
      expect(s.journal.verify()).toMatchObject({ ok: true, state: 'ok' });
      // BYTE equality with the live meta checkpoint — not "a checkpoint at the right count"
      expect(fs.readFileSync(cpFile, 'utf8')).toBe(s.driver.getMeta(JOURNAL_CHECKPOINT_KEY));
      expect(s.journal.verify({ heal: false })).toMatchObject({ ok: true, state: 'ok' });

      s.memory.add({ type: 'semantic', content: 'second fact' }, { now: 3, asProposal: false });
      expect(fs.readFileSync(cpFile, 'utf8')).toBe(s.driver.getMeta(JOURNAL_CHECKPOINT_KEY));
      expect(fs.readdirSync(home.home)).not.toContain('journal.checkpoint.lock');
    } finally {
      s.close();
    }
  });

  it('a failed heal that leaves the OLD PREFIX byte-identical is RED, not a deferred advance', () => {
    const s = sealed();
    let prefix = '';
    try {
      s.memory.add({ type: 'semantic', content: 'first fact' }, { now: 2, asProposal: false });
      prefix = fs.readFileSync(cpFile, 'utf8');
      s.close();
    } finally {
      // reopen so the roll-back below is the only thing that changed
    }
    const s2 = openStack();
    try {
      s2.memory.add({ type: 'semantic', content: 'second fact' }, { now: 3, asProposal: false });
      fs.writeFileSync(cpFile, prefix, { mode: 0o600 }); // roll the anchor back to the prefix
      jamLock(); // …and make the heal fail

      const v = s2.journal.verify(); // HEALING mode
      expect(v.ok, `a failed heal reported the store as verified: ${JSON.stringify(v)}`).toBe(
        false,
      );
      expect(v.reason).toMatch(/external journal checkpoint is STALE/);
      expect(fs.readFileSync(cpFile, 'utf8')).toBe(prefix); // byte-identical, nothing written
      expect(s2.journal.verify({ heal: false }).ok).toBe(false);
    } finally {
      s2.close();
    }
  });

  // ===========================================================================================
  // MUTATION GATES OTHER THAN APPEND
  // ===========================================================================================

  it('persistent lock: a consolidation batch and its rollback are BOTH refused, with zero effects', () => {
    const s = openStack();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      for (const [i, now] of [100, 101].entries()) {
        s.memory.add(
          { type: 'semantic', content: 'duplicate fixture payload', confidence: 0.9 - i * 0.1 },
          { now, asProposal: false },
        );
      }
      const batch = s.consolidate.runDeterministic({ now: 300 });
      expect(batch.exactDupes).toBe(1);
      const entry = s.driver.allJournal().find((r) => r.op === 'consolidate');
      expect(entry).toBeDefined();
      expect(s.journal.verify({ heal: false })).toMatchObject({ ok: true, state: 'ok' });
      // a SECOND duplicate pair, so the consolidation below has real work to refuse
      s.memory.add({ type: 'semantic', content: 'second pair payload' }, { now: 400 });

      // freeze the anchor one behind by defeating the NEXT mirror
      jamLock();
      s.memory.add({ type: 'semantic', content: 'second pair payload' }, { now: 401 });
      const frozen = fs.readFileSync(cpFile, 'utf8');
      const memoriesBefore = s.driver.listMemories().map((m: Memory) => ({ ...m }));

      // (a) consolidation: refused
      expect(() => s.consolidate.runDeterministic({ now: 500 })).toThrow(
        /refusing to append.*external journal checkpoint is STALE/s,
      );
      // (b) rollback: refused, and its NON-HEALING verification wrote nothing to the file
      const rb = s.consolidate.rollback(entry?.id ?? -1, 600);
      expect(rb.ok).toBe(false);
      expect(rb.reverted).toBe(0);
      expect(rb.reason).toMatch(/refusing rollback.*external journal checkpoint is STALE/s);

      expect(fs.readFileSync(cpFile, 'utf8')).toBe(frozen);
      expect(s.driver.listMemories().map((m: Memory) => ({ ...m }))).toEqual(memoriesBefore);
    } finally {
      s.close();
    }
  });

  // ===========================================================================================
  // DB-ONLY REPLAY
  // ===========================================================================================

  it('a DB-ONLY restore to an intermediate snapshot with the anchor frozen behind it is REFUSED', () => {
    // The state is planted out of band — file copies, exactly what an attacker with write access
    // to the home does — because the append gate makes it unreachable THROUGH the service: the store stops
    // accepting writes the moment the anchor stops advancing, so the database can never run ahead
    // to count 4 in the first place.
    const s = openStack();
    expect(s.journal.seal('test', 1).ok).toBe(true);
    const anchorAt1 = fs.readFileSync(cpFile, 'utf8');
    s.memory.add({ type: 'semantic', content: 'fact two' }, { now: 2, asProposal: false });
    s.close();
    const dbAt2 = home.path('snapshot-2.db');
    fs.copyFileSync(dbFile, dbAt2);

    const s2 = openStack();
    s2.memory.add({ type: 'semantic', content: 'fact three' }, { now: 3, asProposal: false });
    s2.memory.add({ type: 'semantic', content: 'fact four' }, { now: 4, asProposal: false });
    expect(metaCount(s2.driver)).toBe(4);
    s2.close();

    // plant the divergent shape: anchor frozen at 1, database at 4
    fs.writeFileSync(cpFile, anchorAt1, { mode: 0o600 });
    jamLock(); // the jam is what holds the anchor behind the database — keep it in place
    {
      const s3 = openStack();
      try {
        expect(extCount()).toBe(1);
        expect(metaCount(s3.driver)).toBe(4);
        const v = s3.journal.verify({ heal: false });
        expect(v.ok, `count-1 anchor vouched for a count-4 database: ${JSON.stringify(v)}`).toBe(
          false,
        );
        expect(v.reason).toMatch(/records 1 entry ending at #1/);
        expect(v.reason).toMatch(/database is at 4 ending at #4/);
      } finally {
        s3.close();
      }
    }

    // now the payload: restore ONLY the database, from the count-2 snapshot
    fs.copyFileSync(dbAt2, dbFile);
    fs.rmSync(`${dbFile}-wal`, { force: true });
    fs.rmSync(`${dbFile}-shm`, { force: true });

    const s4 = openStack();
    try {
      expect(metaCount(s4.driver)).toBe(2);
      expect(extCount()).toBe(1);
      const v = s4.journal.verify({ heal: false });
      expect(v.ok, `a DB-only restore verified green: ${JSON.stringify(v)}`).toBe(false);
      expect(v.reason).toMatch(/external journal checkpoint is STALE/);
      expect(s4.journal.verify().ok).toBe(false); // and the frozen anchor cannot be healed
      expect(() =>
        s4.memory.add(
          { type: 'semantic', content: 'onto the restore' },
          { now: 9, asProposal: false },
        ),
      ).toThrow(/refusing to append/);
      expect(s4.driver.allJournal()).toHaveLength(2);
      expect(extCount()).toBe(1);
    } finally {
      s4.close();
    }
  });

  // ===========================================================================================
  // CONTROLS — legitimate operation must keep working
  // ===========================================================================================

  it('a BATCHED transaction of many writes succeeds, and the anchor ends exactly current', () => {
    // The in-flight lag the invariant must preserve: inside ONE transaction the mirror is deferred
    // to the commit, so appends 2..n necessarily see a file that is behind. Making that fail would
    // break every ordinary batched write.
    const s = sealed();
    try {
      const externalWritesInTransaction: boolean[] = [];
      const raw = FileCheckpoint.prototype.replace;
      const spy = function replaceSpy(
        this: FileCheckpoint,
        expected: string | undefined,
        next: string,
        opts?: { force?: boolean },
      ): boolean {
        externalWritesInTransaction.push(s.driver.inTransaction());
        return raw.call(this, expected, next, opts);
      };
      (FileCheckpoint.prototype as { replace: typeof raw }).replace = spy as typeof raw;
      try {
        s.driver.writeTransaction(() => {
          for (const now of [2, 3, 4, 5, 6]) {
            s.memory.add(
              { type: 'semantic', content: `batched fact ${now}` },
              { now, asProposal: false },
            );
          }
        });
      } finally {
        (FileCheckpoint.prototype as { replace: typeof raw }).replace = raw;
      }
      expect(s.driver.countMemories()).toBe(5);
      expect(metaCount(s.driver)).toBe(6);
      expect(fs.readFileSync(cpFile, 'utf8')).toBe(s.driver.getMeta(JOURNAL_CHECKPOINT_KEY));
      expect(s.journal.verify({ heal: false })).toMatchObject({ ok: true, state: 'ok' });
      // and nothing was published while the transaction could still roll back
      expect(externalWritesInTransaction).not.toContain(true);
    } finally {
      s.close();
    }
  });

  it('a ROLLED-BACK batch leaves the anchor exactly where it was, and writes still work after', () => {
    const s = sealed();
    try {
      const before = fs.readFileSync(cpFile, 'utf8');
      expect(() =>
        s.driver.writeTransaction(() => {
          s.memory.add({ type: 'semantic', content: 'doomed one' }, { now: 2, asProposal: false });
          s.memory.add({ type: 'semantic', content: 'doomed two' }, { now: 3, asProposal: false });
          throw new Error('caller aborted');
        }),
      ).toThrow('caller aborted');
      expect(fs.readFileSync(cpFile, 'utf8')).toBe(before); // the queued mirror never ran
      expect(s.driver.countMemories()).toBe(0);
      expect(s.journal.verify({ heal: false })).toMatchObject({ ok: true, state: 'ok' });

      s.memory.add({ type: 'semantic', content: 'a real fact' }, { now: 4, asProposal: false });
      expect(fs.readFileSync(cpFile, 'utf8')).toBe(s.driver.getMeta(JOURNAL_CHECKPOINT_KEY));
    } finally {
      s.close();
    }
  });

  it('no lock or tmp debris survives any of the refusals', () => {
    const s = sealed();
    try {
      fs.rmSync(cpFile, { force: true });
      expect(() =>
        s.memory.add({ type: 'semantic', content: 'x' }, { now: 2, asProposal: false }),
      ).toThrow(/refusing to append/);
      expect(s.journal.verify()).toMatchObject({ ok: true, state: 'ok' });
      s.memory.add({ type: 'semantic', content: 'x' }, { now: 3, asProposal: false });
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
