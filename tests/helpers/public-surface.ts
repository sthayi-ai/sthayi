import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Comment, Element, Root as HastRoot, Text as HastText } from 'hast';
import type { Root as MdastRoot } from 'mdast';
import { find, html } from 'property-information';
import rehypeRaw from 'rehype-raw';
import rehypeSlug from 'rehype-slug';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { parseSrcset } from 'srcset';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';

/**
 * THE READERS BEHIND `tests/safety/public-surface-invariants.test.ts`.
 *
 * Two questions are answered here and nowhere else in the suite:
 *
 *   · where does a reader of a published page actually END UP, and what does the page NAME that is
 *     not a destination;
 *   · which files does npm really put in the tarball.
 *
 * Both used to be answered by patterns written here. They are not any more. Markdown, HTML, GitHub
 * heading slugs and `srcset` are each a grammar with edge cases that a pattern gets wrong QUIETLY —
 * a mismatched backtick run read as a code span, an `id=` inside a comment read as an anchor, a
 * `>` inside a quoted attribute ending the tag early — and every one of those mistakes hides a
 * destination rather than inventing one. So each grammar is delegated to the implementation the
 * ecosystem already trusts:
 *
 *   · `remark-parse` + `remark-gfm` for CommonMark and GFM (fences, code spans, link references,
 *     escapes, character references, autolink literals);
 *   · `remark-rehype` + `rehype-raw` to render that to the HTML a reader really meets, with raw
 *     HTML re-parsed by parse5 rather than tokenized here;
 *   · `rehype-slug` (github-slugger) for heading anchors, which is the slugger GitHub's own anchors
 *     are modelled on;
 *   · `property-information` to map a hast property back to the attribute it was written as, and to
 *     say which attributes the HTML spec defines as space-separated token lists;
 *   · the `srcset` package for the `srcset`/`imagesrcset` candidate grammar;
 *   · `npm pack --dry-run --json` for the packed-file set.
 *
 * The FINAL traversal is over the HAST — the rendered tree — because that is the document the
 * reader is handed. The MDAST is read as well, and only ever ADDITIVELY: reference DEFINITIONS,
 * which carry a destination that renders to nothing when unreferenced; their labels and titles; and
 * the URL a link or an image was WRITTEN with, which rendering percent-encodes.
 */

const helpersDir = path.dirname(fileURLToPath(import.meta.url));
export const defaultRoot = path.resolve(helpersDir, '..', '..');

/**
 * Markdown by EXTENSION, CASE-INSENSITIVELY, and `.markdown` counts too. A page is no less a page
 * for being `ROOT.MD`: GitHub renders it, npm packs it, and a reader meets it exactly the same way.
 */
export const MARKDOWN_EXT = /\.(?:md|markdown)$/i;

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeSlug);

/** The two trees one text produces. The MDAST is captured BEFORE the run, so it is the parse. */
type Trees = { mdast: MdastRoot; hast: HastRoot };

const treeCache = new Map<string, Trees>();

function treesOf(text: string): Trees {
  const cached = treeCache.get(text);
  if (cached !== undefined) {
    return cached;
  }
  const mdast = processor.parse(text);
  const hast = processor.runSync(mdast) as unknown as HastRoot;
  const trees: Trees = { mdast, hast };
  treeCache.set(text, trees);
  return trees;
}

// ---------------------------------------------------------------------------------------------
// Destinations, read off the rendered tree.
// ---------------------------------------------------------------------------------------------

/**
 * A URL written out in RUNNING TEXT rather than as a link construct — inside a fenced block, inside
 * a code span, or in prose that GFM's autolink extension does not linkify. This is a shape test on
 * a string the parser already handed over as text; it is not a Markdown or an HTML grammar, and it
 * only ever ADDS destinations.
 *
 * `FIRST` admits a bracketed IPv6 literal or one ordinary URL character, which is what keeps
 * `Note:**` from reading as a destination.
 */
const FIRST = String.raw`(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9/%_~#@?&=+.-])`;
const REST = String.raw`[^\s<>()[\]"'\`]*`;
const AUTHORITY = new RegExp(
  String.raw`(?<![A-Za-z0-9+.\-/])([A-Za-z][A-Za-z0-9+.-]*:\/\/${FIRST}${REST})`,
  'g',
);
const PROTOCOL_RELATIVE = new RegExp(
  String.raw`(?<![A-Za-z0-9+.:\-/])(\/\/(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._~%@-]+)(?::\d+)?(?:\/${REST})?)`,
  'g',
);

/** Does this value already carry a scheme or an authority? */
const CARRIES_AUTHORITY = /^\s*(?:[A-Za-z][A-Za-z0-9+.-]*:|\/\/)/;

/**
 * A dotted token: labels joined by dots, the last of them at least two letters long. No suffix is
 * consulted — every dotted token is a candidate hostname until `localNames` accounts for it.
 */
