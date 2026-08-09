import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MARKDOWN_EXT,
  type Packed,
  type Reading,
  anchorsOf,
  linkedMarkdown,
  packChildEnv,
  packedMarkdown,
  readSurface,
  removeTree,
  resolveNpmCli,
} from '../helpers/public-surface.js';

/**
 * SAFETY: the shipped tree states exactly what this build is, and nothing more.
 *
 * Three surfaces are pinned here, and each one is pinned by EQUALITY or by an ALLOWLIST rather
 * than by a list of wordings to avoid:
 *
 *   · the never-paywall list, which is a PROMISE and so may only name things that ship today;
 *   · the SET of public Markdown pages, discovered from the tree and matched to the manifest both
 *     ways, so a page cannot ship without a contract and a contract cannot outlive its page;
 *   · the destinations each of those pages is allowed to send a reader to, together with the
 *     dotted tokens it is allowed to name that are NOT destinations.
 *
 * A blocklist can only refuse what someone already thought to write down. Equality admits one
 * string and an allowlist admits one set, so any addition — an entry, a promised item, a page, a
 * destination — has to be made here on purpose before it can ship.
 *
 * WHERE THE GRAMMARS LIVE. Nothing in this file tokenizes Markdown, HTML, a GitHub heading slug, a
 * `srcset` candidate list or an npm `files` glob. Every one of those is delegated — to
 * remark/rehype, to `github-slugger`, to the `srcset` package, and to `npm pack --dry-run --json` —
 * in `tests/helpers/public-surface.ts`, which says why. This file states the CONTRACT and the
 * cases; it does not implement a parser.
 *
 * Section 5 builds throwaway trees under the run's own TMPDIR, and the npm model spawns npm inside
 * one of them, because a reader that has only ever been shown the tree as it stands has never been
 * shown to refuse anything.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

// ---------------------------------------------------------------------------------------------
// 2. The never-paywall list — a promise, so it is pinned to exactly what ships.
// ---------------------------------------------------------------------------------------------

/** The items promised free and open forever. Each one is a surface this build installs today. */
const NEVER_PAYWALLED = [
  'the store',
  'the schema',
  'the MCP server',
  'the importers',
  'the prompt pack',
] as const;

/** The section, byte for byte, from its heading to the one after it. */
const NEVER_PAYWALL_SECTION = [
  '## Never-paywall list',
  '',
  'These are free and open forever:',
  '',
  `- ${NEVER_PAYWALLED.join(' · ')}`,
  '',
].join('\n');

function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  expect(start, `${heading} is missing`).toBeGreaterThan(-1);
  const end = text.indexOf('\n## ', start + 1);
  return text.slice(start, end === -1 ? undefined : end);
}

describe('safety: the never-paywall list promises exactly the surfaces this build ships', () => {
  it('the section is exactly the expected wording, heading and bullet included', () => {
    expect(section(read('README.md'), '## Never-paywall list')).toBe(NEVER_PAYWALL_SECTION);
  });

  it('the promised items are exactly that set, in that order', () => {
    const bullet = section(read('README.md'), '## Never-paywall list')
      .split('\n')
      .find((line) => line.startsWith('- '));
    expect(bullet, 'the never-paywall list has no item line').toBeDefined();
    expect((bullet ?? '').slice(2).split(' · ')).toEqual([...NEVER_PAYWALLED]);
  });
});

// ---------------------------------------------------------------------------------------------
// 3. The published prose sends a reader to exactly the destinations it is allowed to send them to.
// ---------------------------------------------------------------------------------------------

/**
 * The prose a reader of the repository or of the npm tarball actually meets, and the exact
 * contract each page keeps.
 *
 * `origins` is the exact set of EXTERNAL destinations the page may send a reader to, written the
 * way `URL` normalizes an origin: SCHEME, HOSTNAME and PORT, with a default port omitted. Nothing
 * about a destination is left to reading. An uppercased host, a unicode host, a default port, a
 * query and a fragment all collapse onto the same key — and a different scheme, a non-default
 * port, a bare IPv4 or IPv6 literal, `localhost`, or a host under ANY suffix does not.
 *
 * `localNames` is the exact set of dotted tokens the page names that are NOT destinations —
 * filenames, code identifiers, a database name. A dotted token outside that set is read as a
 * hostname mention and fails. Pinning the tokens rather than the suffixes is what lets this refuse
 * EVERY suffix instead of the handful someone thought to list: there is no TLD table here at all.
 *
 * Both are checked BOTH WAYS. Something outside the set fails, and a set entry that has stopped
 * appearing fails too, so neither list can decay into a standing permission.
 */
type PublicDoc = {
  readonly rel: string;
  readonly origins: readonly string[];
  readonly localNames: readonly string[];
  /**
   * The EXACT set of local destinations the page offers — every relative link and every in-page
   * fragment, and nothing else.
   *
   * This is an EQUALITY, not a floor, and the difference is the whole point. A list that only says
   * "these must still be present" is a one-way allowlist: it catches a link that is deleted and
   * says nothing at all about a link that is ADDED, so a page can grow a new destination — to a
   * file nobody meant to publish, to a page outside the contracted surface — and the contract stays
   * green. Both directions are pinned here, so an undeclared destination fails and a declaration
   * that has stopped appearing fails too.
   *
   * Each entry that names a path must resolve, from its own page, to a real file. A pure fragment
   * names no file and is exempt from that check alone, not from the equality.
   */
  readonly localFiles: readonly string[];
};

const PUBLIC_DOCS: readonly PublicDoc[] = [
  {
    rel: 'README.md',
    origins: ['https://modelcontextprotocol.io', 'https://nodejs.org'],
    localNames: [
      'cmd.exe',
      'config.json',
      'console.error',
      'contributing.md',
      'fs-safe.ts',
      'journal.checkpoint',
      'node.js',
      'paths.ts',
      'process.exit',
      'process.version',
      'process.versions.node.split',
      'sthayi-v0-spec.md',
      'sthayi.cmd',
      'sthayi.db',
    ],
    localFiles: [
      '#development',
      '#upgrade--uninstall',
      'CONTRIBUTING.md',
      'LICENSE',
      'docs/sthayi-v0-spec.md',
      'packages/cli/src/fs-safe.ts',
      'packages/cli/src/importers/detect.ts',
      'packages/cli/src/importers/run.ts',
      'packages/cli/src/paths.ts',
      'packages/core/src/importers/chatgpt.ts',
      'packages/core/src/index.ts',
    ],
  },
  {
    rel: 'SECURITY.md',
    origins: ['https://nodejs.org'],
    localNames: [
      'console.error',
      'fs-safe.ts',
      'fs.statfs',
      'node.js',
      'paths.ts',
      'process.exit',
      'process.version',
      'process.versions.node.split',
      'readme.md',
      'sthayi-v0-spec.md',
      'sthayi.db',
    ],
    localFiles: ['README.md', 'README.md#quickstart', 'docs/sthayi-v0-spec.md'],
  },
  {
    // The DCO's canonical text is a destination this page exists to send a contributor to, and the
    // only page that has any business doing so. It is allowed HERE and nowhere else.
    rel: 'CONTRIBUTING.md',
    origins: ['https://developercertificate.org', 'https://github.com', 'https://nodejs.org'],
    localNames: ['example.com', 'node.js', 'sthayi-v0-spec.md', 'user.email', 'user.name'],
    localFiles: [],
  },
  {
    rel: 'docs/DECISIONS.md',
    origins: [],
    localNames: [
      'config.toml',
      'demo.tape',
      'engines.node',
      'fs-safe.ts',
      'json.parse',
      'json.stringify',
      'package.json',
    ],
    localFiles: [],
  },
  {
    rel: 'docs/RELEASE.md',
    origins: ['https://nodejs.org'],
    localNames: [
      'console.error',
      'freshtest-gate-contract.test.ts',
      'freshtest.tgz',
      'fs-safe.ts',
      'index.js',
      'io.github.sthayi-ai',
      'keyless-matrix.test.ts',
      'launcher-repin-route.test.ts',
      'launcher-upgrade-truth.test.ts',
      'mcp-registry-contract.test.ts',
      'node.js',
      'package.json',
      'packaged-keyless-matrix.test.ts',
      'process.exit',
      'process.version',
      'process.versions.node.split',
      'readme.md',
      'release-workflow-durability.test.ts',
      'release.yml',
      'server.json',
      'serverinfo.version',
      'sthayi.cmd',
      'version.test.ts',
      'version.ts',
    ],
    // The five files the release runbook points a reader AT, as clickable links. Owner decision:
    // they stay links, and this set is the whole of what the page may link.
    localFiles: [
      '../packages/cli/src/oracle/prompts.ts',
      '../packages/cli/src/oracle/qualify.ts',
      '../scripts/stage-release-package.mjs',
      '../scripts/verify-tarball-contents.mjs',
      '../tests/safety/tarball-contents-gate.test.ts',
    ],
  },
  {
    rel: 'docs/sthayi-v0-spec.md',
    origins: ['https://nodejs.org'],
    localNames: [
      'biome.json',
      'chatgpt-export.zip',
      'chatgpt.ts',
      'claude.ts',
      'claude_desktop_config.json',
      'cline_mcp_settings.json',
      'cmd.exe',
      'config.json',
      'config.toml',
      'console.error',
      'context.md',
      'contributing.md',
      'decisions.md',
      'fs-safe.ts',
      'gemini.ts',
      'index.ts',
      'mcp.json',
      'mcp_config.json',
      'mcp_settings.json',
      'memories.content',
      'node.js',
      'package.json',
      'pnpm-workspace.yaml',
      'process.exit',
      'process.version',
      'process.versions.node.split',
      'readme.md',
      'rooveterinaryinc.roo-cline',
      'saoudrizwan.claude-dev',
      'settings.json',
      'skill.md',
      'sthayi-v0-spec.md',
      'sthayi.cmd',
      'sthayi.db',
      'v1.md',
      'vitest.config.ts',
      'vn.md',
    ],
    localFiles: [],
  },
  {
    rel: '.github/pull_request_template.md',
    origins: [],
    localNames: ['decisions.md'],
    localFiles: [],
  },
  {
    rel: 'packages/cli/prompts/consolidate@v1.md',
    origins: [],
    localNames: [],
    localFiles: [],
  },
  {
    rel: 'packages/cli/prompts/contradictions@v1.md',
    origins: [],
    localNames: [],
    localFiles: [],
  },
  {
    rel: 'packages/cli/prompts/distill@v1.md',
    origins: [],
    localNames: [],
    localFiles: [],
  },
];

/**
 * THE PUBLIC SURFACE, DISCOVERED FROM DISK — not listed from memory.
 *
 * A contract that names the pages it happens to know about protects those pages and nothing else: a
 * new page ships unread, which is the one failure mode a surface contract exists to prevent. So the
 * set of public prose is derived from the tree on every run and compared to `PUBLIC_DOCS` BOTH
 * WAYS. A page that appears under any of these roots fails until a contract is written for it, and
 * a contract naming a page that has gone fails too.
 *
 * A page is public when a reader meets it without cloning to work on the code:
 *
 *   · Markdown at the repository root — the README, the security policy, the contributing guide;
 *   · everything under `docs/`, which the repository serves as its documentation;
 *   · Markdown under `.github/`, which GitHub renders into the issue and pull-request forms;
 *   · Markdown NPM ITSELF SAYS IT PACKS for a publishable package, which is Markdown that ships
 *     inside the tarball — the prompt pack is met exactly the way the README is.
 *
 * One exclusion, for a stated reason rather than by omission: `tests/` is not public, because
 * nothing publishes it and nothing links it.
 *
 * `packages/cli/README.md` does not appear, and the reason is stated rather than assumed: it does
 * not exist in the tree. `prepack` copies the root README there AT PACK TIME, and the npm question
 * asked here is asked with `--ignore-scripts`, so no lifecycle output is in the answer. See
 * `tests/helpers/public-surface.ts`. That copy is the root README's bytes, already under contract
 * above, and the finished archive is pinned by the packaged-artifact gate rather than here.
 */
const PUBLIC_ROOTS = ['docs', '.github'] as const;

/**
 * Every Markdown file at or under `rel`, repository-relative.
 *
 * NO NAME IS EXEMPT. The walk carries no skip list: a Markdown file under a public root IS part of
 * the published surface, and the answer to an uncontracted one is to fail and make someone contract
 * it. A list of names the scan agrees not to look at is exactly where an unread page would hide.
 */
function markdownUnder(rel: string, root: string): string[] {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) {
    return [];
  }
  const found: string[] = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const child = rel === '.' ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...markdownUnder(child, root));
    } else if (entry.isFile() && MARKDOWN_EXT.test(entry.name)) {
      found.push(child);
    }
  }
  return found;
}

/** Markdown directly at the tree root. The walk does not descend: only root-level pages count. */
function markdownAtRoot(root: string): string[] {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isFile() && MARKDOWN_EXT.test(e.name))
    .map((e) => e.name);
}

function discoverPublicMarkdown(root: string = repoRoot): Packed {
  const packed = packedMarkdown(root);
  return {
    found: [
      ...markdownAtRoot(root),
      ...PUBLIC_ROOTS.flatMap((rel) => markdownUnder(rel, root)),
      ...packed.found,
    ].sort(),
    unsupported: packed.unsupported,
  };
}

