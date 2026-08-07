import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FakeHome, createFakeHome } from '../../../tests/helpers/fake-home.js';
import { runTempDir } from '../../../tests/helpers/run-temp.js';
import { SqliteDriver } from './drivers/sqlite.js';
import { formatScore } from './format.js';
import { COMMANDS, REVIEW_PAGE_MAX, VERSION, buildProgram } from './index.js';
import { openStore } from './store.js';

describe('cli program', () => {
  it('names itself sthayi and reports the version', () => {
    const program = buildProgram();
    expect(program.name()).toBe('sthayi');
    expect(program.version()).toBe(VERSION);
  });

  it('registers every v0 subcommand', () => {
    const program = buildProgram();
    const registered = program.commands.map((c) => c.name()).sort();
    const expected = COMMANDS.map((c) => c.name).sort();
    expect(registered).toEqual(expected);
  });

  it('lists all subcommands in --help output', () => {
    const help = buildProgram().helpInformation();
    for (const cmd of COMMANDS) {
      expect(help).toContain(cmd.name);
    }
  });

  it('covers the whole spec §0 command surface + B6 entities + B9 index (17 commands)', () => {
    expect(COMMANDS).toHaveLength(17);
  });
});

describe('search --scope and score rendering', () => {
  let home: FakeHome;
  let chunks: string[];
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    home = createFakeHome();
    chunks = [];
    spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    }) as ReturnType<typeof vi.spyOn>;
  });

  afterEach(() => {
    spy.mockRestore();
    home.cleanup();
  });

  /** One matching memory per scope, so scope filtering has something to exclude. */
  function seed(): void {
    const store = openStore();
    try {
      const opts = { now: Date.now(), actor: 'test', asProposal: false, warnings: [] };
      store.memory.add(
        {
          type: 'semantic',
          scope: 'user',
          content: 'shibboleth fact in the user scope',
          confidence: 0.9,
          source: 't',
        },
        opts,
      );
      store.memory.add(
        {
          type: 'semantic',
          scope: 'project:alpha',
          content: 'shibboleth fact in the alpha project',
          confidence: 0.9,
          source: 't',
        },
        opts,
      );
    } finally {
      store.close();
    }
  }

  interface JsonHit {
    memory: { scope: string; content: string };
    score: number;
  }

  /** `search --json` emits ONE document: the hits plus the search's own mutation outcome. */
  interface SearchEnvelope {
    hits: JsonHit[];
    mutation: { state: string; anchor?: string; journalId?: number; message?: string };
  }

  async function run(args: string[]): Promise<string> {
    chunks.length = 0;
    await buildProgram().parseAsync(['node', 'sthayi', ...args]);
    return chunks.join('');
  }

  /** Parse the whole stdout as ONE JSON document — anything printed beside it fails here. */
  function envelope(stdout: string): SearchEnvelope {
    return JSON.parse(stdout) as SearchEnvelope;
  }

  it('--scope restricts CLI results to exactly that scope (--json emits one envelope)', async () => {
    seed();
    const scoped = envelope(
      await run(['search', 'shibboleth', '--scope', 'project:alpha', '--json']),
    );
    expect(scoped.hits.length).toBeGreaterThan(0);
    for (const h of scoped.hits) {
      expect(h.memory.scope).toBe('project:alpha');
    }
    // and without --scope, both scopes surface — proving the filter did the narrowing
    const all = envelope(await run(['search', 'shibboleth', '--json']));
    expect(new Set(all.hits.map((h) => h.memory.scope))).toEqual(
      new Set(['user', 'project:alpha']),
    );
    // The search's retrieval bump is a WRITE, and the envelope states what it achieved — a
    // healthy store anchors it, and the fact is structure a consumer can branch on rather than
    // prose it would have to parse out of the same stream as the hits.
    expect(all.mutation.state).toBe('committed');
    expect(all.mutation.anchor).toBe('anchored');
    expect(all.mutation.journalId).toBeTypeOf('number');
  });

  it('--scope also filters the human-readable table', async () => {
    seed();
    const table = await run(['search', 'shibboleth', '--scope', 'user']);
    expect(table).toContain('user scope');
    expect(table).not.toContain('alpha project');
  });

  it('score column renders 3 significant figures and never a flat 0.00 for a nonzero score', async () => {
    // Fillers keep the bm25 idf healthy; the confidence-0.001 hit lands a real-but-faint score
    // (~1e-3) — a fixed-2-decimal rendering would flatten it to a dead "0.00".
    const store = openStore();
    try {
      const mk = (content: string, confidence: number) =>
        store.memory.add(
          { type: 'semantic' as const, scope: 'user', content, confidence, source: 't' },
          { now: Date.now(), actor: 'test', asProposal: false, warnings: [] },
        );
      mk('filler one about the weather', 0.9);
      mk('filler two about the roadmap', 0.9);
      mk('filler three about lunch', 0.9);
      mk('glimmer of a strong fact', 0.9);
      mk('glimmer of a faint trace', 0.001);
    } finally {
      store.close();
    }
    const table = await run(['search', 'glimmer']);
    const cells = table
      .split('\n')
      .filter((l) => /^\d/.test(l))
      .map((l) => l.split(/\s+/)[0] as string);
    expect(cells.length, table).toBe(2);
    for (const cell of cells) {
      expect(Number(cell), `cell ${cell}`).toBeGreaterThan(0); // a nonzero score never renders as zero
      expect(cell).not.toBe('0.00');
      expect(cell).toBe(formatScore(Number(cell))); // exactly the 3-significant-figure rendering
    }
    // formatting is display-only: the column still descends in ranking order
    const nums = cells.map(Number);
    expect(nums[0] as number).toBeGreaterThan(nums[1] as number);
    // the faint hit stayed distinguishable below 0.01 — the exact case toFixed(2) destroyed
    expect(nums[1] as number).toBeLessThan(0.01);
    expect(table).not.toMatch(/^0\.00\s/m);
  });
});

