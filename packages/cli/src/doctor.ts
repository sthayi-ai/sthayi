import fs from 'node:fs';
import path from 'node:path';
import { SCHEMA_VERSION_KEY, pendingMigrations } from '@sthayi/core';
import { defaultAdapters } from './clients/index.js';
import { launcherHealth } from './clients/launcher.js';
import { NodeCrypto } from './drivers/crypto.js';
import { safeReadTextFile, untrustedFileReason } from './fs-safe.js';
import { assertReadOnlySthayiHome, dbPath, keyPath, sthayiHomeRoot } from './paths.js';
import {
  isNativeAddonCompatibilityError,
  nativeAddonCompatibilitySummary,
  nativeAddonReinstallGuidance,
  nodeRuntimeSupport,
} from './runtime-guard.js';
import { openStoreReadOnly } from './store.js';

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function storeOpenFailureCheck(
  error: unknown,
  options: { nodeVersion?: string; platform?: NodeJS.Platform } = {},
): Check {
  if (isNativeAddonCompatibilityError(error)) {
    return {
      name: 'Store',
      ok: false,
      detail: nativeAddonCompatibilitySummary(options.nodeVersion),
      fix: nativeAddonReinstallGuidance(options.platform),
    };
  }
  return {
    name: 'Store',
    ok: false,
    detail: errMsg(error),
    fix: 'the database cannot be opened read-only — if this persists, restore ~/.sthayi from backup',
  };
}

/**
 * TRI-STATE presence: an entry is there, nothing is there, or DOCTOR CANNOT TELL.
 * `unknown` carries the errno code so the diagnostic can name it.
 */
type Presence = { state: 'present' } | { state: 'absent' } | { state: 'unknown'; code: string };

/**
 * Is SOMETHING present at `p`? lstat, never `fs.existsSync`.
 *
 * existsSync FOLLOWS symlinks, so at Sthayi's well-known state paths it answers for the LINK'S
 * TARGET, and BOTH directions are wrong and user-visible: `~/.sthayi/sthayi.db -> <outside file>`
 * would make doctor declare the machine INITIALIZED (and then report on that outside file), while
 * a DANGLING link at the same path reads as "nothing here" and produces a confident "not
 * initialized" for a home with an entry plainly planted in it. Presence is a property of the entry
 * AT the path — a symlink is present as a symlink — so lstat is the only correct probe, and
 * whatever is found is validated before anything further is said about it.
 *
 * AND A FAILED lstat IS NOT ABSENCE. Collapsing every error into `false` turns EACCES — the
 * containing directory chmod'd 000, the single most common way a real home becomes unreadable —
 * and EIO from a failing disk into the healthiest verdict doctor can print:
 * `Initialization · ok · not initialized (no store at ~/.sthayi) — run \`sthayi init\` when ready`,
 * with the store and the key sitting right there. A user acting on that line runs `sthayi init`
 * against a home doctor never managed to look at. "I could not tell" and "there is nothing there"
 * are different answers, and only one of them is safe to render as OK — so they are different
 * states here, and the caller must handle `unknown` explicitly rather than defaulting it either way.
 *
 * ENOENT is the only code that means absent. ENOTDIR (a file where a directory must be), EACCES,
 * EPERM, ELOOP, EIO and anything else are all `unknown`.
 */
function presenceNoFollow(p: string): Presence {
  try {
    fs.lstatSync(p);
    return { state: 'present' };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT'
      ? { state: 'absent' }
      : { state: 'unknown', code: code ?? 'unknown error' };
  }
}

