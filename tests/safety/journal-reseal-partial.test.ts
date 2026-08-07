import fs from 'node:fs';
import path from 'node:path';
import {
  type CheckpointStore,
  JOURNAL_CHECKPOINT_KEY,
  JournalService,
  type StorageDriver,
} from '@sthayi/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileCheckpoint } from '../../packages/cli/src/drivers/checkpoint-file.js';
import { NodeCrypto } from '../../packages/cli/src/drivers/crypto.js';
import { SqliteDriver } from '../../packages/cli/src/drivers/sqlite.js';
import { type FakeHome, createFakeHome } from '../helpers/fake-home.js';
import { removeOwned } from '../helpers/owned-fs.js';

/**
 * SAFETY: `sthayi journal reseal` has TWO halves and only one of them is transactional.
 *
 * The database half — the auditable `journal_seal` entry plus the meta checkpoint — commits under
 * the writer lock. The external checkpoint file is a separate write that a live lock, an I/O error
 * or a hostile destination can defeat entirely on its own. The two cannot be made atomic.
 *
 * WHAT A FIRE-AND-FORGET FLUSH WOULD COST. If the forced flush were void plus a best-effort
 * warning, a reseal whose file write never landed would still return `{ ok: true }` and the CLI
 * would still print "authenticated checkpoint rewritten (store meta + journal.checkpoint file)" —
 * while the file still held the very tamper evidence the reseal was run to clear, and a fresh
 * verify() came back RED. Reseal is the command an owner runs precisely when they suspect tampering,
 * so a false success here is the worst possible answer.
 *
 * INVARIANT: the forced flush returns an EXPLICIT OUTCOME, and success is reported ONLY after the
 * file has been READ BACK and confirmed to hold exactly the new authenticated checkpoint. A
 * committed-database/failed-file outcome is an honest PARTIAL FAILURE — never a success, never a
 * plain refusal. Every row below finishes with a FRESH verify() proving the reported state is the
 * real one.
 */