describe('journal --details: reviewable contradictions', () => {
  let home: FakeHome;
  let chunks: string[];
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    home = createFakeHome();
    chunks = [];
    spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    }) as ReturnType<typeof vi.spyOn>;
  });

  afterEach(() => {
    spy.mockRestore();
    home.cleanup();
  });

  async function run(args: string[]): Promise<string> {
    chunks.length = 0;
    await buildProgram().parseAsync(['node', 'sthayi', ...args]);
    return chunks.join('');
  }

  it("renders each pair's ids and the journaled reason IN FULL (the pointer target)", async () => {
    // Long enough that any snippet()-style truncation would provably cut it.
    const reason =
      'the first memory says the deployment moved to Fridays while the second says deployments ' +
      'are frozen on Fridays — both cannot hold; review which policy is current and reject the other';
    let a = '';
    let b = '';
    const store = openStore();
    try {
      const now = Date.now();
      a = store.memory.add(
        { type: 'semantic', content: 'deployments happen on fridays' },
        { now, asProposal: false },
      ).id;
      b = store.memory.add(
        { type: 'semantic', content: 'deployments are frozen on fridays' },
        { now: now + 1, asProposal: false },
      ).id;
      // seeded via the service, exactly as ConsolidationService journals oracle contradictions
      store.journal.append({
        ts: now + 2,
        actor: 'oracle:mock:test',
        op: 'consolidate_contradictions',
        payload: { pairs: [{ a, b, reason }] },
      });
    } finally {
      store.close();
    }

    const detailed = await run(['journal', '--details']);
    expect(detailed).toContain('consolidate_contradictions');
    expect(detailed).toContain(a);
    expect(detailed).toContain(b);
    // the complete journaled reason (masked + bounded at write time) — never truncated further
    expect(detailed).toContain(reason);

    // without --details the summary line stays terse (the reason is a --details affair)
    const plain = await run(['journal']);
    expect(plain).toContain('consolidate_contradictions');
    expect(plain).not.toContain(reason);
  });

  // Reachability invariant: a recent-N default view ages contradictions out — the --op route
  // must reach them regardless of how many entries land after them.
  it('1 contradiction + 21 later records: `journal --op consolidate_contradictions` still shows it', async () => {
    const reason = 'policy X and policy Y cannot both hold — review which is current';
    let a = '';
    let b = '';
    const store = openStore();
    try {
      const now = Date.now();
      a = store.memory.add(
        { type: 'semantic', content: 'policy x is in force' },
        { now, asProposal: false },
      ).id;
      b = store.memory.add(
        { type: 'semantic', content: 'policy y is in force' },
        { now: now + 1, asProposal: false },
      ).id;
      store.journal.append({
        ts: now + 2,
        actor: 'oracle:mock:test',
        op: 'consolidate_contradictions',
        payload: { pairs: [{ a, b, reason }] },
      });
      // 21 later journal entries push the contradiction out of the default recent-20 window
      for (let i = 0; i < 21; i++) {
        store.memory.add(
          { type: 'semantic', content: `later unrelated record number ${i}` },
          { now: now + 3 + i, asProposal: false },
        );
      }
    } finally {
      store.close();
    }

    // the default recent view no longer surfaces it (that is fine — it is a recency window)…
    const recent = await run(['journal', '--details']);
    expect(recent).not.toContain('consolidate_contradictions');

    // …but the guaranteed route — the EXACT invocation the consolidate summary names —
    // lists it with both ids and the complete journaled reason
    const guaranteed = await run(['journal', '--op', 'consolidate_contradictions', '--details']);
    expect(guaranteed).toContain('consolidate_contradictions');
    expect(guaranteed).toContain(a);
    expect(guaranteed).toContain(b);
    expect(guaranteed).toContain(reason);
    // and the scan is an op FILTER, not a full dump
    expect(guaranteed).not.toContain('memory_write');

    // an op with no entries says so instead of printing nothing
    expect(await run(['journal', '--op', 'no_such_op'])).toContain(
      "no journal entries with op 'no_such_op'.",
    );
  });
});

