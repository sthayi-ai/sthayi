import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CRITICAL_SECTION_ENTRY,
  ENV_DIGEST_RELAY,
  buildInputDigest,
  buildLayout,
  bundlerEnv,
  contractedEnvDigest,
  criticalSectionEnv,
  distIsCurrent,
  distOutputs,
  ensureBuiltCli,
  lockedRun,
  recordBuild,
} from '../helpers/build-cli.js';
import { claimToolEntry, removeOwned } from '../helpers/owned-fs.js';
import { runTempDir } from '../helpers/run-temp.js';

/**
 * SAFETY: the safety suite must never spawn a `dist` that its sources did not produce.
 *
 * Fourteen test files spawn `packages/cli/dist/index.js` and make claims about the product from
 * what it does. Every one of those claims is really a claim about whatever bytes are sitting in
 * `dist`, and it is worth nothing unless those bytes are the output of the sources standing on
 * disk. The harness decides that once, cheaply, for all of them — so the decision procedure is
 * itself a safety property, and this file is where it is held to account.
 *
 * WHY MTIMES CANNOT DECIDE IT. The old answer compared one timestamp against the newest mtime in
 * two source trees. Three separate holes, each of which produces a SILENT green:
 *
 *   1. An mtime is not a fact about content. `git checkout`, `git stash pop`, a rebase, `cp -p`,
 *      an editor that preserves timestamps, or a plain `touch -r` all leave the bytes changed and
 *      the timestamp where it was — and the comparison is one-sided anyway, able only to notice a
 *      source that became NEWER. A same-size edit with the mtime put back is invisible.
 *   2. The walked trees were not the build inputs. The bundler configs, the root manifest, the
 *      lockfile and the bundler itself all decide what comes out of `dist`, and none of them was
 *      looked at. Change a tsup config and the harness serves output built under the old one.
 *   3. The marker said a build once STARTED to finish. It said nothing about the output still
 *      being there: half a `dist` deleted, or one chunk edited by hand, still reads as current.
 *
 * INVARIANT: `dist` is current when, and only when, a completed build was recorded for exactly the
 * build inputs now on disk — content-digested, across the whole contract — and every file that
 * build produced is still present with exactly the bytes it was produced with. Nothing missing,
 * nothing altered, nothing extra.
 *
 * The fixture is a synthetic repository, not this one: proving the predicate must not mean editing
 * the sources the rest of the run is about to build.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const itPosix = it.skipIf(process.platform === 'win32');

const strays: string[] = [];

function write(root: string, rel: string, body: string): string {
  const abs = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return abs;
}

/** Plant a symlink at `rel` pointing at `target`, exactly as a vendored or aliased source would. */
function link(root: string, rel: string, target: string): string {
  const abs = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.symlinkSync(target, abs);
  return abs;
}

/**
 * Put a variable back exactly as it was — including back to ABSENT.
 *
 * `process.env.X = undefined` does not unset anything: it stores the four characters "undefined",
 * which is a different environment from the one the test started in and would leave every later
 * currency check answering about a state nobody asked for. Removing the property is the only way
 * back, and `Reflect.deleteProperty` is how it is spelled here.
 */
function restoreEnv(name: string, saved: string | undefined): void {
  if (saved === undefined) {
    Reflect.deleteProperty(process.env, name);
    return;
  }
  process.env[name] = saved;
}

/** Re-point an existing symlink without touching anything it used to reach. */
function relink(abs: string, target: string): void {
  fs.unlinkSync(abs);
  fs.symlinkSync(target, abs);
}

/** A repository shaped like this one: every input the contract names, and a plausible `dist`. */
function fakeRepo(): string {
  const root = runTempDir('sthayi-build-currency-');
  strays.push(root);
  write(root, 'package.json', '{ "name": "sthayi-workspace" }\n');
  write(root, 'pnpm-lock.yaml', 'lockfileVersion: "9.0"\n');
  write(root, 'pnpm-workspace.yaml', 'packages:\n  - packages/*\n');
  write(root, 'tsconfig.json', '{ "files": [] }\n');
  write(root, 'tsconfig.base.json', '{ "compilerOptions": {} }\n');
  write(root, 'packages/cli/package.json', '{ "name": "sthayi" }\n');
  write(root, 'packages/cli/tsconfig.json', '{ "extends": "../../tsconfig.base.json" }\n');
  write(root, 'packages/cli/tsup.config.ts', "export default { platform: 'node' };\n");
  write(root, 'packages/cli/src/index.ts', "export const greeting = 'world';\n");
  write(root, 'packages/cli/src/nested/store.ts', 'export const store = 1;\n');
  write(root, 'packages/core/package.json', '{ "name": "@sthayi/core" }\n');
  write(root, 'packages/core/tsconfig.json', '{ "extends": "../../tsconfig.base.json" }\n');
  write(root, 'packages/core/tsup.config.ts', "export default { platform: 'neutral' };\n");
  write(root, 'packages/core/src/index.ts', 'export const core = 1;\n');
  // THE TOOLCHAIN, SHAPED THE WAY IT REALLY IS. The entry point is a stub that imports a chunk
  // beside it, and esbuild is a JS wrapper over a native EXECUTABLE — because those are the two
  // places a change alters the emitted bytes while leaving the manifest and the entry untouched.
  write(root, 'node_modules/tsup/package.json', '{ "name": "tsup", "version": "8.5.1" }\n');
  write(root, 'node_modules/tsup/dist/cli-default.js', 'import "./chunk-BUNDLER.js";\n');
  write(root, 'node_modules/tsup/dist/chunk-BUNDLER.js', 'export const emit = 1;\n');
  write(root, 'node_modules/esbuild/package.json', '{ "name": "esbuild", "version": "0.27.7" }\n');
  write(root, 'node_modules/esbuild/lib/main.js', 'module.exports = { build: 1 };\n');
  write(root, 'node_modules/esbuild/bin/esbuild', '#!/usr/bin/env node\n// launcher v1\n');
  write(
    root,
    `node_modules/@esbuild/${process.platform}-${process.arch}/package.json`,
    '{ "name": "esbuild-platform", "version": "0.27.7" }\n',
  );
  write(
    root,
    `node_modules/@esbuild/${process.platform}-${process.arch}/bin/esbuild`,
    'THE-NATIVE-COMPILER-v1\n',
  );
  write(root, 'node_modules/.cache/.keep', '');
  write(root, 'packages/cli/dist/index.js', '#!/usr/bin/env node\nimport "./chunk-AAAA.js";\n');
  write(root, 'packages/cli/dist/chunk-AAAA.js', 'export const chunk = 1;\n');
  write(root, 'packages/cli/dist/index.js.map', '{ "version": 3 }\n');
  return root;
}

