import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Fixture {
  name: string;
  input: { items: { id: string; content: string }[] };
  expect: {
    empty?: boolean;
    redundant?: string[][];
    promote?: string[];
    contradiction?: string[][];
  };
}

/** Every valid prompt pack must contain this file — candidates without it are not a pack. */
const PACK_MARKER = 'consolidate@v1.md';

function hasPack(dir: string): boolean {
  return fs.existsSync(path.join(dir, PACK_MARKER));
}

/**
 * The pack shipped inside the `sthayi` package itself: walk up from this module to the nearest
 * `package.json` named `sthayi` and use its `prompts/` directory. Resolves identically for the
 * repo (`packages/cli/{src,dist}` → `packages/cli/prompts`) and for an npm install
 * (`node_modules/sthayi/dist` → `node_modules/sthayi/prompts`), and never depends on the cwd.
 */
function packagedPromptsDir(): string | undefined {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let hops = 0; hops < 8; hops++) {
    const manifest = path.join(dir, 'package.json');
    if (fs.existsSync(manifest)) {
      try {
        const name = (JSON.parse(fs.readFileSync(manifest, 'utf8')) as { name?: unknown }).name;
        if (name === 'sthayi') {
          return path.join(dir, 'prompts');
        }
      } catch {
        // unreadable/invalid package.json — keep walking
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return undefined;
}

/** Candidate overrides — tests only. Omitted fields read the real env / module path. */
export interface ResolvePromptsOptions {
  explicitDir?: string | undefined;
  packagedDir?: string | undefined;
}

/**
 * Locate the prompt pack. Resolution order (trust-boundary hardening):
 *   1. `STHAYI_PROMPTS_DIR` — explicit user override. Set-but-invalid is a hard error,
 *      never a silent fallback.
 *   2. The pack shipped with sthayi itself (`<package>/prompts`, inside the npm tarball).
 * There is deliberately NO cwd fallback: `./prompts` under an arbitrary working directory is
 * attacker-controlled (any repo the user happens to be in could replace the oracle system
 * prompts), so a missing packaged pack FAILS CLOSED with an actionable error instead.
 */
export function resolvePromptsDir(opts: ResolvePromptsOptions = {}): string {
  const explicit = 'explicitDir' in opts ? opts.explicitDir : process.env.STHAYI_PROMPTS_DIR;
  if (explicit) {
    const dir = path.resolve(explicit);
    if (!hasPack(dir)) {
      throw new Error(
        `STHAYI_PROMPTS_DIR points at ${dir} but ${PACK_MARKER} is not there — fix or unset it (an explicit override never falls back)`,
      );
    }
    return dir;
  }

  const packaged = 'packagedDir' in opts ? opts.packagedDir : packagedPromptsDir();
  if (packaged && hasPack(packaged)) {
    return packaged;
  }

  throw new Error(
    `oracle prompt pack missing from this installation (no ${PACK_MARKER} in the packaged prompts directory) — reinstall sthayi, or point STHAYI_PROMPTS_DIR at a trusted pack`,
  );
}

/** The only oracle prompt ops that exist. Guards `loadPrompt` against a path-traversal `op`
 *  (e.g. a crafted `--prompt ../../etc/x`) reaching an arbitrary `*@v1.md` file. */
const PROMPT_OPS = new Set(['consolidate', 'distill', 'contradictions']);

export function loadPrompt(op: string): string {
  if (!PROMPT_OPS.has(op)) {
    throw new Error(
      `unknown oracle prompt "${op}" (expected one of: ${[...PROMPT_OPS].join(', ')})`,
    );
  }
  return fs.readFileSync(path.join(resolvePromptsDir(), `${op}@v1.md`), 'utf8');
}

export function loadFixtures(op: string): Fixture[] {
  const dir = path.join(resolvePromptsDir(), 'fixtures', op);
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({
      name: f,
      ...(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Omit<Fixture, 'name'>),
    }));
}
