import fs from 'node:fs';
import { JournalService, MemoryService } from '@sthayi/core';
import Database from 'better-sqlite3';
import { type MockInstance, afterEach, describe, expect, it, vi } from 'vitest';
import { FileCheckpoint } from '../../packages/cli/src/drivers/checkpoint-file.js';
import { NodeCrypto } from '../../packages/cli/src/drivers/crypto.js';
import { SqliteDriver } from '../../packages/cli/src/drivers/sqlite.js';
import {
  PII_REMASK_DONE,
  PII_REMASK_LEGACY_META_KEY,
  PII_REMASK_META_KEY,
  PII_REMASK_ROWS_DONE,
  openStore,
} from '../../packages/cli/src/store.js';
import { type FakeHome, createFakeHome } from '../helpers/fake-home.js';

/**
 * SAFETY: the legacy-unmasked-store PII migration — the TWO-PHASE, RETRYABLE shape. Stores
 * written by a build that predates at-rest PII masking hold plaintext PII in memory
 * content/scope/source/provenance. Opening such a store through the real openStore() must:
 *
 *  - phase 1 (one atomic transaction): remask the rows to vault pseudonyms, mint entities,
 *    append EXACTLY ONE `migrate_masking` journal entry across the whole saga (only when rows
 *    actually changed), and set the state to 'rows-done';
 *  - phase 2: FTS rebuild + VACUUM + WAL TRUNCATE-checkpoint + byte verification — and ONLY
 *    after all of it succeeds flip the state to the final 'scrubbed'. Any injected failure must
 *    leave the state pending (honestly detectable), warn, and the next open must retry to
 *    completion — never a final flag over plaintext remnants;
 *  - the plaintext must be gone from the db AND WAL bytes WHILE THE STORE IS STILL OPEN — flipping
 *    the flag before the scrub, or verifying only after close, proves nothing about the live file;
 *  - the scrub must run on the GATED connection: a bare `new Database(file)` reopen would bypass
 *    the open() trust gate, so there is no reopen at all.
 *
 * THE MARKER IS VERSIONED AND ONLY THE CURRENT VERSION IS EVIDENCE. A legacy build stamped its
 * FINAL value under the v1 key whenever the row pass changed zero rows, so `pii_remask_v1 =
 * 'scrubbed'` can sit on a database that was never physically scrubbed. Every state except the
 * CURRENT key's final value must therefore run both phases — pinned by the upgrade matrix and by
 * the freed-page probes below, which carry that exact v1 marker.
 *
 * PHASE 2 IS UNCONDITIONAL: "zero rows changed" is a statement about current row VALUES and says
 * nothing about the file's BYTES, and there is NO bypass at all — not even for a store this
 * process just created. A freshness bypass (lstat the database path before opening it, treat
 * absence as proof that no legacy byte can exist) is a check/open TOCTOU window, so none exists;
 * a brand-new store just runs the empty row pass and one cheap scrub, once.
 *
 * THE MARKER'S VALUE IS PARSED, NOT PROBED FOR DEFINEDNESS. 'scrubbed' skips both phases;
 * 'rows-done' skips the row pass and runs the scrub; absent, UNKNOWN or corrupt runs both. A
 * defined-but-unrecognized value ('garbage-state') is the hostile case pinned below: probing for
 * definedness alone would skip the row remask, leave live plaintext in memory rows, and then
 * promote the store to 'scrubbed'.
 *
 * SCOPE (visible by design): the migration covers memory rows only. Journal history is
 * append-only and never rewritten — pinned below as an explicit compatibility boundary.
 */

const PII = {
  email: 'legacy.pii@example-leak.io',
  phone: '+15550998877',
  ssn: '987-65-4321',
};
/** Byte needles that must vanish from the database file (phone normalized sans '+'). */
const NEEDLES = ['legacy.pii@example-leak.io', '15550998877', '987-65-4321'];
/** A marker value this build never writes: DEFINED, unrecognized, and therefore NOT evidence. */
const UNKNOWN_MARKER = 'garbage-state';

/**
 * Seed the store EXACTLY as a legacy unmasked build wrote it: MemoryService constructed WITHOUT
 * a vault, so content/scope/source/provenance land plaintext, while the journal (crypto +
 * external checkpoint file) works as it always did. Uses the same on-disk paths openStore uses.
 */
function seedLegacyStore(home: FakeHome): void {
  const driver = SqliteDriver.open(home.path('sthayi.db'));
  driver.migrate();
  const crypto = NodeCrypto.open(home.path('key'));
  const journal = new JournalService(driver, {
    crypto,
    external: new FileCheckpoint(home.path('journal.checkpoint')),
  });
  const memory = new MemoryService(driver, journal); // NO vault — the legacy unmasked build
  memory.write(
    [
      {
        type: 'semantic',
        content: `email me at ${PII.email} about the launch`,
        scope: 'user',
      },
      {
        type: 'episodic',
        content: `call ${PII.phone} before noon`,
        source: `note from ${PII.email}`,
        provenance: { source: 'chat', note: `ssn on file: ${PII.ssn}` },
      },
    ],
    { now: 1_700_000_000_000, actor: 'cli', asProposal: false },
  );
  driver.close();
}

/**
 * Seed a PRE-EXISTING store whose rows hold nothing sensitive: the row pass will change nothing
 * and journal nothing, so what a marker state costs shows up purely as work done or skipped.
 */
function seedBenignStore(home: FakeHome): void {
  const driver = SqliteDriver.open(home.path('sthayi.db'));
  driver.migrate();
  const crypto = NodeCrypto.open(home.path('key'));
  const journal = new JournalService(driver, {
    crypto,
    external: new FileCheckpoint(home.path('journal.checkpoint')),
  });
  new MemoryService(driver, journal).write(
    [{ type: 'semantic', content: 'nothing sensitive here', scope: 'user' }],
    { now: 1_700_000_000_000, actor: 'cli', asProposal: false },
  );
  driver.close();
}

function dbAndWalBytes(home: FakeHome): Buffer {
  const db = home.path('sthayi.db');
  const wal = `${db}-wal`;
  return Buffer.concat([
    fs.readFileSync(db),
    fs.existsSync(wal) ? fs.readFileSync(wal) : Buffer.alloc(0),
  ]);
}

function migrationEvents(driver: SqliteDriver) {
  return driver.allJournal().filter((r) => r.op === 'migrate_masking');
}

/**
 * Rewrite the store's migration markers with RAW SQL. This is the only way to reconstruct the
 * marker states legacy builds left behind: the current build never writes the v1 key at all, and
 * has no API for clearing a meta row. `null` deletes the key.
 */
function setMarkers(home: FakeHome, markers: Record<string, string | null>): void {
  const raw = new Database(home.path('sthayi.db'));
  try {
    for (const [key, value] of Object.entries(markers)) {
      if (value === null) {
        raw.prepare('DELETE FROM meta WHERE k = ?').run(key);
      } else {
        raw
          .prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = ?')
          .run(key, value, value);
      }
    }
  } finally {
    raw.close();
  }
}

