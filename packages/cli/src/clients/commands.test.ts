import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FakeHome, createFakeHome } from '../../../../tests/helpers/fake-home.js';
import { runTempDir } from '../../../../tests/helpers/run-temp.js';
import { runDoctor } from '../doctor.js';
import { openStore } from '../store.js';
import { VERSION } from '../version.js';
import { planInit, runInit, runStatus, runWire } from './commands.js';
import { defaultAdapters } from './index.js';
import { launcherCommand, launcherHealth, writeLauncher } from './launcher.js';

/** Capture stdout lines without leaking them into the vitest reporter. */
function captureStdout(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  return { text: () => chunks.join(''), restore: () => spy.mockRestore() };
}

describe('planInit / init --dry-run (plan-then-execute)', () => {
  let home: FakeHome;
  beforeEach(() => {
    home = createFakeHome();
  });
  afterEach(() => home.cleanup());

  it('planInit on an empty home reports everything as to-create — and creates nothing', () => {
    const plan = planInit();
    expect(plan.home).toBe(home.home);
    expect(plan.db.exists).toBe(false);
    expect(plan.key.exists).toBe(false);
    expect(plan.launcher.action).toBe('create');
    expect(plan.skillsSample.wouldCreate).toBe(true);
    for (const r of plan.clients) {
      expect(r.changed).toBe(false); // dry-run adapter results only
    }
    expect(fs.readdirSync(home.home)).toEqual([]);
  });

  it('planInit on a VIRGIN home (dir does not exist) performs pure reads only', () => {
    fs.rmSync(home.home, { recursive: true, force: true });
    const plan = planInit();
    expect(plan.homeExists).toBe(false);
    expect(plan.launcher.action).toBe('create');
    expect(fs.existsSync(home.home)).toBe(false);
  });

  it('planInit on an initialized home reports keep/unchanged', () => {
    openStore().close();
    writeLauncher();
    const plan = planInit();
    expect(plan.db.exists).toBe(true);
    expect(plan.key.exists).toBe(true);
    expect(plan.launcher.action).toBe('unchanged');
  });

  it('planInit reports update when the launcher on disk differs', () => {
    openStore().close();
    const p = writeLauncher();
    fs.writeFileSync(p, '#!/usr/bin/env bash\nexec stale\n', { mode: 0o755 });
    expect(planInit().launcher.action).toBe('update');
  });

  it('init --dry-run leaves a virgin STHAYI_HOME nonexistent', async () => {
    fs.rmSync(home.home, { recursive: true, force: true });
    const cap = captureStdout();
    try {
      await runInit({ dryRun: true });
    } finally {
      cap.restore();
    }
    expect(cap.text()).toMatch(/Dry run — would initialize/);
    expect(cap.text()).toMatch(/create db/);
    expect(cap.text()).toMatch(/create launcher/);
    expect(fs.existsSync(home.home)).toBe(false);
  });

  it('init --dry-run on an existing empty home writes nothing into it', async () => {
    const cap = captureStdout();
    try {
      await runInit({ dryRun: true });
    } finally {
      cap.restore();
    }
    expect(fs.readdirSync(home.home)).toEqual([]);
  });
});

/**
 * A REFUSED INIT WRITES NOTHING — the `npx` shape, which is the one an ephemeral entry produces.
 *
 * `npx sthayi init` runs the CLI out of an npm cache, and a launcher pinned there breaks the moment
 * that cache is pruned, so the launcher write REFUSES it and the message tells the user to install
 * somewhere durable and re-run. "Re-run" is a promise about state: the user is being told this run
 * achieved nothing. Settled only AFTER the store had been opened, that promise was false — the
 * refusal left a home behind holding `sthayi.db`, the vault `key` and `journal.checkpoint`, i.e. a
 * sealed store and a vault key created for an installation that reported itself uninitialized.
 *
 * So the probe is about the HOME, not about the message: a genuinely ABSENT `STHAYI_HOME` must
 * still be absent when the refusal returns, on the normal path and on the dry-run path alike.
 */
