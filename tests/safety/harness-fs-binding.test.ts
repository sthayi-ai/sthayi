import fs from 'node:fs';
import * as fsNamespace from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { removeOwned } from '../helpers/owned-fs.js';
import { runTempDir } from '../helpers/run-temp.js';

/**
 * SAFETY: every directory this suite creates must reach the recorder, or the evidence rots.
 *
 * The test harness records each directory it creates by wrapping `node:fs`'s creating entry points
 * (tests/helpers/owned-fs.ts). Cleanup then descends only into directories that carry a record — an
 * unrecorded, nonempty directory is refused and leaked rather than walked.
 *
 * A WRAPPER ONLY EXISTS ON THE BINDING IT PATCHED, AND ONLY FOR THE CALLS IT KNOWS. `import fs from
 * 'node:fs'` and `import * as fs from 'node:fs'` are NOT the same object under this ESM setup;
 * `fs.promises.mkdir` and `mkdir()` from `node:fs/promises` are different functions again; and a
 * destructured `import { mkdirSync }` captures the original before anything wraps it. Each of those
 * creates directories the recorder never sees.
 *
 * WHY THAT IS A DEFECT AND NOT A TIDINESS PREFERENCE. The consequence is silent: the suite stays
 * green and the fixtures simply stop being cleaned up. But the second consequence is worse, and it
 * is the reason this file exists. Nearly every hostile test in this repo asserts that a foreign tree
 * SURVIVED a teardown — and an unrecorded parent is refused whether or not the identity check works.
 * A creation the recorder cannot see therefore converts those assertions into vacuous ones: they
 * pass because nothing was recorded, not because ownership was proved. Weak recording is how a
 * hostile suite quietly stops testing anything, so "it only leaks" is not a defence available here.
 * The stated invariant is EXACT OWNERSHIP, in both directions.
 *
 * So the rule is enforced from both ends. Every creating and removing entry point the recorder
 * SUPPORTS is asserted to be genuinely wrapped, and every route to `fs` that would BYPASS those
 * wrappers is refused across `tests/` and `packages/` — visibly, by name and line, rather than left
 * to be discovered as a leak. The register at the end does the same for recursive removal: a
 * pathname handed to a recursive primitive decides its whole walk inside the call, so the files
 * allowed to do it are named one at a time with the reason each is a deliberate exception.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const selfRelative = path.relative(repoRoot, fileURLToPath(import.meta.url));

/** Every tracked source file the rules below apply to. Enumerated once; several rules walk it. */
let sourceFilesCache: string[] | undefined;

function sourceFiles(): string[] {
  if (sourceFilesCache !== undefined) {
    return sourceFilesCache;
  }
  const found: string[] = [];
  const walk = (relative: string): void => {
    for (const entry of fs.readdirSync(path.join(repoRoot, relative), { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') {
        continue;
      }
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        walk(child);
      } else if (entry.isFile() && /\.(?:ts|mts|mjs)$/.test(entry.name)) {
        found.push(child);
      }
    }
  };
  walk('tests');
  walk('packages');
  sourceFilesCache = found.sort();
  return sourceFilesCache;
}

/** Executable lines only: prose describing a hazard is not the hazard. */
function codeLines(rel: string): { line: string; at: string }[] {
  const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
  return text
    .split('\n')
    .map((line, i) => ({ line: line.trim(), at: `${rel}:${i + 1}` }))
    .filter(
      ({ line }) => !(line.startsWith('*') || line.startsWith('//') || line.startsWith('/*')),
    );
}

/** Every `at` in the tree whose code line matches, excluding files that are allowed to. */
function offenders(pattern: RegExp, allowed: ReadonlySet<string>): string[] {
  const hits: string[] = [];
  for (const rel of sourceFiles()) {
    if (allowed.has(rel)) {
      continue;
    }
    for (const { line, at } of codeLines(rel)) {
      if (pattern.test(line)) {
        hits.push(`${at}: ${line}`);
      }
    }
  }
  return hits.sort();
}

