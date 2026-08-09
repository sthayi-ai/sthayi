import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { relativeEscapes, safeReadTextFile } from '../fs-safe.js';
import {
  assertReadOnlySthayiHome,
  binDir,
  ensureSthayiHome,
  launcherPath,
  sthayiHomeRoot,
} from '../paths.js';

/** The command clients should invoke — the platform-appropriate launcher path under the
 *  ESTABLISHED CANONICAL home root (spec §1 invariant 7: absolute realpath, always), with the
 *  launcher filename joined onto it. It reads the canonical root rather than realpathing the
 *  logical STHAYI_HOME string: a home reached through a symlink is REFUSED outright now, so
 *  there is nothing left to canonicalize, and re-resolving the logical string would be exactly
 *  the re-follow that a retargeted ancestor exploits. The launcher FILE itself is never
 *  realpathed — an attacker-planted symlink at the launcher path must never steer client configs
 *  to its target. */
export function launcherCommand(): string {
  const p = path.join(sthayiHomeRoot(), 'bin', 'sthayi-mcp');
  return process.platform === 'win32' ? `${p}.cmd` : p;
}

/**
 * The characters a path may not carry into a generated launcher: inside the double-quoted launcher
 * these EXPAND or break quoting at every client launch (command substitution, variable expansion).
 * Real install paths never contain them.
 *
 * THE PLATFORM IS A PARAMETER, not a read of `process.platform`. This is the writer's policy, and
 * the health check has to apply the very same rule to a launcher it did not write — including the
 * Windows rule, which a POSIX test run must be able to exercise. A policy only one platform can
 * assert is a policy only one platform keeps.
 */