describe('init refuses an EPHEMERAL entry BEFORE it writes anything', () => {
  let home: FakeHome;
  let clientHome: string;
  let previousArgv1: string | undefined;

  /** Whatever a refused run left in the home, or null when the home is (still) absent. */
  function homeContents(): string[] | null {
    return fs.existsSync(home.home) ? fs.readdirSync(home.home).sort() : null;
  }

  beforeEach(() => {
    home = createFakeHome();
    // client configs resolve from os.homedir() — isolate so the dev machine's real wiring can
    // never be read, let alone rewritten, by the durable control below
    clientHome = runTempDir('sthayi-init-preflight-');
    vi.spyOn(os, 'homedir').mockReturnValue(clientHome);
    previousArgv1 = process.argv[1];
    // A genuinely ABSENT home — the virgin machine an `npx` first run meets.
    fs.rmSync(home.home, { recursive: true, force: true });
  });

  afterEach(() => {
    if (previousArgv1 === undefined) {
      process.argv.splice(1, 1);
    } else {
      process.argv[1] = previousArgv1;
    }
    vi.restoreAllMocks();
    fs.rmSync(clientHome, { recursive: true, force: true });
    home.cleanup();
  });

  /** Point the CLI entry at an `_npx` cache path — the shape isEphemeralPath refuses. It never has
   *  to exist: an entry that cannot be realpathed is judged as the literal path argv[1] carries. */
  /**
   * The refusal names the ephemeral entry and points at a durable install, and never sends the user
   * back to the command that was just refused.
   *
   * Asserted by shape rather than by quoting the message verbatim: the guidance names a prefix and
   * varies by platform and by whether the global prefix is writable, so an exact-string match would
   * pin one machine's wording and would go green for a message that had stopped saying anything
   * useful. These three together are stricter than the single literal they replace.
   */
  function expectDurableInstallRefusal(err: unknown): void {
    const message = (err as Error | undefined)?.message ?? '';
    expect(message).toMatch(/refusing to write a launcher pinned to/);
    expect(message).toMatch(/npm install -g[^\n]*\bsthayi\b/);
    expect(message).not.toMatch(/npx\s+sthayi\s+init/);
  }

  function pinEphemeralEntry(): void {
    process.argv[1] = path.join(
      home.fixture,
      'cache',
      '_npx',
      'deadbeef01',
      'node_modules',
      'sthayi',
      'dist',
      'index.js',
    );
  }

  it('a refused NORMAL init leaves an absent STHAYI_HOME absent — no db, no key, no checkpoint', async () => {
    pinEphemeralEntry();
    const cap = captureStdout();
    let err: unknown;
    try {
      await runInit({ yes: true }).catch((e: unknown) => {
        err = e;
      });
    } finally {
      cap.restore();
    }
    expectDurableInstallRefusal(err);
    expect(homeContents(), `left behind in ${home.home} by a REFUSED init`).toBeNull();
    // and it never got as far as claiming otherwise
    expect(cap.text()).not.toMatch(/Sthayi initialized/);
  });

  it('a refused DRY-RUN init leaves an absent STHAYI_HOME absent too', async () => {
    pinEphemeralEntry();
    const cap = captureStdout();
    let err: unknown;
    try {
      await runInit({ dryRun: true }).catch((e: unknown) => {
        err = e;
      });
    } finally {
      cap.restore();
    }
    expectDurableInstallRefusal(err);
    expect(homeContents(), `left behind in ${home.home} by a REFUSED dry run`).toBeNull();
  });

  it('CONTROL: a DURABLE entry still initializes — the preflight refuses npm caches, not installs', async () => {
    // A checked-out tree the user keeps — this very file. Durable by the only test that matters:
    // no `_npx`/`_cacache` segment, not under the system temp dir, not under `npm_config_cache`.
    // A fixture under the temp root would NOT do: the temp dir is one of the three ephemeral
    // shapes, so such an "install" is refused for a real reason.
    process.argv[1] = fileURLToPath(import.meta.url);
    const cap = captureStdout();
    try {
      // no `yes`, and stdin is not a TTY under vitest, so confirm() declines and no client config
      // is ever rewritten
      await runInit({});
    } finally {
      cap.restore();
    }
    expect(cap.text()).toMatch(/Sthayi initialized/);
    expect(homeContents()).toContain('sthayi.db');
    const launcherSuffix = process.platform === 'win32' ? '.cmd' : '';
    expect(fs.existsSync(home.path('bin', `sthayi-mcp${launcherSuffix}`))).toBe(true);
    expect(fs.existsSync(home.path('bin', `sthayi${launcherSuffix}`))).toBe(true);
  });
});

