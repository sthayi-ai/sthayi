import nodeCrypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as jsonc from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import { describe, expect, it, vi } from 'vitest';
import type { ClientAdapter } from '../../packages/cli/src/clients/adapter.js';
import { JsonMcpAdapter } from '../../packages/cli/src/clients/json-adapter.js';
import type { ClientState } from '../../packages/cli/src/clients/state.js';
import { TomlMcpAdapter } from '../../packages/cli/src/clients/toml-adapter.js';
import { createFakeHome, snapshotTree } from '../helpers/fake-home.js';

/**
 * SAFETY TESTS 1–2 (spec §7): for every client adapter and every fixture (clean + a variant with
 * pre-existing OTHER mcpServers entries), prove wire→unwire restores the config BYTE-EXACT, wire is
 * idempotent, and dry-run writes nothing. Also: a config that DRIFTED after wire (clients rewrite
 * their own configs) is never wholesale-restored or deleted — unwire removes only the sthayi entry
 * and every post-wire change survives. Corrupting a user's client config is the worst thing
 * Sthayi can do — this is the release gate that prevents it.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixturesRoot = path.join(repoRoot, 'tests', 'fixtures', 'clients');
const LAUNCHER = '/opt/launch/mcp-bin'; // deliberately contains no "sthayi" substring
const NOW = 1_700_000_000_000;

interface Case {
  id: string;
  fixtureDir: string;
  kind: 'json' | 'toml';
  clean: string;
  populated: string;
  ext: string;
  /** JSON container object for server entries (default mcpServers; VS Code uses servers) */
  containerKey?: string;
  /** custom entry shape, mirroring the real adapter registration in clients/index.ts */
  entryValue?: (launcherCommand: string) => Record<string, unknown>;
}

const CASES: Case[] = [
  {
    id: 'claude-desktop',
    fixtureDir: 'claude-desktop',
    kind: 'json',
    clean: 'clean.json',
    populated: 'populated.json',
    ext: '.json',
  },
  {
    id: 'claude-code',
    fixtureDir: 'claude-code',
    kind: 'json',
    clean: 'clean.json',
    populated: 'populated.json',
    ext: '.json',
  },
  {
    id: 'cursor',
    fixtureDir: 'cursor',
    kind: 'json',
    clean: 'clean.json',
    populated: 'populated.json',
    ext: '.json',
  },
  {
    id: 'gemini-cli',
    fixtureDir: 'gemini-cli',
    kind: 'json',
    clean: 'clean.json',
    populated: 'populated.json',
    ext: '.json',
  },
  {
    id: 'codex',
    fixtureDir: 'codex-cli',
    kind: 'toml',
    clean: 'clean.toml',
    populated: 'populated.toml',
    ext: '.toml',
  },
  {
    id: 'vscode',
    fixtureDir: 'vscode',
    kind: 'json',
    clean: 'clean.json',
    populated: 'populated.json',
    ext: '.json',
    containerKey: 'servers',
    entryValue: (command) => ({ type: 'stdio', command, args: [] }),
  },
  {
    id: 'windsurf',
    fixtureDir: 'windsurf',
    kind: 'json',
    clean: 'clean.json',
    populated: 'populated.json',
    ext: '.json',
  },
  {
    id: 'cline',
    fixtureDir: 'cline',
    kind: 'json',
    clean: 'clean.json',
    populated: 'populated.json',
    ext: '.json',
    entryValue: (command) => ({ command, args: [], disabled: false, autoApprove: [] }),
  },
  {
    id: 'lmstudio',
    fixtureDir: 'lmstudio',
    kind: 'json',
    clean: 'clean.json',
    populated: 'populated.json',
    ext: '.json',
  },
  {
    id: 'warp',
    fixtureDir: 'warp',
    kind: 'json',
    clean: 'clean.json',
    populated: 'populated.json',
    ext: '.json',
  },
  {
    id: 'junie',
    fixtureDir: 'junie',
    kind: 'json',
    clean: 'clean.json',
    populated: 'populated.json',
    ext: '.json',
  },
  {
    // Zed's settings.json is JSONC — the fixtures carry comments that must survive byte-exact.
    id: 'zed',
    fixtureDir: 'zed',
    kind: 'json',
    clean: 'clean.json',
    populated: 'populated.json',
    ext: '.json',
    containerKey: 'context_servers',
  },
  {
    id: 'roo-code',
    fixtureDir: 'roo-code',
    kind: 'json',
    clean: 'clean.json',
    populated: 'populated.json',
    ext: '.json',
    entryValue: (command) => ({ command, args: [], disabled: false, alwaysAllow: [] }),
  },
  {
    id: 'visual-studio',
    fixtureDir: 'visual-studio',
    kind: 'json',
    clean: 'clean.json',
    populated: 'populated.json',
    ext: '.json',
    containerKey: 'servers',
    entryValue: (command) => ({ type: 'stdio', command, args: [] }),
  },
];

