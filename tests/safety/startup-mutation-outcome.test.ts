import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JournalService, MemoryService } from '@sthayi/core';
import Database from 'better-sqlite3';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FileCheckpoint } from '../../packages/cli/src/drivers/checkpoint-file.js';
import { NodeCrypto } from '../../packages/cli/src/drivers/crypto.js';
import { SqliteDriver } from '../../packages/cli/src/drivers/sqlite.js';
import {
  PII_REMASK_META_KEY,
  StartupUnanchoredError,
  openStore,
  startupBlockers,
} from '../../packages/cli/src/store.js';
import { ensureBuiltCli } from '../helpers/build-cli.js';
import { type FakeHome, createFakeHome } from '../helpers/fake-home.js';
import { removeOwned } from '../helpers/owned-fs.js';
import { runTempDir } from '../helpers/run-temp.js';

/**
 * SAFETY: opening the store MUTATES, and what those mutations achieved must reach every front door.
 *
 * THE HAZARD. Two journaled writes run because the store was OPENED, not because anyone asked for
 * them: the first-run seal (a `journal_seal` entry plus the meta checkpoint) and the legacy-PII
 * migration (remasked memory rows plus a `migrate_masking` entry). Each therefore has the third
 * outcome — COMMITTED while the off-database anchor did not advance — and each arrives inside
 * whatever command happened to open the store. Reduced to a stderr warning, the command goes on to
 * print its ordinary output and exit 0, so a store that is now durable-but-unanchored, with every
 * further write blocked, is reported as a healthy one. Retrying is worse than useless: the database
 * half already landed and cannot be redone.
 *
 * THE INVARIANT. `openStore()` returns a typed startup channel with three states — 'clean',
 * 'refused' (nothing was written, safe to re-run) and 'committed-unanchored' (durable, do not
 * retry, writes blocked) — and every front door reads it. A CLI command whose open committed
 * unanchored does not run, says so, and exits 3; an MCP server refuses to serve at all, because a
 * server has no exit code to carry the fact and a model would keep writing into a blocked store.
 *
 * These probes use real SQLite, a real FileCheckpoint and the real `openStore()`; the degraded
 * state is forced honestly with a DIRECTORY at `journal.checkpoint.lock`, which no O_CREAT|O_EXCL
 * lock can ever take.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const distEntry = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');

/** The exit code reserved for committed-but-unanchored (packages/cli/src/index.ts). */
const EXIT_COMMITTED_UNANCHORED = 3;

