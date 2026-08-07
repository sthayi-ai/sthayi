import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readState, setClientState } from '../../packages/cli/src/clients/state.js';
import {
  SqliteDriver,
  setReadOnlySnapshotCapForTests,
} from '../../packages/cli/src/drivers/sqlite.js';
import { safeReadTextFile, safeWriteFileAtomic } from '../../packages/cli/src/fs-safe.js';
import { fileLog } from '../../packages/cli/src/mcp/logger.js';
import { ensureHttpToken, httpTokenPath } from '../../packages/cli/src/mcp/serve-http.js';
import {
  assertReadOnlySthayiHome,
  dbPath,
  ensureSthayiHome,
  logsDir,
} from '../../packages/cli/src/paths.js';
import { openStore } from '../../packages/cli/src/store.js';
import { type FakeHome, createFakeHome } from '../helpers/fake-home.js';
import { claimToolEntry } from '../helpers/owned-fs.js';

/**
 * SAFETY: filesystem containment for every Sthayi-owned state file. An unprivileged local
 * attacker plants a symlink (or a hard link) at a well-known Sthayi path, pointing at an
 * EXTERNAL VICTIM file. Every hardened open/read/write path must REFUSE — and refusing means
 * the victim's bytes AND permission bits are byte-identical afterwards, the planted link is
 * still in place, and no temp debris was left behind. Healthy paths stay byte-exact.
 *
 * Covers: sthayi.db (SqliteDriver.open), ~/.sthayi/http-token (ensureHttpToken),
 * clients-state.json (state.ts), logs/mcp.log (fileLog), and the shared fs-safe
 * safeWriteFileAtomic (the discipline pack/export writes should adopt).
 */

interface Victim {
  path: string;
  bytes: string;
  mode: number;
}

