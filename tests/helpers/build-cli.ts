import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Build-the-CLI-once coordination for every safety test that spawns the BUILT dist
 * (keyless-matrix, multi-process-writes, dry-run, oracle-precheck, …). Vitest runs test files in
 * parallel worker processes: if one file rebuilds `packages/cli/dist` while another is spawning
 * it, the spawn can load a half-written entry/chunk and die with a bogus nonzero exit. This
 * helper makes the build (a) happen at most once per change to the build INPUTS, and (b)
 * exclusive — every other worker waits on a lock until the winner finishes.
 *
 * TWO THINGS HAVE TO BE TRUE, AND BOTH ARE ABOUT WHAT THE SAFETY SUITE IS ALLOWED TO BELIEVE.
 *
 * 1. THE DIST THAT IS SPAWNED IS THE DIST THESE SOURCES PRODUCE. Deciding that with mtimes cannot
 *    do it. An mtime is metadata a checkout, a `cp -p`, an editor, a `git stash`, a rebase or a
 *    plain `touch` all rewrite independently of content, and the comparison is one-sided: it can
 *    only notice a source that became NEWER than the marker. A same-size edit whose mtime is put
 *    back is invisible, and so is every input outside the walked trees — the bundler configs, the
 *    root manifest, the lockfile, the bundler itself. The failure is silent and total: the suite
 *    keeps spawning yesterday's bytes and reports green about code that no longer exists. So the
 *    question is answered with a CONTENT DIGEST over the whole build-input contract, and the
 *    produced dist is recorded and re-verified file by file — a marker alone says a build once
 *    happened, not that its output is still standing there intact.
 *
 * 2. TWO CLEAN BUILDS NEVER RUN AT ONCE. The lock is what buys that, and it is a KERNEL lock — a
 *    `flock(2)` held by `flock(1)`/`lockf(1)` for the entire life of the process that builds. A
 *    lock asserted by the existence of a NAME cannot buy it: a name is not an identity, so a
 *    waiter's authorisation to take it can outlive the state it was minted from (pathname ABA), and
 *    there is a window between `mkdir` succeeding and the owner metadata existing in which no
 *    answer a waiter can give is correct. A kernel lock has no metadata to race, gives a waiter no
 *    move to make on the holder's lock, and is released by the kernel the instant the holder dies —
 *    including `SIGKILL` — so there is no stale state and nothing is ever "reclaimed". See
 *    the KERNEL ADVISORY LOCK section below, and `scripts/freshtest.sh`, which holds the same primitive for
 *    the same reason.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The child that IS the critical section: plain node, launched under the kernel lock.
 *
 * Declared here rather than beside its launcher because the input digest below has to be able to
 * ask "am I that child?" — see `isCriticalSectionChild`.
 */
export const CRITICAL_SECTION_ENTRY = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'build-critical-section.mjs',
);

/**
 * Where the lock file lives: STABLE, CANONICAL, REPO-PRIVATE, and deliberately NOT under
 * `node_modules/`.
 *
 * `node_modules/.cache` was the old home and it splits the lock. `node_modules` is package-manager
 * state: a `pnpm install`, a prune, or a plain `rm -rf node_modules` removes it mid-run, and every
 * invocation arriving afterwards locks a NEW file — two runs then hold two different locks and both
 * enter the section. This path is created once, is NEVER unlinked (a lock file is not debris; it is
 * the object the kernel lock is attached to), and is git-ignored.
 */
export const BUILD_LOCK_FILE = path.join(repoRoot, '.sthayi-build.lock');

/**
 * Bumped when the shape of the recorded marker OR the meaning of the input digest changes; an older
 * marker is simply not current. v3: symlinks are digested through to their resolved bytes, the
 * bundler identity covers the tsup and esbuild implementations and the esbuild executable, and the
 * environment the bundler is given is part of the contract.
 */
const CONTRACT = 3;

export interface BuildLayout {
  repoRoot: string;
  cacheDir: string;
  /**
   * The file the KERNEL lock is taken on. Repo-private, stable, git-ignored, and deliberately NOT
   * under `node_modules/`: a `pnpm install` or a prune removes `node_modules` mid-run, and every
   * invocation arriving afterwards would lock a NEW inode — two runs, two locks, both building.
   * It is created once and never unlinked; a lock file is not debris, it is the object the lock
   * is attached to.
   */
  lockFile: string;
  marker: string;
  cliRoot: string;
  distDir: string;
  distEntry: string;
  /** The bundler as a JS entry point, run under THIS node — not a `.bin` shim, which is a shell
   *  script on POSIX and a `.cmd` on Windows, and so would need `shell: true` to launch. */
  tsupBin: string;
  tsupManifest: string;
  tsupConfig: string;
}

export function buildLayout(root: string = repoRoot): BuildLayout {
  const cacheDir = path.join(root, 'node_modules', '.cache');
  const cliRoot = path.join(root, 'packages', 'cli');
  const distDir = path.join(cliRoot, 'dist');
  return {
    repoRoot: root,
    cacheDir,
    lockFile: root === repoRoot ? BUILD_LOCK_FILE : path.join(root, '.sthayi-build.lock'),
    marker: path.join(cacheDir, 'sthayi-test-build.manifest.json'),
    cliRoot,
    distDir,
    distEntry: path.join(distDir, 'index.js'),
    tsupBin: path.join(root, 'node_modules', 'tsup', 'dist', 'cli-default.js'),
    tsupManifest: path.join(root, 'node_modules', 'tsup', 'package.json'),
    tsupConfig: path.join(cliRoot, 'tsup.config.ts'),
  };
}

export const distEntry = buildLayout().distEntry;

// ===================================================================================================
// THE BUILD-INPUT CONTRACT — everything a change to which can change the bytes in `dist`.
// ===================================================================================================