/**
 * Plant a marker whose CELL IS NOT A STRING — the corrupt-state case. No API can produce this;
 * only a foreign writer, a partially-written cell or bit rot can, which is precisely why the
 * migration must not assume the value it reads is one it wrote.
 */
function setCorruptMarker(home: FakeHome, key: string, value: number): void {
  const raw = new Database(home.path('sthayi.db'));
  try {
    raw
      .prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = ?')
      .run(key, value, value);
  } finally {
    raw.close();
  }
}

/** Read a marker straight from the file, without opening (and thus migrating) the store. */
function readMarker(home: FakeHome, key: string): string | undefined {
  const raw = new Database(home.path('sthayi.db'));
  try {
    return (raw.prepare('SELECT v FROM meta WHERE k = ?').get(key) as { v: string } | undefined)?.v;
  } finally {
    raw.close();
  }
}

describe('safety: legacy unmasked stores are remasked on open (two-phase)', () => {
  it('openStore remasks rows, mints entities, journals ONCE, reaches the FINAL state; bytes clean WHILE OPEN; second open is a no-op', () => {
    const home = createFakeHome();
    try {
      seedLegacyStore(home);
      // Precondition — the seed really is plaintext at rest and unflagged (a legacy unmasked db)
      const before = dbAndWalBytes(home);
      for (const needle of NEEDLES) {
        expect(before.includes(Buffer.from(needle)), `seed lost ${needle}`).toBe(true);
      }

      const store = openStore();
      let journalLen: number;
      try {
        // PII gone from the db AND WAL bytes WHILE THE STORE IS STILL OPEN — the scrub and its
        // verification ran before openStore returned, not at close time.
        const openBytes = dbAndWalBytes(home);
        for (const needle of NEEDLES) {
          expect(openBytes.includes(Buffer.from(needle)), `${needle} in bytes while open`).toBe(
            false,
          );
        }

        // rows re-masked: pseudonyms in, plaintext out — content, scope stays, source, provenance
        const memories = store.driver.listMemories();
        expect(memories).toHaveLength(2);
        const dump = JSON.stringify(memories);
        for (const needle of NEEDLES) {
          expect(dump.includes(needle), `${needle} survived in a memory row`).toBe(false);
        }
        expect(dump).toMatch(/EMAIL_\d\d/);
        expect(dump).toMatch(/PHONE_\d\d/);
        expect(dump).toMatch(/SSN_\d\d/);

        // entities minted, canonicals recoverable locally
        const mappings = store.vault.listMappings();
        expect(mappings.some((m) => m.kind === 'EMAIL' && m.value === PII.email)).toBe(true);
        expect(mappings.some((m) => m.kind === 'PHONE')).toBe(true);
        expect(mappings.some((m) => m.kind === 'SSN' && m.value === PII.ssn)).toBe(true);

        // exactly ONE migrate_masking entry, with the remask count and the honest scope
        // (memory rows only — journal history is never rewritten); the chain still verifies
        const migrations = migrationEvents(store.driver);
        expect(migrations).toHaveLength(1);
        const payload = migrations[0]?.payload as { remasked?: number; scope?: string };
        expect(payload.remasked).toBe(2);
        expect(payload.scope).toBe('memory-rows');
        expect(store.journal.verify().ok).toBe(true);

        // the FINAL state — both phases proven, the migration never runs again
        expect(store.driver.getMeta(PII_REMASK_META_KEY)).toBe(PII_REMASK_DONE);

        // masked rows are still searchable (the FTS index was rebuilt, not orphaned)
        const hits = store.memory.search('launch', { now: Date.now(), bump: false });
        expect(hits.length).toBeGreaterThan(0);

        journalLen = store.driver.allJournal().length;
      } finally {
        store.close();
      }

      // still clean after close, including superseded FTS segments and freed pages
      const after = dbAndWalBytes(home);
      for (const needle of NEEDLES) {
        expect(after.includes(Buffer.from(needle)), `${needle} still in db bytes`).toBe(false);
      }
      // and every text column is clean too
      const raw = new Database(home.path('sthayi.db'));
      const dump = ['memories', 'memories_fts', 'journal', 'entities', 'meta']
        .map((t) => {
          try {
            return JSON.stringify(raw.prepare(`SELECT * FROM ${t}`).all());
          } catch {
            return '';
          }
        })
        .join('\n');
      raw.close();
      for (const needle of NEEDLES) {
        expect(dump.includes(needle), `${needle} still in a SQLite text column`).toBe(false);
      }

      // second open: idempotent — no new migrate_masking entry, no journal growth
      const store2 = openStore();
      try {
        expect(store2.driver.allJournal().length).toBe(journalLen);
        expect(migrationEvents(store2.driver)).toHaveLength(1);
        expect(store2.journal.verify().ok).toBe(true);
      } finally {
        store2.close();
      }
    } finally {
      home.cleanup();
    }
  });

  it('a BRAND-NEW store runs the sequence like everything else — no freshness bypass — and journals nothing; the second open is free', () => {
    // THERE IS NO FRESHNESS PROOF AT ALL. lstat()ing the database path before
    // SqliteDriver.open() creates it and stamping the final marker on the strength of that
    // snapshot is a check/open TOCTOU window (see the interleaving test below), so no such
    // shortcut exists: a fresh store has zero rows, so the row pass short-circuits without a
    // scan, and it pays exactly ONE cheap scrub, once in its life. What must NOT change: a fresh
    // store journals nothing, ever.
    const home = createFakeHome();
    const scan = vi.spyOn(SqliteDriver.prototype, 'listMemories');
    const vacuum = vi.spyOn(SqliteDriver.prototype, 'vacuum');
    const fts = vi.spyOn(SqliteDriver.prototype, 'rebuildMemoryFts');
    try {
      let journalLen: number;
      const store = openStore();
      try {
        expect(store.driver.getMeta(PII_REMASK_META_KEY)).toBe(PII_REMASK_DONE);
        expect(migrationEvents(store.driver)).toHaveLength(0);
        journalLen = store.driver.allJournal().length;
        expect(store.journal.verify().ok).toBe(true);
      } finally {
        store.close();
      }
      // the marker was EARNED: the scrub really ran, exactly once, with no row scan (zero rows)
      expect(vacuum).toHaveBeenCalledTimes(1);
      expect(fts).toHaveBeenCalledTimes(1);
      expect(scan).not.toHaveBeenCalled();

      // reopen: the final state short-circuits everything — no second scrub, no journal growth
      const store2 = openStore();
      try {
        expect(migrationEvents(store2.driver)).toHaveLength(0);
        expect(store2.driver.allJournal().length).toBe(journalLen);
      } finally {
        store2.close();
      }
      expect(vacuum).toHaveBeenCalledTimes(1);
      expect(fts).toHaveBeenCalledTimes(1);
      expect(scan).not.toHaveBeenCalled();
    } finally {
      scan.mockRestore();
      vacuum.mockRestore();
      fts.mockRestore();
      home.cleanup();
    }
  });

  it('a database that APPEARS DURING the open — the check/open race the freshness snapshot lost to — is migrated, never stamped fresh', () => {
    // The hostile interleaving, made deterministic: the path is EMPTY at the instant openStore()
    // starts (what any pre-open lstat would have recorded), and a legacy plaintext database is
    // moved into place before SqliteDriver.open() gets it. A build that snapshots freshness
    // before opening stamps 'scrubbed' on this store and never remasks a single row. With the
    // snapshot deleted there is no window to lose: the state comes from the OPENED database.
    const home = createFakeHome();
    try {
      seedLegacyStore(home);
      const live = home.path('sthayi.db');
      const stash = home.path('raced-legacy.db');
      fs.renameSync(live, stash);
      for (const sidecar of [`${live}-wal`, `${live}-shm`]) {
        fs.rmSync(sidecar, { force: true });
      }
      expect(fs.existsSync(live), 'the path must be empty when the open begins').toBe(false);

      const realOpen = SqliteDriver.open.bind(SqliteDriver);
      let raced = false;
      const open = vi.spyOn(SqliteDriver, 'open').mockImplementation((file: string) => {
        if (!raced) {
          raced = true;
          fs.renameSync(stash, live); // the racer wins: the legacy file lands after the check
        }
        return realOpen(file);
      });
      try {
        const store = openStore();
        try {
          expect(raced).toBe(true);
          // the legacy rows were REMASKED — not blessed as bytes this build wrote
          const dump = JSON.stringify(store.driver.listMemories());
          for (const needle of NEEDLES) {
            expect(dump.includes(needle), `${needle} survived the raced open`).toBe(false);
          }
          expect(store.vault.listMappings().length).toBeGreaterThan(0);
          expect(migrationEvents(store.driver)).toHaveLength(1);
          expect(store.driver.getMeta(PII_REMASK_META_KEY)).toBe(PII_REMASK_DONE);
          const openBytes = dbAndWalBytes(home);
          for (const needle of NEEDLES) {
            expect(openBytes.includes(Buffer.from(needle)), `${needle} in raced bytes`).toBe(false);
          }
        } finally {
          store.close();
        }
      } finally {
        open.mockRestore();
      }
    } finally {
      home.cleanup();
    }
  });

  it('a PRE-EXISTING store whose rows are already clean still SCRUBS — with NO journal event: the event exists only when rows actually changed', () => {
    // CONTRACT (deliberately changed): clean current rows are NOT evidence about the file's
    // bytes, so a database that already existed always runs phase 2 even though phase 1
    // changed nothing. What stays true is the journal contract: no migrate_masking entry is
    // fabricated — the event count is exactly (rows changed ? 1 : 0) across the whole saga,
    // retries included. A pure remnant scrub is a byte operation, not a logical one.
    const home = createFakeHome();
    const vacuum = vi.spyOn(SqliteDriver.prototype, 'vacuum');
    const fts = vi.spyOn(SqliteDriver.prototype, 'rebuildMemoryFts');
    try {
      seedBenignStore(home);

      const store = openStore();
      try {
        expect(migrationEvents(store.driver)).toHaveLength(0);
        expect(store.driver.getMeta(PII_REMASK_META_KEY)).toBe(PII_REMASK_DONE);
        expect(store.journal.verify().ok).toBe(true);
        // …and the scrub really executed rather than being skipped as "nothing changed"
        expect(vacuum).toHaveBeenCalled();
        expect(fts).toHaveBeenCalled();
      } finally {
        store.close();
      }
    } finally {
      vacuum.mockRestore();
      fts.mockRestore();
      home.cleanup();
    }
  });

  it("a legacy single-flag store (timestamp under the v1 key, unverified best-effort scrub) is upgraded: phase 2 re-runs and proves it, no new journal event, state becomes 'scrubbed'", () => {
    const home = createFakeHome();
    try {
      seedLegacyStore(home);
      // Build the LEGACY outcome: rows remasked and journaled (the legacy build did that
      // atomically with its flag), then rewind to what that build actually left on disk — a
      // timestamp under the v1 key and NO current marker. Its scrub was best-effort, warn-only
      // and never verified.
      openStore().close();
      setMarkers(home, {
        [PII_REMASK_META_KEY]: null,
        [PII_REMASK_LEGACY_META_KEY]: String(Date.now()),
      });

      const store = openStore();
      try {
        // the rows phase re-ran but changed nothing (rows were already covered), so there is no
        // SECOND journal event…
        expect(migrationEvents(store.driver)).toHaveLength(1);
        // …and phase 2 ran and PROVED the scrub: the CURRENT marker is final, and the remnant
        // plaintext the legacy build's best-effort scrub might have left is gone from the db AND
        // the (TRUNCATE-checkpointed) WAL while the store is still open. (The only WAL frame
        // after the checkpoint is the masked completion-marking meta write itself.)
        expect(store.driver.getMeta(PII_REMASK_META_KEY)).toBe(PII_REMASK_DONE);
        const openBytes = dbAndWalBytes(home);
        for (const needle of NEEDLES) {
          expect(openBytes.includes(Buffer.from(needle)), `${needle} after upgrade`).toBe(false);
        }
      } finally {
        store.close();
      }
    } finally {
      home.cleanup();
    }
  });
});