// `sthayi review` must stay storage-bounded on a large queue: the list serves ONE SQL-bounded
// page, and --confirm-all drains via repeated-first-page keyset loops — the full queue is never
// materialized in this process (proven by driver spies).
describe('review pagination (storage-bounded list + keyset confirm-all)', () => {
  let home: FakeHome;
  let chunks: string[];
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    home = createFakeHome();
    chunks = [];
    spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    }) as ReturnType<typeof vi.spyOn>;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    spy.mockRestore();
    home.cleanup();
  });

  async function run(args: string[]): Promise<string> {
    chunks.length = 0;
    await buildProgram().parseAsync(['node', 'sthayi', ...args]);
    return chunks.join('');
  }

  /** Seed `n` proposals (batched writes — journaled, exactly like real MCP/CLI writes). */
  function seedProposals(n: number, type: 'episodic' | 'semantic' | 'procedural' = 'semantic') {
    const store = openStore();
    try {
      const now = Date.now();
      const drafts = Array.from({ length: n }, (_, i) => ({
        type,
        content: `${type} proposal fixture number ${i}`,
      }));
      for (let i = 0; i < drafts.length; i += 50) {
        store.memory.write(drafts.slice(i, i + 50), { now: now + i, actor: 'test' });
      }
    } finally {
      store.close();
    }
  }

  /** Lines that render a proposal row (two-space indent + 26-char ulid). */
  function proposalRows(text: string): string[] {
    return text.split('\n').filter((l) => /^ {2}[0-9A-HJKMNP-TV-Z]{26} {2}/.test(l));
  }

  it('300-proposal queue: the list is BOUNDED (default 50) and storage-paged, with -n/--offset', async () => {
    seedProposals(300);
    const pageSpy = vi.spyOn(SqliteDriver.prototype, 'listMemoriesPage');
    const listSpy = vi.spyOn(SqliteDriver.prototype, 'listMemories');

    const text = await run(['review']);
    expect(text).toContain('300 proposal(s)');
    expect(proposalRows(text)).toHaveLength(50); // bounded default page, not the whole queue
    expect(text).toContain('showing 50 of 300 (offset 0)');
    expect(text).toContain('--offset 50'); // next-page pointer

    const page2 = await run(['review', '-n', '10', '--offset', '295']);
    expect(proposalRows(page2)).toHaveLength(5); // the tail page
    expect(page2).toContain('showing 5 of 300 (offset 295)');

    // every page came from the storage layer, bounded — and the unpaged full-queue path
    // (listMemories) was never taken
    for (const call of pageSpy.mock.calls) {
      expect((call[1] as { limit: number }).limit).toBeLessThanOrEqual(50);
    }
    expect(pageSpy.mock.calls.length).toBeGreaterThan(0);
    expect(listSpy).not.toHaveBeenCalled();
  });

  it('confirm-all drains all 300 via repeated-first-page keyset loops, never materializing the queue', async () => {
    seedProposals(300);
    const pageSpy = vi.spyOn(SqliteDriver.prototype, 'listMemoriesPage');
    const listSpy = vi.spyOn(SqliteDriver.prototype, 'listMemories');

    const text = await run(['review', '--confirm-all']);
    expect(text).toContain('confirmed 300 memory(ies) as trusted.');

    // keyset discipline: every storage call was a bounded FIRST page (offset 0) — statuses
    // change as we confirm, so re-reading page one visits every row without skipping any
    expect(pageSpy.mock.calls.length).toBeGreaterThanOrEqual(3); // 300 rows / 100-page bound
    for (const call of pageSpy.mock.calls) {
      const page = call[1] as { limit: number; offset: number };
      expect(page.limit).toBeLessThanOrEqual(100);
      expect(page.offset).toBe(0);
    }
    expect(listSpy).not.toHaveBeenCalled(); // the full queue was never materialized

    const store = openStore();
    try {
      expect(store.driver.countMemories({ status: 'proposed' })).toBe(0);
      expect(store.driver.countMemories({ status: 'confirmed' })).toBe(300);
    } finally {
      store.close();
    }
  });

  it('confirm-all --type filters in the SQL page and leaves other types proposed', async () => {
    seedProposals(120, 'semantic');
    seedProposals(30, 'procedural');
    const text = await run(['review', '--confirm-all', '--type', 'semantic']);
    expect(text).toContain('confirmed 120 semantic memory(ies) as trusted.');
    const store = openStore();
    try {
      expect(store.driver.countMemories({ status: 'confirmed', type: 'semantic' })).toBe(120);
      expect(store.driver.countMemories({ status: 'proposed', type: 'procedural' })).toBe(30);
    } finally {
      store.close();
    }
  });

  it('an unknown --type errors up front instead of silently confirming nothing', async () => {
    seedProposals(1);
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await run(['review', '--confirm-all', '--type', 'bogus']);
    expect(errSpy.mock.calls.join('')).toContain('--type must be episodic | semantic | procedural');
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined; // never leak a failure code into the harness
    const store = openStore();
    try {
      expect(store.driver.countMemories({ status: 'proposed' })).toBe(1); // nothing confirmed
    } finally {
      store.close();
    }
  });

  it(`-n is capped at the documented maximum (${REVIEW_PAGE_MAX}) — the cap renders, one past it is refused`, async () => {
    seedProposals(250);
    const text = await run(['review', '-n', String(REVIEW_PAGE_MAX)]);
    expect(proposalRows(text)).toHaveLength(REVIEW_PAGE_MAX);
    expect(text).toContain(`showing ${REVIEW_PAGE_MAX} of 250`);

    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const over = await run(['review', `--n=${REVIEW_PAGE_MAX + 1}`]);
    expect(proposalRows(over)).toHaveLength(0);
    expect(errSpy.mock.calls.join('')).toContain(
      `-n must be a whole number from 1 to ${REVIEW_PAGE_MAX}`,
    );
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined; // never leak a failure code into the harness
  });

  it('the maximum is documented in --help so the refusal is never a surprise', () => {
    const review = buildProgram().commands.find((c) => c.name() === 'review');
    const help = review?.helpInformation() ?? '';
    expect(help).toContain(`1-${REVIEW_PAGE_MAX}`);
  });

  // An unbounded page size is a resource hazard: `review -n 1000` against a 300-proposal queue
  // materializes and renders every row with no paging message. Every shape below is refused
  // BEFORE the database is opened, so a bad page size costs neither a store open nor a SQL LIMIT.
  it.each([
    ['1000', 'far past the maximum'],
    ['201', 'one past the maximum'],
    ['1e21', 'a huge exponent literal that parseInt would have read as 1'],
    [String(Number.MAX_SAFE_INTEGER + 1), 'beyond 2^53 — no longer an exact integer'],
    ['Infinity', 'non-finite'],
    ['abc', 'non-numeric'],
    ['50nonsense', 'numeric prefix that parseInt would have accepted as 50'],
    ['1.5', 'fractional'],
    ['0', 'zero'],
    ['-5', 'negative'],
    ['', 'empty'],
  ])('review --n=%s is refused before the store opens (%s)', async (value) => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const openSpy = vi.spyOn(SqliteDriver, 'open');
    const text = await run(['review', `--n=${value}`]);
    expect(openSpy, 'the store was opened despite an invalid page size').not.toHaveBeenCalled();
    expect(errSpy.mock.calls.join('')).toContain(
      `-n must be a whole number from 1 to ${REVIEW_PAGE_MAX}`,
    );
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    expect(proposalRows(text)).toHaveLength(0);
  });

  it('--offset is validated the same way, before the store opens', async () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const openSpy = vi.spyOn(SqliteDriver, 'open');
    await run(['review', '--offset=-1']);
    expect(openSpy).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.join('')).toContain('--offset must be a whole number of 0 or more');
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });

  it('normal paging still works across the whole queue', async () => {
    seedProposals(120);
    const first = await run(['review', '-n', '40']);
    expect(proposalRows(first)).toHaveLength(40);
    expect(first).toContain('showing 40 of 120 (offset 0)');
    expect(first).toContain('--offset 40');
    const last = await run(['review', '-n', '40', '--offset', '80']);
    expect(proposalRows(last)).toHaveLength(40);
    expect(last).toContain('showing 40 of 120 (offset 80)');
  });
});