function plantVictim(home: FakeHome, name = 'victim.bin'): Victim {
  const p = home.path('external', name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const bytes = 'VICTIM CONTENT — must survive byte-identical\n';
  fs.writeFileSync(p, bytes);
  if (process.platform !== 'win32') {
    fs.chmodSync(p, 0o640);
  }
  return { path: p, bytes, mode: fs.lstatSync(p).mode & 0o777 };
}

function assertVictimIntact(v: Victim): void {
  expect(fs.readFileSync(v.path, 'utf8')).toBe(v.bytes);
  expect(fs.lstatSync(v.path).mode & 0o777).toBe(v.mode);
}

function noTmpDebris(dir: string): void {
  expect(fs.readdirSync(dir).filter((f) => f.includes('.sthayi-tmp'))).toEqual([]);
}

const posixOnly = describe.skipIf(process.platform === 'win32');

posixOnly('safety: the home boundary itself refuses planted paths (victim untouched)', () => {
  it('symlinked STHAYI_HOME → refused BEFORE any chmod or write: victim dir keeps its mode, stays empty', () => {
    const home = createFakeHome();
    try {
      const outside = home.path('outside-home');
      fs.mkdirSync(outside);
      fs.chmodSync(outside, 0o755);
      const planted = home.path('planted-home');
      fs.symlinkSync(outside, planted, 'dir');
      const saved = process.env.STHAYI_HOME;
      process.env.STHAYI_HOME = planted;
      try {
        expect(() => ensureSthayiHome()).toThrow(/symlink/);
        // the full store-open path refuses the same way, before creating anything
        expect(() => openStore()).toThrow(/symlink/);
      } finally {
        process.env.STHAYI_HOME = saved;
      }
      expect(fs.lstatSync(planted).isSymbolicLink()).toBe(true);
      // the OUTSIDE target was NOT re-modded 0755→0700: a chmod on a symlink re-modes its target
      expect(fs.lstatSync(outside).mode & 0o777).toBe(0o755);
      // and nothing (sqlite.db, key, logs, …) was created outside
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      home.cleanup();
    }
  });

  it('world-writable home → refused before any chmod (mode preserved, honestly reported)', () => {
    const home = createFakeHome();
    try {
      fs.chmodSync(home.home, 0o777);
      expect(() => ensureSthayiHome()).toThrow(/world-writable/);
      // refusal, not repair: chmodding cannot un-plant what an attacker may already have placed
      expect(fs.lstatSync(home.home).mode & 0o777).toBe(0o777);
      fs.chmodSync(home.home, 0o700);
    } finally {
      home.cleanup();
    }
  });

  it('a regular file squatting at STHAYI_HOME → refused (not a directory)', () => {
    const home = createFakeHome();
    try {
      const filePath = home.path('file-home');
      fs.writeFileSync(filePath, 'not a directory');
      const saved = process.env.STHAYI_HOME;
      process.env.STHAYI_HOME = filePath;
      try {
        expect(() => ensureSthayiHome()).toThrow(/not a directory/);
      } finally {
        process.env.STHAYI_HOME = saved;
      }
      expect(fs.readFileSync(filePath, 'utf8')).toBe('not a directory');
    } finally {
      home.cleanup();
    }
  });

  it('healthy home path unchanged: created 0700, loose-but-safe 0755 tightened to 0700', () => {
    const home = createFakeHome();
    try {
      ensureSthayiHome();
      expect(fs.lstatSync(home.home).mode & 0o777).toBe(0o700);
      fs.chmodSync(home.home, 0o755);
      ensureSthayiHome();
      expect(fs.lstatSync(home.home).mode & 0o777).toBe(0o700);
    } finally {
      home.cleanup();
    }
  });
});

/**
 * SAFETY: the home trust boundary is a stable CANONICAL DIRECTORY (path + device/inode), never a
 * path STRING. Registering both the logical path and its realpath as interchangeable trusted
 * prefixes would let an attacker-controlled ancestor symlink steer the home — and retargeting it
 * afterwards would steer every hardened read and atomic write with it.
 *
 * PLATFORM SCOPE: the device/inode half of that identity is compared on POSIX only, so this block
 * is `posixOnly` and the property is claimed for macOS/Linux alone — see the platform scope note
 * at the top of fs-safe.ts.
 */
posixOnly('safety: the home boundary is a canonical directory, not a path string', () => {
  /** Run `fn` with STHAYI_HOME pointed at `home`, restoring the previous value afterwards. */
  function withHome<T>(home: string, fn: () => T): T {
    const saved = process.env.STHAYI_HOME;
    process.env.STHAYI_HOME = home;
    try {
      return fn();
    } finally {
      process.env.STHAYI_HOME = saved;
    }
  }

  it('4A: an EXISTING home behind a symlinked parent → refused; the outside target keeps its mode and contents', () => {
    const home = createFakeHome();
    try {
      const outside = home.path('outside-a');
      const target = path.join(outside, 'existing-home');
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'pre-existing.txt'), 'OUTSIDE CONTENT\n');
      fs.chmodSync(target, 0o755);
      fs.symlinkSync(outside, home.path('hop'), 'dir');

      withHome(home.path('hop', 'existing-home'), () => {
        expect(() => ensureSthayiHome()).toThrow(/symlink/);
        expect(() => openStore()).toThrow(/symlink/);
      });

      // never chmodded through the hop, never written into, never read out of
      expect(fs.lstatSync(target).mode & 0o777).toBe(0o755);
      expect(fs.readdirSync(target)).toEqual(['pre-existing.txt']);
      expect(fs.readFileSync(path.join(target, 'pre-existing.txt'), 'utf8')).toBe(
        'OUTSIDE CONTENT\n',
      );
    } finally {
      home.cleanup();
    }
  });

  it('4B: a MISSING home behind a symlinked parent → refused; nothing is created in the outside tree', () => {
    const home = createFakeHome();
    try {
      const outside = home.path('outside-b');
      fs.mkdirSync(outside);
      fs.symlinkSync(outside, home.path('hop2'), 'dir');

      withHome(home.path('hop2', 'new-home'), () => {
        expect(() => ensureSthayiHome()).toThrow(/symlink/);
        expect(() => openStore()).toThrow(/symlink/);
      });

      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      home.cleanup();
    }
  });

  it('4C: retargeting the ancestor symlink AFTER establishment moves nothing — the new target is byte- and mode-identical', () => {
    const home = createFakeHome();
    try {
      const a = home.path('A', 'sub');
      fs.mkdirSync(a, { recursive: true });
      fs.symlinkSync(home.path('A'), home.path('hop'), 'dir');

      // The home is named by its CANONICAL REAL PATH — the `hop/sub/home` spelling of the same
      // directory is refused outright (4G), so the only reachable state is this one.
      withHome(path.join(a, 'home'), () => {
        const canonical = ensureSthayiHome();
        expect(canonical).toBe(path.join(a, 'home'));

        // B — the attacker's tree: same shape, wide open, with an export victim already in it
        const b = home.path('B');
        const bHome = path.join(b, 'sub', 'home');
        fs.mkdirSync(bHome, { recursive: true });
        const victim = path.join(bHome, 'export.md');
        fs.writeFileSync(victim, 'OUTSIDE — must survive byte-identical\n');
        fs.chmodSync(victim, 0o666);
        fs.chmodSync(bHome, 0o777);
        fs.unlinkSync(home.path('hop'));
        fs.symlinkSync(b, home.path('hop'), 'dir');

        // the store still lands in the validated canonical root, not in B
        const store = openStore();
        store.close();
        expect(fs.existsSync(path.join(a, 'home', 'sthayi.db'))).toBe(true);
        expect(fs.existsSync(path.join(bHome, 'sthayi.db'))).toBe(false);

        // hardened read AND atomic write, derived from the canonical root, stay inside it
        safeWriteFileAtomic(path.join(canonical, 'export.md'), 'inside\n');
        expect(safeReadTextFile(path.join(canonical, 'export.md'), 'probe')).toBe('inside\n');

        // The LOGICAL spelling through the retargeted hop is NOT an alias for the established
        // boundary — it does not prefix-match it, so no boundary is found. Validating only the
        // FINAL PARENT would pass there (`hop/sub/home` lstats as a real directory); the whole
        // chain is walked instead, and the symlinked `hop` refuses both the read and the write.
        const throughHop = home.path('hop', 'sub', 'home', 'export.md');
        expect(() => safeWriteFileAtomic(throughHop, 'HIJACKED\n')).toThrow(/symlink/);
        expect(() => safeReadTextFile(throughHop, 'probe')).toThrow(/symlink/);

        // B is untouched: contents, file mode, directory mode, and no temp debris
        expect(fs.readFileSync(victim, 'utf8')).toBe('OUTSIDE — must survive byte-identical\n');
        expect(fs.lstatSync(victim).mode & 0o777).toBe(0o666);
        expect(fs.lstatSync(bHome).mode & 0o777).toBe(0o777);
        expect(fs.readdirSync(bHome)).toEqual(['export.md']);
        noTmpDebris(bHome);
      });
    } finally {
      home.cleanup();
    }
  });

  it('4D: a missing home under a NON-STICKY world-writable parent → refused; a sticky /tmp-shaped parent is fine', () => {
    const home = createFakeHome();
    try {
      const loose = home.path('loose-parent');
      fs.mkdirSync(loose);
      fs.chmodSync(loose, 0o777);
      withHome(path.join(loose, 'home'), () => {
        expect(() => ensureSthayiHome()).toThrow(/sticky/);
      });
      expect(fs.readdirSync(loose)).toEqual([]);

      const sticky = home.path('sticky-parent');
      fs.mkdirSync(sticky);
      fs.chmodSync(sticky, 0o1777);
      withHome(path.join(sticky, 'home'), () => {
        expect(ensureSthayiHome()).toBe(path.join(sticky, 'home'));
      });
      expect(fs.lstatSync(path.join(sticky, 'home')).mode & 0o777).toBe(0o700);
    } finally {
      home.cleanup();
    }
  });

  it('4E: an already GROUP-writable home → refused before any chmod (a chmod cannot un-plant what peers wrote)', () => {
    const home = createFakeHome();
    try {
      const shared = home.path('group-home');
      fs.mkdirSync(shared);
      fs.writeFileSync(path.join(shared, 'planted-by-a-peer.txt'), 'PLANTED\n');
      fs.chmodSync(shared, 0o770);
      withHome(shared, () => {
        expect(() => ensureSthayiHome()).toThrow(/group-writable/);
        expect(() => openStore()).toThrow(/group-writable/);
      });
      expect(fs.lstatSync(shared).mode & 0o777).toBe(0o770); // refusal, not silent repair
      expect(fs.readdirSync(shared)).toEqual(['planted-by-a-peer.txt']);
    } finally {
      home.cleanup();
    }
  });

  it('4F: the OBSERVATIONAL validator refuses a symlinked home and creates/chmods nothing', () => {
    const home = createFakeHome();
    try {
      const outside = home.path('outside-f');
      fs.mkdirSync(outside);
      fs.chmodSync(outside, 0o755);
      const planted = home.path('planted-home');
      fs.symlinkSync(outside, planted, 'dir');

      withHome(planted, () => {
        expect(() => assertReadOnlySthayiHome()).toThrow(/symlink/);
      });
      expect(fs.lstatSync(outside).mode & 0o777).toBe(0o755);
      expect(fs.readdirSync(outside)).toEqual([]);

      // and an absent home is simply "nothing to observe" — never created
      withHome(home.path('never-initialized'), () => {
        expect(assertReadOnlySthayiHome()).toBeUndefined();
      });
      expect(fs.existsSync(home.path('never-initialized'))).toBe(false);
    } finally {
      home.cleanup();
    }
  });

  it('4G: an INTERMEDIATE symlink at any depth is refused — existing and missing, writable and read-only', () => {
    const home = createFakeHome();
    try {
      const outside = home.path('outside-g');
      const existing = path.join(outside, 'sub', 'existing-home');
      fs.mkdirSync(existing, { recursive: true });
      fs.writeFileSync(path.join(existing, 'pre-existing.txt'), 'OUTSIDE\n');
      fs.chmodSync(existing, 0o755);
      fs.mkdirSync(path.join(outside, 'deep', 'a', 'b'), { recursive: true });
      fs.symlinkSync(outside, home.path('hopg'), 'dir');

      // depth 2, EXISTING: the home's own parent (`hopg/sub`) lstats as a real directory
      withHome(home.path('hopg', 'sub', 'existing-home'), () => {
        expect(() => ensureSthayiHome()).toThrow(/symlink/);
        expect(() => assertReadOnlySthayiHome()).toThrow(/symlink/);
        expect(() => openStore()).toThrow(/symlink/);
      });

      // depth 2, MISSING: the deepest EXISTING ancestor is a real directory through the link
      withHome(home.path('hopg', 'sub', 'new-home'), () => {
        expect(() => ensureSthayiHome()).toThrow(/symlink/);
        expect(() => openStore()).toThrow(/symlink/);
      });

      // depth 4, MISSING
      withHome(home.path('hopg', 'deep', 'a', 'b', 'new-home'), () => {
        expect(() => ensureSthayiHome()).toThrow(/symlink/);
      });

      // the whole outside tree is byte- and mode-identical, and nothing new appeared in it
      expect(fs.lstatSync(existing).mode & 0o777).toBe(0o755);
      expect(fs.readdirSync(existing)).toEqual(['pre-existing.txt']);
      expect(fs.readFileSync(path.join(existing, 'pre-existing.txt'), 'utf8')).toBe('OUTSIDE\n');
      expect(fs.readdirSync(path.join(outside, 'sub'))).toEqual(['existing-home']);
      expect(fs.readdirSync(path.join(outside, 'deep', 'a', 'b'))).toEqual([]);
    } finally {
      home.cleanup();
    }
  });
});