/**
 * THE UPGRADE MATRIX. Every marker state a pre-existing store can arrive in, and what each one
 * costs. ONLY the current key's final value may stand down the work; every legacy v1 value —
 * 'scrubbed' emphatically included, because a legacy build wrote it on zero row changes alone —
 * means "this file has never been provably scrubbed", so both phases run.
 */
const UPGRADE_MATRIX: {
  state: string;
  markers: Record<string, string | null>;
  runsRowPass: boolean;
  runsScrub: boolean;
}[] = [
  { state: 'no marker at all', markers: {}, runsRowPass: true, runsScrub: true },
  {
    state: `legacy v1 = '${PII_REMASK_ROWS_DONE}' (rows covered, scrub never finished)`,
    markers: { [PII_REMASK_LEGACY_META_KEY]: PII_REMASK_ROWS_DONE },
    runsRowPass: true,
    runsScrub: true,
  },
  {
    state: 'legacy v1 = <timestamp> (the single-flag build)',
    markers: { [PII_REMASK_LEGACY_META_KEY]: '1700000000000' },
    runsRowPass: true,
    runsScrub: true,
  },
  {
    state: `legacy v1 = '${PII_REMASK_DONE}' (stamped on zero row changes — NOT proof)`,
    markers: { [PII_REMASK_LEGACY_META_KEY]: PII_REMASK_DONE },
    runsRowPass: true,
    runsScrub: true,
  },
  {
    state: `current v2 = '${UNKNOWN_MARKER}' (defined, unrecognized — proves NOTHING)`,
    markers: { [PII_REMASK_META_KEY]: UNKNOWN_MARKER },
    runsRowPass: true,
    runsScrub: true,
  },
  {
    state: `current v2 = '${PII_REMASK_ROWS_DONE}' (phase 1 provably done, scrub still owed)`,
    markers: { [PII_REMASK_META_KEY]: PII_REMASK_ROWS_DONE },
    runsRowPass: false,
    runsScrub: true,
  },
  {
    state: `current v2 = '${PII_REMASK_DONE}' (the only proof there is)`,
    markers: { [PII_REMASK_META_KEY]: PII_REMASK_DONE },
    runsRowPass: false,
    runsScrub: false,
  },
];