describe('runWire dry-run vs execute', () => {
  let home: FakeHome;
  beforeEach(() => {
    home = createFakeHome();
  });
  afterEach(() => home.cleanup());

  it('wire --dry-run leaves a virgin STHAYI_HOME nonexistent (no launcher write)', () => {
    fs.rmSync(home.home, { recursive: true, force: true });
    const cap = captureStdout();
    try {
      // scope to a nonexistent client so this never touches real machine configs
      runWire({ client: 'no-such-client', dryRun: true });
    } finally {
      cap.restore();
    }
    expect(cap.text()).toMatch(/Dry run — launcher .*would create/);
    expect(fs.existsSync(home.home)).toBe(false);
  });

  it('real wire DOES write the launcher (execute path unchanged)', () => {
    const cap = captureStdout();
    try {
      runWire({ client: 'no-such-client' });
    } finally {
      cap.restore();
    }
    const launcher =
      process.platform === 'win32'
        ? `${home.path('bin', 'sthayi-mcp')}.cmd`
        : home.path('bin', 'sthayi-mcp');
    expect(fs.existsSync(launcher)).toBe(true);
  });
});

// INVARIANT: `sthayi status` surfaces a pending HTTP-token rotation before it bites. Rotation
// happens at the next `sthayi serve --http` start, and HTTP clients 401 until they adopt the new
// token, so status must warn ahead of time — one non-secret warning line, never the token value,
// and only for LEGACY unprefixed token files.
describe('runStatus: pending HTTP-token rotation warning', () => {
  let home: FakeHome;
  let clientHome: string;

  beforeEach(() => {
    home = createFakeHome();
    // client configs resolve from os.homedir() — isolate so real machine wiring can't leak in
    clientHome = runTempDir('sthayi-status-token-');
    vi.spyOn(os, 'homedir').mockReturnValue(clientHome);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(clientHome, { recursive: true, force: true });
    home.cleanup();
  });

  function statusOutput(): string {
    const cap = captureStdout();
    try {
      runStatus();
    } finally {
      cap.restore();
    }
    return cap.text();
  }

  it('legacy unprefixed token: one warning line naming `sthayi serve --http`, value never printed', () => {
    const legacy = 'legacy-unprefixed-token-abcdef1234567890';
    fs.writeFileSync(home.path('http-token'), `${legacy}\n`, { mode: 0o600 });
    const text = statusOutput();
    expect(text).toMatch(/rotated the next time `sthayi serve --http` starts/);
    expect(text).toMatch(/HTTP clients must adopt the new token/);
    expect(text).not.toContain(legacy);
    expect(text).not.toMatch(/any startup|every startup/);
    // status stays read-only: the legacy token file was not rotated by status itself
    expect(fs.readFileSync(home.path('http-token'), 'utf8')).toBe(`${legacy}\n`);
  });

  it('modern sthayi_tk_ token: no warning line', () => {
    fs.writeFileSync(home.path('http-token'), 'sthayi_tk_notarealtoken\n', { mode: 0o600 });
    expect(statusOutput()).not.toMatch(/rotated the next time/);
  });

  it('no token file: no warning line', () => {
    expect(statusOutput()).not.toMatch(/rotated the next time/);
  });
});