/** Source trees bundled into the CLI. `noExternal: ['@sthayi/core']` is why core is one of them. */
const SOURCE_TREES = ['packages/cli/src', 'packages/core/src'];

/**
 * Single files that steer the build. Each is digested by CONTENT, and a file that is absent is
 * recorded as absent — so deleting one is a change, exactly like editing one.
 *
 * `packages/core/tsup.config.ts` is here even though the CLI build does not read it: core is
 * bundled from source, and the day that changes the config becomes load-bearing without anyone
 * remembering to add it. Over-inclusion costs a rebuild that was not strictly needed;
 * under-inclusion costs a green test run against bytes nobody produced.
 */
const MANIFEST_FILES = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'tsconfig.base.json',
  'packages/cli/package.json',
  'packages/cli/tsconfig.json',
  'packages/cli/tsup.config.ts',
  'packages/core/package.json',
  'packages/core/tsconfig.json',
  'packages/core/tsup.config.ts',
];

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Content digest of one file, or `undefined` when there is nothing readable at that path. */
function fileDigest(abs: string): string | undefined {
  try {
    return sha256(fs.readFileSync(abs));
  } catch {
    return undefined;
  }
}

const posix = (p: string): string => p.split(path.sep).join('/');

/**
 * The key under which a symlink's RESOLVED CONTENT is recorded, derived from the link's own key.
 *
 * `\0` cannot occur in a path component, so a derived key can never collide with the key of a real
 * entry — a file genuinely called `x -> target` would collide with any printable separator.
 */
function viaKey(key: string): string {
  return `\u0000via:${key}`;
}

/** Whether `abs` is `root` itself or lies beneath it, compared on already-resolved paths. */
function contained(root: string, abs: string): boolean {
  if (abs === root) {
    return true;
  }
  return abs.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/**
 * Digest one filesystem node into `out` under `key`.
 *
 * `lstat`, never `stat`: a symlink is recorded as the link it IS, so replacing a file with a link
 * to somewhere else is a change rather than an invisible redirection of what gets digested.
 *
 * THE LINK TEXT IS NOT THE INPUT — THE BYTES CONSUMED THROUGH IT ARE. Recording only
 * `sha256(readlink)` was a silent currency hole with exactly the shape this module exists to
 * refuse: the bundler reads through the link, so editing the TARGET changes the emitted `dist`
 * while the link text — and therefore the whole input digest — stays byte-for-byte identical, and
 * `distIsCurrent()` keeps answering true about output nobody produced. So the link text is kept
 * (a re-pointed link is still a change) AND the resolved target's identity and bytes are digested
 * underneath it.
 *
 * CONTAINMENT AND CYCLES. `realpathSync` resolves the whole chain in one call and throws on a loop
 * of links; a directory reached through a link is then walked with the set of realpaths already
 * entered on this branch, so `a -> D` where `D` contains `b -> D` terminates at `cycle` instead of
 * recursing. A target is recorded as `in:<path relative to the digest root>` when it lands inside
 * the tree being digested and `out:<absolute path>` when it does not — an escape is a fact the
 * digest carries rather than a walk that silently wanders off.
 */
function digestNode(
  abs: string,
  key: string,
  out: Map<string, string>,
  root: string,
  seen: ReadonlySet<string>,
): void {
  const st = fs.lstatSync(abs, { throwIfNoEntry: false });
  if (st === undefined) {
    return;
  }
  if (st.isSymbolicLink()) {
    const text = sha256(fs.readlinkSync(abs));
    let real: string | undefined;
    try {
      real = fs.realpathSync(abs);
    } catch {
      real = undefined;
    }
    if (real === undefined) {
      // Dangling, or a resolution loop. Both are recorded, and both change the moment the link
      // starts resolving to something — a state that is not silently equal to any other.
      out.set(key, `symlink:${text}:unresolvable`);
      return;
    }
    const where = contained(root, real)
      ? `in:${posix(path.relative(root, real))}`
      : `out:${posix(real)}`;
    out.set(key, `symlink:${text}:${where}`);
    if (seen.has(real)) {
      out.set(viaKey(key), 'cycle');
      return;
    }
    const next = new Set(seen);
    next.add(real);
    digestNode(real, viaKey(key), out, root, next);
    return;
  }
  if (st.isDirectory()) {
    for (const entry of fs.readdirSync(abs).sort()) {
      digestNode(path.join(abs, entry), key === '' ? entry : `${key}/${entry}`, out, root, seen);
    }
    return;
  }
  if (!st.isFile()) {
    out.set(key, 'not-a-regular-file');
    return;
  }
  out.set(key, fileDigest(abs) ?? 'unreadable');
}

/** Digest every entry under `base`/`rel` into `out`, keyed by its path relative to `base`. */
function digestTree(base: string, rel: string, out: Map<string, string>): void {
  const abs = rel === '' ? base : path.join(base, ...rel.split('/'));
  digestNode(abs, rel, out, base, new Set<string>());
}

/** One rolled-up digest of a whole tree, for inputs recorded as a single identity line. */
function treeDigest(abs: string): string {
  const entries = new Map<string, string>();
  digestNode(abs, '', entries, abs, new Set<string>());
  if (entries.size === 0) {
    return 'absent';
  }
  const hash = createHash('sha256');
  for (const key of [...entries.keys()].sort()) {
    hash.update(`${JSON.stringify(key)} ${entries.get(key) as string}\n`);
  }
  return hash.digest('hex');
}

// ===================================================================================================
// THE ENVIRONMENT THE BUNDLER RUNS IN — explicit, not whatever the caller happened to export.
// ===================================================================================================

/**
 * The ONLY variables handed to the bundler. Everything else is dropped.
 *
 * An allowlist, not a denylist: a denylist is a guess about what is dangerous, and the guess is
 * wrong the day a tool grows a new knob. These are the variables a child process needs in order to
 * find its own binaries and a writable scratch directory, and none of them selects a compiler, a
 * loader, a plugin or a define.
 */
const BUNDLER_ENV_ALLOW = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  // Windows needs these to spawn anything at all.
  'SystemRoot',
  'COMSPEC',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
] as const;