describe('safety: every public Markdown surface is under contract, and every contract has a page', () => {
  it('the pages on disk and the pages in the manifest are the same set', () => {
    const { found, unsupported } = discoverPublicMarkdown();
    expect(unsupported, 'a declared package surface could not be modelled').toEqual([]);
    expect(found).toEqual(PUBLIC_DOCS.map((doc) => doc.rel).sort());
  }, 20_000);

  it('the manifest names no page twice, and every page it names exists', () => {
    const named = PUBLIC_DOCS.map((doc) => doc.rel);
    expect(new Set(named).size).toBe(named.length);
    for (const rel of named) {
      expect(fs.existsSync(path.join(repoRoot, rel)), `${rel} is under contract but absent`).toBe(
        true,
      );
    }
  });

  it('discovery is not vacuous — it finds the pages a reader most obviously meets', () => {
    const { found } = discoverPublicMarkdown();
    for (const rel of ['README.md', 'SECURITY.md', 'CONTRIBUTING.md']) {
      expect(found, `discovery missed ${rel}`).toContain(rel);
    }
    expect(found.length).toBeGreaterThan(PUBLIC_ROOTS.length);
  }, 20_000);

  it('the packed prompt pack really comes from npm, not from a walk of the tree', () => {
    expect(packedMarkdown(repoRoot)).toEqual({
      found: [
        'packages/cli/prompts/consolidate@v1.md',
        'packages/cli/prompts/contradictions@v1.md',
        'packages/cli/prompts/distill@v1.md',
      ],
      unsupported: [],
    });
  }, 20_000);

  it('a Markdown page a public page LINKS is itself under contract', () => {
    const contracted = PUBLIC_DOCS.map((doc) => doc.rel);
    for (const { rel } of PUBLIC_DOCS) {
      for (const linked of linkedMarkdown(read(rel), rel)) {
        expect(contracted, `${rel} links ${linked}, which is not under contract`).toContain(linked);
      }
    }
  });

  it('the DCO text is a destination CONTRIBUTING.md may offer, and no other page may', () => {
    const dco = 'https://developercertificate.org';
    for (const doc of PUBLIC_DOCS) {
      expect(new Set(doc.origins).has(dco), `${doc.rel} allows the DCO URL`).toBe(
        doc.rel === 'CONTRIBUTING.md',
      );
    }
  });
});

/**
 * Does this text offer EXACTLY these local destinations? Sorted-set equality, so an extra one and a
 * missing one are both failures. Every local-destination assertion in this file is written in terms
 * of this one predicate, which is what lets the mutations below prove the real check.
 */
function localsMatch(text: string, rel: string, declared: readonly string[]): boolean {
  return JSON.stringify(readSurface(text, rel).local) === JSON.stringify(sorted(declared));
}

describe('safety: the published prose offers exactly the destinations it is allowed to offer', () => {
  it('every allowlist entry is itself a normalized https origin — no path, port or userinfo', () => {
    for (const { rel, origins } of PUBLIC_DOCS) {
      for (const entry of origins) {
        const url = new URL(entry);
        expect(url.protocol, `${rel} allows ${entry}, which is not https`).toBe('https:');
        expect(url.origin, `${rel} allows ${entry}, which is not a bare origin`).toBe(entry);
      }
    }
  });

  for (const { rel, origins, localNames, localFiles } of PUBLIC_DOCS) {
    const named = origins.length === 0 ? 'no external destination' : origins.join(', ');

    it(`${rel} sends a reader to exactly ${named}`, () => {
      expect(readSurface(read(rel), rel).origins).toEqual([...origins].sort());
    });

    it(`${rel} offers no destination that is refused outright`, () => {
      expect(readSurface(read(rel), rel).rejected).toEqual([]);
    });

    it(`${rel} names exactly the dotted tokens that are not destinations`, () => {
      expect(readSurface(read(rel), rel).mentions).toEqual([...localNames].sort());
    });

    it(`${rel} links exactly the local destinations it declares, and no others`, () => {
      expect(localsMatch(read(rel), rel, localFiles)).toBe(true);
    });

    it(`${rel} declares no local destination that is not a real file`, () => {
      for (const dest of localFiles) {
        const pathPart = (dest.split('#')[0] ?? '').split('?')[0] ?? '';
        if (pathPart === '') {
          continue; // A pure fragment names an anchor, not a file; section 6 pins those.
        }
        const target = path.resolve(path.dirname(path.join(repoRoot, rel)), pathPart);
        expect(
          fs.existsSync(target) && fs.statSync(target).isFile(),
          `${rel} declares ${dest}, which is not a file`,
        ).toBe(true);
      }
    });
  }

  /**
   * THE ALLOWLIST HAS TO CUT BOTH WAYS, AND HERE IS THE PROOF THAT IT DOES.
   *
   * Neither of these mutates a published page: each asks `localsMatch` — the very predicate the
   * per-page assertions above are written in terms of — the question the contract would be asked if
   * the page HAD been mutated, and requires the answer `false`. A one-way list would answer `true`
   * to the first of them.
   */
  it('a local link the contract does not declare fails the page', () => {
    const readme = PUBLIC_DOCS.find((doc) => doc.rel === 'README.md');
    expect(readme, 'README.md has no contract').toBeDefined();
    const declared = readme?.localFiles ?? [];
    const mutated = `${read('README.md')}\n\n[undeclared](docs/DECISIONS.md)\n`;
    // The undeclared destination really is read off the page — otherwise the refusal below would be
    // proving nothing about links at all.
    expect(readSurface(mutated, 'README.md').local).toContain('docs/DECISIONS.md');
    expect(declared).not.toContain('docs/DECISIONS.md');
    expect(localsMatch(mutated, 'README.md', declared)).toBe(false);
  });

  it('a declared local link that the page no longer offers fails the page', () => {
    const readme = PUBLIC_DOCS.find((doc) => doc.rel === 'README.md');
    expect(readme, 'README.md has no contract').toBeDefined();
    const stale = [...(readme?.localFiles ?? []), 'docs/DECISIONS.md'];
    expect(readSurface(read('README.md'), 'README.md').local).not.toContain('docs/DECISIONS.md');
    expect(localsMatch(read('README.md'), 'README.md', stale)).toBe(false);
  });

  it('an allowlist entry that has stopped appearing fails', () => {
    const stale = ['https://modelcontextprotocol.io', 'https://retired.example'].sort();
    expect(readSurface(read('README.md'), 'README.md').origins).not.toEqual(stale);
  });

  it('a localNames entry that has stopped appearing fails', () => {
    const security = PUBLIC_DOCS.find((doc) => doc.rel === 'SECURITY.md');
    expect(security, 'SECURITY.md has no contract').toBeDefined();
    const stale = [...(security?.localNames ?? []), 'retired.example'].sort();
    expect(readSurface(read('SECURITY.md'), 'SECURITY.md').mentions).not.toEqual(stale);
  });
});

// ---------------------------------------------------------------------------------------------
// 4. The destination table: one row per shape a destination can take.
// ---------------------------------------------------------------------------------------------

/**
 * Each row is read on its own (does the extractor see the destination, and does `URL` reduce it to
 * the origin it really is?) and then spliced into README.md (does the contract above actually
 * refuse it?). A row marked `holds` is legitimate and must leave the contract standing — that is
 * where a relative repository link, an in-page fragment and a code-span placeholder are proved to
 * keep passing, so nothing here is bought by turning the check into a wall.
 */
type Row = {
  name: string;
  doc: string;
  holds?: true;
  origins?: readonly string[];
  rejected?: readonly string[];
  local?: readonly string[];
  mentions?: readonly string[];
};