function launcherUnsafeChars(platform: NodeJS.Platform): RegExp {
  return platform === 'win32' ? /["%\r\n]/ : /["$`\\\r\n]/;
}

/** Refuse to bake a path into the generated launcher if it carries those metacharacters. */
function assertLauncherSafe(p: string, platform: NodeJS.Platform = process.platform): void {
  if (launcherUnsafeChars(platform).test(p)) {
    throw new Error(
      `refusing to write launcher: path contains characters unsafe for the generated launcher script: ${JSON.stringify(p)}`,
    );
  }
}

/** Absolute path to the CLI entry this process is running from. */
function resolveCliEntry(): string {
  const argv1 = process.argv[1];
  if (argv1) {
    try {
      return fs.realpathSync(argv1);
    } catch {
      return argv1;
    }
  }
  return 'sthayi';
}

function hasSegment(p: string, segment: string): boolean {
  return p.split(/[\\/]/).includes(segment);
}

function isUnder(p: string, dir: string): boolean {
  const rel = path.relative(dir, p);
  return rel !== '' && !relativeEscapes(rel);
}

function realpathOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Durability check: would this path stop existing when npm's caches are pruned? `npx sthayi` runs from
 * `.../_npx/<hash>/node_modules/...` inside the npm cache — pinning the launcher there produces
 * MODULE_NOT_FOUND as soon as the cache is cleaned.
 *
 * WHAT THIS DOES *NOT* REQUIRE: a GLOBAL install. Only three shapes are ephemeral — an
 * `_npx`/`_cacache` path segment, anything under the system temp dir, and anything under
 * `npm_config_cache`. Every other location is durable and is pinned exactly where it stands, so a
 * `npm i --engine-strict sthayi@latest` after the same preflight in a directory the user keeps
 * qualifies just as well as `npm install -g`.
 * Anything under the Sthayi home is OURS and durable by definition, even when STHAYI_HOME itself
 * sits under a temp dir (tests).
 */
export function isEphemeralPath(p: string): boolean {
  // Both literal and resolved forms on each side: a nonexistent path cannot be realpathed, yet
  // its BOUNDARY dir usually can (macOS: /var/folders vs /private/var/folders).
  const candidates = [...new Set([p, realpathOr(p)])];
  const underAny = (dir: string): boolean => {
    const dirs = [...new Set([dir, realpathOr(dir)])];
    return candidates.some((c) => dirs.some((d) => isUnder(c, d)));
  };
  // EVERY form, not merely one of them — an UNRESOLVED spelling never gets to overrule a RESOLVED
  // escape. "Anything under the home is ours" is a statement about a place, and a path that is
  // lexically beneath STHAYI_HOME while it RESOLVES outside is not that place: a link planted
  // inside the runtime tree would otherwise wear the home's durability while pointing anywhere.
  // A resolved escape therefore falls through to the ephemerality checks below instead of being
  // waved through as durable.
  const underAll = (dir: string): boolean => {
    const dirs = [...new Set([dir, realpathOr(dir)])];
    return candidates.every((c) => dirs.some((d) => isUnder(c, d)));
  };
  // The ESTABLISHED canonical root, never the logical STHAYI_HOME string: "is this path ours?"
  // must be answered against the directory that was validated, or a retargeted ancestor could
  // make an external path look durable (or make a path inside the home look ephemeral).
  if (underAll(sthayiHomeRoot())) {
    return false;
  }
  if (candidates.some((c) => hasSegment(c, '_npx') || hasSegment(c, '_cacache'))) {
    return true;
  }
  if (underAny(os.tmpdir())) {
    return true;
  }
  const npmCache = process.env.npm_config_cache;
  if (npmCache && underAny(npmCache)) {
    return true;
  }
  return false;
}

export interface LauncherPlan {
  /** launcher file path (`.cmd` on Windows) */
  path: string;
  /** full script body */
  content: string;
  mode: number;
  /** pinned node runtime */
  node: string;
  /** CLI entry the script references — always a durable path (an ephemeral one is refused) */
  entry: string;
}

/**
 * npm's global install prefix as this machine reports it, or undefined when it cannot be read.
 *
 * READ ONLY, AND NEVER A PACKAGE MANAGER RUN. No subprocess is spawned at all — not even
 * `npm config get prefix`. Invoking npm from inside a refusal would let a tool this code does not
 * control write into the user's home (npm materialises `~/.npm`, `~/.npmrc` and a log directory on
 * ordinary invocations) at the exact moment Sthayi is promising it wrote nothing. The prefix is
 * read from the three places that hold it instead, in the order npm itself resolves them:
 *
 *   1. `npm_config_prefix`, which npm exports into any process it starts;
 *   2. `prefix=` in the user's `~/.npmrc` — where `npm config set prefix` puts it;
 *   3. otherwise npm's default, which is derived from where this very node binary lives
 *      (`<prefix>/bin/node` on POSIX, `<prefix>\node.exe` on Windows).
 *
 * Every failure returns undefined, and the caller then prints all routes rather than a claim about
 * a machine it could not inspect.
 */
function npmGlobalPrefix(): string | undefined {
  const fromEnv = process.env.npm_config_prefix;
  if (fromEnv && path.isAbsolute(fromEnv)) {
    return fromEnv;
  }
  try {
    const npmrc = safeReadTextFile(path.join(os.homedir(), '.npmrc'), 'npmrc', {
      maxBytes: 64 * 1024,
    });
    const configured = npmrc === undefined ? undefined : /^\s*prefix\s*=\s*(.+?)\s*$/m.exec(npmrc);
    const value = configured?.[1]?.replace(/^["']|["']$/g, '');
    if (value && path.isAbsolute(value)) {
      return value;
    }
  } catch {
    // unreadable or untrusted npmrc — fall through to the default; this is advisory text, and the
    // file's contents are never acted on, only read to name a directory back to the user
  }
  const derived =
    process.platform === 'win32'
      ? path.dirname(process.execPath)
      : path.dirname(path.dirname(process.execPath));
  return path.isAbsolute(derived) && derived !== path.dirname(derived) ? derived : undefined;
}

/**
 * The access an install needs on the directory it will create entries INSIDE — write AND
 * execute/search, not write alone.
 *
 * `W_OK` ALONE IS THE WRONG QUESTION, and the failure is not exotic. On POSIX, creating, renaming or
 * removing an entry in a directory requires the WRITE bit *and* the EXECUTE (search) bit: write says
 * the directory listing may be modified, search says a name inside it may be resolved at all, and
 * the create needs both. A directory at mode 0200 — write, no execute — therefore answers YES to
 * `access(W_OK)` while every `open(…, O_CREAT)` under it fails EACCES. Asking only about write
 * prints "your account can write it" about a prefix where the install cannot place a single file,
 * and that sentence is the one a reader acts on.
 *
 * ON WINDOWS THE EXECUTE BIT IS NOT A THING `access` ANSWERS. Node documents `X_OK` as having no
 * effect there — it degrades to a plain existence check — so requiring it would neither add a
 * guarantee nor cost one. It is left off rather than folded in silently, so the POSIX rule reads as
 * the POSIX rule it is. (The Windows layout is a separate question; see globalPrefixWritable.)
 */
function requiredAccess(platform: NodeJS.Platform): number {
  // the access() mode argument is a bit mask: write AND search, both, on POSIX
  return platform === 'win32' ? fs.constants.W_OK : fs.constants.W_OK | fs.constants.X_OK;
}

/** `dest` and every ancestor above it, ROOT FIRST — the order npm would have to create them in. */
function destinationChain(dest: string): string[] {
  const chain: string[] = [];
  for (let p = path.resolve(dest); ; p = path.dirname(p)) {
    chain.push(p);
    if (path.dirname(p) === p) {
      break;
    }
  }
  return chain.reverse();
}

/**
 * Could npm write this one destination — or create it?
 *
 * EVERY COMPONENT THAT EXISTS HAS TO BE A DIRECTORY. `access(W_OK)` answers "may this account write
 * this object", and that is not the question being asked: npm has to CREATE ENTRIES INSIDE each of
 * these names, so a writable REGULAR FILE at `<prefix>/bin` answers yes to W_OK while the install
 * cannot begin — and "your account can write it" is the sentence a reader acts on. A component of
 * any other kind means the install cannot happen there, whatever its mode says.
 *
 * KIND IS RESOLVED, NOT REFUSED, AND THIS IS THE ONE PLACE THAT IS RIGHT. Everywhere Sthayi AIMS A
 * SYSCALL through a name, a symlink standing at it is refused rather than followed (untrustedDirReason).
 * Nothing is aimed anywhere here: this is a read-only statement about a prefix npm owns, and the
 * question is what NPM would find. npm installs perfectly well through a symlinked destination, so
 * refusing one would print the opposite false sentence — "your account cannot write it" about a
 * prefix where the install completes. The link is therefore followed FOR ITS KIND, and a link whose
 * target is not a directory, or is not there at all, is not a destination: the name is occupied, so
 * npm's own `mkdir` fails on it.
 *
 * AN ABSENT COMPONENT IS NOT A REFUSAL. It is where npm starts creating, so the question moves to
 * the deepest ancestor that does exist — which must itself be a writable directory. Anything other
 * than ENOENT on the way down is a refusal rather than a reason to keep going.
 */
function destinationWritable(dest: string, platform: NodeJS.Platform): boolean {
  let deepestExisting: string | undefined;
  for (const component of destinationChain(dest)) {
    let st: fs.Stats;
    try {
      st = fs.statSync(component); // follows: the kind npm would find, not the kind of the name
    } catch (err) {
      if (errCode(err) !== 'ENOENT') {
        return false;
      }
      // Absent — and so is everything below it. A DANGLING LINK is not absent: `lstat` still finds
      // an entry, and npm's `mkdir` on an occupied name fails.
      if (fs.lstatSync(component, { throwIfNoEntry: false }) !== undefined) {
        return false;
      }
      break;
    }
    if (!st.isDirectory()) {
      return false;
    }
    deepestExisting = component;
  }
  if (deepestExisting === undefined) {
    return false; // not even the filesystem root answered
  }
  try {
    fs.accessSync(deepestExisting, requiredAccess(platform));
    return true;
  } catch {
    return false;
  }
}

/**
 * Could a global install actually finish there? EVERY DESTINATION npm needs, not the first one that
 * happens to answer.
 *
 * A global install writes in two places: the package is unpacked under `<prefix>/lib/node_modules`
 * and the command shim is written to `<prefix>/bin`. A prefix that grants one and refuses the other
 * fails partway through, so a probe that stops at the first writable destination reports "your
 * account can write it" about a prefix where the install cannot complete — and that sentence is the
 * one a reader acts on. Both must be writable, or creatable in a directory that is — and both must
 * be DIRECTORIES where they already exist, which is the other half of the same sentence being true
 * (see destinationWritable).
 *
 * WINDOWS HAS A DIFFERENT LAYOUT, NOT A SHORTER QUESTION. By npm's own design the shims land
 * directly in `<prefix>\` and the package under `<prefix>\node_modules` — two destinations, spelled
 * differently from the POSIX pair. Asking only about the prefix answers for the shims and says
 * nothing about the package: an entry ALREADY STANDING at `<prefix>\node_modules` that is not a
 * directory — a regular file, a link to one, a dangling link — occupies the name npm has to create
 * or unpack into, so the install cannot finish while the prefix itself reads perfectly writable.
 * That is the same wrong-kind failure the POSIX side already refuses (see destinationWritable), and
 * it is checked the same way rather than assumed away.
 *
 * THE PLATFORM IS A PARAMETER, for the reason it is one in assertLauncherSafe and
 * ephemeralEntryRefusal: a rule only one platform can evaluate is a rule only one platform can
 * check, and Windows is the platform this suite is least likely to be running on. NO WINDOWS HOST
 * VALIDATES THIS. The rows that exercise the Windows branch run on POSIX and assert what the branch
 * DECIDES, never that a Windows install was observed — the layout stays designed and unvalidated
 * until hosted Windows CI executes it.
 */
function globalPrefixWritable(prefix: string, platform: NodeJS.Platform): boolean {
  const destinations =
    platform === 'win32'
      ? [prefix, path.join(prefix, 'node_modules')]
      : [path.join(prefix, 'lib', 'node_modules'), path.join(prefix, 'bin')];
  return destinations.every((dest) => destinationWritable(dest, platform));
}

/**
 * The install route, per SHELL, as one line that runs from start to finish.
 *
 * PREFLIGHT BEFORE RESOLUTION. A bare package name lets npm choose an older release whose engines
 * admit the active runtime. Every copied route therefore rejects unsupported Node majors before
 * npm runs, requests `sthayi@latest` explicitly, and enables per-invocation `--engine-strict`.
 *
 * A SCOPED PREFIX, ALWAYS — never a bare `npm install -g sthayi`. That form installs into whatever
 * npm's configured global prefix happens to be, and on a machine where that prefix is root-owned it
 * fails outright (EACCES) — so presenting it as the universal answer hands half the world a command
 * that cannot work and no way to tell in advance. `--prefix` is a PER-INVOCATION flag: it scopes
 * this one install into a directory the user certainly owns and leaves their npm configuration
 * exactly as it was (no `~/.npmrc` is written), which makes one line correct in both cases.
 *
 * EVERY COMMAND RUNS AS TYPED, INCLUDING THE PART THAT INVOKES STHAYI. Naming an install and then
 * saying "now run `sthayi init`" is a route that stops at its last step: the shim lands under the
 * prefix that was just named, and it is not on PATH yet. Each route therefore ends in the exact
 * invocation that route produces.
 *
 * ONE SHELL PER LINE, NEVER MIXED. PowerShell 5.1 has no `&&`, and `cmd` expands `%LOCALAPPDATA%`
 * where PowerShell expands `$env:LOCALAPPDATA` — a single "Windows" line is wrong in at least one
 * of the three shells a Windows user is likely to be standing in.
 *
 * AND THE SECOND HALF NEVER RUNS AFTER A FAILED INSTALL. `&&` gives that ordering for free; the
 * shell without `&&` gets it from an explicit check, because `;` sequences UNCONDITIONALLY. Left
 * ungated, a failed install is followed by an invocation of whatever stands at the shim path — on a
 * prefix an install has been attempted at before, a shim from that attempt, pinned at an entry this
 * failed install never refreshed. The user sees the install error, then a command that appears to
 * have worked.
 *
 * AND THE 5.1 GATE READS BOTH SIGNALS, BECAUSE THE EXIT CODE ALONE HAS A HOLE THE ORDINARY FAILURE
 * FALLS STRAIGHT INTO. `$LASTEXITCODE` is written by NATIVE COMMANDS. An `npm` that cannot be
 * RESOLVED never runs one: PowerShell raises CommandNotFoundException and that variable keeps
 * whatever value the session already held — 0, in any session where something succeeded earlier. An
 * `if ($LASTEXITCODE -eq 0)` gate then passes on a stale zero and runs the init half after an
 * install that did not happen at all. `$?` is the signal that failure does set, and it describes the
 * statement that just ran and only that one, so it is CAPTURED IMMEDIATELY (`$ok = $?`, on the heels
 * of the install) and the condition requires BOTH. `&&` in PowerShell 7 and `cmd` already carries
 * the same requirement, which is why only the 5.1 line spells it out.
 *
 * THESE LINES ARE DESIGNED, NOT EXERCISED. No Windows host runs them here, and nothing in this
 * repository is evidence that one has (the sequencing tests evaluate the STRINGS against the shells'
 * documented rules). They stay designed and unvalidated until hosted Windows CI executes them.
 */
interface InstallRoute {
  /** The shell this line is for, printed above it; empty where the platform has only one. */
  shell: string;
  command: string;
}

const NODE_PREFLIGHT =
  "node -e \"const m=Number(process.versions.node.split('.')[0]);if(m===22||m===24){}else{console.error('Sthayi requires Node.js 22 or 24 (24 LTS recommended). Detected '+process.version+'. Install Node.js 24 LTS: https://nodejs.org/en/download');process.exit(1)}\"";

/** The one-clause form of the scoped install, for messages with no room for a command block. */
const DURABLE_INSTALL_HINT =
  '`npm install -g --prefix "$HOME/.local" --engine-strict sthayi@latest` on macOS/Linux, or the equivalent for your shell in README.md';

const INSTALL_ROUTES: { posix: InstallRoute[]; win32: InstallRoute[] } = {
  posix: [
    {
      shell: '',
      command: `${NODE_PREFLIGHT} && npm install -g --prefix "$HOME/.local" --engine-strict sthayi@latest && "$HOME/.local/bin/sthayi" init`,
    },
  ],
  win32: [
    {
      shell: 'PowerShell 7:',
      command: `${NODE_PREFLIGHT} && npm install -g --prefix "$env:LOCALAPPDATA\\sthayi" --engine-strict sthayi@latest && & "$env:LOCALAPPDATA\\sthayi\\sthayi.cmd" init`,
    },
    {
      shell:
        'PowerShell 5.1 (no `&&` in 5.1 — the install’s success state and exit code are checked instead):',
      command: `${NODE_PREFLIGHT}; $nodeOk = $?; if ($nodeOk -and $LASTEXITCODE -eq 0) { npm install -g --prefix "$env:LOCALAPPDATA\\sthayi" --engine-strict sthayi@latest; $installOk = $?; if ($installOk -and $LASTEXITCODE -eq 0) { & "$env:LOCALAPPDATA\\sthayi\\sthayi.cmd" init } }`,
    },
    {
      shell: 'cmd:',
      command: `${NODE_PREFLIGHT} && npm install -g --prefix "%LOCALAPPDATA%\\sthayi" --engine-strict sthayi@latest && "%LOCALAPPDATA%\\sthayi\\sthayi.cmd" init`,
    },
  ],
};

/**
 * The refusal an ephemeral CLI entry earns, naming the fix in the terminal the user is already
 * looking at.
 *
 * THE CURRENT PLATFORM'S ROUTE, AND NOTHING ELSE. Four commands with no indication of which one
 * applies is three wrong answers and a puzzle; a POSIX user is shown the POSIX line, and a Windows
 * user the shells Windows actually has.
 *
 * STILL SITUATION-AWARE, BUT NO LONGER AS A CHOICE. npm's prefix is read (never run — see
 * npmGlobalPrefix) and tested for writability, and what that answers is now a STATEMENT about this
 * machine rather than a branch between routes: the scoped install above is correct whether the
 * global prefix is writable, unwritable, or unreadable, so it is what is printed either way and the
 * probe only explains why it does not depend on the prefix at all. Where the prefix cannot be read,
 * nothing is claimed about the machine.
 *
 * NO ELEVATION, IN ANY BRANCH. The requirement is a DURABLE install location, never a global or a
 * privileged one (see isEphemeralPath), and no form of privilege escalation is named anywhere here.
 *
 * THE PLATFORM IS A PARAMETER, for the same reason it is one in assertLauncherSafe: text only one
 * platform can produce is text only one platform can check.
 */
export function ephemeralEntryRefusal(
  entry: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const routes = platform === 'win32' ? INSTALL_ROUTES.win32 : INSTALL_ROUTES.posix;
  const lines = [
    `refusing to write a launcher pinned to ${entry}: that path lives in an npm/npx cache or a temp`,
    'directory and disappears when the cache is pruned, which would break every client launch.',
    'Install sthayi somewhere durable — one line, no elevated privileges:',
  ];
  for (const route of routes) {
    if (route.shell !== '') {
      lines.push(route.shell);
    }
    lines.push(`  ${route.command}`);
  }
  lines.push(
    '`--prefix` applies to that one command and does not change your npm configuration. The package',
    platform === 'win32'
      ? 'and its shim land under the directory named there; your memory stays in the sthayi home, and'
      : 'lands in ~/.local/lib/node_modules/sthayi and the shim in ~/.local/bin; your memory stays in',
    platform === 'win32'
      ? 'the install survives `npm cache clean --force`.'
      : '~/.sthayi, and the install survives `npm cache clean --force`.',
  );

  const prefix = npmGlobalPrefix();
  if (prefix === undefined) {
    lines.push(
      "npm's own global prefix could not be read here, which is one more reason the line above",
      'names its own.',
    );
  } else if (globalPrefixWritable(prefix, platform)) {
    lines.push(
      `npm's own global prefix here is ${prefix} and your account can write it; the line above stays`,
      'out of it anyway, so the same command keeps working on machines where that is not true.',
    );
  } else {
    lines.push(
      `npm's own global prefix here is ${prefix}, which your account cannot write — an unscoped`,
      'global install would fail there. The line above never touches it.',
    );
  }
  lines.push('README.md ("Quickstart") covers the rest.');
  return lines.join('\n');
}