const DOTTED =
  /(?<![A-Za-z0-9._~%-])(?:[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?\.)+[A-Za-z][A-Za-z0-9-]+\b/g;

/**
 * Attributes that carry a destination. An attribute OUTSIDE this set is not waved through: if its
 * value carries a scheme or an authority it is read as a destination anyway, so a novel
 * destination-bearing attribute fails closed instead of shipping unread.
 */
const HTML_DESTINATION_ATTRS: ReadonlySet<string> = new Set([
  'action',
  'archive',
  'background',
  'cite',
  'classid',
  'codebase',
  'data',
  'formaction',
  'href',
  'icon',
  'imagesrcset',
  'longdesc',
  'manifest',
  'ping',
  'poster',
  'profile',
  'src',
  'srcset',
  'usemap',
  'xlink:href',
]);

/** The two attributes whose value is a `srcset` candidate list. */
const SRCSET_ATTRS: ReadonlySet<string> = new Set(['imagesrcset', 'srcset']);

/** One destination, and the reason it is refused outright if it is. */
type Found = { dest: string; refuse?: string };

/** What a text — or a comment, or a leftover attribute value — leaves behind once URLs are taken. */
type Scan = { found: Found[]; rest: string };

/**
 * Take every URL-shaped run out of a string and hand back what is left. Both halves come from ONE
 * pass over ONE string, so the offsets the scanners report and the offsets the leftovers are cut at
 * are the same UTF-16 code-unit quantities by construction — there is no second indexing model to
 * disagree with the first.
 */
function scanText(value: string): Scan {
  const taken = new Array<boolean>(value.length).fill(false);
  const found: Found[] = [];
  for (const pattern of [AUTHORITY, PROTOCOL_RELATIVE]) {
    pattern.lastIndex = 0;
    for (const hit of value.matchAll(pattern)) {
      const url = hit[1] ?? '';
      if (url === '') {
        continue;
      }
      found.push({ dest: url });
      for (let i = hit.index; i < hit.index + hit[0].length; i += 1) {
        taken[i] = true;
      }
    }
  }
  let rest = '';
  for (let i = 0; i < value.length; i += 1) {
    rest += taken[i] === true ? ' ' : (value[i] ?? '');
  }
  return { found, rest };
}

/** Everything one page offers: destinations, and every scrap of text that is not one. */
type Surface = { found: Found[]; text: string[] };

/** What one attribute of one element contributes: destinations, and text that is not one. */
type AttrReading = { found: Found[]; rest: string[] };

/**
 * A URL THE `srcset` GRAMMAR ITSELF WOULD ACCEPT AS A DESCRIPTOR — asked of the grammar, not of a
 * pattern written here. The token is offered to the strict parser as the descriptor of a URL that
 * cannot appear anywhere else, and a token is a descriptor only if the parser reads it as the width
 * or the density of that candidate.
 */
const DESCRIPTOR_PROBE = 'https://descriptor.invalid/probe';

function isSrcsetDescriptor(token: string): boolean {
  try {
    const [candidate] = parseSrcset(`${DESCRIPTOR_PROBE} ${token}`, { strict: true });
    return (
      candidate !== undefined &&
      (candidate.width !== undefined || candidate.density !== undefined) &&
      candidate.url === DESCRIPTOR_PROBE
    );
  } catch {
    return false;
  }
}

/**
 * EVERYTHING IN THE VALUE THAT THE CANDIDATE LIST DOES NOT ACCOUNT FOR.
 *
 * A `srcset` parser reports the candidates it RECOGNISED; it does not report what it walked past.
 * The implementation this contract delegates to splits on a candidate pattern and keeps the capture
 * groups, so text between matches is dropped on the floor — and a candidate the pattern cannot
 * match is dropped with it. `x, https://allowed.example/a 2x` is the whole failure in one line: `x`
 * is a legitimate one-character fallback candidate that the pattern's `[^,]\S*[^,]` (two characters
 * minimum) cannot match, so the value reads as the ALLOWED origin alone and a reader is sent to a
 * destination this contract never saw.
 *
 * So the value is COVERED rather than trusted. Each reported candidate URL is located in the raw
 * value in order and consumed; whatever is left over between and after them must be nothing but
 * separators and descriptors the grammar itself accepts. Any other leftover token means the parse
 * did not read the whole input, and an unread input is refused — and the leftover token is
 * classified as a destination in its own right, so it answers for itself either way.
 */
/**
 * Where a candidate URL really sits in the raw value: the first occurrence at or after `from` that
 * is DELIMITED — bounded on each side by the start or end of the value, whitespace, or a comma.
 * A plain `indexOf` finds `x` inside the descriptor `1x` and consumes the wrong run, which reports
 * a covered value as uncovered; the boundary is what keeps a candidate from being located inside
 * another token.
 */
function locateCandidate(raw: string, url: string, from: number): number {
  const delimits = (ch: string): boolean => ch === '' || ch === ',' || /\s/.test(ch);
  for (let at = raw.indexOf(url, from); at !== -1; at = raw.indexOf(url, at + 1)) {
    const before = at === 0 ? '' : (raw[at - 1] ?? '');
    const after = raw[at + url.length] ?? '';
    if (delimits(before) && delimits(after)) {
      return at;
    }
  }
  return -1;
}

function srcsetLeftovers(raw: string, urls: readonly string[]): string[] {
  const gaps: string[] = [];
  let cursor = 0;
  for (const url of urls) {
    const at = url === '' ? -1 : locateCandidate(raw, url, cursor);
    if (at === -1) {
      gaps.push(raw.slice(cursor));
      cursor = raw.length;
      break;
    }
    gaps.push(raw.slice(cursor, at));
    cursor = at + url.length;
  }
  gaps.push(raw.slice(cursor));
  return gaps
    .flatMap((gap) => gap.split(/[\s,]+/))
    .filter((token) => token !== '' && !isSrcsetDescriptor(token));
}

/**
 * A `<meta http-equiv=refresh>` CONTENT DIRECTIVE, PARSED WITH THE GRAMMAR THAT DEFINES IT.
 *
 * This is the one construct on a page that takes a reader somewhere with no click at all, and its
 * destination does not sit in an attribute any destination table names — it is buried in `content`,
 * behind a time, a separator, an optional `url` keyword, an optional `=` and optional quoting. A
 * reader that only knows `href` and `src` never sees it.
 *
 * The grammar is not re-invented here: these are the HTML Standard's own "shared declarative
 * refresh steps", in order — skip whitespace; collect the digits of the time (a bare leading `.` is
 * allowed where the standard allows it); if the value ends there it is a RELOAD and names no
 * destination; otherwise the next character must be `;`, `,` or whitespace, and anything else means
 * the value is not a refresh directive at all; skip whitespace and one optional separator; capture
 * the remainder; consume `url` (ASCII case-insensitively) and an optional `=` if they are there,
 * with a partial `u`/`ur` falling back to the remainder exactly as the standard does; then strip one
 * layer of matching quotes.
 *
 * Everything it can conclude is stated: a destination, a reload that offers none, or an ERROR. The
 * error is a refusal — a `content` this grammar cannot read is a navigation nobody has examined, and
 * that is not the same thing as a `content` that carries no navigation.
 */
type Refresh = { url: string | null } | { error: string };

function parseRefresh(input: string): Refresh {
  const isWs = (c: string): boolean =>
    c === '\t' || c === '\n' || c === '\f' || c === '\r' || c === ' ';
  const isDigit = (c: string): boolean => c >= '0' && c <= '9';
  let at = 0;
  const peek = (): string => input[at] ?? '';
  const lower = (): string => peek().toLowerCase();
  const skipWs = (): void => {
    while (at < input.length && isWs(peek())) {
      at += 1;
    }
  };

  skipWs();
  const digitsFrom = at;
  while (at < input.length && isDigit(peek())) {
    at += 1;
  }
  if (at === digitsFrom && peek() !== '.') {
    return {
      error: 'begins with no refresh time, which the grammar requires before anything else',
    };
  }
  while (at < input.length && (isDigit(peek()) || peek() === '.')) {
    at += 1;
  }
  if (at >= input.length) {
    return { url: null };
  }
  if (!(peek() === ';' || peek() === ',' || isWs(peek()))) {
    return { error: 'runs its refresh time straight into a character the grammar does not allow' };
  }
  skipWs();
  if (peek() === ';' || peek() === ',') {
    at += 1;
    skipWs();
  }
  if (at >= input.length) {
    return { url: null };
  }
  const remainder = input.slice(at);
  if (lower() === 'u') {
    at += 1;
    if (lower() !== 'r') {
      return { url: remainder };
    }
    at += 1;
    if (lower() !== 'l') {
      return { url: remainder };
    }
    at += 1;
    skipWs();
    if (peek() === '=') {
      at += 1;
      skipWs();
    }
  }
  const quote = peek();
  if (quote === '"' || quote === "'") {
    at += 1;
    const end = input.indexOf(quote, at);
    return { url: end === -1 ? input.slice(at) : input.slice(at, end) };
  }
  return { url: input.slice(at) };
}

/**
 * Is this element the one tag that moves a reader with no click at all?
 *
 * `http-equiv` is a space-separated token list in the attribute table rehype itself uses, so its
 * value arrives as an ARRAY; a plain string is handled too rather than assumed away. The token is
 * trimmed and matched ASCII case-insensitively, which is how the standard matches it.
 */
function isMetaRefresh(element: Element): boolean {
  if (element.tagName !== 'meta') {
    return false;
  }
  const value = element.properties?.httpEquiv;
  const tokens = Array.isArray(value) ? value : [value];
  return tokens.some(
    (token) => typeof token === 'string' && token.trim().toLowerCase() === 'refresh',
  );
}

/**
 * ONE ATTRIBUTE, MANY DESTINATIONS.
 *
 * `srcset`, `imagesrcset`, `ping` and `archive` each hold a LIST of URLs, and reading such an
 * attribute as a single destination reads only the first one — so an attribute whose first entry is
 * an approved origin carries every other entry past an allowlist that never sees them.
 *
 * NOTHING HERE GUESSES AT A CANDIDATE GRAMMAR.
 *
 *   · `srcset` and `imagesrcset` go to the `srcset` package, which implements the HTML candidate
 *     grammar. If it THROWS, the attribute is refused outright rather than read.
 *   · `ping`, and `archive` on `<object>`, are spec-defined SPACE-separated token sets, and
 *     `property-information` — the table rehype itself uses — has already split them into an array.
 *     That array is the candidate list.
 *   · `archive` on `<applet>` is COMMA-separated, and the array above is therefore the wrong split
 *     for it. Rather than guess, the attribute is REFUSED.
 *
 * Whatever any of that concludes FOR A LIST-VALUED ATTRIBUTE, every whitespace-or-comma separated
 * token in the raw value that carries a scheme or an authority is classified as well. That is not a
 * second grammar: it decides nothing about candidate boundaries and can only ADD destinations, so
 * no shape of a list attribute can leave an absolute URL sitting inside it unread. It is applied
 * ONLY to list attributes — a single-URL attribute holds one destination, and splitting it would
 * report the halves of a comma-bearing `data:` URL as destinations of their own.
 */
function readAttribute(
  tagName: string,
  attr: string,
  value: string | number | boolean | Array<string | number> | null | undefined,
  refresh = false,
): AttrReading {
  if (value === null || value === undefined || typeof value === 'boolean') {
    return { found: [], rest: [] };
  }
  const items = (Array.isArray(value) ? value : [value]).map((v) => String(v));
  const raw = items.join(' ');
  if (raw.trim() === '') {
    return { found: [], rest: [] };
  }
  if (refresh && attr === 'content') {
    // Absolute URLs come out of the raw value first and ADDITIVELY, so one sits in the reading even
    // if the grammar below reads the directive some other way. Then the directive itself is parsed,
    // and its destination — absolute or RELATIVE — is a destination like any other, resolved and
    // contained exactly as an `href` would be. A value the grammar cannot read is refused.
    const scan = scanText(raw);
    const directive = parseRefresh(raw);
    if ('error' in directive) {
      return {
        found: [...scan.found, { dest: raw, refuse: `is a meta refresh that ${directive.error}` }],
        rest: [],
      };
    }
    if (directive.url === null || directive.url.trim() === '') {
      return { found: scan.found, rest: [scan.rest] };
    }
    return { found: [...scan.found, { dest: directive.url }], rest: [] };
  }
  if (attr === 'srcdoc') {
    // A WHOLE DOCUMENT INSIDE AN ATTRIBUTE, AND NOT ONE THIS CONTRACT CAN RESOLVE AGAINST.
    //
    // `srcdoc` is a nested HTML document, and every absolute URL written anywhere in it is taken
    // additively below — which is what stops an encoded anchor in there from shipping unread. Its
    // RELATIVE destinations are a different question and an unanswerable one: they resolve against
    // the srcdoc document's own base, which is the containing page's, through a nesting this reader
    // does not model. Rather than resolve them against a base that may not be theirs, or walk past
    // them and call the attribute read, the attribute is REFUSED. Silence is the one answer that
    // would be a lie.
    const scan = scanText(raw);
    return {
      found: [
        ...scan.found,
        {
          dest: raw,
          refuse:
            'is a srcdoc, a nested document whose relative destinations this contract does not resolve',
        },
      ],
      rest: [],
    };
  }
  const isList = SRCSET_ATTRS.has(attr) || attr === 'ping' || attr === 'archive';
  const net: Found[] = !isList
    ? []
    : raw
        .split(/[\s,]+/)
        .filter((token) => token !== '' && CARRIES_AUTHORITY.test(token))
        .map((dest) => ({ dest }));

  if (attr === 'archive' && tagName === 'applet') {
    return {
      found: [
        ...net,
        { dest: raw, refuse: 'is an <applet> archive, whose comma-separated list is not parsed' },
      ],
      rest: [],
    };
  }
  if (SRCSET_ATTRS.has(attr)) {
    // TWICE, ON PURPOSE. The lenient parse is asked what candidates are in there, because even an
    // invalid value can hide a real URL and that URL still has to answer for itself. The STRICT
    // parse is asked whether the value is a valid candidate list at all, and if it is not the whole
    // attribute is refused — a value the grammar rejects is not one whose reading can be trusted.
    const urls: string[] = [];
    try {
      for (const candidate of parseSrcset(raw)) {
        urls.push(candidate.url);
      }
    } catch {
      // Nothing to add; the strict pass below is what reports the refusal.
    }
    const candidates: Found[] = urls.map((dest) => ({ dest }));
    try {
      parseSrcset(raw, { strict: true });
    } catch {
      return {
        found: [
          ...candidates,
          ...net,
          { dest: raw, refuse: `is a ${attr} the srcset grammar refuses as a candidate list` },
        ],
        rest: [],
      };
    }
    // THE VALUE PARSED, BUT DID IT PARSE ALL OF IT? A grammar that accepts a value while silently
    // dropping part of it has answered a different question than the one that was asked.
    const leftover = srcsetLeftovers(raw, urls);
    if (leftover.length > 0) {
      return {
        found: [
          ...candidates,
          ...net,
          ...leftover.map((dest) => ({ dest })),
          {
            dest: raw,
            refuse: `is a ${attr} whose candidate list leaves ${leftover.join(' ')} unread, so a destination inside it would ship unexamined`,
          },
        ],
        rest: [],
      };
    }
    return { found: [...candidates, ...net], rest: [] };
  }
  if (HTML_DESTINATION_ATTRS.has(attr)) {
    return { found: [...items.map((dest) => ({ dest })), ...net], rest: [] };
  }
  // AN UNKNOWN ATTRIBUTE IS NOT A SAFE ONE, AND A URL DOES NOT HAVE TO START AT CHARACTER ZERO.
  //
  // A value that BEGINS with a scheme or an authority is one destination and is read as one. But a
  // destination-bearing attribute the HTML spec did not exist to define — `content` on a refresh,
  // `srcdoc`, or whatever a renderer invents next — puts its URL in the MIDDLE of a value, and a
  // whole-value test that anchors at the start walks past it and reports the value as prose. So
  // every other value is additionally SCANNED, with the same reader that finds a URL written out in
  // running text, and whatever it takes out is a destination. This can only ADD: it decides nothing
  // about the shape of the attribute, and what it does not take stays text.
  const rest: string[] = [];
  const found: Found[] = [];
  for (const item of items) {
    if (CARRIES_AUTHORITY.test(item)) {
      found.push({ dest: item });
      continue;
    }
    const scan = scanText(item);
    found.push(...scan.found);
    rest.push(scan.rest);
  }
  return { found, rest };
}

/**
 * EVERY DESTINATION THE RENDERED PAGE OFFERS, and everything else it puts in front of a reader.
 *
 * The walk is over the HAST, so a link is a link because the renderer made one — inline, reference,
 * autolink, GFM autolink literal, image, or raw HTML — and not because a pattern recognised its
 * spelling. Text and comment nodes are additionally scanned for URLs written out rather than
 * linked, which is how a `curl https://…` line inside a fenced block still answers for itself.
 *
 * THREE THINGS COME OFF THE MDAST AS WELL, and they only ever ADD:
 *
 *   · reference DEFINITIONS, because an unreferenced one renders to nothing and would otherwise
 *     ship unread — their labels and titles are kept as text for the same reason;
 *   · the URL a `link` or an `image` was WRITTEN with. Rendering percent-encodes a destination
 *     (`http://[::1]/x` becomes `http://%5B::1%5D/x`, which `URL` will not parse at all), so the
 *     rendered form alone cannot say which origin an IPv6 literal names. Reading both means a
 *     destination answers under the spelling a reader follows AND the spelling the author wrote.
 */
function surfaceOf(text: string): Surface {
  const { mdast, hast } = treesOf(text);
  const found: Found[] = [];
  const rest: string[] = [];
  visit(mdast, 'definition', (node) => {
    found.push({ dest: node.url });
    rest.push(node.label ?? node.identifier);
    if (typeof node.title === 'string') {
      rest.push(node.title);
    }
  });
  visit(mdast, (node) => {
    if (node.type === 'link' || node.type === 'image') {
      found.push({ dest: node.url });
    }
  });
  visit(hast, (node) => {
    if (node.type === 'element') {
      const element = node as Element;
      const refresh = isMetaRefresh(element);
      for (const [property, value] of Object.entries(element.properties ?? {})) {
        const attr = find(html, property).attribute.toLowerCase();
        const reading = readAttribute(element.tagName, attr, value, refresh);
        found.push(...reading.found);
        rest.push(...reading.rest);
      }
      return;
    }
    if (node.type === 'text' || node.type === 'comment') {
      const scan = scanText((node as HastText | Comment).value);
      found.push(...scan.found);
      rest.push(scan.rest);
    }
  });
  return { found, text: rest };
}

// ---------------------------------------------------------------------------------------------
// Anchors.
// ---------------------------------------------------------------------------------------------

/**
 * Every anchor a page defines, read off the RENDERED tree.
 *
 *   · a heading anchor is whatever `rehype-slug` put on the heading, which is `github-slugger` —
 *     the slugger GitHub's own anchors are modelled on — including its duplicate suffixes and its
 *     handling of character references, inline markup and multi-line setext headings. No slug is
 *     computed here;
 *   · an `id` counts on ANY element, because that is what a browser resolves a fragment against;
 *   · a `name` counts ONLY on `<a>`, which is the one element the HTML spec ever gave a named
 *     anchor. `name` on a `<span>` is an attribute, not an anchor, and does not create one;
 *   · an HTML COMMENT is not an element, so an `id=` written inside one creates nothing. The
 *     rendered tree carries comments as comment nodes, so this falls out rather than being coded.
 *
 * Fragments are compared EXACTLY, never case-folded: a browser does not fold them either.
 */
const anchorCache = new Map<string, ReadonlySet<string>>();

export function anchorsOf(text: string): ReadonlySet<string> {
  const cached = anchorCache.get(text);
  if (cached !== undefined) {
    return cached;
  }
  const anchors = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value === 'string' && value.trim() !== '') {
      anchors.add(value.trim());
    }
  };
  visit(treesOf(text).hast, 'element', (element: Element) => {
    add(element.properties?.id);
    if (element.tagName === 'a') {
      add(element.properties?.name);
    }
  });
  anchorCache.set(text, anchors);
  return anchors;
}