posixOnly('safety: sthayi.db open refuses planted paths (external victim untouched)', () => {
  it('symlinked db path → refused, victim and link byte-identical', () => {
    const home = createFakeHome();
    try {
      const victim = plantVictim(home);
      fs.symlinkSync(victim.path, dbPath());
      expect(() => SqliteDriver.open(dbPath())).toThrow(/refusing to open the memory database/);
      expect(() => SqliteDriver.open(dbPath())).toThrow(/symlink/);
      expect(fs.lstatSync(dbPath()).isSymbolicLink()).toBe(true);
      assertVictimIntact(victim);
    } finally {
      home.cleanup();
    }
  });

  it('hard-linked db path (nlink > 1) → refused, victim byte-identical', () => {
    const home = createFakeHome();
    try {
      const victim = plantVictim(home);
      fs.linkSync(victim.path, dbPath());
      expect(() => SqliteDriver.open(dbPath())).toThrow(/hard links/);
      assertVictimIntact(victim);
      expect(fs.lstatSync(victim.path).nlink).toBe(2); // the alias was not unlinked either
    } finally {
      home.cleanup();
    }
  });

  it('symlinked -wal sidecar → refused before SQLite can open it', () => {
    const home = createFakeHome();
    try {
      const victim = plantVictim(home);
      fs.mkdirSync(path.dirname(dbPath()), { recursive: true });
      fs.symlinkSync(victim.path, `${dbPath()}-wal`);
      expect(() => SqliteDriver.open(dbPath())).toThrow(/WAL sidecar.*symlink/);
      assertVictimIntact(victim);
    } finally {
      home.cleanup();
    }
  });

  it('directory at the db path → refused (not a regular file)', () => {
    const home = createFakeHome();
    try {
      fs.mkdirSync(dbPath(), { recursive: true });
      expect(() => SqliteDriver.open(dbPath())).toThrow(/not a regular file/);
    } finally {
      home.cleanup();
    }
  });

  it('FIFO at the db path → refused without hanging', () => {
    const home = createFakeHome();
    try {
      fs.mkdirSync(path.dirname(dbPath()), { recursive: true });
      try {
        execFileSync('mkfifo', [dbPath()]);
      } catch {
        return; // no mkfifo on this system — the directory case covers the branch
      }
      // `mkfifo` is an external binary whose syscalls no wrapper in this process sees. This names
      // the ONE entry it was asked to make, so teardown has a basis for removing that entry alone.
      claimToolEntry(dbPath());
      expect(() => SqliteDriver.open(dbPath())).toThrow(/not a regular file/);
    } finally {
      home.cleanup();
    }
  });
});

