import fs from 'node:fs';
import path from 'node:path';
import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FakeHome, createFakeHome } from '../../../tests/helpers/fake-home.js';
import { buildProgram } from './index.js';
import { openStore } from './store.js';

/** Read the single pack file the command wrote under the fake home's export dir. */
function readPack(home: FakeHome): string {
  const dir = home.path('export');
  const files = fs.readdirSync(dir).sort();
  const last = files[files.length - 1];
  if (!last) {
    throw new Error('no pack file written');
  }
  return fs.readFileSync(path.join(dir, last), 'utf8');
}

/**
 * Pack policy: confirmed-only by default (with a review hint when proposals exist);
 * --include-proposals opts in, and the pack labels them in a segregated section.
 */
describe('pack command — proposal policy', () => {
  let home: FakeHome;
  let lines: string[];
  let spy: MockInstance;

  beforeEach(() => {
    home = createFakeHome();
    const now = Date.now();
    const store = openStore();
    store.memory.add(
      { type: 'semantic', content: 'confirmed pack fixture' },
      { now, asProposal: false },
    );
    store.memory.add({ type: 'procedural', content: 'unreviewed pack fixture' }, { now: now + 1 });
    store.close();
    lines = [];
    spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    spy.mockRestore();
    home.cleanup();
  });

  it('default pack excludes proposals and prints the review hint', async () => {
    await buildProgram().parseAsync(['pack'], { from: 'user' });
    const md = readPack(home);
    expect(md).toMatch(/confirmed pack fixture/);
    expect(md).not.toMatch(/unreviewed pack fixture/);
    expect(md).not.toMatch(/## Unreviewed proposals/);
    expect(md).toMatch(/_Contents: 1 confirmed memories_/);
    const printed = lines.join('');
    expect(printed).toMatch(
      /1 unreviewed proposal\(s\) not included — add --include-proposals, or review with: sthayi review/,
    );
  });

  it('--include-proposals renders them labeled in the segregated section', async () => {
    await buildProgram().parseAsync(['pack', '--include-proposals'], { from: 'user' });
    const md = readPack(home);
    expect(md).toMatch(/## Unreviewed proposals/);
    expect(md).toContain('- [procedural] unreviewed pack fixture');
    expect(md).toMatch(
      /_Contents: 1 confirmed memories, 1 unreviewed proposals \(labeled below\)_/,
    );
    const printed = lines.join('');
    expect(printed).toMatch(/1 confirmed \+ 1 proposed memory\(ies\)/);
    expect(printed).not.toMatch(/not included/);
  });
});

// Resource honesty: pack builds the whole document in memory (proportional to the matching
// memories) — the help must SAY so, and must not smuggle in a blanket resource-bounds claim.
describe('pack command — help acknowledges proportional memory', () => {
  it('the description names the in-memory, proportional-to-matches behavior', () => {
    const pack = buildProgram().commands.find((c) => c.name() === 'pack');
    expect(pack).toBeDefined();
    const desc = (pack as NonNullable<typeof pack>).description();
    expect(desc).toContain('Builds the whole document in memory');
    expect(desc).toContain('proportional to the number of matching memories');
    expect(desc).not.toMatch(/bounded memory|constant memory/i);
  });
});

/**
 * The export write goes through safeWriteFileAtomic (fs-safe hardened-write family): a planted
 * symlink at the export target is refused with the victim byte-identical, and a normal export
 * lands 0644 (a user-shareable document, not a secret).
 */
describe('pack command — hardened export write', () => {
  let home: FakeHome;
  let spy: MockInstance;

  beforeEach(() => {
    home = createFakeHome();
    const store = openStore();
    store.memory.add(
      { type: 'semantic', content: 'hardened write fixture' },
      { now: Date.now(), asProposal: false },
    );
    store.close();
    spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    spy.mockRestore();
    vi.restoreAllMocks();
    home.cleanup();
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a symlinked export target; the victim stays byte-identical',
    async () => {
      // Pin Date.now so the timestamped export filename is predictable — the attacker's
      // pre-planted symlink sits at the EXACT path the command will write.
      const FIXED = 1_753_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(FIXED);
      const target = home.path(
        'export',
        `context-${new Date(FIXED).toISOString().replace(/[:.]/g, '-')}.md`,
      );
      const victim = home.path('victim.md');
      fs.writeFileSync(victim, 'VICTIM BYTES');
      fs.mkdirSync(home.path('export'), { recursive: true });
      fs.symlinkSync(victim, target);

      await expect(buildProgram().parseAsync(['pack'], { from: 'user' })).rejects.toThrow(
        /symlink/,
      );
      // the symlink was never followed, the victim never written, no temp debris left behind
      expect(fs.readFileSync(victim, 'utf8')).toBe('VICTIM BYTES');
      expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
      expect(fs.readdirSync(home.path('export')).filter((f) => f.includes('.sthayi-tmp'))).toEqual(
        [],
      );
    },
  );

  it('a normal export still works and lands 0644 (user-shareable document)', async () => {
    await buildProgram().parseAsync(['pack'], { from: 'user' });
    const md = readPack(home);
    expect(md).toContain('hardened write fixture');
    if (process.platform !== 'win32') {
      const dir = home.path('export');
      const files = fs.readdirSync(dir).sort();
      const last = files[files.length - 1] as string;
      expect(fs.statSync(path.join(dir, last)).mode & 0o777).toBe(0o644);
    }
  });
});