/** A built, recorded repository: the state every test below starts from. */
function builtRepo(): string {
  const root = fakeRepo();
  recordBuild(root);
  return root;
}

/**
 * The same repository with links in the source tree, and their targets deliberately OUTSIDE every
 * digested tree.
 *
 * A target that is itself walked would be caught by its own entry, and a test built on one would
 * pass without the link ever being followed — which is precisely how the link-text-only digest
 * survived review. `vendor/` and `vendorlib/` are in neither `SOURCE_TREES` nor `MANIFEST_FILES`,
 * so the only route to them is through the links.
 */
function builtRepoWithLinks(): string {
  const root = fakeRepo();
  write(root, 'vendor/consumed.ts', 'export const v = "CONSUMED-A";\n');
  write(root, 'vendorlib/helper.ts', 'export const h = "HELPER-A";\n');
  const up = path.join('..', '..', '..');
  link(root, 'packages/cli/src/consumed.ts', path.join(up, 'vendor', 'consumed.ts'));
  link(root, 'packages/cli/src/vendored', path.join(up, 'vendorlib'));
  // Points back at the directory it lives in, which is itself only reachable through a link.
  link(root, 'vendorlib/loop', path.join('..', 'vendorlib'));
  // Resolves to nothing today. That is a state, not an absence of one.
  link(root, 'packages/cli/src/ghost.ts', path.join(up, 'vendor', 'ghost.ts'));
  recordBuild(root);
  return root;
}

/**
 * Rewrite a file with content of the SAME LENGTH and put its timestamps back — the exact shape a
 * checkout or a timestamp-preserving copy leaves behind, and the one an mtime comparison misses.
 */
function editInPlace(abs: string, from: string, to: string): void {
  // Pinned to a fixed instant on both sides — a filesystem keeps sub-millisecond precision that a
  // JS `Date` cannot carry, so "put the timestamp back" is only exactly true against a timestamp
  // that was set from a `Date` to begin with. It is deliberately OLDER than the recorded build:
  // that is the state in which a timestamp comparison concludes there is nothing to do.
  const pinned = new Date(1_700_000_000_000);
  fs.utimesSync(abs, pinned, pinned);
  const before = fs.statSync(abs);
  const text = fs.readFileSync(abs, 'utf8');
  expect(text.includes(from), `fixture no longer contains ${from}`).toBe(true);
  expect(to.length, 'the probe must be a SAME-SIZE edit').toBe(from.length);
  fs.writeFileSync(abs, text.replace(from, to));
  fs.utimesSync(abs, pinned, pinned);
  const after = fs.statSync(abs);
  expect(after.size, 'the probe changed the file size').toBe(before.size);
  expect(after.mtimeMs, 'the probe did not restore the mtime').toBe(before.mtimeMs);
  expect(after.mtimeMs, 'the probe did not pin the mtime').toBe(pinned.getTime());
}

/**
 * Give the fixtures back through the machinery that allocated them.
 *
 * NOT `fs.rmSync(dir, { recursive: true })`. A recursive removal decides its entire walk inside the
 * call, from a name, long after the last check the caller made — one directory swapped in at that
 * name and a tidy-up becomes the loss of a foreign tree. `removeOwned` descends only through
 * directories THIS run recorded creating, and refuses (leaks) anything else, which is why every
 * fixture here comes from `runTempDir` in the first place.
 */
function wipe(): void {
  for (const dir of strays.splice(0)) {
    removeOwned(dir);
  }
}