function matrixVerdict(row: { runsRowPass: boolean; runsScrub: boolean }): string {
  if (row.runsRowPass) {
    return 'runs the row pass AND the physical scrub';
  }
  return row.runsScrub ? 'skips the row pass, still scrubs' : 'skips both phases';
}

describe('safety: the marker upgrade matrix — only the CURRENT final marker skips the migration', () => {
  for (const row of UPGRADE_MATRIX) {
    it(`${row.state} → ${matrixVerdict(row)}`, () => {
      const home = createFakeHome();
      const scan = vi.spyOn(SqliteDriver.prototype, 'listMemories');
      const vacuum = vi.spyOn(SqliteDriver.prototype, 'vacuum');
      const fts = vi.spyOn(SqliteDriver.prototype, 'rebuildMemoryFts');
      try {
        seedBenignStore(home);
        setMarkers(home, row.markers);

        const store = openStore();
        try {
          // whatever it arrived carrying, it leaves with the CURRENT marker final…
          expect(store.driver.getMeta(PII_REMASK_META_KEY)).toBe(PII_REMASK_DONE);
          // …and nothing is journaled either way: these rows never changed.
          expect(migrationEvents(store.driver)).toHaveLength(0);
          expect(store.journal.verify().ok).toBe(true);
        } finally {
          store.close();
        }

        // The discriminator: did the work actually happen? A v1-trusting build skips the
        // v1='scrubbed' row entirely, and a definedness-testing build skips the row pass on the
        // unknown value — those stores are the ones most likely to hold plaintext.
        expect(scan.mock.calls.length > 0, 'row pass').toBe(row.runsRowPass);
        expect(vacuum).toHaveBeenCalledTimes(row.runsScrub ? 1 : 0);
        expect(fts).toHaveBeenCalledTimes(row.runsScrub ? 1 : 0);

        // the legacy value is preserved verbatim for diagnostics, never rewritten
        const legacySeed = row.markers[PII_REMASK_LEGACY_META_KEY];
        expect(readMarker(home, PII_REMASK_LEGACY_META_KEY)).toBe(
          legacySeed === null ? undefined : legacySeed,
        );
      } finally {
        scan.mockRestore();
        vacuum.mockRestore();
        fts.mockRestore();
        home.cleanup();
      }
    });
  }
});

/**
 * THE FREED-PAGE REMNANT. Every case below produces a legacy database whose CURRENT rows are
 * spotless (so phase 1 remasks nothing and journals nothing) while the raw file still carries
 * legacy plaintext on pages the delete/update freed. A v1-era migration reads "zero rows changed"
 * as "nothing to scrub" and stamps its final marker over that plaintext — which is exactly why
 * that marker (`pii_remask_v1 = 'scrubbed'`) can never be trusted, and why the last two cases
 * carry it: they are the stores a v1-trusting build skips forever.
 */
const REMNANT_EMAIL = 'freed.page.pii@example-leak.io';
/** Big enough that the row occupies overflow pages, so freeing it leaves a real freelist. */
const BULK = 'x'.repeat(200_000);

/**
 * Seed ONE large legacy row carrying plaintext PII, then mutate it with RAW SQL — outside every
 * masker — so the surviving logical state is clean and only the bytes are dirty. The FTS triggers
 * fire on that raw SQL, so the current FTS content is clean too and the plaintext survives only
 * in freed pages and superseded FTS segments. Closing both connections checkpoints and removes
 * the WAL, so the remnant ends up inside the main database file. `markers` are written last, with
 * raw SQL, to reconstruct what a legacy build left on disk.
 */
function seedFreedPageRemnant(
  home: FakeHome,
  mutate: (raw: Database.Database, id: string) => void,
  markers: Record<string, string | null> = {},
): void {
  const driver = SqliteDriver.open(home.path('sthayi.db'));
  driver.migrate();
  const crypto = NodeCrypto.open(home.path('key'));
  const journal = new JournalService(driver, {
    crypto,
    external: new FileCheckpoint(home.path('journal.checkpoint')),
  });
  const memory = new MemoryService(driver, journal); // NO vault — the legacy unmasked build
  const [written] = memory.write(
    [{ type: 'semantic', content: `${BULK} reach me at ${REMNANT_EMAIL} ${BULK}`, scope: 'user' }],
    { now: 1_700_000_000_000, actor: 'cli', asProposal: false },
  );
  driver.close();
  if (!written) {
    throw new Error('seed failed: no memory written');
  }
  const raw = new Database(home.path('sthayi.db'));
  try {
    mutate(raw, written.id);
  } finally {
    raw.close();
  }
  setMarkers(home, markers);
}

/** Bytes of the main database file only — where a freed page's old content lives. */
function mainDbBytes(home: FakeHome): Buffer {
  return fs.readFileSync(home.path('sthayi.db'));
}

/** Bytes of the `-wal` sidecar only — where un-checkpointed page images live. */
function walBytes(home: FakeHome): Buffer {
  const wal = home.path('sthayi.db-wal');
  return fs.existsSync(wal) ? fs.readFileSync(wal) : Buffer.alloc(0);
}

function freelistCount(home: FakeHome): number {
  const raw = new Database(home.path('sthayi.db'));
  try {
    return raw.pragma('freelist_count', { simple: true }) as number;
  } finally {
    raw.close();
  }
}

/**
 * Every CURRENT row a logical scan could see — all memory columns plus the live FTS content —
 * for the "no sensitive value survives in any current row" precondition.
 */
function currentRowDump(home: FakeHome): string {
  const raw = new Database(home.path('sthayi.db'));
  try {
    return JSON.stringify([
      raw.prepare('SELECT * FROM memories').all(),
      raw.prepare('SELECT rowid, content FROM memories_fts').all(),
    ]);
  } finally {
    raw.close();
  }
}