// ---------------------------------------------------------------------------------------------
// What a destination resolves to. Unchanged in substance: WHATWG `URL` decides the outer scheme
// and the origin, and `realpath` decides containment.
// ---------------------------------------------------------------------------------------------

export type Verdict =
  | { kind: 'local'; dest: string }
  | { kind: 'external'; dest: string; key: string }
  | { kind: 'rejected'; dest: string; why: string };

/**
 * The only schemes a published page may send a reader to over the network.
 *
 * THE OUTER SCHEME IS DECIDED FIRST, BEFORE ANY ORIGIN REDUCTION. `URL` derives the origin of a
 * `blob:` or `filesystem:` URL from the URL NESTED INSIDE IT, so `blob:https://allowed.example/id`
 * reduces to `https://allowed.example` — the allowlist would recognise the inner origin and wave
 * through an outer scheme nobody approved. Reducing first and judging after therefore answers a
 * question about the wrong URL. Every other scheme is refused for the same structural reason: what
 * `data:`, `javascript:`, `ws:`, `wss:`, `ftp:`, `mailto:` and `file:` do with a reader is not a
 * navigation to an origin at all, so an origin allowlist is not the instrument that governs them.
 */
const ALLOWED_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:']);

/** Scheme, hostname and port, with a default port omitted — `URL`'s own normalization. */
const originKey = (url: URL): string => url.origin;

