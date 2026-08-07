// THE TREE THE RELEASE PACKS, BUILT FRESH AND SETTLED BEFORE ANYTHING PACKS IT.
//
//   stage-release-package.mjs --contract <contract.json> --out <stage-dir> [--repo <dir>]
//
// WHY A STAGING TREE AT ALL. `npm pack` in `packages/cli` runs the package lifecycle: `prepack` is
// arbitrary code holding write access to the checkout it is packing and to `$RUNNER_TEMP`, and it
// runs BETWEEN the release contract being captured and the archive being read. That is enough to
// rewrite a built file and recompute the contract's digest for it in the same script, after which
// the contents gate compares a substitute to itself, reports "byte-identical", and the canary —
// which perturbs some OTHER contracted digest — still reports that the comparison is load-bearing.
// The release is then green about an artifact nobody reviewed.
//
// So the release does not pack the checkout. It builds a NEW tree here, holding exactly the five
// things the package publishes — the approved `package.json`, the built `dist` tree, the `prompts`
// pack, the repo-root `README.md` and `LICENSE` — enumerates it, settles every byte of it against
// the pre-pack contract, and hands that to `npm pack --ignore-scripts`. No lifecycle script runs on
// the release path at all, so there is no code between the capture and the archive.
//
// WHAT "EXACTLY" MEANS HERE. The stage is compared to the contract as an EXACT SET in both
// directions: a contracted file that is missing is a defect, and a file in the stage that the
// contract does not hold is DEBRIS — a build leftover, a scratch file, a payload someone dropped
// into `dist` — and is refused by name rather than packed. `package.json` is the one member the
// contract does not carry bytes for (npm may re-serialise it), so it is settled on the same manifest
// FACTS the archive gate uses, imported from that gate so the two cannot drift apart.
//
// NOTHING HERE FOLLOWS A LINK. Every source entry is `lstat`ed: a symlink, a device node or a FIFO
// under `dist/` or `prompts/` is refused where it is found, rather than being copied as whatever it
// happens to resolve to on the build machine.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonical,
  entryPointsOf,
  loadContract,
  manifestFacts,
  render,
  sameValue,
  sha256,
} from './verify-tarball-contents.mjs';

const problems = [];
const fail = (msg) => problems.push(msg);

/**
 * What the staging tree holds, and nothing else. `from` is relative to the repository root; `to` is
 * the path inside the package. npm always ships `package.json`, `README*` and `LICENSE*`, and the
 * manifest's `files` allowlist ships `dist` and `prompts` — so this list IS the published package.
 */
const STAGED = [
  { from: 'packages/cli/package.json', to: 'package.json', kind: 'file' },
  { from: 'packages/cli/dist', to: 'dist', kind: 'tree' },
  { from: 'packages/cli/prompts', to: 'prompts', kind: 'tree' },
  { from: 'README.md', to: 'README.md', kind: 'file' },
  { from: 'LICENSE', to: 'LICENSE', kind: 'file' },
];

const describeType = (stat) => {
  if (stat.isSymbolicLink()) return 'a symbolic link';
  if (stat.isBlockDevice() || stat.isCharacterDevice()) return 'a device node';
  if (stat.isFIFO()) return 'a FIFO';
  if (stat.isSocket()) return 'a socket';
  return 'not a regular file';
};

/** Copies one regular file, refusing anything that is not one. Returns whether it landed. */
function copyRegularFile(src, dest, shown) {
  const stat = fs.lstatSync(src);
  if (!stat.isFile()) {
    fail(`${shown} is ${describeType(stat)} — a release stages regular files only`);
    return false;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, fs.readFileSync(src));
  return true;
}

/** Copies a whole tree, file by file, refusing every member that is not a file or a directory. */
function copyTree(srcDir, destDir, shown) {
  const walk = (at, to, rel) => {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(at).sort()) {
      const from = path.join(at, name);
      const here = rel === '' ? name : `${rel}/${name}`;
      const stat = fs.lstatSync(from);
      if (stat.isDirectory()) {
        walk(from, path.join(to, name), here);
      } else if (stat.isFile()) {
        fs.writeFileSync(path.join(to, name), fs.readFileSync(from));
      } else {
        fail(`${shown}/${here} is ${describeType(stat)} — a release stages regular files only`);
      }
    }
  };
  walk(srcDir, destDir, '');
}

/** Every regular file under `dir`, as POSIX-separated relative paths. */
function enumerate(dir) {
  const out = [];
  const walk = (at, rel) => {
    for (const name of fs.readdirSync(at).sort()) {
      const abs = path.join(at, name);
      const here = rel === '' ? name : `${rel}/${name}`;
      const stat = fs.lstatSync(abs);
      if (stat.isDirectory()) walk(abs, here);
      else if (stat.isFile()) out.push(here);
      else fail(`the staged '${here}' is ${describeType(stat)} — it would be packed as one`);
    }
  };
  walk(dir, '');
  return out;
}