describe('safety: legacy freed-page remnants are scrubbed even when NO row changes', () => {
  /**
   * Shared body: the preconditions legacy behavior satisfies while still leaking, then the scrub.
   * `legacyMarker`, when given, is the v1 value already on the store before this build opens it.
   */
  function expectRemnantScrubbed(
    mutate: (raw: Database.Database, id: string) => void,
    legacyMarker?: string,
  ): void {
    const home = createFakeHome();
    try {
      seedFreedPageRemnant(
        home,
        mutate,
        legacyMarker === undefined ? {} : { [PII_REMASK_LEGACY_META_KEY]: legacyMarker },
      );

      // PRECONDITION 1 — the raw database bytes DO carry the plaintext email right now.
      expect(mainDbBytes(home).includes(Buffer.from(REMNANT_EMAIL))).toBe(true);
      // PRECONDITION 2 — yet every current row is clean, so no logical scan can see it.
      expect(currentRowDump(home).includes(REMNANT_EMAIL)).toBe(false);
      // PRECONDITION 3 — the freed pages really exist (this is where the plaintext survives).
      expect(freelistCount(home)).toBeGreaterThan(0);
      // PRECONDITION 4 — the marker state this store arrives in, and NO current marker: a
      // v1-trusting build reads 'scrubbed' here and skips both phases forever.
      expect(readMarker(home, PII_REMASK_LEGACY_META_KEY)).toBe(legacyMarker);
      expect(readMarker(home, PII_REMASK_META_KEY)).toBeUndefined();

      const store = openStore();
      try {
        // GONE from the raw bytes WHILE THE STORE IS STILL OPEN — main db and WAL separately.
        // Asserted FIRST: the leak itself is the headline, not the bookkeeping around it.
        expect(
          mainDbBytes(home).includes(Buffer.from(REMNANT_EMAIL)),
          'remnant still in the main db while open',
        ).toBe(false);
        expect(
          walBytes(home).includes(Buffer.from(REMNANT_EMAIL)),
          'remnant still in the WAL while open',
        ).toBe(false);
        // Zero rows changed, so NO logical migration event is fabricated…
        expect(migrationEvents(store.driver)).toHaveLength(0);
        // …but the physical scrub still ran to completion and was verified.
        expect(store.driver.getMeta(PII_REMASK_META_KEY)).toBe(PII_REMASK_DONE);
        expect(store.driver.freelistCount()).toBe(0);
        expect(store.journal.verify().ok).toBe(true);
        // the legacy value stays readable for diagnostics — reported, never trusted
        expect(store.driver.getMeta(PII_REMASK_LEGACY_META_KEY)).toBe(legacyMarker);
      } finally {
        store.close();
      }
      // …and GONE after close, too, from the main db and from the WAL.
      expect(
        mainDbBytes(home).includes(Buffer.from(REMNANT_EMAIL)),
        'remnant still in the main db after close',
      ).toBe(false);
      expect(
        walBytes(home).includes(Buffer.from(REMNANT_EMAIL)),
        'remnant still in the WAL after close',
      ).toBe(false);
      expect(readMarker(home, PII_REMASK_META_KEY)).toBe(PII_REMASK_DONE);
    } finally {
      home.cleanup();
    }
  }

  it('a legacy row DELETED before the migration leaves plaintext on freed pages — the scrub still runs and removes it', () => {
    expectRemnantScrubbed((raw, id) => {
      raw.prepare('DELETE FROM memories WHERE id = ?').run(id);
    });
  });

  it('a legacy row UPDATED to benign content before the migration leaves plaintext on freed pages — the scrub still runs and removes it', () => {
    expectRemnantScrubbed((raw, id) => {
      raw.prepare('UPDATE memories SET content = ? WHERE id = ?').run('nothing sensitive', id);
    });
  });

  it("DELETED row + the legacy v1 'scrubbed' marker already present — the marker is not proof, both phases still run and the bytes go", () => {
    expectRemnantScrubbed((raw, id) => {
      raw.prepare('DELETE FROM memories WHERE id = ?').run(id);
    }, PII_REMASK_DONE);
  });

  it("UPDATED row + the legacy v1 'scrubbed' marker already present — the marker is not proof, both phases still run and the bytes go", () => {
    expectRemnantScrubbed((raw, id) => {
      raw.prepare('UPDATE memories SET content = ? WHERE id = ?').run('nothing sensitive', id);
    }, PII_REMASK_DONE);
  });
});

describe('safety: the legacy-journal compatibility boundary is explicit and pinned', () => {
  it('a legacy store JOURNAL payload is preserved VERBATIM — the migration masks rows, never authenticated history', () => {
    // COMPATIBILITY BOUNDARY (SECURITY.md, "Compatibility boundary — legacy unmasked stores"):
    // the journal is append-only (spec §1 invariant 3). A legacy unmasked build masked secrets
    // but not PII, so a memory_retrieve payload from back then can hold a plaintext email. The
    // migration must NOT silently rewrite or reseal that history — this test exists so the
    // boundary can never move by accident, in either direction. It is a documented limitation,
    // NOT a claim that a legacy store's PII is fully removed.
    const journalEmail = 'legacy.query.pii@example-leak.io';
    const home = createFakeHome();
    try {
      const driver = SqliteDriver.open(home.path('sthayi.db'));
      driver.migrate();
      const crypto = NodeCrypto.open(home.path('key'));
      const journal = new JournalService(driver, {
        crypto,
        external: new FileCheckpoint(home.path('journal.checkpoint')),
      });
      const memory = new MemoryService(driver, journal); // NO vault — the legacy unmasked build
      memory.write(
        [{ type: 'semantic', content: `ping ${PII.email} about launch`, scope: 'user' }],
        {
          now: 1_700_000_000_000,
          actor: 'cli',
          asProposal: false,
        },
      );
      // …and a retrieve whose QUERY carries PII straight into an authenticated journal payload
      memory.search(`launch ${journalEmail}`, { now: 1_700_000_000_001, bump: true });
      const before = driver.allJournal();
      driver.close();

      const retrieveBefore = before.filter((r) => r.op === 'memory_retrieve');
      expect(retrieveBefore).toHaveLength(1);
      expect(JSON.stringify(retrieveBefore[0]?.payload)).toContain(journalEmail);

      const store = openStore();
      try {
        // The ROWS were remasked (the migration did its job where it has authority)…
        expect(JSON.stringify(store.driver.listMemories())).not.toContain(PII.email);
        expect(store.driver.getMeta(PII_REMASK_META_KEY)).toBe(PII_REMASK_DONE);

        // …and every pre-existing journal record is byte-identical: same id, ts, actor, op,
        // payload and hash. History was appended to, never edited.
        const after = store.driver.allJournal();
        expect(after.length).toBeGreaterThanOrEqual(before.length);
        expect(JSON.stringify(after.slice(0, before.length))).toBe(JSON.stringify(before));
        expect(store.journal.verify().ok).toBe(true);

        // The consequence, stated out loud: that legacy payload's plaintext is STILL there.
        expect(JSON.stringify(after.map((r) => r.payload))).toContain(journalEmail);
      } finally {
        store.close();
      }
    } finally {
      home.cleanup();
    }
  });
});