function buildAdapter(c: Case, configPath: string): ClientAdapter {
  const common = {
    id: c.id,
    label: c.id,
    resolveConfigPath: () => configPath,
    detect: () => true,
    launcherCommand: () => LAUNCHER,
    now: () => NOW,
  };
  return c.kind === 'json'
    ? new JsonMcpAdapter({ ...common, containerKey: c.containerKey, entryValue: c.entryValue })
    : new TomlMcpAdapter(common);
}

function jsonContainer(c: Case): string {
  return c.containerKey ?? 'mcpServers';
}

function sthayiCount(text: string, c: Case): number {
  if (c.kind === 'toml') {
    return (text.match(/\[mcp_servers\.sthayi\]/g) ?? []).length;
  }
  const parsed = jsonc.parse(text) as Record<string, Record<string, unknown> | undefined>;
  const container = parsed[jsonContainer(c)];
  return container && 'sthayi' in container ? 1 : 0;
}

function plant(c: Case, fixture: string, home: ReturnType<typeof createFakeHome>): string {
  const cfg = home.path('cfg', fixture);
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.copyFileSync(path.join(fixturesRoot, c.fixtureDir, fixture), cfg);
  return cfg;
}

function parseConfig(text: string, kind: 'json' | 'toml'): Record<string, unknown> {
  // jsonc.parse handles plain JSON and JSONC alike (Zed's settings.json carries comments).
  return kind === 'toml'
    ? (parseToml(text) as Record<string, unknown>)
    : (jsonc.parse(text) as Record<string, unknown>);
}

/** Simulate the client itself rewriting its config after wire: new server + new setting. */
function mutateConfig(cfg: string, c: Case): void {
  if (c.kind === 'toml') {
    fs.appendFileSync(cfg, '\n[mcp_servers.added_later]\ncommand = "other-tool"\n');
    return;
  }
  const key = jsonContainer(c);
  const fmt = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } };
  let text = fs.readFileSync(cfg, 'utf8');
  text = jsonc.applyEdits(text, jsonc.modify(text, ['postWireSetting'], true, fmt));
  text = jsonc.applyEdits(
    text,
    jsonc.modify(text, [key, 'added-later'], { command: 'other-tool' }, fmt),
  );
  fs.writeFileSync(cfg, text);
}

/** Did the post-wire mutation survive? Parses the config, so it also proves the file is valid. */
function hasMutation(text: string, c: Case): boolean {
  const parsed = parseConfig(text, c.kind);
  if (c.kind === 'toml') {
    const servers = parsed.mcp_servers as Record<string, unknown> | undefined;
    return Boolean(servers?.added_later);
  }
  const servers = parsed[jsonContainer(c)] as Record<string, unknown> | undefined;
  return parsed.postWireSetting === true && Boolean(servers?.['added-later']);
}

/** The parsed config minus exactly the sthayi server entry — what surgical unwire must leave. */
function withoutSthayi(parsed: Record<string, unknown>, c: Case): Record<string, unknown> {
  const containerKey = c.kind === 'toml' ? 'mcp_servers' : jsonContainer(c);
  const container = parsed[containerKey] as Record<string, unknown>;
  return {
    ...parsed,
    [containerKey]: Object.fromEntries(Object.entries(container).filter(([k]) => k !== 'sthayi')),
  };
}

