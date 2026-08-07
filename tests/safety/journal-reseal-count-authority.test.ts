import { JournalService } from '@sthayi/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileCheckpoint } from '../../packages/cli/src/drivers/checkpoint-file.js';
import { NodeCrypto } from '../../packages/cli/src/drivers/crypto.js';
import { SqliteDriver } from '../../packages/cli/src/drivers/sqlite.js';
import { buildProgram } from '../../packages/cli/src/index.js';
import { openStore } from '../../packages/cli/src/store.js';
import { type FakeHome, createFakeHome } from '../helpers/fake-home.js';

/**
 * SAFETY: the number `journal reseal` prints describes the history the seal ACCEPTED.
 *
 * THE HAZARD. Reseal is an explicit trust decision, and the count it reports is the only
 * description the owner gets of what they just blessed — they read it, compare it against what they
 * believe is in the store, and treat a match as confirmation. The store is shared: a peer process
 * (another client's MCP session, a second terminal) can commit its own journal entry at any moment,
 * and the seal's snapshot is taken under the writer lock at the seal itself. A count sampled BEFORE
 * that snapshot therefore describes a store that no longer exists by the time the checkpoint is
 * minted — it is smaller than the history actually accepted, and the owner is told they blessed
 * fewer entries than they did. That is the wrong way for this number to be wrong: it invites
 * "looks right, nothing extra got in" about a reseal that covered a peer's write.
 *
 * THE INVARIANT. The reported count comes from the transaction that sealed — the same rows the new
 * authenticated checkpoint covers, including the seal's own auditable entry — never from a read
 * taken before it. What the command prints and what `sthayi journal verify` counts are the same
 * number, on a quiet store and on a busy one.
 *
 * The interleaving is FORCED, not awaited: the peer commits inside the call boundary between the
 * command's own work and the seal, so the window is entered on every run regardless of timing.
 */
describe('safety: reseal reports the count the seal accepted, not a pre-seal sample', () => {
  let home: FakeHome;
  let chunks: string[];
  let outSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let sealSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    home = createFakeHome();
    chunks = [];
    outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    }) as ReturnType<typeof vi.spyOn>;
    errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    }) as ReturnType<typeof vi.spyOn>;
  });

  afterEach(() => {
    sealSpy?.mockRestore();
    sealSpy = undefined;
    outSpy.mockRestore();
    errSpy.mockRestore();
    process.exitCode = undefined;
    home.cleanup();
  });

  /** Give the store a history worth describing, and report how many entries it holds. */
  function seed(): number {
    const s = openStore();
    try {
      s.journal.append({ ts: 2, actor: 'cli', op: 'memory_write', payload: { ids: [] } });
      s.journal.append({ ts: 3, actor: 'cli', op: 'memory_write', payload: { ids: [] } });
      return s.driver.allJournal().length;
    } finally {
      s.close();
    }
  }

  /**
   * A SEPARATE writer on the same store, holding its own connection, key handle and checkpoint
   * file handle — the peer whose entry the reseal is about to inherit.
   */
  function peerAppends(): void {
    const driver = SqliteDriver.open(home.path('sthayi.db'));
    try {
      const journal = new JournalService(driver, {
        crypto: NodeCrypto.open(home.path('key')),
        external: new FileCheckpoint(home.path('journal.checkpoint')),
        warn: () => {
          // a peer's own anchor warnings are not this store's report
        },
      });
      journal.append({ ts: 4, actor: 'peer', op: 'memory_write', payload: { ids: [] } });
    } finally {
      driver.close();
    }
  }

  /**
   * Force the peer into the window the command opens: it commits when the explicit reseal is
   * entered, after everything the command did on its own behalf and before the sealing
   * transaction takes its snapshot. Deterministic — a call boundary, not a delay.
   *
   * The store's automatic first-use seal (`onlyIfMissing`) is left alone: it is not the trust
   * decision under test, and it runs while the command is still opening the store.
   */
  function peerCommitsBeforeTheSeal(): void {
    const original = JournalService.prototype.seal;
    let fired = false;
    sealSpy = vi.spyOn(JournalService.prototype, 'seal').mockImplementation(function (
      this: JournalService,
      actor: string,
      now: number,
      opts?: { onlyIfMissing?: boolean },
    ) {
      if (opts?.onlyIfMissing !== true && !fired) {
        fired = true;
        peerAppends();
      }
      return original.call(this, actor, now, opts);
    }) as ReturnType<typeof vi.spyOn>;
  }

  /** The count the command printed, or `undefined` when it never claimed success. */
  function reportedCount(text: string): number | undefined {
    const m = /resealed: accepted (\d+) journal entr(?:y|ies) as trusted history\./.exec(text);
    return m === null ? undefined : Number.parseInt(m[1] as string, 10);
  }

  /** What the store really holds, read by a reader that took no part in the reseal. */
  function actualEntries(): number {
    const s = openStore();
    try {
      return s.driver.allJournal().length;
    } finally {
      s.close();
    }
  }

  it('a peer that commits between the command and the seal is INSIDE the reported count', async () => {
    const seeded = seed();
    peerCommitsBeforeTheSeal();

    await buildProgram().parseAsync(['node', 'sthayi', 'journal', 'reseal']);

    sealSpy?.mockRestore();
    sealSpy = undefined;
    const all = chunks.join('');
    expect(all, `reseal did not succeed: ${all}`).toContain('resealed: accepted');
    expect(process.exitCode).toBeUndefined();

    // The peer's entry and the seal's own entry are both part of the history the checkpoint now
    // covers, so both are part of what the owner was told they accepted.
    const printed = reportedCount(all);
    expect(printed).toBe(seeded + 2);
    // …which is the store as it really stands, not the store as it stood before the seal.
    expect(printed).toBe(actualEntries());
    expect(printed).not.toBe(seeded);
    expect(all, 'reported a count sampled before the seal').not.toContain(
      `accepted ${seeded} journal entries`,
    );

    // And the reseal did what it claimed: a fresh verify agrees, over the same number of entries.
    chunks.length = 0;
    await buildProgram().parseAsync(['node', 'sthayi', 'journal', '--verify']);
    const verified = chunks.join('');
    expect(verified).toContain('chain + authenticated checkpoint intact');
    expect(verified).toContain(`journal OK — ${printed} entries`);
    expect(process.exitCode).toBe(0);
  });

  it('on a quiet store the reported count is still the sealed history, verify agreeing', async () => {
    const seeded = seed();

    await buildProgram().parseAsync(['node', 'sthayi', 'journal', 'reseal']);

    const all = chunks.join('');
    const printed = reportedCount(all);
    // the seal's own auditable entry is part of the history the checkpoint covers
    expect(printed).toBe(seeded + 1);
    expect(printed).toBe(actualEntries());

    chunks.length = 0;
    await buildProgram().parseAsync(['node', 'sthayi', 'journal', '--verify']);
    expect(chunks.join('')).toContain(`journal OK — ${printed} entries`);
    expect(process.exitCode).toBe(0);
  });
});
