import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * SAFETY: the release smoke gate must install the release tarball somewhere DURABLE, and must not
 * expect a launcher to outlive the installation it is pinned at.
 *
 * TWO PROPERTIES OF `.github/workflows/release.yml` THAT NOTHING ELSE IN THE SUITE CAN SEE.
 *
 *   1. THE INSTALL LOCATION. `sthayi init` writes launchers that pin the exact CLI entry they were
 *      written from, and `isEphemeralPath` (packages/cli/src/clients/launcher.ts) REFUSES to pin an
 *      entry that lives in an npm/npx cache or beneath `os.tmpdir()`. A `mktemp -d` install dir is
 *      beneath `os.tmpdir()`, so an `init --yes` run against an installation there fails outright,
 *      and the failure is reachable only by pushing a tag and watching the pipeline break.
 *   2. THE TEARDOWN. Sthayi copies no package into the home: every launcher references the
 *      installation IN PLACE. A gate that deletes the installation and then expects the launchers to
 *      keep working asserts a capability that does not exist — it could hold only against a runtime
 *      copy, and there is none.
 *
 * WHY IT IS A TEXT GATE IN THE ORDINARY SUITE. The workflow's only trigger is pushing a release tag,
 * so the pipeline first runs itself on the release it is supposed to protect. `pnpm test` runs on
 * every change, which is where a claim about the release path has to be checked. The parse is
 * deliberately shallow and FAILS CLOSED: an install directory this file cannot resolve to a durable
 * base is a failure, not a pass, so renaming or restructuring the step does not silently disarm it.
 *
 * Nothing here executes the workflow, spawns a shell, or writes to the filesystem.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'release.yml');
const workflow = (): string => fs.readFileSync(workflowPath, 'utf8');

/**
 * The lines of one top-level job. Jobs sit at two-space indent under `jobs:`, so the block runs from
 * `  <name>:` to the next line matching that shape. Blank lines and comments inside the block are
 * kept — the ordering assertions below are about executable lines, and the comment scan needs them.
 *
 * `text` defaults to the workflow on disk. Passing a MUTATED copy is how the analysis below is
 * shown to catch what it claims to catch, rather than being trusted to.
 */
function jobBlock(name: string, text: string = workflow()): { line: string; at: number }[] {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l === `  ${name}:`);
  expect(start, `job '${name}' not found in .github/workflows/release.yml`).toBeGreaterThan(-1);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}[A-Za-z][\w-]*:\s*$/.test(lines[i] as string)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).map((line, i) => ({ line, at: start + i + 1 }));
}

/** Executable shell lines only — a comment describing a hazard is not the hazard. */
function shellLines(name: string, text?: string): { line: string; at: number }[] {
  return jobBlock(name, text)
    .map(({ line, at }) => ({ line: line.trim(), at }))
    .filter(({ line }) => line !== '' && !line.startsWith('#'));
}

/** A `NAME=value` word. */
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/** The shell's own variables and working directory, as they stand at one point in the job. */
interface ShellState {
  /** variable → its value, with the `$NAME`s it was written with already expanded */
  vars: Map<string, string>;
  /** variable → the value as the workflow spells it, for messages */
  literals: Map<string, string>;
  cwd: string;
}

/**
 * A command with its leading `NAME=value` words removed. Those words are a PREFIX: they set the
 * environment of the single command that follows them and leave the shell's own variables alone,
 * so `HOME="$SMOKE_HOME" "$BIN" --help` is a USE of `$SMOKE_HOME` and not a definition of `HOME`.
 * What follows the prefix is still a command — `FOO=1 rm -rf …` removes exactly what `rm -rf …`
 * removes.
 */
function withoutPrefixAssignments(w: string[]): string[] {
  let n = 0;
  while (n < w.length && ASSIGNMENT.test(w[n] as string)) {
    n += 1;
  }
  return w.slice(n);
}

/**
 * Apply one command to the shell state; report whether the command WAS that state change and so
 * removes nothing.
 *
 * REASSIGNMENT IS LAST-WRITE-WINS, AT THE POINT OF USE. A name holds what was most recently
 * assigned to it, so a variable that pointed somewhere harmless earlier in the job does not still
 * point there after it is reassigned — `X=safe` followed by `X="$SMOKE_INSTALL_DIR"` leaves `$X`
 * naming the installation.
 */
function applyToState(state: ShellState, w: string[]): boolean {
  if (w.length === 0) {
    return true;
  }
  const rest = withoutPrefixAssignments(w);
  if (rest.length === 0) {
    for (const word of w) {
      const m = ASSIGNMENT.exec(word) as RegExpExecArray;
      const value = m[2] as string;
      state.literals.set(m[1] as string, value);
      state.vars.set(m[1] as string, expandShell(value, state.vars, state.cwd));
    }
    return true;
  }
  if (rest[0] === 'cd') {
    state.cwd =
      rest[1] === undefined
        ? state.cwd
        : resolvePath(expandShell(rest[1], state.vars, state.cwd), state.cwd);
    return true;
  }
  return false;
}