/**
 * Ambient variables that CHANGE WHAT THE BUNDLER EMITS without changing one byte in the repository.
 *
 * `NODE_OPTIONS` injects loaders, import hooks and `--require` into the node that runs tsup;
 * `ESBUILD_BINARY_PATH` swaps the actual compiler for another executable; `NODE_PATH` re-resolves
 * plugins; `NODE_ENV` reaches `define`. Every one of them was inherited wholesale by the old
 * `execFileSync`, and none of them appeared in the digest — so a build under `ESBUILD_BINARY_PATH`
 * pointing at a different esbuild produced different bytes and was still called current.
 *
 * They are handled in BOTH directions, because either alone leaves a hole:
 *   - CONTRACTED out of the bundler's environment, so they cannot affect the output at all;
 *   - and RECORDED in the input digest, so a `dist` that was built while one of them was set is not
 *     silently reused by a run where it is not. That is over-inclusion, and it is the trade this
 *     module makes everywhere else: an unnecessary rebuild costs time, a wrongly-current `dist`
 *     costs a green suite about bytes nobody produced.
 */
const OUTPUT_AFFECTING_ENV = [
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_ENV',
  'ESBUILD_BINARY_PATH',
  'ESBUILD_WORKER_THREADS',
] as const;

/** The exact environment the bundler is launched with — built from an allowlist, never inherited. */
export function bundlerEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of BUNDLER_ENV_ALLOW) {
    const value = source[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  return env;
}

/**
 * The ONE thing the critical-section child is given beyond that allowlist: the parent's
 * ALREADY-COMPUTED digest of the output-affecting ambient variables.
 *
 * WHY IT HAS TO EXIST. The child's `buildInputDigest()` must equal the parent's, or the two would
 * never agree that `dist` is current and every worker would rebuild forever. The old way of buying
 * that agreement was to hand the child `process.env` wholesale — which handed it `NODE_OPTIONS`
 * too, so a loader, an import hook or a `--require` ran inside the very process that decides
 * currency and then runs the build. Sanitising only the grandchild bundler left that untouched.
 * Relaying the ANSWER buys the same agreement with none of the injection.
 *
 * WHY IT IS INERT. Its value is one sha256, or the word `none`; the shape is checked before it is
 * believed, so nothing structural gets through it either. Node interprets no variable of this name:
 * it selects no loader, no module search path, no compiler and no `define`. It is data the digest
 * reads, never something the runtime acts on.
 */
export const ENV_DIGEST_RELAY = 'STHAYI_BUILD_CONTRACTED_ENV_DIGEST';

/** Exactly what this harness ever mints. Anything else is not believed, it is recomputed. */
const RELAYED_DIGEST = /^(?:none|[0-9a-f]{64})$/;

/**
 * Whether THIS process is the critical-section child — the only process that may believe a relayed
 * digest instead of reading the ambient environment for itself.
 *
 * Without the gate the relay would be a way to LIE about your own environment: a stray ambient
 * `STHAYI_BUILD_CONTRACTED_ENV_DIGEST` would make an ordinary worker report an environment it is
 * not running in, and a `dist` built under a different one would be reused unquestioned. This is
 * not a defence against a process that can write `dist` outright — nothing in this file is — it
 * keeps an ambient variable from being mistaken for authority.
 */
function isCriticalSectionChild(argv: readonly string[]): boolean {
  const entry = argv[1];
  return entry !== undefined && path.resolve(entry) === CRITICAL_SECTION_ENTRY;
}

/**
 * The output-affecting variables that were present and had to be contracted away, digested.
 *
 * A sanitized critical-section child HAS none of them — that is the point of sanitizing it — so it
 * would otherwise compute `none` while its parent computed something else, and the two would never
 * agree. It therefore takes the parent's answer, and only it does: the relay is honoured only for
 * that one process, only when nothing output-affecting is actually set, and only when the value has
 * the shape this harness mints.
 */
export function contractedEnvDigest(
  source: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): string {
  const present: string[] = [];
  for (const name of [...OUTPUT_AFFECTING_ENV].sort()) {
    const value = source[name];
    if (value !== undefined) {
      present.push(`${name}=${sha256(value)}`);
    }
  }
  const relayed = source[ENV_DIGEST_RELAY];
  if (
    present.length === 0 &&
    relayed !== undefined &&
    RELAYED_DIGEST.test(relayed) &&
    isCriticalSectionChild(argv)
  ) {
    return relayed;
  }
  return present.length === 0 ? 'none' : sha256(present.join('\n'));
}

/**
 * The exact environment the CRITICAL-SECTION CHILD is launched with.
 *
 * THE CHILD IS NOT A COURIER, IT IS THE BUILD. It imports this module, decides currency, runs the
 * bundler and publishes the marker, so every argument for contracting the bundler's environment
 * applies to it FIRST: `NODE_OPTIONS` puts a loader or a `--require` inside the process that
 * decides what `dist` is, and `NODE_PATH` re-resolves what that process imports. Sanitising only
 * the grandchild left the deciding process wide open.
 *
 * AND CURRENCY COULD NOT HAVE CAUGHT IT. The digest covers the TEXT of `NODE_OPTIONS`, never the
 * bytes of the loader that text names — so changing the loader while leaving the option string
 * alone changed what the critical section did and left the digest standing still. The repair is
 * not a bigger digest (a loader can live anywhere, and be written after the digest is taken); it
 * is that the variable never reaches the child, which makes those bytes irrelevant to the build
 * rather than unwatched.
 *
 * So: the same allowlist the bundler gets — nothing in it selects code — plus one inert digest
 * string, so that parent and child still agree about the ambient environment.
 *
 * THIS IS NOT A HYPOTHETICAL. This very suite runs with `NODE_OPTIONS` set: `owned-fs` publishes
 * `--import …/child-dir-ledger.mjs?ledger=…&root=…` so that node CHILDREN record the directories
 * they create into the run's ledger. That is a real import hook, and before this function existed
 * it was loaded and executed inside the critical-section child on every run. Dropping it here is
 * what that ledger's own contract already provides for: a child launched with `NODE_OPTIONS`
 * stripped records nothing, and a directory with no record is never walked — the cost is a leaked
 * fixture, never a deleted stranger. This child allocates nothing under the run root; it writes
 * `packages/cli/dist` and the marker beside it, both repo paths the ledger never governs.
 */
export function criticalSectionEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = bundlerEnv(source);
  env[ENV_DIGEST_RELAY] = contractedEnvDigest(source);
  return env;
}