// `sthayi status` reports launcher/RUNTIME health, not config syntax alone.
// A syntactically-wired client whose launcher is missing/corrupt/stale-runtime is BROKEN, with a
// one-line reason — and doctor (which reads the same launcherHealth()) names the same condition.
describe.skipIf(process.platform === 'win32')(
  'runStatus × runDoctor: launcher/runtime health agreement',
  () => {
    let home: FakeHome;
    let clientHome: string;

    beforeEach(() => {
      home = createFakeHome();
      // client configs resolve from os.homedir() — isolate so the dev machine's real wiring
      // (meta-dogfood) can never leak in
      clientHome = runTempDir('sthayi-status-clients-');
      vi.spyOn(os, 'homedir').mockReturnValue(clientHome);
      // an initialized home, so doctor proceeds past the initialization gate to the launcher check
      openStore().close();
      // a SYNTACTICALLY wired Claude Desktop: the config entry matches the canonical launcher
      const adapter = defaultAdapters().find((a) => a.id === 'claude-desktop');
      expect(adapter).toBeDefined();
      const cfg = (adapter as NonNullable<typeof adapter>).configPath();
      fs.mkdirSync(path.dirname(cfg), { recursive: true });
      fs.writeFileSync(
        cfg,
        `${JSON.stringify(
          { mcpServers: { sthayi: { command: launcherCommand(), args: [] } } },
          null,
          2,
        )}\n`,
      );
    });

    afterEach(() => {
      vi.restoreAllMocks();
      fs.rmSync(clientHome, { recursive: true, force: true });
      home.cleanup();
    });

    function statusOutput(): string {
      const cap = captureStdout();
      try {
        runStatus();
      } finally {
        cap.restore();
      }
      return cap.text();
    }

    /** status row broken + doctor Launcher check failing, BOTH carrying launcherHealth's reason. */
    function expectBrokenAndAgreeing(): { statusOut: string } {
      const lh = launcherHealth();
      expect(lh.ok).toBe(false);
      const statusOut = statusOutput();
      expect(statusOut).toMatch(/Claude Desktop\s+yes\s+broken/);
      expect(statusOut).toContain(lh.detail); // the one-line reason under the broken row
      const checks = runDoctor();
      expect(checks.some((c) => !c.ok)).toBe(true); // doctor exits nonzero
      const launcher = checks.find((c) => c.name === 'Launcher');
      expect(launcher?.ok).toBe(false);
      expect(launcher?.detail).toContain(lh.detail); // same condition, same words
      return { statusOut };
    }

    it('healthy launcher: the wired client stays "yes" (baseline)', () => {
      writeLauncher();
      expect(launcherHealth().ok).toBe(true);
      const statusOut = statusOutput();
      expect(statusOut).toMatch(/Claude Desktop\s+yes\s+yes/);
      expect(statusOut).not.toContain('broken');
      expect(runDoctor().find((c) => c.name === 'Launcher')?.ok).toBe(true);
    });

    it('MISSING launcher under a wired client: broken, and doctor names the same condition', () => {
      expect(launcherHealth().state).toBe('missing');
      const { statusOut } = expectBrokenAndAgreeing();
      expect(statusOut).toContain('does not exist');
    });

    it('CORRUPT launcher body: broken, and doctor names the same condition', () => {
      writeLauncher();
      fs.writeFileSync(home.path('bin', 'sthayi-mcp'), 'garbage — not a launcher\n', {
        mode: 0o755,
      });
      expect(launcherHealth().state).toBe('stale-target');
      const { statusOut } = expectBrokenAndAgreeing();
      expect(statusOut).toContain('unparseable');
    });

    /** A launcher pinned inside `<home>/runtime/` — a location Sthayi never writes and never trusts. */
    function pinIntoRuntime(version: string, plantEntry: boolean): void {
      const oldEntry = home.path('runtime', version, 'node_modules', 'sthayi', 'dist', 'i.js');
      if (plantEntry) {
        fs.mkdirSync(path.dirname(oldEntry), { recursive: true });
        fs.writeFileSync(oldEntry, '// old runtime entry\n');
      }
      fs.mkdirSync(home.path('bin'), { recursive: true });
      fs.writeFileSync(
        home.path('bin', 'sthayi-mcp'),
        `#!/usr/bin/env bash\nNODE="${process.execPath}"\nexec "$NODE" "${oldEntry}" serve "$@"\n`,
        { mode: 0o755 },
      );
    }

    it('launcher pinned inside <home>/runtime (dir gone): stale runtime named by both', () => {
      pinIntoRuntime('0.0.1-old', false);
      expect(launcherHealth().state).toBe('stale-runtime');
      const { statusOut } = expectBrokenAndAgreeing();
      expect(statusOut).toContain(home.path('runtime'));
    });

    it('runtime dir still on disk for THIS version: stale runtime, not a healthy launcher', () => {
      // The entry EXISTS and would satisfy an existence check — but this build neither creates nor
      // maintains that tree, so a launcher pinned inside it is broken wiring rather than health.
      pinIntoRuntime(VERSION, true);
      expect(launcherHealth().state).toBe('stale-runtime');
      const { statusOut } = expectBrokenAndAgreeing();
      expect(statusOut).toContain(home.path('runtime'));
    });
  },
);