describe('safety: sthayi.db healthy path unchanged', () => {
  it('creates, migrates, persists across reopen; 0600 on POSIX', () => {
    const home = createFakeHome();
    try {
      const d1 = SqliteDriver.open(dbPath());
      d1.migrate();
      d1.setMeta('file-trust-probe', 'v1');
      d1.close();
      if (process.platform !== 'win32') {
        expect(fs.lstatSync(dbPath()).mode & 0o777).toBe(0o600);
      }
      const d2 = SqliteDriver.open(dbPath()); // reopen with healthy sidecars present
      expect(d2.getMeta('file-trust-probe')).toBe('v1');
      d2.close();
    } finally {
      home.cleanup();
    }
  });
});

posixOnly('safety: http-token file refuses planted paths (external victim untouched)', () => {
  it('symlinked token file → refused, victim and link byte-identical', () => {
    const home = createFakeHome();
    try {
      const victim = plantVictim(home);
      fs.symlinkSync(victim.path, httpTokenPath());
      expect(() => ensureHttpToken()).toThrow(/symlink/);
      expect(fs.lstatSync(httpTokenPath()).isSymbolicLink()).toBe(true);
      assertVictimIntact(victim);
      noTmpDebris(home.home);
    } finally {
      home.cleanup();
    }
  });

  it('hard-linked token file (nlink > 1) → refused, victim byte-identical', () => {
    const home = createFakeHome();
    try {
      const victim = plantVictim(home);
      fs.chmodSync(victim.path, 0o600); // pass the private-mode gate so nlink is what refuses
      const v = { ...victim, mode: fs.lstatSync(victim.path).mode & 0o777 };
      fs.linkSync(victim.path, httpTokenPath());
      expect(() => ensureHttpToken()).toThrow(/hard links/);
      assertVictimIntact(v);
      expect(fs.lstatSync(victim.path).nlink).toBe(2);
    } finally {
      home.cleanup();
    }
  });
});