/**
 * The state the shell has reached at `beforeLine` — or at the end of the job when that is omitted —
 * by running the job's own assignments and `cd`s in order.
 */
function shellStateAt(
  lines: { line: string; at: number }[],
  beforeLine: number = Number.POSITIVE_INFINITY,
): ShellState {
  const state: ShellState = { vars: new Map(), literals: new Map(), cwd: JOB_CWD };
  for (const { line, at } of lines) {
    if (at >= beforeLine) {
      break;
    }
    for (const command of commands(line)) {
      applyToState(state, words(command));
    }
  }
  return state;
}

/** Every spelling of "this path is thrown away by the OS or by npm". */
const EPHEMERAL_SPELLINGS: { re: RegExp; why: string }[] = [
  { re: /\bmktemp\b/, why: 'mktemp allocates beneath the system temp dir' },
  { re: /\$\{?TMPDIR\b/, why: '$TMPDIR is the system temp dir' },
  { re: /\$\{?RUNNER_TEMP\b/, why: '$RUNNER_TEMP is a scratch dir the runner reclaims' },
  { re: /\$\{?TEMP\b/, why: '$TEMP is a system temp dir' },
  { re: /(^|[^\w])\/tmp(\/|$)/, why: '/tmp is the system temp dir' },
  { re: /(^|[^\w])\/var\/tmp(\/|$)/, why: '/var/tmp is a system temp dir' },
  { re: /\b_npx\b/, why: '_npx is npm’s download cache' },
  { re: /\b_cacache\b/, why: '_cacache is npm’s content cache' },
  { re: /\$\{?npm_config_cache\b/, why: 'npm_config_cache is npm’s cache' },
];

/** Bases a release install may live under: the checkout the job owns, or the runner user's home. */
const DURABLE_BASES = ['$GITHUB_WORKSPACE', '${GITHUB_WORKSPACE}', '$HOME', '${HOME}'];

/**
 * Resolve the directory the release tarball is npm-installed into: find the single
 * `npm install --engine-strict "$TARBALL"`, walk back to the `cd` that put the shell there, and read that variable
 * out of the state the job has reached AT THAT LINE — the value it was last assigned before the
 * install, not the first one it ever held. No `cd`, no resolvable variable, or more than one
 * tarball install and this fails — an install location the gate cannot name is not a pass.
 */
function smokeInstallDir(text?: string): { raw: string; expanded: string; varName: string } {
  const lines = shellLines('smoke-install', text);
  const installs = lines.filter(({ line }) =>
    /^npm\s+install\s+--engine-strict\s+"?\$\{?TARBALL/.test(line),
  );
  expect(
    installs.length,
    'expected exactly one strict `npm install --engine-strict "$TARBALL"` in the smoke-install job',
  ).toBe(1);
  const installAt = (installs[0] as { at: number }).at;
  const { vars, literals } = shellStateAt(lines, installAt);
  const cds = lines.filter(({ line, at }) => at < installAt && /^cd\s+/.test(line));
  expect(
    cds.length,
    'no `cd` precedes the tarball install — its directory is unknown',
  ).toBeGreaterThan(0);
  const target = (cds[cds.length - 1] as { line: string }).line
    .replace(/^cd\s+/, '')
    .replace(/^"(.*)"$/, '$1')
    .trim();
  const nameMatch = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(target);
  expect(
    nameMatch,
    `the tarball install runs in ${JSON.stringify(target)}, which is not a single shell variable this gate can resolve`,
  ).not.toBeNull();
  const varName = (nameMatch as RegExpExecArray)[1] as string;
  expect(
    vars.has(varName),
    `no assignment for $${varName} stands when the tarball install runs`,
  ).toBe(true);
  return {
    raw: literals.get(varName) as string,
    expanded: vars.get(varName) as string,
    varName,
  };
}

describe('safety: the release smoke gate installs somewhere durable', () => {
  it('the tarball is installed into a directory that is not a temp or cache path', () => {
    const { raw, expanded, varName } = smokeInstallDir();
    for (const { re, why } of EPHEMERAL_SPELLINGS) {
      expect(
        re.test(expanded),
        `smoke install dir $${varName} = ${JSON.stringify(raw)} is ephemeral: ${why}.
\`sthayi init\` refuses to pin a launcher at an entry under it, so \`init --yes\` in the release
smoke job would fail outright.`,
      ).toBe(false);
    }
  });

  it('the install directory is anchored to a durable base rather than an unnamed one', () => {
    const { raw, expanded, varName } = smokeInstallDir();
    expect(
      DURABLE_BASES.some((b) => expanded.startsWith(b)),
      `smoke install dir $${varName} = ${JSON.stringify(raw)} is not anchored to one of ${DURABLE_BASES.join(', ')} — this gate cannot establish that it survives the step, so it refuses to pass it.`,
    ).toBe(true);
  });

  it('reads the install directory as the value that stands AT the install, not an earlier one', () => {
    // A name assigned a durable path and then REASSIGNED before the install holds the second value
    // when the install runs. Reading the first one would clear an install the job never performs.
    const anchor = `${' '.repeat(10)}mkdir -p "$SMOKE_INSTALL_DIR"\n`;
    const wf = workflow();
    expect(
      wf,
      'the smoke job does not create its install directory — this test has nothing to inject after',
    ).toContain(anchor);
    const { expanded } = smokeInstallDir(
      wf.replace(anchor, `${anchor}${' '.repeat(10)}SMOKE_INSTALL_DIR="$(mktemp -d)"\n`),
    );
    expect(
      EPHEMERAL_SPELLINGS.some(({ re }) => re.test(expanded)),
      `an install directory reassigned to a temp path before the install resolves to ${JSON.stringify(expanded)} — the gate is reading a value the install never sees`,
    ).toBe(true);
  });

  it('the job proves durability against os.tmpdir() on the runner, not only in this text gate', () => {
    // A text gate reads spellings; only the runner knows what `os.tmpdir()` actually is there.
    const block = jobBlock('smoke-install')
      .map((l) => l.line)
      .join('\n');
    expect(block).toContain('os.tmpdir()');
  });
});

describe('safety: the release smoke gate never deletes the installation its launchers are pinned at', () => {
  /** Every removal command in the job, with the argument text it was given. */
  function removals(): { line: string; at: number }[] {
    return shellLines('smoke-install').filter(({ line }) =>
      /(^|[|;&]\s*)rm\s+-[A-Za-z]*[rR]|^npm\s+(rm|uninstall|remove)\b/.test(line),
    );
  }

  // What this one verifies is exactly its title: a recursive removal that NAMES the install
  // variable. A deletion reaches the same directory without naming it — through the literal path,
  // an alias, a `cd`, a single file inside it, or a program that is not `rm` — and resolving those
  // is the gate further down ("no deletion in the smoke job resolves to the pinned installation").
  it('no recursive removal spells the install variable in its arguments', () => {
    const lines = shellLines('smoke-install');
    const { vars } = shellStateAt(lines);
    const installVar = [...vars.keys()].find((k) => /INSTALL_DIR$/.test(k));
    expect(
      installVar,
      'expected a shell variable whose name ends in INSTALL_DIR to hold the smoke installation',
    ).toBeTruthy();
    for (const { line, at } of removals()) {
      expect(
        line.includes(`$${installVar}`) || line.includes(`\${${installVar}}`),
        `release.yml:${at} removes the installation the launchers are pinned at: ${line}
Sthayi copies no package into the home — every launcher references the install in place, so a
launcher cannot survive its installation being deleted. Remove only the npm cache and the release
tarball.`,
      ).toBe(false);
    }
  });

  it('no npm uninstall of the package stands between the install and the launcher proof', () => {
    for (const { line, at } of removals()) {
      expect(
        /^npm\s+(rm|uninstall|remove)\b/.test(line),
        `release.yml:${at} uninstalls the package the launchers are pinned at: ${line}`,
      ).toBe(false);
    }
  });

  it('the launcher proof runs after the teardown, so it still proves something', () => {
    const lines = shellLines('smoke-install');
    const cacheClean = lines.find(({ line }) => /^npm\s+cache\s+clean/.test(line));
    expect(
      cacheClean,
      'the smoke job no longer prunes the npm cache before proving the launchers',
    ).toBeTruthy();
    const launcherRun = lines.filter(({ line }) => /\$\{?LAUNCHER_(CLI|MCP)\}?/.test(line));
    expect(launcherRun.length, 'no launcher is exercised in the smoke job').toBeGreaterThan(0);
    const lastLauncher = (launcherRun[launcherRun.length - 1] as { at: number }).at;
    expect(lastLauncher).toBeGreaterThan((cacheClean as { at: number }).at);
  });

  it('the job asserts the pinned installation is still standing when the launchers run', () => {
    const lines = shellLines('smoke-install');
    const { vars } = shellStateAt(lines);
    const installVar = [...vars.keys()].find((k) => /INSTALL_DIR$/.test(k)) as string;
    const stillThere = lines.some(
      ({ line }) => /^if\s+\[\s+!\s+-[fdes]\s/.test(line) && line.includes(`$${installVar}`),
    );
    expect(
      stillThere,
      'nothing in the smoke job checks that the installation the launchers point at still exists ' +
        'when they are exercised — without it the gate cannot tell an in-place pin from a copy',
    ).toBe(true);
  });
});

/* ── resolving what a deletion command actually deletes ───────────────────────────────────────
 *
 * The check above reads one line at a time and asks whether the INSTALL_DIR variable is spelled in
 * it. A deletion does not have to spell it: the same directory is reachable as the literal path the
 * variable was assigned, as a second variable holding the first, as a relative path after a `cd`
 * into it, as a single file deep inside it, and as an operand of a program that is not `rm`. Each
 * of those removes exactly what the launchers are pinned at while reading nothing like a removal of
 * `$SMOKE_INSTALL_DIR`.
 *
 * So the job is read the way a shell runs it: each assignment REPLACES the previous value of that
 * name, an assignment written in front of a command belongs to that command alone, `cd` moves the
 * working directory, and every deletion command's operands are expanded and resolved to a path,
 * which is then compared with the installation — the same path, an ancestor of it, or something
 * inside it are all fatal. Where the text cannot establish that two paths are separate, they are
 * read as possibly the same.
 */

/** Where a `run:` step starts. GitHub Actions runs each step of a job in `$GITHUB_WORKSPACE`, and
 *  this job sets no `working-directory`. */
const JOB_CWD = '$GITHUB_WORKSPACE';

/** Commands that unlink what they are handed. */
const REMOVERS = new Set(['rm', 'rmdir', 'unlink', 'shred']);

/** `npm` subcommands that remove an installed package from `node_modules`. */
const NPM_REMOVE = new Set(['rm', 'uninstall', 'remove', 'un', 'r']);

/** Cut an unquoted trailing `#` comment. */
function stripComment(line: string): string {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] as string;
    if (quote) {
      if (ch === quote) {
        quote = undefined;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1] as string))) {
      return line.slice(0, i);
    }
  }
  return line;
}

/** The separate commands one line runs, split at unquoted `;`, `&&`, `||`, `|` and `&`. */
function commands(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | undefined;
  const src = stripComment(line);
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i] as string;
    if (quote) {
      cur += ch;
      if (ch === quote) {
        quote = undefined;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '&') {
      out.push(cur);
      cur = '';
      if (src[i + 1] === ch) {
        i += 1;
      }
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim()).filter((c) => c !== '');
}

/** One command's words, with quoting removed. */
function words(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let has = false;
  let quote: string | undefined;
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) {
        quote = undefined;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has) {
        out.push(cur);
        cur = '';
        has = false;
      }
      continue;
    }
    cur += ch;
    has = true;
  }
  if (has) {
    out.push(cur);
  }
  return out;
}

