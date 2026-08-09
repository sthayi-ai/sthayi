import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FakeHome, createFakeHome, snapshotTree } from '../../../tests/helpers/fake-home.js';
import { claimToolEntry } from '../../../tests/helpers/owned-fs.js';
import { runTempDir } from '../../../tests/helpers/run-temp.js';
import { defaultAdapters } from './clients/index.js';
import { writeLauncher } from './clients/launcher.js';
import { legacyHttpTokenWarning, runDoctor, storeOpenFailureCheck } from './doctor.js';
import { SqliteDriver } from './drivers/sqlite.js';
import { PRIVATE_READ_CAP_BYTES } from './fs-safe.js';
import { dbPath, keyPath } from './paths.js';
import { openStore } from './store.js';
import { VERSION } from './version.js';

/** Detector-valid synthetic secret (same family as the vault-secrets canary) — never a real key. */
const CANARY = `sk-proj-DOCTOR${'a'.repeat(30)}`;

function find(checks: ReturnType<typeof runDoctor>, name: string) {
  return checks.find((c) => c.name === name);
}

/** Initialize a store containing at least one ENCRYPTED entity (the canary is vaulted). */
function seedStoreWithEntity(): void {
  const store = openStore();
  try {
    const warnings: string[] = [];
    store.memory.add(
      { type: 'semantic', scope: 'user', content: `token ${CANARY}`, confidence: 0.9, source: 't' },
      { now: Date.now(), actor: 'test', asProposal: false, warnings },
    );
  } finally {
    store.close();
  }
}

/** Seed `n` DISTINCT detector-valid canaries → n encrypted entities, with strictly increasing
 *  created_at so listEntities (ORDER BY created_at) returns a deterministic order. */
function seedStoreWithEntities(n: number): void {
  const store = openStore();
  try {
    const base = Date.now();
    for (let i = 0; i < n; i++) {
      store.memory.add(
        {
          type: 'semantic',
          scope: 'user',
          content: `token sk-proj-DOCTOR${String(i).repeat(24)}`,
          confidence: 0.9,
          source: 't',
        },
        { now: base + i, actor: 'test', asProposal: false, warnings: [] },
      );
    }
  } finally {
    store.close();
  }
}