describe('safety: http-token healthy path unchanged', () => {
  it('generates sthayi_tk_ at 0600, byte-exact file, stable across calls', () => {
    const home = createFakeHome();
    try {
      const token = ensureHttpToken();
      expect(token).toMatch(/^sthayi_tk_[A-Za-z0-9_-]{43}$/);
      expect(fs.readFileSync(httpTokenPath(), 'utf8')).toBe(`${token}\n`);
      if (process.platform !== 'win32') {
        expect(fs.lstatSync(httpTokenPath()).mode & 0o777).toBe(0o600);
      }
      expect(ensureHttpToken()).toBe(token);
    } finally {
      home.cleanup();
    }
  });
});

posixOnly('safety: clients-state.json refuses planted paths (external victim untouched)', () => {
  it('symlinked ledger → read AND write refused, victim and link byte-identical', () => {
    const home = createFakeHome();
    try {
      const victim = plantVictim(home);
      fs.symlinkSync(victim.path, home.path('clients-state.json'));
      expect(() => readState()).toThrow(/symlink/);
      expect(() =>
        setClientState('x', { backupPath: null, existedBefore: false, wiredAt: 1 }),
      ).toThrow(/symlink/);
      expect(fs.lstatSync(home.path('clients-state.json')).isSymbolicLink()).toBe(true);
      assertVictimIntact(victim);
      noTmpDebris(home.home);
    } finally {
      home.cleanup();
    }
  });

  it('hard-linked ledger (nlink > 1) → refused, victim byte-identical', () => {
    const home = createFakeHome();
    try {
      const victim = plantVictim(home);
      fs.linkSync(victim.path, home.path('clients-state.json'));
      expect(() => readState()).toThrow(/hard links/);
      expect(() =>
        setClientState('x', { backupPath: null, existedBefore: false, wiredAt: 1 }),
      ).toThrow(/hard links/);
      assertVictimIntact(victim);
      expect(fs.lstatSync(victim.path).nlink).toBe(2);
    } finally {
      home.cleanup();
    }
  });
});