/** 'mcp' — `bin/sthayi-mcp`, forces `serve` (what client configs invoke);
 *  'cli' — `bin/sthayi`, the durable general CLI the README documents, so `sthayi <command>` works
 *  without the package being on PATH. */
export type LauncherVariant = 'mcp' | 'cli';

/** Platform-final path of the general CLI launcher (`~/.sthayi/bin/sthayi`). */
export function cliLauncherPath(): string {
  const p = path.join(binDir(), 'sthayi');
  return process.platform === 'win32' ? `${p}.cmd` : p;
}

function runtimeRoot(): string {
  return path.join(sthayiHomeRoot(), 'runtime');
}

/** A launcher script is a few hundred bytes of generated shell; 64 KiB is already absurd for one.
 *  The cap is what stops a launcher path swapped for a huge file from being buffered whole. */
export const LAUNCHER_READ_CAP_BYTES = 64 * 1024;

/**
 * The ONE way Sthayi reads a launcher file — the dry-run's create/update/unchanged decision and
 * the doctor/status diagnosis both go through it.
 *
 * Why it is not a `readFileSync` in a try/catch: that shape follows a symlinked launcher (an
 * outside target with identical bytes then reads as "unchanged" — a hijack rendered as health),
 * BLOCKS on a FIFO, reads a hard-linked or oversize file whole, and collapses every one of those
 * failures into "the launcher is absent, create it". This is the capped O_NOFOLLOW descriptor
 * reader with the lstat+fstat double check, so `undefined` means GENUINE ABSENCE and nothing else;
 * every unsafe state THROWS and the caller must propagate it as a refusal.
 */
export function readLauncherBody(p: string): string | undefined {
  return safeReadTextFile(p, 'launcher', { maxBytes: LAUNCHER_READ_CAP_BYTES });
}

/** Script body with a node fallback: the pinned execPath if it still exists, else `node` from
 *  PATH, else exit 127 with an actionable message (a launcher must not die just
 *  because the node that wrote it was upgraded away). `serve: true` is the MCP launcher
 *  (forced `serve` arg, spec §1 invariant 7); `serve: false` is the general CLI launcher —
 *  identical fallback + durable entry, dispatching straight to `sthayi <command>`. */
export function launcherScriptBody(
  node: string,
  entry: string,
  serve: boolean,
  platform: NodeJS.Platform = process.platform,
): string {
  const label = serve ? 'sthayi-mcp' : 'sthayi';
  const forced = serve ? ' serve' : '';
  if (platform === 'win32') {
    return [
      '@echo off',
      'rem sthayi launcher - generated by sthayi init/wire; clients invoke this, never raw npx.',
      `set "NODE=${node}"`,
      'if exist "%NODE%" goto run',
      'where node >nul 2>nul',
      'if errorlevel 1 (',
      `  echo ${label}: no usable Node runtime: pinned ${node} is gone and no node on PATH 1>&2`,
      '  exit /b 127',
      ')',
      'set "NODE=node"',
      ':run',
      `"%NODE%" "${entry}"${forced} %*`,
      '',
    ].join('\r\n');
  }
  return [
    '#!/usr/bin/env bash',
    '# sthayi launcher — generated by `sthayi init`/`sthayi wire`; clients invoke this, never raw npx.',
    `NODE="${node}"`,
    'if [ ! -x "$NODE" ]; then',
    '  NODE="$(command -v node || true)"',
    'fi',
    'if [ -z "$NODE" ]; then',
    `  echo "${label}: no usable Node runtime: pinned ${node} is gone and no 'node' on PATH" >&2`,
    '  exit 127',
    'fi',
    `exec "$NODE" "${entry}"${forced} "$@"`,
    '',
  ].join('\n');
}

/**
 * Pure planning half of the launcher write (true dry-runs consume this): computes the launcher
 * path and script content. Reads the filesystem, never writes it.
 *
 * AN EPHEMERAL ENTRY IS REFUSED HERE, AT PLAN TIME. A launcher pinned into an npm/npx cache breaks
 * the moment that cache is pruned. Sthayi does not answer that by copying the cached tree into the
 * user's home: a tree taken out of an unpacked tarball, pinned under `~/.sthayi`, and executed by
 * Node on every client launch is persistent code execution, so there is no such copy to guard —
 * the refusal is the whole mechanism. Refusing in the PLAN is what makes `--dry-run` refuse too:
 * a dry run that described a write the real run cannot perform would be describing a fiction.
 */
export function renderLauncher(
  opts: { cliEntry?: string; node?: string; variant?: LauncherVariant } = {},
): LauncherPlan {
  const variant = opts.variant ?? 'mcp';
  const node = opts.node ?? process.execPath;
  const entry = opts.cliEntry ?? resolveCliEntry();

  if (isEphemeralPath(entry)) {
    throw new Error(ephemeralEntryRefusal(entry));
  }

  assertLauncherSafe(node);
  assertLauncherSafe(entry);
  const p =
    variant === 'cli'
      ? cliLauncherPath()
      : process.platform === 'win32'
        ? `${launcherPath()}.cmd`
        : launcherPath();
  return {
    path: p,
    content: launcherScriptBody(node, entry, variant === 'mcp'),
    mode: 0o755,
    node,
    entry,
  };
}

/**
 * POSIX trust rules for a DIRECTORY the launcher write acts inside (`~/.sthayi/bin`): a real,
 * owner-controlled directory, judged as itself. lstat, never stat — a symlink standing at the name
 * is refused rather than resolved, so the write is never aimed through one.
 *
 * Permission bits are NOT policed: `bin/` is created under the caller's umask inside a 0700 home
 * that already excludes other users, and refusing a 0775 one would break installs made under a
 * umask of 002 without excluding anybody the home does not already exclude.
 *
 * "The home already excludes other users" is a claim about the uid-and-mode-bit model, and holds
 * only where those two fields are what decides who may write. An EXTENDED ACL (macOS `chmod +a`,
 * Linux `setfacl`) can grant another user write on a home whose owner and mode read as a private
 * 0700 one, and on a NETWORK FILESYSTEM the server's identity mapping or a mount-wide uid override
 * decides instead — so there the home excludes whoever that mechanism does not. Neither case is
 * detected and neither is warned about; SECURITY.md states that scope in full.
 */
function untrustedDirReason(st: fs.Stats, p: string): string | undefined {
  if (st.isSymbolicLink()) {
    return `${p} is a symlink (possible hijack) — the launcher directory is never resolved through one`;
  }
  if (!st.isDirectory()) {
    return `${p} is not a real directory`;
  }
  if (process.platform !== 'win32') {
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
      return `${p} is owned by uid ${st.uid}, not you`;
    }
  }
  return undefined;
}

function errCode(err: unknown): string {
  return (err as NodeJS.ErrnoException).code ?? 'unknown error';
}