/**
 * The identity of the toolchain that will do the bundling.
 *
 * A dependency bump changes the emitted bytes without touching a single source file, and under
 * pnpm the version lives in the store path `node_modules/tsup` points at — so the resolved path is
 * recorded alongside the implementation. The node that runs the bundler is part of the identity
 * too: `target: 'node22'` is a request, not a guarantee that two runtimes emit the same output.
 *
 * THE ENTRY POINT IS NOT THE IMPLEMENTATION. `tsup/dist/cli-default.js` is a few lines that import
 * chunks beside it, and every line that decides what comes out of the bundler lives in those
 * chunks — so patching one changed the output and left `tsup-entry` identical. The identity is
 * therefore over the RESOLVED IMPLEMENTATION TREE, not over the one file that happens to be the
 * entry. The same argument applies to esbuild twice over: `esbuild/package.json` says nothing about
 * `lib/main.js`, and `lib/main.js` says nothing about the NATIVE EXECUTABLE that does the actual
 * compiling — which is a separate file, is what `ESBUILD_BINARY_PATH` would replace, and is the
 * thing whose bytes decide the output.
 */
function toolIdentity(root: string): Record<string, string> {
  const layout = buildLayout(root);
  const identity: Record<string, string> = {
    node: process.version,
    'tsup-entry': fileDigest(layout.tsupBin) ?? 'absent',
    'tsup-manifest': fileDigest(layout.tsupManifest) ?? 'absent',
    'env-contracted': contractedEnvDigest(),
  };
  let resolvedTsup: string | undefined;
  try {
    resolvedTsup = fs.realpathSync(layout.tsupManifest);
  } catch {
    resolvedTsup = undefined;
  }
  identity['tsup-resolved'] =
    resolvedTsup === undefined ? 'absent' : posix(path.relative(root, resolvedTsup));
  identity['tsup-impl'] =
    resolvedTsup === undefined
      ? 'absent'
      : treeDigest(path.join(path.dirname(resolvedTsup), 'dist'));
  identity.esbuild = 'absent';
  identity['esbuild-impl'] = 'absent';
  identity['esbuild-exe'] = 'absent';
  if (resolvedTsup !== undefined) {
    try {
      const pkg = fs.realpathSync(createRequire(resolvedTsup).resolve('esbuild/package.json'));
      identity.esbuild = `${posix(path.relative(root, pkg))}:${fileDigest(pkg) ?? 'unreadable'}`;
      const home = path.dirname(pkg);
      identity['esbuild-impl'] = treeDigest(path.join(home, 'lib'));
      identity['esbuild-exe'] = executableIdentity(root, path.join(home, 'bin', 'esbuild'));
      // On Linux the shipped `bin/esbuild` is a launcher and the compiler is a platform package
      // beside it. When that package resolves, ITS executable is the one that runs.
      try {
        const platformPkg = fs.realpathSync(
          createRequire(pkg).resolve(`@esbuild/${process.platform}-${process.arch}/package.json`),
        );
        identity['esbuild-platform-exe'] = executableIdentity(
          root,
          path.join(path.dirname(platformPkg), 'bin', 'esbuild'),
        );
      } catch {
        // No platform package on this install — `bin/esbuild` above is the compiler itself.
      }
    } catch {
      // Not resolvable from where tsup really lives — recorded as absent, which is itself a fact
      // the digest carries: it changes the moment an esbuild appears there.
    }
  }
  return identity;
}

/** Where an executable really lives, plus its bytes — the two things that decide what it does. */
function executableIdentity(root: string, abs: string): string {
  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch {
    return 'absent';
  }
  const where = contained(root, real) ? posix(path.relative(root, real)) : posix(real);
  return `${where}:${fileDigest(real) ?? 'unreadable'}`;
}

/** One digest over the complete build-input contract: sources, manifests, configs, toolchain. */
export function buildInputDigest(root: string = repoRoot): string {
  const entries = new Map<string, string>();
  for (const tree of SOURCE_TREES) {
    digestTree(root, tree, entries);
  }
  for (const rel of MANIFEST_FILES) {
    entries.set(rel, fileDigest(path.join(root, ...rel.split('/'))) ?? 'absent');
  }
  const hash = createHash('sha256');
  hash.update(`sthayi-build-inputs v${CONTRACT}\n`);
  for (const key of [...entries.keys()].sort()) {
    hash.update(`${JSON.stringify(key)} ${entries.get(key) as string}\n`);
  }
  const tools = toolIdentity(root);
  for (const key of Object.keys(tools).sort()) {
    hash.update(`tool ${JSON.stringify(key)} ${tools[key] as string}\n`);
  }
  return hash.digest('hex');
}

/** Every file the build produced, by path relative to `dist`, with its content digest. */
export function distOutputs(root: string = repoRoot): Record<string, string> {
  const entries = new Map<string, string>();
  digestTree(buildLayout(root).distDir, '', entries);
  const outputs: Record<string, string> = {};
  for (const key of [...entries.keys()].sort()) {
    outputs[key] = entries.get(key) as string;
  }
  return outputs;
}