posixOnly('safety: logs/mcp.log never writes through a planted path', () => {
  it('symlinked mcp.log → line dropped (no throw), victim and link byte-identical', () => {
    const home = createFakeHome();
    try {
      const victim = plantVictim(home);
      fs.mkdirSync(logsDir(), { recursive: true });
      fs.symlinkSync(victim.path, path.join(logsDir(), 'mcp.log'));
      expect(() => fileLog('hijack probe — must not land in the victim')).not.toThrow();
      expect(fs.lstatSync(path.join(logsDir(), 'mcp.log')).isSymbolicLink()).toBe(true);
      assertVictimIntact(victim);
    } finally {
      home.cleanup();
    }
  });

  it('hard-linked mcp.log (nlink > 1) → line dropped, victim byte-identical', () => {
    const home = createFakeHome();
    try {
      const victim = plantVictim(home);
      fs.mkdirSync(logsDir(), { recursive: true });
      fs.linkSync(victim.path, path.join(logsDir(), 'mcp.log'));
      expect(() => fileLog('hijack probe — must not land in the victim')).not.toThrow();
      assertVictimIntact(victim);
    } finally {
      home.cleanup();
    }
  });
});

describe('safety: logs/mcp.log healthy path unchanged', () => {
  it('creates the log 0600 and appends across calls', () => {
    const home = createFakeHome();
    try {
      fileLog('first line');
      fileLog('second line');
      const p = path.join(logsDir(), 'mcp.log');
      const content = fs.readFileSync(p, 'utf8');
      expect(content).toMatch(/first line\n/);
      expect(content).toMatch(/second line\n$/);
      expect(content.split('\n').filter(Boolean)).toHaveLength(2);
      if (process.platform !== 'win32') {
        expect(fs.lstatSync(p).mode & 0o777).toBe(0o600);
      }
    } finally {
      home.cleanup();
    }
  });
});

posixOnly('safety: safeWriteFileAtomic refuses planted paths (external victim untouched)', () => {
  it('symlinked target → refused, victim and link byte-identical, no debris', () => {
    const home = createFakeHome();
    try {
      const victim = plantVictim(home);
      const target = home.path('out', 'export.md');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.symlinkSync(victim.path, target);
      expect(() => safeWriteFileAtomic(target, 'new content\n')).toThrow(/symlink/);
      expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
      assertVictimIntact(victim);
      noTmpDebris(path.dirname(target));
    } finally {
      home.cleanup();
    }
  });

  it('hard-linked target (nlink > 1) → refused, victim byte-identical', () => {
    const home = createFakeHome();
    try {
      const victim = plantVictim(home);
      const target = home.path('out', 'export.md');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.linkSync(victim.path, target);
      expect(() => safeWriteFileAtomic(target, 'new content\n')).toThrow(/hard links/);
      assertVictimIntact(victim);
      expect(fs.lstatSync(victim.path).nlink).toBe(2);
    } finally {
      home.cleanup();
    }
  });

  it('symlinked parent directory → refused, nothing lands in the real directory', () => {
    const home = createFakeHome();
    try {
      const realDir = home.path('real-dir');
      fs.mkdirSync(realDir, { recursive: true });
      const linkedDir = home.path('linked-dir');
      fs.symlinkSync(realDir, linkedDir, 'dir');
      expect(() => safeWriteFileAtomic(path.join(linkedDir, 'export.md'), 'new content\n')).toThrow(
        /symlink/,
      );
      expect(fs.readdirSync(realDir)).toEqual([]);
      expect(fs.lstatSync(linkedDir).isSymbolicLink()).toBe(true);
    } finally {
      home.cleanup();
    }
  });

  it('symlinked EARLIER ancestor (missing tail) → refused, nothing created in the outside dir', () => {
    // target home/a/b/export.md with home/a → outside: a recursive mkdir would build THROUGH the
    // link (creating outside/b), after which a final-parent lstat sees a real directory.
    const home = createFakeHome();
    try {
      const outside = home.path('outside-dir');
      fs.mkdirSync(outside);
      fs.symlinkSync(outside, home.path('a'), 'dir');
      expect(() => safeWriteFileAtomic(home.path('a', 'b', 'export.md'), 'x\n')).toThrow(/symlink/);
      expect(fs.readdirSync(outside)).toEqual([]);
      expect(fs.lstatSync(home.path('a')).isSymbolicLink()).toBe(true);
    } finally {
      home.cleanup();
    }
  });

  it('symlinked EARLIER ancestor with the final parent pre-created outside → refused beneath the established home boundary', () => {
    // The harder shape: home/a → outside AND outside/b already exists, so the final parent
    // (home/a/b) lstats as a real directory. Beneath an ensureSthayiHome-established boundary
    // the WHOLE chain below the home is validated, and home/a is refused as a symlink.
    const home = createFakeHome();
    try {
      ensureSthayiHome(); // establishes the boundary, as every production write path does
      const outside = home.path('outside-dir');
      fs.mkdirSync(path.join(outside, 'b'), { recursive: true });
      fs.symlinkSync(outside, home.path('a'), 'dir');
      expect(() => safeWriteFileAtomic(home.path('a', 'b', 'export.md'), 'x\n')).toThrow(/symlink/);
      expect(fs.readdirSync(path.join(outside, 'b'))).toEqual([]);
      noTmpDebris(path.join(outside, 'b'));
      expect(fs.lstatSync(home.path('a')).isSymbolicLink()).toBe(true);
    } finally {
      home.cleanup();
    }
  });
});