/**
 * Non-secret probe for a LEGACY (unprefixed) HTTP token file. `sthayi serve --http` rotates
 * such a token the next time IT starts (mcp/serve-http.ts ensureHttpToken) — no other command
 * or startup touches it — so status and doctor surface the pending rotation here, letting HTTP
 * clients prepare instead of hitting a surprise 401. The path mirrors serve-http's
 * httpTokenPath() rather than importing it: serve-http pulls the MCP SDK in at module top, far
 * too heavy for the status/doctor path. Returns a one-line warning or undefined; the token
 * VALUE is never returned, logged, or printed.
 *
 * SAME hardened reader as serve-http's ensureHttpToken — `safeReadTextFile(..., { modePolicy:
 * 'private' })`: O_NOFOLLOW + fstat re-validation on the open descriptor (a symlinked or
 * hard-linked token is refused, never followed; a FIFO cannot block us) and the 4 KiB
 * PRIVATE_READ_CAP_BYTES cap enforced at the descriptor level. The raw unbounded
 * `fs.readFileSync` this replaced happily followed a planted link and read past the cap.
 * A trust refusal is SURFACED as a warning, never swallowed as "no token file" — a hijacked
 * token path is precisely what doctor exists to report.
 *
 * `homeRoot` is the already-validated canonical home when the caller has one (runDoctor passes
 * it); otherwise the home is validated here, read-only — this function never creates or chmods.
 */
export function legacyHttpTokenWarning(homeRoot?: string): string | undefined {
  let root = homeRoot;
  if (root === undefined) {
    try {
      root = assertReadOnlySthayiHome();
    } catch (err) {
      return `HTTP token file could not be checked: ${errMsg(err)}`;
    }
    if (root === undefined) {
      return undefined; // no home at all — nothing to check
    }
  }
  const p = path.join(root, 'http-token');
  let value: string | undefined;
  try {
    value = safeReadTextFile(p, 'HTTP token file', { modePolicy: 'private' });
  } catch (err) {
    return `HTTP token file at ${p} is not safe to read: ${errMsg(err)}`;
  }
  if (value === undefined) {
    return undefined; // absent — the healthy "never served over HTTP" state
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.startsWith('sthayi_tk_')) {
    return undefined; // modern detector-recognizable token — nothing pending
  }
  return `legacy unprefixed token file at ${p} — the HTTP token will be rotated the next time \`sthayi serve --http\` starts; HTTP clients must adopt the new token`;
}

/**
 * `sthayi doctor` — diagnose the install: Node version, store health, journal integrity, vault
 * key state, encrypted-entity health, launcher integrity, and per-client wiring. Every failure
 * carries a fix-it line.
 *
 * Doctor is OBSERVATIONAL. It creates, migrates, rewrites, and repairs NOTHING —
 * the store opens read-only, the key is loaded (never generated), a missing key next to an
 * existing store is a fatal diagnostic rather than a trigger to mint a new key, and the home is
 * validated with assertReadOnlySthayiHome (never ensureSthayiHome, which would create and chmod).
 */