/**
 * A directory AS PROVED: the path it was reached by, plus the directory that path denoted at the
 * moment it was proved. Every create, write, rename and unlink below takes one of these, never a
 * path string. A pathname is not an identity — it says nothing about which directory it will name
 * one instruction later, and that gap is exactly what a syscall must not be aimed through.
 */
interface BoundDir {
  canonical: string;
  dev: number;
  ino: number;
  /**
   * A SINGLE PATH COMPONENT to enter this directory by, valid only while the directory that
   * contains it is the one currently held. A child entered this way cannot be steered by anything
   * above it: there is no ancestor left in the name for a substitution to re-resolve. Absent, the
   * canonical absolute path is used — the only honest option for the outermost directory, which by
   * definition has no held parent to be named from.
   */
  enterBy?: string;
}

/**
 * ACT INSIDE A DIRECTORY THAT HAS BEEN PROVED — the one thing the launcher write depends on.
 *
 * THE ARGUMENT THIS MODULE RESTS ON, stated once here and referred to everywhere else. `mkdir`,
 * `open`, `readdir`, `unlink`, `rmdir` and `rename` resolve every component of the path they are
 * handed INSIDE the call. A directory proved an instruction earlier is therefore not the directory
 * they act in: the name is free to lead somewhere else by then, and the syscall lands wherever it
 * now leads. Binding an operation to a proved directory is what the `*at` syscalls are for, and
 * Node exposes none of them — so a preceding pathname check is not a licence to act, and nothing
 * here treats it as one.
 *
 * What Node DOES expose is the process working directory, and that is a bound reference rather than
 * a name: `chdir` resolves the path once and the kernel then holds the DIRECTORY. A relative name
 * resolved afterwards starts from the held directory even if every path that used to lead there has
 * been renamed, deleted, or replaced by a link, and `lstat('.')` reads that HELD directory — so the
 * identity check has no window after it. Callers pass SINGLE PATH COMPONENTS from here on: a name
 * with no directory part is a name with nothing for a substituted ancestor to re-resolve. That
 * applies to ENTERING a directory too (`BoundDir.enterBy`), so a nested bind descends one component
 * at a time from a directory already held rather than re-walking an absolute path.
 *
 * PLATFORM AND CONTEXT SCOPE, stated rather than assumed:
 *   - the device/inode comparison is POSIX. On Windows the working directory is a path string, so
 *     the guarantee there degrades to the path-based discipline this module already documents;
 *   - `process.chdir` does not exist inside a worker thread. There is no fallback: the directory
 *     cannot be bound, so the caller REFUSES and LEAKS. An entry left on disk is recoverable; a
 *     foreign file removed through a substituted name is not;
 *   - WHO can be in the race is a question about the uid-and-mode-bit model, and every statement
 *     here that a peer is excluded is made within it. An extended ACL or a network filesystem
 *     decides access by something this module never reads, and portable Node exposes nothing to
 *     read it with, so neither is detected here (SECURITY.md carries the full scope statement).
 *
 * Everything between the chdir and the restore is synchronous by construction, so no other work in
 * this process observes the moved working directory.
 *
 * `state` is what each refusal says the filesystem holds afterwards. It is a FUNCTION, evaluated at
 * the moment a refusal is raised rather than composed in advance: what the disk holds is a question
 * only the disk answers, and it can change between the start of the call and the failure. It
 * defaults to the honest answer for a caller that has created nothing yet, and a caller that HAS
 * created or published something passes its own — a refusal is a statement about the disk, and a
 * statement the disk does not match is worse than no statement at all.
 */
function actInsideProvedDir<T>(
  dir: BoundDir,
  refusal: string,
  act: () => T,
  state: () => string = () => 'nothing was touched',
): T {
  if (typeof process.chdir !== 'function') {
    throw new Error(
      `${refusal}: this Node context has no process.chdir (a worker thread), so ${dir.canonical} cannot be bound and a path-based syscall could land outside it — ${state()}`,
    );
  }
  let previous: string | undefined;
  try {
    previous = process.cwd();
  } catch {
    previous = undefined; // the directory this process started in is already gone
  }
  try {
    process.chdir(dir.enterBy ?? dir.canonical);
  } catch (err) {
    throw new Error(
      `${refusal}: ${dir.canonical} could not be entered (${errCode(err)}) — ${state()}`,
    );
  }
  try {
    let st: fs.Stats;
    try {
      st = fs.lstatSync('.');
    } catch (err) {
      throw new Error(
        `${refusal}: the bound directory could not be inspected (${errCode(err)}) — ${state()}`,
      );
    }
    const bound =
      st.isDirectory() &&
      (process.platform === 'win32'
        ? realpathOr('.') === dir.canonical
        : st.dev === dir.dev && st.ino === dir.ino);
    if (!bound) {
      throw new Error(
        `${refusal}: ${dir.canonical} is no longer the directory that was validated (it was replaced, retargeted, or recreated), so nothing could be bound to it — ${state()}`,
      );
    }
    return act();
  } finally {
    if (previous !== undefined) {
      try {
        process.chdir(previous);
      } catch {
        // the directory we started in has gone away; the bound one stays current, which changes
        // nothing here because every path this module uses afterwards is absolute
      }
    }
  }
}

/**
 * Why an entry already standing at a launcher name may NOT be replaced — or undefined when it is an
 * ordinary launcher file this run may overwrite. A regular, owner-controlled, single-link,
 * non-group/world-writable file is the only thing a write is allowed to land on; everything else is
 * a hijack shape, and the link target of a symlinked name is never touched.
 */
function untrustedTargetReason(st: fs.Stats): string | undefined {
  if (st.isSymbolicLink()) {
    return 'it is a symlink (possible hijack; the link target was NOT touched)';
  }
  if (!st.isFile()) {
    return 'it is not a regular file';
  }
  if (process.platform !== 'win32') {
    if (st.nlink > 1) {
      return `it has ${st.nlink} hard links (possible hijack)`;
    }
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
      return `it is owned by uid ${st.uid}, not you`;
    }
    if ((st.mode & 0o022) !== 0) {
      return `it is group/world-writable (mode ${(st.mode & 0o777).toString(8)})`;
    }
  }
  return undefined;
}

/** `lstat` of a single name, with genuine absence separated from every other failure. */
function lstatEntry(name: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(name);
  } catch (err) {
    if (errCode(err) !== 'ENOENT') {
      throw err;
    }
    return undefined;
  }
}

/** A directory identity, as read at one instant. */
interface DirIdentity {
  dev: number;
  ino: number;
}

/**
 * What the `bin/` NAME held at the FIRST read after this run's `mkdir` returned — and it is a
 * three-way answer, not a two-way one.
 *
 * `mkdir` hands back no descriptor, so the only reading available is a fresh look-up of the name,
 * and that look-up can find something that is not a usable directory at all: a peer that removed the
 * new directory and stood a symlink at the name wins that instant, and the FIRST reading is already
 * hostile. Collapsing that into "no identity" and reporting it as a CHANGE says the name held one
 * thing and now holds another, which in that case never happened — there was never a valid reading
 * for it to have changed from. The two outcomes are therefore kept apart at the point they are
 * observed, because nothing downstream can tell them apart afterwards.
 */
type PostCreateReading =
  | { kind: 'identity'; id: DirIdentity }
  /** `because` names what the first reading actually found, for the refusal to state. */
  | { kind: 'untrusted'; because: string };

/**
 * Does the entry standing at `expected` RIGHT NOW still match the reading taken at that name
 * immediately after this run's `mkdir` returned?
 *
 * A STATEMENT ABOUT THE NAME, TWICE OVER, and it is deliberately not the stronger one. `mkdir`
 * hands back no descriptor and portable Node has no `mkdirat`, so the only way to put an identity
 * behind a directory this run created is to look the NAME up again afterwards — and a same-uid peer
 * that moves the new directory aside and stands its own empty 0700 one at the name in that interval
 * supplies that identity instead. Empty is exactly the shape `mkdir` produces, so the substitute
 * passes every freshness leg there is, and no check performed later can separate the two. That is
 * the whole class of post-hoc identification rather than a gap to be narrowed.
 *
 * So this answers the question that IS answerable — has the name changed hands since it was first
 * read? — and the sentence it feeds says exactly that and no more. It is re-read at the moment of
 * the refusal rather than assumed from the creation: what a user will find at that path is a
 * question only the disk answers, and only when it is asked.
 */
function binMatchesPostCreateReading(expected: string, afterCreate: DirIdentity): boolean {
  try {
    const st = fs.lstatSync(expected, { throwIfNoEntry: false });
    return (
      st?.isDirectory() === true &&
      !st.isSymbolicLink() &&
      st.dev === afterCreate.dev &&
      st.ino === afterCreate.ino
    );
  } catch {
    return false; // unreadable is not "unchanged"
  }
}

/**
 * What a refusal says the filesystem holds — assembled from what is on disk at the moment it is
 * asked, never from what an earlier step intended.
 *
 * Two things can be standing there by the time a launcher write refuses: a `bin/` this run created,
 * and launchers this run already published. Both are named.
 *
 * THE `bin/` CLAUSE STATES THE ACT AND THE OBSERVATION, NEVER THE IDENTITY. That this run created a
 * directory at that name is a fact about a call that returned. That the entry there now matches the
 * reading taken just after that call is a fact about two look-ups of a NAME. "The directory this run
 * created is the one standing there" is neither, and it is not available at any price the write can
 * pay: the reading behind it is post-hoc (see binMatchesPostCreateReading), so a substituted
 * directory would supply it and be reported as ours. A refusal that made that claim would send a
 * user to inspect a directory on the strength of something nothing here established — and these
 * messages are printed in exactly the situations where the substitution is the thing that happened.
 */