/** Expand `$NAME` / `${NAME}` against the job's own assignments, with `$PWD` standing for the
 *  working directory the job's `cd`s have established. */
function expandShell(value: string, vars: Map<string, string>, cwd: string): string {
  let out = value;
  for (let round = 0; round < 5; round += 1) {
    const next = out.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (whole, name: string) => {
      if (name === 'PWD') {
        return cwd;
      }
      return vars.has(name) ? (vars.get(name) as string) : whole;
    });
    if (next === out) {
      break;
    }
    out = next;
  }
  return out;
}

/** Resolve `p` against `cwd` and fold away `.` / `..`. A path opening with a VARIABLE is absolute:
 *  the variable names a directory, not something inside the current one. */
function resolvePath(p: string, cwd: string): string {
  const abs = p.startsWith('/') || p.startsWith('$') ? p : `${cwd}/${p}`;
  const rooted = abs.startsWith('/');
  const segs: string[] = [];
  for (const seg of abs.split('/')) {
    if (seg === '' || seg === '.') {
      continue;
    }
    if (seg === '..') {
      segs.pop();
      continue;
    }
    segs.push(seg);
  }
  return (rooted ? '/' : '') + segs.join('/');
}

/**
 * One path segment as the resolver compares it. Any variable in a segment becomes a WILDCARD,
 * because the gate does not know what it expands to on the runner and must not assume it is
 * something harmless.
 *
 * THIS INCLUDES THE RUNNER'S OWN DIRECTORY NAMES. `$HOME`, `$GITHUB_WORKSPACE`, `$RUNNER_TEMP` and
 * `$TMPDIR` are four names, not four established directories: which of them contains which is a
 * property of the runner, not of this text, and one routinely holds another. Reading them as
 * distinct would let a removal of one be cleared while it takes the installation inside another
 * with it, so where containment cannot be established the gate treats the paths as POSSIBLY
 * OVERLAPPING and refuses the removal.
 */