describe('bare `sthayi` routing', () => {
  let home: FakeHome;
  let chunks: string[];
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    home = createFakeHome();
    chunks = [];
    spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    }) as ReturnType<typeof vi.spyOn>;
  });

  afterEach(() => {
    spy.mockRestore();
    home.cleanup();
  });

  it('uninitialized: runs the init flow (non-TTY: creates the home, never wires clients)', async () => {
    await buildProgram().parseAsync(['node', 'sthayi']);
    const all = chunks.join('');
    expect(all).toContain('Sthayi initialized');
    expect(all).not.toContain('Sthayi is initialized.'); // the other branch's line
    // the flow created the store + launcher…
    expect(fs.existsSync(home.path('sthayi.db'))).toBe(true);
    expect(fs.existsSync(home.path('key'))).toBe(true);
    const launcher =
      process.platform === 'win32'
        ? `${home.path('bin', 'sthayi-mcp')}.cmd`
        : home.path('bin', 'sthayi-mcp');
    expect(fs.existsSync(launcher)).toBe(true);
    // …and without a TTY it must have skipped client wiring (no unauthorized config edits)
    expect(all).not.toMatch(/^Wiring:/m);
  });

  it('initialized: prints the one-line pointer + status instead of re-running init', async () => {
    openStore().close();
    await buildProgram().parseAsync(['node', 'sthayi']);
    const all = chunks.join('');
    expect(all).toContain(
      'Sthayi is initialized. (`sthayi --help` for commands; `sthayi doctor` to diagnose.)',
    );
    expect(all).toMatch(/client\s+detected\s+wired/); // runStatus header
    expect(all).not.toContain('Sthayi initialized at');
  });

  // SAFETY: the bare command must not inspect the db or the key with `fs.existsSync`, and must not
  // inspect them at all before the home is validated. existsSync FOLLOWS symlinks, so a planted
  // link answers about a path OUTSIDE the home: an existing target would print "Sthayi is
  // initialized." over an attacker's file, and a dangling one would read as "nothing here" and
  // route the first-run initializer at the link. The presence probes are therefore lstat-based
  // (never the target), and the home is validated first.
  describe('no-follow presence probes (never inspect a symlink target)', () => {
    let outside: string;
    let errors: string[];
    let errSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      outside = runTempDir('sthayi-outside-');
      errors = [];
      errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        errors.push(String(chunk));
        return true;
      }) as ReturnType<typeof vi.spyOn>;
    });

    afterEach(() => {
      errSpy.mockRestore();
      process.exitCode = undefined;
      fs.rmSync(outside, { recursive: true, force: true });
    });

    /**
     * Record every path the process hands to a LINK-FOLLOWING filesystem call. `lstat` is
     * deliberately absent: inspecting the link itself is the safe behaviour being asserted, while
     * any of these reaching the target is the disclosure being ruled out.
     */
    function recordFollowingProbes(): { paths: string[]; restore: () => void } {
      const paths: string[] = [];
      const spies = (['existsSync', 'statSync', 'openSync', 'readFileSync'] as const).map(
        (name) => {
          const original = fs[name] as (...a: never[]) => unknown;
          return vi.spyOn(fs, name).mockImplementation(((...args: never[]) => {
            paths.push(String(args[0]));
            return original(...args);
          }) as never);
        },
      );
      return {
        paths,
        restore: () => {
          for (const s of spies) {
            s.mockRestore();
          }
        },
      };
    }

    it('a db path that is a SYMLINK to an existing outside file is refused, never reported as initialized', async () => {
      const target = path.join(outside, 'someone-elses.db');
      fs.writeFileSync(target, 'not a sthayi store', { mode: 0o600 });
      fs.symlinkSync(target, home.path('sthayi.db'));

      const probes = recordFollowingProbes();
      try {
        await buildProgram().parseAsync(['node', 'sthayi']);
      } finally {
        probes.restore();
      }

      const all = chunks.join('');
      expect(all).not.toContain('Sthayi is initialized.');
      expect(all).not.toContain('Sthayi initialized'); // nor did it initialize over the link
      // The refusal NAMES the clause that fired (symlink) and then the whole policy — never a
      // generic "symlink or not a regular file" that leaves a hard-link victim guessing.
      expect(errors.join('')).toMatch(/memory database at .*sthayi\.db is a symlink/);
      expect(errors.join('')).toMatch(/refusing to initialize over it/);
      expect(process.exitCode).toBe(1);
      // not one following stat reached the target — its existence was never inspected
      expect(probes.paths.filter((p) => p.startsWith(outside))).toEqual([]);
      // and the link itself was left exactly as it was found
      expect(fs.lstatSync(home.path('sthayi.db')).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(target, 'utf8')).toBe('not a sthayi store');
    });

    it('a DANGLING db symlink is PRESENT-and-hostile, not "uninitialized" (no init runs at it)', async () => {
      const target = path.join(outside, 'never-created.db');
      fs.symlinkSync(target, home.path('sthayi.db'));

      await buildProgram().parseAsync(['node', 'sthayi']);

      expect(chunks.join('')).not.toContain('Sthayi initialized');
      expect(errors.join('')).toMatch(/memory database at .*sthayi\.db is a symlink/);
      expect(errors.join('')).toMatch(/refusing to initialize over it/);
      expect(process.exitCode).toBe(1);
      expect(fs.existsSync(target)).toBe(false); // nothing was created through the link
      expect(fs.lstatSync(home.path('sthayi.db')).isSymbolicLink()).toBe(true);
    });

    it('a key path that is a SYMLINK is refused the same way', async () => {
      const target = path.join(outside, 'someone-elses.key');
      fs.writeFileSync(target, 'not our key', { mode: 0o600 });
      fs.symlinkSync(target, home.path('key'));

      await buildProgram().parseAsync(['node', 'sthayi']);

      expect(chunks.join('')).not.toContain('Sthayi is initialized.');
      expect(errors.join('')).toMatch(/vault key at .*key is a symlink/);
      expect(errors.join('')).toMatch(/refusing to initialize over it/);
      expect(process.exitCode).toBe(1);
      expect(fs.readFileSync(target, 'utf8')).toBe('not our key');
    });

    it('a SYMLINKED HOME is refused before anything beneath it is probed', async () => {
      const realHome = path.join(outside, 'real-home');
      fs.mkdirSync(realHome, { mode: 0o700 });
      fs.writeFileSync(path.join(realHome, 'sthayi.db'), 'planted', { mode: 0o600 });
      const linkedHome = path.join(outside, 'linked-home');
      fs.symlinkSync(realHome, linkedHome);
      const previous = process.env.STHAYI_HOME;
      process.env.STHAYI_HOME = linkedHome;

      const probes = recordFollowingProbes();
      let message = '';
      try {
        await buildProgram().parseAsync(['node', 'sthayi']);
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      } finally {
        probes.restore();
        process.env.STHAYI_HOME = previous;
      }

      expect(message).toMatch(/symlink/i);
      expect(chunks.join('')).not.toContain('Sthayi is initialized.');
      // the db beneath the symlinked home was never inspected, by any following call
      expect(probes.paths.filter((p) => p.includes('sthayi.db'))).toEqual([]);
    });
  });
});