/**
 * The `bin/` clause of a refusal, as exactly ONE OF THREE STATES — because there are three, and a
 * sentence that covers two of them is false in the third.
 *
 *   (i)   A VALID IDENTITY WAS CAPTURED AND STILL MATCHES. The strongest thing that can honestly be
 *         said, and it is still a statement about a NAME read twice, never about the directory the
 *         create made.
 *   (ii)  A VALID IDENTITY WAS CAPTURED AND LATER CHANGED. Here "it was replaced" is the truth:
 *         there was a reading, and what stands there now is demonstrably not it.
 *   (iii) THE FIRST READING WAS ALREADY UNTRUSTED — missing, a non-directory, a symlink. No identity
 *         was ever captured, so there is nothing for the entry to have changed FROM, and calling
 *         this a replacement asserts a transition that did not occur. This is not a corner: a peer
 *         that removes the new directory and stands its own link at the name lands exactly here, and
 *         these messages are printed in precisely those situations.
 */
function binClause(expected: string, reading: PostCreateReading | undefined): string {
  if (reading === undefined || reading.kind === 'untrusted') {
    const because = reading === undefined ? 'no usable directory' : reading.because;
    return `${expected} was created by this run, and the FIRST reading taken at that name after the create already found ${because} — no directory identity was ever captured there, so what stands at that name is not the directory this run created, nothing of this run's was written into either, and no later reading of it can be reported as a change`;
  }
  return binMatchesPostCreateReading(expected, reading.id)
    ? `${expected} was created by this run before this refusal and nothing here removed it; the entry standing at that name still matches the reading taken there immediately after the create — \`mkdir\` returns no handle, so that reading identifies the NAME and never the directory the create made, and an entry substituted in that instant would read exactly like this one`
    : `${expected} was created by this run, and the entry now standing at that name is not the one read there immediately after the create (it was replaced) — nothing of this run's was written into either`;
}

function launcherWriteState(
  expected: string,
  madeBin: boolean,
  binAfterCreate: PostCreateReading | undefined,
  published: readonly string[],
): string {
  const parts: string[] = [];
  if (madeBin) {
    parts.push(binClause(expected, binAfterCreate));
  }
  if (published.length > 0) {
    parts.push(
      `${published.join(' and ')} ${published.length === 1 ? 'was' : 'were'} written by this run before this refusal and left in place`,
    );
  }
  return parts.length === 0 ? 'nothing was modified' : parts.join('; ');
}

/**
 * ACT INSIDE `<home>/bin`, PROVED AND BOUND — the one place any launcher syscall is aimed from.
 *
 * THE CONTAINMENT CHECK IS NOT WHAT THE WRITE RIDES ON. It states where `bin/` led at the moment it
 * ran; a create, a write, a rename and a failure path's cleanup each resolve that name again,
 * several syscalls later, and a `bin/` swapped for a link in between steers all of them at once —
 * the generated launcher created and renamed OVER an outside file, the cleanup deleting an outside
 * file it never created. So the proved directory is ENTERED and every one of those syscalls is aimed
 * by a SINGLE RELATIVE NAME (see actInsideProvedDir): what they act in is the directory the kernel
 * is holding, not wherever the name currently leads. Where that binding cannot be established,
 * nothing is created and nothing is removed.
 *
 * THE HOME IS BOUND THE SAME WAY, and it is bound FIRST. `bin/` is a child of the home, so reaching
 * it by absolute pathname re-resolves the home component inside every one of those calls: a home
 * moved aside and replaced by another REAL directory at the same path — which passes every
 * path-shaped test, and under which `<home>/bin` canonicalises to exactly the string the containment
 * check expects — would take the whole write with it while the caller reports success. Hence the
 * `BoundDir` parameter: the caller proves the home once and every directory beneath it is entered
 * one component at a time from there.
 *
 * `bin/` IS PROBED BEFORE IT IS CREATED, so a refusal about a `bin/` that was ALREADY THERE is a
 * refusal that really did modify nothing. Where the directory is absent and this run makes it, the
 * refusals say so instead, and it is LEFT STANDING — nothing here can prove the directory now at
 * that name is the one this run made, so removing it is not ours to do.
 *
 * `create: false` is the read-only form, for callers that must judge before anything is written: an
 * absent `bin/` is then not created, and `whenAbsent` decides what that means for the caller.
 */
function actInsideBinDir<T>(
  home: BoundDir,
  refusal: string,
  opts: { create: boolean; already: readonly string[] },
  act: (ctx: { state: () => string; target: (name: string) => string }) => T,
  whenAbsent?: () => T,
): T {
  const expected = path.join(home.canonical, 'bin');
  /** Did the `mkdir` below really make the directory? Only an exclusive create that RETURNED says
   *  so — an EEXIST means the name belongs to whatever raced in, and claiming it would be the same
   *  "what is here now?" answer this module refuses everywhere else. */
  let madeBin = false;
  /** What the NAME held when it was first read back after that `mkdir` — never a receipt for the
   *  directory the `mkdir` made, which portable Node cannot produce. */
  let binAfterCreate: PostCreateReading | undefined;
  const state = (): string => launcherWriteState(expected, madeBin, binAfterCreate, opts.already);

  return actInsideProvedDir(
    home,
    refusal,
    () => {
      // lstat, never a `mkdir` that swallows EEXIST: "did this run create it?" has to be answered
      // before the create, or it cannot be answered at all.
      let dirStat = fs.lstatSync('bin', { throwIfNoEntry: false });
      if (dirStat === undefined) {
        if (!opts.create) {
          if (whenAbsent === undefined) {
            throw new Error(`${refusal}: ${expected} does not exist — ${state()}`);
          }
          return whenAbsent();
        }
        try {
          fs.mkdirSync('bin');
          madeBin = true;
        } catch (err) {
          if (errCode(err) !== 'EEXIST') {
            throw err;
          }
          // raced — whatever appeared is judged below exactly like a pre-existing entry
        }
        dirStat = fs.lstatSync('bin', { throwIfNoEntry: false });
        if (dirStat === undefined) {
          // The name held NOTHING at the first look-up after the create — the third state again,
          // and the one an ENOENT throw would have turned into an unexplained errno. Recorded
          // before the refusal so the message describes what was actually observed.
          if (madeBin) {
            binAfterCreate = { kind: 'untrusted', because: 'nothing at all' };
          }
          throw new Error(
            `${refusal}: ${expected} could not be read back after it was created — ${state()}`,
          );
        }
      }
      if (madeBin && !(dirStat.isDirectory() && !dirStat.isSymbolicLink())) {
        // STATE (iii): the FIRST look-up after the create already found something that is not a
        // usable directory. Recorded as what it is — there is no identity here to compare against
        // later, and a refusal that inferred one would report a change that never happened.
        binAfterCreate = {
          kind: 'untrusted',
          because: dirStat.isSymbolicLink() ? 'a symlink' : 'an entry that is not a directory',
        };
      }
      if (madeBin && dirStat.isDirectory() && !dirStat.isSymbolicLink()) {
        // WHAT THE NAME HELD AT THE FIRST READ AFTER THE CREATE — recorded as that and nothing
        // more. `mkdir` hands back no descriptor, so this look-up is post hoc: a peer that swapped
        // its own empty directory in first would be recorded here instead, indistinguishably. It is
        // therefore never treated as the identity of the directory this run made; a later refusal
        // compares against it only to say whether the NAME has since changed hands.
        binAfterCreate = { kind: 'identity', id: { dev: dirStat.dev, ino: dirStat.ino } };
      }
      // THE IDENTITY IS READ FIRST, and containment is then proved about the directory it describes.
      // Proving containment first and capturing the identity afterwards are two separate resolutions
      // of one name: a directory substituted in between — a REAL one, standing at the same path,
      // which passes every path-shaped test there is — would supply the identity the write binds to,
      // with nothing ever proved about it. Taken in this order, a substitution either fails
      // containment or fails the identity check inside the binding below. (untrustedDirReason states
      // why the permission bits of `bin/` itself are not policed.)
      let realDir: string;
      try {
        realDir = fs.realpathSync(binDir());
      } catch (err) {
        throw new Error(
          `refusing to write the launcher: ${binDir()} could not be resolved (${errCode(err)}) — ${state()}`,
        );
      }
      if (realDir !== expected) {
        throw new Error(
          `refusing to write the launcher: ${binDir()} resolves to ${realDir}, outside ${expected} — remove the symlinked/replaced bin directory and re-run \`sthayi wire\` (${state()})`,
        );
      }
      const dirReason = untrustedDirReason(dirStat, realDir);
      if (dirReason) {
        throw new Error(
          `refusing to write the launcher: ${dirReason} — remove the replaced bin directory and re-run \`sthayi wire\` (${state()})`,
        );
      }
      const boundDir: BoundDir = {
        canonical: realDir,
        dev: dirStat.dev,
        ino: dirStat.ino,
        enterBy: 'bin',
      };
      return actInsideProvedDir(
        boundDir,
        refusal,
        () => act({ state, target: (name: string) => path.join(realDir, name) }),
        state,
      );
    },
    state,
  );
}

/**
 * JUDGE EVERY TARGET BEFORE ANY OF THEM IS PUBLISHED.
 *
 * A write publishes two launchers, and a hostile entry standing at the second one is a refusal this
 * run can reach with the disk untouched. Reaching it after the first launcher is on disk turns
 * "remove it and re-run" into advice about a machine that has already been changed — and the
 * message would have to describe a partial write nobody asked for.
 *
 * IT CREATES NOTHING. An absent `bin/` holds no entries to judge, so there is nothing to refuse and
 * nothing to make: the write that follows creates the directory, and its own inspection is what
 * judges anything that appears in the meantime. THAT LATER INSPECTION IS NOT REDUNDANT: no ordering
 * excludes a peer that plants an entry after this pass, which is exactly why the write repeats the
 * judgement and why a refusal that follows a publication states what was published.
 */