/** `target` is `root` itself or sits underneath it. Both must already be canonical. */
const contains = (root: string, target: string): boolean =>
  target === root || target.startsWith(`${root}${path.sep}`);

/** Does `fragment` name an anchor `anchors` really defines? */
function fragmentVerdict(
  dest: string,
  fragment: string | null,
  anchors: ReadonlySet<string>,
  where: string,
): Verdict {
  if (fragment === null || fragment === '') {
    return { kind: 'local', dest };
  }
  let name: string;
  try {
    name = decodeURIComponent(fragment);
  } catch {
    return { kind: 'rejected', dest, why: 'carries a fragment that is not decodable' };
  }
  if (!anchors.has(name)) {
    return { kind: 'rejected', dest, why: `names #${name}, which ${where} does not define` };
  }
  return { kind: 'local', dest };
}

/** The page a destination is written on: which tree it lives in, where in it, and its bytes. */
type Site = { root: string; fromRel: string; text: string };

/**
 * The path part of a local destination, under BOTH readings of the decode/strip order.
 *
 * This contract strips the fragment and the query FIRST and percent-decodes what is left, because
 * decoding first would let `%23` — an ENCODED `#`, a literal character in the path — masquerade as
 * the fragment delimiter and truncate the path. A reader's tooling may nonetheless take the other
 * order, so both are computed and BOTH have to survive whatever is asked of them: the union is the
 * fail-closed reading, since a page cannot pick the order that suits it.
 */