/**
 * THE UNKNOWN MARKER. A migration gate that asked whether the marker cell was DEFINED, rather
 * than what it said, counts any value this build never writes — a future build's state, a
 * corrupt or truncated cell, a hand-planted `'garbage-state'` — as "the rows were already
 * remasked": phase 1 is skipped entirely, the physical scrub runs over rows that still hold LIVE
 * plaintext (so it has no needles to look for and happily verifies), and the final 'scrubbed'
 * marker is written on top. The plaintext email and phone survive in the memory row, ZERO vault
 * entities are minted, nothing is journaled, and the marker ends final — a store that looks
 * permanently migrated and never will be.
 *
 * The value is therefore parsed against a closed state machine, and unknown means "nothing is
 * proven".
 */

/** Plaintext in EVERY masked column — one distinct value per field, so each is proven alone. */
const FIELD_PII = {
  content: 'content.leak@example-leak.io',
  scope: 'scope.leak@example-leak.io',
  source: 'source.leak@example-leak.io',
  provenance: 'prov.leak@example-leak.io',
};

/** A legacy row whose content, scope, source AND provenance all carry plaintext PII. */
function seedLegacyStoreAllFields(home: FakeHome): void {
  const driver = SqliteDriver.open(home.path('sthayi.db'));
  driver.migrate();
  const crypto = NodeCrypto.open(home.path('key'));
  const journal = new JournalService(driver, {
    crypto,
    external: new FileCheckpoint(home.path('journal.checkpoint')),
  });
  new MemoryService(driver, journal).write(
    [
      {
        type: 'semantic',
        content: `ping ${FIELD_PII.content} about the launch`,
        scope: `team ${FIELD_PII.scope}`,
        source: `note from ${FIELD_PII.source}`,
        provenance: { source: 'chat', note: `cc ${FIELD_PII.provenance}` },
      },
    ],
    { now: 1_700_000_000_000, actor: 'cli', asProposal: false },
  );
  driver.close();
}