describe('safety: client adapter wire/unwire', () => {
  for (const c of CASES) {
    for (const fixture of [c.clean, c.populated]) {
      it(`${c.id} / ${fixture}: wire → unwire restores byte-exact`, () => {
        const home = createFakeHome();
        try {
          const cfg = plant(c, fixture, home);
          const original = fs.readFileSync(cfg, 'utf8');

          const adapter = buildAdapter(c, cfg);
          expect(adapter.isWired()).toBe(false);

          adapter.wire();
          expect(adapter.isWired()).toBe(true);
          if (fixture === c.populated) {
            expect(sthayiCount(fs.readFileSync(cfg, 'utf8'), c)).toBe(1);
          }

          adapter.unwire();
          expect(adapter.isWired()).toBe(false);
          expect(fs.readFileSync(cfg, 'utf8')).toBe(original);
        } finally {
          home.cleanup();
        }
      });
    }

    it(`${c.id}: wire is idempotent (×3 → single entry, no further writes)`, () => {
      const home = createFakeHome();
      try {
        const cfg = plant(c, c.populated, home);
        const adapter = buildAdapter(c, cfg);
        adapter.wire();
        const afterFirst = fs.readFileSync(cfg, 'utf8');
        adapter.wire();
        adapter.wire();
        expect(fs.readFileSync(cfg, 'utf8')).toBe(afterFirst);
        expect(sthayiCount(afterFirst, c)).toBe(1);
      } finally {
        home.cleanup();
      }
    });

    it(`${c.id}: dry-run writes nothing`, () => {
      const home = createFakeHome();
      try {
        const cfg = plant(c, c.clean, home);
        const before = fs.readFileSync(cfg, 'utf8');
        const filesBefore = fs.readdirSync(path.dirname(cfg)).sort();

        const adapter = buildAdapter(c, cfg);
        const res = adapter.wire({ dryRun: true });
        expect(res.dryRun).toBe(true);
        expect(fs.readFileSync(cfg, 'utf8')).toBe(before);
        expect(fs.readdirSync(path.dirname(cfg)).sort()).toEqual(filesBefore);
        expect(adapter.isWired()).toBe(false);
      } finally {
        home.cleanup();
      }
    });

    it(`${c.id}: creates then removes a config that did not exist`, () => {
      const home = createFakeHome();
      try {
        const cfg = home.path('cfg', `fresh${c.ext}`);
        expect(fs.existsSync(cfg)).toBe(false);
        const adapter = buildAdapter(c, cfg);

        adapter.wire();
        expect(fs.existsSync(cfg)).toBe(true);
        expect(adapter.isWired()).toBe(true);

        adapter.unwire();
        expect(fs.existsSync(cfg)).toBe(false);
      } finally {
        home.cleanup();
      }
    });

    it(`${c.id}: unwire after post-wire edits keeps them (surgical removal, backup kept)`, () => {
      const home = createFakeHome();
      try {
        const cfg = plant(c, c.populated, home);
        const adapter = buildAdapter(c, cfg);
        adapter.wire();

        mutateConfig(cfg, c);
        const mutated = fs.readFileSync(cfg, 'utf8');

        const res = adapter.unwire();
        const after = fs.readFileSync(cfg, 'utf8');
        expect(adapter.isWired()).toBe(false);
        expect(sthayiCount(after, c)).toBe(0);
        expect(hasMutation(after, c)).toBe(true);
        // Exactly the sthayi entry is gone; every other key (pre-existing AND post-wire) survives.
        expect(parseConfig(after, c.kind)).toEqual(withoutSthayi(parseConfig(mutated, c.kind), c));
        // The pre-wire backup is untouched and surfaced to the user.
        expect(res.backupPath).toBeTruthy();
        expect(fs.existsSync(res.backupPath as string)).toBe(true);
        expect(res.message).toContain(res.backupPath as string);
      } finally {
        home.cleanup();
      }
    });

    it(`${c.id}: a ledger entry carrying no wire hash is treated as drifted — edits survive unwire`, () => {
      const home = createFakeHome();
      try {
        const cfg = plant(c, c.populated, home);
        const adapter = buildAdapter(c, cfg);
        adapter.wire();

        // Wire must record the content hash…
        const ledgerPath = home.path('clients-state.json');
        const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) as Record<
          string,
          ClientState
        >;
        const wired = ledger[c.id];
        expect(wired?.wireHash).toBeTruthy();
        // …but an entry carrying no hash offers no drift evidence, and without it unwire must
        // never wholesale-restore. Rewrite the entry into the hash-less shape.
        ledger[c.id] = {
          backupPath: wired?.backupPath ?? null,
          existedBefore: wired?.existedBefore ?? true,
          wiredAt: wired?.wiredAt ?? 0,
        };
        fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));

        mutateConfig(cfg, c);
        adapter.unwire();
        const after = fs.readFileSync(cfg, 'utf8');
        expect(adapter.isWired()).toBe(false);
        expect(sthayiCount(after, c)).toBe(0);
        expect(hasMutation(after, c)).toBe(true);
      } finally {
        home.cleanup();
      }
    });

    it(`${c.id}: wire-created config that gained entries is not deleted on unwire`, () => {
      const home = createFakeHome();
      try {
        const cfg = home.path('cfg', `fresh${c.ext}`);
        const adapter = buildAdapter(c, cfg);
        adapter.wire();

        mutateConfig(cfg, c); // user gained servers after wire created the file

        adapter.unwire();
        expect(fs.existsSync(cfg)).toBe(true);
        const after = fs.readFileSync(cfg, 'utf8');
        expect(sthayiCount(after, c)).toBe(0);
        expect(hasMutation(after, c)).toBe(true);
      } finally {
        home.cleanup();
      }
    });
  }
});

/**
 * False-wired detection: a config entry NAMED sthayi that does not match the canonical launcher wiring is a
 * BROKEN state — never "already wired". For every broken fixture: inspect says broken; a dry-run
 * only reports the repair (byte-for-byte no writes); a real wire repairs to canonical with a
 * backup of the original; a second wire is a no-op; unwire restores the original broken bytes.
 */