/**
 * THE PATH COMPONENT OF A DESTINATION: everything before the fragment and before the query.
 *
 * The fragment is cut first and the query second, because a `?` after a `#` is fragment text rather
 * than a query delimiter — `a.md#x?y` has no query at all.
 */
const pathComponent = (dest: string): string => (dest.split('#')[0] ?? '').split('?')[0] ?? '';

function localPathReadings(dest: string): string[] {
  const strip = pathComponent;
  const decode = (value: string): string | null => {
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  };
  const decodedWhole = decode(dest);
  return [
    ...new Set(
      [decode(strip(dest)), decodedWhole === null ? null : strip(decodedWhole)].filter(
        (value): value is string => value !== null && value !== '',
      ),
    ),
  ];
}

/**
 * A relative destination, resolved from the directory of the page that writes it.
 *
 * CONTAINMENT IS CANONICAL. A lexical check answers where the STRING points, not where the reader
 * lands: `docs/out.md` can be a symlink to a file outside the tree entirely, and `path.resolve`
 * plus a `statSync` that follows links calls it a contained regular file. So the target is resolved
 * with `realpath` — which collapses every symlink in the chain, not merely a final one — and the
 * REAL path is what has to sit inside the real repository root.
 */
/**
 * A BACKSLASH IS NOT A CHARACTER IN A DESTINATION, IT IS A DISAGREEMENT.
 *
 * `new URL('\\outside.xyz', 'https://host/docs/x.md')` is `https://outside.xyz/` — WHATWG resolution
 * against a SPECIAL scheme treats a backslash as a path separator, and a leading `\\` therefore
 * reads as the `//` that starts an AUTHORITY. A reader who clicks such a link on a published page
 * leaves for another host. The filesystem this contract resolves against says something else
 * entirely: on POSIX `\\outside.xyz` is one perfectly ordinary filename, so a repository that
 * happens to hold a file by that name makes the destination look CONTAINED and it ships as a local
 * link. Windows disagrees with both, treating the backslash as its own separator, which is how
 * `..%5C..%5C` climbs out of a tree that `path.resolve` on POSIX keeps it inside.
 *
 * Three readings, no majority. So a local destination carrying a backslash — literally, or through
 * any percent-decoding of its path — is REFUSED rather than resolved under whichever reading the
 * host platform happens to supply.
 *
 * THE PATH IS WHERE THAT DISAGREEMENT LIVES, AND ONLY THE PATH. Every reading above is a reading of
 * a PATH: WHATWG turns a backslash into a path separator while parsing the path, `path.resolve`
 * disagrees about the same segment, and Windows disagrees again. Past the `?` none of that is true —
 * a backslash in a query string is opaque data that no resolver treats as a separator, and
 * `a.md?q=\part` names the same file `a.md` under all three readings. Judging the WHOLE destination
 * therefore refuses a link that is not in dispute at all, so the literal check and the decoded
 * checks are both applied to the path component alone.
 */
const carriesBackslash = (dest: string): boolean =>
  pathComponent(dest).includes('\\') ||
  localPathReadings(dest).some((reading) => reading.includes('\\'));

function classifyLocal(dest: string, site: Site): Verdict {
  if (carriesBackslash(dest)) {
    return {
      kind: 'rejected',
      dest,
      why: 'carries a backslash, which a browser resolving against an https base reads as a path separator',
    };
  }
  const hash = dest.indexOf('#');
  const fragment = hash === -1 ? null : dest.slice(hash + 1);
  const beforeHash = hash === -1 ? dest : dest.slice(0, hash);
  const query = beforeHash.indexOf('?');
  const rawPath = query === -1 ? beforeHash : beforeHash.slice(0, query);

  if (rawPath === '') {
    return fragmentVerdict(dest, fragment, anchorsOf(site.text), 'this page');
  }
  let unescaped: string;
  try {
    unescaped = decodeURIComponent(rawPath);
  } catch {
    return { kind: 'rejected', dest, why: 'is not a decodable path' };
  }
  const realRoot = fs.realpathSync(site.root);
  const base = path.dirname(path.resolve(realRoot, site.fromRel));
  const target = path.resolve(base, unescaped);
  if (!contains(realRoot, target)) {
    return { kind: 'rejected', dest, why: 'resolves outside the repository' };
  }
  let real: string;
  try {
    real = fs.realpathSync(target);
  } catch {
    return { kind: 'rejected', dest, why: 'names nothing in the repository' };
  }
  if (!contains(realRoot, real)) {
    return { kind: 'rejected', dest, why: 'escapes the repository through a symlink' };
  }
  if (!fs.lstatSync(real).isFile()) {
    return { kind: 'rejected', dest, why: 'resolves to a directory, not a file' };
  }
  if (fragment === null || fragment === '') {
    return { kind: 'local', dest };
  }
  if (!MARKDOWN_EXT.test(real)) {
    return {
      kind: 'rejected',
      dest,
      why: 'carries a fragment into a file whose anchors cannot be enumerated',
    };
  }
  const rel = path.relative(realRoot, real).split(path.sep).join('/');
  return fragmentVerdict(dest, fragment, anchorsOf(fs.readFileSync(real, 'utf8')), rel);
}