const STORE_BACKED_COMMANDS: Array<[label: string, args: string[]]> = [
  ['review', ['review']],
  ['add', ['add', 'a fact']],
  ['search', ['search', 'anything']],
  ['journal list', ['journal', '-n', '5']],
  ['journal verify', ['journal', '--verify']],
  ['consolidate', ['consolidate']],
  ['entities', ['entities']],
  ['pack', ['pack']],
  ['index status', ['index', 'status']],
  ['rollback', ['rollback', '1']],
  ['import', ['import', path.join(repoRoot, 'tests', 'fixtures', 'imports', 'claude')]],
  // `init` and the bare first-run command open the store like any other front door — leaving
  // them out is what made the original aggregate list's claim false.
  ['init', ['init']],
  ['init --yes', ['init', '--yes']],
  ['bare sthayi', []],
];

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(home: string, args: string[]): RunResult {
  const env: NodeJS.ProcessEnv = { ...process.env, STHAYI_HOME: home, HOME: home };
  const r = spawnSync(process.execPath, [distEntry, ...args], {
    env,
    cwd: home,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Jam every checkpoint replacement in `home`, permanently and deterministically. */
function jam(home: string): void {
  fs.mkdirSync(path.join(home, 'journal.checkpoint.lock'), { recursive: true });
}

/** All three facts a durable-but-unanchored report must state, in words a human and a script act on. */
function expectDegradedText(text: string, label: string): void {
  expect(text, label).toMatch(/DEGRADED/);
  expect(text, label).toMatch(/COMMITTED/);
  expect(text, label).toMatch(/DO NOT RETRY/);
  expect(text, label).toMatch(/Further writes are BLOCKED/);
  expect(text, label).toMatch(/journal reseal/);
}

/**
 * Turn a healthy store into what a LEGACY unmasked build left behind: plaintext PII in a memory
 * row, and the migration marker cleared. The next open must remask the row and journal it — which
 * is the startup mutation whose outcome is under test.
 */
function makeLegacy(home: string, id?: string): void {
  const db = new Database(path.join(home, 'sthayi.db'));
  try {
    const row = (
      id === undefined ? db.prepare('SELECT id FROM memories LIMIT 1').get() : { id }
    ) as { id: string };
    db.prepare('UPDATE memories SET content = ? WHERE id = ?').run(
      'email me at legacy.pii@example-leak.io about the launch',
      row.id,
    );
    db.prepare('DELETE FROM meta WHERE k = ?').run(PII_REMASK_META_KEY);
  } finally {
    db.close();
  }
}

describe('safety: the store startup channel reaches every CLI front door (built CLI)', () => {
  const homes: string[] = [];
  beforeAll(() => {
    ensureBuiltCli();
  }, 300_000);
  afterEach(() => {
    for (const h of homes.splice(0)) {
      removeOwned(path.join(h, 'journal.checkpoint.lock'));
      removeOwned(h);
    }
  });

  function freshHome(prefix: string): string {
    const home = runTempDir(prefix);
    homes.push(home);
    return home;
  }

  it('first-run seal: a fresh JAMMED store exits 3 instead of letting `review` report an empty queue', () => {
    const home = freshHome('sthayi-startup-seal-');
    jam(home); // jammed BEFORE the store has ever been opened

    const r = runCli(home, ['review']);
    const label = `${r.stdout}\n---\n${r.stderr}`;
    // The seal's database half is durable and its file half is not, so this open left the store
    // unable to accept writes — a fact `no proposals in the queue.` at exit 0 does not carry.
    expect(r.status, label).toBe(EXIT_COMMITTED_UNANCHORED);
    expectDegradedText(r.stdout, label);
    expect(r.stdout).toMatch(/first-run initialization COMMITTED the journal seal/);
    expect(r.stdout).toMatch(/This command did NOT run/);
    expect(r.stdout).not.toMatch(/no proposals in the queue/);

    // …and the database half really did land: a durable seal entry and a store checkpoint,
    // with NOTHING outside the database vouching for either.
    const db = new Database(path.join(home, 'sthayi.db'), { readonly: true });
    try {
      const seals = db
        .prepare("SELECT count(*) AS c FROM journal WHERE op = 'journal_seal'")
        .get() as { c: number };
      expect(seals.c).toBe(1);
      expect(db.prepare("SELECT v FROM meta WHERE k = 'journal_checkpoint'").get()).toBeDefined();
    } finally {
      db.close();
    }
    expect(fs.existsSync(path.join(home, 'journal.checkpoint'))).toBe(false);
  });

  it('first-run seal: the repair works — clear the blocker, reseal, and the store writes again', () => {
    const home = freshHome('sthayi-startup-repair-');
    jam(home);
    expect(runCli(home, ['review']).status).toBe(EXIT_COMMITTED_UNANCHORED);

    // The report names the repair, and it must actually be reachable: the seal does not run a
    // second time (the store now holds a checkpoint), so the next open's startup is clean.
    removeOwned(path.join(home, 'journal.checkpoint.lock'));
    const reseal = runCli(home, ['journal', 'reseal']);
    expect(reseal.status, `${reseal.stdout}\n---\n${reseal.stderr}`).toBe(0);
    expect(reseal.stdout).toMatch(/authenticated checkpoint rewritten/);
    const add = runCli(home, ['add', 'writable again']);
    expect(add.status, `${add.stdout}\n---\n${add.stderr}`).toBe(0);
    expect(add.stdout).toMatch(/^added proposed semantic/m);
  });

  it('first-run seal CONTROL: an unjammed fresh store initializes cleanly and exits 0', () => {
    const home = freshHome('sthayi-startup-seal-ok-');
    const r = runCli(home, ['review']);
    expect(r.status, `${r.stdout}\n---\n${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/no proposals in the queue/);
    expect(r.stdout).not.toMatch(/DEGRADED/);
    expect(fs.readFileSync(path.join(home, 'journal.checkpoint'), 'utf8').length).toBeGreaterThan(
      0,
    );
  });

  it('PII migration: a command that triggered a committed-unanchored remask exits 3, not 0', () => {
    const home = freshHome('sthayi-startup-mig-');
    expect(runCli(home, ['add', 'placeholder fact']).status).toBe(0);
    makeLegacy(home);
    jam(home);

    const r = runCli(home, ['review']);
    const label = `${r.stdout}\n---\n${r.stderr}`;
    expect(r.status, label).toBe(EXIT_COMMITTED_UNANCHORED);
    expectDegradedText(r.stdout, label);
    expect(r.stdout).toMatch(/This command did NOT run/);
    // the ordinary listing is NOT what a caller gets from an open that blocked the store
    expect(r.stdout).not.toMatch(/proposal\(s\) — confirm with/);

    // the migration's entry really is durable — the outcome was reported, not invented
    const db = new Database(path.join(home, 'sthayi.db'), { readonly: true });
    try {
      const events = db
        .prepare("SELECT count(*) AS c FROM journal WHERE op = 'migrate_masking'")
        .get() as { c: number };
      expect(events.c).toBe(1);
      const row = db.prepare('SELECT content FROM memories LIMIT 1').get() as { content: string };
      expect(row.content).not.toContain('legacy.pii@example-leak.io');
    } finally {
      db.close();
    }
  });

  it('PII migration CONTROL: the same legacy store with a healthy anchor migrates and exits 0', () => {
    const home = freshHome('sthayi-startup-mig-ok-');
    expect(runCli(home, ['add', 'placeholder fact']).status).toBe(0);
    makeLegacy(home);

    const r = runCli(home, ['review']);
    expect(r.status, `${r.stdout}\n---\n${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/proposal\(s\) — confirm with/);
    expect(r.stdout).not.toMatch(/DEGRADED/);
  });

  /**
   * `init` is the command that MAKES the store, so it is the one that meets a first-run seal
   * committing while the anchor does not advance — and it is also the command that goes on to
   * write a launcher, seed skills, rewrite client configs and print "Sthayi initialized". Every
   * one of those is an initialization write over a store that has stopped accepting writes, and
   * the success line describes a machine that is not set up.
   */
  function expectInitRefused(home: string, args: string[]): void {
    jam(home); // jammed BEFORE the store has ever been opened — the genuine first-run case
    const r = runCli(home, args);
    const label = `${args.join(' ')}\n${r.stdout}\n---\n${r.stderr}`;
    expect(r.status, label).toBe(EXIT_COMMITTED_UNANCHORED);
    expectDegradedText(r.stdout, label);
    expect(r.stdout, label).toMatch(/first-run initialization COMMITTED the journal seal/);
    expect(r.stdout, label).toMatch(/This command did NOT run/);
    // NO ordinary success, and no line describing an initialization that did not finish
    expect(r.stdout, label).not.toMatch(/Sthayi initialized/);
    expect(r.stdout, label).not.toMatch(/Launcher:/);
    expect(r.stdout, label).not.toMatch(/CLI launcher:/);
    expect(r.stdout, label).not.toMatch(/Detected \d+ of \d+ clients/);
    expect(r.stdout, label).not.toMatch(/Sixty-Second Demo/);

    // …and the writes really did not happen: no launcher directory, no seeded skills.
    expect(fs.existsSync(path.join(home, 'bin')), label).toBe(false);
    expect(fs.existsSync(path.join(home, 'skills')), label).toBe(false);

    // The seal's database half IS durable — the refusal above is a report, not a guess.
    const db = new Database(path.join(home, 'sthayi.db'), { readonly: true });
    try {
      const seals = db
        .prepare("SELECT count(*) AS c FROM journal WHERE op = 'journal_seal'")
        .get() as { c: number };
      expect(seals.c, label).toBe(1);
      expect(db.prepare("SELECT v FROM meta WHERE k = 'journal_checkpoint'").get()).toBeDefined();
    } finally {
      db.close();
    }
    expect(fs.existsSync(path.join(home, 'journal.checkpoint')), label).toBe(false);
  }

  it('init: a JAMMED first run exits 3 and writes NO launcher, NO skills, and claims no initialization', () => {
    expectInitRefused(freshHome('sthayi-startup-init-'), ['init']);
  });

  it('init --yes: the UNATTENDED path is gated too — nothing is wired over a blocked store', () => {
    expectInitRefused(freshHome('sthayi-startup-inityes-'), ['init', '--yes']);
  });

  it('bare `sthayi`: the documented first-run entry point inherits the same gate', () => {
    // The bare command runs the init flow itself on an uninitialized machine, so an init routed
    // through the gate that this path bypassed would leave the defect exactly where it was.
    expectInitRefused(freshHome('sthayi-startup-bare-'), []);
  });

  it('init CONTROL: an unjammed first run initializes, writes both launchers and the skills sample, and exits 0', () => {
    const home = freshHome('sthayi-startup-init-ok-');
    const r = runCli(home, ['init']);
    const label = `${r.stdout}\n---\n${r.stderr}`;
    expect(r.status, label).toBe(0);
    expect(r.stdout).toMatch(/Sthayi initialized/);
    expect(r.stdout).not.toMatch(/DEGRADED/);
    const launcherSuffix = process.platform === 'win32' ? '.cmd' : '';
    expect(fs.existsSync(path.join(home, 'bin', `sthayi-mcp${launcherSuffix}`))).toBe(true);
    expect(fs.existsSync(path.join(home, 'bin', `sthayi${launcherSuffix}`))).toBe(true);
    expect(fs.existsSync(path.join(home, 'skills'))).toBe(true);
    expect(fs.readFileSync(path.join(home, 'journal.checkpoint'), 'utf8').length).toBeGreaterThan(
      0,
    );
  });

  it('init --dry-run stays a PURE READ even when jammed — it opens no store, so there is nothing to gate', () => {
    const home = freshHome('sthayi-startup-initdry-');
    jam(home);
    const r = runCli(home, ['init', '--dry-run']);
    const label = `${r.stdout}\n---\n${r.stderr}`;
    expect(r.status, label).toBe(0);
    expect(r.stdout).toMatch(/Dry run — would initialize/);
    expect(r.stdout).toMatch(/create db/);
    expect(r.stdout).not.toMatch(/DEGRADED/);
    // not one byte: no database, so no seal, so nothing for the gate to report
    expect(fs.existsSync(path.join(home, 'sthayi.db'))).toBe(false);
    expect(fs.existsSync(path.join(home, 'bin'))).toBe(false);
    expect(fs.existsSync(path.join(home, 'skills'))).toBe(false);
  });

  // Each row keeps the real CLI/SQLite boundary and its own home. Giving each process its own
  // budget avoids turning aggregate Windows runner scheduling into a false safety failure.
  it.each(STORE_BACKED_COMMANDS)(
    '%s is gated before the store-backed command runs',
    (_label, args) => {
      // The channel is only a safety property if EVERY front door reads it: a single command still
      // exiting 0 over a blocked store is the whole defect, relocated.
      const home = freshHome('sthayi-startup-all-');
      jam(home);
      const r = runCli(home, args);
      const label = `${args.join(' ')}\n${r.stdout}\n---\n${r.stderr}`;
      expect(r.status, label).toBe(EXIT_COMMITTED_UNANCHORED);
      expect(r.stdout, label).toMatch(/DEGRADED/);
      expect(r.stdout, label).toMatch(/This command did NOT run/);
    },
    15_000,
  );

  it('serve (stdio) REFUSES to start, on stderr, leaving stdout — the JSON-RPC channel — untouched', () => {
    const home = freshHome('sthayi-startup-serve-');
    jam(home);
    const r = runCli(home, ['serve']);
    const label = `${r.stdout}\n---\n${r.stderr}`;
    expect(r.status, label).toBe(EXIT_COMMITTED_UNANCHORED);
    expectDegradedText(r.stderr, label);
    // stdout is the protocol channel in stdio mode: a client must never find a report where it
    // expects a frame.
    expect(r.stdout).toBe('');
  });

  it('serve --http REFUSES to start rather than serve a blocked store', () => {
    const home = freshHome('sthayi-startup-servehttp-');
    jam(home);
    const r = runCli(home, ['serve', '--http', '--port', '0']);
    const label = `${r.stdout}\n---\n${r.stderr}`;
    expect(r.status, label).toBe(EXIT_COMMITTED_UNANCHORED);
    expectDegradedText(r.stderr, label);
    expect(r.stdout).not.toMatch(/MCP endpoint listening/);
  });
});

describe('safety: the startup channel is a typed value, and its three states are distinct', () => {
  let home: FakeHome;

  afterEach(() => {
    removeOwned(home.path('journal.checkpoint.lock'));
    home.cleanup();
  });

  it("a clean first run reports 'clean' and blocks nothing", () => {
    home = createFakeHome();
    const store = openStore();
    try {
      expect(store.startup.map((s) => s.state)).toContain('clean');
      expect(startupBlockers(store.startup)).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("a jammed first run reports 'committed-unanchored' — durable, and every further write refuses", () => {
    home = createFakeHome();
    fs.mkdirSync(home.path('journal.checkpoint.lock'), { recursive: true });
    const store = openStore();
    try {
      const blocked = startupBlockers(store.startup);
      expect(blocked).toHaveLength(1);
      expect(blocked[0]?.step).toBe('first-run-seal');
      expectDegradedText(blocked[0]?.message ?? '', 'seal message');
      // COMMITTED is a claim about the database, and the database backs it
      expect(store.driver.allJournal().filter((r) => r.op === 'journal_seal')).toHaveLength(1);
      // …and the store really has stopped accepting writes
      expect(() => store.memory.add({ type: 'semantic', content: 'next' }, { now: 2 })).toThrow(
        /refusing to append/,
      );
    } finally {
      store.close();
    }
  });

  it(
    "a rows-bearing store with no checkpoint reports 'refused' — nothing was written",
    () => {
      home = createFakeHome();
      // A pre-checkpoint store: journal rows, no meta checkpoint, no checkpoint file. The auto-seal
      // fails CLOSED here, and a refusal is categorically different from the degraded state — it is
      // safe to re-run, because it wrote nothing.
      const driver = SqliteDriver.open(home.path('sthayi.db'));
      driver.migrate();
      const crypto = NodeCrypto.open(home.path('key'));
      new MemoryService(driver, new JournalService(driver, { crypto })).add(
        { type: 'semantic', content: 'a pre-checkpoint fact' },
        { now: 1 },
      );
      driver.close();
      // Both copies removed: an append refreshes the meta checkpoint too, so leaving it behind
      // would describe a store that already has one — not the pre-checkpoint store under test.
      const raw = new Database(home.path('sthayi.db'));
      raw.prepare("DELETE FROM meta WHERE k = 'journal_checkpoint'").run();
      raw.close();
      fs.rmSync(home.path('journal.checkpoint'), { force: true });

      const store = openStore();
      try {
        const refused = store.startup.filter((s) => s.state === 'refused');
        expect(refused).toHaveLength(1);
        expect(refused[0]?.step).toBe('first-run-seal');
        // a refusal is NOT reported as a committed outcome, and therefore blocks no front door
        expect(startupBlockers(store.startup)).toHaveLength(0);
        expect(store.driver.allJournal().filter((r) => r.op === 'journal_seal')).toHaveLength(0);
      } finally {
        store.close();
      }
    },
    process.platform === 'win32' ? 20_000 : 5_000,
  );

  it('the PII migration surfaces its own committed-unanchored outcome, with the receipt', () => {
    home = createFakeHome();
    // seed a healthy store, then make it look legacy
    const seed = openStore();
    seed.memory.add({ type: 'semantic', content: 'placeholder fact' }, { now: 1 });
    seed.close();
    makeLegacy(home.home);
    fs.mkdirSync(home.path('journal.checkpoint.lock'), { recursive: true });

    const store = openStore();
    try {
      const blocked = startupBlockers(store.startup);
      expect(blocked).toHaveLength(1);
      expect(blocked[0]?.step).toBe('pii-migration');
      // the receipt is the typed evidence, not a re-parsed sentence
      expect(blocked[0]?.receipt?.committed).toBe(true);
      expect(blocked[0]?.receipt?.anchor).toBe('unanchored');
      expect(blocked[0]?.receipt?.doNotRetry).toBe(true);
      expect(blocked[0]?.receipt?.writesBlocked).toBe(true);
      expect(blocked[0]?.receipt?.record.op).toBe('migrate_masking');
      expectDegradedText(blocked[0]?.message ?? '', 'migration message');
    } finally {
      store.close();
    }
  });

  it('the MCP startup path THROWS the typed error rather than serving a blocked store', async () => {
    home = createFakeHome();
    fs.mkdirSync(home.path('journal.checkpoint.lock'), { recursive: true });
    const { runServer } = await import('../../packages/cli/src/mcp/serve.js');
    // A server's only report is "it is running", so the outcome is reported by NOT running.
    // Called ONCE on purpose: the seal is a first-run mutation, so a second open finds the
    // checkpoint it committed and would legitimately start a server on this stdio pair.
    const err: unknown = await runServer().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(StartupUnanchoredError);
    expect((err as StartupUnanchoredError).blocked[0]?.step).toBe('first-run-seal');
    expect((err as Error).message).toMatch(/DO NOT RETRY/);
  });

  it('the HTTP MCP startup path refuses the same way', async () => {
    home = createFakeHome();
    fs.mkdirSync(home.path('journal.checkpoint.lock'), { recursive: true });
    const { runHttpServer } = await import('../../packages/cli/src/mcp/serve.js');
    await expect(runHttpServer({ port: 0 })).rejects.toBeInstanceOf(StartupUnanchoredError);
  });
});