function comparable(seg: string): string {
  return seg.replace(/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/g, '*');
}

/** Could these two segments name the same thing? `*` (an unresolved expansion, or a glob) may be
 *  anything, so a wildcard on EITHER side is a match. */
function segMatch(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  const pattern = (s: string): RegExp =>
    new RegExp(
      `^${s
        .split('*')
        .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*')}$`,
    );
  return pattern(a).test(b) || pattern(b).test(a);
}

/** How a resolved deletion target stands to the installation, or undefined when it is elsewhere. */
function relationTo(
  target: string,
  install: string,
): 'the installation' | 'an ancestor of the installation' | 'inside the installation' | undefined {
  const t = target
    .split('/')
    .filter((s) => s !== '')
    .map(comparable);
  const i = install
    .split('/')
    .filter((s) => s !== '')
    .map(comparable);
  for (let n = 0; n < Math.min(t.length, i.length); n += 1) {
    if (!segMatch(t[n] as string, i[n] as string)) {
      return undefined;
    }
  }
  if (t.length === i.length) {
    return 'the installation';
  }
  return t.length < i.length ? 'an ancestor of the installation' : 'inside the installation';
}

/** One path a deletion command removes: where it was written, and what it resolves to. */
interface DeletionTarget {
  at: number;
  command: string;
  raw: string;
  resolved: string;
  /** set when the resolver cannot say what the path is — command substitution, `eval`, a value
   *  built at run time. An unresolvable deletion is a failure, never a pass. */
  unresolvable?: string;
}