function classify(span: Found, site: Site): Verdict {
  const dest = span.dest.trim();
  if (span.refuse !== undefined) {
    return { kind: 'rejected', dest, why: span.refuse };
  }
  // A protocol-relative destination inherits the page's scheme; published prose is served over
  // https, so that is the scheme it resolves under.
  const absolute = dest.startsWith('//') ? `https:${dest}` : dest;
  let url: URL;
  try {
    url = new URL(absolute);
  } catch {
    return classifyLocal(dest, site);
  }
  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    return {
      kind: 'rejected',
      dest,
      why: `carries the scheme ${url.protocol}, which is not one a published page may offer`,
    };
  }
  if (url.username !== '' || url.password !== '') {
    return {
      kind: 'rejected',
      dest,
      why: 'carries userinfo, so the host it reads as is not the host it resolves to',
    };
  }
  return { kind: 'external', dest, key: originKey(url) };
}

export type Reading = {
  origins: string[];
  rejected: string[];
  local: string[];
  mentions: string[];
};

/**
 * Every destination the text offers and every dotted token it names outside those destinations.
 * `fromRel` is the repository-relative path of the page the text belongs to, because that is what a
 * relative destination resolves against.
 */
export function readSurface(text: string, fromRel: string, root: string = defaultRoot): Reading {
  const site: Site = { root, fromRel, text };
  const { found, text: rest } = surfaceOf(text);
  const verdicts = [
    ...new Map(found.map((s) => [`${s.dest}\u0000${s.refuse ?? ''}`, classify(s, site)])).values(),
  ];
  DOTTED.lastIndex = 0;
  return {
    origins: [...new Set(verdicts.flatMap((v) => (v.kind === 'external' ? [v.key] : [])))].sort(),
    rejected: verdicts
      .flatMap((v) => (v.kind === 'rejected' ? [`${v.dest} — ${v.why}`] : []))
      .sort(),
    local: [...new Set(verdicts.flatMap((v) => (v.kind === 'local' ? [v.dest] : [])))].sort(),
    mentions: [
      ...new Set([...rest.join('\n').matchAll(DOTTED)].map((m) => m[0].toLowerCase())),
    ].sort(),
  };
}

/**
 * CLOSURE. Every Markdown page a text links, canonical and repository-relative.
 *
 * The check this feeds is what stops a page from walking a reader off the contracted surface one
 * link at a time, so the question it asks is where the reader LANDS, not what the destination
 * looked like. In order: strip the query and the fragment, percent-decode (under both orders, see
 * `localPathReadings`), resolve against the linking page's own directory, canonicalize with
 * `realpath` so `a/../b` and a symlink both settle, recognise a Markdown extension WITHOUT regard to
 * case, and only then ask the manifest.
 */
export function linkedMarkdown(
  text: string,
  fromRel: string,
  root: string = defaultRoot,
): string[] {
  const realRoot = fs.realpathSync(root);
  const base = path.dirname(path.resolve(realRoot, fromRel));
  const found = new Set<string>();
  for (const dest of readSurface(text, fromRel, root).local) {
    for (const candidate of localPathReadings(dest)) {
      const target = path.resolve(base, candidate);
      const real = fs.existsSync(target) ? fs.realpathSync(target) : target;
      if (!contains(realRoot, real) || !MARKDOWN_EXT.test(real)) {
        continue;
      }
      found.add(path.relative(realRoot, real).split(path.sep).join('/'));
    }
  }
  return [...found].sort();
}

// ---------------------------------------------------------------------------------------------
// What npm really packs.
// ---------------------------------------------------------------------------------------------

/**
 * Take a throwaway tree apart entry by entry. NOT a recursive removal call: a symlinked directory
 * is UNLINKED rather than descended, so a link that points outside the tree cannot turn the removal
 * into a reach outside the tree it was handed.
 */
export function removeTree(abs: string): void {
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const child = path.join(abs, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      removeTree(child);
    } else {
      fs.unlinkSync(child);
    }
  }
  fs.rmdirSync(abs);
}

/** Markdown that ships inside the npm tarball, and every package npm could not answer for. */
export type Packed = { found: string[]; unsupported: string[] };

/**
 * The two directories the pack fixture never copies. Neither is ever packed by npm — EXCEPT under
 * `bundleDependencies`, which is why `bundlingObjection` refuses that configuration outright rather
 * than letting this filter quietly change the answer.
 */
const NEVER_COPIED: ReadonlySet<string> = new Set(['node_modules', '.git']);

/**
 * npm's OWN CLI, PAIRED WITH THIS PROCESS'S OWN NODE — never whatever `npm` happens to be on `PATH`.
 *
 * A `PATH` lookup is not a resolution, it is a question asked of the environment, and the
 * environment is exactly what an attacker on a build machine controls. So `PATH` is never consulted.
 * Only three layouts are trusted, and each of them is derived from `process.execPath` — the
 * interpreter that is already running this test — so the npm that answers is the npm that ships
 * beside this node:
 *
 *   · the OFFICIAL Unix layout, `<prefix>/bin/node` beside `<prefix>/lib/node_modules/npm/bin/…`,
 *     which is what the nodejs.org tarballs, nvm and the Docker images all lay down;
 *   · the ADJACENT layout, `<dir>/node.exe` beside `<dir>/node_modules/npm/bin/…`, which is what
 *     `actions/setup-node` lays down on Windows — npm is a SIBLING of node there, not an uncle, so
 *     the Unix candidate is not merely absent but structurally wrong;
 *   · the HOMEBREW layout, and ONLY in its canonical shape. `process.execPath` is inside the
 *     Cellar — `<prefix>/Cellar/node/<version>/bin/node` — whose own `lib/` holds nothing but
 *     `libnode.dylib`, so neither candidate above exists; the only pointer to npm is the `npm`
 *     symlink sitting beside the binary, and it points OUT of the Cellar into the prefix's shared
 *     `lib/node_modules`. That link is followed only when it canonicalizes to EXACTLY
 *     `<prefix>/lib/node_modules/npm/bin/npm-cli.js` for the SAME `<prefix>` the running node was
 *     derived from. Not a path that ends in those segments — the same path.
 *
 * WHAT THAT DOES AND DOES NOT BUY, STATED HONESTLY. A SUFFIX test — "does the realpath end in
 * `npm/bin/npm-cli.js`" — is not a trust decision at all: any writable directory anywhere on the
 * machine can be given those three segments, so a planted `npm` link could nominate an arbitrary
 * script and be followed. Pinning the whole path to the running node's own prefix is what makes the
 * link unable to name anything outside the installation the interpreter already came from. The
 * boundary is therefore the INSTALLATION, not the file: anyone who can write inside
 * `<prefix>/lib/node_modules/npm` already owns the node that is executing this test, and no check
 * here can recover from that. Nothing about the LINK is trusted — only where it is allowed to land.
 *
 * Returning `null` is a REFUSAL, not a fallback: the caller reports the package as unmodelled.
 */