interface BuildRecord {
  contract: number;
  inputs: string;
  outputs: Record<string, string>;
}

function readRecord(layout: BuildLayout): BuildRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(layout.marker, 'utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const record = parsed as Partial<BuildRecord>;
  if (record.contract !== CONTRACT) {
    return undefined;
  }
  if (typeof record.inputs !== 'string' || record.inputs === '') {
    return undefined;
  }
  if (typeof record.outputs !== 'object' || record.outputs === null) {
    return undefined;
  }
  return { contract: CONTRACT, inputs: record.inputs, outputs: record.outputs };
}

/** Same key set, same digest for every key — a missing, changed or extra file all fail this. */
function sameOutputs(recorded: Record<string, string>, found: Record<string, string>): boolean {
  const recordedKeys = Object.keys(recorded).sort();
  const foundKeys = Object.keys(found).sort();
  if (recordedKeys.length !== foundKeys.length) {
    return false;
  }
  for (let i = 0; i < recordedKeys.length; i += 1) {
    const key = recordedKeys[i] as string;
    if (key !== foundKeys[i]) {
      return false;
    }
    if (recorded[key] !== found[key]) {
      return false;
    }
  }
  return true;
}

/**
 * Whether `packages/cli/dist` is the output of a completed build of the inputs standing on disk
 * RIGHT NOW — content, not timestamps, and the output is re-proved rather than assumed.
 */
export function distIsCurrent(root: string = repoRoot): boolean {
  const layout = buildLayout(root);
  const record = readRecord(layout);
  if (record === undefined) {
    return false;
  }
  // A record with no entry point describes a build that produced nothing worth spawning.
  if (record.outputs['index.js'] === undefined) {
    return false;
  }
  if (record.inputs !== buildInputDigest(root)) {
    return false;
  }
  return sameOutputs(record.outputs, distOutputs(root));
}

/**
 * Record a build that has just succeeded — ATOMICALLY, and only inside the excluded critical
 * section (the POSIX lock holder, or the explicitly isolated pre-worker Windows CI setup).
 *
 * Written to a private name and renamed into place, because a marker is read by workers that are
 * not holding the lock: a torn write is a marker that parses as something, and something is what a
 * reader would act on. Rename is the one operation that publishes a whole file or none of it.
 */