describe('safety: false-wired detection and repair', () => {
  interface BrokenCase {
    name: string;
    kind: 'json' | 'toml';
    content: string;
  }

  const BROKEN: BrokenCase[] = [
    {
      name: 'json: entry with no command',
      kind: 'json',
      content: '{\n  "mcpServers": {\n    "sthayi": {\n      "args": []\n    }\n  }\n}\n',
    },
    {
      name: 'json: wrong command (/definitely/missing/sthayi)',
      kind: 'json',
      content:
        '{\n  "mcpServers": {\n    "sthayi": {\n      "command": "/definitely/missing/sthayi",\n      "args": []\n    }\n  }\n}\n',
    },
    {
      name: 'json: right command, wrong args',
      kind: 'json',
      content: `{\n  "mcpServers": {\n    "sthayi": {\n      "command": ${JSON.stringify(LAUNCHER)},\n      "args": ["--oops"]\n    }\n  }\n}\n`,
    },
    {
      // The original false-wired repro: treated as "already wired" before tri-state diagnosis.
      name: 'toml: wrong command (/definitely/missing/sthayi)',
      kind: 'toml',
      content: '[mcp_servers.sthayi]\ncommand = "/definitely/missing/sthayi"\nargs = []\n',
    },
    {
      name: 'toml: entry with no command',
      kind: 'toml',
      content: '[mcp_servers.sthayi]\nargs = []\n',
    },
    {
      name: 'toml: right command, wrong args',
      kind: 'toml',
      content: `[mcp_servers.sthayi]\ncommand = ${JSON.stringify(LAUNCHER)}\nargs = ["--oops"]\n`,
    },
    {
      name: 'toml: unparseable config that names sthayi',
      kind: 'toml',
      content: '[mcp_servers.sthayi]\ncommand = "broken\n',
    },
  ];

  function adapterFor(b: BrokenCase, cfg: string): ClientAdapter {
    const common = {
      id: 'x',
      label: 'x',
      resolveConfigPath: () => cfg,
      detect: () => true,
      launcherCommand: () => LAUNCHER,
      now: () => NOW,
    };
    return b.kind === 'json' ? new JsonMcpAdapter(common) : new TomlMcpAdapter(common);
  }

  for (const b of BROKEN) {
    const ext = b.kind === 'json' ? '.json' : '.toml';

    it(`${b.name}: inspect() === broken (not wired, not absent)`, () => {
      const home = createFakeHome();
      try {
        const cfg = home.path('cfg', `config${ext}`);
        fs.mkdirSync(path.dirname(cfg), { recursive: true });
        fs.writeFileSync(cfg, b.content);
        const adapter = adapterFor(b, cfg);
        expect(adapter.inspect().state).toBe('broken');
        expect(adapter.isWired()).toBe(false);
      } finally {
        home.cleanup();
      }
    });

    it(`${b.name}: wire --dry-run reports "would repair" and writes nothing`, () => {
      const home = createFakeHome();
      try {
        const cfg = home.path('cfg', `config${ext}`);
        fs.mkdirSync(path.dirname(cfg), { recursive: true });
        fs.writeFileSync(cfg, b.content);
        const before = snapshotTree(home.home);

        const res = adapterFor(b, cfg).wire({ dryRun: true });
        expect(res.dryRun).toBe(true);
        expect(res.message).toMatch(/would repair/);
        expect(snapshotTree(home.home)).toEqual(before);
      } finally {
        home.cleanup();
      }
    });

    it(`${b.name}: real wire repairs to canonical, keeps a backup, second wire is a no-op`, () => {
      const home = createFakeHome();
      try {
        const cfg = home.path('cfg', `config${ext}`);
        fs.mkdirSync(path.dirname(cfg), { recursive: true });
        fs.writeFileSync(cfg, b.content);
        const adapter = adapterFor(b, cfg);

        const res = adapter.wire();
        expect(res.message).toBe('repaired');
        expect(adapter.inspect().state).toBe('wired');
        const repaired = fs.readFileSync(cfg, 'utf8');
        // exactly one canonical sthayi entry pointing at the launcher
        const parsed = parseConfig(repaired, b.kind);
        const container = (b.kind === 'toml' ? parsed.mcp_servers : parsed.mcpServers) as Record<
          string,
          { command?: string; args?: unknown[] }
        >;
        expect(container.sthayi?.command).toBe(LAUNCHER);
        expect(container.sthayi?.args).toEqual([]);
        if (b.kind === 'toml') {
          expect((repaired.match(/\[mcp_servers\.sthayi\]/g) ?? []).length).toBe(1);
        }
        // the original broken bytes are preserved in the backup
        expect(res.backupPath).toBeTruthy();
        expect(fs.readFileSync(res.backupPath as string, 'utf8')).toBe(b.content);

        // idempotent: a second wire changes nothing (no backup churn)
        const again = adapter.wire();
        expect(again.message).toBe('already wired');
        expect(again.changed).toBe(false);
        expect(fs.readFileSync(cfg, 'utf8')).toBe(repaired);
      } finally {
        home.cleanup();
      }
    });

    it(`${b.name}: unwire after repair restores the original broken bytes`, () => {
      const home = createFakeHome();
      try {
        const cfg = home.path('cfg', `config${ext}`);
        fs.mkdirSync(path.dirname(cfg), { recursive: true });
        fs.writeFileSync(cfg, b.content);
        const adapter = adapterFor(b, cfg);
        adapter.wire();

        adapter.unwire();
        expect(fs.readFileSync(cfg, 'utf8')).toBe(b.content);
      } finally {
        home.cleanup();
      }
    });

    it(`${b.name}: unwire WITHOUT a prior repair strips only the sthayi entry`, () => {
      const home = createFakeHome();
      try {
        const cfg = home.path('cfg', `config${ext}`);
        fs.mkdirSync(path.dirname(cfg), { recursive: true });
        fs.writeFileSync(cfg, b.content);
        const adapter = adapterFor(b, cfg);

        const res = adapter.unwire();
        expect(res.message).toMatch(/unwired/);
        const after = fs.readFileSync(cfg, 'utf8');
        if (b.kind === 'toml') {
          expect(after).not.toMatch(/\[mcp_servers\.sthayi/);
        } else {
          const parsed = parseConfig(after, 'json');
          const container = parsed.mcpServers as Record<string, unknown> | undefined;
          expect(container?.sthayi).toBeUndefined();
        }
      } finally {
        home.cleanup();
      }
    });
  }
});

/**
 * Diagnosis hardening: inspect() is parser-based and finds a sthayi entry in ANY TOML
 * representation, but the mutation-path stripper is header-line-based. For inline
 * (`sthayi = { … }` under `[mcp_servers]`) and dotted (`mcp_servers.sthayi = …`) forms the
 * strip removes NOTHING, and appending the canonical `[mcp_servers.sthayi]` table would
 * REDEFINE the still-present key — the whole config stops parsing and the client loses every
 * server (spec §1 invariant 4). Both wire (repair) and unwire must REFUSE with an actionable
 * message and leave the file byte-identical, never "succeed" into corruption.
 */
describe('safety: TOML inline/dotted sthayi forms are refused, never corrupted', () => {
  const tomlAdapter = (cfg: string): ClientAdapter =>
    new TomlMcpAdapter({
      id: 'codex',
      label: 'codex',
      resolveConfigPath: () => cfg,
      detect: () => true,
      launcherCommand: () => LAUNCHER,
      now: () => NOW,
    });

  const UNREMOVABLE = [
    {
      name: 'inline entry under [mcp_servers]',
      content: `[settings]\nmodel = "o4"\n\n[mcp_servers]\nsthayi = { command = "npx", args = ["sthayi", "serve"] }\nother = { command = "other-tool" }\n`,
    },
    {
      name: 'dotted root-level entry',
      content: `model = "o4"\nmcp_servers.sthayi = { command = "npx", args = ["sthayi", "serve"] }\nmcp_servers.other = { command = "other-tool" }\n`,
    },
  ];

  for (const c of UNREMOVABLE) {
    it(`${c.name}: inspect says broken, wire REFUSES to repair, config byte-identical, no backup`, () => {
      const home = createFakeHome();
      try {
        const cfg = home.path('cfg', 'config.toml');
        fs.mkdirSync(path.dirname(cfg), { recursive: true });
        fs.writeFileSync(cfg, c.content);
        const before = snapshotTree(home.home);

        const adapter = tomlAdapter(cfg);
        expect(adapter.inspect().state).toBe('broken');

        const res = adapter.wire();
        expect(res.changed).toBe(false);
        expect(res.wired).toBe(false);
        expect(res.message).toMatch(/refusing to repair/);
        expect(res.message).toContain(cfg);
        expect(res.message).toMatch(/by hand/);
        expect(res.message).toMatch(/sthayi wire/);
        // byte-identical config AND no backup/state files were minted
        expect(fs.readFileSync(cfg, 'utf8')).toBe(c.content);
        expect(snapshotTree(home.home)).toEqual(before);
        // the config still parses — the client never sees a corrupted file
        expect(() => parseToml(fs.readFileSync(cfg, 'utf8'))).not.toThrow();
      } finally {
        home.cleanup();
      }
    });

    it(`${c.name}: unwire REFUSES (surgical strip cannot remove it), config byte-identical`, () => {
      const home = createFakeHome();
      try {
        const cfg = home.path('cfg', 'config.toml');
        fs.mkdirSync(path.dirname(cfg), { recursive: true });
        fs.writeFileSync(cfg, c.content);
        const before = snapshotTree(home.home);

        const res = tomlAdapter(cfg).unwire();
        expect(res.changed).toBe(false);
        expect(res.message).toMatch(/cannot unwire/);
        expect(res.message).toMatch(/by hand/);
        expect(fs.readFileSync(cfg, 'utf8')).toBe(c.content);
        expect(snapshotTree(home.home)).toEqual(before);
      } finally {
        home.cleanup();
      }
    });
  }

  it('root-level inline mcp_servers table (no sthayi): plain wire refuses instead of corrupting', () => {
    const home = createFakeHome();
    try {
      const cfg = home.path('cfg', 'config.toml');
      fs.mkdirSync(path.dirname(cfg), { recursive: true });
      const content = `mcp_servers = { other = { command = "other-tool" } }\n`;
      fs.writeFileSync(cfg, content);
      const before = snapshotTree(home.home);

      const adapter = tomlAdapter(cfg);
      expect(adapter.inspect().state).toBe('absent');
      const res = adapter.wire();
      expect(res.changed).toBe(false);
      expect(res.wired).toBe(false);
      expect(res.message).toMatch(/refusing to wire/);
      expect(fs.readFileSync(cfg, 'utf8')).toBe(content);
      expect(snapshotTree(home.home)).toEqual(before);
    } finally {
      home.cleanup();
    }
  });

  it('header-form broken entries still repair (the strip handles them)', () => {
    const home = createFakeHome();
    try {
      const cfg = home.path('cfg', 'config.toml');
      fs.mkdirSync(path.dirname(cfg), { recursive: true });
      fs.writeFileSync(
        cfg,
        '[mcp_servers.sthayi]\ncommand = "/definitely/missing/sthayi"\nargs = []\n',
      );
      const adapter = tomlAdapter(cfg);
      const res = adapter.wire();
      expect(res.message).toBe('repaired');
      expect(adapter.inspect().state).toBe('wired');
      expect(() => parseToml(fs.readFileSync(cfg, 'utf8'))).not.toThrow();
    } finally {
      home.cleanup();
    }
  });
});

/**
 * Trust-boundary hardening of the config write path (mirrors the launcher's hardened-write pattern):
 * a symlinked config target or a symlinked parent directory is REFUSED before any read, backup,
 * or write — never written through, never silently replaced — and the actual write goes through
 * a RANDOM exclusive-create ('wx') temp file in the same directory, so a preplanted file or
 * symlink at any predictable temp path can never be followed, truncated, or renamed into place.
 */
describe('safety: hardened config writes (no-follow targets, random exclusive temp)', () => {
  interface HardCase {
    id: string;
    kind: 'json' | 'toml';
    ext: string;
    wiredContent: (launcher: string) => string;
  }
  const HARD: HardCase[] = [
    {
      id: 'json',
      kind: 'json',
      ext: '.json',
      wiredContent: (l) =>
        `{\n  "mcpServers": {\n    "sthayi": {\n      "command": ${JSON.stringify(l)},\n      "args": []\n    }\n  }\n}\n`,
    },
    {
      id: 'toml',
      kind: 'toml',
      ext: '.toml',
      wiredContent: (l) =>
        `[mcp_servers.sthayi]\ncommand = ${JSON.stringify(l)}\nargs = []\nenabled = true\n`,
    },
  ];

  function hardAdapter(c: HardCase, cfg: string): ClientAdapter {
    const common = {
      id: `hard-${c.id}`,
      label: `hard-${c.id}`,
      resolveConfigPath: () => cfg,
      detect: () => true,
      launcherCommand: () => LAUNCHER,
      now: () => NOW,
    };
    return c.kind === 'json' ? new JsonMcpAdapter(common) : new TomlMcpAdapter(common);
  }

  /** Symlink or bail (returns false on platforms without symlink privilege). */
  function trySymlink(target: string, linkPath: string, type?: fs.symlink.Type): boolean {
    try {
      fs.symlinkSync(target, linkPath, type);
      return true;
    } catch {
      return false;
    }
  }

  for (const c of HARD) {
    it(`${c.id}: symlinked config target — wire AND unwire refused, link and external target byte-unchanged`, () => {
      const home = createFakeHome();
      try {
        // external target holds a WIRED-looking config: without the guard, unwire would try to act
        const external = home.path('external', `victim${c.ext}`);
        fs.mkdirSync(path.dirname(external), { recursive: true });
        const externalBytes = c.wiredContent(LAUNCHER);
        fs.writeFileSync(external, externalBytes);
        const cfg = home.path('cfg', `config${c.ext}`);
        fs.mkdirSync(path.dirname(cfg), { recursive: true });
        if (!trySymlink(external, cfg)) {
          return;
        }
        const before = snapshotTree(home.home);

        const adapter = hardAdapter(c, cfg);
        const wireRes = adapter.wire();
        expect(wireRes.changed).toBe(false);
        expect(wireRes.wired).toBe(false);
        expect(wireRes.message).toMatch(/refusing to wire/);
        expect(wireRes.message).toMatch(/symlink/);

        const unwireRes = adapter.unwire();
        expect(unwireRes.changed).toBe(false);
        expect(unwireRes.message).toMatch(/refusing to unwire/);
        expect(unwireRes.message).toMatch(/symlink/);

        // fail closed means fail UNTOUCHED: link still a link, target bytes intact, no backups,
        // no temp debris, no ledger entries — the whole tree is byte-identical
        expect(fs.lstatSync(cfg).isSymbolicLink()).toBe(true);
        expect(fs.readFileSync(external, 'utf8')).toBe(externalBytes);
        expect(snapshotTree(home.home)).toEqual(before);
      } finally {
        home.cleanup();
      }
    });

    it(`${c.id}: symlinked parent directory — wire refused, nothing written through it`, () => {
      const home = createFakeHome();
      try {
        const realDir = home.path('real-config-dir');
        fs.mkdirSync(realDir, { recursive: true });
        const linkedDir = home.path('linked-dir');
        if (!trySymlink(realDir, linkedDir, 'dir')) {
          return;
        }
        const cfg = path.join(linkedDir, `config${c.ext}`);

        const adapter = hardAdapter(c, cfg);
        const res = adapter.wire();
        expect(res.changed).toBe(false);
        expect(res.wired).toBe(false);
        expect(res.message).toMatch(/refusing to wire/);
        expect(res.message).toMatch(/config directory .* is a symlink/);
        // nothing landed in the real directory behind the link — no config, no temp, no backup
        expect(fs.readdirSync(realDir)).toEqual([]);
        expect(fs.lstatSync(linkedDir).isSymbolicLink()).toBe(true);
        expect(fs.existsSync(home.path('clients-state.json'))).toBe(false);
      } finally {
        home.cleanup();
      }
    });

    it(`${c.id}: a preplanted file at the predictable temp path is ignored and survives untouched`, () => {
      const home = createFakeHome();
      try {
        const cfg = home.path('cfg', `config${c.ext}`);
        fs.mkdirSync(path.dirname(cfg), { recursive: true });
        // the guessable `<config>.sthayi-tmp` name — an attacker can squat it (or symlink it) to
        // hijack the rename, which is why the staging name is random and opened 'wx'
        const oldTmp = `${cfg}.sthayi-tmp`;
        fs.writeFileSync(oldTmp, 'squatter');

        const adapter = hardAdapter(c, cfg);
        const res = adapter.wire();
        expect(res.wired).toBe(true);
        expect(adapter.isWired()).toBe(true);
        // the squatter was neither renamed into place, truncated, nor deleted
        expect(fs.readFileSync(oldTmp, 'utf8')).toBe('squatter');
        // and no random temp debris is left behind
        const debris = fs
          .readdirSync(path.dirname(cfg))
          .filter((f) => f.endsWith('.sthayi-tmp') && f !== path.basename(oldTmp));
        expect(debris).toEqual([]);
      } finally {
        home.cleanup();
      }
    });

    it(`${c.id}: a random temp-name collision retries with a fresh name (squatter untouched)`, () => {
      const home = createFakeHome();
      try {
        const cfg = home.path('cfg', `config${c.ext}`);
        fs.mkdirSync(path.dirname(cfg), { recursive: true });
        // Force the FIRST random name to collide with a preplanted squatter, then let the
        // retry draw real randomness. 'wx' turns the collision into EEXIST — never a follow.
        const fixed = Buffer.from('deadbeefdead', 'hex');
        const squatTmp = path.join(
          path.dirname(cfg),
          `.${path.basename(cfg)}.${fixed.toString('hex')}.sthayi-tmp`,
        );
        fs.writeFileSync(squatTmp, 'squatter');
        const spy = vi
          .spyOn(nodeCrypto, 'randomBytes')
          .mockImplementationOnce((() => fixed) as typeof nodeCrypto.randomBytes);
        try {
          const res = hardAdapter(c, cfg).wire();
          expect(res.wired).toBe(true);
          expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2); // collided once, regenerated
        } finally {
          spy.mockRestore();
        }
        expect(fs.readFileSync(squatTmp, 'utf8')).toBe('squatter');
        const parsed = parseConfig(fs.readFileSync(cfg, 'utf8'), c.kind) as Record<
          string,
          Record<string, { command?: string }>
        >;
        const container = c.kind === 'toml' ? parsed.mcp_servers : parsed.mcpServers;
        expect(container?.sthayi?.command).toBe(LAUNCHER);
      } finally {
        home.cleanup();
      }
    });

    it(`${c.id}: preplanted symlink at the predictable BACKUP path is never followed — backup gets a fresh name`, () => {
      const home = createFakeHome();
      try {
        const cfg = home.path('cfg', `config${c.ext}`);
        fs.mkdirSync(path.dirname(cfg), { recursive: true });
        const original = c.kind === 'json' ? '{\n  "mcpServers": {}\n}\n' : '[settings]\nx = 1\n';
        fs.writeFileSync(cfg, original);
        // the exact backup path wire would use for now=NOW — squat it with a symlink at a victim
        const victim = home.path('victim.txt');
        fs.writeFileSync(victim, 'victim bytes');
        const predictedBak = `${cfg}.sthayi-bak-${new Date(NOW).toISOString().replace(/[:.]/g, '-')}`;
        if (!trySymlink(victim, predictedBak)) {
          return;
        }

        const res = hardAdapter(c, cfg).wire();
        expect(res.wired).toBe(true);
        // the squatted name was skipped: victim untouched, link untouched, backup elsewhere
        expect(fs.readFileSync(victim, 'utf8')).toBe('victim bytes');
        expect(fs.lstatSync(predictedBak).isSymbolicLink()).toBe(true);
        expect(res.backupPath).toBeTruthy();
        expect(res.backupPath).not.toBe(predictedBak);
        expect(fs.readFileSync(res.backupPath as string, 'utf8')).toBe(original);
      } finally {
        home.cleanup();
      }
    });

    it(`${c.id}: the happy path is byte-identical end to end (wire → unwire round-trip)`, () => {
      const home = createFakeHome();
      try {
        const cfg = home.path('cfg', `config${c.ext}`);
        fs.mkdirSync(path.dirname(cfg), { recursive: true });
        const original =
          c.kind === 'json'
            ? '{\n  "mcpServers": {\n    "other": {\n      "command": "other-tool"\n    }\n  }\n}\n'
            : '[mcp_servers.other]\ncommand = "other-tool"\n';
        fs.writeFileSync(cfg, original);

        const adapter = hardAdapter(c, cfg);
        adapter.wire();
        expect(adapter.isWired()).toBe(true);
        adapter.unwire();
        expect(fs.readFileSync(cfg, 'utf8')).toBe(original);
        // no temp debris anywhere in the config dir
        expect(fs.readdirSync(path.dirname(cfg)).filter((f) => f.includes('.sthayi-tmp'))).toEqual(
          [],
        );
      } finally {
        home.cleanup();
      }
    });
  }

  it.skipIf(process.platform === 'win32')(
    'a 0600 config keeps its mode through the hardened write (secret-holding configs stay private)',
    () => {
      const home = createFakeHome();
      try {
        const cfg = home.path('cfg', 'config.json');
        fs.mkdirSync(path.dirname(cfg), { recursive: true });
        fs.writeFileSync(cfg, '{\n  "mcpServers": {}\n}\n');
        fs.chmodSync(cfg, 0o600);
        const adapter = hardAdapter(HARD[0] as HardCase, cfg);
        adapter.wire();
        expect(fs.lstatSync(cfg).mode & 0o777).toBe(0o600);
        expect(adapter.isWired()).toBe(true);
      } finally {
        home.cleanup();
      }
    },
  );
});

