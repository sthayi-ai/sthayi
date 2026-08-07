// WHAT THE RELEASE TARBALL CONTAINS, CHECKED AGAINST THE ARCHIVE ITSELF.
//
// The claim "the tarball ships dist/, prompts/, README.md and LICENSE" used to live in a release
// checklist, where it was a sentence a human ticked. A `files` allowlist that stops shipping a
// prompt is invisible to every source-driven test in this repo — the file is on the developer's
// disk and absent from the user's install — so the claim is settled HERE, against the bytes that
// were just packed, before anything is checksummed, uploaded or published.
//
// TWO MODES, AND THE ORDER BETWEEN THEM IS THE WHOLE POINT.
//
//   --snapshot <contract.json> [--repo <dir>]   capture the RELEASE CONTRACT from the repository
//   <tarball.tgz> --contract <contract.json>    settle one archive against that contract
//
// `npm pack` RUNS THE PACKAGE LIFECYCLE unless it is told not to. A `prepack` script is arbitrary
// code with write access to the checkout AND to `$RUNNER_TEMP`, so a verifier that derives its
// expectations from the working tree AFTER the pack is comparing the archive to whatever that code
// decided the working tree should say. Rewrite `dist/index.js` and the source it is checked against
// in the same script and the substitute is compared to itself. So the contract is captured ONCE —
// immediately after the build the tests ran against, and BEFORE anything packs — and the archive is
// settled against that captured file. There is deliberately NO fallback to the live tree at verify
// time: a fallback is the hole.
//
// AND THE CAPTURE ALONE IS NOT ENOUGH, WHICH IS WHY THE RELEASE PACKS NO LIFECYCLE AT ALL. Writing
// the contract under `$RUNNER_TEMP` does not make it immutable — that directory is ordinary,
// writable runner state, and a `prepack` inheriting `RUNNER_TEMP` can rewrite a packed file AND
// recompute this contract's digest for it in one go, at which point every comparison below is
// between a substitute and itself. `.github/workflows/release.yml` therefore packs ONCE, from a
// newly created staging tree, with `npm pack --ignore-scripts`, and pins the sha256 of this contract
// and of the enforcing scripts as immutable step outputs BEFORE the pack, re-asserting them after
// it. `scripts/stage-release-package.mjs` builds and settles that stage.
//
// WHAT IS CONTRACTED IS DERIVED, NOT LISTED. The entry points come from the package manifest, and
// the prompt pack comes from the CLI source: `oracle/prompts.ts` names the ops a prompt may be
// loaded for, `oracle/qualify.ts` names the ops `qualify` actually runs, and every fixture file
// sitting in the pack for those ops is a case `qualify` will execute. A prompt added to the source
// therefore becomes a required tarball entry with no edit here.
//
// THE CONTRACTED TREES ARE EXACT SETS, NOT MINIMA. `dist/` and `prompts/` are compared as whole
// trees — the same path set, byte for byte. "Every required file is present" is not the property
// that matters: `loadFixtures` reads EVERY `.json` in `prompts/fixtures/<op>`, so one extra file
// there is one extra case `qualify` executes, and one extra `dist/*.js` is one more module the
// installed package can load. Neither is missing anything; both change what runs on the user's
// machine. Extra members in those trees are refused for that reason.
//
// AND THE ARCHIVE AS A WHOLE IS AN EXACT SET, NOT JUST THOSE TREES. The release packs a STAGING
// tree, so the interval between "the stage is settled" and "the archive exists" is a real boundary
// a member can be written across, and the scoped rules above do not cover the package ROOT: a file
// there that is not Markdown, not under a contracted tree and not on the deny-list used to ride
// along unnamed. `npm pack` makes that concrete rather than theoretical — it ALWAYS ships a root
// README/LICENSE/LICENCE/NOTICE in whatever spelling it finds, `files` allowlist or not, so
// `package/README` and `package/README.md` are two different published files and only one of them
// was ever reviewed. The complete set of REGULAR members must therefore equal `contract.files` plus
// `package.json` exactly, in both directions.
//
// THE PACKED MANIFEST IS CHECKED SEMANTICALLY, NOT BYTEWISE. `package.json` decides what executes:
// `bin` and `main` name what runs, `scripts` can name what runs AT INSTALL TIME, and the dependency
// maps name what gets fetched. It is the one contracted file that may legitimately be re-serialised
// on the way into the archive, so it is parsed as strict UTF-8 and compared field by field against
// the manifest the contract captured. Every entry point the PACKED manifest names is required to be
// in the archive, so a manifest pointing at a file the release does not ship cannot pass.
//
// HOW IT READS THE ARCHIVE. It parses the tar stream in-process (`tar-stream` over `zlib`) and
// NEVER EXTRACTS. That is not a convenience: a verifier that shells out to `tar -tzf` is reading a
// rendering of the archive rather than the archive. Listing output trims names, hides member type,
// and collapses two members onto one line, so a required entry could be a SYMLINK to somewhere
// else, a HARD LINK, a DUPLICATE, or a name with a trailing space, and the listing would look
// correct. Extracting first is worse still: whatever survives on disk is what the extractor chose
// to write, links included, and the check then follows them. Every rule below is applied to the
// RAW HEADER and the RAW MEMBER BYTES, before anything could be written anywhere. Nothing is
// spawned and no shell is involved at any point.
//
// WHAT IT DOES NOT CLAIM. `dist/*.js.map` is shipped by the package as it stands, and a tsup
// sourcemap carries `sourcesContent` — the TypeScript is inside the map. The rejection below is
// therefore precisely "no source FILE is an entry in this archive", not "no source text ships".
// Narrowing that is a packaging decision (tsup `sourcemap`, or the manifest's `files`), not a
// decision this script may make on its own, and the allowance is spelled out rather than implied.
// A map's STRUCTURAL fields (`sources`, `sourceRoot`, `file`) must stay relative and free of
// build-machine paths; its `sourcesContent` is source text, which legitimately discusses absolute
// paths in prose, and is held only to the secret-value scan every member gets.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { extract } from 'tar-stream';