/**
 * The Homebrew PREFIX that owns a `bin` directory, or `null` when this is not Homebrew's shape.
 *
 * Homebrew installs a formula into a versioned keg — `<prefix>/Cellar/node/<version>` — and the
 * binary a reader ever runs lives in that keg's `bin`. The prefix is the directory the `Cellar`
 * itself sits in, and it is the only thing this returns: a `bin` that is not `Cellar/node/<version>`
 * deep gets `null`, and no other layout is guessed at.
 */
function homebrewPrefix(binDir: string): string | null {
  if (path.basename(binDir) !== 'bin') {
    return null;
  }
  const keg = path.dirname(binDir);
  const formula = path.dirname(keg);
  const cellar = path.dirname(formula);
  const version = path.basename(keg);
  if (version === '' || version === '.' || version === '..') {
    return null;
  }
  if (path.basename(formula) !== 'node' || path.basename(cellar) !== 'Cellar') {
    return null;
  }
  return path.dirname(cellar);
}

export function resolveNpmCli(execPath: string): string | null {
  const dir = path.dirname(execPath);
  const isFile = (candidate: string): boolean => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  };
  for (const candidate of [
    path.resolve(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]) {
    if (isFile(candidate)) {
      return candidate;
    }
  }
  const prefix = homebrewPrefix(dir);
  if (prefix === null) {
    return null;
  }
  const link = path.join(dir, 'npm');
  try {
    if (!fs.lstatSync(link).isSymbolicLink()) {
      return null;
    }
  } catch {
    return null;
  }
  let real: string;
  let permitted: string;
  try {
    real = fs.realpathSync(link);
    permitted = fs.realpathSync(
      path.join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    );
  } catch {
    return null;
  }
  if (real !== permitted) {
    return null;
  }
  return isFile(real) ? real : null;
}

/**
 * WHAT NPM PACKS, ASKED OF NPM.
 *
 * The `files` field is not a glob language anyone should re-implement. A doubled star matches ZERO
 * segments, so `docs`, that star and `x.md` joined by slashes matches plain `docs/x.md`; a LEADING
 * doubled star matches at the root, so that pattern joined to `*.md` matches a root-level
 * `guide.md`; `main`, `browser` and `bin` drag their targets in whatever `files` says, but
 * only when they are written without a `./` prefix; `!` negates; a brace set expands; `README`,
 * `LICENSE` and friends are always included. A model of that is a model, and every gap in it
 * discovers nothing and ships the pages it missed unread. So npm is asked instead, and its JSON
 * `files[]` is the answer.
 *
 * ISOLATION. The package is COPIED into a fresh temp fixture (never `node_modules`, never `.git`)
 * and npm runs there with its own `HOME`, its own cache, `--ignore-scripts`, and `offline` set, so
 * nothing it does can touch the repository, the developer's npm config, or the network. `--dry-run`
 * writes no tarball.
 *
 * LIFECYCLE, HONESTLY. `--ignore-scripts` means `prepack` DOES NOT RUN. A file a `prepack` script
 * copies into the package — this repository's `packages/cli/README.md` is exactly that — is
 * therefore NOT in this answer, and this contract does not pretend otherwise. What is pinned here
 * is the GLOB AND ALLOWLIST semantics of a static tree; the bytes of the finished archive are a
 * different question, pinned by the packaged-artifact gate.
 */
/**
 * THE CHILD'S WHOLE ENVIRONMENT, WRITTEN OUT RATHER THAN INHERITED.
 *
 * `HOME` alone is a POSIX answer to a cross-platform question. On Windows npm reads `USERPROFILE`
 * for the user's config and `TEMP`/`TMP` for its scratch space, so a run that sets only `HOME` and
 * `TMPDIR` there falls back to the DEVELOPER'S profile and the machine's temp directory — the two
 * places this fixture exists to stay out of. All five are therefore pointed inside the fixture.
 *
 * Nothing else is inherited. Only the handful of variables a child process genuinely cannot run
 * without on Windows are carried through, and each of them is a machine-shape constant rather than
 * a secret: `SystemRoot` and `windir` (which the CRT and winsock resolve DLLs against), `ComSpec`
 * and `PATHEXT`. A token, a registry credential or an `npm_config_*` override in the ambient
 * environment reaches the child through none of this.
 */
export function packChildEnv(
  home: string,
  cache: string,
  ambient: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: path.dirname(process.execPath),
    HOME: home,
    USERPROFILE: home,
    TEMP: cache,
    TMP: cache,
    TMPDIR: cache,
    npm_config_cache: cache,
    npm_config_offline: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    // Two DISTINCT empty files: npm refuses to load one path as both user and global config.
    npm_config_userconfig: path.join(home, 'npmrc-user'),
    npm_config_globalconfig: path.join(home, 'npmrc-global'),
    npm_config_ignore_scripts: 'true',
  };
  for (const name of ['SystemRoot', 'windir', 'ComSpec', 'PATHEXT']) {
    const value = ambient[name];
    if (typeof value === 'string' && value !== '') {
      env[name] = value;
    }
  }
  return env;
}

function packFiles(pkgDir: string): { files: string[] } | { error: string } {
  const cli = resolveNpmCli(process.execPath);
  if (cli === null) {
    return {
      error: 'npm is not installed beside this node, so its packed set cannot be asked for',
    };
  }
  const fixture = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sthayi-pack-'));
  try {
    const pkg = path.join(fixture, 'pkg');
    const home = path.join(fixture, 'home');
    const cache = path.join(fixture, 'cache');
    fs.mkdirSync(home);
    fs.mkdirSync(cache);
    fs.cpSync(pkgDir, pkg, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      filter: (src) => !NEVER_COPIED.has(path.basename(src)),
    });
    const stdout = execFileSync(
      process.execPath,
      [cli, 'pack', '--dry-run', '--ignore-scripts', '--json'],
      {
        cwd: pkg,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000,
        env: packChildEnv(home, cache),
      },
    );
    const parsed: unknown = JSON.parse(stdout);
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    const files = (first as { files?: unknown } | undefined)?.files;
    if (!Array.isArray(files)) {
      return { error: 'npm pack --json produced no files array' };
    }
    return {
      files: files.map((entry) => String((entry as { path?: unknown }).path ?? '')),
    };
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const detail = typeof stderr === 'string' && stderr.trim() !== '' ? stderr : String(error);
    return { error: detail.split('\n').slice(0, 3).join(' / ').slice(0, 300) };
  } finally {
    removeTree(fixture);
  }
}