posixOnly('safety: a symlinked logs DIRECTORY never receives a log line', () => {
  it('logs → outside dir: line dropped (no throw), outside dir stays empty, link intact', () => {
    // A logger that mkdir'd logs/ blindly and guarded only the final mcp.log component would land
    // its appends in the outside tree whenever `<home>/logs -> outside`. The directory itself is
    // validated too, so the line is dropped instead.
    const home = createFakeHome();
    try {
      const outside = home.path('outside-logs');
      fs.mkdirSync(outside);
      fs.chmodSync(outside, 0o755);
      fs.symlinkSync(outside, logsDir(), 'dir');
      expect(() => fileLog('hijack probe — must not land outside')).not.toThrow();
      expect(fs.readdirSync(outside)).toEqual([]);
      expect(fs.lstatSync(outside).mode & 0o777).toBe(0o755); // never chmodded through the link
      expect(fs.lstatSync(logsDir()).isSymbolicLink()).toBe(true);
    } finally {
      home.cleanup();
    }
  });
});

posixOnly(
  'safety: read-only db open applies the same trust gate (external victim untouched)',
  () => {
    it('symlinked db path → refused, victim and link byte-identical', () => {
      const home = createFakeHome();
      try {
        const victim = plantVictim(home);
        fs.symlinkSync(victim.path, dbPath());
        expect(() => SqliteDriver.openReadOnly(dbPath())).toThrow(
          /refusing to open the memory database/,
        );
        expect(() => SqliteDriver.openReadOnly(dbPath())).toThrow(/symlink/);
        expect(fs.lstatSync(dbPath()).isSymbolicLink()).toBe(true);
        assertVictimIntact(victim);
      } finally {
        home.cleanup();
      }
    });

    it('hard-linked db path (nlink > 1) → refused, victim byte-identical', () => {
      const home = createFakeHome();
      try {
        const victim = plantVictim(home);
        fs.linkSync(victim.path, dbPath());
        expect(() => SqliteDriver.openReadOnly(dbPath())).toThrow(/hard links/);
        assertVictimIntact(victim);
        expect(fs.lstatSync(victim.path).nlink).toBe(2);
      } finally {
        home.cleanup();
      }
    });

    it('FIFO at the db path → refused without hanging', () => {
      const home = createFakeHome();
      try {
        fs.mkdirSync(path.dirname(dbPath()), { recursive: true });
        try {
          execFileSync('mkfifo', [dbPath()]);
        } catch {
          return; // no mkfifo on this system — the symlink/hardlink rows cover the gate
        }
        // `mkfifo` is an external binary whose syscalls no wrapper in this process sees. This names
        // the ONE entry it was asked to make, so teardown has a basis for removing that entry alone.
        claimToolEntry(dbPath());
        expect(() => SqliteDriver.openReadOnly(dbPath())).toThrow(/not a regular file/);
      } finally {
        home.cleanup();
      }
    });

    it('oversize db (over the 512 MiB snapshot cap) → refused with an actionable message, file untouched', () => {
      const home = createFakeHome();
      try {
        const d = SqliteDriver.open(dbPath());
        d.migrate();
        d.setMeta('probe', 'v1');
        d.close();
        // Sparse-extend past the cap: st.size is what the gate must refuse on, before any read.
        fs.truncateSync(dbPath(), 513 * 1024 * 1024);
        expect(() => SqliteDriver.openReadOnly(dbPath())).toThrow(/512 MiB snapshot cap/);
        expect(fs.lstatSync(dbPath()).size).toBe(513 * 1024 * 1024);
      } finally {
        home.cleanup();
      }
    });

    // The fstat size is a hint, not a bound: the cap is the read loop's own limit (a limit+1
    // sentinel on the same descriptor), so a db that grows after the stat is refused rather than
    // copied into memory whole — which is what an unbounded fs.readFileSync(fd) behind a size
    // check would do. The cap is lowered through the documented test-only seam so this stays cheap.
    it('a db that GROWS after the fstat is refused by the capped read, and the file is untouched', () => {
      const home = createFakeHome();
      try {
        const d = SqliteDriver.open(dbPath());
        d.migrate();
        d.setMeta('probe', 'v1');
        d.close();
        fs.rmSync(`${dbPath()}-wal`, { force: true });
        fs.rmSync(`${dbPath()}-shm`, { force: true });
        const before = fs.readFileSync(dbPath());

        const cap = 4096;
        setReadOnlySnapshotCapForTests(cap);
        const realFstat = fs.fstatSync.bind(fs);
        vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number) => {
          const st = realFstat(fd);
          Object.defineProperty(st, 'size', { value: cap }); // as if it grew right after the stat
          return st;
        }) as typeof fs.fstatSync);
        try {
          expect(() => SqliteDriver.openReadOnly(dbPath())).toThrow(/grew while being read/);
        } finally {
          vi.restoreAllMocks();
          setReadOnlySnapshotCapForTests(undefined);
        }
        expect(fs.readFileSync(dbPath()).equals(before)).toBe(true);
      } finally {
        home.cleanup();
      }
    });

    it('healthy path unchanged: snapshot-reads a cleanly checkpointed store with zero writes', () => {
      const home = createFakeHome();
      try {
        const d = SqliteDriver.open(dbPath());
        d.migrate();
        d.setMeta('probe', 'v1');
        d.close();
        const beforeBytes = fs.readFileSync(dbPath());
        const ro = SqliteDriver.openReadOnly(dbPath());
        try {
          expect(ro.getMeta('probe')).toBe('v1');
        } finally {
          ro.close();
        }
        expect(fs.readFileSync(dbPath()).equals(beforeBytes)).toBe(true);
        expect(fs.existsSync(`${dbPath()}-wal`)).toBe(false); // observation minted no sidecars
      } finally {
        home.cleanup();
      }
    });
  },
);