const problems = [];
const fail = (msg) => problems.push(msg);

/** npm packs everything under a single `package/` prefix; nothing else is a legitimate entry. */
const PREFIX = 'package/';

/** A published CLI tarball is a few megabytes. The cap is what stops a decompression bomb. */
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

/** What a contract file says it is, so a truncated or foreign JSON cannot stand in for one. */
const CONTRACT_KIND = 'sthayi-release-contract';
const CONTRACT_VERSION = 1;

/**
 * The only two member types a published tarball may contain. Everything else — symlink, hard link,
 * device node, FIFO — is refused by KIND rather than by where it happens to point: a link's target
 * is resolved by the extractor on the user's machine, not by anything visible in the archive.
 */
const ALLOWED_TYPES = new Set(['file', 'directory']);

/**
 * Paths that must never be in a published tarball, each with the reason it is refused. Matched
 * against the entry path INSIDE the package, so `src/index.ts` and `a/b/src/index.ts` both hit.
 */
const REJECTED = [
  { why: 'TypeScript source', test: (p) => /\.(?:ts|tsx|mts|cts)$/.test(p) },
  { why: 'a source directory', test: (p) => /(?:^|\/)src\//.test(p) },
  { why: 'a test file', test: (p) => /(?:^|\/)tests?\//.test(p) || /\.(?:test|spec)\./.test(p) },
  { why: 'repository documentation', test: (p) => /(?:^|\/)docs\//.test(p) },
  {
    why: 'a repository page the package does not publish',
    test: (p) => /^(?:SECURITY|CONTRIBUTING|CHANGELOG)\.md$/.test(p),
  },
  { why: 'CI or VCS configuration', test: (p) => /(?:^|\/)\.(?:github|git|circleci)\//.test(p) },
  {
    why: 'build or container tooling',
    test: (p) => /^(?:Dockerfile|\.dockerignore|.*\.tape)/.test(p),
  },
  { why: 'a dependency tree', test: (p) => /(?:^|\/)node_modules\//.test(p) },
  {
    why: 'a lockfile',
    test: (p) => /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/.test(p),
  },
  { why: 'another tarball', test: (p) => /\.(?:tgz|tar|zip)$/.test(p) },
  {
    why: 'a credential file',
    test: (p) =>
      /(?:^|\/)\.env(?:\.|$)/.test(p) ||
      /(?:^|\/)\.npmrc$/.test(p) ||
      /(?:^|\/)id_(?:rsa|ed25519|ecdsa)/.test(p) ||
      /\.(?:pem|key|p12|pfx|keystore)$/.test(p),
  },
];

/**
 * Secret VALUES, not the shapes that describe them. The CLI's own masking detectors are compiled
 * into `dist`, so their pattern text (`sk-ant-[A-Za-z0-9_-]{20,}` and friends) is legitimately in
 * the archive; every regex here requires the concrete tail a real credential has, which the
 * pattern text — a `[` where the tail would be — does not supply.
 */
const SECRET_VALUES = [
  { what: 'an Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { what: 'an OpenAI API key', re: /\bsk-(?:proj-)?[A-Za-z0-9]{20,}/ },
  { what: 'an AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { what: 'an npm token', re: /\bnpm_[A-Za-z0-9]{36}/ },
  { what: 'a GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36}/ },
  { what: 'a private key block', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----\n/ },
];

/** A build machine's home directory or per-run scratch, wherever it appears in a map reference. */
const MACHINE_PATH = /(?:^|\/)(?:Users|home)\/[^/]+\/|(?:^|\/)(?:var\/folders|private\/tmp)\//;

/** Codepoint tests, so no control byte has to be written into this source to look for one. */
const isControl = (code) => code < 0x20 || code === 0x7f;
const hasControl = (s) => [...s].some((c) => isControl(c.codePointAt(0)));

/** So a hostile name is readable in the error without smuggling control characters into the log. */
const display = (raw) =>
  [...raw]
    .map((c) => {
      const code = c.codePointAt(0);
      return isControl(code) ? `\\x${code.toString(16).padStart(2, '0')}` : c;
    })
    .join('');

const describeType = (type) =>
  ({
    symlink: 'a symbolic link',
    link: 'a hard link',
    'character-device': 'a device node',
    'block-device': 'a device node',
    fifo: 'a FIFO',
  })[type] ?? `a '${type ?? 'unknown'}' member`;

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * Reads every member out of the gzipped tar WITHOUT writing anything to disk. Returns the raw
 * header (untrimmed name, real type) and the raw bytes of each member, in archive order, so a
 * duplicate is two entries here rather than one.
 */
async function readMembers(archive) {
  const tarBytes = zlib.gunzipSync(fs.readFileSync(archive), {
    maxOutputLength: MAX_ARCHIVE_BYTES,
  });
  const parser = extract();
  Readable.from([tarBytes]).pipe(parser);
  const members = [];
  for await (const entry of parser) {
    const chunks = [];
    for await (const chunk of entry) {
      chunks.push(chunk);
    }
    members.push({ header: entry.header, body: Buffer.concat(chunks) });
  }
  return members;
}

/**
 * Everything wrong with a member's RAW name. A name is a path an extractor will act on, so it is
 * held to what a path may be — not to what it looks like after trimming.
 */
function nameProblems(raw, type) {
  const found = [];
  if (raw === '') {
    return ['has an empty name'];
  }
  if (hasControl(raw)) {
    found.push('has a control character in its name');
  }
  if (raw.includes('\\')) {
    found.push('has a backslash in its name');
  }
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) {
    found.push('has an absolute name');
  }
  // Only a directory record may end in a slash; a file whose name does is an empty last segment.
  const body = type === 'directory' ? raw.replace(/\/+$/, '') : raw;
  for (const segment of body.split('/')) {
    if (segment === '') {
      found.push('has an empty path segment');
    } else if (segment === '.' || segment === '..') {
      found.push(`has a '${segment}' path segment — that is a directory traversal`);
    } else if (segment !== segment.trim()) {
      found.push('has leading or trailing whitespace in a path segment');
    }
  }
  return [...new Set(found)];
}

/** The set literal a source file declares, e.g. `new Set(['a', 'b'])` or `= ['a', 'b']`. */
function stringList(text, declaration) {
  const at = text.indexOf(declaration);
  if (at === -1) return undefined;
  const open = text.indexOf('[', at);
  const close = text.indexOf(']', open);
  if (open === -1 || close === -1) return undefined;
  return [...text.slice(open + 1, close).matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE MANIFEST FACTS: the fields that decide what a published package RUNS and FETCHES.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Lifecycle scripts npm runs on the INSTALLING user's machine. `prepack`/`postpack` are the
 * package's own pack-time hooks and are contracted like any other script; these are the ones that
 * turn an install into code execution, so an addition is called out by name rather than left to
 * read as an ordinary field mismatch.
 */
const INSTALL_TIME_HOOKS = [
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'preprepare',
  'postprepare',
  'prepublish',
  'prepublishOnly',
];

const stripDot = (p) => (typeof p === 'string' ? p.replace(/^\.\//, '') : p);

/** `./dist/x.js` and `dist/x.js` name the same file; normalising both sides keeps that a non-event. */
function stripDotDeep(value) {
  if (typeof value === 'string') return stripDot(value);
  if (Array.isArray(value)) return value.map(stripDotDeep);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stripDotDeep(v)]));
  }
  return value;
}

/** npm expands a string `bin` into `{ <unscoped package name>: <path> }`; so does this. */
function normaliseBin(bin, name) {
  if (bin === undefined || bin === null) return bin;
  if (typeof bin === 'string') {
    return { [String(name ?? '').replace(/^@[^/]+\//, '')]: stripDot(bin) };
  }
  if (typeof bin !== 'object' || Array.isArray(bin)) return bin;
  return stripDotDeep(bin);
}

/**
 * The fields a reviewer of a release actually has to have settled: what runs (`bin`, `main`,
 * `exports`, every `script`), what is fetched (every dependency map, both spellings of the bundled
 * alias), where it is allowed to run (`engines`, `os`, `cpu`, `libc`), what ships (`files`) and how
 * it is published (`publishConfig`). Everything else in a manifest is prose.
 */
export function manifestFacts(m) {
  return {
    name: m.name,
    version: m.version,
    type: m.type,
    main: stripDot(m.main),
    bin: normaliseBin(m.bin, m.name),
    exports: stripDotDeep(m.exports),
    files: m.files,
    engines: m.engines,
    os: m.os,
    cpu: m.cpu,
    libc: m.libc,
    publishConfig: m.publishConfig,
    scripts: m.scripts,
    dependencies: m.dependencies,
    devDependencies: m.devDependencies,
    peerDependencies: m.peerDependencies,
    peerDependenciesMeta: m.peerDependenciesMeta,
    optionalDependencies: m.optionalDependencies,
    bundleDependencies: m.bundleDependencies,
    bundledDependencies: m.bundledDependencies,
  };
}

/** Key order is a serialisation detail; the VALUES are the claim. */
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  }
  return value;
}

export const render = (v) => (v === undefined ? '(absent)' : JSON.stringify(canonical(v)));
export const sameValue = (a, b) => render(a) === render(b);

/** The entry points a manifest names, as tarball-relative paths. */
export function entryPointsOf(facts) {
  const bin = facts.bin;
  const raw = [
    ...(bin !== null && typeof bin === 'object' && !Array.isArray(bin) ? Object.values(bin) : []),
    facts.main,
  ].filter((p) => typeof p === 'string' && p !== '');
  return [...new Set(raw.map(stripDot))];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CAPTURING THE CONTRACT, BEFORE ANY LIFECYCLE SCRIPT COULD HAVE RUN.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Every regular file under `dir`, as `<prefix>/<rel>` → sha256, with `<rel>` POSIX-separated. */
function hashTree(dir, prefix) {
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  const walk = (at, rel) => {
    for (const name of fs.readdirSync(at).sort()) {
      const abs = path.join(at, name);
      const here = rel === '' ? name : `${rel}/${name}`;
      const stat = fs.lstatSync(abs);
      if (stat.isDirectory()) {
        walk(abs, here);
      } else if (stat.isFile()) {
        out.set(path.posix.join(prefix, here), sha256(fs.readFileSync(abs)));
      }
    }
  };
  walk(dir, '');
  return out;
}

/**
 * What this release IS, read off the repository at the moment the build the tests ran against is
 * still the build on disk. Throws if the source it derives from is not shaped the way it expects —
 * an undeclared requirement set would make every check downstream vacuous.
 */
function captureContract(repo) {
  const cliDir = path.join(repo, 'packages', 'cli');
  const manifest = JSON.parse(fs.readFileSync(path.join(cliDir, 'package.json'), 'utf8'));
  const facts = manifestFacts(manifest);
  if (entryPointsOf(facts).length === 0) {
    throw new Error('packages/cli/package.json declares no bin or main entry point');
  }

  const promptsSrc = fs.readFileSync(path.join(cliDir, 'src', 'oracle', 'prompts.ts'), 'utf8');
  const qualifySrc = fs.readFileSync(path.join(cliDir, 'src', 'oracle', 'qualify.ts'), 'utf8');
  const loadable = stringList(promptsSrc, 'const PROMPT_OPS');
  const qualified = stringList(qualifySrc, 'const OPS');
  if (loadable === undefined || loadable.length === 0) {
    throw new Error('could not read PROMPT_OPS out of packages/cli/src/oracle/prompts.ts');
  }
  if (qualified === undefined || qualified.length === 0) {
    throw new Error('could not read OPS out of packages/cli/src/oracle/qualify.ts');
  }
  for (const op of qualified) {
    if (!loadable.includes(op)) {
      throw new Error(`qualify runs the '${op}' prompt, which loadPrompt refuses — fix the source`);
    }
  }

  // THE TWO EXACT TREES. `dist` is the build the tests just ran against; `prompts` is the pack the
  // installed CLI reads. Both are captured whole, so the archive is settled on its path set as well
  // as on its bytes.
  const files = new Map([
    ...hashTree(path.join(cliDir, 'dist'), 'dist'),
    ...hashTree(path.join(cliDir, 'prompts'), 'prompts'),
  ]);
  const sources = new Map();
  for (const entry of files.keys()) {
    sources.set(entry, path.posix.join('packages/cli', entry));
  }
  if (![...files.keys()].some((e) => e.startsWith('dist/'))) {
    throw new Error(
      `no build output under ${path.join(cliDir, 'dist')} — capture the contract AFTER the build`,
    );
  }

  // The Markdown the package is CONTRACTED to publish, and nothing else. The repo-root README.md
  // and LICENSE are staged into the package tree (in the release, by
  // `scripts/stage-release-package.mjs`; for a local `npm pack`, by the package's own `prepack`),
  // and the prompt pack is copied verbatim. All of them are held to the contract's bytes, because a
  // script that rewrites or invents a Markdown file at pack time changes what users read without
  // changing anything a source-driven test can see.
  for (const [entry, abs] of [
    ['README.md', path.join(repo, 'README.md')],
    ['LICENSE', path.join(repo, 'LICENSE')],
  ]) {
    if (!fs.existsSync(abs)) {
      throw new Error(`${abs} is missing — the release contract cannot be captured without it`);
    }
    files.set(entry, sha256(fs.readFileSync(abs)));
    sources.set(entry, entry);
  }

  // `resolvePromptsDir` insists on `consolidate@v1.md` being present before it will treat a
  // directory as a pack at all, and `loadPrompt` reads `<op>@v1.md` for every op it allows.
  for (const op of loadable) {
    const rel = path.posix.join('prompts', `${op}@v1.md`);
    if (!files.has(rel)) {
      throw new Error(`loadPrompt allows the '${op}' prompt, but packages/cli/${rel} is not there`);
    }
  }
  // `loadFixtures` reads EVERY `.json` in `prompts/fixtures/<op>`, so each one on disk is a case
  // `qualify` runs — and a case that is not shipped is a case that silently stops running.
  for (const op of qualified) {
    const under = `prompts/fixtures/${op}/`;
    const cases = [...files.keys()].filter((e) => e.startsWith(under) && e.endsWith('.json'));
    if (cases.length === 0) {
      throw new Error(`no fixtures for the '${op}' prompt in packages/cli/prompts/fixtures`);
    }
  }

  const markdown = [...files.keys()].filter((e) => /\.md$/i.test(e)).sort();
  return {
    contract: CONTRACT_KIND,
    version: CONTRACT_VERSION,
    // `package.json` is deliberately absent from `files`: it is the one contracted member npm may
    // legitimately re-serialise, so it is settled on its FACTS below rather than on its bytes.
    manifest: canonical(facts),
    trees: ['dist', 'prompts'],
    markdown,
    files: Object.fromEntries([...files.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
    sources: Object.fromEntries([...sources.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
  };
}

/** Reads a captured contract back, refusing anything that is not one. */
export function loadContract(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file} is not a release contract object`);
  }
  if (parsed.contract !== CONTRACT_KIND || parsed.version !== CONTRACT_VERSION) {
    throw new Error(`${file} is not a v${CONTRACT_VERSION} ${CONTRACT_KIND}`);
  }
  for (const field of ['manifest', 'trees', 'markdown', 'files', 'sources']) {
    if (parsed[field] === undefined) {
      throw new Error(`${file} has no '${field}' — it is not a usable release contract`);
    }
  }
  if (Object.keys(parsed.files).length === 0) {
    throw new Error(`${file} contracts no files at all — every comparison would be vacuous`);
  }
  return parsed;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// SETTLING ONE ARCHIVE AGAINST THAT CONTRACT.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Structural validation of every member, against the raw headers. Returns the regular files that
 * survived it, keyed by their path inside the package.
 */
function inspectMembers(members) {
  const rawSeen = new Set();
  const normSeen = new Map();
  const files = new Map();

  for (const { header, body } of members) {
    const raw = header.name ?? '';
    const type = header.type ?? undefined;
    const shown = display(raw);

    if (rawSeen.has(raw)) {
      fail(`the tarball ships '${shown}' more than once — a duplicate archive member`);
    } else {
      rawSeen.add(raw);
      const norm = raw.replace(/\/+$/, '').normalize('NFC').trim().toLowerCase();
      const first = normSeen.get(norm);
      if (first !== undefined) {
        fail(
          `the tarball ships '${display(first)}' and '${shown}', which resolve to the same path`,
        );
      } else {
        normSeen.set(norm, raw);
      }
    }

    const bad = nameProblems(raw, type);
    for (const why of bad) {
      fail(`the tarball ships an entry that ${why}: '${shown}'`);
    }

    if (!ALLOWED_TYPES.has(type)) {
      fail(
        `the tarball ships '${shown}' as ${describeType(type)} — a published archive may hold only regular files and directories`,
      );
      continue;
    }
    if (bad.length > 0) continue;

    const trimmed = type === 'directory' ? raw.replace(/\/+$/, '') : raw;
    if (trimmed !== PREFIX.slice(0, -1) && !trimmed.startsWith(PREFIX)) {
      fail(`'${shown}' is outside the ${PREFIX} prefix npm packs into`);
      continue;
    }
    const inside = trimmed === PREFIX.slice(0, -1) ? '' : trimmed.slice(PREFIX.length);
    if (inside === '') continue; // the prefix directory record itself carries nothing

    if (type === 'directory') {
      for (const rule of REJECTED) {
        if (rule.test(`${inside}/`)) {
          fail(
            `the tarball ships '${inside}/' — ${rule.why} has no business in a published package`,
          );
        }
      }
      continue;
    }
    files.set(inside, body);
  }
  return files;
}

/** The sourcemap contract: parity with the JS, valid JSON, and no build-machine path in it. */
function checkSourcemaps(files) {
  const isJs = (p) => /^dist\/(?:[^/]+\/)*[^/]+\.js$/.test(p);
  const isMap = (p) => /^dist\/.+\.map$/.test(p);

  for (const entry of files.keys()) {
    if (isJs(entry) && !files.has(`${entry}.map`)) {
      fail(`the tarball ships '${entry}' with no '${entry}.map' — the package ships sourcemaps`);
    }
  }
  for (const entry of files.keys()) {
    if (!isMap(entry)) continue;
    const owner = entry.endsWith('.js.map') ? entry.slice(0, -'.map'.length) : undefined;
    if (owner === undefined || !files.has(owner)) {
      fail(`the tarball ships '${entry}', a sourcemap for a JS artifact it does not ship`);
      continue;
    }
    let map;
    try {
      map = JSON.parse(files.get(entry).toString('utf8'));
    } catch (e) {
      fail(`the tarball's '${entry}' is not valid JSON: ${e.message}`);
      continue;
    }
    if (map === null || typeof map !== 'object' || Array.isArray(map)) {
      fail(`the tarball's '${entry}' is not a sourcemap object`);
      continue;
    }
    if (map.sources !== undefined && !Array.isArray(map.sources)) {
      fail(`the tarball's '${entry}' declares a 'sources' that is not a list`);
      continue;
    }
    const refs = [
      ...(map.sources ?? []),
      ...(map.sourceRoot === undefined ? [] : [map.sourceRoot]),
      ...(map.file === undefined ? [] : [map.file]),
    ];
    for (const ref of refs) {
      if (typeof ref !== 'string') {
        fail(`the tarball's '${entry}' names a source that is not a string`);
        continue;
      }
      if (ref === '') continue;
      if (
        ref.startsWith('/') ||
        ref.includes('\\') ||
        /^[A-Za-z][A-Za-z0-9+.-]*:/.test(ref) ||
        MACHINE_PATH.test(ref)
      ) {
        fail(
          `the tarball's '${entry}' points at '${ref}' — a shipped sourcemap may name only paths relative to the artifact, never an absolute or build-machine path`,
        );
      }
    }
  }
}

/**
 * The packed `package.json`, read as STRICT UTF-8 and settled field by field against the manifest
 * the contract captured. Returns the packed manifest's facts, so the entry points that are REQUIRED
 * to be in the archive are the ones the packed manifest actually names.
 */
function checkPackedManifest(files, contract) {
  const body = files.get('package.json');
  if (body === undefined) return undefined; // its absence is already a required-entry failure

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    fail("the tarball's 'package.json' is not valid UTF-8 — a manifest npm cannot read as text");
    return undefined;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    fail(`the tarball's 'package.json' is not valid JSON: ${e.message}`);
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail("the tarball's 'package.json' is not a manifest object");
    return undefined;
  }

  const packed = canonical(manifestFacts(parsed));
  const want = contract.manifest ?? {};

  // AN ADDED INSTALL-TIME HOOK IS ITS OWN FINDING. `npm install` executes these on the user's
  // machine; a manifest that gains one has changed what installing this package DOES.
  const packedScripts =
    packed.scripts !== null && typeof packed.scripts === 'object' ? packed.scripts : {};
  const wantScripts = want.scripts !== null && typeof want.scripts === 'object' ? want.scripts : {};
  for (const hook of INSTALL_TIME_HOOKS) {
    if (packedScripts[hook] === undefined) continue;
    if (!sameValue(packedScripts[hook], wantScripts[hook])) {
      fail(
        `the tarball's 'package.json' declares a '${hook}' script the release does not contract: ${render(packedScripts[hook])} — an install-time hook runs on the installing user's machine`,
      );
    }
  }

  for (const field of Object.keys(manifestFacts({}))) {
    if (sameValue(packed[field], want[field])) continue;
    fail(
      `the tarball's 'package.json' declares '${field}' as ${render(packed[field])}, but the release contract captured ${render(want[field])}`,
    );
  }
  return packed;
}

async function verifyArchive(archive, contract) {
  let members;
  try {
    members = await readMembers(archive);
  } catch (e) {
    process.stderr.write(
      `::error::tarball contents: ${path.basename(archive)} could not be read as a gzipped tar: ${e.message}\n`,
    );
    return 1;
  }

  // ── STRUCTURE, BEFORE ANYTHING ELSE ─────────────────────────────────────────────────────────
  const files = inspectMembers(members);
  if (files.size === 0) {
    fail(`${archive} contains no files under ${PREFIX}`);
  }

  // ── THE PACKED MANIFEST DECIDES WHAT RUNS, SO IT IS SETTLED FIRST ───────────────────────────
  const packedFacts = checkPackedManifest(files, contract);

  // ── REQUIRED ────────────────────────────────────────────────────────────────────────────────
  // `files` holds regular members only, so a required entry that is a link or a directory is
  // missing here — which is what it is. The entry points come from the PACKED manifest as well as
  // the contract's: a manifest that repoints `bin` at a file the archive does not carry is a
  // package whose `sthayi` command does not exist, however healthy the contracted tree looks.
  const required = new Set([
    ...Object.keys(contract.files),
    'package.json',
    ...entryPointsOf(contract.manifest ?? {}),
    ...(packedFacts === undefined ? [] : entryPointsOf(packedFacts)),
  ]);
  for (const want of [...required].sort()) {
    if (!files.has(want)) {
      fail(`the tarball does not ship '${want}', which the installed CLI needs`);
    }
  }

  // ── THE ARCHIVE IS THE CONTRACTED SET, IN BOTH DIRECTIONS ───────────────────────────────────
  // The loop above settles ONE direction: nothing contracted is missing. On its own that is a
  // minimum, and the release does not pack the checkout — it packs a STAGING TREE, so every member
  // written into that tree between the staging gate and `npm pack` is a member no rule above has an
  // opinion about. The rules that DO refuse extras are scoped: `dist/` and `prompts/` are exact
  // trees, Markdown is an exact set, and `REJECTED` is a deny-list. An uncontracted file at the
  // package ROOT with a non-Markdown name falls through every one of them.
  //
  // AND `npm pack` ALWAYS INCLUDES SOME OF THOSE NAMES. Whatever the manifest's `files` says, npm
  // ships a root `README`, `LICENSE`, `LICENCE` or `NOTICE` in any spelling it finds — so `README`
  // and `README.md` ride in the same archive as two different files, and only one of them is the
  // page the release contracted and a reviewer read. The archive is therefore held to EXACTLY the
  // contracted set plus `package.json`, which is the single member contracted on its FACTS rather
  // than on its bytes. No naming variant, no leftover, no unnamed extra.
  const contracted = new Set([...Object.keys(contract.files), 'package.json']);
  for (const entry of files.keys()) {
    if (contracted.has(entry)) continue;
    fail(
      `the tarball ships '${entry}', which the release does not contract — a published archive is EXACTLY the contracted file set plus 'package.json', not a superset of it`,
    );
  }

  // ── REFUSED ─────────────────────────────────────────────────────────────────────────────────
  for (const entry of files.keys()) {
    // The one stated allowance: see the header. A map is not a source file entry, and the package
    // ships maps today; nothing else gets an exemption.
    if (/^dist\/(?:[^/]+\/)*[^/]+\.js\.map$/.test(entry)) continue;
    for (const rule of REJECTED) {
      if (rule.test(entry)) {
        fail(`the tarball ships '${entry}' — ${rule.why} has no business in a published package`);
      }
    }
  }

  // ── THE CONTRACTED TREES ARE EXACT SETS ─────────────────────────────────────────────────────
  // Not "nothing is missing": nothing EXTRA either. An extra `prompts/fixtures/<op>/*.json` is a
  // case `loadFixtures` executes; an extra `dist/*.js` is a module the installed package can load.
  for (const entry of files.keys()) {
    const tree = (contract.trees ?? []).find((t) => entry.startsWith(`${t}/`));
    if (tree === undefined) continue;
    if (contract.files[entry] === undefined) {
      fail(
        `the tarball ships '${entry}', which the release contract's '${tree}/' tree does not hold — that tree is an exact set, not a minimum`,
      );
    }
  }

  // ── THE MARKDOWN SET IS EXACT ───────────────────────────────────────────────────────────────
  // `npm pack` runs the package lifecycle, so a `prepack` script can write a Markdown file that
  // exists nowhere in the repository. An allowlist of what may NOT ship cannot see that; only an
  // exact set can.
  const contractedMarkdown = new Set(contract.markdown ?? []);
  for (const entry of files.keys()) {
    if (/\.md$/i.test(entry) && !contractedMarkdown.has(entry)) {
      fail(
        `the tarball ships '${entry}', a Markdown file the release does not contract — the published Markdown is README.md plus the shipped prompts`,
      );
    }
  }

  // ── CONTRACTED COPIES ARE BYTE-IDENTICAL TO WHAT THE CONTRACT CAPTURED ──────────────────────
  for (const [entry, digest] of Object.entries(contract.files)) {
    const packed = files.get(entry);
    if (packed === undefined) continue; // its absence is already a required-entry failure
    if (sha256(packed) !== digest) {
      fail(
        `the tarball's '${entry}' is not byte-identical to the release contract's ${contract.sources?.[entry] ?? entry}`,
      );
    }
  }

  // ── SOURCEMAPS ──────────────────────────────────────────────────────────────────────────────
  checkSourcemaps(files);

  // ── NO SECRET VALUES IN THE BYTES ───────────────────────────────────────────────────────────
  // Every regular member, read as raw bytes out of the archive. `latin1` is a byte-for-byte
  // mapping, so a payload cannot hide a credential behind a NUL or behind invalid UTF-8, and a
  // sourcemap's `sourcesContent` is scanned exactly like any other byte in the file.
  for (const [entry, body] of files) {
    const text = body.toString('latin1');
    for (const { what, re } of SECRET_VALUES) {
      if (re.test(text)) {
        fail(`the tarball's '${entry}' holds what reads as ${what}`);
      }
    }
  }

  if (problems.length > 0) {
    for (const p of problems) {
      process.stderr.write(`::error::tarball contents: ${p}\n`);
    }
    process.stderr.write(
      `::error::tarball contents: ${path.basename(archive)} failed ${problems.length} check(s) — this archive is not publishable\n`,
    );
    return 1;
  }
  process.stdout.write(
    `tarball contents OK: ${path.basename(archive)} ships ${files.size} file(s) — exactly the contracted set plus package.json, every entry byte-identical, nothing refused\n`,
  );
  return 0;
}

const USAGE =
  'usage: verify-tarball-contents.mjs --snapshot <contract.json> [--repo <dir>]\n' +
  '       verify-tarball-contents.mjs <tarball.tgz> --contract <contract.json>\n';

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
  };
  const taken = new Set();
  for (const name of ['--repo', '--snapshot', '--contract']) {
    const at = argv.indexOf(name);
    if (at !== -1) {
      taken.add(at);
      taken.add(at + 1);
    }
  }
  const repo =
    flag('--repo') === undefined
      ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
      : path.resolve(flag('--repo'));

  // ── MODE 1: capture, BEFORE the pack ────────────────────────────────────────────────────────
  const snapshot = flag('--snapshot');
  if (snapshot !== undefined) {
    let contract;
    try {
      contract = captureContract(repo);
    } catch (e) {
      process.stderr.write(`::error::release contract: ${e.message}\n`);
      return 1;
    }
    const out = path.resolve(snapshot);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(contract, null, 2)}\n`);
    process.stdout.write(
      `release contract captured: ${Object.keys(contract.files).length} contracted file(s) from ${repo} -> ${out}\n`,
    );
    return 0;
  }

  // ── MODE 2: settle one archive against that capture ──────────────────────────────────────────
  const tarball = argv.find((a, i) => !a.startsWith('--') && !taken.has(i));
  const contractFile = flag('--contract');
  if (tarball === undefined || contractFile === undefined) {
    process.stderr.write(USAGE);
    // A release contract is not optional and there is no fallback to the live tree: `npm pack` runs
    // the package lifecycle, so the working tree AFTER a pack is whatever that lifecycle left.
    return 2;
  }
  const archive = path.resolve(tarball);
  if (!fs.existsSync(archive)) {
    process.stderr.write(`::error::no tarball at ${archive}\n`);
    return 2;
  }
  let contract;
  try {
    contract = loadContract(path.resolve(contractFile));
  } catch (e) {
    process.stderr.write(`::error::release contract: ${e.message}\n`);
    return 2;
  }
  return verifyArchive(archive, contract);
}

// RUN ONLY WHEN THIS FILE IS THE PROGRAM. `scripts/stage-release-package.mjs` imports the manifest
// and contract helpers above so the staging gate and the archive gate cannot drift apart on what a
// manifest FACT is; importing must not pack, verify or exit.
const invokedAsProgram = (() => {
  const arg = process.argv[1];
  if (arg === undefined) return false;
  try {
    return fs.realpathSync(path.resolve(arg)) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedAsProgram) {
  process.exit(await main());
}