const ROWS: readonly Row[] = [
  { name: 'localhost', doc: '[a](http://localhost:3000/x)', origins: ['http://localhost:3000'] },
  { name: 'IPv4 literal', doc: '[a](http://127.0.0.1:8080/x)', origins: ['http://127.0.0.1:8080'] },
  {
    // TWO SPELLINGS, BOTH ANSWERED. The origin comes from the destination as WRITTEN; the refusal
    // comes from the destination as RENDERED, because CommonMark percent-encodes the brackets and
    // `http://%5B::1%5D:3000/x` is a URL no browser can resolve. A bare IPv6 literal in a Markdown
    // link really is a dead link, and saying so is the honest reading.
    name: 'IPv6 loopback',
    doc: '[a](http://[::1]:3000/x)',
    origins: ['http://[::1]:3000'],
    rejected: ['http://%5B::1%5D:3000/x'],
  },
  {
    name: 'IPv6 literal on its default port',
    doc: '[a](https://[2001:db8::1]:443/x)',
    origins: ['https://[2001:db8::1]'],
    rejected: ['https://%5B2001:db8::1%5D:443/x'],
  },
  {
    name: 'protocol-relative link',
    doc: '[a](//outside.example.xyz/path)',
    origins: ['https://outside.example.xyz'],
  },
  {
    name: 'protocol-relative in prose',
    doc: 'Read more at //outside.example.xyz/path today.',
    origins: ['https://outside.example.xyz'],
  },
  { name: 'query string', doc: '[a](https://example.com?x=1)', origins: ['https://example.com'] },

  // ---- The OUTER scheme decides, and only http/https reach the origin allowlist at all. ----
  {
    name: 'blob: wrapping the allowed origin',
    doc: '[a](blob:https://modelcontextprotocol.io/id)',
    rejected: ['blob:https://modelcontextprotocol.io/id'],
  },
  {
    name: 'filesystem: wrapping the allowed origin',
    doc: '[a](filesystem:https://modelcontextprotocol.io/temporary/x)',
    rejected: ['filesystem:https://modelcontextprotocol.io/temporary/x'],
  },
  {
    name: 'blob: wrapping an outside origin',
    doc: '[a](blob:https://outside.xyz/id)',
    rejected: ['blob:https://outside.xyz/id'],
  },
  {
    name: 'data: scheme',
    doc: '[a](data:text/plain;base64,aGk=)',
    rejected: ['data:text/plain;base64,aGk='],
  },
  { name: 'javascript: scheme', doc: '[a](javascript:void0)', rejected: ['javascript:void0'] },
  { name: 'ws: scheme', doc: '[a](ws://outside.xyz/s)', rejected: ['ws://outside.xyz/s'] },
  { name: 'wss: scheme', doc: '[a](wss://outside.xyz/s)', rejected: ['wss://outside.xyz/s'] },
  { name: 'ftp: scheme', doc: '[a](ftp://outside.xyz/f)', rejected: ['ftp://outside.xyz/f'] },
  { name: 'file scheme', doc: '[a](file:///tmp/a)', rejected: ['file:///tmp/a'] },
  {
    name: 'mailto scheme',
    doc: '[a](mailto:user@outside.xyz)',
    rejected: ['mailto:user@outside.xyz'],
  },
  {
    // The page offers ONE destination, and the entity is decoded before it is a URL, so the outer
    // scheme is `blob:` and it is refused. The inner https text is not a second destination: it is
    // part of a URL nobody may follow.
    name: 'blob: reached through an entity-encoded colon',
    doc: '[a](blob&#58;https://modelcontextprotocol.io/id)',
    rejected: ['blob:https://modelcontextprotocol.io/id'],
  },
  {
    name: 'blob: in a raw HTML href',
    doc: '<a href="blob:https://modelcontextprotocol.io/id">a</a>',
    rejected: ['blob:https://modelcontextprotocol.io/id'],
  },
  {
    name: 'userinfo smuggling an allowed host',
    doc: '[a](https://modelcontextprotocol.io@outside.xyz/)',
    rejected: ['https://modelcontextprotocol.io@outside.xyz/'],
  },
  {
    name: 'userinfo with a password',
    doc: '[a](https://user:pw@outside.xyz/)',
    rejected: ['https://user:pw@outside.xyz/'],
  },
  {
    name: 'allowed origin with query and fragment',
    doc: '[a](https://modelcontextprotocol.io/spec?q=1#f)',
    origins: ['https://modelcontextprotocol.io'],
    holds: true,
  },
  {
    name: 'allowed host on a non-default port',
    doc: '[a](https://modelcontextprotocol.io:8443/)',
    origins: ['https://modelcontextprotocol.io:8443'],
  },
  {
    name: 'allowed host over http',
    doc: '[a](http://modelcontextprotocol.io)',
    origins: ['http://modelcontextprotocol.io'],
  },
  {
    name: 'allowed host, uppercased',
    doc: '[a](https://MODELCONTEXTPROTOCOL.IO/)',
    origins: ['https://modelcontextprotocol.io'],
    holds: true,
  },
  { name: 'suffix .xyz', doc: '[a](https://outside.xyz/x)', origins: ['https://outside.xyz'] },
  {
    name: 'suffix .co.uk',
    doc: '[a](https://outside.co.uk/x)',
    origins: ['https://outside.co.uk'],
  },
  { name: 'suffix .app', doc: '[a](https://outside.app/x)', origins: ['https://outside.app'] },
  { name: 'suffix .page', doc: '[a](https://outside.page/x)', origins: ['https://outside.page'] },
  { name: 'suffix .test', doc: '[a](https://outside.test/x)', origins: ['https://outside.test'] },
  {
    name: 'relative repository link',
    doc: '[spec](docs/sthayi-v0-spec.md)',
    local: ['docs/sthayi-v0-spec.md'],
    holds: true,
  },

  // ---- FRAGMENTS resolve against the anchors the target page really defines. ----
  {
    name: 'in-page fragment the page defines',
    doc: '## Row anchor probe\n\n[a](#row-anchor-probe)',
    local: ['#row-anchor-probe'],
    holds: true,
  },
  {
    name: 'in-page fragment nothing defines',
    doc: '[a](#no-such-heading)',
    rejected: ['#no-such-heading'],
  },
  {
    name: 'fragment whose punctuation was dropped from the anchor',
    doc: '## Upgrade & uninstall\n\n[a](#upgrade-uninstall)',
    rejected: ['#upgrade-uninstall'],
  },
  {
    name: 'ampersand heading keeps the space it leaves behind',
    doc: '## Upgrade & uninstall\n\n[a](#upgrade--uninstall)',
    local: ['#upgrade--uninstall'],
    holds: true,
  },
  {
    name: 'duplicate heading, second occurrence',
    doc: '## Row notes\n\n## Row notes\n\n[a](#row-notes-1)',
    local: ['#row-notes-1'],
    holds: true,
  },
  {
    name: 'duplicate-heading suffix nothing reaches',
    doc: '## Row notes\n\n## Row notes\n\n[a](#row-notes-2)',
    rejected: ['#row-notes-2'],
  },
  {
    name: 'percent-encoded fragment matching a unicode anchor',
    doc: '## Café notes\n\n[a](#caf%C3%A9-notes)',
    local: ['#caf%C3%A9-notes'],
    holds: true,
  },
  {
    name: 'percent-encoded fragment matching nothing',
    doc: '## Café notes\n\n[a](#caf%C3%A8-notes)',
    rejected: ['#caf%C3%A8-notes'],
  },
  {
    name: 'explicit HTML id is an anchor',
    doc: '<span id="row-explicit"></span>\n\n[a](#row-explicit)',
    local: ['#row-explicit'],
    holds: true,
  },
  {
    name: 'fragment inside a fenced block defines nothing',
    doc: '```md\n## Row fenced heading\n```\n\n[a](#row-fenced-heading)',
    rejected: ['#row-fenced-heading'],
  },
  {
    name: 'setext heading is an anchor',
    doc: 'Row setext heading\n---\n\n[a](#row-setext-heading)',
    local: ['#row-setext-heading'],
    holds: true,
  },
  {
    name: 'path-plus-fragment the target page defines',
    doc: '[a](docs/sthayi-v0-spec.md#2-repo-layout-pnpm-workspaces)',
    local: ['docs/sthayi-v0-spec.md#2-repo-layout-pnpm-workspaces'],
    holds: true,
  },
  {
    name: 'path-plus-fragment the target page does not define',
    doc: '[a](docs/sthayi-v0-spec.md#no-such-heading)',
    rejected: ['docs/sthayi-v0-spec.md#no-such-heading'],
  },
  {
    name: 'fragment on a target whose anchors cannot be enumerated',
    doc: '[a](packages/cli/src/paths.ts#L1)',
    rejected: ['packages/cli/src/paths.ts#L1'],
  },
  {
    name: 'fragment that is case-folded rather than exact',
    doc: '## Row anchor probe\n\n[a](#Row-Anchor-Probe)',
    rejected: ['#Row-Anchor-Probe'],
  },
  {
    name: 'relative path climbing out of the repository',
    doc: '[a](../../etc/passwd)',
    rejected: ['../../etc/passwd'],
  },
  {
    name: 'bare hostnames under five suffixes',
    doc: 'Ping evil.xyz, evil.co.uk, evil.app, evil.page and evil.test.',
    mentions: ['evil.app', 'evil.co.uk', 'evil.page', 'evil.test', 'evil.xyz'],
  },
  {
    name: 'code-span placeholder that is not an address',
    doc: 'Run `sthayi qualify <provider:model>` now.',
    holds: true,
  },
  {
    name: 'URL inside a fenced block',
    doc: '```bash\ncurl https://outside.app/x\n```\n',
    origins: ['https://outside.app'],
  },
  {
    name: 'autolink',
    doc: 'See <https://outside.test/x> here.',
    origins: ['https://outside.test'],
  },
  {
    name: 'reference definition',
    doc: '[id]: https://outside.page/x\n',
    origins: ['https://outside.page'],
  },

  // ---- The destination is not the source text: escapes, entities, email autolinks, raw HTML. ----
  {
    name: 'backslash-escaped scheme, localhost',
    doc: '[a](http\\://localhost/x)',
    origins: ['http://localhost'],
  },
  {
    name: 'backslash-escaped scheme, IPv4 literal',
    doc: '[a](http\\://127.0.0.1/x)',
    origins: ['http://127.0.0.1'],
  },
  {
    name: 'backslash-escaped scheme, IPv6 loopback',
    doc: '[a](http\\://[::1]/x)',
    origins: ['http://[::1]'],
    rejected: ['http://%5B::1%5D/x'],
  },
  {
    name: 'entity-encoded scheme and slashes, localhost',
    doc: '[a](http&#58;&#47;&#47;localhost/x)',
    origins: ['http://localhost'],
  },
  {
    name: 'entity-encoded scheme, slashes and dot, external host',
    doc: '[a](https&#58;&#47;&#47;outside&#46;xyz/x)',
    origins: ['https://outside.xyz'],
  },
  {
    name: 'email autolink, which is a mailto: link',
    doc: 'Write to <user@localhost> about it.',
    rejected: ['mailto:user@localhost'],
  },
  {
    // THE OFFSET REGRESSION. Four astral characters in a code span put eight UTF-16 code units
    // behind four code points, so a mask read one way and applied the other runs four characters
    // long and erases `[a](` — the link stops being a link, the page reports no destination, and a
    // localhost address ships behind a green contract. There is no cross-string mask left to get
    // wrong, and these two rows are what keeps it that way.
    name: 'code span of astral characters immediately before an entity-encoded link',
    doc: '`\u{1F600}\u{1F600}\u{1F600}\u{1F600}`[a](http&#58;&#47;&#47;localhost/x)',
    origins: ['http://localhost'],
  },
  {
    name: 'astral characters in prose do not shift what follows them either',
    doc: 'Ship it \u{1F600} and see `code` and [a](http&#58;&#47;&#47;localhost/y).',
    origins: ['http://localhost'],
  },
  {
    name: 'raw HTML href with an entity-encoded scheme',
    doc: '<a href="http&#58;&#47;&#47;localhost/x">a</a>',
    origins: ['http://localhost'],
  },
  {
    name: 'raw HTML attribute outside the known set that carries an authority',
    doc: '<span data-go="https&#58;&#47;&#47;outside.app/x">y</span>',
    origins: ['https://outside.app'],
  },
  {
    name: 'an entity this contract cannot decode, refused rather than read literally',
    doc: '[a](https&zzz;outside.xyz/x)',
    rejected: ['https&zzz;outside.xyz/x'],
  },

  // ---- ONE ATTRIBUTE, MANY DESTINATIONS: an approved FIRST entry hides nothing behind it. ----
  {
    name: 'srcset, allowed first and an encoded outside host second',
    doc: '<img srcset="https://modelcontextprotocol.io/a 1x, https&colon;&sol;&sol;outside&period;xyz/b 2x">',
    origins: ['https://modelcontextprotocol.io', 'https://outside.xyz'],
  },
  {
    name: 'ping, allowed first and an encoded outside host second',
    doc: '<a href="https://modelcontextprotocol.io" ping="https://modelcontextprotocol.io/p https&colon;&sol;&sol;outside&period;xyz/p">x</a>',
    origins: ['https://modelcontextprotocol.io', 'https://outside.xyz'],
  },
  {
    name: 'archive, allowed first and an encoded outside host second',
    doc: '<object archive="https://modelcontextprotocol.io/a https&colon;&sol;&sol;outside&period;xyz/b"></object>',
    origins: ['https://modelcontextprotocol.io', 'https://outside.xyz'],
  },
  {
    // `<object>`'s archive is a SPACE-separated token set, so a comma is part of a URL rather than a
    // separator and the whole value is ONE candidate — whose origin is the allowed host. The second
    // host is read anyway, because the token scan reads every absolute URL in the value.
    name: 'archive holding a comma is one token, and both hosts are still read',
    doc: '<object archive="https://modelcontextprotocol.io/a,https&colon;&sol;&sol;outside&period;xyz/b"></object>',
    origins: ['https://modelcontextprotocol.io', 'https://outside.xyz'],
  },
  {
    // `<applet>`'s archive IS comma-separated, and that split is not the one the attribute table
    // gives. Rather than guess which reading applies, the attribute is refused outright.
    name: 'applet archive is refused rather than split the wrong way',
    doc: '<applet archive="https://modelcontextprotocol.io/a,https&colon;&sol;&sol;outside&period;xyz/b"></applet>',
    origins: ['https://modelcontextprotocol.io', 'https://outside.xyz'],
    rejected: ['https://modelcontextprotocol.io/a,https://outside.xyz/b'],
  },
  {
    name: 'imagesrcset, allowed first and an encoded outside host second',
    doc: '<link imagesrcset="https://modelcontextprotocol.io/a 1x, https&colon;&sol;&sol;outside&period;xyz/b 2x">',
    origins: ['https://modelcontextprotocol.io', 'https://outside.xyz'],
  },
  {
    // Two fallback candidates is not a valid candidate list, so the value is refused — and both
    // hosts inside it are read anyway.
    name: 'srcset whose candidate ends on trailing commas rather than a descriptor',
    doc: '<img srcset="https://modelcontextprotocol.io/a,,, https&colon;&sol;&sol;outside&period;xyz/b">',
    origins: ['https://modelcontextprotocol.io', 'https://outside.xyz'],
    rejected: ['https://modelcontextprotocol.io/a,,, https://outside.xyz/b'],
  },
  {
    name: 'srcset of approved candidates, descriptors read as descriptors',
    doc: '<img srcset="https://modelcontextprotocol.io/a 1x, https://modelcontextprotocol.io/b 2x">',
    origins: ['https://modelcontextprotocol.io'],
    holds: true,
  },
  {
    // `(a` is not a descriptor the grammar accepts, so the value is refused, and the candidate the
    // lenient reading pulled out of it — `b)` — has to answer for itself as well.
    name: 'srcset descriptor holding a comma inside parentheses is refused, not guessed at',
    doc: '<img srcset="https://modelcontextprotocol.io/a (a,b) 1x, https://modelcontextprotocol.io/b 2x">',
    origins: ['https://modelcontextprotocol.io'],
    rejected: [
      'b)',
      'https://modelcontextprotocol.io/a (a,b) 1x, https://modelcontextprotocol.io/b 2x',
    ],
  },
  {
    name: 'ping of approved destinations',
    doc: '<a href="https://modelcontextprotocol.io" ping="https://modelcontextprotocol.io/p https://modelcontextprotocol.io/q">x</a>',
    origins: ['https://modelcontextprotocol.io'],
    holds: true,
  },
  {
    name: 'srcset whose parentheses never close is refused, not guessed at',
    doc: '<img srcset="https://modelcontextprotocol.io/a (1x">',
    origins: ['https://modelcontextprotocol.io'],
    rejected: ['https://modelcontextprotocol.io/a (1x'],
  },

  // ---- A VALUE THE GRAMMAR ACCEPTS IS NOT THE SAME AS A VALUE THE GRAMMAR READ ALL OF. ----
  {
    // THE INCOMPLETE-INPUT BYPASS. `x` is a legitimate one-character fallback candidate — the whole
    // value is valid, and the strict grammar says so — but the candidate pattern the reader
    // delegates to requires two characters, so `x` is walked past and never reported. The value
    // then reads as the ALLOWED origin ALONE, and a page carrying it passes an origin allowlist
    // while sending a reader somewhere the allowlist never saw. Coverage is what catches it: the
    // leftover `x` answers for itself, and the attribute is refused because it was not fully read.
    name: 'srcset whose one-character fallback the candidate pattern cannot match',
    doc: '<img srcset="x, https://modelcontextprotocol.io/a 2x">',
    origins: ['https://modelcontextprotocol.io'],
    rejected: ['x', 'x, https://modelcontextprotocol.io/a 2x'],
  },
  {
    name: 'imagesrcset hides a one-character fallback exactly the same way',
    doc: '<link imagesrcset="x, https://modelcontextprotocol.io/a 2x">',
    origins: ['https://modelcontextprotocol.io'],
    rejected: ['x', 'x, https://modelcontextprotocol.io/a 2x'],
  },
  {
    name: 'srcset that is nothing but a one-character candidate is not an empty srcset',
    doc: '<img srcset="x">',
    rejected: ['x', 'x'],
  },
  {
    // The same shape with a two-character candidate, which the pattern DOES match. It is read as a
    // candidate, resolved against the page, and found to be a real repository file — so the value
    // is fully covered and nothing is refused. This is the row that keeps the coverage check from
    // being a wall: a legitimate local candidate still passes.
    name: 'srcset whose fallback is a real repository file',
    doc: '<img srcset="LICENSE, https://modelcontextprotocol.io/a 2x">',
    origins: ['https://modelcontextprotocol.io'],
    local: ['LICENSE'],
    holds: true,
  },
  {
    // Here the one-character candidate DOES carry a descriptor, so the pattern matches it and the
    // parse is complete. Nothing is refused for coverage — and `x` still answers for itself as the
    // dead link it is. The candidate must not be located inside the earlier `1x` descriptor.
    name: 'srcset whose one-character candidate carries a descriptor is read, not refused wholesale',
    doc: '<img srcset="https://modelcontextprotocol.io/a 1x, x 2x">',
    origins: ['https://modelcontextprotocol.io'],
    rejected: ['x'],
  },
  {
    name: 'MALFORMED CONTROL: a srcset of bare words the grammar rejects outright',
    doc: '<img srcset="a b c">',
    rejected: ['a b c', 'b'],
  },
  {
    name: 'MALFORMED CONTROL: a srcset of nothing but separators offers no destination',
    doc: '<img srcset=", ,">',
    holds: true,
  },
  {
    name: 'CONTROL: fractional density and width descriptors are covered, not left over',
    doc: '<img srcset="https://modelcontextprotocol.io/a 1.5x, https://modelcontextprotocol.io/b 640w">',
    origins: ['https://modelcontextprotocol.io'],
    holds: true,
  },

  // ------------------------------------------------------------------------------------------
  // NAVIGATION WITHOUT A LINK. A destination does not have to sit in a destination attribute, and
  // a reader does not have to click to arrive. Every row below was verified to leave the COMPLETE
  // reading of README.md unchanged — origins, rejected, local and mentions all identical — before
  // the attribute scan, the refresh grammar and the srcdoc refusal were written.
  // ------------------------------------------------------------------------------------------
  {
    name: 'NAVIGATION: a meta refresh carries a destination no destination attribute holds',
    doc: '<meta http-equiv="refresh" content="0; url=http://localhost:3000/x">',
    origins: ['http://localhost:3000'],
  },
  {
    name: 'NAVIGATION: the same refresh, with http-equiv spelled in uppercase',
    doc: '<meta http-equiv="REFRESH" content="0; url=http://localhost:3000/x">',
    origins: ['http://localhost:3000'],
  },
  {
    name: 'NAVIGATION: a refresh whose destination is entity-encoded',
    doc: '<meta http-equiv="refresh" content="0; url=https&colon;&sol;&sol;outside&period;xyz/x">',
    origins: ['https://outside.xyz'],
  },
  {
    // Three grammar shapes at once: an uppercase `URL` keyword, whitespace around the `=`, and a
    // single-quoted destination. Each is spec-legal and each hides the URL from a naive read.
    name: 'NAVIGATION: a refresh whose destination is quoted after an uppercase URL keyword',
    doc: '<meta http-equiv="refresh" content="5; URL = \'http://localhost:3000/y\'">',
    origins: ['http://localhost:3000'],
  },
  {
    name: 'NAVIGATION: a refresh with no url keyword at all still names its destination',
    doc: '<meta http-equiv="refresh" content="0; http://localhost:3000/z">',
    origins: ['http://localhost:3000'],
  },
  {
    // RELATIVE, AND REALLY RESOLVED. A refresh destination with no scheme is invisible to a scan
    // for absolute URLs, so this pair is what says the grammar is parsed rather than skimmed: one
    // relative destination that resolves to a real page, and one that resolves to nothing and is
    // therefore refused. If relative refresh destinations were being walked past, the second row
    // would report nothing at all.
    name: 'NAVIGATION: a refresh to a RELATIVE destination resolves against the page carrying it',
    doc: '<meta http-equiv="refresh" content="0; url=docs/sthayi-v0-spec.md">',
    local: ['docs/sthayi-v0-spec.md'],
    holds: true,
  },
  {
    name: 'NAVIGATION: a refresh to a relative destination that is not there is a dead navigation',
    doc: '<meta http-equiv="refresh" content="0;url=docs/not-here.md">',
    rejected: ['docs/not-here.md'],
  },
  {
    name: 'NAVIGATION: a refresh the grammar cannot read is refused, and its URL read anyway',
    doc: '<meta http-equiv="refresh" content="soon; url=http://localhost:3000/x">',
    origins: ['http://localhost:3000'],
    rejected: ['soon; url=http://localhost:3000/x'],
  },
  {
    name: 'NAVIGATION: a srcdoc is refused, and the absolute URL nested inside it is read too',
    doc: '<iframe srcdoc="&lt;a href=&quot;http://localhost:3000/x&quot;&gt;go&lt;/a&gt;"></iframe>',
    origins: ['http://localhost:3000'],
    rejected: ['<a href="http://localhost:3000/x">go</a>'],
  },
  {
    // The fail-closed half. Nothing in this value carries a scheme, so the additive scan finds
    // nothing — and the attribute is refused rather than reported as empty.
    name: 'NAVIGATION: a srcdoc whose only destination is RELATIVE is refused, never ignored',
    doc: '<iframe srcdoc="&lt;a href=&quot;docs/not-here.md&quot;&gt;go&lt;/a&gt;"></iframe>',
    rejected: ['<a href="docs/not-here.md">go</a>'],
  },
  {
    name: 'NAVIGATION: an absolute URL in the MIDDLE of an unknown attribute value is read',
    doc: '<span data-note="go to https://outside.app/x now">y</span>',
    origins: ['https://outside.app'],
  },
  {
    name: 'CONTROL: a refresh that only reloads names no destination at all',
    doc: '<meta http-equiv="refresh" content="30">',
    holds: true,
  },
  {
    name: 'CONTROL: content on a meta that is NOT a refresh stays ordinary prose',
    doc: '<meta name="description" content="Read docs/sthayi-v0-spec.md first">',
    mentions: ['sthayi-v0-spec.md'],
    holds: true,
  },
  {
    name: 'CONTROL: an unknown attribute holding no URL still reads as prose',
    doc: '<span data-note="see config.json for that">y</span>',
    mentions: ['config.json'],
    holds: true,
  },

  // ---- A BACKSLASH IN THE PATH IS THE DISAGREEMENT; A BACKSLASH IN THE QUERY IS DATA. ----
  {
    // `new URL('README.md?q=\\part', 'https://h/x/')` keeps the backslash in the QUERY and resolves
    // the same file every reading does. There is no disagreement to fail closed on, so refusing it
    // costs a legitimate link and buys nothing.
    name: 'a backslash in the QUERY is opaque data, and the link still resolves',
    doc: '[a](README.md?q=\\part)',
    local: ['README.md?q=%5Cpart', 'README.md?q=\\part'],
    holds: true,
  },
  {
    name: 'a percent-encoded backslash in the query is data too',
    doc: '[a](README.md?q=%5Cpart)',
    local: ['README.md?q=%5Cpart'],
    holds: true,
  },
  {
    name: 'a DOUBLED backslash in the query still starts no authority',
    doc: '<a href="README.md?q=\\\\part">a</a>',
    local: ['README.md?q=\\\\part'],
    holds: true,
  },
  {
    // The other direction, and the one that matters: a query further along the destination does not
    // buy the PATH an exemption.
    name: 'a backslash in the PATH is refused however much query follows it',
    doc: '[a](docs\\x.md?q=1)',
    rejected: ['docs%5Cx.md?q=1', 'docs\\x.md?q=1'],
  },
  {
    name: 'an ENCODED question mark leaves the backslash inside the path, and it is refused',
    doc: '[a](README.md%3Fq=%5Cpart)',
    rejected: ['README.md%3Fq=%5Cpart'],
  },

  // ---- Every LOCAL destination resolves, from its own page, to a file that is really there. ----
  {
    name: 'relative link to a file that does not exist',
    doc: '[missing](docs/not-here.md)',
    rejected: ['docs/not-here.md'],
  },
  {
    name: 'relative link to a directory',
    doc: '[dir](docs/)',
    rejected: ['docs/'],
  },

  // ------------------------------------------------------------------------------------------
  // THE NINE. Each row below is a place where a pattern and a grammar disagree, and in every one
  // of them the pattern is the reading that lets something through. They are the reason this
  // contract stopped writing its own parsers; each one was verified to fail against the previous
  // hand-written extractor before it was written down here.
  // ------------------------------------------------------------------------------------------
  {
    // A `>` inside a QUOTED attribute value does not end the tag. A pattern that stops at the first
    // `>` never reaches `srcset`, so the encoded second candidate ships unread.
    name: 'PROBE: a quoted > inside an attribute does not end the tag',
    doc: '<img alt="a > b" srcset="https://modelcontextprotocol.io/a 1x, https&colon;&sol;&sol;outside&period;xyz/b 2x">',
    origins: ['https://modelcontextprotocol.io', 'https://outside.xyz'],
  },
  {
    // An opening run of two backticks is closed by a run of two, not by a run of one. `` ``x` `` is
    // therefore NOT a code span, and a link written inside it is a real link.
    name: 'PROBE: mismatched inline backtick runs are not a code span',
    doc: 'Text ``[a](https&colon;&sol;&sol;outside&period;xyz/z)` end',
    origins: ['https://outside.xyz'],
  },
  {
    // A backtick fence's info string may not contain a backtick, so ```` ```js` ```` opens nothing.
    // Reading it as a fence hides everything up to the next fence-shaped line.
    name: 'PROBE: a fence opener whose info string holds a backtick is not a fence',
    doc: '```js`\n[a](https&colon;&sol;&sol;outside&period;xyz/f)\n```\n',
    origins: ['https://outside.xyz'],
  },
  {
    // `[foo\]]` is a valid reference label: the escape makes the first `]` part of the label. A
    // pattern that stops at the first unescaped-looking `]` decides this is not a definition.
    name: 'PROBE: an escaped reference label still defines a reference',
    doc: '[foo\\]]: https&colon;&sol;&sol;outside&period;xyz/r\n',
    origins: ['https://outside.xyz'],
  },
  {
    // The heading text is `Fish & Chips` once the character reference is decoded, and GitHub slugs
    // that to `fish--chips`. Slugging the SOURCE gives `fish-amp-chips`, an anchor no page has.
    name: 'PROBE: an entity-bearing heading anchors the way GitHub slugs it',
    doc: '## Fish &amp; Chips\n\n[a](#fish--chips)',
    local: ['#fish--chips'],
    holds: true,
  },
  {
    name: 'PROBE: the pre-decode spelling of that heading anchors nothing',
    doc: '## Fish &amp; Chips\n\n[a](#fish-amp-chips)',
    rejected: ['#fish-amp-chips'],
  },
  {
    // A setext heading is the WHOLE paragraph above the underline, not its last line.
    name: 'PROBE: a multiline setext heading anchors on both its lines',
    doc: 'Line one\nLine two\n===\n\n[a](#line-oneline-two)',
    local: ['#line-oneline-two'],
    holds: true,
  },
  {
    name: 'PROBE: that setext heading does not anchor on its last line alone',
    doc: 'Line one\nLine two\n===\n\n[a](#line-two)',
    rejected: ['#line-two'],
  },
  {
    // A comment is not an element. An `id=` written inside one declares nothing, and a link to it
    // is a dead link a reader would land nowhere on.
    name: 'PROBE: an id inside an HTML comment is not an anchor',
    doc: '<!-- <span id="row-ghost"></span> -->\n\n[a](#row-ghost)',
    rejected: ['#row-ghost'],
  },
  {
    // `name` is a named anchor on `<a>` and an ordinary attribute everywhere else.
    name: 'PROBE: name on a span is not an anchor',
    doc: '<span name="row-span-name"></span>\n\n[a](#row-span-name)',
    rejected: ['#row-span-name'],
  },
  {
    name: 'PROBE: name on an anchor element IS an anchor',
    doc: '<a name="row-a-name"></a>\n\n[a](#row-a-name)',
    local: ['#row-a-name'],
    holds: true,
  },
  {
    // Inside a raw HTML block with no blank line, `## …` is HTML text, not a Markdown heading, and
    // it declares no anchor at all.
    name: 'PROBE: an ATX heading swallowed by a raw HTML block is text, not a heading',
    doc: '<div>\n## Row html heading\n</div>\n\n[a](#row-html-heading)',
    rejected: ['#row-html-heading'],
  },
  {
    name: 'PROBE: the same heading, in an HTML block a blank line reopens, IS a heading',
    doc: '<div>\n\n## Row html heading\n\n</div>\n\n[a](#row-html-heading)',
    local: ['#row-html-heading'],
    holds: true,
  },
];