/**
 * THE FIRST SYMLINK ANYWHERE IN A PACKAGE IS A REFUSAL, NOT A DETOUR.
 *
 * `statSync` FOLLOWS a link, so a `packages/p` pointing at a directory outside the repository
 * answers `isDirectory()` with a cheerful yes and every page under it is then reported as this
 * repository's packed content — a surface contract satisfied by files the repository does not own.
 * `lstat` is the question that was meant: what is THIS entry.
 *
 * The same is true one level down. The manifest decides what npm packs, and a `package.json`
 * symlinked out of the tree hands that decision to whatever it points at; a symlinked file inside
 * the tree is copied VERBATIM into the pack fixture, so what npm reads there is not what the
 * repository holds either. None of this is worth a clever rule about which links are harmless: the
 * repository has no symlinks under `packages/` at all, so any of them is a change that has to be
 * made on purpose, and until it is the package is reported as UNMODELLED rather than read.
 *
 * Returns the reason this package cannot be answered for, or `null` when it can.
 */
function packageObjection(dir: string, realRoot: string): string | null {
  let real: string;
  try {
    real = fs.realpathSync(dir);
  } catch {
    return 'cannot be resolved to a real path';
  }
  if (!contains(realRoot, real)) {
    return 'resolves outside the repository';
  }
  const walk = (abs: string, rel: string): string | null => {
    for (const entry of fs
      .readdirSync(abs, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (NEVER_COPIED.has(entry.name)) {
        continue;
      }
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        return `holds the symlink ${child}, whose target is not this repository's content`;
      }
      if (entry.isDirectory()) {
        const objection = walk(path.join(abs, entry.name), child);
        if (objection !== null) {
          return objection;
        }
      }
    }
    return null;
  };
  return walk(dir, '');
}

/**
 * BUNDLING PUTS `node_modules` IN THE TARBALL, AND THIS READER HAS ALREADY THROWN IT AWAY.
 *
 * `packFiles` copies the package into a fixture with `node_modules` and `.git` filtered out, and
 * that copy is faithful for every ordinary package because npm packs neither.
 * `bundleDependencies` is the one configuration that makes it false: npm then packs
 * `node_modules/<dep>` WHOLE — its README included — so a bundled page really does reach a reader,
 * while the question npm was asked here was asked of a tree that no longer held it. The answer that
 * comes back is not merely wrong, it is EMPTY: nothing in `found`, nothing in `unsupported`, and a
 * page ships with no contract and no complaint. A silent blind spot is the one failure a surface
 * contract cannot survive.
 *
 * Rather than start copying `node_modules` — and with it whatever a workspace link inside one points
 * at — the configuration is REFUSED, before anything is copied at all. `false` and an empty list
 * bundle nothing and stay supported; every other value, including `true`, a non-empty list, and any
 * shape npm does not document, is reported as unmodelled. `bundleDependencies` and
 * `bundledDependencies` are one field under two spellings, and both are read.
 */
const BUNDLE_FIELDS = ['bundleDependencies', 'bundledDependencies'] as const;

function bundlingObjection(manifest: unknown): string | null {
  if (typeof manifest !== 'object' || manifest === null) {
    return null;
  }
  const fields = manifest as Record<string, unknown>;
  for (const field of BUNDLE_FIELDS) {
    if (!(field in fields)) {
      continue;
    }
    const value = fields[field];
    if (value === false || value === null || value === undefined) {
      continue;
    }
    if (Array.isArray(value) && value.length === 0) {
      continue;
    }
    return `configures ${field}, so npm packs a node_modules tree this reader strips before it asks`;
  }
  return null;
}

/** Every Markdown file npm puts in the tarball of every publishable package under `packages/`. */
export function packedMarkdown(root: string): Packed {
  const packagesDir = path.join(root, 'packages');
  if (!fs.existsSync(packagesDir)) {
    return { found: [], unsupported: [] };
  }
  const realRoot = fs.realpathSync(root);
  const found: string[] = [];
  const unsupported: string[] = [];
  for (const entry of fs
    .readdirSync(packagesDir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const pkg = entry.name;
    const dir = path.join(packagesDir, pkg);
    const manifest = path.join(dir, 'package.json');
    if (entry.isSymbolicLink()) {
      unsupported.push(
        `packages/${pkg} could not be packed by npm: is a symlink, so what it names is not this repository's package`,
      );
      continue;
    }
    if (!entry.isDirectory()) {
      continue;
    }
    // WHAT THE ENTRY IS, SETTLED BEFORE ANYTHING THE MANIFEST SAYS.
    //
    // The manifest is not evidence about itself. `packages/p/package.json` can be a symlink to a
    // file outside the repository entirely, and every field in it — `private` above all — is then
    // a claim made by whatever the link points at. A reader that skips a package because the thing
    // at the end of that link says `"private": true` has been talked out of looking by the very
    // file it was supposed to be suspicious of, and the package is neither modelled nor reported.
    // `existsSync` is no safer: it FOLLOWS the link, so even asking whether a manifest is there is
    // a question answered outside the tree. So the entry's own shape is settled first — lstat for
    // symlinks anywhere beneath it, realpath for containment — and only a package that survives
    // that has a manifest worth opening.
    const objection = packageObjection(dir, realRoot);
    if (objection !== null) {
      unsupported.push(`packages/${pkg} could not be packed by npm: ${objection}`);
      continue;
    }
    if (!fs.existsSync(manifest)) {
      continue;
    }
    const parsed: unknown = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if ((parsed as { private?: unknown }).private === true) {
      continue;
    }
    const bundling = bundlingObjection(parsed);
    if (bundling !== null) {
      unsupported.push(`packages/${pkg} could not be packed by npm: ${bundling}`);
      continue;
    }
    const answer = packFiles(dir);
    if ('error' in answer) {
      unsupported.push(`packages/${pkg} could not be packed by npm: ${answer.error}`);
      continue;
    }
    for (const rel of answer.files) {
      if (MARKDOWN_EXT.test(rel)) {
        found.push(`packages/${pkg}/${rel}`);
      }
    }
  }
  return { found: [...new Set(found)].sort(), unsupported };
}