/**
 * The staged `package.json`, settled on the same FACTS the archive gate settles the packed one on.
 * Returns the facts, so the entry points the staged manifest names can be required to be there.
 */
function checkStagedManifest(stage, contract) {
  const at = path.join(stage, 'package.json');
  if (!fs.existsSync(at)) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(at)));
  } catch (e) {
    fail(`the staged 'package.json' is not readable as UTF-8 JSON: ${e.message}`);
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail("the staged 'package.json' is not a manifest object");
    return undefined;
  }
  const staged = canonical(manifestFacts(parsed));
  const want = contract.manifest ?? {};
  for (const field of Object.keys(manifestFacts({}))) {
    if (sameValue(staged[field], want[field])) continue;
    fail(
      `the staged 'package.json' declares '${field}' as ${render(staged[field])}, but the release contract captured ${render(want[field])}`,
    );
  }
  return staged;
}

function stage(repo, out, contract) {
  // NEWLY CREATED, ALWAYS. A stage that may already exist is a stage that may already hold
  // something, and `mkdir -p` would pack it. `mkdir` without `recursive` is the assertion.
  fs.mkdirSync(path.dirname(out), { recursive: true });
  try {
    fs.mkdirSync(out);
  } catch (e) {
    throw new Error(
      e.code === 'EEXIST'
        ? `${out} already exists — the release stage is created fresh, never reused`
        : `${out} could not be created: ${e.message}`,
    );
  }

  for (const item of STAGED) {
    const src = path.join(repo, item.from);
    const dest = path.join(out, item.to);
    if (!fs.existsSync(src)) {
      fail(`${item.from} is missing — the release cannot stage '${item.to}' without it`);
      continue;
    }
    if (item.kind === 'tree') copyTree(src, dest, item.from);
    else copyRegularFile(src, dest, item.from);
  }

  // ── THE STAGE IS AN EXACT SET, IN BOTH DIRECTIONS ──────────────────────────────────────────
  const staged = enumerate(out);
  const stagedSet = new Set(staged);
  const contracted = new Set(Object.keys(contract.files));
  // `package.json` is the one published member the contract holds no bytes for: npm may
  // re-serialise it, so it is settled on its facts below rather than on a digest.
  const expected = new Set([...contracted, 'package.json']);

  for (const want of [...expected].sort()) {
    if (!stagedSet.has(want)) {
      fail(`the release stage does not hold '${want}', which the release contract requires`);
    }
  }
  for (const got of staged) {
    if (!expected.has(got)) {
      fail(
        `the release stage holds '${got}', which the release contract does not — stage debris is not published`,
      );
    }
  }

  // ── AND EVERY CONTRACTED BYTE ─────────────────────────────────────────────────────────────
  for (const [entry, digest] of Object.entries(contract.files)) {
    if (!stagedSet.has(entry)) continue; // already a missing-entry failure
    if (sha256(fs.readFileSync(path.join(out, entry))) !== digest) {
      fail(
        `the staged '${entry}' is not byte-identical to the release contract's ${contract.sources?.[entry] ?? entry}`,
      );
    }
  }

  // ── AND WHAT THE STAGED MANIFEST SAYS RUNS ────────────────────────────────────────────────
  const facts = checkStagedManifest(out, contract);
  for (const entry of entryPointsOf(facts ?? contract.manifest ?? {})) {
    if (!stagedSet.has(entry)) {
      fail(`the staged 'package.json' names '${entry}' as an entry point, and it is not staged`);
    }
  }
  return staged.length;
}

const USAGE =
  'usage: stage-release-package.mjs --contract <contract.json> --out <stage-dir> [--repo <dir>]\n';

function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
  };
  const contractFile = flag('--contract');
  const out = flag('--out');
  if (contractFile === undefined || out === undefined) {
    process.stderr.write(USAGE);
    return 2;
  }
  const repo =
    flag('--repo') === undefined
      ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
      : path.resolve(flag('--repo'));

  let contract;
  try {
    contract = loadContract(path.resolve(contractFile));
  } catch (e) {
    process.stderr.write(`::error::release stage: ${e.message}\n`);
    return 2;
  }

  let count;
  try {
    count = stage(repo, path.resolve(out), contract);
  } catch (e) {
    process.stderr.write(`::error::release stage: ${e.message}\n`);
    return 2;
  }

  if (problems.length > 0) {
    for (const p of problems) {
      process.stderr.write(`::error::release stage: ${p}\n`);
    }
    process.stderr.write(
      `::error::release stage: ${path.resolve(out)} failed ${problems.length} check(s) — this tree is not packable\n`,
    );
    return 1;
  }
  process.stdout.write(
    `release stage OK: ${count} file(s) staged in ${path.resolve(out)}, every contracted entry present and byte-identical, no debris\n`,
  );
  return 0;
}

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
  process.exit(main());
}