export function runDoctor(): Check[] {
  const checks: Check[] = [];

  const supportedNode = nodeRuntimeSupport(process.versions.node).supported;
  checks.push({
    name: 'Node version',
    ok: supportedNode,
    detail: `v${process.versions.node}`,
    fix: supportedNode
      ? undefined
      : 'install Node.js 24 LTS from https://nodejs.org/en/download, then reinstall Sthayi',
  });

  // Home trust gate, FIRST and read-only: doctor must never follow a symlinked (or otherwise
  // hijacked) home and report on a store, key, or token that lives outside it. Everything below
  // derives from the validated canonical root; an untrusted home stops doctor right here, since
  // every later reading would be a reading of the attacker's tree.
  let home: string;
  try {
    // sthayiHomeRoot(), not sthayiHome(): once the validator above establishes a canonical root,
    // every path doctor reports on and reads from follows THAT root. The fallback only applies to
    // an absent home, where the two are the same string and nothing is read at all.
    home = assertReadOnlySthayiHome() ?? sthayiHomeRoot();
  } catch (err) {
    checks.push({
      name: 'Home directory',
      ok: false,
      detail: errMsg(err),
      fix: 'repair or remove the planted path, then re-run `sthayi doctor` — nothing was read through it and nothing was modified',
    });
    return checks;
  }

  // Pending HTTP-token rotation (read-only, non-secret — the value is never printed): only
  // present when a legacy unprefixed ~/.sthayi/http-token exists.
  const tokenWarning = legacyHttpTokenWarning(home);
  if (tokenWarning !== undefined) {
    checks.push({
      name: 'HTTP token',
      ok: false,
      detail: tokenWarning,
      fix: 'start `sthayi serve --http` to rotate it now, then update your HTTP clients with the new token from ~/.sthayi/http-token',
    });
  }

  const db = dbPath();
  const kp = keyPath();
  const dbProbe = presenceNoFollow(db);
  const keyProbe = presenceNoFollow(kp);

  // UNINSPECTABLE STATE STOPS DOCTOR, exactly as an untrusted home does. Every verdict below —
  // "not initialized", "a vault key exists without a store", the store open, the permission bits —
  // is computed FROM these two probes, so a probe that failed makes all of them fiction. The
  // failure is named with its errno and doctor returns: it never guesses, and it never prints the
  // healthy "not initialized" line for a home it could not read.
  let uninspectable = false;
  for (const [name, p, probe] of [
    ['Store', db, dbProbe],
    ['Vault key', kp, keyProbe],
  ] as const) {
    if (probe.state === 'unknown') {
      uninspectable = true;
      checks.push({
        name,
        ok: false,
        detail: `${p} could not be inspected (${probe.code}) — doctor cannot tell whether it exists, and will NOT guess an initialization verdict for a path it never managed to read`,
        fix: `restore access to ${home} and re-run \`sthayi doctor\` (a directory that cannot be searched is the usual cause: \`chmod 700 ${home}\`; a repeating I/O error is a failing disk) — nothing was read or modified`,
      });
    }
  }
  if (uninspectable) {
    return checks;
  }

  const dbExists = dbProbe.state === 'present';
  const keyExists = keyProbe.state === 'present';

  // Per-client wiring is inspected BEFORE the initialization gate: client configs live OUTSIDE
  // ~/.sthayi, so a wiped (or never-restored) home with sthayi wiring still dangling in client
  // configs is a failure state — every wired client errors on the dead launcher — not a healthy
  // "never used Sthayi" machine. Reads only, as everything in doctor.
  const inspections = defaultAdapters().map((a) => {
    const detected = a.detect();
    return { a, detected, inspect: detected ? a.inspect() : undefined };
  });
  const dangling = inspections.filter((i) => i.inspect && i.inspect.state !== 'absent');
  const anyWired = dangling.length > 0;

  // No DB and no key: a machine that has simply never run Sthayi. That is a healthy state, not
  // a failure — and absolutely not a reason to create anything. But ONLY when no client config
  // references a sthayi wiring; otherwise each dangling reference is a failing check.
  if (!dbExists && !keyExists) {
    if (!anyWired) {
      checks.push({
        name: 'Initialization',
        ok: true,
        detail: `not initialized (no store at ${home}) — run \`sthayi init\` when ready`,
      });
      return checks;
    }
    checks.push({
      name: 'Initialization',
      ok: false,
      detail: `not initialized (no store at ${home}) — but client config(s) still reference a sthayi wiring`,
      fix: 'run `sthayi init` (then `sthayi wire`), or remove the stale entries / restore ~/.sthayi from backup',
    });
    for (const { a } of dangling) {
      checks.push({
        name: `Client: ${a.label}`,
        ok: false,
        detail: `wired in ${a.label} (${a.configPath()}) but ${home} is missing — the client will fail to launch sthayi`,
        fix: 'run `sthayi init` (then `sthayi wire`) or remove the entry / restore from backup',
      });
    }
    return checks;
  }

  // Same tri-state discipline for the home itself: an lstat that failed for a reason other than
  // ENOENT is a FAILED check that names the errno, never the "run `sthayi init`" line an absent
  // home earns.
  const homeProbe = presenceNoFollow(home);
  const homePresent = homeProbe.state === 'present';
  checks.push({
    name: 'Home directory',
    ok: homePresent,
    detail:
      homeProbe.state === 'unknown' ? `${home} could not be inspected (${homeProbe.code})` : home,
    fix: homePresent
      ? undefined
      : homeProbe.state === 'absent'
        ? 'run `sthayi init`'
        : `restore access to ${home} (e.g. \`chmod 700 ${home}\`) and re-run \`sthayi doctor\``,
  });

  if (process.platform !== 'win32' && homePresent) {
    // lstat, not statSync: `home` is the canonical root assertReadOnlySthayiHome just proved is a
    // real directory, and the mode doctor prints must be THAT directory's own bits — never a
    // target's, at any point in this function.
    const mode = fs.lstatSync(home).mode & 0o777;
    const ok = (mode & 0o077) === 0;
    checks.push({
      name: 'Home permissions',
      ok,
      detail: `${home} (mode ${mode.toString(8)})`,
      fix: ok ? undefined : `chmod 700 ${home}`,
    });
  }

  // Vault key BEFORE any store access, via fs + loadExisting only — doctor must never take the
  // openStore() path, whose crypto open generates a fresh key when none exists (the exact
  // key-loss-masking failure doctor exists to surface).
  let crypto: NodeCrypto | undefined;
  if (!keyExists) {
    checks.push({
      name: 'Vault key',
      ok: false,
      detail: `absent (${kp}) while the store exists — encrypted entities are unreadable`,
      fix: 'restore ~/.sthayi/key from backup — doctor will NOT generate a new key (a fresh key cannot decrypt existing entities)',
    });
  } else {
    try {
      crypto = NodeCrypto.loadExisting(kp);
      // loadExisting has already refused a symlink/FIFO/foreign-owned key, so this is the real
      // key file — read its bits with lstat regardless, so no reachable line in doctor can be
      // made to report a target's mode by planting a link between the two calls.
      const mode = fs.lstatSync(kp).mode & 0o777;
      const secure = process.platform === 'win32' || mode === 0o600;
      checks.push({
        name: 'Vault key',
        ok: secure,
        detail: `${kp} (mode ${mode.toString(8)})`,
        fix: secure ? undefined : `chmod 600 ${kp}`,
      });
    } catch (err) {
      checks.push({
        name: 'Vault key',
        ok: false,
        detail: errMsg(err),
        fix: 'restore the correct 32-byte ~/.sthayi/key from backup — doctor will NOT generate or overwrite a key',
      });
    }
  }

  if (!dbExists) {
    checks.push({
      name: 'Store',
      ok: false,
      detail: `${db} absent (a vault key exists without a store)`,
      fix: 'run `sthayi init`',
    });
  } else {
    try {
      const store = openStoreReadOnly({ crypto });
      try {
        const version = store.driver.getMeta(SCHEMA_VERSION_KEY);
        const pending = pendingMigrations(Number(version ?? '0')).length;
        checks.push({
          name: 'Store',
          ok: Boolean(version) && pending === 0,
          detail: `schema v${version ?? '?'}${pending > 0 ? ` (${pending} pending migration(s))` : ''} · ${db}`,
          fix:
            Boolean(version) && pending === 0
              ? undefined
              : 'run any store command (e.g. `sthayi journal`) to apply migrations — doctor never migrates',
        });
        const chain = store.journal.verify();
        checks.push({
          name: 'Journal integrity',
          ok: chain.ok,
          detail: chain.ok
            ? `${chain.length} entries, chain intact${chain.state === 'checkpoint-disabled' ? ' (checkpoint unverified — key unavailable)' : ''}`
            : chain.brokenAt !== undefined
              ? `TAMPER at #${chain.brokenAt}: ${chain.reason}`
              : (chain.reason ?? 'verification failed'),
          fix: chain.ok ? undefined : 'do not consolidate until investigated',
        });
        // Encrypted-entity health: decrypt EVERY encrypted entity with the loaded key (the
        // "doctor said all-clear while `sthayi entities` failed" gap — a 3-entity sample missed
        // corruption in entity #4). Entity counts are small by design (one row per distinct
        // vaulted secret), so the full sweep is cheap; the loop still exits on the first failure,
        // since one bad ciphertext already fails the check. In-memory only.
        if (crypto) {
          const encrypted = store.driver.listEntities().filter((e) => e.valueEnc);
          if (encrypted.length > 0) {
            let decryptError: string | undefined;
            try {
              for (const e of encrypted) {
                crypto.decrypt(e.valueEnc as Uint8Array);
              }
            } catch {
              decryptError =
                'key does not decrypt stored entities (wrong or rotated key, or corrupt ciphertext)';
            }
            checks.push({
              name: 'Entity decryption',
              ok: decryptError === undefined,
              detail: decryptError ?? `all ${encrypted.length} encrypted entity(ies) decrypt OK`,
              fix:
                decryptError === undefined
                  ? undefined
                  : 'restore the matching ~/.sthayi/key from backup — doctor will NOT rewrite entities',
            });
          }
        }
      } finally {
        store.close();
      }
    } catch (err) {
      checks.push(storeOpenFailureCheck(err));
    }

    if (process.platform !== 'win32') {
      // The db was REFUSED as a symlink two checks above — and then `fs.statSync` FOLLOWED that
      // very link to produce this line, so doctor printed the permission bits of a file outside
      // the home (`<home>/sthayi.db (mode 646)`) and told the user to chmod it. A path that is not
      // safe to open is not safe to describe either: it is named as untrusted, and NO mode is
      // read through it. Only a validated regular file gets its own bits reported.
      const reason = untrustedFileReason(db, 'memory database', { modePolicy: 'ignore' });
      let st: fs.Stats | undefined;
      if (reason === undefined) {
        try {
          st = fs.lstatSync(db);
        } catch {
          st = undefined; // raced away between the gate and here
        }
      }
      if (reason !== undefined || st === undefined) {
        checks.push({
          name: 'Store file permissions',
          ok: false,
          detail: reason ?? `${db} disappeared while doctor was inspecting it`,
          fix: 'remove whatever is planted at that path and restore ~/.sthayi/sthayi.db from backup — no permissions were read through it',
        });
      } else {
        const mode = st.mode & 0o777;
        const ok = (mode & 0o077) === 0;
        checks.push({
          name: 'Store file permissions',
          ok,
          detail: `${db} (mode ${mode.toString(8)})`,
          fix: ok ? undefined : `chmod 600 ${db}`,
        });
      }
    }
  }

  // The per-client inspections (hoisted above the initialization gate) let the launcher check
  // distinguish "missing but nothing references it" (fine) from "missing while clients point at
  // it" (broken).
  const lh = launcherHealth();
  if (lh.state === 'missing') {
    checks.push({
      name: 'Launcher',
      ok: !anyWired,
      detail: anyWired
        ? `${lh.detail} — but client config(s) reference a sthayi wiring`
        : `${lh.detail} (created by \`sthayi init\` / \`sthayi wire\`)`,
      fix: anyWired ? 'run `sthayi wire`' : undefined,
    });
  } else {
    checks.push({
      name: 'Launcher',
      ok: lh.ok,
      detail: lh.detail,
      fix: lh.ok ? undefined : 'remove the launcher file and re-run `sthayi wire`',
    });
  }

  for (const { a, detected, inspect } of inspections) {
    const state = inspect?.state;
    checks.push({
      name: `Client: ${a.label}`,
      ok: state !== 'broken', // broken wiring is a real failure; the rest informational
      detail: !detected
        ? 'not installed'
        : state === 'wired'
          ? 'detected, wired'
          : state === 'broken'
            ? `detected, sthayi entry broken${inspect?.detail ? ` — ${inspect.detail}` : ''}`
            : 'detected, not wired',
      fix:
        state === 'broken'
          ? `sthayi wire --client ${a.id}`
          : detected && state === 'absent'
            ? `sthayi wire --client ${a.id}`
            : undefined,
    });
  }

  return checks;
}