export function recordBuild(root: string = repoRoot): void {
  const layout = buildLayout(root);
  const record: BuildRecord = {
    contract: CONTRACT,
    inputs: buildInputDigest(root),
    outputs: distOutputs(root),
  };
  const scratch = `${layout.marker}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(scratch, `${JSON.stringify(record)}\n`);
  try {
    fs.renameSync(scratch, layout.marker);
  } catch (err) {
    try {
      fs.rmSync(scratch, { force: true });
    } catch {
      // the rename failed; the scratch file is the only casualty
    }
    throw err;
  }
}

// ===================================================================================================
// THE KERNEL ADVISORY LOCK — the primitive, and how it is run.
// ===================================================================================================

/**
 * THE BUILD LOCK IS A KERNEL LOCK, NOT A PATHNAME PROTOCOL.
 *
 * `packages/cli/dist` is shared state: `tsup --clean` empties it and writes it again while fourteen
 * other test files are spawning `dist/index.js`. Exactly one builder may stand in that section.
 *
 * A lock built out of `mkdir` + an owner file + a stale-reclaim rename CANNOT deliver that. The two
 * failures are races, not bugs, and neither has a fix that stays inside the protocol:
 *
 *   (a) PATHNAME ABA. Two waiters inspect a lock at the same NAME. The first proves the owner dead
 *       and replaces it with its own LIVE lock; the second — already past its check, holding an
 *       authorisation for a name rather than for an object — renames or removes what is now a live
 *       lock and walks into the section beside its holder. Every repair of the form "look at the
 *       name again" reintroduces it, because a name is not an identity.
 *   (b) ACQUIRE→METADATA GAP. `mkdir` succeeds and the winner is descheduled before it writes its
 *       owner file. A waiter reads a lock with no owner recorded. Whatever it does next is wrong:
 *       take over, and it builds beside the paused winner; wait, and a genuinely crashed run
 *       between `mkdir` and the write wedges every future run until a human intervenes.
 *
 * Both disappear when the lock is held by the KERNEL against an open file description rather than
 * asserted by the existence of a name. A `flock(2)` lock is attached to the open file, is released
 * by the kernel when the holding process exits FOR ANY REASON — including `SIGKILL` and a reboot —
 * and is not something another process can take over, reclaim or hand to itself while the holder
 * lives. There is no owner metadata to race, no stale state, and nothing for this harness to clean
 * up by hand.
 *
 * WHAT THAT IS NOT. It is NOT a claim that the PATHNAME is beyond reach. Any process running as
 * this uid can rename or replace a writable path, and this one is deliberately writable; a rename
 * does not disturb the holder — the lock rides the inode, not the name — but a fresh file created
 * at the old name afterwards would be a second inode, and two runs on two inodes both build. That
 * is not a boundary this harness is able to build: the same process could simply write
 * `packages/cli/dist` itself, which is the outcome the lock exists to make impossible for
 * COOPERATING BUILDERS. So the enforced guarantee is stated at the scope it actually holds:
 *
 *   - waiters in this harness never unlink, reclaim, rename or replace the lock — they block in
 *     the kernel and then report that they could not get in;
 *   - the path is outside `node_modules`, so package-manager churn (`pnpm install`, a prune, an
 *     `rm -rf node_modules`) does not remove it and cannot split one lock into two inodes;
 *   - the kernel releases it the instant the holder dies, so there is never anything to reclaim.
 *
 *   Linux : flock(1) (util-linux)  — `flock -w SECONDS -E 75 FILE COMMAND...`
 *   macOS : lockf(1) (/usr/bin)    — `lockf -k -t SECONDS FILE COMMAND...`, flock(2) semantics
 *
 * This is the same primitive, chosen for the same reasons, that `scripts/freshtest.sh` already
 * holds across its build+pack section.
 *
 * DETECTION IS BY TOOL PRESENCE, NOT BY `uname`. Presence is the property that decides whether the
 * section can be serialised at all, so it is the question asked. Neither tool present ⇒ FAIL
 * CLOSED. Building unserialised is not a degraded mode of this harness; it is the defect the lock
 * exists to prevent, and a run that cannot exclude a second builder must refuse rather than guess.
 *
 * NO NEW DEPENDENCY IS INVOLVED. Node's core has no `flock(2)`/`fcntl(2)` binding, and every
 * pure-Node substitute (`open(…, 'wx')`, `mkdir`, a PID file) is a pathname protocol again — the
 * exact thing being replaced. `flock(1)`/`lockf(1)` are base-system utilities, not packages.
 */

export type LockToolKind = 'flock' | 'lockf';

export interface KernelLockTool {
  kind: LockToolKind;
  /** Absolute path to the executable — resolved here, never by a shell. */
  path: string;
}

/**
 * Absolute candidates, tried in order. Absolute rather than a PATH lookup: the executable that
 * serialises the build must not be chosen by whatever `PATH` a test run happens to carry.
 */
const TOOL_CANDIDATES: readonly KernelLockTool[] = [
  { kind: 'flock', path: '/usr/bin/flock' },
  { kind: 'flock', path: '/bin/flock' },
  { kind: 'lockf', path: '/usr/bin/lockf' },
];

function executable(abs: string): boolean {
  const st = fs.statSync(abs, { throwIfNoEntry: false });
  if (st === undefined || !st.isFile()) {
    return false;
  }
  try {
    fs.accessSync(abs, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The kernel advisory-lock tool this machine has, or `undefined` when it has none. */
export function findKernelLockTool(
  candidates: readonly KernelLockTool[] = TOOL_CANDIDATES,
): KernelLockTool | undefined {
  for (const candidate of candidates) {
    if (executable(candidate.path)) {
      return candidate;
    }
  }
  return undefined;
}

/** The message a machine with no kernel lock tool gets — a refusal, never a fallback. */
export function noLockToolMessage(): string {
  return [
    'no kernel advisory lock tool is available on this machine.',
    'The CLI build mutates packages/cli/dist, which fourteen safety files spawn, so it must be',
    'serialised; running it unserialised would let two `tsup --clean` builds empty and rewrite that',
    'directory at once, so this run refuses rather than proceeding.',
    "Expected 'flock' (Linux, util-linux) or 'lockf' (macOS, /usr/bin/lockf).",
    'Debian/Ubuntu: apt-get install util-linux   Alpine: apk add flock',
  ].join('\n          ');
}

export function requireKernelLockTool(
  candidates: readonly KernelLockTool[] = TOOL_CANDIDATES,
): KernelLockTool {
  const tool = findKernelLockTool(candidates);
  if (tool === undefined) {
    throw new Error(`sthayi build lock: ${noLockToolMessage()}`);
  }
  return tool;
}

/**
 * Both tools report "somebody else holds it" with this exit status.
 *
 * `lockf(1)` uses `EX_TEMPFAIL` (75) and offers no way to change it; `flock(1)` defaults to 1,
 * which is indistinguishable from an ordinary crash of the command, so it is given `-E 75` to
 * agree. The command run under the lock must therefore never exit 75 itself — the critical section
 * below exits 0 or a distinct code, and that is asserted rather than assumed.
 */
export const LOCK_CONFLICT_EXIT = 75;

export interface LockedRunOptions {
  lockFile: string;
  /** How long to wait for a holder before giving up. Never a forfeit: the holder is never removed. */
  waitSeconds: number;
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  tool?: KernelLockTool;
}

export interface LockedRunResult {
  /** True when the wait expired with somebody else still holding it. */
  conflict: boolean;
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  tool: KernelLockTool;
}

/**
 * Create the lock file if it is not there yet, without disturbing one that is.
 *
 * Opened `a`, never `w`: the file's CONTENT is irrelevant — the lock lives on the open file
 * description, not on anything written inside — but truncating a file another process currently
 * holds open would be a gratuitous write into shared state.
 */
export function ensureLockFile(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'a');
  fs.closeSync(fd);
}

/** The argv that hands `command` to the kernel-locked tool — split out so tests can read it. */
export function lockToolArgv(
  tool: KernelLockTool,
  lockFile: string,
  waitSeconds: number,
  command: string,
  args: readonly string[],
): string[] {
  if (tool.kind === 'flock') {
    return [
      '-w',
      String(waitSeconds),
      '-E',
      String(LOCK_CONFLICT_EXIT),
      lockFile,
      command,
      ...args,
    ];
  }
  // `-k` KEEPS the file. Without it `lockf` UNLINKS it on release, and the next invocation would
  // create and lock a different inode — two runs, two locks, both inside the section.
  return ['-k', '-t', String(waitSeconds), lockFile, command, ...args];
}

/**
 * Run `command` with the kernel lock on `lockFile` held for its ENTIRE lifetime, and released by
 * the kernel the instant that process ends, however it ends.
 *
 * The lock is held by the tool process, which is the parent of `command`; there is no window
 * between acquiring and "publishing" anything, because there is nothing to publish. No waiter in
 * this harness removes, reclaims, renames or replaces a live holder's lock: exclusion is not
 * carried by the name, and the file is never unlinked.
 *
 * THERE IS NO TIMEOUT ON THE LOCK TOOL, AND THAT IS THE WHOLE POINT.
 *
 * `spawnSync`'s `timeout` signals the process it started — here the lock TOOL, which is merely the
 * parent of the work. The result is tool-specific and neither result is a valid synchronous build
 * boundary. Measured with lockf on macOS/node 22.22, killing the wrapper released the lock while the
 * command kept running, so the next builder entered beside it. util-linux flock normally passes the
 * locked descriptor to its child instead: killing only the wrapper leaves both the command AND the
 * lock alive until the child exits. In both cases `lockedRun` has returned while work it started is
 * still executing, unobserved; only the inner work timeout can end the work while the critical
 * section still owns its lock.
 *
 * Nothing is lost by removing it, because neither half of `wait + run` was ever unbounded:
 *   - ACQUISITION is bounded by the tool itself, `-w`/`-t SECONDS`, which fails cleanly with the
 *     conflict status and leaves no work behind because no work was started;
 *   - THE WORK is bounded inside the critical section, where the bundler is run with its own
 *     180-second `execFileSync` timeout — a ceiling on the process that is actually doing the work,
 *     enforced by the lock holder, so a build that hits it dies while the lock is still held and
 *     the kernel releases the lock as the holder exits.
 *
 * A ceiling reimposed here could only be correct if it retired the ENTIRE command process group and
 * proved no descendant survived before returning. `spawnSync` cannot do that, and a timeout that
 * kills only the wrapper is not a weaker version of it — it is the defect.
 */
export function lockedRun(options: LockedRunOptions): LockedRunResult {
  const tool = options.tool ?? requireKernelLockTool();
  ensureLockFile(options.lockFile);
  const argv = lockToolArgv(
    tool,
    options.lockFile,
    options.waitSeconds,
    options.command,
    options.args,
  );
  const run = spawnSync(tool.path, argv, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    shell: false,
    maxBuffer: 32 * 1024 * 1024,
  });
  // With no timeout, the only way `spawnSync` reports an error is a failure to START the tool
  // (ENOENT, EACCES, EAGAIN). No lock was taken and no command was launched, so there is nothing
  // running to outlive this throw.
  if (run.error !== undefined) {
    throw new Error(`sthayi build lock: could not run ${tool.path}: ${String(run.error)}`);
  }
  return {
    conflict: run.status === LOCK_CONFLICT_EXIT,
    status: run.status,
    signal: run.signal,
    stdout: run.stdout ?? '',
    stderr: run.stderr ?? '',
    tool,
  };
}

// ===================================================================================================
// THE LOCK — HELD BY THE KERNEL, FOR THE LIFETIME OF THE PROCESS THAT DOES THE WORK.
// ===================================================================================================

/**
 * WHY THERE IS NO LOCK PROTOCOL IN THIS FILE ANY MORE.
 *
 * The previous lock was `mkdir` + an `owner.json` + a liveness-checked reclaim rename. It answered
 * the question "may I take this lock?" about a NAME, and a name is not an identity, so it had two
 * races that no amount of re-checking closes:
 *
 *   (a) PATHNAME ABA. Two waiters judge the same stale lock. The first reclaims it and is now a
 *       LIVE holder standing at that name; the second, carrying an authorisation minted before
 *       that happened, renames the live lock into a graveyard and builds beside its holder. The
 *       "read the owner out of the directory I moved, and put it back if it is the wrong one"
 *       repair does not fix it: the live holder's lock has already left its name, and a third
 *       waiter can `mkdir` that name during the window.
 *   (b) ACQUIRE→METADATA GAP. `mkdir` succeeds and the winner is descheduled before `owner.json`
 *       exists. There is no correct answer available to a waiter that finds an ownerless lock:
 *       taking it over builds beside the paused winner, and refusing it wedges every future run
 *       after a real crash in that window.
 *
 * The section above replaces that protocol with `flock(2)` held by `flock(1)`/`lockf(1)`
 * for the whole life of the process that does the work. There is no metadata, so there is no gap;
 * the lock is attached to an open file description rather than to a name, so a waiter has no move
 * left to make on it and this harness makes none; and the kernel drops it when the holder dies for
 * any reason, so nothing is ever "reclaimed". (A same-uid process outside the harness can still
 * rename the path — see the scope stated in the KERNEL ADVISORY LOCK section above.)
 *
 * WHAT IS UNDER THE LOCK IS THE WHOLE CRITICAL SECTION — the currency re-check, the bundler run,
 * and the atomic publication of the marker — because it all runs inside the single locked child.
 * A design that acquired here, built here and published here would have to hold the kernel lock
 * across JavaScript, which needs either a `flock(2)` binding node does not have or a helper process
 * whose own death would silently release the lock mid-build.
 */

/** How long a waiter blocks for a holder before giving up. It never displaces the holder. */
const LOCK_WAIT_SECONDS = 300;

/** Exit code the critical section uses for "the build itself failed", distinct from a lock conflict. */
export const BUILD_FAILED_EXIT = 17;

/**
 * The one explicit authority for running the build critical section without flock/lockf.
 *
 * GitHub's Windows runner has neither POSIX tool, so the Windows matrix leg prepares `dist` from
 * Vitest global setup, before any worker is dispatched. That is a genuinely serial section only
 * because one isolated Actions job owns the checkout and this flag is present on its Test step.
 * Global setup consumes the flag before Vitest captures any worker environment, so the authority
 * cannot be inherited by code running concurrently later in the job.
 * A local Windows run, another CI provider, and every POSIX run retain the ordinary fail-closed
 * `ensureBuiltCli()` path.
 */
export const ISOLATED_WINDOWS_CI_TEST_JOB_ENV = 'STHAYI_ISOLATED_WINDOWS_CI_TEST_JOB';

/** Whether this process is the one narrowly-authorised lock-free Windows CI setup process. */
export function isIsolatedWindowsCiTestJob(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return (
    platform === 'win32' &&
    env.CI === 'true' &&
    env.GITHUB_ACTIONS === 'true' &&
    env[ISOLATED_WINDOWS_CI_TEST_JOB_ENV] === '1'
  );
}

/**
 * THE CRITICAL SECTION. On POSIX it runs in the locked child. The sole other caller is
 * `prepareBuiltCliForIsolatedWindowsCi()`, which admits only the serial, pre-worker global-setup
 * phase of the isolated Windows Actions job.
 *
 * Re-checks currency first: the process that just released the lock may have built exactly what
 * this one wanted, and rebuilding it would be a second `--clean` of a directory other workers are
 * already spawning from.
 */
export function runBuildCriticalSection(): 'already-current' | 'built' {
  if (distIsCurrent()) {
    return 'already-current';
  }
  const layout = buildLayout();
  fs.mkdirSync(layout.cacheDir, { recursive: true });
  try {
    // BUILD WITH THE LOCAL BUNDLER, NEVER THROUGH THE PACKAGE MANAGER. `pnpm` on PATH is routinely
    // a Corepack shim, and Corepack's answer to "which pnpm" is to DOWNLOAD one into the invoking
    // user's home cache. A test harness that reaches for it therefore turns a hermetic offline run
    // into a network fetch, and does it inside whatever HOME the run was given. The bundler is
    // already in `node_modules`; invoking it directly needs no package manager, no shim, and no
    // network. `shell: false` throughout: the binary is resolved here, not by a shell.
    //
    // AND UNDER AN EXPLICIT ENVIRONMENT. `env` is constructed from an allowlist rather than
    // inherited, so `NODE_OPTIONS` (loaders, `--require`, import hooks) and `ESBUILD_BINARY_PATH`
    // (a different compiler entirely) cannot reach the bundler and change what it emits. Inheriting
    // them was a currency hole with no repair available at the digest end alone: the digest can
    // record that they were set, but only contracting them keeps them out of the output.
    execFileSync(process.execPath, [layout.tsupBin, '--config', layout.tsupConfig], {
      cwd: layout.cliRoot,
      stdio: 'pipe',
      timeout: 180_000,
      shell: false,
      env: bundlerEnv(),
    });
  } catch (err) {
    const e = err as { stderr?: Buffer | string; stdout?: Buffer | string };
    throw new Error(
      `building the CLI failed:\n${String(e.stdout ?? '')}\n${String(e.stderr ?? '')}`,
    );
  }
  if (!fs.existsSync(layout.distEntry)) {
    throw new Error(`build produced no ${layout.distEntry}`);
  }
  // The record is written LAST and only here: it is the statement "this dist is the output of these
  // inputs", and it must never exist for a build that did not finish. It is published by `rename`,
  // so a reader that holds nothing still sees the whole file or none of it — and it is published
  // before the exclusion boundary ends: while POSIX still holds the kernel lock, or before the
  // isolated Windows CI global setup starts any worker that could become a second builder.
  recordBuild();
  return 'built';
}

/**
 * Build and record the exact CLI before any Windows CI test worker can call `ensureBuiltCli()`.
 *
 * This does not invent a Windows pathname lock. It refuses unless all four facts that make a lock
 * unnecessary are explicit: Windows, CI, GitHub Actions, and the workflow's isolated-test-job
 * flag. Global setup calls it synchronously before Vitest dispatches collection to a worker; the checkout is
 * owned by that one job, so there can be no second cooperating builder in the section. This entry
 * point consumes the flag before workers are dispatched. The real critical-section implementation still
 * rechecks the complete input/output digest, runs the contracted bundler, and publishes the exact
 * marker last.
 */
export function prepareBuiltCliForIsolatedWindowsCi(): 'already-current' | 'built' {
  if (!isIsolatedWindowsCiTestJob()) {
    throw new Error(
      `lock-free CLI preparation is permitted only in the isolated Windows GitHub Actions test job (${ISOLATED_WINDOWS_CI_TEST_JOB_ENV}=1)`,
    );
  }
  // ONE SHOT. Remove the authority before entering the synchronous section. The flag is not a
  // build input and never reaches the bundler; consuming it here means neither a later caller nor
  // any worker environment Vitest captures after global setup can authorise another unlocked run.
  Reflect.deleteProperty(process.env, ISOLATED_WINDOWS_CI_TEST_JOB_ENV);
  return runBuildCriticalSection();
}

/** Ensure `packages/cli/dist` exists and matches the sources — building at most once, under a lock. */
export function ensureBuiltCli(): void {
  if (distIsCurrent()) {
    return;
  }
  const layout = buildLayout();
  fs.mkdirSync(layout.cacheDir, { recursive: true });
  const run = lockedRun({
    lockFile: layout.lockFile,
    waitSeconds: LOCK_WAIT_SECONDS,
    command: process.execPath,
    args: [CRITICAL_SECTION_ENTRY],
    cwd: layout.repoRoot,
    // THE CHILD IS SANITIZED, NOT INHERITED. It imports this module and runs the build, so
    // `NODE_OPTIONS` reaching it would put a loader inside the process that decides currency —
    // and the digest could never have caught that, because it covers the option TEXT and not the
    // bytes of the loader that text names. `criticalSectionEnv()` gives it the bundler allowlist
    // plus one inert digest string, which is what keeps the child's input digest equal to this
    // process's without carrying anything executable across.
    env: criticalSectionEnv(),
  });
  if (run.conflict) {
    throw new Error(
      `timed out after ${LOCK_WAIT_SECONDS}s waiting for the CLI build lock at ${layout.lockFile}. The lock is held by the kernel for the lifetime of the building process and is released automatically when it exits, so a lock still held means a build is still running.`,
    );
  }
  if (run.status !== 0) {
    throw new Error(
      `the CLI build critical section failed (status ${String(run.status)}, signal ${String(run.signal)}):\n${run.stdout}\n${run.stderr}`,
    );
  }
  if (!distIsCurrent()) {
    throw new Error(
      `the CLI build critical section reported success but ${layout.distDir} is still not current:\n${run.stdout}\n${run.stderr}`,
    );
  }
}