describe('safety: an UNKNOWN marker value proves nothing — both phases re-run', () => {
  let spies: MockInstance[] = [];
  afterEach(() => {
    for (const s of spies) {
      s.mockRestore();
    }
    spies = [];
  });

  it("'garbage-state' over LIVE plaintext: the email and phone are masked, entities are minted, and only then does the marker go final", () => {
    const home = createFakeHome();
    try {
      seedLegacyStore(home);
      setMarkers(home, { [PII_REMASK_META_KEY]: UNKNOWN_MARKER });
      // PRECONDITION — the rows are LIVE plaintext right now (not a freed-page remnant), and
      // the marker is a value this build never writes.
      const seeded = currentRowDump(home);
      expect(seeded.includes(PII.email), 'seed lost the live email').toBe(true);
      expect(seeded.includes('15550998877'), 'seed lost the live phone').toBe(true);
      expect(readMarker(home, PII_REMASK_META_KEY)).toBe(UNKNOWN_MARKER);

      const store = openStore();
      try {
        // THE HEADLINE: no plaintext survives in any memory row…
        const dump = JSON.stringify(store.driver.listMemories());
        for (const needle of NEEDLES) {
          expect(dump.includes(needle), `${needle} survived the unknown marker`).toBe(false);
        }
        expect(dump).toMatch(/EMAIL_\d\d/);
        expect(dump).toMatch(/PHONE_\d\d/);
        // …the vault entities really were minted (a definedness-only gate mints ZERO)…
        const mappings = store.vault.listMappings();
        expect(mappings.some((m) => m.kind === 'EMAIL' && m.value === PII.email)).toBe(true);
        expect(mappings.some((m) => m.kind === 'PHONE')).toBe(true);
        expect(mappings.some((m) => m.kind === 'SSN' && m.value === PII.ssn)).toBe(true);
        // …the row pass journaled exactly once…
        expect(migrationEvents(store.driver)).toHaveLength(1);
        expect(store.journal.verify().ok).toBe(true);
        // …the bytes are clean while the store is still open…
        const openBytes = dbAndWalBytes(home);
        for (const needle of NEEDLES) {
          expect(openBytes.includes(Buffer.from(needle)), `${needle} in bytes while open`).toBe(
            false,
          );
        }
        // …and ONLY now is the unknown value replaced by the earned final state.
        expect(store.driver.getMeta(PII_REMASK_META_KEY)).toBe(PII_REMASK_DONE);
      } finally {
        store.close();
      }
      expect(readMarker(home, PII_REMASK_META_KEY)).toBe(PII_REMASK_DONE);
    } finally {
      home.cleanup();
    }
  });

  it('unknown marker + plaintext in ALL FOUR masked columns (content, scope, source, provenance): every one is remasked and vaulted', () => {
    const home = createFakeHome();
    try {
      seedLegacyStoreAllFields(home);
      setMarkers(home, { [PII_REMASK_META_KEY]: UNKNOWN_MARKER });
      const seeded = currentRowDump(home);
      for (const value of Object.values(FIELD_PII)) {
        expect(seeded.includes(value), `seed lost ${value}`).toBe(true);
      }

      const store = openStore();
      try {
        const [row] = store.driver.listMemories();
        if (!row) {
          throw new Error('the seeded row disappeared');
        }
        // field by field: plaintext out, pseudonym in — no column gets a pass
        expect(row.content).not.toContain(FIELD_PII.content);
        expect(row.content).toMatch(/EMAIL_\d\d/);
        expect(row.scope).not.toContain(FIELD_PII.scope);
        expect(row.scope).toMatch(/EMAIL_\d\d/);
        expect(row.source).not.toContain(FIELD_PII.source);
        expect(row.source).toMatch(/EMAIL_\d\d/);
        const provenance = JSON.stringify(row.provenance);
        expect(provenance).not.toContain(FIELD_PII.provenance);
        expect(provenance).toMatch(/EMAIL_\d\d/);

        // all four canonicals are recoverable from the vault, one entity each
        const mappings = store.vault.listMappings();
        for (const value of Object.values(FIELD_PII)) {
          expect(
            mappings.some((m) => m.kind === 'EMAIL' && m.value === value),
            `no vault entity for ${value}`,
          ).toBe(true);
        }
        expect(migrationEvents(store.driver)).toHaveLength(1);
        expect(store.driver.getMeta(PII_REMASK_META_KEY)).toBe(PII_REMASK_DONE);
        const openBytes = dbAndWalBytes(home);
        for (const value of Object.values(FIELD_PII)) {
          expect(openBytes.includes(Buffer.from(value)), `${value} still in the bytes`).toBe(false);
        }
        expect(store.journal.verify().ok).toBe(true);
      } finally {
        store.close();
      }
    } finally {
      home.cleanup();
    }
  });

  it('a CORRUPT marker cell (a bare number, not a state string) is unknown too: both phases run over the live plaintext', () => {
    const home = createFakeHome();
    try {
      seedLegacyStore(home);
      setCorruptMarker(home, PII_REMASK_META_KEY, 1_700_000_000_000);

      const store = openStore();
      try {
        const dump = JSON.stringify(store.driver.listMemories());
        for (const needle of NEEDLES) {
          expect(dump.includes(needle), `${needle} survived the corrupt marker`).toBe(false);
        }
        expect(store.vault.listMappings().length).toBeGreaterThan(0);
        expect(migrationEvents(store.driver)).toHaveLength(1);
        expect(store.driver.getMeta(PII_REMASK_META_KEY)).toBe(PII_REMASK_DONE);
        expect(store.journal.verify().ok).toBe(true);
      } finally {
        store.close();
      }
    } finally {
      home.cleanup();
    }
  });

  it('unknown marker + a failing ROW PASS: the open FAILS CLOSED — the marker is never advanced, and the retry completes it', () => {
    const home = createFakeHome();
    try {
      seedLegacyStoreAllFields(home);
      setMarkers(home, { [PII_REMASK_META_KEY]: UNKNOWN_MARKER });
      const rowPass = vi.spyOn(SqliteDriver.prototype, 'updateMemory').mockImplementation(() => {
        throw new Error('injected row-pass failure');
      });
      spies.push(rowPass);

      expect(() => openStore()).toThrow(/injected row-pass failure/);
      // NOTHING was advanced: not to 'rows-done', and emphatically not to the final state. The
      // rows are still plaintext, which is exactly why the marker must not say otherwise.
      expect(readMarker(home, PII_REMASK_META_KEY)).toBe(UNKNOWN_MARKER);
      expect(currentRowDump(home).includes(FIELD_PII.content)).toBe(true);

      for (const s of spies.splice(0)) {
        s.mockRestore();
      }
      const store = openStore();
      try {
        expect(JSON.stringify(store.driver.listMemories())).not.toContain(FIELD_PII.content);
        expect(migrationEvents(store.driver)).toHaveLength(1);
        expect(store.driver.getMeta(PII_REMASK_META_KEY)).toBe(PII_REMASK_DONE);
        expect(store.journal.verify().ok).toBe(true);
      } finally {
        store.close();
      }
    } finally {
      home.cleanup();
    }
  });

  const SCRUB_STEPS: { step: string; inject: () => MockInstance }[] = [
    {
      step: 'FTS rebuild',
      inject: () =>
        vi.spyOn(SqliteDriver.prototype, 'rebuildMemoryFts').mockImplementation(() => {
          throw new Error('injected FTS rebuild failure');
        }),
    },
    {
      step: 'VACUUM',
      inject: () =>
        vi.spyOn(SqliteDriver.prototype, 'vacuum').mockImplementation(() => {
          throw new Error('injected VACUUM failure');
        }),
    },
    {
      step: 'WAL truncate-checkpoint',
      inject: () =>
        vi.spyOn(SqliteDriver.prototype, 'checkpointTruncate').mockImplementation(() => {
          throw new Error('injected checkpoint failure');
        }),
    },
    {
      step: 'completion marking',
      inject: () => {
        const original = SqliteDriver.prototype.setMeta;
        return vi.spyOn(SqliteDriver.prototype, 'setMeta').mockImplementation(function (
          this: SqliteDriver,
          key: string,
          value: string,
        ) {
          if (key === PII_REMASK_META_KEY && value === PII_REMASK_DONE) {
            throw new Error('injected completion-marking failure');
          }
          return original.call(this, key, value);
        });
      },
    },
  ];

  for (const { step, inject } of SCRUB_STEPS) {
    it(`unknown marker + ${step} failure: rows are masked, the marker stops at 'rows-done', and the retry finishes with ONE event`, () => {
      const home = createFakeHome();
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      spies.push(stderr);
      try {
        seedLegacyStore(home);
        setMarkers(home, { [PII_REMASK_META_KEY]: UNKNOWN_MARKER });
        spies.push(inject());

        const store = openStore();
        try {
          // phase 1 committed (the unknown marker bought nothing)…
          const dump = JSON.stringify(store.driver.listMemories());
          for (const needle of NEEDLES) {
            expect(dump.includes(needle), `${needle} survived phase 1`).toBe(false);
          }
          expect(migrationEvents(store.driver)).toHaveLength(1);
          // …and phase 2 failed, so the state is honestly PENDING — never final.
          expect(store.driver.getMeta(PII_REMASK_META_KEY)).toBe(PII_REMASK_ROWS_DONE);
        } finally {
          store.close();
        }
        expect(readMarker(home, PII_REMASK_META_KEY)).toBe(PII_REMASK_ROWS_DONE);
        expect(
          stderr.mock.calls.some((c) =>
            String(c[0]).includes('plaintext-remnant scrub incomplete'),
          ),
        ).toBe(true);

        for (const s of spies.splice(1)) {
          s.mockRestore();
        }
        const store2 = openStore();
        try {
          expect(store2.driver.getMeta(PII_REMASK_META_KEY)).toBe(PII_REMASK_DONE);
          expect(migrationEvents(store2.driver)).toHaveLength(1);
          const openBytes = dbAndWalBytes(home);
          for (const needle of NEEDLES) {
            expect(openBytes.includes(Buffer.from(needle)), `${needle} after retry`).toBe(false);
          }
          expect(store2.journal.verify().ok).toBe(true);
        } finally {
          store2.close();
        }
      } finally {
        home.cleanup();
      }
    });
  }

  it("'rows-done' skips the row pass but still scrubs — and the completed store is never touched again", () => {
    // The middle state of the machine, pinned from both sides: the row pass is skipped because
    // THIS BUILD wrote that marker inside phase 1's own transaction, and the scrub still runs
    // because only 'scrubbed' may stand it down.
    const home = createFakeHome();
    const scan = vi.spyOn(SqliteDriver.prototype, 'listMemories');
    const vacuum = vi.spyOn(SqliteDriver.prototype, 'vacuum');
    try {
      seedBenignStore(home);
      setMarkers(home, { [PII_REMASK_META_KEY]: PII_REMASK_ROWS_DONE });

      const store = openStore();
      try {
        expect(scan).not.toHaveBeenCalled(); // row pass skipped
        expect(vacuum).toHaveBeenCalledTimes(1); // scrub still owed, and paid
        expect(store.driver.getMeta(PII_REMASK_META_KEY)).toBe(PII_REMASK_DONE);
        expect(migrationEvents(store.driver)).toHaveLength(0);
      } finally {
        store.close();
      }

      const store2 = openStore();
      try {
        expect(vacuum).toHaveBeenCalledTimes(1); // final state: nothing runs again
      } finally {
        store2.close();
      }
    } finally {
      scan.mockRestore();
      vacuum.mockRestore();
      home.cleanup();
    }
  });

  it('the migration journal stays EXACTLY ONCE across repeated failures and retries', () => {
    const home = createFakeHome();
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    spies.push(stderr);
    try {
      seedLegacyStore(home);
      setMarkers(home, { [PII_REMASK_META_KEY]: UNKNOWN_MARKER });

      // ATTEMPT 1 — the row pass runs and journals; VACUUM fails. (Every spy is registered for
      // afterEach restoration BEFORE it can throw, so a failing assertion here cannot leak a
      // throwing prototype into the tests that follow.)
      const vacuum = vi.spyOn(SqliteDriver.prototype, 'vacuum').mockImplementation(() => {
        throw new Error('injected VACUUM failure');
      });
      spies.push(vacuum);
      let store = openStore();
      try {
        expect(migrationEvents(store.driver)).toHaveLength(1);
        expect(store.driver.getMeta(PII_REMASK_META_KEY)).toBe(PII_REMASK_ROWS_DONE);
      } finally {
        store.close();
      }
      vacuum.mockRestore();

      // ATTEMPT 2 — the row pass is now skipped ('rows-done'); the checkpoint fails. Still one.
      const checkpoint = vi
        .spyOn(SqliteDriver.prototype, 'checkpointTruncate')
        .mockImplementation(() => {
          throw new Error('injected checkpoint failure');
        });
      spies.push(checkpoint);
      store = openStore();
      try {
        expect(migrationEvents(store.driver)).toHaveLength(1);
        expect(store.driver.getMeta(PII_REMASK_META_KEY)).toBe(PII_REMASK_ROWS_DONE);
      } finally {
        store.close();
      }
      checkpoint.mockRestore();

      // ATTEMPT 3 — clean: it completes, and the count is STILL exactly one.
      store = openStore();
      try {
        expect(migrationEvents(store.driver)).toHaveLength(1);
        expect(store.driver.getMeta(PII_REMASK_META_KEY)).toBe(PII_REMASK_DONE);
        expect(store.journal.verify().ok).toBe(true);
      } finally {
        store.close();
      }

      // ATTEMPT 4 — the final state: nothing more is journaled, ever.
      store = openStore();
      try {
        expect(migrationEvents(store.driver)).toHaveLength(1);
      } finally {
        store.close();
      }
    } finally {
      home.cleanup();
    }
  });
});