/**
 * Trust-boundary hardening of the wiring LEDGER (clients-state.json): the ledger steers unwire's
 * restore/delete decisions, so a planted symlink at the ledger path fails CLOSED through the
 * adapters — an actionable error, and the external victim file is never read through, written
 * through, or replaced (bytes AND mode identical afterwards).
 */
describe.skipIf(process.platform === 'win32')(
  'safety: hardened wiring ledger fails closed through adapters (victim untouched)',
  () => {
    function ledgerAdapter(cfg: string): ClientAdapter {
      return new JsonMcpAdapter({
        id: 'ledger-json',
        label: 'ledger-json',
        resolveConfigPath: () => cfg,
        detect: () => true,
        launcherCommand: () => LAUNCHER,
        now: () => NOW,
      });
    }

    function plantLedgerSymlink(home: ReturnType<typeof createFakeHome>): {
      victim: string;
      bytes: string;
      mode: number;
    } {
      const victim = home.path('external', 'victim.json');
      fs.mkdirSync(path.dirname(victim), { recursive: true });
      const bytes = '{"planted":true}\n';
      fs.writeFileSync(victim, bytes);
      fs.symlinkSync(victim, home.path('clients-state.json'));
      return { victim, bytes, mode: fs.lstatSync(victim).mode & 0o777 };
    }

    it('symlinked ledger: wire fails closed with an actionable error; victim bytes and mode identical', () => {
      const home = createFakeHome();
      try {
        const planted = plantLedgerSymlink(home);
        const cfg = home.path('cfg', 'config.json');
        fs.mkdirSync(path.dirname(cfg), { recursive: true });
        expect(() => ledgerAdapter(cfg).wire()).toThrow(/client wiring ledger.*symlink/);
        expect(fs.lstatSync(home.path('clients-state.json')).isSymbolicLink()).toBe(true);
        expect(fs.readFileSync(planted.victim, 'utf8')).toBe(planted.bytes);
        expect(fs.lstatSync(planted.victim).mode & 0o777).toBe(planted.mode);
      } finally {
        home.cleanup();
      }
    });

    it('symlinked ledger: unwire fails closed BEFORE touching the config (config byte-identical)', () => {
      const home = createFakeHome();
      try {
        const cfg = home.path('cfg', 'config.json');
        fs.mkdirSync(path.dirname(cfg), { recursive: true });
        const wired = `{\n  "mcpServers": {\n    "sthayi": {\n      "command": ${JSON.stringify(LAUNCHER)},\n      "args": []\n    }\n  }\n}\n`;
        fs.writeFileSync(cfg, wired);
        const planted = plantLedgerSymlink(home);
        expect(() => ledgerAdapter(cfg).unwire()).toThrow(/client wiring ledger.*symlink/);
        expect(fs.readFileSync(cfg, 'utf8')).toBe(wired); // refusal precedes any config edit
        expect(fs.readFileSync(planted.victim, 'utf8')).toBe(planted.bytes);
        expect(fs.lstatSync(planted.victim).mode & 0o777).toBe(planted.mode);
      } finally {
        home.cleanup();
      }
    });

    it('healthy ledger through adapters is unchanged: wire records, unwire clears, byte-exact restore', () => {
      const home = createFakeHome();
      try {
        const cfg = home.path('cfg', 'config.json');
        fs.mkdirSync(path.dirname(cfg), { recursive: true });
        const original =
          '{\n  "mcpServers": {\n    "other": {\n      "command": "other-tool"\n    }\n  }\n}\n';
        fs.writeFileSync(cfg, original);
        const adapter = ledgerAdapter(cfg);
        adapter.wire();
        const ledger = JSON.parse(
          fs.readFileSync(home.path('clients-state.json'), 'utf8'),
        ) as Record<string, ClientState>;
        expect(ledger['ledger-json']?.existedBefore).toBe(true);
        adapter.unwire();
        expect(fs.readFileSync(cfg, 'utf8')).toBe(original);
        const cleared = JSON.parse(
          fs.readFileSync(home.path('clients-state.json'), 'utf8'),
        ) as Record<string, ClientState>;
        expect(cleared['ledger-json']).toBeUndefined();
      } finally {
        home.cleanup();
      }
    });
  },
);