describe('safety: reseal reports a partial failure instead of a false success', () => {
  let home: FakeHome;
  let file: string;
  let cpFile: string;

  beforeEach(() => {
    home = createFakeHome();
    file = home.path('sthayi.db');
    cpFile = home.path('journal.checkpoint');
  });
  afterEach(() => {
    removeOwned(`${cpFile}.lock`);
    home.cleanup();
  });

  /** Shape-valid v1 checkpoint JSON whose MAC was never minted under this vault's key: the state
   *  an operator actually runs `journal reseal` to clear. */
  const BAD_MAC = JSON.stringify({
    v: 1,
    count: 9,
    tipId: 9,
    tipHash: 'f'.repeat(64),
    mac: 'not-a-mac-this-key-ever-produced',
  });

  const LOCK_HELD = 'journal checkpoint lock is held by another writer';

  /** A checkpoint store whose replacement always fails — the live-lock / write-failure model. */
  class FailingCheckpoint implements CheckpointStore {
    readonly inner: FileCheckpoint;
    constructor(
      p: string,
      private readonly mode: 'throw' | 'refuse',
    ) {
      this.inner = new FileCheckpoint(p);
    }
    read(): string | undefined {
      return this.inner.read();
    }
    write(): void {
      if (this.mode === 'throw') {
        throw new Error(LOCK_HELD);
      }
    }
    replace(): boolean {
      if (this.mode === 'throw') {
        throw new Error(LOCK_HELD);
      }
      return false;
    }
  }

  /** A driver that predates post-commit callbacks: the flush cannot run inside the transaction. */
  function withoutAfterCommit(driver: SqliteDriver): StorageDriver {
    return new Proxy(driver, {
      get(target, prop) {
        if (prop === 'afterCommit') {
          return undefined;
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as unknown as StorageDriver;
  }

  interface Stack {
    driver: SqliteDriver;
    journal: JournalService;
    warnings: string[];
    close(): void;
  }

  function open(opts?: { external?: CheckpointStore; legacy?: boolean }): Stack {
    const driver = SqliteDriver.open(file);
    driver.migrate();
    const warnings: string[] = [];
    const journal = new JournalService(
      opts?.legacy === true ? withoutAfterCommit(driver) : driver,
      {
        crypto: NodeCrypto.open(home.path('key')),
        external: opts?.external ?? new FileCheckpoint(cpFile),
        warn: (m) => warnings.push(m),
      },
    );
    return { driver, journal, warnings, close: () => driver.close() };
  }

  /** A sealed store with two more entries, then the given bytes planted in the file. */
  function seed(external: string): void {
    const s = open();
    try {
      expect(s.journal.seal('test', 1).ok).toBe(true);
      s.journal.append({ ts: 2, actor: 'cli', op: 'memory_write', payload: { ids: [] } });
      s.journal.append({ ts: 3, actor: 'cli', op: 'memory_write', payload: { ids: [] } });
    } finally {
      s.close();
    }
    fs.writeFileSync(cpFile, external, { mode: 0o600 });
  }

  /** The verdict a completely fresh reader reaches — reality, independent of the reseal's report. */
  function freshVerify(): { ok: boolean; reason?: string } {
    const s = open();
    try {
      return s.journal.verify({ heal: false });
    } finally {
      s.close();
    }
  }

  it('a live-locked file write over TAMPER EVIDENCE: partial failure, file intact, verify RED', () => {
    seed(BAD_MAC);
    const s = open({ external: new FailingCheckpoint(cpFile, 'throw') });
    let entries = 0;
    try {
      const r = s.journal.seal('owner', 9);
      expect(r.ok, `reseal claimed success: ${JSON.stringify(r)}`).toBe(false);
      expect(r.partial).toBe(true);
      expect(r.external).toBe('failed');
      expect(r.reason).toMatch(/the database was resealed but the file was NOT/);
      expect(r.reason).toContain(LOCK_HELD); // the cause is carried, not swallowed
      expect(r.entries).toBe(4);
      entries = s.driver.allJournal().length;
      // the tamper evidence is untouched — the reseal did not destroy it on its way out
      expect(fs.readFileSync(cpFile, 'utf8')).toBe(BAD_MAC);
    } finally {
      s.close();
    }
    // the database half IS durable (that is why the result is partial, not a refusal)…
    expect(entries).toBe(4);
    // …and reality agrees with the report: still red, exactly as the partial result implies
    const v = freshVerify();
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/external journal checkpoint tampered/);
  });

  it('a REFUSED (non-throwing) file replacement is a partial failure too', () => {
    seed(BAD_MAC);
    const s = open({ external: new FailingCheckpoint(cpFile, 'refuse') });
    try {
      const r = s.journal.seal('owner', 9);
      expect(r.ok, `reseal claimed success: ${JSON.stringify(r)}`).toBe(false);
      expect(r.partial).toBe(true);
      expect(r.external).toBe('refused');
      expect(fs.readFileSync(cpFile, 'utf8')).toBe(BAD_MAC);
    } finally {
      s.close();
    }
    expect(freshVerify().ok).toBe(false);
  });

  it('a JAMMED LOCK on the real FileCheckpoint: partial failure, file intact, verify RED', () => {
    seed(BAD_MAC);
    // a lock path that is not a regular file — the store fails closed on it, no timing involved
    fs.mkdirSync(`${cpFile}.lock`);
    const s = open();
    try {
      const r = s.journal.seal('owner', 9);
      expect(r.ok, `reseal claimed success: ${JSON.stringify(r)}`).toBe(false);
      expect(r.partial).toBe(true);
      expect(r.external).toBe('failed');
      expect(fs.readFileSync(cpFile, 'utf8')).toBe(BAD_MAC);
    } finally {
      s.close();
    }
    expect(freshVerify().ok).toBe(false);
  });

  it('a failed file write is PARTIAL even when verification would still be green', () => {
    // The file is a legitimate lagging ANCESTOR, so verify() heals it and reports green. The
    // reseal still did only half of what it said it would, and must say so: the CLI's claim is
    // about the FILE, not about the next verdict.
    seed(BAD_MAC);
    const ancestor = (() => {
      const s = open();
      try {
        fs.rmSync(cpFile, { force: true });
        expect(s.journal.seal('owner', 4).ok).toBe(true); // a clean reseal writes both copies
        return fs.readFileSync(cpFile, 'utf8');
      } finally {
        s.close();
      }
    })();

    const s = open({ external: new FailingCheckpoint(cpFile, 'throw') });
    try {
      const r = s.journal.seal('owner', 9);
      expect(r.ok, `reseal claimed success: ${JSON.stringify(r)}`).toBe(false);
      expect(r.partial).toBe(true);
      expect(fs.readFileSync(cpFile, 'utf8')).toBe(ancestor); // never advanced
    } finally {
      s.close();
    }
    // healing verify goes green (the file is a genuine ancestor) — which is exactly why the
    // reseal's own report may not be derived from it
    const s2 = open();
    try {
      expect(s2.journal.verify()).toMatchObject({ ok: true, state: 'ok' });
    } finally {
      s2.close();
    }
  });

  // -------------------------------------------------------------------------------------------
  // The other half of the contract: a reseal that DID write both copies still reports success,
  // and still exercises its explicit trust decision.
  // -------------------------------------------------------------------------------------------

  it('a complete reseal reports ok with an explicit written outcome, and clears the evidence', () => {
    seed(BAD_MAC);
    const s = open();
    try {
      const r = s.journal.seal('owner', 9);
      expect(r).toMatchObject({ ok: true, entries: 4, external: 'written' });
      expect(r.partial).toBeUndefined();
      // force IS the explicit trust decision: unauthentic bytes are replaced, which is the whole
      // point of the command (ordinary appends must never do this — asserted below)
      expect(fs.readFileSync(cpFile, 'utf8')).toBe(
        s.driver.getMeta(JOURNAL_CHECKPOINT_KEY) as string,
      );
    } finally {
      s.close();
    }
    expect(freshVerify().ok).toBe(true);
  });

  it('a legacy driver DEFERS the flush — the reseal resolves it instead of claiming it', () => {
    seed(BAD_MAC);
    const s = open({ legacy: true });
    try {
      const r = s.journal.seal('owner', 9);
      expect(r).toMatchObject({ ok: true, external: 'written' });
      expect(fs.readFileSync(cpFile, 'utf8')).not.toBe(BAD_MAC);
    } finally {
      s.close();
    }
    expect(freshVerify().ok).toBe(true);
  });

  it('an ordinary append and a healing verify still never make the trust decision', () => {
    seed(BAD_MAC);
    const s = open();
    try {
      expect(() =>
        s.journal.append({ ts: 5, actor: 'cli', op: 'memory_write', payload: { ids: [] } }),
      ).toThrow(/refusing to append/);
      expect(s.journal.verify().ok).toBe(false);
      expect(fs.readFileSync(cpFile, 'utf8')).toBe(BAD_MAC); // neither path overwrote it
      expect(s.driver.allJournal()).toHaveLength(3); // and nothing was appended
    } finally {
      s.close();
    }
  });

  it('no lock or tmp debris survives a partial reseal', () => {
    seed(BAD_MAC);
    const s = open({ external: new FailingCheckpoint(cpFile, 'throw') });
    try {
      expect(s.journal.seal('owner', 9).partial).toBe(true);
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