describe('safety: safeWriteFileAtomic healthy path', () => {
  it('new file: byte-exact content, 0600 default, explicit mode honored, no debris', () => {
    const home = createFakeHome();
    try {
      const a = home.path('out', 'a.md');
      safeWriteFileAtomic(a, 'alpha\n');
      expect(fs.readFileSync(a, 'utf8')).toBe('alpha\n');
      const b = home.path('out', 'b.md');
      safeWriteFileAtomic(b, 'bravo\n', { mode: 0o644 });
      expect(fs.readFileSync(b, 'utf8')).toBe('bravo\n');
      if (process.platform !== 'win32') {
        expect(fs.lstatSync(a).mode & 0o777).toBe(0o600);
        expect(fs.lstatSync(b).mode & 0o777).toBe(0o644);
      }
      noTmpDebris(home.path('out'));
    } finally {
      home.cleanup();
    }
  });

  it('existing file: content replaced byte-exact, permission bits preserved', () => {
    const home = createFakeHome();
    try {
      const p = home.path('out', 'keep-mode.md');
      safeWriteFileAtomic(p, 'v1\n', { mode: 0o640 });
      safeWriteFileAtomic(p, 'v2 — replaced\n');
      expect(fs.readFileSync(p, 'utf8')).toBe('v2 — replaced\n');
      if (process.platform !== 'win32') {
        expect(fs.lstatSync(p).mode & 0o777).toBe(0o640);
      }
      noTmpDebris(home.path('out'));
    } finally {
      home.cleanup();
    }
  });
});