function preflightLauncherTargets(names: readonly string[], home: BoundDir): void {
  const expected = path.join(home.canonical, 'bin');
  actInsideBinDir(
    home,
    `refusing to write the launchers in ${expected}`,
    { create: false, already: [] },
    ({ state, target }) => {
      for (const name of names) {
        const st = lstatEntry(name);
        if (st === undefined) {
          continue;
        }
        const reason = untrustedTargetReason(st);
        if (reason !== undefined) {
          throw new Error(
            `refusing to replace the launcher at ${target(name)}: ${reason} — remove it yourself and re-run \`sthayi wire\` (${state()}; no launcher was written)`,
          );
        }
      }
    },
    () => undefined,
  );
}

/**
 * The single hardened write path for ONE launcher file, inside the proved and bound `bin/`. The
 * write is an exclusive-create random temp name in that directory, renamed over the target — rename
 * replaces a path, never follows a link, so a target swapped in after validation still cannot
 * redirect the write into an external file.
 *
 * `already` is what this run has published so far. It is not bookkeeping: it is what the refusals
 * from here on say the disk holds, and a run that has written one launcher may never claim it wrote
 * nothing.
 *
 * The publication and the cleanup both name THIS INVOCATION'S OWN INODE, not merely a name it once
 * created. An exclusive create that FAILED means the name belongs to whatever was already standing
 * there, and a name we did not create is never one we unlink; a create that SUCCEEDED keeps its
 * descriptor open through the pre-action identity read, the rename, the post-publication check and
 * guarded failure cleanup on POSIX. That live descriptor prevents Linux from recycling the deleted
 * inode number into a replacement while this call still trusts it. The name is re-read before an
 * act and ONCE MORE after publication (see `stillOurs`, which states exactly what portable Node can
 * and cannot promise there), so a replacement that wins the sub-syscall interval is refused and
 * reported rather than passing as a successful write. SECURITY.md states the residual pathname
 * intervals that an open descriptor still cannot remove.
 */
function persistLauncher(plan: LauncherPlan, home: BoundDir, already: readonly string[]): string {
  const expected = path.join(home.canonical, 'bin');
  const name = path.basename(plan.path);
  return actInsideBinDir(
    home,
    `refusing to write the launcher at ${path.join(expected, name)}`,
    { create: true, already },
    ({ state, target }) => writeLauncherFile(plan, name, target(name), state),
  );
}

/**
 * The identity of a launcher temp file. POSIX identities stay bigint from the syscall through the
 * comparison: converting either field to number would let adjacent values above
 * Number.MAX_SAFE_INTEGER compare equal. Windows deliberately retains the existing numeric
 * identity because this module makes no POSIX inode guarantee there.
 */
type LauncherTempIdentity =
  | { kind: 'posix'; dev: bigint; ino: bigint }
  | { kind: 'windows'; dev: number; ino: number };

/** One fstat call supplies both identity fields and the file-kind verdict. */
function launcherTempFdReading(fd: number): {
  identity: LauncherTempIdentity;
  isFile: boolean;
} {
  if (process.platform === 'win32') {
    const st = fs.fstatSync(fd);
    return {
      identity: { kind: 'windows', dev: st.dev, ino: st.ino },
      isFile: st.isFile(),
    };
  }
  const st = fs.fstatSync(fd, { bigint: true });
  return {
    identity: { kind: 'posix', dev: st.dev, ino: st.ino },
    isFile: st.isFile(),
  };
}

/** One lstat call supplies both exact identity fields for the name being authorised. */
function launcherTempNameIdentity(
  name: string,
  kind: LauncherTempIdentity['kind'],
): LauncherTempIdentity {
  if (kind === 'windows') {
    const st = fs.lstatSync(name);
    return { kind, dev: st.dev, ino: st.ino };
  }
  const st = fs.lstatSync(name, { bigint: true });
  return { kind, dev: st.dev, ino: st.ino };
}

function sameLauncherTempIdentity(
  expected: LauncherTempIdentity,
  actual: LauncherTempIdentity,
): boolean {
  return (
    expected.kind === actual.kind && expected.dev === actual.dev && expected.ino === actual.ino
  );
}

/** The temp-create/write/publish body, running INSIDE the bound `bin/`: every syscall below is
 *  aimed by a single relative name, and `target` is used only to name things in messages. */
function writeLauncherFile(
  plan: LauncherPlan,
  name: string,
  target: string,
  state: () => string,
): string {
  // The judgement is repeated here, inside the binding, because the preflight pass is a statement
  // about an earlier instant: an entry planted after it is one only this inspection can see.
  const st = lstatEntry(name);
  if (st !== undefined) {
    const reason = untrustedTargetReason(st);
    if (reason !== undefined) {
      throw new Error(
        `refusing to replace the launcher at ${target}: ${reason} — remove it yourself and re-run \`sthayi wire\` (${state()})`,
      );
    }
  }

  const tmp = `.${name}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let fd: number | undefined;
  /** The exact POSIX device/inode this invocation created, read from one descriptor stat call. */
  let made: LauncherTempIdentity | undefined;
  /** Once rename returns, cleanup must never reach for the temp name or the published target. */
  let published = false;
  /**
   * Does `tmp` STILL denote the inode this invocation created? "The exclusive create succeeded"
   * says the name was ours THEN, not that it is ours now — and a file swapped in afterwards is one
   * that would otherwise be published as the executable launcher, or unlinked by a cleanup that
   * never created it.
   *
   * WHAT THIS IS AND IS NOT: portable Node exposes no `renameat`/`unlinkat`, so this cannot be
   * BOUND the way the directory above is. The identity is re-read immediately before each act and a
   * mismatch REFUSES, leaving the entry standing — neither published nor removed. What remains is
   * the interval between that read and the next syscall, inside a directory the kernel is holding,
   * under a random name this invocation alone knows. In that interval the rename can carry a
   * replacement onto the launcher name (caught afterwards, by re-reading the published inode) and
   * THE CLEANUP `unlink` CAN REMOVE A REPLACEMENT — an entry this run did not create, deleted
   * because the identity read that authorised the removal was true when it was taken and not when
   * the syscall landed. That residue is stated rather than described as a binding; SECURITY.md
   * publishes it, along with the Windows scope of a device/inode identity.
   */
  const stillOurs = (entry = tmp): boolean => {
    if (made === undefined) {
      return false;
    }
    try {
      // On POSIX the retained descriptor is the non-recyclable anchor. Re-fstat it as well as the
      // name so an accidentally closed/reused descriptor fails closed instead of preserving a
      // stale value. Windows closes before rename for compatibility with its open-handle rules and
      // retains the module's documented weaker path/value check there.
      if (fd !== undefined) {
        const held = launcherTempFdReading(fd);
        if (!held.isFile || !sameLauncherTempIdentity(made, held.identity)) {
          return false;
        }
      }
      const now = launcherTempNameIdentity(entry, made.kind);
      return sameLauncherTempIdentity(made, now);
    } catch {
      return false;
    }
  };
  try {
    fd = fs.openSync(tmp, 'wx', plan.mode); // exclusive-create: never follows a preplanted path
    // Both fields come from this one stat result, with no lossy number conversion on POSIX.
    made = launcherTempFdReading(fd).identity;
    fs.writeSync(fd, plan.content);
    if (process.platform !== 'win32') {
      fs.fchmodSync(fd, plan.mode); // openSync mode is umask-filtered; pin it exactly
    }
    if (process.platform === 'win32') {
      // Windows has no POSIX inode-identity claim and an open file can block rename depending on
      // the filesystem/share mode. Preserve the established close-before-rename compatibility.
      fs.closeSync(fd);
      fd = undefined;
    }
    if (!stillOurs()) {
      throw new Error(
        `refusing to publish the launcher at ${target}: ${tmp} is no longer the file this run created (it was replaced) — nothing was published, and the replacement was left standing; re-run \`sthayi wire\` (${state()})`,
      );
    }
    fs.renameSync(tmp, name);
    published = true;
    // PUBLICATION IS VERIFIED, NOT ASSUMED. `rename` carries the inode with it, so the launcher
    // name must now denote the very inode this run created. A replacement that won the interval
    // between `stillOurs()` and the rename cannot be PREVENTED in portable Node — there is no
    // `renameat` to aim by descriptor — but it can be caught the instant after, and a caller told
    // "written" about a file it did not write is the one outcome worth ruling out. The foreign
    // entry is LEFT STANDING: it is not ours to remove, and the message says so.
    if (!stillOurs(name)) {
      throw new Error(
        `refusing to report the launcher at ${target} as written: the entry standing there is not the file this run created (it was replaced as it was published) — remove ${target} yourself and re-run \`sthayi wire\`; nothing at that path is trusted (${state()})`,
      );
    }
  } catch (err) {
    // Cleanup is judged while the descriptor still pins the created inode. Closing first would let
    // Linux recycle its number into a foreign replacement and make a stale dev/ino value authorise
    // that replacement's unlink.
    if (!published && stillOurs()) {
      try {
        fs.unlinkSync(tmp); // one name, our pinned inode, inside the bound directory — never a tree
      } catch {
        // best-effort tmp cleanup — the original error is the one worth surfacing
      }
    }
    throw err;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // The write verdict is already fixed; preserve it over a close failure.
      }
      fd = undefined;
    }
  }
  return target;
}