describe('safety: the built CLI the safety suite spawns matches the sources on disk', () => {
  it('a repository that was built and left alone stays current, and says so repeatedly', () => {
    // THE CONTROL. Without it every refusal below could be a predicate that simply always says no,
    // which would be safe and would also rebuild the CLI once per test file, forever.
    const root = builtRepo();
    const first = distIsCurrent(root);
    const second = distIsCurrent(root);
    const digestA = buildInputDigest(root);
    const digestB = buildInputDigest(root);
    wipe();

    expect(first, 'a freshly recorded build is not recognised as current').toBe(true);
    expect(second, 'the answer is not stable across calls').toBe(true);
    expect(digestB, 'the input digest is not deterministic').toBe(digestA);
  });

  it('a SAME-SIZE source edit with the mtime put back is caught', () => {
    // THE DEFECT THAT MOTIVATED THE REWRITE, in the exact form it takes in practice. Under the
    // mtime comparison this file is "not newer than the marker" and the stale dist is served.
    const root = builtRepo();
    const before = buildInputDigest(root);
    editInPlace(path.join(root, 'packages', 'cli', 'src', 'index.ts'), 'world', 'WORLD');
    const after = buildInputDigest(root);
    const current = distIsCurrent(root);
    wipe();

    expect(after, 'the input digest did not notice the edit').not.toBe(before);
    expect(current, 'a same-size, same-mtime source edit was served from a stale dist').toBe(false);
  });

  it('a same-size edit in the CORE tree is caught too — core is bundled into the CLI', () => {
    const root = builtRepo();
    editInPlace(path.join(root, 'packages', 'core', 'src', 'index.ts'), 'core = 1', 'core = 2');
    const current = distIsCurrent(root);
    wipe();

    expect(current, 'a core source edit was served from a stale dist').toBe(false);
  });

  it('a source whose mtime moved but whose bytes did not is still current', () => {
    // The inverse property, and the reason the digest is over CONTENT rather than over content and
    // timestamps: a checkout that rewrites every mtime must not force a rebuild in every worker.
    const root = builtRepo();
    const src = path.join(root, 'packages', 'cli', 'src', 'index.ts');
    const later = new Date(Date.now() + 3_600_000);
    fs.utimesSync(src, later, later);
    const current = distIsCurrent(root);
    wipe();

    expect(current, 'a pure timestamp change forced a rebuild').toBe(true);
  });

  it('a change to the CLI tsup config is caught', () => {
    // Not in either source tree, and it decides target, format, externals and banner — everything
    // about the shape of the output.
    const root = builtRepo();
    write(root, 'packages/cli/tsup.config.ts', "export default { platform: 'neutral' };\n");
    const current = distIsCurrent(root);
    wipe();

    expect(current, 'the CLI bundler config is outside the build-input contract').toBe(false);
  });

  it('a change to the CORE tsup config is caught', () => {
    const root = builtRepo();
    write(root, 'packages/core/tsup.config.ts', "export default { platform: 'node' };\n");
    const current = distIsCurrent(root);
    wipe();

    expect(current, 'the core bundler config is outside the build-input contract').toBe(false);
  });

  it('a change to the lockfile is caught', () => {
    // A dependency moving underneath the build changes the emitted bytes without any source edit.
    const root = builtRepo();
    write(root, 'pnpm-lock.yaml', 'lockfileVersion: "9.0"\n# a dependency moved\n');
    const current = distIsCurrent(root);
    wipe();

    expect(current, 'the lockfile is outside the build-input contract').toBe(false);
  });

  it('a change to the root manifest is caught', () => {
    const root = builtRepo();
    write(root, 'package.json', '{ "name": "sthayi-workspace", "type": "module" }\n');
    const current = distIsCurrent(root);
    wipe();

    expect(current, 'the root manifest is outside the build-input contract').toBe(false);
  });

  it('a change to the BUNDLER ITSELF is caught', () => {
    // The same sources through a different tsup are different bytes. Nothing in the repository
    // changes when this happens — only what `node_modules` resolves to.
    const root = builtRepo();
    write(root, 'node_modules/tsup/package.json', '{ "name": "tsup", "version": "8.6.0" }\n');
    const versionBump = distIsCurrent(root);
    write(root, 'node_modules/tsup/package.json', '{ "name": "tsup", "version": "8.5.1" }\n');
    const restored = distIsCurrent(root);
    write(root, 'node_modules/tsup/dist/cli-default.js', '// a patched bundler entry point\n');
    const patchedEntry = distIsCurrent(root);
    wipe();

    expect(versionBump, 'a bundler version bump is outside the build-input contract').toBe(false);
    expect(restored, 'restoring the bundler did not restore currency').toBe(true);
    expect(patchedEntry, 'the bundler entry point is outside the build-input contract').toBe(false);
  });

  it('a manifest file that is DELETED is caught, not skipped', () => {
    // An absent input is recorded as absent, so removing one is a change like any other. A
    // predicate that simply skips what it cannot read would call this state current.
    const root = builtRepo();
    fs.rmSync(path.join(root, 'tsconfig.base.json'));
    const current = distIsCurrent(root);
    wipe();

    expect(current, 'deleting a build input left the dist looking current').toBe(false);
  });

  it('a new source file is caught', () => {
    const root = builtRepo();
    write(root, 'packages/cli/src/nested/extra.ts', 'export const extra = 1;\n');
    const current = distIsCurrent(root);
    wipe();

    expect(current, 'a new source file left the dist looking current').toBe(false);
  });

  it('a MISSING dist output is caught', () => {
    // The marker records that a build finished; it cannot record that its output is still there.
    const root = builtRepo();
    fs.rmSync(path.join(root, 'packages', 'cli', 'dist', 'chunk-AAAA.js'));
    const current = distIsCurrent(root);
    wipe();

    expect(current, 'half a dist was accepted as a complete build').toBe(false);
  });

  it('an ALTERED dist output is caught', () => {
    const root = builtRepo();
    write(root, 'packages/cli/dist/chunk-AAAA.js', 'export const chunk = 2;\n');
    const current = distIsCurrent(root);
    wipe();

    expect(current, 'a hand-edited chunk was accepted as build output').toBe(false);
  });

  it('an EXTRA file in dist is caught', () => {
    // `clean: true` means the build owns the directory outright. A file the build did not write is
    // either a leftover from a different build or something nobody can account for; either way the
    // directory is no longer the output of the recorded build.
    const root = builtRepo();
    write(root, 'packages/cli/dist/chunk-BBBB.js', 'export const stray = 1;\n');
    const current = distIsCurrent(root);
    wipe();

    expect(current, 'an unaccounted file in dist was accepted').toBe(false);
  });

  it('a dist that is gone entirely is caught', () => {
    const root = builtRepo();
    fs.rmSync(path.join(root, 'packages', 'cli', 'dist'), { recursive: true });
    const outputs = distOutputs(root);
    const current = distIsCurrent(root);
    wipe();

    expect(outputs, 'a missing dist should enumerate nothing').toEqual({});
    expect(current, 'a missing dist was accepted as current').toBe(false);
  });

  it('with no record at all, nothing is current', () => {
    const root = fakeRepo(); // built-looking dist, but no build was ever recorded here
    const current = distIsCurrent(root);
    wipe();

    expect(current, 'a dist of unknown provenance was accepted').toBe(false);
  });

  it('a record that is truncated, foreign or of an older contract is not believed', () => {
    const root = builtRepo();
    const marker = path.join(root, 'node_modules', '.cache', 'sthayi-test-build.manifest.json');
    const good = fs.readFileSync(marker, 'utf8');

    fs.writeFileSync(marker, good.slice(0, Math.floor(good.length / 2)));
    const truncated = distIsCurrent(root);

    // The shape the OLD harness wrote: a bare timestamp. It must not read as anything.
    fs.writeFileSync(marker, `${Date.now()}`);
    const legacy = distIsCurrent(root);

    const parsed = JSON.parse(good) as { contract: number };
    fs.writeFileSync(marker, JSON.stringify({ ...parsed, contract: parsed.contract - 1 }));
    const olderContract = distIsCurrent(root);

    fs.writeFileSync(marker, JSON.stringify({ ...parsed, outputs: {} }));
    const noEntryPoint = distIsCurrent(root);

    fs.writeFileSync(marker, good);
    const restored = distIsCurrent(root);
    wipe();

    expect(truncated, 'a torn record was believed').toBe(false);
    expect(legacy, "the old marker's bare timestamp was believed").toBe(false);
    expect(olderContract, 'a record from an older contract was believed').toBe(false);
    expect(noEntryPoint, 'a record describing no entry point was believed').toBe(false);
    expect(restored, 'the fixture did not survive its own probes').toBe(true);
  });

  it('the record is published whole or not at all', () => {
    // Written by the lock holder and read by workers that hold nothing, so a half-written record is
    // a record somebody acts on. Nothing but the finished file may ever appear at that name.
    const root = fakeRepo();
    const cache = path.join(root, 'node_modules', '.cache');
    recordBuild(root);
    const leftovers = fs.readdirSync(cache).filter((e) => e.endsWith('.tmp'));
    const current = distIsCurrent(root);
    wipe();

    expect(leftovers, 'a scratch file was left beside the record').toEqual([]);
    expect(current, 'the published record does not describe the build').toBe(true);
  });

  // -----------------------------------------------------------------------------------------
  // SYMLINKS — the bytes the bundler CONSUMES through a link, not the text of the link.
  // -----------------------------------------------------------------------------------------
  //
  // The digest used to record `sha256(readlink(path))` and stop there. That is a fact about the
  // link, not about the build: the bundler reads THROUGH it, so editing the target changed what
  // came out of `dist` while the link text — and therefore the whole input digest — stayed
  // byte-for-byte identical, and `distIsCurrent()` went on answering true. It is the same silent
  // green this file was written to abolish, arriving one indirection later.
  //
  // The targets below sit OUTSIDE both digested source trees on purpose. A target that is itself
  // walked would be caught by its own entry, and the test would pass without the link ever being
  // followed — which is exactly how this hole survived.

  it('a symlink TARGET whose bytes change is caught, though the link text never moves', () => {
    const root = builtRepoWithLinks();
    const target = path.join(root, 'vendor', 'consumed.ts');
    const linkPath = path.join(root, 'packages', 'cli', 'src', 'consumed.ts');
    const linkTextBefore = fs.readlinkSync(linkPath);
    const before = buildInputDigest(root);

    editInPlace(target, 'CONSUMED-A', 'CONSUMED-B');
    const afterEdit = buildInputDigest(root);
    const stale = distIsCurrent(root);
    const linkTextAfter = fs.readlinkSync(linkPath);

    editInPlace(target, 'CONSUMED-B', 'CONSUMED-A');
    const restoredDigest = buildInputDigest(root);
    const restored = distIsCurrent(root);
    wipe();

    expect(linkTextAfter, 'the probe changed the link instead of its target').toBe(linkTextBefore);
    expect(afterEdit, 'the input digest did not follow the link to the bytes behind it').not.toBe(
      before,
    );
    expect(stale, 'bytes consumed through an unchanged link were served from a stale dist').toBe(
      false,
    );
    expect(restoredDigest, 'restoring the exact bytes did not restore the digest').toBe(before);
    expect(restored, 'restoring the exact bytes did not restore currency').toBe(true);
  });

  it('re-pointing a symlink at IDENTICAL bytes is still a change', () => {
    // The other direction, and the reason the link text is kept as well as followed: two files can
    // hold the same bytes today and diverge tomorrow, so which one is being read is itself an input.
    const root = builtRepoWithLinks();
    const linkPath = path.join(root, 'packages', 'cli', 'src', 'consumed.ts');
    write(
      root,
      'vendor/twin.ts',
      fs.readFileSync(path.join(root, 'vendor', 'consumed.ts'), 'utf8'),
    );
    recordBuild(root); // the twin is a new file outside the trees; re-record so only the link moves

    relink(linkPath, path.join('..', '..', '..', 'vendor', 'twin.ts'));
    const repointed = distIsCurrent(root);
    relink(linkPath, path.join('..', '..', '..', 'vendor', 'consumed.ts'));
    const restored = distIsCurrent(root);
    wipe();

    expect(repointed, 'a link re-pointed at a different file was not a change').toBe(false);
    expect(restored, 'putting the link back did not restore currency').toBe(true);
  });

  it('a symlinked DIRECTORY is walked, and a file inside it is caught', () => {
    const root = builtRepoWithLinks();
    const inside = path.join(root, 'vendorlib', 'helper.ts');

    editInPlace(inside, 'HELPER-A', 'HELPER-B');
    const stale = distIsCurrent(root);
    editInPlace(inside, 'HELPER-B', 'HELPER-A');
    const restored = distIsCurrent(root);
    wipe();

    expect(stale, 'a file reached through a linked directory was outside the contract').toBe(false);
    expect(restored, 'restoring the exact bytes did not restore currency').toBe(true);
  });

  it('a symlink CYCLE terminates and is deterministic, rather than hanging the digest', () => {
    // Following links is only safe if a loop is a bounded outcome. `vendorlib/loop` points back at
    // the directory it lives in, which is reached through a link in the first place.
    const root = builtRepoWithLinks();
    const first = buildInputDigest(root);
    const second = buildInputDigest(root);
    const current = distIsCurrent(root);
    wipe();

    expect(first, 'a symlink cycle did not produce a digest').toMatch(/^[0-9a-f]{64}$/);
    expect(second, 'a symlink cycle made the digest non-deterministic').toBe(first);
    expect(current, 'the fixture with a cycle in it is not recognised as built').toBe(true);
  });

  it('a DANGLING symlink is recorded, and becomes a change the moment it resolves', () => {
    // Recorded as unresolvable rather than skipped: "there is nothing there" and "there is now a
    // file there" are different inputs, and a predicate that ignores what it cannot read would call
    // the second one current.
    const root = builtRepoWithLinks();
    write(root, 'vendor/ghost.ts', 'export const ghost = 1;\n');
    const appeared = distIsCurrent(root);
    fs.rmSync(path.join(root, 'vendor', 'ghost.ts'));
    const gone = distIsCurrent(root);
    wipe();

    expect(appeared, 'a dangling link that started resolving was not a change').toBe(false);
    expect(gone, 'removing the target again did not restore currency').toBe(true);
  });

  // -----------------------------------------------------------------------------------------
  // THE TOOLCHAIN — the implementation that runs, not the file that happens to be the entry.
  // -----------------------------------------------------------------------------------------

  it('a tsup CHUNK imported by the entry is caught, though the entry is byte-identical', () => {
    // `tsup/dist/cli-default.js` is a stub that imports chunks beside it; every line that decides
    // what comes out of the bundler is in those chunks. Digesting the entry alone therefore said
    // nothing about the bundler at all — patch a chunk and the build changed while the identity did
    // not. The identity is over the resolved implementation TREE for exactly that reason.
    const root = builtRepo();
    const entry = path.join(root, 'node_modules', 'tsup', 'dist', 'cli-default.js');
    const chunk = path.join(root, 'node_modules', 'tsup', 'dist', 'chunk-BUNDLER.js');
    const entryBefore = fs.readFileSync(entry);

    editInPlace(chunk, 'emit = 1', 'emit = 2');
    const stale = distIsCurrent(root);
    const entryAfter = fs.readFileSync(entry);

    editInPlace(chunk, 'emit = 2', 'emit = 1');
    const restored = distIsCurrent(root);
    wipe();

    expect(entryAfter.equals(entryBefore), 'the probe changed the entry, not a chunk').toBe(true);
    expect(stale, 'a patched bundler chunk was outside the toolchain identity').toBe(false);
    expect(restored, 'restoring the chunk did not restore currency').toBe(true);
  });

  it('the esbuild IMPLEMENTATION and its EXECUTABLE are both caught', () => {
    // esbuild's `package.json` says nothing about `lib/main.js`, and `lib/main.js` says nothing
    // about the native binary that does the compiling — which is a separate file, is what
    // `ESBUILD_BINARY_PATH` would substitute, and is the thing whose bytes decide the output.
    const root = builtRepo();
    const lib = path.join(root, 'node_modules', 'esbuild', 'lib', 'main.js');
    const launcher = path.join(root, 'node_modules', 'esbuild', 'bin', 'esbuild');
    const native = path.join(
      root,
      'node_modules',
      '@esbuild',
      `${process.platform}-${process.arch}`,
      'bin',
      'esbuild',
    );

    editInPlace(lib, 'build: 1', 'build: 2');
    const staleLib = distIsCurrent(root);
    editInPlace(lib, 'build: 2', 'build: 1');
    const afterLib = distIsCurrent(root);

    editInPlace(launcher, 'launcher v1', 'launcher v2');
    const staleLauncher = distIsCurrent(root);
    editInPlace(launcher, 'launcher v2', 'launcher v1');
    const afterLauncher = distIsCurrent(root);

    editInPlace(native, 'COMPILER-v1', 'COMPILER-v2');
    const staleNative = distIsCurrent(root);
    editInPlace(native, 'COMPILER-v2', 'COMPILER-v1');
    const afterNative = distIsCurrent(root);
    wipe();

    expect(staleLib, 'the esbuild implementation was outside the toolchain identity').toBe(false);
    expect(afterLib, 'restoring the esbuild implementation did not restore currency').toBe(true);
    expect(staleLauncher, 'the esbuild launcher was outside the toolchain identity').toBe(false);
    expect(afterLauncher, 'restoring the esbuild launcher did not restore currency').toBe(true);
    expect(staleNative, 'the esbuild EXECUTABLE was outside the toolchain identity').toBe(false);
    expect(afterNative, 'restoring the esbuild executable did not restore currency').toBe(true);
  });

  // -----------------------------------------------------------------------------------------
  // THE ENVIRONMENT — contracted out of the build, and recorded so a stale dist is not reused.
  // -----------------------------------------------------------------------------------------

  it('an output-affecting environment variable makes the dist not current', () => {
    // `NODE_OPTIONS` injects loaders, `--require` and import hooks into the node that runs the
    // bundler; `ESBUILD_BINARY_PATH` replaces the compiler outright. Both used to be inherited
    // wholesale and neither appeared anywhere in the digest, so a `dist` produced under one was
    // reused, unquestioned, by a run without it. Recording them is over-inclusion by design: an
    // unnecessary rebuild costs seconds, a wrongly-current `dist` costs a green suite about bytes
    // nobody produced.
    const root = builtRepo();
    const savedOptions = process.env.NODE_OPTIONS;
    const savedBinary = process.env.ESBUILD_BINARY_PATH;

    process.env.NODE_OPTIONS = '--require ./instrument.js';
    const withOptions = distIsCurrent(root);
    process.env.NODE_OPTIONS = '--require ./other.js';
    const withDifferentOptions = buildInputDigest(root);
    process.env.NODE_OPTIONS = '--require ./instrument.js';
    const sameAgain = buildInputDigest(root);
    restoreEnv('NODE_OPTIONS', savedOptions);
    const restoredOptions = distIsCurrent(root);

    process.env.ESBUILD_BINARY_PATH = '/somewhere/else/esbuild';
    const withBinary = distIsCurrent(root);
    restoreEnv('ESBUILD_BINARY_PATH', savedBinary);
    const restoredBinary = distIsCurrent(root);
    wipe();

    expect(withOptions, 'a dist built without NODE_OPTIONS was reused under one').toBe(false);
    expect(withDifferentOptions, 'two different NODE_OPTIONS digested the same').not.toBe(
      sameAgain,
    );
    expect(restoredOptions, 'restoring the exact environment did not restore currency').toBe(true);
    expect(withBinary, 'a dist built with one esbuild was reused under another').toBe(false);
    expect(restoredBinary, 'restoring the exact environment did not restore currency').toBe(true);
  });

  it('the bundler is handed an EXPLICIT environment, with the dangerous variables removed', () => {
    // Recording them is not enough on its own — recording says "this dist came from somewhere
    // else", and only contracting them keeps the ambient environment out of the OUTPUT. An
    // allowlist rather than a denylist: a denylist is a guess about what is dangerous, and the
    // guess is wrong the day a tool grows a new knob.
    const dangerous = {
      NODE_OPTIONS: '--require ./instrument.js',
      NODE_PATH: '/opt/shims',
      NODE_ENV: 'production',
      ESBUILD_BINARY_PATH: '/somewhere/else/esbuild',
      ESBUILD_WORKER_THREADS: '0',
    };
    const env = bundlerEnv({ ...dangerous, PATH: '/usr/bin', HOME: '/home/x', CI: 'true' });

    for (const name of Object.keys(dangerous)) {
      expect(
        env[name],
        `${name} reached the bundler and could change what it emits`,
      ).toBeUndefined();
    }
    expect(env.PATH, 'the bundler was given no PATH and could not spawn anything').toBe('/usr/bin');
    expect(env.HOME, 'the bundler was given no HOME').toBe('/home/x');
    expect(env.CI, 'the environment is a denylist, not an allowlist').toBeUndefined();
    // ...and the bundler really is launched with it, rather than inheriting this process's.
    const src = fs.readFileSync(path.join(repoRoot, 'tests', 'helpers', 'build-cli.ts'), 'utf8');
    const launches = src.split('execFileSync(').length - 1;
    expect(launches, 'the harness gained a second bundler launch this rule does not cover').toBe(1);
    expect(
      /execFileSync\([\s\S]{0,600}?env: bundlerEnv\(\)/.test(src),
      'the bundler is launched with an inherited environment',
    ).toBe(true);
  });

  // -----------------------------------------------------------------------------------------
  // THE CRITICAL-SECTION CHILD — the process that DECIDES currency and then produces `dist`.
  // -----------------------------------------------------------------------------------------
  //
  // Contracting the bundler's environment was only half the job, and the smaller half. The
  // bundler is a GRANDCHILD; between it and this process stands the locked child that imports
  // this module, evaluates `distIsCurrent()`, runs the build and publishes the marker. That
  // child used to be handed `process.env` wholesale, for a reason that was true as far as it
  // went — its input digest has to equal the parent's — and the cost was that `NODE_OPTIONS`
  // put a loader, an import hook or a `--require` inside the very process that decides what
  // `dist` is.
  //
  // AND CURRENCY COULD NOT HAVE CAUGHT IT. The digest records `sha256(NODE_OPTIONS)` — the TEXT.
  // It says nothing about the bytes of the loader that text names, and it cannot: the loader can
  // live anywhere, and can be written after the digest is taken. So the option string could stand
  // still while the code running inside the critical section was replaced outright. That is the
  // symlink hole one level further out, and the repair is the same shape as the one made for the
  // bundler — the variable does not reach the child at all, which makes those bytes IRRELEVANT to
  // the build rather than merely unwatched.

  /** `--import`, spelled the way `NODE_OPTIONS` wants it, with the path quoted. */
  function importHook(file: string): string {
    return `--import ${JSON.stringify(`file://${file}`)}`;
  }

  /** A REAL import hook: it announces that it ran, and then stops the process it ran in. */
  function writeHook(file: string, marker: string, tag: string): void {
    fs.writeFileSync(
      file,
      `import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(marker)}, 'EXECUTED ${tag} in pid ' + process.pid + '\\n');
process.exit(9);
`,
    );
  }

  itPosix(
    'a REAL loader named by NODE_OPTIONS never executes in the critical-section child',
    () => {
      // THE LOAD-BEARING PROOF, and it runs the REAL critical section: the real entry, under the
      // real POSIX kernel lock, with the environment `criticalSectionEnv()` really builds for it.
      // Windows has no flock/lockf and therefore cannot run this lock-mechanics probe; its static
      // child-environment/currency assertions below remain active, and the hosted Windows job proves
      // the pre-worker exact-build path by running every built-CLI product suite without a rebuild.
      const dir = runTempDir('sthayi-critical-env-');
      strays.push(dir);
      const hook = path.join(dir, 'hook.mjs');
      const sanitizedMarker = path.join(dir, 'ran-in-sanitized-child.txt');
      const inheritedMarker = path.join(dir, 'ran-in-inherited-child.txt');
      const layout = buildLayout();

      // The child answers `already-current` only if it agreed with this process about the inputs, so
      // the run has to start from a `dist` this process considers current.
      ensureBuiltCli();

      // A hostile AMBIENT environment — the thing a developer, a CI runner or a wrapper script
      // actually has set — and the child environment the harness derives from it.
      const hostile = { ...process.env, NODE_OPTIONS: importHook(hook) };
      const childEnv = criticalSectionEnv(hostile);
      // One deliberate substitution, and it is NOT about the loader: the relayed digest is set to
      // THIS process's real ambient answer, so the child finds `dist` current and does not rebuild it
      // underneath the fourteen other files that are spawning `dist/index.js`. `NODE_OPTIONS` is
      // untouched by it — `criticalSectionEnv` had already dropped it before this line.
      childEnv[ENV_DIGEST_RELAY] = contractedEnvDigest(process.env);

      const runChild = (env: NodeJS.ProcessEnv) =>
        lockedRun({
          lockFile: layout.lockFile,
          waitSeconds: 300,
          command: process.execPath,
          args: [CRITICAL_SECTION_ENTRY],
          cwd: layout.repoRoot,
          env,
        });

      writeHook(hook, sanitizedMarker, 'A');
      const digestWithHookA = buildInputDigest();
      const withHookA = runChild(childEnv);

      // THE SAME OPTION TEXT, A COMPLETELY DIFFERENT LOADER. This is the mutation the digest cannot
      // see, and the one that used to change what the critical section did.
      writeHook(hook, sanitizedMarker, 'B-ENTIRELY-DIFFERENT-BYTES-AND-BEHAVIOUR');
      const digestWithHookB = buildInputDigest();
      const withHookB = runChild(childEnv);
      const everRanInChild = fs.existsSync(sanitizedMarker);

      // THE CONTROL, and without it every line above would be satisfied by a hook that simply does
      // not work. Same hook, same entry, same lock — handed the INHERITED environment instead.
      writeHook(hook, inheritedMarker, 'CONTROL');
      const inherited = runChild(hostile);
      const ranInInheritedChild = fs.existsSync(inheritedMarker);
      // This control deliberately replaces the recorder preload with the hostile hook. Claim the
      // one exact file that external child was asked to fill so identity-aware teardown can remove
      // it without granting authority over anything else in the fixture.
      claimToolEntry(inheritedMarker);
      wipe();

      expect(
        ranInInheritedChild,
        'the hook cannot execute at all — the proof would be vacuous',
      ).toBe(true);
      expect(
        inherited.status,
        'the inherited-environment child did not stop where the injected hook stops it',
      ).toBe(9);

      expect(everRanInChild, 'an injected loader EXECUTED inside the critical-section child').toBe(
        false,
      );
      expect(withHookA.status, `the critical section failed: ${withHookA.stderr}`).toBe(0);
      expect(withHookB.status, `the critical section failed: ${withHookB.stderr}`).toBe(0);
      // Changing the loader's bytes changed nothing about the build — and the child said so itself,
      // by re-deciding currency from the inputs rather than being told the answer.
      expect(withHookA.stdout.trim(), 'the child did not agree that the dist was current').toBe(
        'already-current',
      );
      expect(
        withHookB.stdout.trim(),
        'a different loader changed what the critical section did',
      ).toBe('already-current');
      // The digest is identical across the two, and that is now HONEST rather than a hole: the loader
      // cannot reach the process that builds, so its bytes are not an input to anything.
      expect(digestWithHookB, 'the option text was not held still by this probe').toBe(
        digestWithHookA,
      );
    },
  );

  it('the critical-section child is given an explicit environment with nothing executable in it', () => {
    // The same argument as the bundler's allowlist, one process earlier — plus the one addition
    // that keeps parent and child agreeing, which has to be inert or it is just the hole again.
    const hostile = {
      PATH: '/usr/bin',
      HOME: '/home/x',
      CI: 'true',
      NODE_OPTIONS: '--require ./instrument.js',
      NODE_PATH: '/opt/shims',
      NODE_ENV: 'production',
      ESBUILD_BINARY_PATH: '/somewhere/else/esbuild',
      ESBUILD_WORKER_THREADS: '0',
    };
    const env = criticalSectionEnv(hostile);

    for (const name of [
      'NODE_OPTIONS',
      'NODE_PATH',
      'NODE_ENV',
      'ESBUILD_BINARY_PATH',
      'ESBUILD_WORKER_THREADS',
    ]) {
      expect(
        env[name],
        `${name} reached the process that decides currency and runs the build`,
      ).toBeUndefined();
    }
    expect(env.PATH, 'the child was given no PATH and could not launch the bundler').toBe(
      '/usr/bin',
    );
    expect(env.CI, "the child's environment is a denylist, not an allowlist").toBeUndefined();
    // EXACTLY ONE thing crosses the boundary beyond the allowlist, and it is a digest.
    const extra = Object.keys(env).filter((k) => !(k in bundlerEnv(hostile)));
    expect(
      extra,
      'something other than the digest relay was added to the child environment',
    ).toEqual([ENV_DIGEST_RELAY]);
    expect(
      env[ENV_DIGEST_RELAY],
      'the relayed value is not the inert digest it is supposed to be',
    ).toMatch(/^(?:none|[0-9a-f]{64})$/);
    // …and it cannot act as a node option. Node reads `NODE_OPTIONS`, `NODE_PATH`, `NODE_REPL_*`
    // and friends; a name outside that set is data. Nothing here even looks like a flag.
    expect(ENV_DIGEST_RELAY.startsWith('STHAYI_'), 'the relay borrowed a name node reads').toBe(
      true,
    );
    expect(String(env[ENV_DIGEST_RELAY]), 'the relayed value carries option syntax').not.toMatch(
      /[-\s"'=/\\]/,
    );

    // …and the locked child really is launched with it, rather than with an inherited environment.
    const src = fs.readFileSync(path.join(repoRoot, 'tests', 'helpers', 'build-cli.ts'), 'utf8');
    expect(
      /lockedRun\(\{[\s\S]{0,900}?env: criticalSectionEnv\(\)/.test(src),
      'the critical-section child is launched with an environment this rule does not cover',
    ).toBe(true);
    expect(src, 'an inherited environment is handed to a child again').not.toMatch(
      /env: process\.env/,
    );
  });

  it('the relayed digest keeps parent and child agreeing, and nobody else believes it', () => {
    // WHY IT IS RELAYED AT ALL. A sanitized child has none of the output-affecting variables — that
    // is the point of sanitizing it — so it would compute `none` while its parent computed
    // something else, they would never agree that `dist` is current, and every worker would rebuild
    // forever. The child is therefore told the parent's ANSWER, which is a digest and not a lever.
    const ambient = {
      NODE_OPTIONS: '--require ./instrument.js',
      ESBUILD_BINARY_PATH: '/somewhere/else/esbuild',
    };
    const notTheChild = [process.execPath, path.join(repoRoot, 'anything-else.mjs')];
    const theChild = [process.execPath, CRITICAL_SECTION_ENTRY];

    const parent = contractedEnvDigest(ambient, notTheChild);
    const child = contractedEnvDigest(criticalSectionEnv(ambient), theChild);
    expect(parent, 'the ambient environment was not digested at all').not.toBe('none');
    expect(
      child,
      'the sanitized child could never agree with its parent about the environment',
    ).toBe(parent);

    // AND THE RELAY IS NOT A WAY TO LIE ABOUT YOUR OWN ENVIRONMENT. Any other process reads the
    // environment it is actually running in; a stray variable is not authority.
    expect(
      contractedEnvDigest({ [ENV_DIGEST_RELAY]: 'a'.repeat(64) }, notTheChild),
      'an ordinary worker believed a relayed digest and reported an environment it was not in',
    ).toBe('none');
    // Not even in the child, when something output-affecting is genuinely set: the environment
    // standing in front of it wins over anything it was told.
    expect(
      contractedEnvDigest({ ...ambient, [ENV_DIGEST_RELAY]: 'a'.repeat(64) }, theChild),
      'a relayed digest overrode an environment that was really there',
    ).toBe(parent);
    // …and a value that is not the shape this harness mints is recomputed, never passed through.
    expect(
      contractedEnvDigest({ [ENV_DIGEST_RELAY]: '--require ./instrument.js' }, theChild),
      'an arbitrary string was carried into the input digest',
    ).toBe('none');
  });
});