describe('safety: injected phase-2 failures never commit the final state over plaintext', () => {
  let spies: MockInstance[] = [];
  afterEach(() => {
    for (const s of spies) {
      s.mockRestore();
    }
    spies = [];
  });

  /** Run the injected-failure saga: first open with `inject` armed, then a clean reopen. */
  function runSaga(inject: () => MockInstance): void {
    const home = createFakeHome();
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    spies.push(stderr);
    try {
      seedLegacyStore(home);
      spies.push(inject());

      // FIRST OPEN — phase 2 fails. The store still opens (rows are safe), but the state must
      // stay PENDING and the incompleteness must be warned about: honestly detectable, twice.
      const store = openStore();
      try {
        expect(store.driver.getMeta(PII_REMASK_META_KEY)).toBe(PII_REMASK_ROWS_DONE);
        expect(migrationEvents(store.driver)).toHaveLength(1);
        // rows themselves are already masked — phase 1 committed atomically
        const dump = JSON.stringify(store.driver.listMemories());
        for (const needle of NEEDLES) {
          expect(dump.includes(needle), `${needle} survived phase 1`).toBe(false);
        }
      } finally {
        store.close();
      }
      expect(
        stderr.mock.calls.some((c) => String(c[0]).includes('plaintext-remnant scrub incomplete')),
      ).toBe(true);

      // SECOND OPEN — injection removed: the saga retries and completes. Exactly ONE
      // migrate_masking event across the whole saga; bytes clean while open; state final.
      for (const s of spies.splice(1)) {
        s.mockRestore();
      }
      const store2 = openStore();
      try {
        expect(store2.driver.getMeta(PII_REMASK_META_KEY)).toBe(PII_REMASK_DONE);
        expect(migrationEvents(store2.driver)).toHaveLength(1);
        const openBytes = dbAndWalBytes(home);
        for (const needle of NEEDLES) {
          expect(openBytes.includes(Buffer.from(needle)), `${needle} after retry`).toBe(false);
        }
        expect(store2.journal.verify().ok).toBe(true);
      } finally {
        store2.close();
      }
    } finally {
      home.cleanup();
    }
  }

  it('FTS rebuild failure → state stays rows-done, next open completes with one event', () => {
    runSaga(() =>
      vi.spyOn(SqliteDriver.prototype, 'rebuildMemoryFts').mockImplementation(() => {
        throw new Error('injected FTS rebuild failure');
      }),
    );
  });

  it('VACUUM failure → state stays rows-done, next open completes with one event', () => {
    runSaga(() =>
      vi.spyOn(SqliteDriver.prototype, 'vacuum').mockImplementation(() => {
        throw new Error('injected VACUUM failure');
      }),
    );
  });

  it("the warning REPORTS the legacy v1 marker (diagnostics) while the marker still buys nothing: a v1='scrubbed' store with plaintext rows gets both phases anyway", () => {
    const home = createFakeHome();
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    spies.push(stderr);
    try {
      seedLegacyStore(home);
      setMarkers(home, { [PII_REMASK_LEGACY_META_KEY]: PII_REMASK_DONE });
      spies.push(
        vi.spyOn(SqliteDriver.prototype, 'vacuum').mockImplementation(() => {
          throw new Error('injected VACUUM failure');
        }),
      );

      const store = openStore();
      try {
        // The v1 marker did NOT shortcut phase 1: rows were remasked and journaled exactly once…
        expect(migrationEvents(store.driver)).toHaveLength(1);
        const dump = JSON.stringify(store.driver.listMemories());
        for (const needle of NEEDLES) {
          expect(dump.includes(needle), `${needle} survived phase 1`).toBe(false);
        }
        // …and phase 2 was attempted, failed, and left the state honestly pending.
        expect(store.driver.getMeta(PII_REMASK_META_KEY)).toBe(PII_REMASK_ROWS_DONE);
      } finally {
        store.close();
      }
      const warning = stderr.mock.calls.map((c) => String(c[0])).join('');
      expect(warning).toContain('plaintext-remnant scrub incomplete');
      expect(warning).toContain(`${PII_REMASK_LEGACY_META_KEY}=${PII_REMASK_DONE}`);
    } finally {
      home.cleanup();
    }
  });

  it('WAL checkpoint failure → state stays rows-done, next open completes with one event', () => {
    runSaga(() =>
      vi.spyOn(SqliteDriver.prototype, 'checkpointTruncate').mockImplementation(() => {
        throw new Error('injected checkpoint failure');
      }),
    );
  });

  it('completion-marking failure → state stays rows-done, next open completes with one event', () => {
    runSaga(() => {
      const original = SqliteDriver.prototype.setMeta;
      return vi.spyOn(SqliteDriver.prototype, 'setMeta').mockImplementation(function (
        this: SqliteDriver,
        key: string,
        value: string,
      ) {
        if (key === PII_REMASK_META_KEY && value === PII_REMASK_DONE) {
          throw new Error('injected completion-marking failure');
        }
        return original.call(this, key, value);
      });
    });
  });
});