// SAFETY: `journal reseal` must never claim it rewrote BOTH checkpoints when the
// external file write did not land. The database half commits transactionally; the file half can
// fail on its own, and the command's entire promise is about both.
describe('`journal reseal` reports a partial failure honestly', () => {
  let home: FakeHome;
  let chunks: string[];
  let errors: string[];
  let spy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  /** The claim the command may only make when both copies are confirmed. */
  const BOTH = 'authenticated checkpoint rewritten (store meta + journal.checkpoint file).';
  const BAD_MAC = JSON.stringify({
    v: 1,
    count: 9,
    tipId: 9,
    tipHash: 'f'.repeat(64),
    mac: 'not-a-mac-this-key-ever-produced',
  });

  beforeEach(() => {
    home = createFakeHome();
    chunks = [];
    errors = [];
    spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    }) as ReturnType<typeof vi.spyOn>;
    errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      errors.push(String(chunk));
      return true;
    }) as ReturnType<typeof vi.spyOn>;
  });

  afterEach(() => {
    spy.mockRestore();
    errSpy.mockRestore();
    process.exitCode = undefined;
    fs.rmSync(`${home.path('journal.checkpoint')}.lock`, { recursive: true, force: true });
    home.cleanup();
  });

  it('a jammed checkpoint file: exits NONZERO, says INCOMPLETE, and never claims both copies', async () => {
    openStore().close();
    const cpFile = home.path('journal.checkpoint');
    fs.writeFileSync(cpFile, BAD_MAC, { mode: 0o600 }); // the tamper evidence being resealed away
    // a lock path that is not a regular file: the store fails closed on it — deterministic, no
    // waiting, and the same refusal a genuinely held lock produces
    fs.mkdirSync(`${cpFile}.lock`);

    await buildProgram().parseAsync(['node', 'sthayi', 'journal', 'reseal']);

    const all = chunks.join('');
    expect(all).toContain('reseal INCOMPLETE:');
    expect(all).toContain('the journal.checkpoint file was NOT');
    expect(all, 'claimed both checkpoints were rewritten').not.toContain(BOTH);
    expect(all).not.toContain('reseal refused'); // it was not refused — half of it happened
    expect(process.exitCode).toBe(1);
    // the file really is untouched, so the report matches the disk
    expect(fs.readFileSync(cpFile, 'utf8')).toBe(BAD_MAC);

    // …and a FRESH verify agrees with what the command reported
    fs.rmSync(`${cpFile}.lock`, { recursive: true, force: true });
    chunks.length = 0;
    process.exitCode = undefined;
    await buildProgram().parseAsync(['node', 'sthayi', 'journal', '--verify']);
    expect(chunks.join('')).toContain('JOURNAL VERIFY FAILED');
    expect(process.exitCode).toBe(1);
  });

  it('a reseal that DID write both copies still prints the claim and exits zero', async () => {
    openStore().close();
    const cpFile = home.path('journal.checkpoint');
    fs.writeFileSync(cpFile, BAD_MAC, { mode: 0o600 });

    await buildProgram().parseAsync(['node', 'sthayi', 'journal', 'reseal']);

    const all = chunks.join('');
    expect(all).toContain('resealed: accepted');
    expect(all).toContain(BOTH);
    expect(all).not.toContain('INCOMPLETE');
    expect(process.exitCode).toBeUndefined();
    expect(fs.readFileSync(cpFile, 'utf8')).not.toBe(BAD_MAC);

    chunks.length = 0;
    await buildProgram().parseAsync(['node', 'sthayi', 'journal', '--verify']);
    expect(chunks.join('')).toContain('chain + authenticated checkpoint intact');
    expect(process.exitCode).toBe(0); // green, exactly as the command claimed
  });
});