/**
 * Every path the smoke-install job deletes, in order, resolved through the job's own assignments
 * and working directory. `rm`/`rmdir`/`unlink`/`shred` (recursive or not), `mv` away from a path,
 * `find … -delete` and `find … -exec rm`, and `npm rm|uninstall|remove` are read as deletions.
 */
function deletionTargets(text?: string): DeletionTarget[] {
  const state: ShellState = { vars: new Map(), literals: new Map(), cwd: JOB_CWD };
  const out: DeletionTarget[] = [];
  for (const { line, at } of shellLines('smoke-install', text)) {
    for (const command of commands(line)) {
      // Assignments and `cd`s move the state; anything else is read as a command, with any
      // environment prefix it was given stripped off first so `FOO=1 rm -rf …` is still a removal.
      if (applyToState(state, words(command))) {
        continue;
      }
      const { vars, cwd } = state;
      const w = withoutPrefixAssignments(words(command));
      const head = w[0] as string;
      const raws: string[] = [];
      if (head === 'xargs' && w.slice(1).some((a) => REMOVERS.has(a))) {
        // The paths arrive on stdin from an earlier stage this gate does not evaluate.
        out.push({
          at,
          command,
          raw: command,
          resolved: '',
          unresolvable: 'the paths come from stdin',
        });
        continue;
      }
      if (REMOVERS.has(head)) {
        raws.push(...operands(w.slice(1)));
        if (raws.length === 0) {
          out.push({
            at,
            command,
            raw: command,
            resolved: '',
            unresolvable: 'the removal names no target this gate can see',
          });
          continue;
        }
      } else if (head === 'mv') {
        // The destination is the last operand; every source is unlinked from where it stands.
        raws.push(...operands(w.slice(1)).slice(0, -1));
      } else if (head === 'find' && findDeletes(w)) {
        raws.push(...leadingOperands(w.slice(1)));
      } else if (head === 'npm' && NPM_REMOVE.has(w[1] ?? '')) {
        raws.push(...operands(w.slice(2)).map((pkg) => `${cwd}/node_modules/${pkg}`));
      } else if (head === 'eval') {
        out.push({
          at,
          command,
          raw: command,
          resolved: '',
          unresolvable: '`eval` builds its command at run time',
        });
        continue;
      } else {
        continue;
      }
      for (const raw of raws) {
        const expanded = expandShell(raw, vars, cwd);
        const substitution = /\$\(|`/.test(expanded);
        out.push({
          at,
          command,
          raw,
          resolved: resolvePath(expanded, cwd),
          ...(substitution ? { unresolvable: 'the path is a command substitution' } : {}),
        });
      }
    }
  }
  return out;
}

/** Operands of a command: flags dropped, everything after `--` taken literally. */
function operands(args: string[]): string[] {
  const out: string[] = [];
  let literal = false;
  for (const a of args) {
    if (!literal && a === '--') {
      literal = true;
      continue;
    }
    if (!literal && a.startsWith('-')) {
      continue;
    }
    out.push(a);
  }
  return out;
}

/** `find`'s starting points: the operands before its first predicate. */
function leadingOperands(args: string[]): string[] {
  const out: string[] = [];
  for (const a of args) {
    if (a.startsWith('-')) {
      break;
    }
    out.push(a);
  }
  return out;
}

/** Does this `find` delete what it walks? */
function findDeletes(w: string[]): boolean {
  if (w.includes('-delete')) {
    return true;
  }
  return w.some((a, n) => (a === '-exec' || a === '-execdir') && REMOVERS.has(w[n + 1] ?? ''));
}

/** Deletion targets that reach the installation, as reportable messages. */
function installationDeletions(text?: string): string[] {
  const install = resolvePath(smokeInstallDir(text).expanded, JOB_CWD);
  const out: string[] = [];
  for (const t of deletionTargets(text)) {
    if (t.unresolvable !== undefined) {
      continue;
    }
    const relation = relationTo(t.resolved, install);
    if (relation !== undefined) {
      out.push(`release.yml:${t.at}: \`${t.command}\` removes ${relation} (${t.resolved})`);
    }
  }
  return out;
}

/**
 * SAFETY: NO DELETION IN THE SMOKE JOB REACHES THE INSTALLATION, HOWEVER IT IS SPELLED.
 *
 * WHAT THIS GATE VERIFIES, EXACTLY. Reading the smoke-install job in order — applying its
 * assignments so that the LAST value assigned to a name before a use is the one that use sees,
 * treating an assignment written in front of a command as scoped to that command, following its
 * `cd`s, and expanding `$NAME`/`${NAME}`/`$PWD` — every operand of `rm`, `rmdir`, `unlink`, `shred`
 * (with or without a recursive flag), every source of an `mv`, every starting point of a
 * `find … -delete` or `find … -exec rm`, and every package of an `npm rm|uninstall|remove`
 * resolves to a path that is NOT the installation, NOT an ancestor of it, and NOT inside it.
 *
 * IT FAILS CLOSED ON EVERYTHING IT CANNOT ESTABLISH. A target it cannot resolve — a command
 * substitution, an `eval`, paths fed in on stdin (`… | xargs rm`), a removal with no visible
 * operand — FAILS the gate rather than passing it. A variable whose value the gate does not know is
 * a WILDCARD that MATCHES the installation rather than an assumption that it misses. That holds for
 * the runner's own directory names too: `$HOME`, `$GITHUB_WORKSPACE`, `$RUNNER_TEMP` and `$TMPDIR`
 * are names whose containment of one another is a property of the runner and not of this text, so a
 * removal of any of them is read as reaching the installation. The consequence is deliberate and is
 * the direction the gate errs in: a removal of an unrelated directory named only by a variable is
 * refused as well.
 *
 * WHAT IT DOES NOT VERIFY, and does not claim to. It reads text, not a shell: a deletion performed
 * by a program it does not model (`git clean`, `rsync --delete`, a `node -e` script, a Makefile),
 * one reached through a symlink, one hidden in a function or a sourced file, or one whose target
 * is assembled at run time, is outside what it can see. The gate is honest about that rather than
 * silent: what stands behind all of it is the RUNTIME check in the job itself — the installation
 * must still be there when the launchers are exercised (asserted in release.yml, and required by
 * the gate above) — which fails on the runner whatever removed it and however it was written.
 */
describe('safety: no deletion in the smoke job resolves to the pinned installation', () => {
  /** Indentation of the run-script lines, and a line every mutation can be injected after. */
  const INDENT = ' '.repeat(10);
  const ANCHOR = `${INDENT}npm cache clean --force\n`;

  /** The workflow with `lines` inserted into the smoke job's run script. */
  function withInjected(...lines: string[]): string {
    const wf = workflow();
    expect(wf, 'the smoke job no longer prunes the npm cache — the anchor is gone').toContain(
      ANCHOR,
    );
    return wf.replace(ANCHOR, ANCHOR + lines.map((l) => `${INDENT}${l}\n`).join(''));
  }

  it('the job really does delete things, and each one resolves — an empty scan proves nothing', () => {
    const targets = deletionTargets();
    expect(
      targets.length,
      'no deletion command was found in the smoke job at all — the scan is looking at the wrong text',
    ).toBeGreaterThan(0);
    for (const t of targets) {
      expect(
        t.unresolvable,
        `release.yml:${t.at}: \`${t.command}\` deletes a path this gate cannot resolve (${t.unresolvable}) — an unresolvable deletion is refused, not trusted`,
      ).toBeUndefined();
    }
    // the tarball removal the job legitimately performs, resolved and cleared
    expect(targets.map((t) => t.resolved)).toContain('$GITHUB_WORKSPACE/sthayi-${VERSION}.tgz');
  });

  it('no deletion targets the installation, an ancestor of it, or anything inside it', () => {
    expect(installationDeletions()).toEqual([]);
  });

  /**
   * Each mutation deletes the installation while spelling it differently from
   * `rm -rf "$SMOKE_INSTALL_DIR"`. Every one of them passes a gate that only looks for the
   * variable's name in the line.
   */
  const MUTATIONS: { what: string; lines: string[] }[] = [
    {
      what: 'the literal path the install variable was assigned',
      lines: ['rm -rf "$GITHUB_WORKSPACE/sthayi-smoke-install"'],
    },
    {
      what: 'a relative target after a cd into the installation',
      lines: ['cd "$SMOKE_INSTALL_DIR"', 'rm -rf node_modules'],
    },
    {
      what: 'a relative target after a cd on the SAME line',
      lines: ['cd "$SMOKE_INSTALL_DIR"; rm -rf node_modules'],
    },
    {
      what: 'an alias variable holding the installation directory',
      lines: ['X="$SMOKE_INSTALL_DIR"', 'rm -rf "$X"'],
    },
    {
      what: 'an alias variable assigned and used on the SAME line',
      lines: ['X="$SMOKE_INSTALL_DIR"; rm -rf "$X"'],
    },
    {
      what: 'a NON-recursive removal of the pinned entry point',
      lines: ['rm "$SMOKE_INSTALL_DIR/node_modules/sthayi/dist/index.js"'],
    },
    {
      what: 'a structural deletion by find',
      lines: [`find "$SMOKE_INSTALL_DIR" -name '*.js' -delete`],
    },
    {
      what: 'a structural deletion by find -exec rm',
      lines: ['find "$SMOKE_INSTALL_DIR" -type f -exec rm -f {} +'],
    },
    {
      what: 'an npm uninstall of the package from inside the installation',
      lines: ['cd "$SMOKE_INSTALL_DIR"', 'npm uninstall sthayi'],
    },
    {
      what: 'a glob that expands onto the installation',
      lines: ['rm -rf "$GITHUB_WORKSPACE"/sthayi-smoke-*'],
    },
    {
      what: 'a move of the installation out from under the launchers',
      lines: ['mv "$SMOKE_INSTALL_DIR" "$GITHUB_WORKSPACE/parked"'],
    },
    {
      what: 'a removal of the directory the installation sits in',
      lines: ['rm -rf "$GITHUB_WORKSPACE"'],
    },
    {
      what: 'a removal of $HOME, which may be an ancestor of the checkout the install sits in',
      lines: ['rm -rf "$HOME"'],
    },
    {
      what: 'a removal of $RUNNER_TEMP, whose containment of the install cannot be established',
      lines: ['rm -rf "$RUNNER_TEMP"'],
    },
    {
      what: 'an alias REASSIGNED to the installation after holding something else',
      lines: ['X=safe', 'X="$SMOKE_INSTALL_DIR"', 'rm -rf "$X"'],
    },
    {
      // The same reassignment, from a first value that resolves to a NAMED sibling directory the
      // resolver can positively clear. Only the last write reaches the installation, so this one
      // is caught by reading the assignments in order and by nothing else.
      what: 'an alias REASSIGNED from a sibling the resolver clears to the installation',
      lines: ['X="$GITHUB_WORKSPACE/sthayi-smoke-logs"', 'X="$SMOKE_INSTALL_DIR"', 'rm -rf "$X"'],
    },
    {
      what: 'a removal carrying an environment prefix in front of the command',
      lines: ['LC_ALL=C rm -rf "$SMOKE_INSTALL_DIR"'],
    },
  ];

  for (const { what, lines } of MUTATIONS) {
    it(`catches ${what}`, () => {
      const hits = installationDeletions(withInjected(...lines));
      expect(
        hits,
        `a deletion written as ${JSON.stringify(lines.join(' '))} is not caught — the gate's claim is wider than what it verifies`,
      ).not.toEqual([]);
    });
  }

  for (const [what, line] of [
    ['a command substitution', 'rm -rf "$(cat /var/where)"'],
    ['paths fed in on stdin', 'find "$SMOKE_INSTALL_DIR" -type f | xargs rm -f'],
    ['a command built at run time', 'eval "$TEARDOWN"'],
  ] as const) {
    it(`refuses, rather than passes, a deletion whose target it cannot resolve: ${what}`, () => {
      const targets = deletionTargets(withInjected(line));
      expect(
        targets.some((t) => t.unresolvable !== undefined),
        `${JSON.stringify(line)} is read as resolvable — an unresolvable deletion must fail the gate, not slip through it`,
      ).toBe(true);
    });
  }

  it('reads an environment prefix as scoped to its command, not as a reassignment', () => {
    // `SAFE_DIR=… printf` sets the environment of `printf` alone; the shell's own `SAFE_DIR` is
    // still the sibling directory it was assigned. Reading the prefix as a reassignment would put
    // the installation behind `$SAFE_DIR` and flag a removal that never touches it.
    expect(
      installationDeletions(
        withInjected(
          'SAFE_DIR="$GITHUB_WORKSPACE/sthayi-smoke-logs"',
          'SAFE_DIR="$SMOKE_INSTALL_DIR" printf ok',
          'rm -rf "$SAFE_DIR"',
        ),
      ),
    ).toEqual([]);
  });

  it('does not flag a deletion that stands beside the installation rather than in it', () => {
    // Two siblings under the same durable base: a name the installation's is a PREFIX of, and a
    // file the job itself wrote there. Neither is the installation, and neither is inside it.
    expect(
      installationDeletions(
        withInjected(
          'rm -rf "$GITHUB_WORKSPACE/sthayi-smoke-installer-logs"',
          'rm -f "$CHECK_SCRIPT"',
        ),
      ),
    ).toEqual([]);
  });
});

describe('safety: the release workflow claims no runtime copy', () => {
  /**
   * The removed capability, in the phrasings it wore. `~/.sthayi/runtime/` is never created, so a
   * workflow comment or assertion saying `init` produced a runtime describes something that cannot
   * happen — and a gate written against it can only be passing for the wrong reason.
   */
  const RUNTIME_COPY_CLAIMS: RegExp[] = [
    /\binit\b[^\n]*\bcopie[ds]\b/i,
    /\bcopie[ds]\b[^\n]*\bruntime\b/i,
    /\bruntime\b[^\n]*\bcopie[ds]\b/i,
    /\bruntime copy\b/i,
    /\bdurable runtime\b/i,
    /\bstage[ds]?\b[^\n]*\bruntime\b/i,
  ];

  /**
   * A line that DENIES the capability is the correct thing to write, and it necessarily uses the
   * same nouns. Only affirmative lines are claims.
   */
  function denies(line: string): boolean {
    return /\b(no|not|never|neither|nothing|none|refus\w*|doesn't|don't)\b/i.test(line);
  }

  /** The first line of `text` that affirms a runtime copy, if any. */
  function runtimeCopyClaim(text: string): string | undefined {
    return text
      .split('\n')
      .find((line) => !denies(line) && RUNTIME_COPY_CLAIMS.some((re) => re.test(line)));
  }

  it('flags a comment that credits `init` with a durable runtime — the matcher is load-bearing', () => {
    // The shape of comment the matcher must refuse: it says `init` produced a runtime under the
    // home, which is the only way a teardown that deletes the installation could ever hold.
    expect(
      runtimeCopyClaim(
        '# `init` above copied a durable runtime under $SMOKE_HOME/.sthayi and wrote the two\n' +
          '# launchers. Honesty check: they must keep working with the temporary npm install AND\n' +
          '# the npm cache gone — the durable runtime is the thing the README promises survives\n' +
          '# cache pruning, and this is the only gate that proves it on a real install.',
      ),
    ).toContain('copied a durable runtime');
    expect(runtimeCopyClaim('# the runtime copy is refreshed on upgrade')).toContain(
      'runtime copy',
    );
    // …while the denial the workflow legitimately carries is not a claim.
    expect(runtimeCopyClaim('# sthayi copies no runtime into the home')).toBeUndefined();
  });

  it('no comment or step in the workflow says a runtime was copied into the home', () => {
    const hit = runtimeCopyClaim(workflow());
    expect(
      hit,
      `.github/workflows/release.yml claims a runtime copy: ${hit}
The capability was removed, not hardened — nothing is ever written under ~/.sthayi/runtime/.`,
    ).toBeUndefined();
  });

  it('the workflow mentions ~/.sthayi/runtime only to refuse it', () => {
    const lines = workflow()
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => !l.startsWith('#'));
    for (const line of lines) {
      if (!/\.sthayi\/runtime/.test(line)) {
        continue;
      }
      // Legitimate mentions: an existence test that leads to a refusal, or the refusal itself.
      expect(
        /\[\s*!?\s*-e\s/.test(line) || line.includes('::error::'),
        `release.yml treats ~/.sthayi/runtime as something that should exist: ${line}`,
      ).toBe(true);
    }
  });
});

describe('safety: the release workflow onboarding matches the shipped contract', () => {
  it('the workflow never onboards through npx', () => {
    const lines = workflow()
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => !l.startsWith('#'));
    for (const line of lines) {
      expect(
        /\bnpx\s+sthayi\b/.test(line),
        `release.yml runs sthayi through npx: ${line}
\`npx sthayi init\` is refused — onboarding is a durable install, then \`sthayi init\`.`,
      ).toBe(false);
    }
  });
});

describe('safety: release publishing is token-free and pinned to npm trusted publishing', () => {
  const publishJob = (): string =>
    jobBlock('publish')
      .map(({ line }) => line)
      .join('\n');

  it('uses the protected environment, OIDC, and a pinned trusted-publishing-capable npm CLI', () => {
    const text = publishJob();
    expect(text).toContain('name: npm-production');
    expect(text).toContain('id-token: write');
    expect(text).toContain(
      'npm install --global --ignore-scripts --no-audit --no-fund npm@11.11.0',
    );
    expect(text).toContain('test "$(npm --version)" = "11.11.0"');
    expect(text).toMatch(/npm publish "\$TARBALL" --provenance --access public/);
  });

  it('carries no reusable npm publish credential', () => {
    expect(publishJob()).not.toMatch(/\b(?:NODE_AUTH_TOKEN|NPM_TOKEN)\b/);
  });
});