describe('doctor (observational, key-loss aware)', () => {
  let home: FakeHome;
  let clientHome: string;
  beforeEach(() => {
    home = createFakeHome();
    // Doctor now sweeps per-client configs even on an uninitialized machine, and
    // client configs resolve from os.homedir() — isolate it so the DEV machine's real wiring
    // (meta-dogfood) can never leak into these assertions.
    clientHome = runTempDir('sthayi-doctor-clients-');
    vi.spyOn(os, 'homedir').mockReturnValue(clientHome);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(clientHome, { recursive: true, force: true });
    home.cleanup();
  });

  it('empty home: single "not initialized" OK check, byte-for-byte no mutation', () => {
    const before = snapshotTree(home.home);
    const checks = runDoctor();
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(find(checks, 'Initialization')?.detail).toMatch(/not initialized/);
    // no store/journal/client checks on an uninitialized machine — and nothing was created
    expect(checks.map((c) => c.name)).toEqual(['Node version', 'Initialization']);
    expect(snapshotTree(home.home)).toEqual(before);
    expect(fs.readdirSync(home.home)).toEqual([]);
  });

  // TRI-STATE PRESENCE. Collapsing every lstat failure into "absent" would render EACCES/EIO on a
  // state path as `Initialization · ok · not initialized` — doctor's healthiest line, for a home it
  // never managed to look at. present / absent / unknown are three distinct answers, and
  // `unknown` is a FAILED check that names the errno. (End-to-end hostile coverage, including a
  // real chmod-000 home, lives in tests/safety/state-file-trust-policy.test.ts; these pin the
  // check-level contract.)
  describe('presence is tri-state: an uninspectable path is never reported as absent', () => {
    /** lstat throws `code` for `target` only; every other path answers normally. */
    function failLstatFor(target: string, code: string): void {
      const realLstat = fs.lstatSync;
      vi.spyOn(fs, 'lstatSync').mockImplementation(((p: fs.PathLike, o?: never) => {
        if (String(p) === target) {
          const err = new Error(`${code}: injected, lstat '${target}'`) as NodeJS.ErrnoException;
          err.code = code;
          throw err;
        }
        return realLstat(p, o) as fs.Stats;
      }) as never);
    }

    it('EACCES on the db: a failed Store check, and NO "not initialized" verdict at all', () => {
      fs.writeFileSync(dbPath(), 'planted', { mode: 0o600 });
      fs.writeFileSync(keyPath(), crypto.randomBytes(32), { mode: 0o600 });
      failLstatFor(dbPath(), 'EACCES');

      const checks = runDoctor();

      expect(find(checks, 'Initialization')).toBeUndefined();
      expect(checks.some((c) => c.ok && /not initialized/.test(c.detail))).toBe(false);
      expect(find(checks, 'Store')?.ok).toBe(false);
      expect(find(checks, 'Store')?.detail).toMatch(/could not be inspected \(EACCES\)/);
      expect(find(checks, 'Store')?.fix).toBeDefined();
    });

    it('a generic non-ENOENT failure (EIO) on the key is failed, not absent', () => {
      fs.writeFileSync(dbPath(), 'planted', { mode: 0o600 });
      fs.writeFileSync(keyPath(), crypto.randomBytes(32), { mode: 0o600 });
      failLstatFor(keyPath(), 'EIO');

      const checks = runDoctor();

      expect(find(checks, 'Initialization')).toBeUndefined();
      expect(find(checks, 'Vault key')?.ok).toBe(false);
      expect(find(checks, 'Vault key')?.detail).toMatch(/could not be inspected \(EIO\)/);
      // and doctor stopped there — no verdict was computed from a probe that failed
      expect(checks.map((c) => c.name)).toEqual(['Node version', 'Vault key']);
    });

    it('ENOENT is still absence: an empty home keeps the healthy "not initialized" line', () => {
      const checks = runDoctor();
      expect(find(checks, 'Initialization')?.ok).toBe(true);
      expect(find(checks, 'Initialization')?.detail).toMatch(/not initialized/);
    });

    it('the HOME probe is tri-state too: an uninspectable home is failed, not "run `sthayi init`"', () => {
      fs.writeFileSync(dbPath(), 'planted', { mode: 0o600 });
      fs.writeFileSync(keyPath(), crypto.randomBytes(32), { mode: 0o600 });
      // The home gate and the db/key probes must all succeed first, so the HOME PRESENCE probe —
      // the very next lstat of the home after the key probe — is the one under test.
      const realLstat = fs.lstatSync;
      let keyProbed = false;
      vi.spyOn(fs, 'lstatSync').mockImplementation(((p: fs.PathLike, o?: never) => {
        if (String(p) === keyPath()) {
          keyProbed = true;
        } else if (String(p) === home.home && keyProbed) {
          const err = new Error('EIO: injected') as NodeJS.ErrnoException;
          err.code = 'EIO';
          throw err;
        }
        return realLstat(p, o) as fs.Stats;
      }) as never);

      const checks = runDoctor();

      const dir = find(checks, 'Home directory');
      expect(dir?.ok).toBe(false);
      expect(dir?.detail).toMatch(/could not be inspected \(EIO\)/);
      expect(dir?.fix).not.toMatch(/sthayi init/); // absence's advice, wrong for "cannot read it"
      expect(dir?.fix).toMatch(/restore access/);
    });
  });

  it('healthy initialized store: core checks pass, tree untouched', () => {
    seedStoreWithEntity();
    writeLauncher();
    const before = snapshotTree(home.home);
    const checks = runDoctor();
    expect(find(checks, 'Store')?.ok).toBe(true);
    expect(find(checks, 'Journal integrity')?.ok).toBe(true);
    expect(find(checks, 'Vault key')?.ok).toBe(true);
    expect(find(checks, 'Entity decryption')?.ok).toBe(true);
    expect(find(checks, 'Launcher')?.ok).toBe(true);
    expect(checks.some((c) => c.name.startsWith('Client:'))).toBe(true);
    expect(snapshotTree(home.home)).toEqual(before);
  });

  it.skipIf(process.platform === 'win32')(
    'a launcher pinned into <home>/runtime is a FAILING launcher check, and the pin is never followed',
    () => {
      // `~/.sthayi/runtime/` is a directory Sthayi never creates and never vouches for; a launcher
      // pinned inside it can only have come from elsewhere. A version name made to lead outside the
      // home is complete to anything that
      // FOLLOWS it, so a health report built on `existsSync` renders the hijack as `Launcher · ok`
      // — the one line that tells a user their wiring is sound while every client launch runs
      // somebody else's file. The verdict now comes from the pinned PATH alone: the planted tree is
      // never opened, quoted, repaired or removed.
      seedStoreWithEntity();
      const external = runTempDir('sthayi-doctor-runtime-');
      const foreign = path.join(external, 'foreign-version');
      const foreignEntry = path.join(foreign, 'node_modules', 'sthayi', 'dist', 'index.js');
      try {
        fs.mkdirSync(path.dirname(foreignEntry), { recursive: true });
        fs.writeFileSync(
          path.join(foreign, 'node_modules', 'sthayi', 'package.json'),
          '{"name":"sthayi"}',
        );
        fs.writeFileSync(foreignEntry, '// FOREIGN\n');
        fs.writeFileSync(
          path.join(foreign, 'node_modules', '.sthayi-runtime-complete'),
          'foreign\n',
        );
        const pinned = home.path('runtime', VERSION, 'node_modules', 'sthayi', 'dist', 'index.js');
        fs.mkdirSync(home.path('runtime'), { recursive: true });
        fs.symlinkSync(foreign, home.path('runtime', VERSION));
        fs.mkdirSync(home.path('bin'), { recursive: true });
        fs.writeFileSync(
          home.path('bin', 'sthayi-mcp'),
          `#!/usr/bin/env bash\nNODE="${process.execPath}"\nexec "$NODE" "${pinned}" serve "$@"\n`,
          { mode: 0o755 },
        );

        const launcher = find(runDoctor(), 'Launcher');
        expect(launcher?.ok).toBe(false);
        expect(launcher?.detail).toContain(home.path('runtime'));
        expect(launcher?.fix).toMatch(/sthayi wire/);
        // nothing was read, repaired, removed or echoed through the planted link
        expect(launcher?.detail).not.toContain('FOREIGN');
        expect(fs.readFileSync(foreignEntry, 'utf8')).toBe('// FOREIGN\n');
        expect(fs.lstatSync(home.path('runtime', VERSION)).isSymbolicLink()).toBe(true);
      } finally {
        fs.rmSync(external, { recursive: true, force: true });
      }
    },
  );

  it('key deleted with encrypted entities: fatal diagnostic, NO new key, NO new files', () => {
    seedStoreWithEntity();
    fs.rmSync(keyPath());
    const before = snapshotTree(home.home);

    const checks = runDoctor();
    const key = find(checks, 'Vault key');
    expect(key?.ok).toBe(false);
    expect(key?.detail).toMatch(/absent/);
    expect(key?.fix).toMatch(/restore .*key from backup/);
    expect(key?.fix).toMatch(/NOT generate/);
    // INVARIANT: doctor never mints a vault key. A fresh key cannot decrypt existing entities,
    // so creating one here would mask permanent key loss as a healthy install.
    expect(fs.existsSync(keyPath())).toBe(false);
    expect(snapshotTree(home.home)).toEqual(before);
  });

  it('wrong 32-byte key: the decryption check fails, tree untouched', () => {
    seedStoreWithEntity();
    fs.writeFileSync(keyPath(), crypto.randomBytes(32), { mode: 0o600 });
    const before = snapshotTree(home.home);

    const checks = runDoctor();
    const ent = find(checks, 'Entity decryption');
    expect(ent?.ok).toBe(false);
    expect(ent?.detail).toMatch(/does not decrypt/);
    // the authenticated checkpoint also stops verifying under a foreign key
    expect(find(checks, 'Journal integrity')?.ok).toBe(false);
    expect(snapshotTree(home.home)).toEqual(before);
  });

  it('malformed key (wrong size): fatal with the byte count, never rewritten', () => {
    seedStoreWithEntity();
    fs.writeFileSync(keyPath(), Buffer.alloc(8), { mode: 0o600 });
    const before = snapshotTree(home.home);

    const checks = runDoctor();
    const key = find(checks, 'Vault key');
    expect(key?.ok).toBe(false);
    expect(key?.detail).toMatch(/malformed/);
    expect(key?.detail).toMatch(/8 bytes/);
    expect(snapshotTree(home.home)).toEqual(before);
  });

  it('corrupt entity ciphertext: the decryption check fails, tree untouched', () => {
    seedStoreWithEntity();
    const driver = SqliteDriver.open(dbPath());
    try {
      // flip the ciphertext to garbage of a plausible length (iv+tag+data)
      const raw = driver as unknown as {
        db: { prepare: (s: string) => { run: (b: Buffer) => void } };
      };
      raw.db.prepare('UPDATE entities SET value_enc = ?').run(crypto.randomBytes(48));
    } finally {
      driver.close();
    }
    const before = snapshotTree(home.home);

    const checks = runDoctor();
    expect(find(checks, 'Entity decryption')?.ok).toBe(false);
    expect(snapshotTree(home.home)).toEqual(before);
  });

  // Decryption is EXHAUSTIVE, not sampled: a probe that decrypted only the first few entities
  // would report "all clear" while corruption in entity #4+ makes `sthayi entities` fail.
  it('corrupt ciphertext in the FOURTH entity: exhaustive decryption catches it, zero writes', () => {
    seedStoreWithEntities(5);
    const driver = SqliteDriver.open(dbPath());
    try {
      const encrypted = driver.listEntities().filter((e) => e.valueEnc);
      expect(encrypted.length).toBe(5);
      const fourth = encrypted[3] as NonNullable<(typeof encrypted)[number]>;
      const raw = driver as unknown as {
        db: { prepare: (s: string) => { run: (b: Buffer, id: string) => void } };
      };
      raw.db
        .prepare('UPDATE entities SET value_enc = ? WHERE id = ?')
        .run(crypto.randomBytes(48), fourth.id);
    } finally {
      driver.close();
    }
    const before = snapshotTree(home.home);

    const checks = runDoctor();
    const ent = find(checks, 'Entity decryption');
    expect(ent?.ok).toBe(false); // the failing check makes `sthayi doctor` exit nonzero
    expect(ent?.detail).toMatch(/does not decrypt/);
    expect(ent?.fix).toMatch(/NOT rewrite/);
    // every OTHER check that reads entities stayed observational: byte-for-byte no mutation
    expect(snapshotTree(home.home)).toEqual(before);
  });

  it('all five healthy entities: the exhaustive sweep reports the full count', () => {
    seedStoreWithEntities(5);
    const checks = runDoctor();
    const ent = find(checks, 'Entity decryption');
    expect(ent?.ok).toBe(true);
    expect(ent?.detail).toMatch(/all 5 encrypted entity\(ies\) decrypt OK/);
  });

  it('restored key: doctor passes again (round trip)', () => {
    seedStoreWithEntity();
    const saved = fs.readFileSync(keyPath());
    fs.rmSync(keyPath());
    expect(find(runDoctor(), 'Vault key')?.ok).toBe(false);

    fs.writeFileSync(keyPath(), saved, { mode: 0o600 });
    const checks = runDoctor();
    expect(find(checks, 'Vault key')?.ok).toBe(true);
    expect(find(checks, 'Entity decryption')?.ok).toBe(true);
    expect(find(checks, 'Journal integrity')?.ok).toBe(true);
  });

  it('every failing check carries a fix-it line', () => {
    seedStoreWithEntity();
    fs.rmSync(keyPath()); // force at least one failure
    for (const c of runDoctor()) {
      if (!c.ok) {
        expect(c.fix, `${c.name} has no fix`).toBeTruthy();
      }
    }
  });

  it('turns a cross-Node native SQLite mismatch into reinstall guidance, never backup advice', () => {
    const raw = new Error(
      'better_sqlite3.node was compiled against a different Node.js version using NODE_MODULE_VERSION 127; this runtime requires NODE_MODULE_VERSION 137',
    );
    const check = storeOpenFailureCheck(raw, { nodeVersion: '24.13.0', platform: 'darwin' });

    expect(check.ok).toBe(false);
    expect(check.detail).toContain('native SQLite module is incompatible');
    expect(check.detail).toContain('Node.js v24.13.0');
    expect(check.detail).not.toContain('NODE_MODULE_VERSION');
    expect(check.fix).toContain('reinstall Sthayi');
    expect(check.fix).toContain(
      'npm install -g --prefix "$HOME/.local" --engine-strict sthayi@latest',
    );
    expect(check.fix).not.toContain('restore ~/.sthayi from backup');
  });

  // Wiring-diagnosis × observational-doctor composition: client configs live OUTSIDE ~/.sthayi, so
  // a wiped home with sthayi still referenced by a client is a FAILURE, not "not initialized".
  it('uninitialized home but a client config references sthayi: failing checks name the client, zero writes', () => {
    const adapter = defaultAdapters().find((a) => a.id === 'claude-desktop');
    expect(adapter).toBeDefined();
    const cfg = (adapter as NonNullable<typeof adapter>).configPath();
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    fs.writeFileSync(
      cfg,
      `${JSON.stringify(
        { mcpServers: { sthayi: { command: '/gone/.sthayi/bin/sthayi-mcp', args: [] } } },
        null,
        2,
      )}\n`,
    );
    const beforeClients = snapshotTree(clientHome);
    const beforeHome = snapshotTree(home.home);

    const checks = runDoctor();
    // doctor exits nonzero: at least one failing check
    expect(checks.some((c) => !c.ok)).toBe(true);
    const init = find(checks, 'Initialization');
    expect(init?.ok).toBe(false);
    expect(init?.detail).toMatch(/reference a sthayi wiring/);
    const client = find(checks, 'Client: Claude Desktop');
    expect(client?.ok).toBe(false);
    expect(client?.detail).toMatch(/is missing/);
    expect(client?.fix).toMatch(/sthayi init/);
    expect(client?.fix).toMatch(/remove the entry/);
    // doctor stays zero-write: neither the client configs nor the (absent) home were touched
    expect(snapshotTree(clientHome)).toEqual(beforeClients);
    expect(snapshotTree(home.home)).toEqual(beforeHome);
    expect(fs.readdirSync(home.home)).toEqual([]);
  });

  // Token-rotation surfacing: a LEGACY unprefixed http-token is invisible to the secret
  // detectors, and `sthayi serve --http` rotates it at ITS next start (nowhere else). Doctor
  // must say exactly that — one non-secret line — without ever printing the token value.
  it('legacy unprefixed http-token: doctor warns naming the next `sthayi serve --http` start', () => {
    seedStoreWithEntity();
    const legacy = 'legacy-unprefixed-token-abcdef1234567890';
    fs.writeFileSync(home.path('http-token'), `${legacy}\n`, { mode: 0o600 });
    const before = snapshotTree(home.home);

    const checks = runDoctor();
    const tok = find(checks, 'HTTP token');
    expect(tok?.ok).toBe(false);
    expect(tok?.detail).toMatch(/rotated the next time `sthayi serve --http` starts/);
    expect(tok?.detail).toMatch(/HTTP clients must adopt the new token/);
    expect(tok?.fix).toBeTruthy();
    // never the value, and never a claim that any/every startup rotates
    expect(JSON.stringify(checks)).not.toContain(legacy);
    expect(JSON.stringify(checks)).not.toMatch(/any startup|every startup/);
    // observational as ever: the legacy file was NOT rotated by doctor itself
    expect(snapshotTree(home.home)).toEqual(before);
    expect(fs.readFileSync(home.path('http-token'), 'utf8')).toBe(`${legacy}\n`);
  });

  it('modern sthayi_tk_ token file: no rotation warning', () => {
    seedStoreWithEntity();
    fs.writeFileSync(home.path('http-token'), 'sthayi_tk_notarealtoken\n', { mode: 0o600 });
    expect(find(runDoctor(), 'HTTP token')).toBeUndefined();
  });

  it('no token file at all: no rotation warning', () => {
    seedStoreWithEntity();
    expect(find(runDoctor(), 'HTTP token')).toBeUndefined();
  });

  // INVARIANT: the doctor/status token probe reads through the SAME hardened reader serve-http
  // uses — safeReadTextFile(..., { modePolicy: 'private' }). A raw, unbounded fs.readFileSync
  // here would FOLLOW a planted symlink, accept a 4097-byte token past the 4 KiB control-file
  // cap, follow a hard link, and BLOCK on a FIFO. A trust refusal is SURFACED as a warning
  // rather than swallowed as "no token file".
  describe('HTTP-token probe: hardened, capped reader on the doctor/status call path', () => {
    const tokenPath = () => home.path('http-token');

    it(`a legacy token of EXACTLY ${PRIVATE_READ_CAP_BYTES} bytes is read and reported`, () => {
      fs.writeFileSync(tokenPath(), 'x'.repeat(PRIVATE_READ_CAP_BYTES), { mode: 0o600 });
      expect(fs.statSync(tokenPath()).size).toBe(PRIVATE_READ_CAP_BYTES);
      expect(legacyHttpTokenWarning()).toMatch(/rotated the next time/);
    });

    it(`a token of ${PRIVATE_READ_CAP_BYTES + 1} bytes is REFUSED by the cap, not read`, () => {
      const oversize = 'x'.repeat(PRIVATE_READ_CAP_BYTES + 1);
      fs.writeFileSync(tokenPath(), oversize, { mode: 0o600 });
      const warning = legacyHttpTokenWarning();
      expect(warning).toMatch(new RegExp(`${PRIVATE_READ_CAP_BYTES}-byte cap`));
      expect(warning).not.toMatch(/rotated the next time/);
      // and the doctor path surfaces it as a failing check — never silently "no token"
      const checks = runDoctor();
      const tok = find(checks, 'HTTP token');
      expect(tok?.ok).toBe(false);
      expect(tok?.detail).toMatch(/not safe to read/);
      expect(JSON.stringify(checks)).not.toContain(oversize);
    });

    it('a symlinked token file is refused, never followed — the outside victim is untouched', () => {
      const victim = home.path('external', 'victim.token');
      fs.mkdirSync(path.dirname(victim), { recursive: true });
      fs.writeFileSync(victim, 'legacy-outside-secret\n', { mode: 0o600 });
      const before = fs.readFileSync(victim, 'utf8');
      fs.symlinkSync(victim, tokenPath());

      const checks = runDoctor();
      const tok = find(checks, 'HTTP token');
      expect(tok?.ok).toBe(false);
      expect(tok?.detail).toMatch(/symlink/);
      expect(JSON.stringify(checks)).not.toContain('legacy-outside-secret');
      expect(fs.readFileSync(victim, 'utf8')).toBe(before);
      expect(fs.lstatSync(tokenPath()).isSymbolicLink()).toBe(true);
    });

    it.skipIf(process.platform === 'win32')(
      'a hard-linked token file (nlink > 1) is refused',
      () => {
        const victim = home.path('external', 'victim.token');
        fs.mkdirSync(path.dirname(victim), { recursive: true });
        fs.writeFileSync(victim, 'legacy-outside-secret\n', { mode: 0o600 });
        fs.linkSync(victim, tokenPath());
        expect(legacyHttpTokenWarning()).toMatch(/hard links/);
        expect(fs.lstatSync(victim).nlink).toBe(2); // refused, not unlinked
      },
    );

    it.skipIf(process.platform === 'win32')(
      'a FIFO swapped in at the token path is refused without blocking',
      () => {
        try {
          execFileSync('mkfifo', [tokenPath()]);
        } catch {
          return; // no mkfifo here — the symlink/hard-link rows cover the descriptor gate
        }
        // `mkfifo` is an external binary whose syscalls no wrapper in this process sees. This names
        // the ONE entry it was asked to make, so teardown has a basis for removing that entry alone.
        claimToolEntry(tokenPath());
        expect(legacyHttpTokenWarning()).toMatch(/not a regular file/);
      },
    );

    it.skipIf(process.platform === 'win32')(
      'a group-readable token is refused by the private-mode policy',
      () => {
        fs.writeFileSync(tokenPath(), 'legacy-unprefixed-token\n', { mode: 0o640 });
        expect(legacyHttpTokenWarning()).toMatch(/group- or world-accessible/);
      },
    );

    it('a healthy modern 0600 token stays silent, and the file is never rewritten', () => {
      fs.writeFileSync(tokenPath(), 'sthayi_tk_healthy-token-value\n', { mode: 0o600 });
      const before = fs.readFileSync(tokenPath(), 'utf8');
      expect(legacyHttpTokenWarning()).toBeUndefined();
      expect(find(runDoctor(), 'HTTP token')).toBeUndefined();
      expect(fs.readFileSync(tokenPath(), 'utf8')).toBe(before);
      if (process.platform !== 'win32') {
        expect(fs.lstatSync(tokenPath()).mode & 0o777).toBe(0o600);
      }
    });
  });

  // INVARIANT: the home is validated read-only before anything else, so an untrusted home stops
  // doctor at the gate. Following a symlinked home would have doctor report on — and read a
  // canary out of — a SQLite database that lives entirely outside the home.
  it('symlinked home: doctor refuses at the home gate and never reads the outside store', () => {
    const outsideBase = fs.realpathSync(runTempDir('sthayi-doctor-outside-'));
    try {
      const real = path.join(outsideBase, 'real-home');
      fs.mkdirSync(real, { mode: 0o700 });
      process.env.STHAYI_HOME = real;
      seedStoreWithEntity(); // a genuine store + vault key + canary, OUTSIDE the home
      const before = snapshotTree(real);

      const planted = home.path('planted-home');
      fs.symlinkSync(real, planted, 'dir');
      process.env.STHAYI_HOME = planted;

      const checks = runDoctor();
      expect(checks.map((c) => c.name)).toEqual(['Node version', 'Home directory']);
      const dir = find(checks, 'Home directory');
      expect(dir?.ok).toBe(false);
      expect(dir?.detail).toMatch(/symlink/);
      expect(dir?.fix).toBeTruthy();
      // nothing from the outside store leaked into the report, and nothing there was touched
      expect(JSON.stringify(checks)).not.toContain(CANARY);
      expect(snapshotTree(real)).toEqual(before);
    } finally {
      process.env.STHAYI_HOME = home.home;
      fs.rmSync(outsideBase, { recursive: true, force: true });
    }
  });

  it('group-writable home: doctor refuses it rather than reporting on a shared tree', () => {
    if (process.platform === 'win32') {
      return;
    }
    seedStoreWithEntity();
    fs.chmodSync(home.home, 0o770);
    try {
      const checks = runDoctor();
      expect(find(checks, 'Home directory')?.ok).toBe(false);
      expect(find(checks, 'Home directory')?.detail).toMatch(/group-writable/);
      expect(checks.some((c) => c.name === 'Store')).toBe(false);
      expect(fs.lstatSync(home.home).mode & 0o777).toBe(0o770); // observation never repairs
    } finally {
      fs.chmodSync(home.home, 0o700);
    }
  });

  it('uninitialized home with NO sthayi references anywhere still passes clean', () => {
    // a detected client without any sthayi entry must not trip the dangling-wiring check
    const adapter = defaultAdapters().find((a) => a.id === 'claude-desktop');
    const cfg = (adapter as NonNullable<typeof adapter>).configPath();
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    fs.writeFileSync(cfg, `${JSON.stringify({ mcpServers: { other: { command: 'x' } } })}\n`);

    const checks = runDoctor();
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(checks.map((c) => c.name)).toEqual(['Node version', 'Initialization']);
  });
});