/**
 * Write `~/.sthayi/bin/sthayi-mcp` — an absolute launcher that runs `sthayi serve`, pinned IN PLACE
 * at the durable install this process is running from. Clients wire to THIS, never raw `npx`
 * (spec §1 invariant 7). Alongside it, the general CLI launcher `bin/sthayi` is written from the
 * SAME entry and node fallback (no forced `serve`), so the README's documented `sthayi <command>`
 * forms work without the package being on PATH. Both go through the same hardened write.
 *
 * NOTHING IS EVER COPIED. An entry that would not survive an npm cache prune is REFUSED by
 * renderLauncher (a plan is never built for one), so this function only ever pins a path that is
 * already durable — global install, plain local install, anywhere the user keeps. Returns the MCP
 * launcher path.
 *
 * TWO FILES, AND NO ATOMICITY IS CLAIMED FOR THE PAIR. Two names are published by two renames, and
 * portable Node offers no way to make that one act, so there is no instant at which both appear
 * together. What is offered instead is stated exactly:
 *
 *   - BOTH TARGETS ARE JUDGED BEFORE EITHER IS PUBLISHED, so a hostile entry standing at the second
 *     one is refused with the disk untouched rather than after the first launcher is on disk;
 *   - WHERE A REFUSAL STILL FOLLOWS A PUBLICATION — a peer that plants its entry after that
 *     judgement, which no ordering excludes — the message names the launcher this run wrote and
 *     says it is standing. A partial result is reported as a partial result.
 */
export function writeLauncher(): string {
  // ensureSthayiHome FIRST — before the plan is rendered, not after. renderLauncher derives every
  // path it returns (the launcher path, bin/) from sthayiHomeRoot(), and that root is only the
  // VALIDATED canonical one once the home has been established. Planning first would bake the
  // unvalidated LOGICAL home into the plan, and the plan is what the write then acts on: the two
  // halves could disagree about which directory the home is.
  const home = bindEstablishedHome();
  const plan = renderLauncher();
  // The same entry and node the MCP launcher pins, so the two upgrade in lockstep.
  const cli = renderLauncher({ variant: 'cli', cliEntry: plan.entry, node: plan.node });
  preflightLauncherTargets([path.basename(plan.path), path.basename(cli.path)], home);
  const target = persistLauncher(plan, home, []);
  // The SAME bound home, so the second write cannot land in a directory the first one never saw —
  // and it carries what has been published, so its refusals describe the disk as it now stands.
  persistLauncher(cli, home, [target]);
  return target;
}

/**
 * Establish the home and hand back its IDENTITY, proved to be the identity that was established.
 *
 * A canonical path is not a home. `ensureSthayiHome()` returns one, and every syscall that then
 * spells the home out resolves that path afresh — so a home moved aside and replaced by another
 * real directory at the same pathname is a home the caller was never told about. The device/inode
 * is what separates the two, and it has to be read.
 *
 * READING IT IS NOT ENOUGH EITHER: an identity captured after the establishment could be the
 * REPLACEMENT'S, and binding to it would bind to exactly the wrong directory with full confidence.
 * So the establishment is re-entered afterwards. `establishTrustedDir` compares an already
 * established boundary against the identity it registered and REFUSES a replacement rather than
 * re-registering it, which makes the second call a proof about the first: it can only return if the
 * home is still the inode that was registered, and the stat taken between the two calls therefore
 * describes that same inode. (POSIX: the comparison is device/inode. fs-safe states the Windows
 * scope, where it degrades to the path-based discipline this module already documents.)
 */
function bindEstablishedHome(): BoundDir {
  const canonical = ensureSthayiHome();
  let st: fs.Stats;
  try {
    st = fs.lstatSync(canonical);
  } catch (err) {
    throw new Error(
      `refusing to write the launcher: the sthayi home ${canonical} could not be inspected (${errCode(err)}) — nothing was modified`,
    );
  }
  ensureSthayiHome(); // re-entry compares against the registered identity; a replacement throws here
  return { canonical, dev: st.dev, ino: st.ino };
}

export type LauncherState =
  | 'ok'
  | 'untrusted-home'
  | 'missing'
  | 'symlink'
  | 'not-regular'
  | 'bad-mode'
  | 'foreign-owner'
  /** present and lstat-clean, but the hardened read refused it (swapped path, over the cap, …) */
  | 'unreadable'
  /** parseable, and carrying a command Sthayi does not generate — an edited launcher runs it on
   *  every client launch, so a body is never vouched for because one recognisable line survives */
  | 'foreign-content'
  | 'stale-target'
  /** pinned into `<home>/runtime/…` — a directory Sthayi neither creates, refreshes, nor vouches
   *  for, so a launcher pinned inside it is wiring nothing maintains. The pinned tree is NEVER
   *  read through to decide this. */
  | 'stale-runtime'
  | 'ephemeral-target';

export interface LauncherHealth {
  ok: boolean;
  state: LauncherState;
  detail: string;
}

/**
 * The line shapes a generated launcher is made of — the node assignment, its fallback, the two
 * guards around it, and comments.
 *
 * A launcher that PARSES is not the same claim as a launcher that contains only what Sthayi wrote.
 * The parse looks for one recognisable line; a launcher with that line still intact and a command
 * inserted above it runs the inserted command on every client launch, and reported healthy it is a
 * command the user has been told is fine. So the body is read as a whole vocabulary, and anything
 * outside it is REPORTED — never executed, never rendered as health.
 */
function launcherLineShapes(platform: NodeJS.Platform): RegExp[] {
  return platform === 'win32'
    ? [
        /^@echo off$/,
        /^rem\b/,
        /^set "NODE=[^"%\r\n]*"$/,
        /^if exist "%NODE%" goto run$/,
        /^where node >nul 2>nul$/,
        /^if errorlevel 1 \($/,
        /^echo [^"%|&<>]*1>&2$/,
        /^exit \/b 127$/,
        /^\)$/,
        /^:run$/,
      ]
    : [
        /^#/,
        /^NODE="\$\(command -v node \|\| true\)"$/,
        /^NODE="[^"$`\\\n]*"$/,
        /^if \[ (?:! -x|-z) "\$NODE" \]; then$/,
        /^fi$/,
        /^echo "[^"$`\\\n]*" >&2$/,
        /^exit 127$/,
      ];
}

/**
 * The one line that runs a program — allowed only as the LAST line of the script.
 *
 * The path slots carry the WRITER'S character policy, not a laxer one. A slot of `[^"\n]+` accepted
 * `$(…)`, `$VAR` and backticks that `assertLauncherSafe` refuses to write, so a launcher whose
 * entry expanded at every client launch matched this shape and was reported healthy — while bash
 * ran whatever the environment made that path resolve to, which is a different file. `%` is the
 * same hole on Windows. The node slot additionally admits the variable the generator itself writes.
 */
function launcherExecShape(platform: NodeJS.Platform): RegExp {
  return platform === 'win32'
    ? /^"(?:%NODE%|[^"%\r\n]+)" "[^"%\r\n]+"(?: serve)? %\*$/
    : /^exec "(?:\$NODE|[^"$`\\\n]+)" "[^"$`\\\n]+"(?: serve)? "\$@"$/;
}

/** The first line of `body` that is neither one of the generated shapes nor the trailing exec. */
function foreignLauncherLine(
  body: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const shapes = launcherLineShapes(platform);
  const exec = launcherExecShape(platform);
  const lines = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (shapes.some((re) => re.test(line))) {
      continue;
    }
    if (i === lines.length - 1 && exec.test(line)) {
      continue;
    }
    return line;
  }
  return undefined;
}

/** Pull the pinned node and CLI entry back out of a launcher script.
 *  `serve: true` parses the MCP launcher (forced `serve` arg); `serve: false` parses the general
 *  CLI launcher (no forced arg). The MCP dialect also accepts a FALLBACK-LESS body — one that names
 *  the node binary directly in the exec line instead of assigning it first. */