describe('the harness fs binding', () => {
  it('is a different object under a namespace import — the reason the rules below exist', () => {
    // If this ever becomes true, the rule is obsolete and this file should say so rather than
    // keep enforcing a restriction that no longer buys anything.
    expect(fs.mkdirSync === fsNamespace.mkdirSync).toBe(false);
  });

  it('WRAPS every entry point the recorder claims to support', () => {
    // The negative rules below are only worth anything if the positive side actually holds. An
    // entry point that is documented as supported but never patched is the same silent gap as an
    // import form that bypasses the patch, and nothing else in the suite would ever report it.
    // The first six create or destroy DIRECTORIES and are what the creation ledger is written
    // from. The rest create or destroy ENTRIES inside one: they record no identity of their own,
    // but each is the evidence that this run WROTE inside the directory the entry landed in, which
    // is the only thing that ever permits that directory to be emptied. An unwrapped one there is
    // the same silent gap as an unwrapped `mkdir`, in the opposite direction — a home full of a
    // store and a key would be refused and leaked instead of cleaned up.
    const supported = [
      'mkdirSync',
      'mkdtempSync',
      'cpSync',
      'renameSync',
      'rmSync',
      'rmdirSync',
      'writeFileSync',
      'appendFileSync',
      'copyFileSync',
      'symlinkSync',
      'linkSync',
      'openSync',
      'unlinkSync',
    ];
    const unwrapped = supported.filter(
      (name) =>
        (fs as unknown as Record<string, unknown>)[name] ===
        (fsNamespace as unknown as Record<string, unknown>)[name],
    );
    expect(unwrapped).toEqual([]);
  });

  it('records directories created through the default import, so cleanup can descend', () => {
    const dir = runTempDir('sthayi-fsbinding-');
    fs.mkdirSync(path.join(dir, 'x', 'y', 'z'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'x', 'y', 'z', 'own.txt'), 'mine', { mode: 0o600 });
    removeOwned(dir);
    // A no-op cleanup would leave this standing: the recorder has to have witnessed every level.
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('is never reached through a NAMESPACE import anywhere in tests or packages', () => {
    const namespaceImport = /import\s+\*\s+as\s+\w+\s+from\s+['"](?:node:)?fs(?:\/promises)?['"]/;
    expect(offenders(namespaceImport, new Set([selfRelative]))).toEqual([]);
  });

  it('is never reached through a DESTRUCTURED import of a creating or removing call', () => {
    // `import { mkdirSync } from 'node:fs'` binds the original at module evaluation, before any
    // wrapper is installed — the call then creates directories nothing writes down.
    const wrapped = 'mkdirSync|mkdtempSync|cpSync|renameSync|rmSync|rmdirSync';
    const destructured = new RegExp(
      `import\\s*\\{[^}]*\\b(?:${wrapped})\\b[^}]*\\}\\s*from\\s*['"](?:node:)?fs['"]`,
    );
    expect(offenders(destructured, new Set([selfRelative]))).toEqual([]);
  });

  it('is never reached through fs/promises, which no wrapper here covers', () => {
    // `node:fs/promises` is a separate module object and `fs.promises` a separate function table.
    // Neither is patched, so a directory made through either is invisible to cleanup. There is no
    // partial-credit answer available: the recorder supports the synchronous surface, and anything
    // else has to be refused rather than half-covered.
    const promisesRoute = /from\s*['"](?:node:)?fs\/promises['"]|\bfs\s*\.\s*promises\b/;
    expect(offenders(promisesRoute, new Set([selfRelative]))).toEqual([]);
  });

  it('is never reached through the ASYNC or callback form of a creating or removing call', () => {
    const asyncForm =
      /\bfs\s*\.\s*(?:mkdir|mkdtemp|cp|rename|rm|rmdir|opendir)\s*\(|\bfs\s*\.\s*(?:mkdir|mkdtemp|cp|rename|rm|rmdir)\s*\.\s*__promisify__/;
    expect(offenders(asyncForm, new Set([selfRelative]))).toEqual([]);
  });

  it('is never reached through require(), except where the require IS the mechanism', () => {
    // The child recorder runs before any ESM graph exists and reaches `fs` through `createRequire`
    // on purpose — it is the thing doing the wrapping in a child process, not a bypass of it. The
    // suites that drive a real child carry that child's SOURCE as a string, and a child by
    // definition cannot use this module's binding; that is the property they exist to exercise.
    const requireRoute = /\brequire\s*\(\s*['"](?:node:)?fs(?:\/promises)?['"]\s*\)/;
    const allowed = new Set([
      selfRelative,
      path.join('tests', 'helpers', 'child-dir-ledger.mjs'),
      path.join('tests', 'safety', 'cross-process-ledger.test.ts'),
      path.join('tests', 'safety', 'ledger-record-lifecycle.test.ts'),
    ]);
    expect(offenders(requireRoute, allowed)).toEqual([]);
  });

  // -------------------------------------------------------------------------------------------
  // WHERE A RECURSIVE REMOVAL MAY STAND — decided per CALL, by position, never per file.
  // -------------------------------------------------------------------------------------------

  /**
   * A recursive `rm` decides its entire walk inside the call, from a name, long after the caller's
   * last check — one directory swapped in at that name turns a tidy-up into the loss of a foreign
   * tree. Teardown therefore never uses one: fixtures go through `removeOwned()`, which removes one
   * entry at a time against an identity recorded at creation.
   *
   * WHY THIS IS NOT A LIST OF FILES. A file-level allowance says "somewhere in here, a recursive
   * removal is the subject" and then licenses every other line in the same file forever, including
   * the `afterEach` somebody adds next month. The thing that has to be authorised is the CALL, and
   * the only property that distinguishes the two uses is WHERE IT STANDS: a call inside a test body
   * runs because the test is exercising the primitive, and a call in a teardown position runs no
   * matter what the test was about.
   *
   * WHY IT IS NOT A LIST OF NAMES EITHER — the defect this rewrite fixes. The rule used to spell
   * "teardown position" partly as a NAME SHORTLIST: `clean|teardown|dispose|unwind`. That is not a
   * property of the code, it is a property of what somebody felt like calling it, and three helpers
   * in this suite were called `wipe`. All three were `function wipe(…)` bodies whose entire content
   * was `fs.rmSync(…, { recursive: true, force: true })` — teardown in every respect except the
   * one the regex was reading — and all three PASSED. A shortlist cannot be completed, because the
   * next author picks a word that is not on it; every green it produces is provisional on
   * vocabulary.
   *
   * SO THE THIRD SIGNAL IS BEHAVIOURAL: A DISPOSAL BODY. A block whose entire content is
   * destruction — it removes, and it does nothing else: no assertion, no allocation, no process,
   * no test — is teardown by construction, whatever it is called and wherever it is called from.
   * That is precisely what a fixture-disposal helper is, and precisely what a test exercising the
   * primitive is not: a test that is ABOUT recursive removal asserts something about it, and a
   * helper that builds anything allocates something. Neither reads as a disposal body, and neither
   * needs to be named to be recognised.
   *
   * The two structural signals stay, because they are API positions rather than names: a lifecycle
   * hook's callback, and a `finally`.
   */
  const HOOK_CALLBACK = /\b(?:beforeAll|beforeEach|afterAll|afterEach)\s*\(/;
  const FINALLY_BLOCK = /\bfinally\b/;

  /**
   * Headers that open CONTROL FLOW rather than a body of their own. A `for`, `try` or `if` block
   * inherits its meaning from whatever encloses it, so judging it independently would condemn the
   * loop inside a test that is exercising the primitive.
   */
  const CONTROL_HEADER = /^\s*(?:if|else|for|while|do|try|catch|switch)\b/;

  /** Anything whose presence means the block does more than destroy. */
  const NOT_ONLY_DESTRUCTION =
    /\b(?:expect|it|test|describe|assert|mkdirSync|mkdtempSync|writeFileSync|appendFileSync|copyFileSync|symlinkSync|linkSync|openSync|renameSync|cpSync|spawnSync|spawn|execFileSync|execSync|runTempDir|createFakeHome|require|import)\s*\(/;

  /** The destruction a disposal body is made of. */
  const DESTRUCTION =
    /\b(?:rmSync|rmdirSync|unlinkSync|removeOwned|removeForeignTree)\s*\(|\bfs\s*\.\s*rm\s*\(/;

  /**
   * A genuine recursive removal CALL, anchored — not the word `recursive` inside a spy's
   * bookkeeping, and not a mention of the name in prose.
   */
  const RECURSIVE_CALL =
    /^fs\s*\.\s*(?:rmSync\s*\([^;]*\brecursive\s*:\s*true|rm\s*\(|promises\s*\.\s*rm\s*\()/;

  /**
   * The source with everything a brace inside it would lie about replaced by spaces: comments, the
   * three string forms, and REGEX LITERALS. Newlines are kept so an offset still names a line.
   *
   * Brace depth is how the enclosing blocks are tracked, so a `{` in a comment or a `${` in a
   * template literal would shift every block boundary after it and silently re-classify calls.
   *
   * REGEX LITERALS ARE NOT AN EDGE CASE — LEAVING THEM OUT BLINDED THIS RULE TO A WHOLE FILE. A
   * pattern like `/[\s"']\/x/` contains a lone `"`, and a stripper that only knows about strings
   * treats it as the START of one: the scan then runs to the next `"` hundreds of lines later,
   * blanking every brace, every call and every hook in between. `freshtest-gate-contract.test.ts`
   * was exactly this — over a thousand lines of it were erased before the classifier ever saw them,
   * so the rule reported that file clean without having read a line of it. A scanner that fails
   * this way fails SILENTLY and in the permissive direction, which is the one failure mode a
   * meta-rule may not have. Hence both the regex handling below and `desyncs()` beneath it.
   *
   * A `/` starts a regex only where a value cannot already have ended, so the preceding significant
   * character decides it; a division always follows an identifier, a number, `)` or `]`. Inside a
   * `[...]` class a `/` is literal, and a scan that reaches a newline was a division after all and
   * is abandoned rather than guessed at.
   */
  const BEFORE_REGEX = /[([{=:,;!&|?+\-*%~^<>]$/;
  const KEYWORD_BEFORE_REGEX =
    /(?:^|[^A-Za-z0-9_$])(?:return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await)$/;

  function regexStartsHere(before: string, end = before.length): boolean {
    // This predicate runs once for every slash in every source file. Do not build and trim the
    // whole prefix at each call: that turns the scanner's otherwise linear walk into a quadratic
    // one. Looking backwards to the preceding significant character is the same lexical decision.
    let last = end - 1;
    while (last >= 0 && /\s/.test(before[last] as string)) {
      last -= 1;
    }
    if (last < 0) {
      return true;
    }
    if (BEFORE_REGEX.test(before[last] as string)) {
      return true;
    }
    // `instanceof` is the longest accepted keyword. Keep one preceding character in the window
    // so the JavaScript-identifier boundary has the same information it had against the full prefix.
    return KEYWORD_BEFORE_REGEX.test(before.slice(Math.max(0, last - 10), last + 1));
  }

  it('classifies regex positions from the preceding lexical window', () => {
    const cases: readonly [before: string, end: number | undefined, expected: boolean][] = [
      ['', undefined, true],
      ['   ', undefined, true],
      ['(  ', undefined, true],
      ['return  ', undefined, true],
      ['instanceof ', undefined, true],
      ['_instanceof ', undefined, false],
      ['$instanceof ', undefined, false],
      ['value ', undefined, false],
      ['return / ignored', 'return '.length, true],
      ['value / ignored', 'value '.length, false],
    ];

    for (const [before, end, expected] of cases) {
      expect(regexStartsHere(before, end), JSON.stringify({ before, end })).toBe(expected);
    }
  });

  /** How far a regex literal beginning at `i` runs, or -1 when it was a division after all. */
  function regexEnd(text: string, i: number): number {
    let inClass = false;
    for (let j = i + 1; j < text.length; j += 1) {
      const ch = text[j] as string;
      if (ch === '\\') {
        j += 1;
        continue;
      }
      if (ch === '\n') {
        return -1; // a regex literal cannot span lines: this was a division
      }
      if (inClass) {
        if (ch === ']') {
          inClass = false;
        }
        continue;
      }
      if (ch === '[') {
        inClass = true;
        continue;
      }
      if (ch === '/') {
        return j;
      }
    }
    return -1;
  }

  /** Several rules strip the same file; the result depends only on the text, so it is memoised. */
  const stripped = new Map<string, string>();

  function stripInert(text: string): string {
    const hit = stripped.get(text);
    if (hit !== undefined) {
      return hit;
    }
    const out = stripInertUncached(text);
    stripped.set(text, out);
    return out;
  }

  function stripInertUncached(text: string): string {
    let out = '';
    for (let i = 0; i < text.length; i += 1) {
      const two = text.slice(i, i + 2);
      if (two === '/*') {
        for (i += 2; i < text.length && text.slice(i, i + 2) !== '*/'; i += 1) {
          out += text[i] === '\n' ? '\n' : ' ';
        }
        out += '  ';
        i += 1;
        continue;
      }
      if (two === '//') {
        for (i += 2; i < text.length && text[i] !== '\n'; i += 1) {
          out += ' ';
        }
        out += '  \n'.slice(0, i < text.length ? 3 : 2);
        continue;
      }
      const ch = text[i] as string;
      if (ch === '/' && regexStartsHere(out)) {
        const end = regexEnd(text, i);
        if (end !== -1) {
          out += ' '.repeat(end - i + 1);
          i = end;
          continue;
        }
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        out += ' ';
        for (i += 1; i < text.length; i += 1) {
          if (text[i] === '\\') {
            out += '  ';
            i += 1;
          } else if (text[i] === ch) {
            out += ' ';
            break;
          } else {
            out += text[i] === '\n' ? '\n' : ' ';
          }
        }
        continue;
      }
      out += ch;
    }
    return out;
  }

  /**
   * Evidence that the stripper stayed in step with the source — reported per file, by line.
   *
   * Two invariants, both cheap and both violated by the failure above:
   *   1. A `'` or `"` string cannot legally span a line in JavaScript. A blanked run that crosses
   *      one therefore means the scanner mistook something else for a quote and has been erasing
   *      code ever since.
   *   2. Braces balance. A stripper that swallowed an opening or closing brace shifts every block
   *      boundary after it, which is how an authorised call silently becomes a teardown one, or the
   *      reverse.
   * A file that trips either is REPORTED rather than classified — a scanner that cannot read a file
   * must say so, not call it clean.
   */
  function desyncs(rel: string, text: string): string[] {
    const problems: string[] = [];
    let line = 1;
    for (let i = 0; i < text.length; i += 1) {
      const two = text.slice(i, i + 2);
      if (two === '/*') {
        for (i += 2; i < text.length && text.slice(i, i + 2) !== '*/'; i += 1) {
          if (text[i] === '\n') {
            line += 1;
          }
        }
        i += 1;
        continue;
      }
      if (two === '//') {
        for (i += 2; i < text.length && text[i] !== '\n'; i += 1) {
          // consumed
        }
        continue;
      }
      const ch = text[i] as string;
      if (ch === '\n') {
        line += 1;
        continue;
      }
      if (ch === '/' && regexStartsHere(text, i)) {
        const end = regexEnd(text, i);
        if (end !== -1) {
          i = end;
          continue;
        }
      }
      if (ch === "'" || ch === '"') {
        const startLine = line;
        for (i += 1; i < text.length; i += 1) {
          if (text[i] === '\\') {
            i += 1;
          } else if (text[i] === ch) {
            break;
          } else if (text[i] === '\n') {
            line += 1;
          }
        }
        if (line !== startLine) {
          problems.push(`${rel}:${startLine}: a ${ch} run spans ${line - startLine} lines`);
          return problems; // everything after this point is untrustworthy anyway
        }
        continue;
      }
      if (ch === '`') {
        for (i += 1; i < text.length; i += 1) {
          if (text[i] === '\\') {
            i += 1;
          } else if (text[i] === '`') {
            break;
          } else if (text[i] === '\n') {
            line += 1;
          }
        }
      }
    }
    const code = stripInert(text);
    let depth = 0;
    for (const ch of code) {
      if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (depth < 0) {
          problems.push(`${rel}: brace depth went negative — the stripper lost its place`);
          return problems;
        }
      }
    }
    if (depth !== 0) {
      problems.push(`${rel}: ${depth} unclosed brace(s) after stripping`);
    }
    return problems;
  }

  interface Block {
    header: string;
    bodyStart: number;
    bodyEnd: number;
  }

  /**
   * Every recursive removal call in `text`, each answering the one question that matters: is any
   * block open around it a teardown position?
   *
   * Walked character by character rather than line by line, because a hook, its callback and the
   * call can all share a line and the ORDER along that line is what decides the answer.
   *
   * The header of a block is the text since the last `{`, `}` or `;` — the header of the block
   * being opened, and nothing else. A wider window would inherit an `afterEach` that closed three
   * statements ago and condemn the next test body that follows it.
   *
   * Blocks are judged AFTER the walk rather than at the `{`, because the behavioural signal is a
   * property of the block's BODY and the body is not known when it opens.
   */
  function recursiveCallPositions(text: string): { line: number; teardown: boolean }[] {
    const code = stripInert(text);
    const blocks: Block[] = [];
    const open: number[] = [];
    const calls: { line: number; enclosing: number[] }[] = [];
    let header = '';
    let line = 1;
    for (let i = 0; i < code.length; i += 1) {
      const ch = code[i] as string;
      if (ch === 'f' && code.startsWith('fs', i) && RECURSIVE_CALL.test(code.slice(i, i + 200))) {
        calls.push({ line, enclosing: [...open] });
      }
      if (ch === '\n') {
        line += 1;
      }
      if (ch === '{') {
        blocks.push({ header, bodyStart: i + 1, bodyEnd: code.length });
        open.push(blocks.length - 1);
        header = '';
      } else if (ch === '}') {
        const closing = open.pop();
        if (closing !== undefined) {
          (blocks[closing] as Block).bodyEnd = i;
        }
        header = '';
      } else if (ch === ';') {
        header = '';
      } else {
        header += ch;
      }
    }

    const teardownPosition = (block: Block): boolean => {
      if (HOOK_CALLBACK.test(block.header) || FINALLY_BLOCK.test(block.header)) {
        return true;
      }
      if (CONTROL_HEADER.test(block.header)) {
        // Control flow inherits its meaning from whatever encloses it, which is judged separately.
        return false;
      }
      const body = code.slice(block.bodyStart, block.bodyEnd);
      // A DISPOSAL BODY: it destroys, and it does nothing else. No name is consulted.
      return DESTRUCTION.test(body) && !NOT_ONLY_DESTRUCTION.test(body);
    };

    return calls.map((call) => ({
      line: call.line,
      teardown: call.enclosing.some((idx) => teardownPosition(blocks[idx] as Block)),
    }));
  }

  /**
   * DEBT, NOT AUTHORISATION — and deliberately awkward to live with.
   *
   * These files hold a disposal helper that still hands a pathname to a recursive removal. They
   * belong to other work in flight and are not this change's to edit, so the rule that catches them
   * would otherwise have to be weakened to ship — which is how the name shortlist got there in the
   * first place. They are named here instead, with three properties that keep this from becoming
   * the register the doctrine above refuses:
   *
   *   1. It is a CEILING, not a licence: the set of offending files must be a SUBSET of this list.
   *      Fixing one is silently fine; adding one anywhere in the suite is a failure.
   *   2. No file this change owns may appear in it. Anything within reach was fixed on the merits —
   *      `build-harness-currency`, `build-harness-lock` and `packaged-keyless-matrix` now allocate
   *      through `runTempDir`/`removeOwned` or walk a foreign tree one entry at a time.
   *   3. It names FILES, and the rule still decides per CALL. A file on this list gets no blanket
   *      pass in any other rule here, and a second offending call inside one of them is still
   *      reported by name and line below.
   */
  // EMPTY, AND IT STAYS EMPTY. Every disposal in this tree now goes through the owned run-root
  // machinery or the bounded foreign-tree removal, so nothing needs an exemption. The set is kept
  // as a named, asserted-empty seam: a future recursive removal in a teardown fails the rule
  // rather than being quietly added here.
  const DISPOSAL_DEBT: ReadonlySet<string> = new Set<string>();

  /** The files this change is responsible for; none of them may be carrying the debt above. */
  const OWNED_HERE: readonly string[] = [
    path.join('tests', 'safety', 'build-harness-currency.test.ts'),
    path.join('tests', 'safety', 'build-harness-lock.test.ts'),
    path.join('tests', 'safety', 'packaged-keyless-matrix.test.ts'),
    path.join('tests', 'safety', 'temp-cleanup-ownership.test.ts'),
    path.join('tests', 'helpers', 'build-cli.ts'),
    path.join('tests', 'helpers', 'foreign-tree.ts'),
  ];

  function harnessTestFiles(): string[] {
    // `packages/` is the product and its own tests; this rule governs the harness's tests, whose
    // teardown the ownership design is responsible for.
    return sourceFiles().filter(
      (rel) => rel.startsWith(`tests${path.sep}`) && rel !== selfRelative,
    );
  }

  it('the scanner can actually read every file it claims to have checked', () => {
    // THE RULE'S OWN PRECONDITION. A stripper that loses its place blanks whatever follows, and a
    // blanked file classifies as clean — silently, permissively, and forever. That is exactly what
    // happened: a regex literal containing a quote erased a thousand-line file from this rule's
    // view. Nothing below is worth anything unless this holds first.
    const problems: string[] = [];
    for (const rel of harnessTestFiles()) {
      problems.push(...desyncs(rel, fs.readFileSync(path.join(repoRoot, rel), 'utf8')));
    }
    expect(problems).toEqual([]);
    // Keep this load-bearing whole-tree check under Vitest's default timeout. In particular, the
    // regex classifier must inspect only the preceding lexical window rather than repeatedly copy
    // and rescan each complete source prefix.
  });

  it('never stands a recursive removal in a TEARDOWN position, in any test file', () => {
    const offences: string[] = [];
    let total = 0;
    for (const rel of harnessTestFiles()) {
      const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
      for (const hit of recursiveCallPositions(text)) {
        total += 1;
        if (hit.teardown) {
          offences.push(`${rel}:${hit.line}`);
        }
      }
    }
    const unexpected = offences.filter(
      (at) => !DISPOSAL_DEBT.has(at.slice(0, at.lastIndexOf(':'))),
    );
    expect(unexpected, 'a recursive removal appeared in a teardown position').toEqual([]);
    // A classifier that has silently stopped finding anything would report a clean tree forever.
    // The suite really does exercise recursive removal where it is the subject, so if this ever
    // reaches zero the rule above has become vacuous and must be re-derived, not celebrated.
    expect(total).toBeGreaterThan(0);
  });

  it('no file this change owns is carrying the disposal debt', () => {
    // The register above is only tolerable while it is shrinking and while nothing reachable is on
    // it. This is the half that can be enforced from here.
    for (const rel of OWNED_HERE) {
      expect(DISPOSAL_DEBT.has(rel), `${rel} took a disposal allowance instead of a fix`).toBe(
        false,
      );
      const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
      const teardown = recursiveCallPositions(text)
        .filter((hit) => hit.teardown)
        .map((hit) => `${rel}:${hit.line}`);
      expect(teardown, `${rel} still disposes of fixtures recursively`).toEqual([]);
    }
  });

  it('the classifier: an authorised call CANNOT be moved into teardown and stay authorised', () => {
    // The rule is only worth anything if it actually catches the migration it exists to prevent.
    // So the classifier is run against sources written here, where the answer is known — the same
    // call, in each position it could end up in.
    const call = 'fs.rmSync(dir, { recursive: true, force: true });';
    const authorised = [
      `describe('d', () => { it('exercises the primitive', () => { ${call} expect(x).toBe(1); }); });`,
      // A helper that BUILDS as well as removes is not a disposal body: it is doing the work the
      // test is about, and the removal is a step in it rather than the whole of it.
      `describe('d', () => { function rebuild(dir) { ${call} fs.mkdirSync(dir); } it('x', () => { rebuild(d); expect(1).toBe(1); }); });`,
      // The removal is the subject of the assertion itself.
      `describe('d', () => { it('x', () => { expect(() => fs.rmSync(t, { recursive: true })).toThrow(); }); });`,
    ];
    for (const src of authorised) {
      expect(recursiveCallPositions(src), src).toEqual([{ line: 1, teardown: false }]);
    }

    const teardown = [
      `describe('d', () => { afterEach(() => { ${call} }); });`,
      `describe('d', () => { beforeEach(() => { ${call} }); });`,
      `describe('d', () => { afterAll(() => { ${call} }); });`,
      `describe('d', () => { beforeAll(() => { ${call} }); });`,
      `describe('d', () => { it('x', () => { try { go(); } finally { ${call} } }); });`,
      `describe('d', () => { function cleanupFixture() { ${call} } it('x', () => { cleanupFixture(); }); });`,
      `describe('d', () => { const teardownAll = () => { ${call} }; it('x', () => { teardownAll(); }); });`,
      // ------------------------------------------------------------------------------------
      // THE REGRESSIONS. Every one of these passed the old rule, because the old rule read the
      // NAME and none of these names was on its list. All three shapes are real: they are the
      // helpers that stood in build-harness-currency, build-harness-lock and
      // packaged-keyless-matrix, and each is a body whose entire content is destruction.
      // ------------------------------------------------------------------------------------
      `describe('d', () => { function wipe(dir) { ${call} } it('x', () => { wipe(d); }); });`,
      `describe('d', () => { function wipe() { for (const dir of strays.splice(0)) { ${call} } } it('x', () => { wipe(); }); });`,
      `describe('d', () => { function wipe(h) { for (const root of [h.a, h.b]) { fs.rmSync(root, { recursive: true, force: true }); } } it('x', () => { wipe(h); }); });`,
      // ...and the name is not what condemns them: nothing on the shortlist, nothing off it.
      `describe('d', () => { const nuke = (d) => { ${call} }; it('x', () => { nuke(d); }); });`,
      `describe('d', () => { function reap(d) { ${call} } it('x', () => { reap(d); }); });`,
      `describe('d', () => { function 又(d) { ${call} } it('x', () => { 又(d); }); });`,
    ];
    for (const src of teardown) {
      expect(recursiveCallPositions(src), src).toEqual([{ line: 1, teardown: true }]);
    }

    // AND THE NAMES CARRY NO WEIGHT IN EITHER DIRECTION. A body that is doing real work is
    // authorised even when it is called `cleanup`, because the rule is reading behaviour.
    expect(
      recursiveCallPositions(
        `describe('d', () => { function cleanup(dir) { ${call} expect(fs.existsSync(dir)).toBe(false); } it('x', () => { cleanup(d); }); });`,
      ),
      'the rule is still reading the helper name rather than the body',
    ).toEqual([{ line: 1, teardown: false }]);

    // And the classifier must not be fooled by the two things that would shift every brace after
    // them: a brace in a comment, and a `${}` inside a template literal.
    const camouflaged = `describe('d', () => { /* afterEach(() => { */ it('x', () => { fs.rmSync(\`\${p}.lock\`, { recursive: true, force: true }); expect(1).toBe(1); }); });`;
    expect(recursiveCallPositions(camouflaged)).toEqual([{ line: 1, teardown: false }]);

    // A spy recording the word `recursive` is bookkeeping, not a removal, and must not be counted.
    const bookkeeping = `it('x', () => { calls.push({ op: 'rmSync', recursive: o?.recursive === true }); });`;
    expect(recursiveCallPositions(bookkeeping)).toEqual([]);
  });

  it('keeps NO recursive removal in the helpers, which exist to make one unnecessary', () => {
    const helpers = path.join('tests', 'helpers');
    const hits: string[] = [];
    for (const rel of sourceFiles()) {
      if (!rel.startsWith(helpers + path.sep)) {
        continue;
      }
      const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
      for (const hit of recursiveCallPositions(text)) {
        hits.push(`${rel}:${hit.line}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
