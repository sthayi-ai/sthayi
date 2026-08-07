import os from 'node:os';
import path from 'node:path';
import { assertTrustedDirReadOnly, establishTrustedDir } from './fs-safe.js';

/**
 * All Sthayi state lives under `~/.sthayi/` (spec §1). `STHAYI_HOME` overrides the location —
 * used by tests (fake homes) and power users. Everything else is derived from it.
 */
export function sthayiHome(): string {
  const override = process.env.STHAYI_HOME;
  if (override !== undefined && override !== '') {
    // A relative home would flow into the launcher `command` written to client configs, yielding a
    // relative/PATH-resolved command — a code-execution hazard (spec §1 invariant 7). Require absolute.
    if (!path.isAbsolute(override)) {
      throw new Error(
        `STHAYI_HOME must be an absolute path (got "${override}"). A relative home would produce a relative launcher command in client configs.`,
      );
    }
    return override;
  }
  return path.join(os.homedir(), '.sthayi');
}

/**
 * The CANONICAL ROOT established for the current STHAYI_HOME, cached for the process. Keyed on
 * the logical home the cache was built from, so a test (or a command) that changes STHAYI_HOME
 * invalidates it automatically instead of deriving paths from a stale root.
 *
 * Why it exists: validating the home and then rebuilding every derived path from the ORIGINAL
 * logical string throws the validation away — an ancestor symlink retargeted after validation
 * would move `sthayi.db`, `key`, `logs/` and the launcher to a directory that was never checked.
 * Every path below derives from this root once it is established.
 */
let establishedHome: { logical: string; canonical: string } | undefined;

/**
 * The validated canonical root when one has been established for the current STHAYI_HOME,
 * otherwise the logical home (nothing has been validated yet — the caller is still in a
 * pure-read/plan phase, and establishing it is what upgrades these paths).
 *
 * EXPORTED because "returning the canonical root from ensureSthayiHome" is not enough on its
 * own: any call site that rebuilds a path as `path.join(sthayiHome(), …)` silently opts back
 * out of the validated root and lands in fs-safe's weaker outside-a-boundary fallback. Every
 * derived state path — including ones defined outside this module (the HTTP token, the clients
 * ledger, the launcher bin dir, the pack export dir) — must go through this.
 */
export function sthayiHomeRoot(): string {
  const logical = sthayiHome();
  return establishedHome?.logical === logical ? establishedHome.canonical : logical;
}

/** Internal alias kept for the derived-path helpers below. */
const homeRoot = sthayiHomeRoot;

/**
 * Create the home dir owner-only (0700) and tighten it if an earlier run left it looser — it
 * holds the vault key, the memory db, and the journal. Call before any write under the home.
 * POSIX modes are meaningless on Windows, so the tighten/ownership steps are skipped there.
 *
 * Hardened (fs-safe establishTrustedDir): a home that is a symlink, sits directly under a
 * symlinked parent, is not a directory, is owned by someone else, or is group/world-writable is
 * REFUSED before any chmod or write. Two threats fix that order: a chmod applied to a path that
 * is a symlink re-modes the LINK'S TARGET (stat follows links — only lstat tells them apart), and
 * "repairing" a group-writable home to 0700 cannot un-plant what a peer may already have written
 * inside it. Returns (and caches) the CANONICAL root, which is what dbPath()/keyPath()/binDir()/…
 * derive from from here on.
 */
export function ensureSthayiHome(): string {
  const logical = sthayiHome();
  // Once a canonical root is established for this STHAYI_HOME, later calls RE-VALIDATE THAT ROOT
  // instead of resolving the logical string again: ensureSthayiHome runs many times per command
  // (store, launcher, ledger, logger, http server), and re-resolving each time would let an
  // ancestor symlink retargeted mid-session quietly move the home to a new tree.
  const from = establishedHome?.logical === logical ? establishedHome.canonical : logical;
  const canonical = establishTrustedDir(from, 'sthayi home', { mode: 0o700 });
  establishedHome = { logical, canonical };
  return canonical;
}

/**
 * OBSERVATIONAL home validation for `sthayi doctor` / `sthayi status` / openStoreReadOnly:
 * validates the home exactly as ensureSthayiHome does but CREATES NOTHING and CHMODS NOTHING.
 *
 * Returns the validated canonical root (also cached, so every derived path below follows it), or
 * `undefined` when the home does not exist — an uninitialized machine is a healthy observational
 * state, not a failure. THROWS with an actionable message when the home exists but cannot be
 * trusted: a symlinked home or symlinked parent (following it would read a store outside the
 * home), a non-directory, a foreign owner, or group/world-writable permissions.
 */
export function assertReadOnlySthayiHome(): string | undefined {
  const logical = sthayiHome();
  // Same stability rule as ensureSthayiHome: re-validate an already-established canonical root
  // rather than re-resolving the logical string.
  const from = establishedHome?.logical === logical ? establishedHome.canonical : logical;
  const canonical = assertTrustedDirReadOnly(from, 'sthayi home');
  if (canonical === undefined) {
    return undefined;
  }
  establishedHome = { logical, canonical };
  return canonical;
}

export function dbPath(): string {
  return path.join(homeRoot(), 'sthayi.db');
}

export function binDir(): string {
  return path.join(homeRoot(), 'bin');
}

export function launcherPath(): string {
  return path.join(binDir(), 'sthayi-mcp');
}

export function skillsDir(): string {
  return path.join(homeRoot(), 'skills');
}

export function keyPath(): string {
  return path.join(homeRoot(), 'key');
}

/** Journal checkpoint copy stored OUTSIDE the db — see core/journal/checkpoint.ts. */
export function checkpointPath(): string {
  return path.join(homeRoot(), 'journal.checkpoint');
}

export function configPath(): string {
  return path.join(homeRoot(), 'config.json');
}

export function logsDir(): string {
  return path.join(homeRoot(), 'logs');
}