const sorted = (values: readonly string[]): string[] => [...values].sort();

/** Does README.md's contract still hold for this text? */
function readmeContractHolds(text: string): boolean {
  const doc = PUBLIC_DOCS.find((candidate) => candidate.rel === 'README.md');
  if (doc === undefined) {
    return false;
  }
  const reading = readSurface(text, 'README.md');
  return (
    reading.rejected.length === 0 &&
    JSON.stringify(reading.origins) === JSON.stringify(sorted(doc.origins)) &&
    JSON.stringify(reading.mentions) === JSON.stringify(sorted(doc.localNames))
  );
}

describe('safety: every shape a destination can take is read for what it resolves to', () => {
  for (const row of ROWS) {
    it(`reads ${row.name}`, () => {
      const reading = readSurface(row.doc, 'README.md');
      expect(reading.origins).toEqual(sorted(row.origins ?? []));
      expect(reading.rejected.map((line) => line.split(' — ')[0] ?? '')).toEqual(
        sorted(row.rejected ?? []),
      );
      expect(reading.local).toEqual(sorted(row.local ?? []));
      expect(reading.mentions).toEqual(sorted(row.mentions ?? []));
    });
  }

  it('README.md as published satisfies its own contract', () => {
    expect(readmeContractHolds(read('README.md'))).toBe(true);
  });

  for (const row of ROWS) {
    const verb = row.holds === true ? 'survives' : 'is refused';
    it(`README.md + ${row.name} ${verb}`, () => {
      const mutated = `${read('README.md')}\n\n${row.doc}\n`;
      expect(readmeContractHolds(mutated)).toBe(row.holds === true);
    });
  }

  /**
   * A ROW ASSERTS THE DESTINATION IT REFUSES, NOT THE REASON — AND FOR THESE TWO THAT IS NOT ENOUGH.
   *
   * Neither `docs/a\b.md?q=1` nor `README.md%3Fq=%5Cpart` names a file this repository holds, so a
   * reader that stopped refusing backslashes entirely would still refuse both of them: for naming
   * nothing. The row would stay green and prove nothing about the guard. The reason is therefore
   * asserted here, which is what makes the pair load-bearing rather than incidental. (The tree
   * tests further down plant the file on disk and take away the second explanation altogether.)
   */
  it('the backslash rows are refused FOR the backslash, not for the file being absent', () => {
    const named = [
      'a backslash in the PATH is refused however much query follows it',
      'an ENCODED question mark leaves the backslash inside the path, and it is refused',
    ];
    for (const name of named) {
      const row = ROWS.find((candidate) => candidate.name === name);
      expect(row, `${name} is no longer a row`).toBeDefined();
      const reading = readSurface(row?.doc ?? '', 'README.md');
      expect(reading.rejected.length, `${name} refuses nothing`).toBeGreaterThan(0);
      for (const line of reading.rejected) {
        expect(line.split(' — ')[1] ?? '', `${name} was refused for something else`).toMatch(
          /^carries a backslash/,
        );
      }
    }
  });

  it('the nine probes are all present, and none of them is vacuous', () => {
    const probes = ROWS.filter((row) => row.name.startsWith('PROBE: '));
    expect(probes.length).toBe(13);
    for (const probe of probes) {
      const reading = readSurface(probe.doc, 'README.md');
      const said =
        reading.origins.length + reading.rejected.length + reading.local.length !== 0 ||
        reading.mentions.length !== 0;
      expect(said, `${probe.name} asserts nothing at all`).toBe(true);
    }
  });

  /**
   * The navigation rows have the same obligation, and one of their own besides.
   *
   * Each must be read as a DESTINATION — an origin, a refusal, or a local link — and a `mentions`
   * entry does not count. That distinction is the whole defect these rows were written for: a URL
   * that lands in `mentions` has been read as PROSE, a dotted token somebody happened to type, and
   * the page that carries it passes an origin allowlist that never saw the host. "The reader said
   * something" is not the property; "the reader said this is somewhere a reader goes" is.
   *
   * And each must reach the CONTRACT rather than the reader alone: a destination that is noticed and
   * then waved through is a destination that ships. Exactly one of them is legitimate — the relative
   * refresh to a page already under contract — and it is the row that keeps this from being a wall.
   */
  it('every navigation row is read as a DESTINATION, not as prose, and reaches the contract', () => {
    const rows = ROWS.filter((row) => row.name.startsWith('NAVIGATION: '));
    expect(rows.length).toBe(11);
    for (const row of rows) {
      const reading = readSurface(row.doc, 'README.md');
      const destinations = reading.origins.length + reading.rejected.length + reading.local.length;
      expect(destinations, `${row.name} names no destination at all`).toBeGreaterThan(0);
      expect(reading.mentions, `${row.name} read a navigation as prose`).toEqual([]);
      // The one exception is the relative row that resolves to a real contracted page, which is
      // legitimate and says so; every other navigation row must leave the contract broken.
      expect(
        readmeContractHolds(`${read('README.md')}\n\n${row.doc}\n`),
        `${row.name} left README.md's contract standing`,
      ).toBe(row.holds === true);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 5. The readers themselves, shown a tree and a text built to break them.
// ---------------------------------------------------------------------------------------------

/**
 * A reader that has only ever been run against the tree as it stands has never been shown to REFUSE
 * anything: every page here happens to be under contract, every link happens to be canonical, and
 * no symlink happens to leave the repository. So discovery, the linked-page closure and the
 * containment check are each given a tree, or a text, that breaks them.
 *
 * Each tree is a fresh `mkdtemp` under this run's own TMPDIR, holding a `repo/` and an `outside/`
 * so a symlink has somewhere real to escape TO, and it is removed again whatever the test does.
 */
function withTrees(run: (repo: string, outside: string) => void): void {
  const parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sthayi-surface-'));
  try {
    const repo = path.join(parent, 'repo');
    const outside = path.join(parent, 'outside');
    fs.mkdirSync(repo);
    fs.mkdirSync(outside);
    run(repo, outside);
  } finally {
    removeTree(parent);
  }
}

const put = (root: string, rel: string, body: string): string => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return abs;
};

const manifest = (value: Record<string, unknown>): string => JSON.stringify(value);

/**
 * WHAT NPM REALLY PUTS IN A TARBALL, ASKED OF THE PACKAGE WHERE IT STANDS.
 *
 * The reader under test answers this question about a COPY, and the copy leaves `node_modules`
 * behind. That is faithful for every ordinary package and it is the whole difficulty for a bundling
 * one, so the two answers have to be comparable: this asks npm the same question about the tree as
 * it actually is, `node_modules` and all. Without it, a test that asserts a bundled package is
 * REFUSED is asserting a refusal of something nobody has shown npm would ever pack.
 *
 * Same npm and same isolation as the reader: the CLI beside this node — never `PATH` — an empty
 * home and cache inside a throwaway fixture, `--ignore-scripts`, and `--dry-run` so no archive is
 * written anywhere.
 */
function npmPacks(pkgDir: string): string[] {
  const cli = resolveNpmCli(process.execPath);
  expect(
    cli,
    'npm is not installed beside this node, so nothing here can be compared',
  ).not.toBeNull();
  const fixture = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sthayi-npmpack-'));
  try {
    const home = path.join(fixture, 'home');
    const cache = path.join(fixture, 'cache');
    fs.mkdirSync(home);
    fs.mkdirSync(cache);
    const stdout = execFileSync(
      process.execPath,
      [cli ?? '', 'pack', '--dry-run', '--ignore-scripts', '--json'],
      {
        cwd: pkgDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000,
        env: packChildEnv(home, cache),
      },
    );
    const parsed: unknown = JSON.parse(stdout);
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    const files = (first as { files?: { path?: unknown }[] } | undefined)?.files ?? [];
    return files.map((entry) => String(entry.path ?? ''));
  } finally {
    removeTree(fixture);
  }
}

// These bodies are synchronous: Vitest can report an elapsed-time breach only after npm has
// exited and fixture cleanup has completed. Preserve the existing non-Windows budgets while
// allowing for Windows process startup and runner contention, in proportion to the number of
// fresh isolated `npm pack` children each case launches.
const ONE_NPM_PACK_TIMEOUT = process.platform === 'win32' ? 20_000 : 5_000;
const TWO_NPM_PACK_TIMEOUT = process.platform === 'win32' ? 40_000 : 20_000;
const FOUR_NPM_PACK_TIMEOUT = process.platform === 'win32' ? 80_000 : 20_000;

describe('safety: discovery finds every public surface, or says which one it could not model', () => {
  it('an uppercase extension is a page — at the root and under docs/ — and .markdown is too', () => {
    withTrees((repo) => {
      put(repo, 'README.md', '# r\n');
      put(repo, 'ROOT.MD', '# r\n');
      put(repo, 'docs/uncovered.MD', '# u\n');
      put(repo, 'docs/other.markdown', '# o\n');
      const { found, unsupported } = discoverPublicMarkdown(repo);
      expect(unsupported).toEqual([]);
      expect(found).toEqual(
        ['README.md', 'ROOT.MD', 'docs/other.markdown', 'docs/uncovered.MD'].sort(),
      );
    });
  });

  /**
   * THE GUARD AGAINST A SKIP LIST COMING BACK. Discovery filters root pages by extension and by
   * nothing else, so an arbitrarily named page is found on the same terms as the README. Both
   * halves matter: the synthetic tree pins names the contract has never heard of, and the real tree
   * requires every root page that actually exists to come back out of `discoverPublicMarkdown`.
   */
  it('no root-level name is exempt — an arbitrarily named page is discovered like any other', () => {
    withTrees((repo) => {
      const pages = ['README.md', 'GUIDE.md', 'notes-2.md', 'x.markdown'];
      for (const page of pages) {
        put(repo, page, '# p\n');
      }
      const { found, unsupported } = discoverPublicMarkdown(repo);
      expect(unsupported).toEqual([]);
      expect(found, 'a root page was skipped by name').toEqual([...pages].sort());
    });

    const onDisk = fs
      .readdirSync(repoRoot, { withFileTypes: true })
      .filter((e) => e.isFile() && MARKDOWN_EXT.test(e.name))
      .map((e) => e.name)
      .sort();
    expect(onDisk.length, 'the repository root has no Markdown to check').toBeGreaterThan(0);
    const { found } = discoverPublicMarkdown();
    for (const name of onDisk) {
      expect(found, `${name} is at the repository root but discovery did not return it`).toContain(
        name,
      );
    }
  }, 20_000);

  it(
    'a publishable package ships its README even though `files` names only dist',
    () => {
      withTrees((repo) => {
        put(
          repo,
          'packages/p/package.json',
          manifest({ name: 'p', version: '1.0.0', files: ['dist'] }),
        );
        put(repo, 'packages/p/README.md', '# p\n');
        put(repo, 'packages/p/dist/index.js', '');
        put(repo, 'packages/p/notes.md', '# not packed\n');
        const { found, unsupported } = discoverPublicMarkdown(repo);
        expect(unsupported).toEqual([]);
        expect(found).toEqual(['packages/p/README.md']);
      });
    },
    ONE_NPM_PACK_TIMEOUT,
  );

  /**
   * THE CONTROL FOR THE MANIFEST-SYMLINK CASE BELOW. An ordinary package, its own manifest, its own
   * `private: true` — skipped, silently and legitimately, because npm would publish nothing of it.
   * That is what the refusal further down must NOT turn into a wall.
   */
  it('a private package ships nothing at all', () => {
    withTrees((repo) => {
      put(
        repo,
        'packages/p/package.json',
        manifest({ name: 'p', version: '1.0.0', private: true, files: ['dist'] }),
      );
      put(repo, 'packages/p/README.md', '# p\n');
      expect(discoverPublicMarkdown(repo)).toEqual({ found: [], unsupported: [] });
    });
  });

  /**
   * BUNDLING IS THE ONE CONFIGURATION THAT MAKES THE PACK FIXTURE UNFAITHFUL.
   *
   * The reader copies a package into a fixture WITHOUT `node_modules` and asks npm what it packs.
   * `bundledDependencies` is the case where npm's honest answer includes `node_modules/<dep>` in
   * full — README and all — so the copy npm was shown is not the package that ships. What comes
   * back is not a wrong list, it is an EMPTY one: nothing found, nothing reported, a page inside
   * the tarball with no contract and no complaint.
   *
   * The second assertion is the one that makes the first mean anything. It asks npm about the tree
   * as it really stands and requires the bundled page to be in the answer, so what is refused above
   * is a page that would genuinely have shipped rather than a hypothetical one.
   */
  it(
    'a package that BUNDLES a dependency is refused — and npm really would pack its pages',
    () => {
      withTrees((repo) => {
        put(
          repo,
          'packages/p/package.json',
          manifest({
            name: 'p',
            version: '1.0.0',
            files: ['dist'],
            dependencies: { dep: '1.0.0' },
            bundledDependencies: ['dep'],
          }),
        );
        put(repo, 'packages/p/dist/index.js', '');
        put(
          repo,
          'packages/p/node_modules/dep/package.json',
          manifest({ name: 'dep', version: '1.0.0' }),
        );
        put(repo, 'packages/p/node_modules/dep/README.md', '# a page from inside a bundled dep\n');

        const { found, unsupported } = discoverPublicMarkdown(repo);
        expect(found, 'a page inside a bundled dependency was silently modelled away').toEqual([]);
        expect(unsupported).toEqual([
          'packages/p could not be packed by npm: configures bundledDependencies, ' +
            'so npm packs a node_modules tree this reader strips before it asks',
        ]);

        const reallyPacked = npmPacks(path.join(repo, 'packages', 'p'));
        expect(
          reallyPacked,
          'npm does not pack the bundled page, so the refusal above proves nothing',
        ).toContain('node_modules/dep/README.md');
      });
    },
    ONE_NPM_PACK_TIMEOUT,
  );

  it('`bundleDependencies: true` is the same refusal under npm’s other spelling of the field', () => {
    withTrees((repo) => {
      put(
        repo,
        'packages/p/package.json',
        manifest({ name: 'p', version: '1.0.0', files: ['docs'], bundleDependencies: true }),
      );
      put(repo, 'packages/p/docs/a.md', '# a\n');
      const { found, unsupported } = discoverPublicMarkdown(repo);
      expect(found).toEqual([]);
      expect(unsupported).toEqual([
        'packages/p could not be packed by npm: configures bundleDependencies, ' +
          'so npm packs a node_modules tree this reader strips before it asks',
      ]);
    });
  });

  /**
   * CONTROLS, BOTH SPELLINGS. A field that bundles NOTHING changes nothing: the fixture is faithful,
   * npm's answer is the package's answer, and the pages are modelled exactly as any other package's
   * are. A refusal that fired here would be a wall rather than a guard.
   */
  it(
    'a bundle field that bundles nothing leaves the package modelled as any other',
    () => {
      for (const empty of [
        { bundledDependencies: [] },
        { bundleDependencies: [] },
        { bundledDependencies: false },
        { bundleDependencies: false },
      ]) {
        withTrees((repo) => {
          put(
            repo,
            'packages/p/package.json',
            manifest({ name: 'p', version: '1.0.0', files: ['docs'], ...empty }),
          );
          put(repo, 'packages/p/docs/a.md', '# a\n');
          expect(discoverPublicMarkdown(repo), `${JSON.stringify(empty)} was refused`).toEqual({
            found: ['packages/p/docs/a.md'],
            unsupported: [],
          });
        });
      }
    },
    FOUR_NPM_PACK_TIMEOUT,
  );

  it(
    'a publishable package with NO `files` ships every page npm does not ignore',
    () => {
      withTrees((repo) => {
        put(repo, 'packages/p/package.json', manifest({ name: 'p', version: '1.0.0' }));
        put(repo, 'packages/p/docs/guide.md', '# g\n');
        const { found, unsupported } = discoverPublicMarkdown(repo);
        expect(unsupported).toEqual([]);
        expect(found).toEqual(['packages/p/docs/guide.md']);
      });
    },
    ONE_NPM_PACK_TIMEOUT,
  );

  /**
   * A PACKAGE IS WHAT THE REPOSITORY HOLDS, NOT WHAT A LINK POINTS AT.
   *
   * `statSync` follows a symlink, so a `packages/p` pointing anywhere at all answers
   * `isDirectory()` yes and everything under the TARGET is then reported as this repository's
   * packed Markdown — pages the repository does not contain, arriving under contract. The same
   * applies one level down: the manifest decides what npm packs, and a symlinked `package.json`
   * hands that decision away; a symlinked file inside the tree is copied verbatim into the pack
   * fixture, so what npm reads is not what the repository holds. Every one of them is refused.
   */
  it('a packages/ entry that is a SYMLINK is refused, never followed out of the tree', () => {
    withTrees((repo, outside) => {
      put(outside, 'package.json', manifest({ name: 'p', version: '1.0.0', files: ['guide.md'] }));
      put(outside, 'guide.md', '# not this repository’s page\n');
      fs.mkdirSync(path.join(repo, 'packages'));
      fs.symlinkSync(outside, path.join(repo, 'packages', 'p'));
      const { found, unsupported } = discoverPublicMarkdown(repo);
      expect(found, 'a page outside the tree was reported as packed content').toEqual([]);
      expect(unsupported).toHaveLength(1);
      expect(unsupported[0]).toMatch(/^packages\/p could not be packed by npm: is a symlink/);
    });
  });

  it('a symlinked package.json is refused rather than read', () => {
    withTrees((repo, outside) => {
      const real = put(
        outside,
        'package.json',
        manifest({ name: 'p', version: '1.0.0', files: ['guide.md'] }),
      );
      put(repo, 'packages/p/guide.md', '# g\n');
      fs.symlinkSync(real, path.join(repo, 'packages', 'p', 'package.json'));
      const { found, unsupported } = discoverPublicMarkdown(repo);
      expect(found).toEqual([]);
      expect(unsupported).toEqual([
        "packages/p could not be packed by npm: holds the symlink package.json, whose target is not this repository's content",
      ]);
    });
  });

  /**
   * A MANIFEST IS NOT EVIDENCE ABOUT ITSELF, AND `private` IS THE FIELD THAT PROVES IT.
   *
   * Every other objection in this section is reached by LOOKING at the package. `private` is
   * reached by BELIEVING it — one field, in one file, and the whole package is dismissed without
   * being read. Point that file out of the repository and the claim is made by content this
   * repository does not own: a package whose pages really do ship is waved past as unpublishable,
   * and — this is the part that matters — it lands in NEITHER list. Not modelled, not reported.
   *
   * So the order is the fix. What the entry IS gets settled first, by `lstat` and by `realpath`,
   * and only a package that survives that has a manifest worth opening. The control directly above
   * is the other half: an ordinary private package is still skipped, silently, exactly as before.
   */
  it('a symlinked package.json claiming `private` is refused, not believed and skipped', () => {
    withTrees((repo, outside) => {
      const real = put(
        outside,
        'package.json',
        manifest({ name: 'p', version: '1.0.0', private: true, files: ['guide.md'] }),
      );
      put(repo, 'packages/p/guide.md', '# a page the package really ships\n');
      fs.symlinkSync(real, path.join(repo, 'packages', 'p', 'package.json'));
      // The claim really is there to be believed — otherwise this would be the plain symlink case.
      expect(JSON.parse(fs.readFileSync(real, 'utf8')).private).toBe(true);
      const { found, unsupported } = discoverPublicMarkdown(repo);
      expect(found).toEqual([]);
      expect(unsupported).toEqual([
        "packages/p could not be packed by npm: holds the symlink package.json, whose target is not this repository's content",
      ]);
    });
  });

  it('a symlinked file NESTED inside the package tree is refused too', () => {
    withTrees((repo, outside) => {
      put(
        repo,
        'packages/p/package.json',
        manifest({ name: 'p', version: '1.0.0', files: ['docs'] }),
      );
      const secret = put(outside, 'secret.md', '# sentinel\n');
      fs.mkdirSync(path.join(repo, 'packages', 'p', 'docs'), { recursive: true });
      fs.symlinkSync(secret, path.join(repo, 'packages', 'p', 'docs', 'guide.md'));
      const { found, unsupported } = discoverPublicMarkdown(repo);
      expect(found).toEqual([]);
      expect(unsupported).toEqual([
        "packages/p could not be packed by npm: holds the symlink docs/guide.md, whose target is not this repository's content",
      ]);
    });
  });

  it(
    'a symlink under node_modules is not a package symlink — npm never packs that tree',
    () => {
      withTrees((repo, outside) => {
        put(
          repo,
          'packages/p/package.json',
          manifest({ name: 'p', version: '1.0.0', files: ['docs'] }),
        );
        put(repo, 'packages/p/docs/a.md', '# a\n');
        const dep = put(outside, 'dep.js', '');
        fs.mkdirSync(path.join(repo, 'packages', 'p', 'node_modules'), { recursive: true });
        fs.symlinkSync(dep, path.join(repo, 'packages', 'p', 'node_modules', 'dep.js'));
        expect(discoverPublicMarkdown(repo)).toEqual({
          found: ['packages/p/docs/a.md'],
          unsupported: [],
        });
      });
    },
    ONE_NPM_PACK_TIMEOUT,
  );

  /**
   * NO CACHE MEANS NO CACHE, AND HERE IS THE EDIT THAT PROVED IT MATTERED.
   *
   * The reader used to remember an answer under a `rel:size` fingerprint of the package tree. Two
   * manifests naming `a.md` and `b.md` are the same LENGTH, so the fingerprint cannot tell them
   * apart, and the second question was answered with the first question's package — `a.md`
   * reported as packed content of a package that ships `b.md`. Within ONE process, in the same
   * millisecond, the answer has to change.
   */
  it(
    'a same-size manifest edit changes the packed set immediately, in one process',
    () => {
      withTrees((repo) => {
        const withFile = (name: string): string =>
          manifest({ name: 'p', version: '1.0.0', files: [name] });
        expect(withFile('a.md').length, 'the two manifests are not the same size').toBe(
          withFile('b.md').length,
        );
        put(repo, 'packages/p/a.md', '# a\n');
        put(repo, 'packages/p/b.md', '# b\n');
        put(repo, 'packages/p/package.json', withFile('a.md'));
        expect(packedMarkdown(repo)).toEqual({ found: ['packages/p/a.md'], unsupported: [] });
        put(repo, 'packages/p/package.json', withFile('b.md'));
        expect(packedMarkdown(repo)).toEqual({ found: ['packages/p/b.md'], unsupported: [] });
      });
    },
    TWO_NPM_PACK_TIMEOUT,
  );

  it('a package npm REFUSES to pack is reported, not silently skipped', () => {
    withTrees((repo) => {
      // Valid JSON, so the manifest is read; no `version`, so npm will not pack it.
      put(repo, 'packages/p/package.json', manifest({ name: 'p', files: ['docs'] }));
      put(repo, 'packages/p/docs/guide.md', '# g\n');
      const { found, unsupported } = discoverPublicMarkdown(repo);
      expect(found).toEqual([]);
      expect(unsupported).toHaveLength(1);
      expect(unsupported[0]).toMatch(/^packages\/p could not be packed by npm: /);
    });
  }, 20_000);

  it(
    '`docs/*.md` reaches one level, and `docs/**` reaches every level',
    () => {
      withTrees((repo) => {
        put(
          repo,
          'packages/p/package.json',
          manifest({ name: 'p', version: '1.0.0', files: ['docs/*.md'] }),
        );
        put(repo, 'packages/p/docs/a.md', '# a\n');
        put(repo, 'packages/p/docs/nested/b.md', '# b\n');
        put(repo, 'packages/p/other/c.md', '# c\n');
        expect(discoverPublicMarkdown(repo)).toEqual({
          found: ['packages/p/docs/a.md'],
          unsupported: [],
        });
      });
      withTrees((repo) => {
        put(
          repo,
          'packages/p/package.json',
          manifest({ name: 'p', version: '1.0.0', files: ['docs/**'] }),
        );
        put(repo, 'packages/p/docs/nested/b.md', '# b\n');
        put(repo, 'packages/p/other/c.md', '# c\n');
        expect(discoverPublicMarkdown(repo)).toEqual({
          found: ['packages/p/docs/nested/b.md'],
          unsupported: [],
        });
      });
    },
    TWO_NPM_PACK_TIMEOUT,
  );

  /**
   * THE THREE THAT A HAND-WRITTEN GLOB GETS WRONG.
   *
   * Every one of these ships a page that a model built out of `**` → "one or more segments" plus
   * "read only the `files` array" discovers NOTHING for — and a page discovery misses is a page
   * that ships with no contract at all, which is the whole failure this section exists to prevent.
   */
  it(
    'a leading `**/` matches at the ROOT, so `**/*.md` packs a root-level page',
    () => {
      withTrees((repo) => {
        put(
          repo,
          'packages/p/package.json',
          manifest({ name: 'p', version: '1.0.0', files: ['**/*.md'] }),
        );
        put(repo, 'packages/p/guide.md', '# g\n');
        put(repo, 'packages/p/docs/deep/x.md', '# x\n');
        put(repo, 'packages/p/notes.txt', 'not markdown\n');
        expect(discoverPublicMarkdown(repo)).toEqual({
          found: ['packages/p/docs/deep/x.md', 'packages/p/guide.md'],
          unsupported: [],
        });
      });
    },
    ONE_NPM_PACK_TIMEOUT,
  );

  it(
    'a `**` in the middle matches ZERO segments, so `docs/**/x.md` packs `docs/x.md`',
    () => {
      withTrees((repo) => {
        put(
          repo,
          'packages/p/package.json',
          manifest({ name: 'p', version: '1.0.0', files: ['docs/**/x.md'] }),
        );
        put(repo, 'packages/p/docs/x.md', '# zero depth\n');
        put(repo, 'packages/p/docs/deep/x.md', '# deeper\n');
        put(repo, 'packages/p/docs/y.md', '# not named x\n');
        expect(discoverPublicMarkdown(repo)).toEqual({
          found: ['packages/p/docs/deep/x.md', 'packages/p/docs/x.md'],
          unsupported: [],
        });
      });
    },
    ONE_NPM_PACK_TIMEOUT,
  );

  it(
    '`main`, `browser` and `bin` drag their targets in whatever `files` says',
    () => {
      withTrees((repo) => {
        put(
          repo,
          'packages/p/package.json',
          manifest({
            name: 'p',
            version: '1.0.0',
            files: ['dist'],
            main: 'entry.md',
            browser: 'browser.md',
            bin: { p: './cli.md' },
          }),
        );
        put(repo, 'packages/p/dist/index.js', '');
        put(repo, 'packages/p/entry.md', '# main\n');
        put(repo, 'packages/p/browser.md', '# browser\n');
        put(repo, 'packages/p/cli.md', '# bin\n');
        put(repo, 'packages/p/unreferenced.md', '# nobody names this\n');
        expect(discoverPublicMarkdown(repo)).toEqual({
          found: ['packages/p/browser.md', 'packages/p/cli.md', 'packages/p/entry.md'],
          unsupported: [],
        });
      });
    },
    ONE_NPM_PACK_TIMEOUT,
  );

  it(
    'a negation in `files` really removes a page, and nothing is reported as unmodelled',
    () => {
      withTrees((repo) => {
        put(
          repo,
          'packages/p/package.json',
          manifest({ name: 'p', version: '1.0.0', files: ['docs/**', '!docs/private.md'] }),
        );
        put(repo, 'packages/p/docs/a.md', '# a\n');
        put(repo, 'packages/p/docs/private.md', '# not for readers\n');
        expect(discoverPublicMarkdown(repo)).toEqual({
          found: ['packages/p/docs/a.md'],
          unsupported: [],
        });
      });
    },
    ONE_NPM_PACK_TIMEOUT,
  );

  /**
   * LIFECYCLE, STATED RATHER THAN IMPLIED.
   *
   * npm is asked with `--ignore-scripts`, so `prepack` DOES NOT RUN and a page a `prepack` script
   * would create is NOT in the answer. That is a real limit of this section and it is asserted here
   * rather than left to be discovered: what is pinned here is the GLOB AND ALLOWLIST semantics of a
   * static tree. The bytes of the finished archive — including anything `prepack` puts in it — are
   * a different question, pinned by the packaged-artifact gate.
   *
   * The same test proves the isolation the answer depends on: the package npm was asked about is a
   * COPY, so even a `prepack` that did run could not have written into the tree under test.
   */
  it(
    'a page `prepack` would generate is NOT in this answer, and the tree is untouched',
    () => {
      withTrees((repo) => {
        put(
          repo,
          'packages/p/package.json',
          manifest({
            name: 'p',
            version: '1.0.0',
            files: ['docs'],
            // A shell redirect rather than a node one-liner: the suite's fs-binding gate reads this
            // file's SOURCE, and a `require('node:fs')` spelled out here would read as a real one.
            scripts: { prepack: "printf '# generated at pack time' > README.md" },
          }),
        );
        put(repo, 'packages/p/docs/a.md', '# a\n');
        expect(discoverPublicMarkdown(repo)).toEqual({
          found: ['packages/p/docs/a.md'],
          unsupported: [],
        });
        expect(fs.existsSync(path.join(repo, 'packages/p/README.md'))).toBe(false);
        expect(fs.readdirSync(path.join(repo, 'packages/p')).sort()).toEqual([
          'docs',
          'package.json',
        ]);
      });
    },
    ONE_NPM_PACK_TIMEOUT,
  );
});

describe('safety: no Markdown page slips out of the manifest through a link', () => {
  const FIXTURE = 'tests/fixtures/clients/README.md';
  const offContract = (text: string): string[] =>
    linkedMarkdown(text, 'README.md').filter((rel) => !PUBLIC_DOCS.some((doc) => doc.rel === rel));

  it('README.md as published links no page outside the manifest', () => {
    expect(offContract(read('README.md'))).toEqual([]);
  });

  it('a link to a page that IS under contract is not flagged', () => {
    expect(offContract(`${read('README.md')}\n\n[a](docs/DECISIONS.md)\n`)).toEqual([]);
  });

  for (const dest of [
    'tests/fixtures/clients/README.md',
    'tests/fixtures/clients/README.md#synthetic-client-config-fixtures',
    'tests/fixtures/clients/README%2emd',
    'tests/fixtures/clients/README.md?v=2',
    './tests/fixtures/../fixtures/clients/README.md',
    'docs/../tests/fixtures/clients/README.md',
  ]) {
    it(`README.md linking ${dest} is read as ${FIXTURE}`, () => {
      expect(offContract(`${read('README.md')}\n\n[a](${dest})\n`)).toEqual([FIXTURE]);
    });
  }

  it('the closure recognises a Markdown extension whatever its case, and `.markdown` too', () => {
    withTrees((repo) => {
      put(repo, 'docs/UNCOVERED.MD', '# u\n');
      put(repo, 'docs/other.markdown', '# o\n');
      expect(
        linkedMarkdown('[a](docs/UNCOVERED.MD) [b](docs/other.markdown)\n', 'README.md', repo),
      ).toEqual(['docs/UNCOVERED.MD', 'docs/other.markdown']);
    });
  });
});

describe('safety: a local destination is contained by its REAL path, not its lexical one', () => {
  const only = (repo: string, dest: string): Reading =>
    readSurface(`[a](${dest})\n`, 'README.md', repo);

  it('a symlinked FILE that leaves the tree is refused', () => {
    withTrees((repo, outside) => {
      const sentinel = put(outside, 'secret.md', '# sentinel\n');
      fs.mkdirSync(path.join(repo, 'docs'));
      fs.symlinkSync(sentinel, path.join(repo, 'docs', 'out.md'));
      const reading = only(repo, 'docs/out.md');
      expect(reading.local).toEqual([]);
      expect(reading.rejected).toEqual(['docs/out.md — escapes the repository through a symlink']);
    });
  });

  it('a symlinked DIRECTORY anywhere in the chain is refused too', () => {
    withTrees((repo, outside) => {
      put(outside, 'secret.md', '# sentinel\n');
      fs.mkdirSync(path.join(repo, 'docs'));
      fs.symlinkSync(outside, path.join(repo, 'docs', 'away'));
      const reading = only(repo, 'docs/away/secret.md');
      expect(reading.local).toEqual([]);
      expect(reading.rejected).toEqual([
        'docs/away/secret.md — escapes the repository through a symlink',
      ]);
    });
  });

  it('a symlink that STAYS inside the tree is still a local link', () => {
    withTrees((repo) => {
      put(repo, 'docs/real.md', '# real\n');
      fs.symlinkSync(path.join(repo, 'docs', 'real.md'), path.join(repo, 'docs', 'alias.md'));
      const reading = only(repo, 'docs/alias.md');
      expect(reading.rejected).toEqual([]);
      expect(reading.local).toEqual(['docs/alias.md']);
    });
  });

  it('a dangling symlink is a dead link, not a live one', () => {
    withTrees((repo) => {
      fs.mkdirSync(path.join(repo, 'docs'));
      fs.symlinkSync(path.join(repo, 'docs', 'gone.md'), path.join(repo, 'docs', 'ghost.md'));
      expect(only(repo, 'docs/ghost.md').rejected).toEqual([
        'docs/ghost.md — names nothing in the repository',
      ]);
    });
  });
});

/**
 * THE npm THAT ANSWERS IS THE ONE THAT SHIPS BESIDE THIS NODE — NEVER THE ONE ON `PATH`.
 *
 * The packed-file question is answered by spawning npm, so WHICH npm is a security decision. A
 * `PATH` lookup would hand it to the environment, and the environment is what an attacker on a
 * build machine owns. It would also be WRONG on two layouts that are not exotic at all: Homebrew's
 * node lives in a Cellar prefix that holds no `lib/node_modules` (npm is reachable only through the
 * `npm` symlink beside the binary), and `actions/setup-node` on Windows puts `node_modules/npm`
 * ADJACENT to `node.exe` rather than an `../lib` away. Each layout is asserted below against a tree
 * built for it, and every failure mode returns `null` — which the caller reports as unmodelled
 * rather than papering over.
 */
describe('safety: npm is resolved from this process’s own node, never from PATH', () => {
  const layout = (run: (root: string) => void): void => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sthayi-npm-'));
    try {
      run(root);
    } finally {
      removeTree(root);
    }
  };

  const plant = (abs: string): string => {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, '#!/usr/bin/env node\n');
    return abs;
  };

  it('the OFFICIAL Unix layout: npm an ../lib away from the node that is running', () => {
    layout((root) => {
      const node = plant(path.join(root, 'bin', 'node'));
      const cli = plant(path.join(root, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
      expect(resolveNpmCli(node)).toBe(cli);
    });
  });

  it('the ADJACENT layout setup-node lays down on Windows: npm a sibling of node.exe', () => {
    layout((root) => {
      const node = plant(path.join(root, 'node.exe'));
      // The Unix candidate is not merely absent here, it is structurally wrong.
      expect(fs.existsSync(path.join(root, '..', 'lib', 'node_modules'))).toBe(false);
      const cli = plant(path.join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
      expect(resolveNpmCli(node)).toBe(cli);
    });
  });

  /**
   * HOMEBREW'S REAL SHAPE, WHICH IS A KEG AND A PREFIX RATHER THAN A DIRECTORY AND A LINK.
   *
   * `<prefix>/Cellar/node/<version>/bin/node` is the binary; the keg's own `lib/` holds a dylib and
   * no `node_modules` at all; and the `npm` beside the binary is a symlink pointing OUT of the keg
   * into `<prefix>/lib/node_modules/npm/bin/npm-cli.js`. The prefix is what ties the two together,
   * and it is the whole of what makes the link followable — see the refusals below.
   */
  const brewLayout = (
    root: string,
  ): { prefix: string; node: string; keg: string; version: string } => {
    const prefix = path.join(root, 'opt', 'homebrew');
    const version = '25.8.1_1';
    const keg = path.join(prefix, 'Cellar', 'node', version);
    return { prefix, keg, version, node: plant(path.join(keg, 'bin', 'node')) };
  };

  it('the HOMEBREW shape: no lib/node_modules in the keg, only an npm symlink beside node', () => {
    layout((root) => {
      const { prefix, keg, node } = brewLayout(root);
      const cli = plant(path.join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
      fs.symlinkSync(cli, path.join(keg, 'bin', 'npm'));
      expect(fs.existsSync(path.join(keg, 'lib'))).toBe(false);
      expect(resolveNpmCli(node)).toBe(fs.realpathSync(cli));
    });
  });

  it('an adjacent npm symlink whose realpath is NOT npm/bin/npm-cli.js is refused', () => {
    layout((root) => {
      const { prefix, keg, node } = brewLayout(root);
      plant(path.join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
      const impostor = plant(path.join(root, 'evil', 'bin', 'npm-cli.js'));
      fs.symlinkSync(impostor, path.join(keg, 'bin', 'npm'));
      expect(resolveNpmCli(node)).toBeNull();
    });
  });

  /**
   * THE REASON A SUFFIX IS NOT A TRUST DECISION.
   *
   * `npm/bin/npm-cli.js` is three directory names. Any writable directory on the machine can be
   * given them, so a resolver that asks only whether the realpath ENDS in those segments has asked
   * a question the attacker gets to answer: plant `<anywhere>/npm/bin/npm-cli.js`, point the
   * adjacent `npm` link at it, and an arbitrary script is spawned as npm with this process's own
   * node. The target here is correctly suffixed in every respect and sits outside the prefix the
   * running node came from — which is the only thing wrong with it, and the only thing that has to
   * be wrong with it.
   */
  it('an adjacent npm symlink to a correctly-suffixed target OUTSIDE the prefix is refused', () => {
    layout((root) => {
      const { prefix, keg, node } = brewLayout(root);
      // The LEGITIMATE npm is planted too, so the refusal below cannot come from the permitted
      // path being missing. Everything about this tree is a working Homebrew install except which
      // file the adjacent link points at.
      const genuine = plant(path.join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
      expect(fs.existsSync(genuine)).toBe(true);
      const planted = plant(path.join(root, 'elsewhere', 'npm', 'bin', 'npm-cli.js'));
      expect(planted.split(path.sep).slice(-3), 'the decoy is not correctly suffixed').toEqual([
        'npm',
        'bin',
        'npm-cli.js',
      ]);
      fs.symlinkSync(planted, path.join(keg, 'bin', 'npm'));
      expect(resolveNpmCli(node), 'a suffix match outside the prefix was followed').toBeNull();
    });
  });

  it('the same link, inside the prefix but not at the one path the layout permits, is refused', () => {
    layout((root) => {
      const { prefix, keg, node } = brewLayout(root);
      const genuine = plant(path.join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
      expect(fs.existsSync(genuine)).toBe(true);
      const planted = plant(
        path.join(prefix, 'lib', 'node_modules', 'evil', 'npm', 'bin', 'npm-cli.js'),
      );
      fs.symlinkSync(planted, path.join(keg, 'bin', 'npm'));
      expect(resolveNpmCli(node), 'a suffix match inside the prefix was followed').toBeNull();
    });
  });

  it('an npm symlink beside a node that is not in a Cellar keg is not the Homebrew layout', () => {
    layout((root) => {
      // Everything the Homebrew branch wants except the `Cellar/node/<version>` shape, and the two
      // structural candidates are genuinely absent — so this is the symlink route or nothing.
      const node = plant(path.join(root, 'somewhere', 'bin', 'node'));
      const cli = plant(path.join(root, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
      fs.symlinkSync(cli, path.join(root, 'somewhere', 'bin', 'npm'));
      expect(fs.existsSync(path.join(root, 'somewhere', 'lib', 'node_modules'))).toBe(false);
      expect(fs.existsSync(path.join(root, 'somewhere', 'bin', 'node_modules'))).toBe(false);
      expect(resolveNpmCli(node)).toBeNull();
    });
  });

  it('a keg under a formula that is not `node` is refused rather than guessed at', () => {
    layout((root) => {
      const prefix = path.join(root, 'opt', 'homebrew');
      const keg = path.join(prefix, 'Cellar', 'node@22', '22.14.0');
      const node = plant(path.join(keg, 'bin', 'node'));
      const cli = plant(path.join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
      fs.symlinkSync(cli, path.join(keg, 'bin', 'npm'));
      expect(resolveNpmCli(node)).toBeNull();
    });
  });

  it('an adjacent npm that is a WRAPPER file rather than a symlink is refused', () => {
    layout((root) => {
      // In the keg shape, so the refusal is the symlink check answering and not the layout check
      // declining to look — the whole rest of the Homebrew branch is reachable from here.
      const { prefix, keg, node } = brewLayout(root);
      plant(path.join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
      plant(path.join(keg, 'bin', 'npm'));
      expect(fs.lstatSync(path.join(keg, 'bin', 'npm')).isSymbolicLink()).toBe(false);
      expect(resolveNpmCli(node)).toBeNull();
    });
  });

  it('a node with no npm anywhere beside it resolves nothing, and says so', () => {
    layout((root) => {
      const node = plant(path.join(root, 'bin', 'node'));
      expect(resolveNpmCli(node)).toBeNull();
    });
  });

  it('a hostile npm EARLIER ON PATH is never chosen — PATH is not consulted at all', () => {
    layout((root) => {
      const node = plant(path.join(root, 'bin', 'node'));
      const decoy = path.join(root, 'decoy');
      plant(path.join(decoy, 'npm'));
      plant(path.join(decoy, 'npm-cli.js'));
      const saved = process.env.PATH;
      try {
        process.env.PATH = `${decoy}${path.delimiter}${saved ?? ''}`;
        expect(resolveNpmCli(node), 'a PATH entry was accepted as npm').toBeNull();
      } finally {
        process.env.PATH = saved;
      }
      // And with a real npm beside node, the decoy still loses to the layout.
      const cli = plant(path.join(root, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
      const saved2 = process.env.PATH;
      try {
        process.env.PATH = `${decoy}${path.delimiter}${saved2 ?? ''}`;
        expect(resolveNpmCli(node)).toBe(cli);
      } finally {
        process.env.PATH = saved2;
      }
    });
  });

  /**
   * A proof against THIS machine's Homebrew installation. Homebrew has shipped both layouts the
   * resolver supports: npm inside the Node keg (the ordinary Unix candidate), and npm in the shared
   * prefix behind the adjacent `npm` symlink. Detect which real layout is installed and require the
   * exact corresponding answer. The synthetic cases above remain the unconditional proof of the
   * fallback and all of its refusal boundaries.
   */
  const BREW_NODE = '/opt/homebrew/bin/node';
  const brewIt = fs.existsSync(BREW_NODE) ? it : it.skip;
  brewIt('a Homebrew node on this machine resolves a real npm-cli.js', () => {
    const execPath = fs.realpathSync(BREW_NODE);
    const unixCandidate = path.resolve(
      path.dirname(execPath),
      '..',
      'lib',
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js',
    );
    const resolved = resolveNpmCli(execPath);
    expect(resolved, 'Homebrew node resolves no npm at all').not.toBeNull();
    expect(fs.statSync(resolved ?? '').isFile()).toBe(true);
    if (fs.existsSync(unixCandidate)) {
      expect(resolved).toBe(unixCandidate);
      return;
    }
    // AND IT IS THE ONE PATH THE LAYOUT PERMITS, not merely a path ending in those three segments.
    // The prefix is read off the running binary — `<prefix>/Cellar/node/<version>/bin/node` — and
    // the npm that answered has to be the one that prefix owns.
    const keg = path.dirname(path.dirname(execPath));
    expect(path.basename(path.dirname(keg)), 'this Homebrew node is not in a node keg').toBe(
      'node',
    );
    expect(path.basename(path.dirname(path.dirname(keg)))).toBe('Cellar');
    const prefix = path.dirname(path.dirname(path.dirname(keg)));
    expect(resolved).toBe(
      fs.realpathSync(path.join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')),
    );
  });
});

/**
 * THE CHILD'S ENVIRONMENT IS WRITTEN, NOT INHERITED — AND IT IS WRITTEN FOR BOTH PLATFORMS.
 *
 * `HOME` and `TMPDIR` are the POSIX half of the answer. On Windows npm reads `USERPROFILE` for the
 * user's config and `TEMP`/`TMP` for scratch, so setting only the POSIX pair there leaves the run
 * writing into the DEVELOPER'S profile and the machine's temp — the two places the fixture exists
 * to stay out of.
 */
describe('safety: the npm the pack model spawns is hermetic in its home and its temp', () => {
  const FIXTURE = path.join(path.sep, 'fx');
  const home = path.join(FIXTURE, 'home');
  const cache = path.join(FIXTURE, 'cache');

  it('every home and temp variable either platform consults points inside the fixture', () => {
    const env = packChildEnv(home, cache, {});
    expect(env.HOME).toBe(home);
    expect(env.USERPROFILE).toBe(home);
    expect(env.TEMP).toBe(cache);
    expect(env.TMP).toBe(cache);
    expect(env.TMPDIR).toBe(cache);
    expect(env.npm_config_cache).toBe(cache);
  });

  it('every path the child is handed is contained by the throwaway fixture', () => {
    const env = packChildEnv(home, cache, {});
    for (const name of [
      'HOME',
      'USERPROFILE',
      'TEMP',
      'TMP',
      'TMPDIR',
      'npm_config_cache',
      'npm_config_userconfig',
      'npm_config_globalconfig',
    ]) {
      const value = env[name] ?? '';
      expect(
        value === FIXTURE || value.startsWith(`${FIXTURE}${path.sep}`),
        `${name} is ${value}, which is outside the fixture`,
      ).toBe(true);
    }
  });

  it('nothing from the ambient environment reaches the child but machine-shape constants', () => {
    const env = packChildEnv(home, cache, {
      SECRET_TOKEN: 'ghp_not_for_the_child',
      NPM_TOKEN: 'also-not',
      npm_config_registry: 'https://registry.invalid',
      HOME: '/home/developer',
      USERPROFILE: 'C:\\Users\\developer',
      TEMP: 'C:\\Users\\developer\\AppData\\Local\\Temp',
      SystemRoot: 'C:\\Windows',
      windir: 'C:\\Windows',
      ComSpec: 'C:\\Windows\\system32\\cmd.exe',
      PATHEXT: '.COM;.EXE;.BAT',
    });
    expect(env.SECRET_TOKEN).toBeUndefined();
    expect(env.NPM_TOKEN).toBeUndefined();
    expect(env.npm_config_registry).toBeUndefined();
    expect(env.HOME).toBe(home);
    expect(env.USERPROFILE).toBe(home);
    expect(env.TEMP).toBe(cache);
    // The four the child genuinely cannot run without on Windows, and none of them is a secret.
    expect(env.SystemRoot).toBe('C:\\Windows');
    expect(env.windir).toBe('C:\\Windows');
    expect(env.ComSpec).toBe('C:\\Windows\\system32\\cmd.exe');
    expect(env.PATHEXT).toBe('.COM;.EXE;.BAT');
  });

  /** Everything the child is given that does not come from the ambient environment at all. */
  const WRITTEN = [
    'HOME',
    'PATH',
    'TEMP',
    'TMP',
    'TMPDIR',
    'USERPROFILE',
    'npm_config_audit',
    'npm_config_cache',
    'npm_config_fund',
    'npm_config_globalconfig',
    'npm_config_ignore_scripts',
    'npm_config_offline',
    'npm_config_update_notifier',
    'npm_config_userconfig',
  ];

  it('the whole variable set is closed — a new name has to be added here on purpose', () => {
    expect(Object.keys(packChildEnv(home, cache, {})).sort()).toEqual([...WRITTEN].sort());
    expect(
      Object.keys(
        packChildEnv(home, cache, { SystemRoot: 'C:\\Windows', SECRET_TOKEN: 'nope' }),
      ).sort(),
    ).toEqual([...WRITTEN, 'SystemRoot'].sort());
  });

  it('PATH is the directory of THIS node and nothing else', () => {
    const env = packChildEnv(home, cache, { PATH: '/opt/hostile/bin' });
    expect(env.PATH).toBe(path.dirname(process.execPath));
  });
});

/**
 * WHERE THE BROWSER AND THE FILESYSTEM DISAGREE, THE BROWSER IS THE READER.
 *
 * A destination is judged by where it sends someone, and on a published page that is a WHATWG URL
 * resolution against an https base — where a backslash is a path separator, so a LEADING one starts
 * an authority and `\outside.xyz` is the host `outside.xyz`. A POSIX filesystem says the opposite:
 * `\outside.xyz` is one ordinary filename, and a repository holding a file by that name makes the
 * destination resolve, contain, and pass as a local link. Windows says a third thing again.
 *
 * The file is really put on disk in each test below, because a refusal that only happens when the
 * path is missing is not the guard — "names nothing in the repository" would pass these tests while
 * the hole stayed open.
 */
describe('safety: a destination a browser reads as another host is refused whatever the disk says', () => {
  /** One backslash, and two: a path separator, and the `//` that starts an authority. */
  const ESCAPES = '\\outside.xyz';
  const AUTHORITY_ESCAPES = '\\\\outside.xyz';

  const reasons = (reading: Reading): string[] =>
    reading.rejected.map((line) => line.split(' — ')[1] ?? '');

  const plantHostReading = (repo: string, relative: string): void => {
    const planted = path.join(repo, relative);
    fs.mkdirSync(path.dirname(planted), { recursive: true });
    fs.writeFileSync(planted, '# sentinel\n');
    expect(fs.existsSync(planted), `the host filesystem did not create ${relative}`).toBe(true);
  };

  it('WHATWG resolution against an https base lands nowhere near where the filesystem does', () => {
    const base = 'https://sthayi.example/docs/page.md';
    // ONE backslash is a path separator, so the destination is ROOT-relative — not the sibling
    // file next to the page that `path.resolve` on POSIX finds.
    expect(new URL(ESCAPES, base).href).toBe('https://sthayi.example/outside.xyz');
    // TWO make the `//` that opens an authority, and the reader leaves for another host entirely.
    expect(new URL(AUTHORITY_ESCAPES, base).href).toBe('https://outside.xyz/');
  });

  it('the doubled form, which really does change host, is refused with the file on disk', () => {
    withTrees((repo) => {
      plantHostReading(repo, AUTHORITY_ESCAPES);
      const reading = readSurface(`<a href="${AUTHORITY_ESCAPES}">a</a>\n`, 'README.md', repo);
      expect(reading.local).toEqual([]);
      expect(reading.origins).toEqual([]);
      expect(reading.rejected.map((line) => line.split(' — ')[0])).toEqual([AUTHORITY_ESCAPES]);
      expect(reasons(reading)[0]).toMatch(/^carries a backslash/);
    });
  });

  it('raw HTML href with a backslash is refused, and the file really is on disk', () => {
    withTrees((repo) => {
      plantHostReading(repo, ESCAPES);
      const reading = readSurface(`<a href="${ESCAPES}">a</a>\n`, 'README.md', repo);
      expect(reading.local, 'a browser would leave the host on this link').toEqual([]);
      expect(reading.origins).toEqual([]);
      expect(reading.rejected.map((line) => line.split(' — ')[0])).toEqual([ESCAPES]);
      expect(reasons(reading)[0]).toMatch(/^carries a backslash/);
    });
  });

  it('the same destination written as Markdown is refused under BOTH spellings it renders to', () => {
    withTrees((repo) => {
      plantHostReading(repo, ESCAPES);
      const reading = readSurface(`[a](${ESCAPES})\n`, 'README.md', repo);
      expect(reading.local).toEqual([]);
      expect(reading.origins).toEqual([]);
      // The written spelling and the percent-encoded spelling rendering produces, both refused.
      expect(reading.rejected.map((line) => line.split(' — ')[0]).sort()).toEqual(
        ['%5Coutside.xyz', ESCAPES].sort(),
      );
      for (const reason of reasons(reading)) {
        expect(reason).toMatch(/^carries a backslash/);
      }
    });
  });

  it('a backslash anywhere in the path is refused, not only a leading one', () => {
    withTrees((repo) => {
      plantHostReading(repo, path.join('docs', 'a\\b.md'));
      const reading = readSurface('[a](docs/a\\b.md)\n', 'README.md', repo);
      expect(reading.local).toEqual([]);
      for (const reason of reasons(reading)) {
        expect(reason).toMatch(/^carries a backslash/);
      }
    });
  });

  /**
   * AND THE OTHER SIDE OF THE `?`, WHERE THERE IS NO DISAGREEMENT TO FAIL CLOSED ON.
   *
   * Every reading above is a reading of a PATH. WHATWG turns a backslash into a separator while
   * parsing the path — `docs\page.md` against `https://h/x/` really is `/x/docs/page.md` — and that
   * is the disagreement with `path.resolve` the refusal exists for. Past the `?` none of it holds:
   * a query is opaque to every resolver, the file named is the same file under all three readings,
   * and a link carrying one is not in dispute. Refusing it costs a legitimate destination and buys
   * nothing at all, so the checks are applied to the path component and stop there.
   */
  it('CONTROL: a backslash in the QUERY is data, and the page it names is still a local link', () => {
    withTrees((repo) => {
      put(repo, 'docs/page.md', '# ordinary\n');
      // The browser reading and the filesystem reading agree here — same file, backslash and all.
      expect(new URL('docs/page.md?q=\\part', 'https://sthayi.example/').href).toBe(
        'https://sthayi.example/docs/page.md?q=\\part',
      );
      const reading = readSurface('<a href="docs/page.md?q=\\part">a</a>\n', 'README.md', repo);
      expect(reading.rejected, 'a backslash in the query was read as a path separator').toEqual([]);
      expect(reading.local).toEqual(['docs/page.md?q=\\part']);
    });
  });

  it('CONTROL: a percent-encoded and a doubled backslash in the query are data as well', () => {
    withTrees((repo) => {
      put(repo, 'docs/page.md', '# ordinary\n');
      for (const dest of ['docs/page.md?q=%5Cpart', 'docs/page.md?q=\\\\part']) {
        const reading = readSurface(`<a href="${dest}">a</a>\n`, 'README.md', repo);
        expect(reading.rejected, `${dest} was refused`).toEqual([]);
        expect(reading.local).toEqual([dest]);
      }
    });
  });

  it('the PATH is still judged when a query follows it, under every spelling', () => {
    withTrees((repo) => {
      // Each file is really planted, so "names nothing in the repository" cannot stand in for the
      // refusal that is being asserted.
      plantHostReading(repo, path.join('docs', 'a\\b.md'));
      plantHostReading(repo, path.join('docs', 'a\\\\b.md'));
      for (const dest of ['docs/a\\b.md?q=1', 'docs/a%5Cb.md?q=1', 'docs/a\\\\b.md?q=1']) {
        const reading = readSurface(`<a href="${dest}">a</a>\n`, 'README.md', repo);
        expect(reading.local, `${dest} was accepted as a local link`).toEqual([]);
        expect(reasons(reading)[0], `${dest} was not refused for its backslash`).toMatch(
          /^carries a backslash/,
        );
      }
    });
  });

  it('CONTROL: the same page, the same tree, an ordinary name — still a local link', () => {
    withTrees((repo) => {
      put(repo, 'docs/outside.xyz.md', '# ordinary\n');
      const reading = readSurface('[a](docs/outside.xyz.md)\n', 'README.md', repo);
      expect(reading.rejected).toEqual([]);
      expect(reading.local).toEqual(['docs/outside.xyz.md']);
    });
  });
});

describe('safety: the fragments the published pages really offer resolve to real anchors', () => {
  it('README.md defines the anchor its own in-page links address', () => {
    expect(anchorsOf(read('README.md')).has('upgrade--uninstall')).toBe(true);
    expect(readSurface(read('README.md'), 'README.md').local).toContain('#upgrade--uninstall');
  });

  // Pinned as a SET, both ways, like everything else here: a page that starts offering a fragment,
  // or stops offering one, has to say so on purpose. It also keeps the check above from going
  // vacuous the day the last fragment link is deleted.
  it('the fragment links the published pages offer are exactly these', () => {
    const offered: string[] = [];
    for (const { rel } of PUBLIC_DOCS) {
      const reading = readSurface(read(rel), rel);
      expect(reading.rejected, `${rel} offers a destination that is refused`).toEqual([]);
      offered.push(...reading.local.filter((d) => d.includes('#')).map((d) => `${rel} → ${d}`));
    }
    expect(offered.sort()).toEqual([
      'README.md → #development',
      'README.md → #upgrade--uninstall',
      'SECURITY.md → README.md#quickstart',
    ]);
  });

  it('a heading inside a fenced block defines no anchor', () => {
    expect(anchorsOf('```md\n## Fenced\n```\n').has('fenced')).toBe(false);
  });

  it('duplicate headings are suffixed in document order', () => {
    const anchors = anchorsOf('## Notes\n\n## Notes\n\n## Notes\n');
    expect([...anchors].sort()).toEqual(['notes', 'notes-1', 'notes-2']);
  });

  it('an id inside a comment declares nothing, and `name` only anchors on `<a>`', () => {
    expect([...anchorsOf('<!-- <span id="ghost"></span> -->\n')]).toEqual([]);
    expect([...anchorsOf('<span name="s"></span>\n')]).toEqual([]);
    expect([...anchorsOf('<a name="a"></a>\n')]).toEqual(['a']);
    expect([...anchorsOf('<section id="any-element"></section>\n')]).toEqual(['any-element']);
  });
});