function parseLauncherBody(
  body: string,
  serve: boolean,
  platform: NodeJS.Platform = process.platform,
): { node?: string; entry?: string } {
  if (platform === 'win32') {
    const node = /^set "NODE=([^"\r\n]+)"/m.exec(body)?.[1];
    if (!serve) {
      return { node, entry: /"%NODE%" "([^"\r\n]+)" %\*/.exec(body)?.[1] };
    }
    const entry =
      /"%NODE%" "([^"\r\n]+)" serve/.exec(body)?.[1] ??
      /^"([^"\r\n]+)" "([^"\r\n]+)" serve %\*/m.exec(body)?.[2];
    return { node, entry };
  }
  const node = /^NODE="([^"\n]+)"/m.exec(body)?.[1];
  if (!serve) {
    return { node, entry: /exec "\$NODE" "([^"\n]+)" "\$@"/.exec(body)?.[1] };
  }
  const pinned = /exec "\$NODE" "([^"\n]+)" serve/.exec(body)?.[1];
  if (node !== undefined || pinned !== undefined) {
    return { node, entry: pinned };
  }
  const bare = /exec "([^"\n]+)" "([^"\n]+)" serve/.exec(body);
  return { node: bare?.[1], entry: bare?.[2] };
}

/** The fallback-less MCP body `parseLauncherBody` also accepts: node named directly in the exec
 *  line, no assignment and no PATH fallback around it. It is a complete, exactly determined script,
 *  so it can be compared byte-for-byte like the generated one. */
function bareBody(node: string, entry: string, platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? `@echo off\r\n"${node}" "${entry}" serve %*\r\n`
    : `#!/usr/bin/env bash\nexec "${node}" "${entry}" serve "$@"\n`;
}

/**
 * WHY `body` IS NOT A LAUNCHER STHAYI WOULD HAVE WRITTEN — or undefined when it is exactly one.
 *
 * The health check exists to report on the writer's policy, so it applies the WRITER'S OWN RULES to
 * the values the body actually carries, and then requires the body to be, byte for byte, a script
 * that policy produces. A line-shape vocabulary alone does not settle it: a vocabulary says every
 * line LOOKS LIKE one of ours, which is a weaker claim than every byte IS ours, and an exec slot
 * loose enough to admit shell expansion the writer refuses outright would pass such a check.
 *
 * The platform is a PARAMETER for the same reason `assertLauncherSafe` takes one: the Windows rule
 * has to be assertable from wherever the tests run, or it is a rule nothing exercises.
 */
export function launcherBodyDeviation(
  body: string,
  serve: boolean,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const { node, entry } = parseLauncherBody(body, serve, platform);
  if (node === undefined || entry === undefined) {
    // Nothing recognisable parsed out. That is ordinary corruption, reported by the caller as an
    // unparseable entry — not a claim about tampering, which needs something to compare against.
    return undefined;
  }
  for (const [what, value] of [
    ['node', node],
    ['entry', entry],
  ] as const) {
    if (launcherUnsafeChars(platform).test(value)) {
      return `the pinned ${what} ${JSON.stringify(value)} carries characters that expand at every client launch — sthayi refuses to write them, so the file this launcher runs is not the file named here`;
    }
  }
  if (
    body === launcherScriptBody(node, entry, serve, platform) ||
    body === bareBody(node, entry, platform)
  ) {
    return undefined;
  }
  const line = foreignLauncherLine(body, platform);
  return line !== undefined
    ? `it carries a command sthayi does not generate (${JSON.stringify(line)})`
    : 'its body is not the script sthayi generates for the node and CLI entry it pins';
}

/**
 * Observational launcher diagnosis for `sthayi doctor`. Reads only — every
 * hostile state writeLauncher refuses to replace is reported here, plus staleness (referenced
 * paths gone) and ephemeral pins (npm-cache paths that will vanish). Diagnoses the MCP
 * launcher first (what client configs invoke), then applies the SAME checks to the general CLI
 * launcher when one is present; an ABSENT CLI launcher is healthy (installs wired before it
 * existed keep passing — the next `sthayi wire`/`init` writes it).
 *
 * The home is validated OBSERVATIONALLY first (creates nothing, chmods nothing): every path read
 * below lives under the home, so a home that is symlinked at ANY depth, foreign-owned, or
 * group/world-writable must produce a REFUSAL rather than a confident report about a launcher
 * outside the boundary. The refusal is RETURNED as a failing state, never thrown — doctor and
 * status both surface it as the one thing wrong, and neither reads through the planted path.
 */
export function launcherHealth(): LauncherHealth {
  const platformPath = (): string =>
    process.platform === 'win32' ? `${launcherPath()}.cmd` : launcherPath();
  try {
    if (assertReadOnlySthayiHome() === undefined) {
      return { ok: false, state: 'missing', detail: `${platformPath()} does not exist` };
    }
  } catch (err) {
    return {
      ok: false,
      state: 'untrusted-home',
      detail: `${err instanceof Error ? err.message : String(err)} — the launcher was NOT inspected through it`,
    };
  }
  // Derived AFTER the validation above, so it hangs off the canonical root that was just checked.
  const mcp = diagnoseLauncher(platformPath(), true);
  if (!mcp.ok) {
    return mcp;
  }
  const cliP = cliLauncherPath();
  try {
    fs.lstatSync(cliP); // presence probe — lstat so a dangling symlink still gets diagnosed
  } catch {
    return mcp;
  }
  const cli = diagnoseLauncher(cliP, false);
  return cli.ok ? mcp : cli;
}

/** The per-file diagnosis behind launcherHealth (`serve` selects the launcher dialect). */
function diagnoseLauncher(p: string, serve: boolean): LauncherHealth {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch {
    return { ok: false, state: 'missing', detail: `${p} does not exist` };
  }
  if (st.isSymbolicLink()) {
    return {
      ok: false,
      state: 'symlink',
      detail: `${p} is a symlink (possible hijack) — remove it and re-run \`sthayi wire\``,
    };
  }
  if (!st.isFile()) {
    return {
      ok: false,
      state: 'not-regular',
      detail: `${p} is not a regular file — remove it and re-run \`sthayi wire\``,
    };
  }
  if (process.platform !== 'win32') {
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
      return {
        ok: false,
        state: 'foreign-owner',
        detail: `${p} is owned by uid ${st.uid}, not you — remove it and re-run \`sthayi wire\``,
      };
    }
    if (st.nlink > 1 || (st.mode & 0o022) !== 0) {
      return {
        ok: false,
        state: 'bad-mode',
        detail:
          st.nlink > 1
            ? `${p} has ${st.nlink} hard links (possible hijack) — remove it and re-run \`sthayi wire\``
            : `${p} is group/world-writable (mode ${(st.mode & 0o777).toString(8)}) — remove it and re-run \`sthayi wire\``,
      };
    }
    // The launcher is the file a client EXECUTES. One that its owner cannot execute is wiring that
    // fails at launch, so it is a failing state here rather than a healthy report of a dead path.
    if ((st.mode & 0o100) === 0) {
      return {
        ok: false,
        state: 'bad-mode',
        detail: `${p} is not executable (mode ${(st.mode & 0o777).toString(8)}) — the client that invokes it cannot run it; re-run \`sthayi wire\``,
      };
    }
  }
  // Descriptor-safe capped read, NOT readFileSync: the lstat rows above are path checks, so a
  // launcher swapped between the lstat and the read would otherwise be followed and slurped. Any
  // refusal is REPORTED as a failing state (launcherHealth never throws — status and doctor both
  // render it), and the unsafe bytes are never read, let alone echoed.
  let body: string;
  try {
    const read = readLauncherBody(p);
    if (read === undefined) {
      return { ok: false, state: 'missing', detail: `${p} does not exist` };
    }
    body = read;
  } catch (err) {
    return {
      ok: false,
      state: 'unreadable',
      detail: `${err instanceof Error ? err.message : String(err)} — it was NOT read`,
    };
  }
  const { node, entry } = parseLauncherBody(body, serve);
  // STALE RUNTIME — a READER-ONLY statement about `<home>/runtime/`, a directory sthayi never
  // creates, refreshes or garbage-collects (SECURITY.md: nothing is copied out of the npm cache).
  // A launcher pinned inside it is therefore wiring nothing maintains — regardless of version, and
  // regardless of whether the tree is still on disk — so it is reported rather than vouched for.
  //
  // THE PINNED TREE IS NEVER READ THROUGH TO DECIDE THIS: the test is `entry` against the home's
  // own `runtime/` path, so a symlink planted at any component of it is neither followed nor
  // stat'd, and a foreign tree standing behind one is never inspected, quoted or removed. Checked
  // BEFORE stale-target so the dir-present and dir-gone shapes name the same condition.
  if (entry !== undefined && isUnder(entry, runtimeRoot())) {
    return {
      ok: false,
      state: 'stale-runtime',
      // The scoped install, for the same reason ephemeralEntryRefusal prints it: a bare
      // `npm install -g` lands in whatever prefix npm is configured for, and fails outright where
      // that prefix is root-owned. One line that works on every machine beats one that works here.
      detail: `${p} pins ${entry} inside ${runtimeRoot()}, a runtime copy this sthayi does not create or maintain — install sthayi somewhere durable (${DURABLE_INSTALL_HINT}) and re-run \`sthayi wire\``,
    };
  }
  // EPHEMERALITY IS THE WRITER'S QUESTION, ASKED THE WRITER'S WAY — `isEphemeralPath` on the PARSED
  // ENTRY, the same predicate renderLauncher refuses an install on. Scanning the script TEXT for
  // npm-cache spellings answers a narrower question than the one the writer asks: it knows nothing
  // about the system temp directory or `npm_config_cache`, so a launcher pinned at a real file
  // under `os.tmpdir()` — one sthayi refuses to create — would pass as healthy. The node is not
  // policed here because the writer does not police it either: a vanished pinned node falls back to
  // `node` on PATH by design, and that fallback is reported in the detail below.
  //
  // ASKED AFTER THE RUNTIME TEST, NEVER BEFORE IT. `isEphemeralPath` resolves the path it is given,
  // and a `<home>/runtime/…` entry is exactly the path a planted symlink is standing in the middle
  // of; resolving it first would follow that link to reach a verdict the lexical test above already
  // reaches without touching the filesystem at all.
  if (entry !== undefined && isEphemeralPath(entry)) {
    return {
      ok: false,
      state: 'ephemeral-target',
      detail: `${p} pins ${entry}, which lives in an npm/npx cache or a temp directory and can vanish — re-run \`sthayi wire\` from a durable install`,
    };
  }
  if (!entry || !fs.existsSync(entry)) {
    return {
      ok: false,
      state: 'stale-target',
      detail: `${p} references ${entry ?? 'an unparseable CLI entry'} which does not exist — re-run \`sthayi wire\``,
    };
  }
  // THE LAST THING BETWEEN A LAUNCHER AND A HEALTHY VERDICT: is this, byte for byte, a script the
  // writer would have produced for the node and entry it names — with the writer's own character
  // policy applied to both? Everything above answers "where does it point"; only this answers "is
  // it ours". It is asked last because a launcher that is stale, runtime-pinned or cache-pinned is
  // already broken wiring, and naming THAT is the more useful thing to tell the user; a body that
  // survives every one of those and is still not ours is the case that would otherwise be called ok.
  const deviation = launcherBodyDeviation(body, serve);
  if (deviation !== undefined) {
    return {
      ok: false,
      state: 'foreign-content',
      detail: `${p} is not a launcher sthayi generated: ${deviation} — it runs on every client launch; remove the launcher and re-run \`sthayi wire\``,
    };
  }
  const detail =
    node && !fs.existsSync(node)
      ? `${p} (pinned node ${node} is gone — the launcher will fall back to \`node\` on PATH)`
      : p;
  return { ok: true, state: 'ok', detail };
}
