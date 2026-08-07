import fs from 'node:fs';
import path from 'node:path';
import { JournalService } from '@sthayi/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileCheckpoint } from '../../packages/cli/src/drivers/checkpoint-file.js';
import { NodeCrypto } from '../../packages/cli/src/drivers/crypto.js';
import { SqliteDriver } from '../../packages/cli/src/drivers/sqlite.js';
import { type FakeHome, createFakeHome } from '../helpers/fake-home.js';

/**
 * SAFETY: a writable session may not report a store as verified while it has NO external
 * checkpoint and could not create one.
 *
 * The external copy is the only anchor that survives WHOLE-DATABASE replacement — the meta copy
 * lives inside the very database an attacker would be swapping. So "no external anchor" is not a
 * cosmetic lag: it is the loss of the guarantee the copy exists to provide.
 *
 * The shape this pins: the external file is absent (so the heal is a CREATE, not an advance) and
 * the create THROWS. Re-reading finds the path still absent — identical to what the verification
 * originally read — so a "did anything change under me?" comparison alone concludes "nothing
 * changed" and keeps the green verdict, even though the anchor was never installed and something
 * is actively preventing it. A directory planted at `journal.checkpoint.lock` does exactly that,
 * permanently and with no privileges beyond writing the home.
 *
 * INVARIANT: absent is RED, and it is red for EVERY session. A writable one is told the anchor
 * could not be written and what is blocking it; doctor's read-only open (`externalReadOnly`) is
 * told the anchor is missing, without being blamed for a write it could never perform. What that
 * flag must never do is convert "I am not allowed to write" into a green integrity check over a
 * store with no off-database anchor — the missing anchor is a fact about the store, not about the
 * observer. A read-only session on a store whose anchor IS current stays green, which is the
 * property the flag actually exists for.
 */
describe('safety: a writable session never reports ok while the external anchor is missing', () => {
  let home: FakeHome;
  let dbFile: string;
  let cpFile: string;

  beforeEach(() => {
    home = createFakeHome();
    dbFile = home.path('sthayi.db');
    cpFile = home.path('journal.checkpoint');
  });
  afterEach(() => {
    home.cleanup();
  });

  /** A sealed store with a real chain, then the external copy removed and its creation blocked. */
  function sealedStoreWithBlockedAnchor(): {
    journal: (readOnly: boolean) => JournalService;
    close: () => void;
  } {
    const driver = SqliteDriver.open(dbFile);
    driver.migrate();
    const crypto = NodeCrypto.open(home.path('key'));
    const make = (readOnly: boolean): JournalService => {
      const file = new FileCheckpoint(cpFile);
      return new JournalService(driver, {
        crypto,
        external: readOnly
          ? {
              read: () => file.read(),
              write: () => {
                throw new Error(
                  'read-only session — refusing to write the journal checkpoint file',
                );
              },
            }
          : file,
        externalReadOnly: readOnly,
      });
    };
    make(false).seal('test', 1000);
    return { journal: make, close: () => driver.close() };
  }

  /** Jam the lock so every replacement fails closed: a DIRECTORY cannot be opened O_CREAT|O_EXCL. */
  function jamLock(): void {
    fs.mkdirSync(`${cpFile}.lock`, { recursive: true });
  }

  it('external absent + creation blocked: verify() is RED and names the blocking lock', () => {
    const s = sealedStoreWithBlockedAnchor();
    try {
      expect(s.journal(false).verify()).toMatchObject({ ok: true }); // healthy to begin with
      fs.rmSync(cpFile, { force: true });
      jamLock();

      const v = s.journal(false).verify();
      expect(v.ok).toBe(false);
      expect(v.reason).toMatch(/absent and could not be written/);
      expect(v.reason).toMatch(/journal\.checkpoint\.lock/);
      // and the refusal wrote nothing: the anchor is still absent, the jam is untouched
      expect(fs.existsSync(cpFile)).toBe(false);
      expect(fs.lstatSync(`${cpFile}.lock`).isDirectory()).toBe(true);
    } finally {
      s.close();
    }
  });

  it('a read-only session is ALSO red — it just does not blame the write it cannot perform', () => {
    // `externalReadOnly` suppresses BLAME, not the verdict. Whether an off-database anchor exists
    // is a property of the STORE, identical for every observer, so a read-only session that
    // reported 'ok' here would be doctor telling the user the whole-database-replacement guarantee
    // is in place while nothing outside the database vouches for the store at all. What the flag
    // still buys: the reason describes the MISSING FILE, never "the heal could not be written",
    // because this session could never have written it.
    const s = sealedStoreWithBlockedAnchor();
    try {
      fs.rmSync(cpFile, { force: true });
      jamLock();
      const v = s.journal(true).verify();
      expect(v.ok).toBe(false);
      expect(v.reason).toMatch(/NO checkpoint file outside it/);
      expect(v.reason).not.toMatch(/could not be written/);
      expect(fs.existsSync(cpFile)).toBe(false); // still created nothing
    } finally {
      s.close();
    }
  });

  it('a read-only session on a healthy store is GREEN — observation is not a verdict', () => {
    // The other half of the same rule: the flag must not turn every read-only inspection of a
    // perfectly anchored store into a failure just because this session cannot write.
    const s = sealedStoreWithBlockedAnchor();
    try {
      jamLock(); // no heal is possible — and none is needed, the anchor is already current
      expect(s.journal(true).verify()).toMatchObject({ ok: true, state: 'ok' });
    } finally {
      s.close();
    }
  });

  it('once the block is cleared, a writable verify() heals the anchor and returns green', () => {
    const s = sealedStoreWithBlockedAnchor();
    try {
      fs.rmSync(cpFile, { force: true });
      jamLock();
      expect(s.journal(false).verify().ok).toBe(false);

      fs.rmSync(`${cpFile}.lock`, { recursive: true, force: true });
      const v = s.journal(false).verify();
      expect(v).toMatchObject({ ok: true, state: 'ok' });
      expect(fs.existsSync(cpFile)).toBe(true);
      expect(fs.readdirSync(path.dirname(cpFile))).not.toContain('journal.checkpoint.lock');
    } finally {
      s.close();
    }
  });
});
