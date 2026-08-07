import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COMMANDS } from '../../packages/cli/src/index.js';
import { removeForeignTree } from '../helpers/foreign-tree.js';

/**
 * SAFETY: the keyless matrix must also hold for the ARTIFACT PEOPLE INSTALL, not only for a build
 * made out of the source tree.
 *
 * WHY A SECOND LAYER EXISTS AT ALL. Three things claim to prove "keyless", and they prove
 * different things:
 *
 *   1. tests/safety/keyless-matrix.test.ts spawns `packages/cli/dist/index.js` — the whole command
 *      surface, scrubbed environment. It is the deepest of the three, and it is structurally blind
 *      to one entire class of release defect: anything the PACKAGE does not ship. `dist/` and
 *      `prompts/` are in `files`; a new asset that is not is present on every developer's disk and
 *      absent from every user's install, and this layer cannot tell.
 *   2. Dockerfile.freshtest runs SIX commands on a clean machine. That is a FRESH-INSTALL SMOKE
 *      SUBSET and this file requires it to be called one — the spec's keyless matrix is every
 *      registered command bar the two provider-dependent ones, and eleven of them are not in the
 *      container. Six commands announced as "the keyless matrix" tells a reader a fresh machine
 *      ran eleven commands it never ran.
 *   3. THE STEP THIS FILE GATES: the release workflow's `Packaged keyless matrix`, which runs the
 *      whole surface against the npm-INSTALLED tarball. It is the only layer where "keyless" and
 *      "shipped" are asserted about the same bytes.
 *
 * WHAT IS PROVED HERE, AND HOW. The release step cannot be run on this machine — it needs a real
 * npm install of a real release artifact — so this file settles offline everything that CAN be
 * settled offline, against the step taken byte-for-byte off disk:
 *   - COVERAGE, against the CLI's own registered command list. Adding a command to
 *     packages/cli/src/index.ts fails this file until the release step exercises it.
 *   - OUTCOMES, against the source-driven twin. Every command has to be pinned to the RESULT it
 *     produces, and the two layers have to agree on what that result is.
 *   - BEHAVIOUR, by EXECUTING the step's shell against a stateful stand-in CLI: that it invokes
 *     every command it claims to, that a single failing command fails the release, that a command
 *     which answers `ok` and does nothing fails the release, that a no-op dry run, an unmasked
 *     secret, a broken journal chain, a hang, an inherited environment and an inherited working
 *     directory each fail the release, and that deleting an invocation is caught rather than
 *     silently reducing coverage.
 *
 * No network, no npm install, no Docker daemon: the stand-in CLI is a shell script.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflowText = (): string =>
  fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8');

/** The commands the release step must exercise: every registered command, without exception. */
const REGISTERED = COMMANDS.map((c) => c.name).sort();

/**
 * WHAT A CORRECT COMMAND PRODUCES — the outcome the release step must find, per command. Every
 * phrase is required in BOTH the step and tests/safety/keyless-matrix.test.ts, so the two layers
 * cannot drift into disagreeing about what "working" means. Alignment is about expectations only:
 * one layer drives a build made out of the working tree and the other an npm installation of the
 * packed artifact, and neither is evidence for the other's bytes.
 */
const OUTCOME_PHRASES: Record<string, string[]> = {
  init: ['Dry run — would initialize', 'create db', 'create launcher'],
  add: ['added proposed', 'added confirmed'],
  search: ['duplicate'],
  review: ['proposal'],
  import: ['Imported'],
  consolidate: ['Deterministic: ', 'archived'],
  journal: ['journal OK'],
  rollback: ['Rolled back #', 'chain intact: true'],
  index: ['association graph: ', 'association graph rebuilt from the journal: '],
  pack: ['Wrote masked memory pack'],
  entities: ['APIKEY_01'],
  status: ['client'],
  wire: ['No detected clients'],
  unwire: ['Dry run'],
  doctor: ['All checks passed'],
};

/**
 * The two commands whose outcome is not a line of output: `serve` is proved by staying up and by
 * staying silent on stdout, `qualify` by refusing and naming its variable.
 */
const OUTCOME_ASSERTED_ELSEWHERE = ['serve', 'qualify'];

/** The two documented key-requiring cases, and the variable each must name when it refuses. */
const KEY_REQUIRED: Record<string, string> = {
  'consolidate --oracle': 'ANTHROPIC_API_KEY',
  qualify: 'OPENAI_API_KEY',
};

/**
 * The `run:` body of the packaged-matrix step, dedented out of the workflow. Empty when the step is
 * not there, so a rename fails these assertions instead of vacating them.
 */
function packagedMatrixStep(text: string = workflowText()): string {
  const lines = text.split('\n');
  const nameAt = lines.findIndex((l) => /^\s*- name: Packaged keyless matrix\b/.test(l));
  if (nameAt === -1) return '';
  const runAt = lines.findIndex((l, i) => i > nameAt && /^\s*run: \|\s*$/.test(l));
  if (runAt === -1) return '';
  const indent = (lines[runAt] as string).search(/\S/);
  const body: string[] = [];
  for (let i = runAt + 1; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (line.trim() !== '' && line.search(/\S/) <= indent) break;
    body.push(line.slice(indent + 2));
  }
  return `${body.join('\n')}\n`;
}

/** Executable shell lines only — a comment naming a command is not an invocation of it. */
const stepLines = (text: string = packagedMatrixStep()): string[] =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));

/** The coverage ledger the step declares, as a set of command names. */
function declaredLedger(text: string = packagedMatrixStep()): string[] {
  const line = stepLines(text).find((l) => l.startsWith('PACKAGED_MATRIX_COMMANDS='));
  if (line === undefined) return [];
  return (line.match(/="([^"]*)"/)?.[1] ?? '').trim().split(/\s+/).filter(Boolean).sort();
}

describe('the release runs the full keyless matrix against the INSTALLED tarball', () => {
  it('is still a step in the smoke-install job, driven from the installed binary', () => {
    const step = packagedMatrixStep();
    expect(step, 'no `Packaged keyless matrix` step in .github/workflows/release.yml').not.toBe('');

    // THE ARTIFACT UNDER TEST IS THE INSTALLATION, and the workflow has to say so: the whole point
    // of this layer is that it is NOT a source build.
    expect(step, 'the step never binds to the installed CLI').toMatch(/BIN="\$\{PACKAGED_BIN:-\}"/);
    expect(
      workflowText(),
      'the install step never hands the installed binary to the packaged matrix',
    ).toMatch(/echo "PACKAGED_BIN=\$BIN" >> "\$GITHUB_ENV"/);
    expect(
      step,
      'a missing installed binary is not a refusal — the matrix would silently prove nothing',
    ).toMatch(/if\s+\[\s+!\s+-x\s+"\$BIN"\s+\]/);

    // ...and it must never fall back to anything built from source on the runner.
    for (const source of ['packages/cli/dist', 'pnpm ', 'tsx ', 'node_modules/.bin/sthayi']) {
      expect(
        step.includes(source),
        `the packaged matrix reaches a source build via '${source}' — it would stop testing the package`,
      ).toBe(false);
    }
  });

  it('covers EVERY registered command — the ledger is the CLI command list', () => {
    // The self-enforcement this layer needs: a command added to the CLI is absent from the shipped
    // matrix until someone adds it here, and that absence fails the ordinary test suite.
    const ledger = declaredLedger();
    expect(ledger, 'the packaged matrix declares no coverage ledger').not.toEqual([]);
    expect(
      ledger,
      `the packaged keyless matrix does not cover the registered command surface — missing: ${REGISTERED.filter(
        (c) => !ledger.includes(c),
      ).join(', ')}; unknown: ${ledger.filter((c) => !REGISTERED.includes(c)).join(', ')}`,
    ).toEqual(REGISTERED);
  });

  it('actually invokes each ledger command, and re-checks that at run time', () => {
    const step = packagedMatrixStep();
    const lines = stepLines(step);
    for (const name of declaredLedger()) {
      const invoked = lines.some((l) =>
        new RegExp(`^(keyless |expect_key_required [A-Z_]+ |printf '%s\\\\n' )${name}\\b`).test(l),
      );
      expect(invoked, `'${name}' is in the coverage ledger but never invoked in the step`).toBe(
        true,
      );
    }
    // A ledger is a comment unless something compares it to what ran. This is the line that makes
    // deleting an invocation a release failure rather than a quiet reduction in coverage.
    expect(step, 'the ledger is never checked against the invocations that happened').toMatch(
      /for\s+c\s+in\s+\$PACKAGED_MATRIX_COMMANDS/,
    );
    expect(step, 'an unexercised ledger entry does not fail the release').toMatch(
      /grep\s+-qxF\s+"\$c"\s+"\$MATRIX_INVOKED"[\s\S]{0,200}exit\s+1/,
    );
  });

  it('asserts an OUTCOME for every command, not just an exit code', () => {
    // WHY THIS IS THE LOAD-BEARING ONE. A CLI that printed `ok` and exited 0 for every command
    // would satisfy an invocation-only gate completely — the ledger would be full, every exit
    // status would be zero, and the release would ship an artifact that does nothing. Each
    // command therefore has to be pinned to the result it produces.
    const step = packagedMatrixStep();
    for (const [name, phrases] of Object.entries(OUTCOME_PHRASES)) {
      for (const phrase of phrases) {
        expect(
          step.includes(phrase),
          `'${name}' is invoked but its outcome is never checked — the step never looks for "${phrase}"`,
        ).toBe(true);
      }
    }
    // Self-enforcement: a new command cannot be added to the ledger with an invocation alone.
    for (const name of declaredLedger()) {
      if (OUTCOME_ASSERTED_ELSEWHERE.includes(name)) continue;
      expect(
        OUTCOME_PHRASES[name],
        `'${name}' has no outcome to assert — add one, or say why it is proved another way`,
      ).toBeTruthy();
    }
    // Results are not the only outcome: two of these commands are defined by what they do NOT do.
    expect(step, 'a dry run that writes to the home is not caught').toMatch(
      /expect_home_unchanged/,
    );
    // The pack is opened, not taken on its word, and the canary must not be in it.
    expect(step, 'the memory pack file is never opened').toMatch(/! -f "\$PACK_FILE"/);
    expect(step, 'the memory pack is never checked for the unmasked secret').toMatch(
      /grep -qF -- "\$MATRIX_CANARY" "\$PACK_FILE"/,
    );
    // Rollback is proved by its effect on the journal, not by its own success line.
    expect(step, 'rollback is believed on its own report').toMatch(
      /JOURNAL_AFTER" -le "\$JOURNAL_BEFORE/,
    );
  });

  it('never lets pipefail turn a successful short-circuiting output match into a miss', () => {
    const step = packagedMatrixStep();
    // With `set -o pipefail`, `producer | grep -q` can be nonzero after a real match because grep
    // closes its input and the producer receives SIGPIPE. That once made CI say `proposal` was
    // absent while printing the matching `1 proposal(s) queued` line in the same failure. It is
    // worse for the canary check: the same false miss could accept output containing a secret.
    expect(
      step,
      'expect_out still feeds short-circuiting grep from a pipe, so a real match can look absent',
    ).toMatch(/if ! grep -Eq -- "\$1" "\$MATRIX_OUT_FILE"/);
    expect(
      step,
      'refute_canary still feeds short-circuiting grep from a pipe, so a present secret can look absent',
    ).toMatch(/if grep -qF -- "\$MATRIX_CANARY" "\$MATRIX_OUT_FILE"/);
    expect(
      step,
      'captured command output still reaches a short-circuiting grep through a pipe',
    ).not.toMatch(/printf[^\n]*\$MATRIX_OUT[^\n]*\|\s*grep\s+-[^\n]*q/);
  });

  it('stays aligned with the source-driven twin on WHAT a correct command produces', () => {
    // The two layers must agree about outcomes or the packaged one drifts into a weaker gate.
    // This is alignment of EXPECTATIONS ONLY: the source matrix drives a build made out of the
    // working tree and this step drives an npm installation of the packed artifact, so neither
    // vouches for the other's bytes and nothing here claims a shared provenance.
    const twin = fs.readFileSync(
      path.join(repoRoot, 'tests', 'safety', 'keyless-matrix.test.ts'),
      'utf8',
    );
    for (const [name, phrases] of Object.entries(OUTCOME_PHRASES)) {
      for (const phrase of phrases) {
        expect(
          twin.includes(phrase),
          `the packaged matrix expects "${phrase}" from '${name}' and the source-driven matrix does not — the two layers have drifted`,
        ).toBe(true);
      }
    }
  });

  it('is keyless by construction: the child environment is BUILT, not filtered', () => {
    const step = packagedMatrixStep();
    // An environment scrubbed by naming variables is only as good as the list. `env -i` makes the
    // child's environment a closed set, so a provider redirect, token or HOME locator nobody
    // thought of cannot arrive by omission.
    expect(step, 'the installed CLI is not launched with an empty base environment').toMatch(
      /exec env -i\b/,
    );
    // ...and every locator the CLI can consult is given an isolated value inside this run's home.
    for (const v of ['PATH', 'HOME', 'STHAYI_HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
      expect(step, `${v} is not set explicitly for the packaged matrix child`).toMatch(
        new RegExp(`\\n\\s*${v}="\\$`),
      );
    }
    expect(
      step,
      'XDG_CONFIG_HOME is not isolated — client discovery can reach the machine',
    ).toMatch(/XDG_CONFIG_HOME="\$MATRIX_HOME/);
    // A fresh HOME, so this is zero-config rather than a continuation of the smoke step's state.
    expect(step, 'the packaged matrix reuses the smoke step home').toMatch(
      /MATRIX_HOME="\$\(mktemp\s+-d\)"/,
    );
    // The keyless invariant itself: no command may ask for an env var.
    expect(step, 'a command that asks for an env var is not treated as a failure').toMatch(
      /\*"is not set"\*\)/,
    );
  });

  it('runs from a NEUTRAL directory, never the checkout it was launched in', () => {
    const step = packagedMatrixStep();
    expect(step, 'the packaged matrix allocates no neutral working directory').toMatch(
      /MATRIX_CWD="\$\(mktemp\s+-d\)"/,
    );
    expect(step, 'the installed CLI is not launched from the neutral directory').toMatch(
      /cd "\$MATRIX_CWD" &&\s*exec env -i/,
    );
  });

  it('bounds every invocation, and tells a timeout apart from an ordinary failure', () => {
    const step = packagedMatrixStep();
    expect(step, 'the packaged matrix declares no per-command bound').toMatch(
      /MATRIX_CMD_TIMEOUT="\$\{MATRIX_CMD_TIMEOUT:-[0-9]+\}"/,
    );
    // An unbounded bound is not one: the step refuses a value it could not survive.
    expect(step, 'the per-command bound is not itself bounded').toMatch(
      /MATRIX_CMD_TIMEOUT" -gt [0-9]+/,
    );
    // Every command goes through the watchdog — a helper that exists but is bypassed proves
    // nothing, so the two runners are required to use it.
    for (const helper of ['keyless', 'expect_key_required']) {
      const body = step.slice(step.indexOf(`${helper}() {`));
      expect(
        body.slice(0, 600),
        `${helper} runs the installed CLI unbounded — a wedged command would hold the job`,
      ).toMatch(/bounded run_packaged "\$@"/);
    }
    // A timeout is a FACT ON DISK, so a hang can never be reported as an ordinary nonzero exit.
    expect(step, 'nothing records that the bound expired').toMatch(/: > "\$MATRIX_TIMEOUT_FLAG"/);
    expect(step, 'a timeout is not distinguished from an ordinary failure').toMatch(
      /timed_out\(\) \{ \[ -f "\$MATRIX_TIMEOUT_FLAG" \]; \}/,
    );
    for (const helper of ['keyless', 'expect_key_required']) {
      const body = step.slice(step.indexOf(`${helper}() {`));
      expect(body.slice(0, 900), `${helper} does not report a timeout as a timeout`).toMatch(
        /timed_out;? then/,
      );
      // AND THE MARKER IS FATAL ON ITS OWN. Consulting it only when the exit status is nonzero
      // hands the verdict to the process being judged: a CLI that catches the retirement signal
      // and returns 0 — or a wrapper that returns 0 after its own child was killed — then reads
      // exactly like a command that finished, and a wedge ships.
      expect(
        body.slice(0, 1200),
        `${helper} only consults the timeout marker when the exit status is nonzero`,
      ).not.toMatch(/-ne 0 \][^\n]*timed_out/);
    }
    // And a backstop on the job, so a wedge with no bound of its own still ends.
    expect(workflowText(), 'the smoke-install job has no timeout-minutes backstop').toMatch(
      /name: smoke-install[\s\S]{0,600}?timeout-minutes: [0-9]+/,
    );
  });

  it('retires the PROCESS GROUP, not the wrapper shell whose pid it happens to hold', () => {
    // `cmd &` starts a shell that execs the installed CLI, so `$!` names a wrapper and the CLI is
    // its descendant. A `kill "$pid"` retires the wrapper and leaves the CLI — and anything the
    // CLI started — running inside the job, holding this run's home and writing into the file the
    // next command is judged by. Monitor mode gives the job a process group of its own so the
    // signals below can name the whole tree.
    const step = packagedMatrixStep();
    expect(step, 'the bounded job is not given a process group of its own').toMatch(
      /set -m\s*\n\s*"\$@" &\s*\n\s*MATRIX_CMD_PID=\$!/,
    );
    expect(step, '`serve` is not given a process group of its own').toMatch(
      /set -m\s*\n\s*run_packaged serve[^\n]*&\s*\n\s*SERVE_PID=\$!/,
    );
    for (const signal of ['TERM', 'KILL']) {
      expect(
        step,
        `the watchdog sends ${signal} to one pid rather than to the job's group`,
      ).toMatch(new RegExp(`kill -${signal} "-\\$MATRIX_CMD_PID"`));
    }
    expect(step, '`serve` is signalled by pid, so the server it execs survives').toMatch(
      /kill -TERM "-\$SERVE_PID"/,
    );
    // ...and the sweep is PROVED, so a survivor is a failure rather than a process nobody looked
    // for. `kill -0` on the group is how "nothing is left in it" is read.
    expect(step, 'nothing checks whether the group is actually gone').toMatch(
      /group_retired\(\) \{[\s\S]{0,400}kill -0 "-\$1"/,
    );
    for (const pid of ['MATRIX_CMD_PID', 'SERVE_PID']) {
      expect(step, `the group behind $${pid} is never proved retired`).toMatch(
        new RegExp(`group_retired "\\$${pid}"`),
      );
    }
  });

  it('keeps stdin open while it observes the stdio MCP server', () => {
    // A headless Actions background job receives EOF unless the harness owns a live input. EOF is
    // a valid MCP client disconnect, not a server crash. The stand-in below models that contract,
    // making this wiring load-bearing in the executable healthy-CLI test as well as here.
    const step = packagedMatrixStep();
    expect(step, '`serve` has no client-owned stdin FIFO').toMatch(
      /SERVE_STDIN="\$MATRIX_SCRATCH\/serve\.stdin"[\s\S]{0,200}mkfifo "\$SERVE_STDIN"/,
    );
    expect(step, 'the FIFO is not held open read/write for the observation').toMatch(
      /exec 9<>"\$SERVE_STDIN"/,
    );
    expect(step, '`serve` still inherits the headless runner EOF').toMatch(
      /run_packaged serve <&9[^\n]*&/,
    );
    expect(step, 'the stdin descriptor is not closed after retirement').toMatch(/exec 9>&-/);
  });

  it('asks the STORE for the imported fact, and the fact is one only the export can supply', () => {
    // The reading that separates an ingest from a sentence about one. It is worth nothing unless
    // the fact really is in the fixture the release imports, and really is absent from everything
    // the step writes itself — both of which are checked here rather than assumed.
    const step = packagedMatrixStep();
    const declared = step.match(/MATRIX_IMPORT_FACT='([^']*)'/)?.[1];
    expect(declared, 'the step names no imported fact to ask the store for').toBeTruthy();
    const fact = declared as string;
    expect(fact, 'the step and this file disagree about the imported fact').toBe(IMPORT_FACT);

    const fixtureDir = path.join(repoRoot, 'tests', 'fixtures', 'imports', 'claude');
    const fixtureText = fs
      .readdirSync(fixtureDir)
      .map((f) => fs.readFileSync(path.join(fixtureDir, f), 'utf8'))
      .join('\n');
    expect(
      fixtureText.includes(fact),
      `the step asks the store for '${fact}', which is not in the export fixture the release imports`,
    ).toBe(true);

    // Nothing the step ADDS may contain it, or the reading would pass with `import` doing nothing.
    const beforeImport = step.slice(0, step.indexOf('keyless import'));
    const written = stepLines(beforeImport).filter((l) => l.startsWith('keyless add'));
    for (const line of written) {
      expect(
        line.includes(fact),
        `the step writes '${fact}' itself before importing — the import reading proves nothing`,
      ).toBe(false);
    }
    // ...and it is asked for AFTER the import, not before.
    expect(step.indexOf('MATRIX_IMPORT_FACT"'), 'the fact is never asked for').toBeGreaterThan(
      step.indexOf('keyless import'),
    );
  });

  it('reads duplicate STATE around the fold and the rollback, not the counts they print', () => {
    const step = packagedMatrixStep();
    expect(step, 'the step never counts the live copies of anything').toMatch(/live_copies\(\) \{/);
    // 2 before the fold, 1 after it, 2 again after the rollback — the three readings that make
    // `→ 1 archived` and `reverted 1 change(s)` claims about the store rather than about text.
    const wanted = stepLines(step)
      .filter((l) => l.startsWith('expect_live_copies '))
      .map((l) => l.split(' ')[1]);
    expect(wanted, 'the fold and the rollback are not held to a live-copy count').toEqual([
      '2',
      '1',
      '2',
    ]);
    // The pack is READ, not merely opened: nonempty, carrying a confirmed memory, carrying the
    // canary memory in its masked form, and not carrying the secret.
    expect(step, 'an empty pack is accepted').toMatch(/! -s "\$PACK_FILE"/);
    expect(step, 'a pack holding none of the memories is accepted').toMatch(
      /! grep -qF -- "\$MATRIX_DUPLICATE" "\$PACK_FILE"/,
    );
    expect(step, "the canary memory's masked form is never required in the pack").toMatch(
      /! grep -qF -- 'ci canary APIKEY_01' "\$PACK_FILE"/,
    );
  });

  it('holds the two provider-dependent commands to a FAST, NAMED refusal', () => {
    const step = packagedMatrixStep();
    for (const [invocation, variable] of Object.entries(KEY_REQUIRED)) {
      expect(
        step,
        `'${invocation}' is not exercised as a documented key-requiring exception`,
      ).toMatch(new RegExp(`expect_key_required ${variable} ${invocation.split(' ')[0]}\\b`));
    }
    expect(step, 'an oracle command that succeeds without a key is accepted').toMatch(
      /if\s+\[\s+"\$rc"\s+-eq\s+0\s+\][\s\S]{0,220}exit\s+1/,
    );
    expect(step, 'a refusal that never names the variable is accepted').toMatch(
      /\*"\$var is not set"\*\)/,
    );
  });

  it('the Docker layer is named a SUBSET, and this layer is what carries the matrix claim', () => {
    const dockerfile = fs.readFileSync(path.join(repoRoot, 'Dockerfile.freshtest'), 'utf8');
    const entrypoint = dockerfile
      .split('\n')
      .filter((l) => /^ENTRYPOINT|^CMD/.test(l))
      .join('\n');
    expect(entrypoint, 'Dockerfile.freshtest declares no ENTRYPOINT').not.toBe('');
    expect(
      entrypoint,
      'the six-command container still calls itself the keyless matrix — it covers six of the registered commands',
    ).not.toMatch(/keyless matrix/i);
    // And the honest name only stays honest while the fuller claim is made somewhere real.
    expect(packagedMatrixStep(), 'nothing runs the full matrix on the packaged artifact').not.toBe(
      '',
    );
  });
});

// ===============================================================================================
// THE EXECUTING HALF.
//
// Coverage can be read off the text; FAILING CLOSED cannot. The step is run byte-for-byte against a
// fake installed CLI — a shell script that answers like the real one — so that "a failing command
// fails the release" is demonstrated rather than asserted. Nothing here installs anything, contacts
// a registry, or starts a daemon.
//
// IT IS ALSO POSIX-ONLY, AND SAYS SO. What it executes is the release step's own shell, verbatim:
// `bash -e`, `set -m` job control, `kill -- -$pgid` against a negative process-group id, `env -i`,
// `trap`. Those are the mechanisms the step is BUILT ON — a Windows-shaped variant would be a
// different step, and passing it would be evidence about a script the release never runs. The
// release runs on ubuntu-latest and the freshtest container is Linux, so Ubuntu and macOS remain
// fully load-bearing here; on win32 the executing half is skipped rather than approximated. The
// STATIC half above stays cross-platform: it reads the shipped workflow as text, and a Windows CI
// leg still holds coverage, outcome alignment, hermeticity and the timeout discipline to account.
// ===============================================================================================

/** The executing half only. Static workflow assertions must never be gated on this. */
const describePosix = describe.skipIf(process.platform === 'win32');

interface RunResult {
  code: number;
  out: string;
}

const scratchDir = (prefix = 'packaged-matrix-'): string =>
  fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));

/**
 * BOTH roots go. The harness allocates two of them — the checkout stand-in and the ambient temp
 * root the step is given — and they are deliberately SIBLINGS rather than nested, so removing one
 * would leave the other behind. Each is an exact path this file created; neither is a pattern
 * matched against a shared temp root.
 *
 * NO RECURSIVE PRIMITIVE. `fs.rmSync(root, { recursive: true, force: true })` decides its whole
 * walk inside the call, from a name, long after the last check made here — and this function runs
 * after a REAL `bash` step has been executing inside those roots, which is exactly the situation in
 * which the name may no longer be the directory that was allocated. `removeForeignTree` re-decides
 * every entry: it never follows a symlink, never leaves the root's device, is depth-bounded, and
 * leaks rather than escalates. `removeOwned()` is not usable here for the opposite reason — the
 * entries inside were written by a child process this one never witnessed, so nothing in the
 * creation ledger could authorise entering them.
 */
function wipe(h: Harness): void {
  for (const root of [h.rootDir, h.ambientTmp]) {
    removeForeignTree(root);
  }
}

/**
 * A STATEFUL stand-in for the installed CLI — not a yes-man. It keeps a store under the home it is
 * given, so `add` is visible to `search` and `review`, `consolidate` really archives the duplicate
 * `add` made, `rollback` really restores it and appends to the journal, and `pack` really writes
 * the file it announces. That is what lets the executing half below demonstrate the difference
 * between a command that WORKS and a command that merely exits 0 — an invocation-only gate cannot
 * tell them apart, and the whole point of the step's outcome assertions is that it must.
 *
 * It also reports two things about how it was launched, because those are load-bearing properties
 * of the step rather than of the CLI: the working directory it was given, and any variable that
 * reached it from outside the environment the step constructs.
 *
 * Knobs arrive in a FILE beside the binary, never in the environment — the step launches it with
 * `env -i`, so an environment-carried knob could not reach it, and one that did would mean the
 * hermetic construction had failed.
 */
const FAKE_CLI_PRELUDE = `#!/bin/sh
kit="$(cd "$(dirname "$0")/.." && pwd)"
if [ -f "$kit/knobs.sh" ]; then . "$kit/knobs.sh"; fi
cwd="$(pwd)"
printf '%s\\n' "$*" >> "$kit/cli.log"
printf '%s\\n' "$cwd" >> "$kit/cwd.log"
env | sed 's/=.*//' >> "$kit/env.log"

# THE CWD SENTINEL. This file exists only in the checkout the step itself is launched from. A CLI
# that can see it is running with the source tree as its working directory, where it could resolve
# a prompt, template or asset the package never shipped and pass a gate the real install fails.
if [ -e "checkout-sentinel" ]; then
  echo "SAW_CHECKOUT_SENTINEL in $cwd" >&2
  exit 9
fi

# THE ENV CANARIES. Every one of these is exported into the step's OWN environment, so each is a
# variable that reaches this process if — and only if — something is inherited rather than
# constructed.
leaked=""
for v in ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY GOOGLE_API_KEY ANTHROPIC_BASE_URL \\
  OPENAI_BASE_URL GEMINI_BASE_URL STHAYI_PROMPTS_DIR STHAYI_SKILLS_DIR CI_DEPLOY_TOKEN \\
  RELEASE_SIGNING_SECRET DB_PASSWORD AWS_SHARED_CREDENTIAL_FILE; do
  eval "val=\\\${$v:-}"
  if [ -n "$val" ]; then leaked="$leaked $v"; fi
done
if [ -n "$leaked" ]; then
  echo "LEAKED_ENV$leaked" >&2
  exit 9
fi
# ...and every HOME locator must be present AND isolated, rather than pointing at whatever the
# machine's own configuration says.
for v in HOME STHAYI_HOME USERPROFILE APPDATA LOCALAPPDATA XDG_CONFIG_HOME; do
  eval "val=\\\${$v:-}"
  case "$val" in
    '') echo "MISSING_ENV $v" >&2; exit 9 ;;
    *canary-external*) echo "LEAKED_ENV $v=$val" >&2; exit 9 ;;
  esac
done

cmd="$1"
# Each knob turns exactly ONE correct behaviour into the defect the step must catch.
if [ -n "\${FAKE_FAIL_COMMAND:-}" ] && [ "$cmd" = "$FAKE_FAIL_COMMAND" ]; then
  echo "fake sthayi: $cmd failed" >&2
  exit 7
fi
if [ -n "\${FAKE_HANG_COMMAND:-}" ] && [ "$cmd" = "$FAKE_HANG_COMMAND" ]; then
  sleep 900
  exit 0
fi
if [ -n "\${FAKE_UNSET_COMPLAINT:-}" ] && [ "$cmd" = "$FAKE_UNSET_COMPLAINT" ]; then
  echo "STHAYI_SOMETHING is not set"
  exit 0
fi
# The defect an invocation-only gate is blind to: exit 0, a cheerful line, nothing done.
if [ -n "\${FAKE_SILENT_OK:-}" ] && [ "$cmd" = "$FAKE_SILENT_OK" ]; then
  echo "ok"
  exit 0
fi
# THE HANG THAT LOOKS LIKE A SUCCESS. It prints the exact line the step reads for \`doctor\`, then
# never returns, then CATCHES the retirement signal and exits 0. Every outcome assertion is
# satisfied and the exit status is the one a healthy command gives, so the only thing left that
# can tell the difference is the timeout marker — which is why the marker may not be conditioned
# on the exit status. Hardcoded to \`doctor\` because the knob has to answer as a specific command.
if [ "\${FAKE_TRAP_TERM_DOCTOR:-0}" = 1 ] && [ "$cmd" = doctor ]; then
  trap 'exit 0' TERM
  echo 'All checks passed.'
  sleep 900 &
  wait $! 2>/dev/null
  exit 0
fi

store="$STHAYI_HOME"
db="$store/sthayi.db"
journal="$store/journal"
ents="$store/entities"

# Commands that must touch NOTHING are answered before the store is ever created.
case "$cmd" in
  --version) printf '%s\\n' "\${FAKE_VERSION:-0.0.0}"; exit 0 ;;
  --help)
    for c in init serve wire unwire status add search review import consolidate pack entities \\
      journal index rollback qualify doctor; do
      if [ "$c" != "\${FAKE_HELP_OMITS:-}" ]; then printf '  %s\\n' "$c"; fi
    done
    exit 0
    ;;
  serve)
    # A SERVER THAT STARTS SOMETHING. The pid is recorded so the test can ask, after the step has
    # finished and passed, whether anything sthayi launched is still running on the machine.
    if [ "\${FAKE_SERVE_GRANDCHILD:-0}" = 1 ]; then
      sleep 45 &
      printf '%s\\n' "$!" > "$kit/grandchild.pid"
    fi
    # Model the real stdio transport: EOF means the client disconnected, so a probe that gives a
    # background server no open stdin must fail instead of being rescued by this stand-in's sleep.
    IFS= read -r _client_frame || exit 0
    sleep 30
    exit 0
    ;;
  init)
    printf 'Dry run — would initialize %s:\\n' "$store"
    printf '  create db             %s\\n' "$db"
    printf '  create launcher       %s/bin/sthayi\\n' "$store"
    if [ "\${FAKE_DRYRUN_WRITES:-}" = init ]; then
      mkdir -p "$store"
      : > "$db"
    fi
    exit 0
    ;;
esac
`;

/** The half that keeps state: every command below can be seen by the command after it. */
const FAKE_CLI_STORE = `
mkdir -p "$store"
: >> "$db"
: >> "$journal"
: >> "$ents"
jnext() { printf '#%s 2026-01-01T00:00:00Z %s\\n' "$(awk 'END { print NR + 1 }' "$journal")" "$1" >> "$journal"; }

case "$cmd" in
  add)
    shift
    status=proposed
    if [ "$1" = "--confirm" ]; then status=confirmed; shift; fi
    text="$*"
    stored="$text"
    case "$text" in
      *"$FAKE_CANARY"*)
        # The real CLI substitutes the bare pseudonym for the secret and files the real value in
        # the vault, which \`entities\` then prints as a three-column decode table. Both shapes are
        # copied here because the step reads BOTH: the masked memory in the pack, and the mapping
        # that decodes it.
        stored="$(printf '%s' "$text" | sed "s|$FAKE_CANARY|APIKEY_01|")"
        grep -q APIKEY_01 "$ents" || printf 'APIKEY_01     APIKEY  %s\\n' "$FAKE_CANARY" >> "$ents"
        ;;
    esac
    if [ "\${FAKE_ADD_NOOP:-0}" != 1 ]; then
      printf '%s|%s|live\\n' "$status" "$stored" >> "$db"
      jnext memory_add
    fi
    id="$(awk 'END { print NR }' "$db")"
    if [ "\${FAKE_ADD_ECHOES_SECRET:-0}" = 1 ]; then
      printf 'added %s note memory %s [scope global]: %s\\n' "$status" "$id" "$text"
      exit 0
    fi
    printf 'added %s note memory %s [scope global]\\n' "$status" "$id"
    exit 0
    ;;
  search)
    shift
    jnext memory_retrieve
    grep '|live$' "$db" | grep -i -- "$1" | sed 's/^[^|]*|/  /; s/|live$//'
    exit 0
    ;;
  review)
    printf '%s proposal(s) queued\\n' "$(grep -c '^proposed|' "$db" || true)"
    grep '^proposed|' "$db" | sed 's/^proposed|/  /; s/|live$//' || true
    exit 0
    ;;
  import)
    shift
    n="$(ls -A "$1" | awk 'END { print NR }')"
    # THE FIXTURE'S OWN FACT, the way the real importer derives a memory from an export: it is in
    # the export and nowhere else, so it is the one thing whose presence in the store can only
    # have come from an ingest that really happened.
    fact="$(sed -n 's/.*"full_name": *"\\([^"]*\\)".*/\\1/p' "$1"/*.json 2>/dev/null | head -n 1)"
    if [ "\${FAKE_IMPORT_NO_STATE:-0}" != 1 ]; then
      i=0
      while [ "$i" -lt "$n" ]; do
        printf 'proposed|imported memory %s|live\\n' "$i" >> "$db"
        i=$((i + 1))
      done
      if [ -n "$fact" ]; then
        printf 'proposed|imported fact: %s|live\\n' "$fact" >> "$db"
      fi
      jnext memory_import
    fi
    printf 'Imported %s memory(ies) as proposals.\\n' "$n"
    exit 0
    ;;
  consolidate)
    for a in "$@"; do
      if [ "$a" = "--oracle" ]; then
        if [ "\${FAKE_ORACLE_SUCCEEDS:-0}" = 1 ]; then
          echo 'consolidated via oracle'
          exit 0
        fi
        echo 'ANTHROPIC_API_KEY is not set' >&2
        exit 1
      fi
    done
    if [ "\${FAKE_CONSOLIDATE_NO_ARCHIVE:-0}" != 1 ]; then
      awk -F'|' 'BEGIN { OFS = "|" } { key = $1 "|" $2; if ($3 == "live" && seen[key]++) $3 = "archived"; print }' "$db" > "$db.new"
      mv "$db.new" "$db"
    fi
    jnext consolidate
    # THE SENTENCE IS ALWAYS THE HONEST-LOOKING ONE: with the knob on, the fold announces the
    # archived duplicate it did not archive, which is the exact shape a report-reading gate
    # cannot tell apart from a fold that worked.
    printf 'Deterministic: 1 duplicate(s) → 1 archived.\\n'
    exit 0
    ;;
  journal)
    if [ "$2" = "--verify" ]; then
      if [ "\${FAKE_JOURNAL_TAMPER:-0}" = 1 ]; then
        echo 'journal chain BROKEN at #3'
        exit 0
      fi
      printf 'journal OK — %s entries, chain intact.\\n' "$(awk 'END { print NR }' "$journal")"
      exit 0
    fi
    cat "$journal"
    exit 0
    ;;
  rollback)
    # TWO DIFFERENT DEFECTS. FAKE_ROLLBACK_NOOP does nothing at all — no restore, no compensating
    # entries — and is caught by the journal count. FAKE_ROLLBACK_NO_RESTORE writes the
    # compensating entries and leaves the memory archived: the journal grows exactly as it should,
    # the success line is exactly right, and only the store knows.
    if [ "\${FAKE_ROLLBACK_NOOP:-0}" != 1 ]; then
      if [ "\${FAKE_ROLLBACK_NO_RESTORE:-0}" != 1 ]; then
        sed 's/|archived$/|live/' "$db" > "$db.new"
        mv "$db.new" "$db"
      fi
      jnext rollback
    fi
    printf 'Rolled back #%s: reverted 1 change(s). Journal chain intact: true.\\n' "$2"
    exit 0
    ;;
  index)
    if [ "$2" = "rebuild" ]; then
      printf 'association graph rebuilt from the journal: 4 edge(s).\\n'
    else
      printf 'association graph: 4 edge(s), folded through journal #%s.\\n' "$(awk 'END { print NR }' "$journal")"
    fi
    exit 0
    ;;
  pack)
    packfile="$store/context.md"
    # FOUR SHAPES OF THE SAME ANNOUNCEMENT. No file at all; a file with nothing in it; a file with
    # the right name holding something else entirely; and the correct pack. All four print the
    # same line, so the line is worth nothing and the file has to be read.
    if [ "\${FAKE_PACK_NO_FILE:-0}" = 1 ]; then
      :
    elif [ "\${FAKE_PACK_EMPTY:-0}" = 1 ]; then
      : > "$packfile"
    elif [ "\${FAKE_PACK_IRRELEVANT:-0}" = 1 ]; then
      printf '# Sthayi memory pack\\n\\n_Contents: 0 confirmed memories_\\n' > "$packfile"
    elif [ "\${FAKE_PACK_DROPS_MASKED:-0}" = 1 ]; then
      { echo '# memory pack'; sed 's/^[^|]*|//; s/|live$//' "$db" | grep -v APIKEY_01; } > "$packfile"
    else
      { echo '# memory pack'; sed 's/^[^|]*|//; s/|live$//' "$db"; } > "$packfile"
      if [ "\${FAKE_PACK_LEAKS_SECRET:-0}" = 1 ]; then printf '%s\\n' "$FAKE_CANARY" >> "$packfile"; fi
    fi
    printf 'Wrote masked memory pack: %s\\n' "$packfile"
    exit 0
    ;;
  entities)
    # The real \`entities\` is the LOCAL decode table and prints the real value on purpose — it is
    # the line the pack tells the reader to run. The stand-in answers the same way, so the step's
    # mapping assertion is exercised against the shape a correct CLI actually produces.
    if [ -s "$ents" ]; then
      printf 'pseudonym     kind    value\\n'
      cat "$ents"
    else
      echo 'no entities recorded'
    fi
    exit 0
    ;;
  status) printf 'client claude-code: not wired\\nclient codex: not wired\\n'; exit 0 ;;
  wire | unwire)
    printf 'Dry run — would %s 0 detected client(s).\\n' "$cmd"
    if [ "\${FAKE_DRYRUN_WRITES:-}" = "$cmd" ]; then printf 'x\\n' >> "$store/$cmd-marker"; fi
    exit 0
    ;;
  doctor) echo 'All checks passed.'; exit 0 ;;
  qualify) echo 'OPENAI_API_KEY is not set' >&2; exit 1 ;;
esac
echo "ok $*"
exit 0
`;

const FAKE_CLI = FAKE_CLI_PRELUDE + FAKE_CLI_STORE;

const FAKE_VERSION = '9.9.9';

/** The same synthetic key shape the step and the source-driven matrix use — never a real key. */
const CANARY = 'sk-proj-CANARYaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/**
 * The fact that exists in the import fixture and nowhere else in the run. The step asks the STORE
 * for it after `import`, which is the only reading that can tell an ingest that happened from a
 * line that says one did. Pinned to the real fixture below.
 */
const IMPORT_FACT = 'Alex Doe';

/**
 * Variables exported into the STEP's own environment, so "the child inherited nothing" is a
 * demonstration rather than an assumption. The `canary-external` paths are what a machine's real
 * client configuration would look like to a CLI that consulted the ambient HOME locators.
 */
const ENV_CANARIES: Record<string, string> = {
  ANTHROPIC_API_KEY: 'sk-ant-CANARY-not-a-key',
  OPENAI_API_KEY: 'sk-CANARY-not-a-key',
  GEMINI_API_KEY: 'CANARY-not-a-key',
  GOOGLE_API_KEY: 'CANARY-not-a-key',
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/canary',
  OPENAI_BASE_URL: 'http://127.0.0.1:9/canary',
  GEMINI_BASE_URL: 'http://127.0.0.1:9/canary',
  STHAYI_PROMPTS_DIR: '/canary-external/prompts',
  STHAYI_SKILLS_DIR: '/canary-external/skills',
  STHAYI_HOME: '/canary-external/sthayi',
  CI_DEPLOY_TOKEN: 'CANARY',
  RELEASE_SIGNING_SECRET: 'CANARY',
  DB_PASSWORD: 'CANARY',
  AWS_SHARED_CREDENTIAL_FILE: '/canary-external/aws',
  USERPROFILE: '/canary-external/profile',
  APPDATA: '/canary-external/appdata',
  LOCALAPPDATA: '/canary-external/localappdata',
  XDG_CONFIG_HOME: '/canary-external/config',
};

interface Harness {
  rootDir: string;
  /** The ambient temp root the step is handed — allocated separately, OUTSIDE `rootDir`. */
  ambientTmp: string;
  env: NodeJS.ProcessEnv;
  stepFile: string;
}

function harness(stepBody: string = packagedMatrixStep()): Harness {
  const rootDir = scratchDir();
  // THE AMBIENT TEMP ROOT IS ALLOCATED INDEPENDENTLY, AND IT IS NOT INSIDE THE CHECKOUT STAND-IN.
  //
  // The step allocates its own home, scratch and working directory with `mktemp -d`, and `mktemp`
  // allocates INSIDE $TMPDIR — on GNU coreutils, which is what the release runner has. Pointing
  // the step's TMPDIR at a directory beneath `rootDir` therefore puts $MATRIX_CWD beneath the
  // checkout stand-in, which is exactly the state the neutral-cwd assertion below exists to
  // forbid: the step would be handed a working directory inside the tree it must not see, and the
  // property would be proved against a harness that had already broken it.
  //
  // macOS hides this. The BSD `mktemp` ignores $TMPDIR entirely and always allocates under
  // /var/folders, so a TMPDIR inside `rootDir` is harmless there and poisonous on Ubuntu — a green
  // that depends on which `mktemp` ran, which is not a proof of anything. A sibling root keeps the
  // two apart under BOTH implementations; the suite below settles that with a shim rather than
  // leaving it to whichever platform happens to run the tests.
  const ambientTmp = scratchDir('packaged-matrix-tmp-');
  for (const d of ['bin', 'fixture', 'ambient-home']) {
    fs.mkdirSync(path.join(rootDir, d));
  }
  fs.writeFileSync(path.join(rootDir, 'fixture', 'conversations.json'), '[]\n');
  // The stand-in export carries the SAME unique fact the real fixture does, in the same shape, so
  // the step's "ask the store for something only the export can have put there" assertion is
  // exercised here exactly as it will be on the runner.
  fs.writeFileSync(
    path.join(rootDir, 'fixture', 'users.json'),
    `[{ "full_name": "${IMPORT_FACT}" }]\n`,
  );
  for (const f of ['cli.log', 'cwd.log', 'env.log']) {
    fs.writeFileSync(path.join(rootDir, f), '');
  }
  // THE CWD SENTINEL lives in the directory the step itself runs from — the stand-in for the
  // checkout, which really is present on the release runner.
  fs.writeFileSync(path.join(rootDir, 'checkout-sentinel'), 'an asset the package never shipped\n');
  fs.writeFileSync(path.join(rootDir, 'bin', 'sthayi'), FAKE_CLI, { mode: 0o700 });
  const stepFile = path.join(rootDir, 'step.sh');
  fs.writeFileSync(stepFile, stepBody);
  return {
    rootDir,
    ambientTmp,
    stepFile,
    env: {
      ...process.env,
      ...ENV_CANARIES,
      // Sibling of the checkout stand-in, never a child of it: everything the step allocates with
      // `mktemp` lands here, and $MATRIX_CWD is only neutral if here is not inside there.
      TMPDIR: ambientTmp,
      // The AMBIENT home — the one the step must not hand on. It stays inside the checkout
      // stand-in on purpose: it is machine state the step is supposed to replace, and a child that
      // ends up with this path has inherited rather than been given a home.
      HOME: path.join(rootDir, 'ambient-home'),
      VERSION: FAKE_VERSION,
      // A short bound so a hang is proved in seconds. The step's own default is the release one;
      // this only narrows it, and the step refuses a value outside its permitted range.
      MATRIX_CMD_TIMEOUT: '4',
      PACKAGED_BIN: path.join(rootDir, 'bin', 'sthayi'),
      PACKAGED_FIXTURE: path.join(rootDir, 'fixture'),
    },
  };
}

/** Knobs reach the stand-in through a FILE, because the step gives it no environment to carry. */
function writeKnobs(h: Harness, knobs: Record<string, string>): void {
  const lines = [`FAKE_VERSION='${FAKE_VERSION}'`, `FAKE_CANARY='${CANARY}'`];
  for (const [k, v] of Object.entries(knobs)) {
    lines.push(`${k}='${v}'`);
  }
  fs.writeFileSync(path.join(h.rootDir, 'knobs.sh'), `${lines.join('\n')}\n`);
}

function runStep(h: Harness, knobs: Record<string, string> = {}): RunResult {
  writeKnobs(h, knobs);
  const r = spawnSync('bash', ['-e', h.stepFile], {
    // THE STEP'S OWN cwd IS THE CHECKOUT — exactly as it is on the release runner, where the
    // workflow checks out the repository for the import fixture. Whether the CLI inherits that
    // directory is the property under test.
    cwd: h.rootDir,
    env: h.env,
    encoding: 'utf8',
    timeout: 180_000,
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/**
 * A `mktemp` that behaves the way GNU coreutils does — the implementation the release runner has.
 *
 * `mktemp -d` on GNU allocates inside $TMPDIR. The BSD one macOS ships ignores $TMPDIR completely
 * and always allocates under /var/folders, so every property this file proves ABOUT the
 * directories the step allocates is settled on macOS by an implementation the release never runs.
 * That is not a difference in decoration: a harness that hands the step a $TMPDIR inside the
 * checkout stand-in is neutral under BSD semantics and not neutral under GNU ones, and the
 * difference decides whether the release passes.
 *
 * So the semantics are supplied rather than inherited. The shim is first on the PATH of the shell
 * that runs the step — not of the CLI, which the step launches with `env -i` and its own PATH —
 * and it delegates every other form of the command to the real binary.
 */
const GNU_MKTEMP_SHIM = [
  '#!/bin/bash',
  '# `-d` with no template: allocate inside $TMPDIR, as GNU coreutils does.',
  'if [ "$1" = "-d" ] && [ $# -eq 1 ]; then',
  '  base="${TMPDIR:-/tmp}"',
  '  base="${base%/}"',
  '  n=0',
  '  while [ "$n" -lt 4096 ]; do',
  '    target="$base/gnu-mktemp.$$.$n"',
  // plain `mkdir`, never `-p`: it FAILS on a name that already exists, which is what makes each
  // allocation unique. `-p` would succeed and hand two callers the same directory.
  '    if mkdir -m 700 "$target" 2>/dev/null; then',
  '      printf \'%s\\n\' "$target"',
  '      exit 0',
  '    fi',
  '    n=$((n + 1))',
  '  done',
  '  echo "gnu-mktemp shim: no free name under $base" >&2',
  '  exit 1',
  'fi',
  'exec /usr/bin/mktemp "$@"',
  '',
].join('\n');

/** The same fixture, with the GNU-semantics `mktemp` ahead of everything else on its PATH. */
function withGnuMktemp(h: Harness): Harness {
  const shimDir = path.join(h.rootDir, 'gnu-bin');
  fs.mkdirSync(shimDir, { recursive: true });
  fs.writeFileSync(path.join(shimDir, 'mktemp'), GNU_MKTEMP_SHIM, { mode: 0o700 });
  return { ...h, env: { ...h.env, PATH: `${shimDir}:${h.env.PATH ?? ''}` } };
}

const logLines = (h: Harness, file: string): string[] =>
  fs
    .readFileSync(path.join(h.rootDir, file), 'utf8')
    .split('\n')
    .filter((l) => l !== '');

const invocations = (h: Harness): string[] => logLines(h, 'cli.log');

describePosix('the packaged matrix step, executed against a fake installed CLI', () => {
  it('invokes every registered command on the installed binary and passes', () => {
    const h = harness();
    const run = runStep(h);
    const called = invocations(h);
    wipe(h);

    expect(run.code, `the packaged matrix failed on a healthy CLI: ${run.out}`).toBe(0);
    expect(run.out, 'the step never announced completion').toContain('packaged keyless matrix OK');

    // EVERY registered command, proved from what the binary was actually asked to do — not from
    // the ledger, which is the thing being checked.
    const firstWords = new Set(called.map((l) => l.split(' ')[0] ?? ''));
    for (const name of REGISTERED) {
      expect(firstWords.has(name), `'sthayi ${name}' was never run on the installed tarball`).toBe(
        true,
      );
    }
    // And the two exceptions were exercised in their key-requiring forms.
    expect(
      called.some((l) => l.startsWith('consolidate --oracle')),
      'the oracle exception was never exercised against the package',
    ).toBe(true);
    expect(
      called.some((l) => l.startsWith('qualify ')),
      'the qualify exception was never exercised against the package',
    ).toBe(true);
  }, 120_000);

  it('gives the installed CLI a neutral cwd and an environment it built', () => {
    // THE POSITIVE HALF of both hermeticity properties, read off what the binary actually received
    // rather than off the shell that launched it. The step ran with the checkout as ITS cwd and
    // with every canary exported into ITS environment, and neither reached the child.
    const h = harness();
    const run = runStep(h);
    const cwds = logLines(h, 'cwd.log');
    const seenVars = new Set(logLines(h, 'env.log'));
    wipe(h);

    expect(run.code, `the packaged matrix failed on a healthy CLI: ${run.out}`).toBe(0);
    expect(cwds.length, 'the CLI was never launched').toBeGreaterThan(20);
    for (const cwd of new Set(cwds)) {
      expect(cwd, 'the installed CLI ran with the checkout as its working directory').not.toBe(
        h.rootDir,
      );
      expect(
        cwd.startsWith(`${h.rootDir}/`),
        `the installed CLI ran inside the checkout (${cwd}) and could resolve an unshipped asset there`,
      ).toBe(false);
    }
    // Nothing outside the constructed set arrived. PWD/SHLVL/_ are written by the shell that runs
    // the stand-in itself, not inherited through the step.
    const allowed = new Set([
      'PATH',
      'HOME',
      'STHAYI_HOME',
      'USERPROFILE',
      'APPDATA',
      'LOCALAPPDATA',
      'XDG_CONFIG_HOME',
      'PWD',
      'OLDPWD',
      'SHLVL',
      '_',
    ]);
    for (const v of seenVars) {
      expect(allowed.has(v), `'${v}' reached the installed CLI from outside the step`).toBe(true);
    }
    for (const v of Object.keys(ENV_CANARIES)) {
      if (allowed.has(v)) continue;
      expect(seenVars.has(v), `the canary '${v}' was inherited by the installed CLI`).toBe(false);
    }
    // AND THE HARNESS ITSELF HAS TO HOLD THE PROPERTY UP. The step allocates its working directory
    // with `mktemp -d`, which allocates inside $TMPDIR wherever `mktemp` honours it. If the ambient
    // temp root the fixture hands over sits inside the checkout stand-in, then $MATRIX_CWD sits
    // inside it too and the loop above is asserting against a fixture that has already conceded
    // the property. Checked here, and not only through the shim below, so the mistake cannot be
    // reintroduced and hide behind whichever `mktemp` the developer's platform happens to ship.
    //
    // Read off the value the step was HANDED, not off the directory the fixture allocated: the two
    // are the same only for as long as nobody re-points one of them, and the one that decides where
    // `mktemp` puts things is the handed one.
    const handedTmp = h.env.TMPDIR ?? '';
    expect(handedTmp, 'the step was handed no TMPDIR at all').not.toBe('');
    expect(
      handedTmp === h.rootDir || handedTmp.startsWith(`${h.rootDir}/`),
      `the fixture handed the step a TMPDIR (${handedTmp}) inside the checkout stand-in (${h.rootDir}) — every directory the step allocates would be inside the tree it must not see`,
    ).toBe(false);
  }, 120_000);

  it('keeps the neutral cwd under a `mktemp -d` that honours TMPDIR, as the release runner does', () => {
    // THE SAME PROPERTY, SETTLED RATHER THAN INHERITED. The release runs on ubuntu-latest, where
    // `mktemp -d` is GNU coreutils and allocates inside $TMPDIR. macOS ships the BSD one, which
    // ignores $TMPDIR and always allocates under /var/folders — so the test above cannot, on a
    // developer's machine, distinguish a step that is given a neutral working directory from one
    // that is handed a directory inside the checkout: BSD `mktemp` walks away from the bad $TMPDIR
    // on its own. A green that depends on which `mktemp` ran proves nothing about the runner.
    //
    // Here the GNU semantics are supplied by a shim, on every platform, and the run is required to
    // land inside the ambient temp root — which is what makes this NOT vacuous: if the shim were
    // ignored the directories would come out under /var/folders and that assertion would fail.
    const h = harness();
    const run = runStep(withGnuMktemp(h));
    const cwds = logLines(h, 'cwd.log');
    const root = h.rootDir;
    const ambient = h.ambientTmp;
    wipe(h);

    expect(run.code, `the packaged matrix failed on a healthy CLI: ${run.out}`).toBe(0);
    expect(cwds.length, 'the CLI was never launched').toBeGreaterThan(20);
    for (const cwd of new Set(cwds)) {
      expect(cwd, 'the installed CLI ran with the checkout as its working directory').not.toBe(
        root,
      );
      expect(
        cwd.startsWith(`${root}/`),
        `the installed CLI ran inside the checkout (${cwd}) and could resolve an unshipped asset there`,
      ).toBe(false);
      // NON-VACUITY, asserted last so a real containment failure above reports itself first: the
      // directories have to have come out of the ambient temp root, which is the one thing a
      // TMPDIR-honouring `mktemp` does and the BSD one never does.
      expect(
        cwd.startsWith(`${ambient}/`),
        `the TMPDIR-honouring shim was not in force: the CLI ran in ${cwd}, which is not under the ambient temp root ${ambient} — this test would be proving nothing`,
      ).toBe(true);
    }
  }, 120_000);

  it('one failing command fails the release', () => {
    // The control above passes for a healthy CLI; this is what makes the step a GATE rather than a
    // script that runs some commands and exits 0.
    const h = harness();
    const run = runStep(h, { FAKE_FAIL_COMMAND: 'pack' });
    wipe(h);

    expect(
      run.code,
      `a broken 'pack' in the installed tarball passed the gate: ${run.out}`,
    ).not.toBe(0);
    expect(run.out, 'the failure does not name the command that failed').toContain("'sthayi pack'");
  }, 120_000);

  it('a command that asks for an env var fails the release', () => {
    // The keyless invariant itself. Exit 0 with "X is not set" on stdout is the exact shape of a
    // command that quietly degrades instead of working keyless.
    const h = harness();
    const run = runStep(h, { FAKE_UNSET_COMPLAINT: 'entities' });
    wipe(h);

    expect(
      run.code,
      `a command asking for an env var passed the keyless gate: ${run.out}`,
    ).not.toBe(0);
    expect(run.out, 'the failure is not the keyless invariant').toMatch(
      /not keyless|asked for an env var/,
    );
  }, 120_000);

  it('an oracle command that succeeds WITHOUT a key fails the release', () => {
    // The two documented exceptions are exceptions because they need a key. One that returns 0 with
    // the environment stripped either reached a provider some other way or silently no-opped, and
    // both are release-stopping.
    const h = harness();
    const run = runStep(h, { FAKE_ORACLE_SUCCEEDS: '1' });
    wipe(h);

    expect(run.code, `an oracle run with no key was accepted: ${run.out}`).not.toBe(0);
    expect(run.out, 'the failure is not the unenforced exception').toContain(
      'succeeded with no ANTHROPIC_API_KEY',
    );
  }, 120_000);

  it('deleting an invocation is caught by the ledger, not silently accepted', () => {
    // WHY THE RUN-TIME LEDGER CHECK EXISTS. Without it, quietly deleting a line from the step
    // reduces the release's coverage and every gate still passes. Here the step is run with one
    // invocation removed and nothing else changed.
    // The whole BLOCK goes — the invocation and the outcome assertions that read its output — so
    // what is left to notice is the ledger and nothing else. Deleting only the invocation would
    // strand its assertions on the previous command's output and be caught for the wrong reason.
    const original = packagedMatrixStep();
    const lines = original.split('\n');
    const at = lines.findIndex((l) => l.trim() === 'keyless entities');
    expect(
      at,
      'the step no longer invokes `entities` — the probe has nothing to remove',
    ).toBeGreaterThan(-1);
    let end = at + 1;
    while (end < lines.length && /^\s*(expect_out|refute_canary)\b/.test(lines[end] as string)) {
      end += 1;
    }
    const mutated = [...lines.slice(0, at), ...lines.slice(end)].join('\n');
    expect(mutated, 'the mutation removed nothing — the probe would prove nothing').not.toBe(
      original,
    );

    const h = harness(mutated);
    const run = runStep(h);
    const called = invocations(h);
    wipe(h);

    expect(
      called.some((l) => l.startsWith('entities')),
      'the mutation did not actually remove the invocation',
    ).toBe(false);
    expect(run.code, `a deleted command was accepted as covered: ${run.out}`).not.toBe(0);
    expect(run.out, 'the ledger did not catch the missing invocation').toContain(
      "'entities' is in the coverage ledger but was never invoked",
    );
  }, 120_000);
});

// ===============================================================================================
// THE OUTCOME MUTATIONS.
//
// A command that runs is not a command that works. Each probe below leaves the stand-in answering
// with the right exit status and — where the defect is a no-op — the right sentence, and changes
// exactly ONE thing about what it actually did. Every one must turn the release red; a probe that
// passes means the step is measuring invocation rather than behaviour.
// ===============================================================================================

/** Run the shipped step against a stand-in with one knob turned, and return what happened. */
function mutate(knobs: Record<string, string>, stepBody?: string): RunResult {
  const h = harness(stepBody);
  const run = runStep(h, knobs);
  wipe(h);
  return run;
}

describePosix('a command that runs but does not WORK fails the release', () => {
  // Self-enforcing: every command the step pins an outcome for gets a probe, so a new command
  // cannot arrive with an invocation and an unchecked result.
  it.each(Object.keys(OUTCOME_PHRASES))(
    "'%s' degraded to a bare `ok` is caught",
    (name) => {
      const run = mutate({ FAKE_SILENT_OK: name });
      expect(
        run.code,
        `'sthayi ${name}' answered 'ok' and did nothing, and the release passed: ${run.out}`,
      ).not.toBe(0);
      // ...and RED for the right reason: the failure names the command whose outcome went missing,
      // not some later collateral collapse.
      expect(
        run.out.includes(`'${name}`),
        `the release failed, but not because of '${name}': ${run.out}`,
      ).toBe(true);
    },
    120_000,
  );

  it('an `add` that reports success and stores nothing is caught downstream', () => {
    const run = mutate({ FAKE_ADD_NOOP: '1' });
    expect(run.code, `a no-op 'add' passed the gate: ${run.out}`).not.toBe(0);
    expect(run.out, 'the failure does not name the empty result').toContain(
      "'search' returned no result",
    );
  }, 120_000);

  it('a `rollback` that prints its success line and reverts nothing is caught', () => {
    // The reason the journal is counted either side: rollback reverts by APPENDING compensating
    // entries, so its own sentence proves nothing that the entries do not.
    const run = mutate({ FAKE_ROLLBACK_NOOP: '1' });
    expect(run.code, `a no-op 'rollback' passed the gate: ${run.out}`).not.toBe(0);
    expect(run.out, 'the failure is not the missing effect').toContain(
      'appended no compensating journal entries',
    );
  }, 120_000);

  it('a `pack` that announces a file it never wrote is caught', () => {
    const run = mutate({ FAKE_PACK_NO_FILE: '1' });
    expect(run.code, `a 'pack' that wrote nothing passed the gate: ${run.out}`).not.toBe(0);
    expect(run.out, 'the announced pack file was never opened').toContain(
      'announced a memory pack at',
    );
  }, 120_000);

  it('a `journal --verify` that reports a broken chain is caught', () => {
    const run = mutate({ FAKE_JOURNAL_TAMPER: '1' });
    expect(run.code, `a broken journal chain passed the gate: ${run.out}`).not.toBe(0);
    expect(run.out, 'the failure is not the journal chain').toContain(
      'journal chain is not intact',
    );
  }, 120_000);

  it('a `--help` missing a registered command is caught', () => {
    const run = mutate({ FAKE_HELP_OMITS: 'rollback' });
    expect(run.code, `a --help missing a command passed the gate: ${run.out}`).not.toBe(0);
    expect(run.out, 'the failure does not name the missing command').toContain(
      "--help never lists 'rollback'",
    );
  }, 120_000);
});

// ===============================================================================================
// THE STATE MUTATIONS.
//
// Each stand-in below prints EVERY sentence the step reads and exits 0 — the correct-message,
// wrong-state shape a prose-matching gate accepts completely. What is different is what the store
// holds afterwards, and that is the only thing left that can catch them.
// ===============================================================================================

describePosix('a command whose words are right and whose state is wrong fails the release', () => {
  it('an `import` that announces an ingest and stores nothing is caught', () => {
    const run = mutate({ FAKE_IMPORT_NO_STATE: '1' });
    expect(run.code, `an 'import' that ingested nothing passed the gate: ${run.out}`).not.toBe(0);
    // RED FOR THE STATE, and demonstrably not for the prose: the success line is right there in
    // the output the failure printed.
    expect(run.out, 'the failure is not the missing imported state').toContain(
      "the store cannot return the fixture's own",
    );
    expect(
      run.out,
      "the prose check fired instead — the stand-in's success line was supposed to satisfy it",
    ).not.toContain('ingested nothing from the export fixture');
  }, 120_000);

  it('a `consolidate` that announces an archived duplicate and archives nothing is caught', () => {
    const run = mutate({ FAKE_CONSOLIDATE_NO_ARCHIVE: '1' });
    expect(run.code, `a fold that archived nothing passed the gate: ${run.out}`).not.toBe(0);
    expect(run.out, 'the failure is not the unchanged duplicate state').toContain(
      'the store still returns both',
    );
    expect(
      run.out,
      "the prose check fired instead — the stand-in's counts were supposed to satisfy it",
    ).not.toContain("'consolidate' archived nothing");
  }, 120_000);

  it('a `rollback` that records compensating entries and restores nothing is caught', () => {
    // Distinct from the no-op rollback: this one appends to the journal exactly as a real one
    // does, so the journal-length reading is satisfied and the memory is still archived.
    const run = mutate({ FAKE_ROLLBACK_NO_RESTORE: '1' });
    expect(run.code, `a rollback that restored nothing passed the gate: ${run.out}`).not.toBe(0);
    expect(run.out, 'the failure is not the unrestored memory').toContain(
      'the archived duplicate is still archived',
    );
    expect(
      run.out,
      'the journal check caught it instead — this probe is meant to get past that one',
    ).not.toContain('appended no compensating journal entries');
  }, 120_000);

  it('a `pack` that creates an empty file is caught', () => {
    const run = mutate({ FAKE_PACK_EMPTY: '1' });
    expect(run.code, `an empty memory pack passed the gate: ${run.out}`).not.toBe(0);
    expect(run.out, 'the failure is not the empty pack').toContain('is empty');
  }, 120_000);

  it('a `pack` that writes a file holding none of the memories is caught', () => {
    const run = mutate({ FAKE_PACK_IRRELEVANT: '1' });
    expect(run.code, `a memory pack with no memories in it passed the gate: ${run.out}`).not.toBe(
      0,
    );
    expect(run.out, 'the failure is not the contentless pack').toContain(
      'carries no confirmed memory',
    );
  }, 120_000);

  it('a `pack` that drops the canary memory instead of masking it is caught', () => {
    // A pack with the secret removed rather than PSEUDONYMISED passes "the secret is not in it"
    // and loses the memory. Masking is a substitution, so both halves are required.
    const run = mutate({ FAKE_PACK_DROPS_MASKED: '1' });
    expect(
      run.code,
      `a pack missing the masked canary memory passed the gate: ${run.out}`,
    ).not.toBe(0);
    expect(run.out, 'the failure is not the missing masked form').toContain(
      'does not carry the canary memory in masked form',
    );
  }, 120_000);
});

describePosix('masking and inertness hold on the packaged artifact', () => {
  it('an `add` that echoes the secret back unmasked fails the release', () => {
    const run = mutate({ FAKE_ADD_ECHOES_SECRET: '1' });
    expect(run.code, `an unmasked secret in 'add' output passed the gate: ${run.out}`).not.toBe(0);
    expect(run.out, 'the failure is not the masking invariant').toContain('echoed the secret back');
  }, 120_000);

  it('a memory pack that ships the secret unmasked fails the release', () => {
    // The message can be clean while the FILE is not — which is why the file is opened.
    const run = mutate({ FAKE_PACK_LEAKS_SECRET: '1' });
    expect(run.code, `a memory pack holding the raw secret passed the gate: ${run.out}`).not.toBe(
      0,
    );
    expect(run.out, 'the pack file was never read').toContain('holds the secret unmasked');
  }, 120_000);

  it.each(['init', 'wire', 'unwire'])(
    'a `%s --dry-run` that writes to the home fails the release',
    (name) => {
      const run = mutate({ FAKE_DRYRUN_WRITES: name });
      expect(
        run.code,
        `'sthayi ${name} --dry-run' wrote to the home and the release passed: ${run.out}`,
      ).not.toBe(0);
      expect(run.out, 'the failure is not the dry-run inertness invariant').toMatch(
        /changed the home/,
      );
    },
    120_000,
  );
});

describePosix('the packaged run inherits nothing from the machine it runs on', () => {
  it('the environment is built, not filtered: a narrower construction leaks and fails', () => {
    // The step is launched with every canary exported into ITS environment. `env -i` is the only
    // reason none of them reach the child, and dropping the `-i` is the whole mutation: the child
    // then inherits provider redirects, tokens and credentials from whatever the machine holds.
    const original = packagedMatrixStep();
    const mutated = original.replace('exec env -i \\', 'exec env \\');
    expect(mutated, 'the mutation changed nothing — the probe would prove nothing').not.toBe(
      original,
    );

    const run = mutate({}, mutated);
    expect(run.code, `an inherited environment passed the keyless gate: ${run.out}`).not.toBe(0);
    expect(run.out, 'the leak was not detected').toContain('LEAKED_ENV');
    for (const v of ['GEMINI_BASE_URL', 'STHAYI_PROMPTS_DIR', 'RELEASE_SIGNING_SECRET']) {
      expect(run.out, `'${v}' reached the CLI and nothing noticed`).toContain(v);
    }
  }, 120_000);

  it('the working directory is neutral: running from the checkout finds it and fails', () => {
    // The step's own cwd is the checkout — the release runner really does check the repository
    // out — and the sentinel stands for any prompt, template or asset the package never shipped
    // but the source tree still has. A CLI that can see it passes a gate the real install fails.
    const original = packagedMatrixStep();
    const mutated = original.replace('( cd "$MATRIX_CWD" && exec env -i \\', '( exec env -i \\');
    expect(mutated, 'the mutation changed nothing — the probe would prove nothing').not.toBe(
      original,
    );

    const run = mutate({}, mutated);
    expect(run.code, `the CLI ran inside the checkout and the release passed: ${run.out}`).not.toBe(
      0,
    );
    expect(run.out, 'the checkout was reachable and nothing noticed').toContain(
      'SAW_CHECKOUT_SENTINEL',
    );
  }, 120_000);
});

describePosix('the packaged run fails fast: a hang is killed and named', () => {
  it('a command that never returns is killed, and reported as a timeout not a failure', () => {
    const started = Date.now();
    const run = mutate({ FAKE_HANG_COMMAND: 'doctor' });
    const elapsedMs = Date.now() - started;

    expect(run.code, `a hanging command passed the gate: ${run.out}`).not.toBe(0);
    // The DISTINCTION is the point: a timeout that surfaced as "exited 143" would send whoever
    // reads the log hunting for a bug in `doctor` instead of a wedge.
    expect(run.out, 'the hang was not reported as a hang').toMatch(/was still running after \d+s/);
    expect(run.out, 'a hang was reported as an ordinary nonzero exit').not.toMatch(
      /'sthayi doctor' exited/,
    );
    // And it ended promptly rather than being cut off by something further out.
    expect(elapsedMs, 'the hang was not killed anywhere near the bound').toBeLessThan(90_000);
  }, 180_000);

  it('a command that CATCHES the retirement signal and exits 0 is still rejected', () => {
    // THE HANG THAT LOOKS LIKE A SUCCESS. The stand-in prints the exact line the step reads for
    // `doctor`, never returns, then traps the signal and exits 0. Every outcome assertion is
    // satisfied and the exit status is a healthy one, so a gate that reads the timeout marker
    // only when the status is nonzero passes it — and ships a CLI that wedges.
    const started = Date.now();
    const run = mutate({ FAKE_TRAP_TERM_DOCTOR: '1' });
    const elapsedMs = Date.now() - started;

    expect(
      run.code,
      `a command that trapped the signal and exited 0 passed the gate: ${run.out}`,
    ).not.toBe(0);
    expect(run.out, 'the wedge was not reported as a timeout').toMatch(
      /was still running after \d+s/,
    );
    // Proof that the OUTCOME assertions are not what caught it: the line they look for was
    // printed, and it is in the output the failure reported.
    expect(
      run.out,
      "`doctor`'s success line never appeared — the outcome check caught it",
    ).toContain('All checks passed.');
    expect(elapsedMs, 'the wedge was not killed anywhere near the bound').toBeLessThan(90_000);
  }, 180_000);

  it('nothing the installed CLI started outlives the step', () => {
    // `serve` starts a process and records its pid. The step retires `serve` and passes; the
    // question this asks is whether the machine is clean afterwards — a wrapper-only kill leaves
    // the server AND its children running for the rest of the job, holding this run's home.
    const h = harness();
    const run = runStep(h, { FAKE_SERVE_GRANDCHILD: '1' });
    const pidFile = path.join(h.rootDir, 'grandchild.pid');
    const recorded = fs.existsSync(pidFile)
      ? Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10)
      : Number.NaN;
    let survived = false;
    if (Number.isInteger(recorded) && recorded > 1) {
      try {
        process.kill(recorded, 0);
        survived = true;
        process.kill(recorded, 'SIGKILL'); // a probe never leaves its own process behind
      } catch {
        survived = false;
      }
    }
    wipe(h);

    expect(run.code, `the packaged matrix failed on a healthy CLI: ${run.out}`).toBe(0);
    expect(
      Number.isInteger(recorded),
      '`serve` recorded no process — the probe would prove nothing',
    ).toBe(true);
    expect(
      survived,
      `a process 'sthayi serve' started (pid ${recorded}) was still running after the step finished`,
    ).toBe(false);
  }, 120_000);
});

// ===============================================================================================
// THE PLATFORM GATE, CHECKED AGAINST ITSELF.
//
// A `skipIf` is a claim about which suites need a POSIX shell, and a claim that is not checked
// rots in the direction that hurts: a new executing suite declared with a plain `describe` fails
// the Windows leg for a reason that reads like a product bug, and a static suite quietly wrapped
// in the gate stops being asserted on Windows at all while still reporting green. This runs
// EVERYWHERE — it is the one thing about the executing half that a Windows runner can settle.
// ===============================================================================================
describe('the POSIX gate covers the executing suites and nothing else', () => {
  const source = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  /** A CALL into the shell harness — the `function ` forms are its definitions, above every suite. */
  const HARNESS_CALL = /(?<!function )\b(?:harness|runStep|mutate)\(/;
  /** Every top-level suite in this file, header line first. */
  const suites = source
    .split(/^(?=describe(?:Posix)?\()/m)
    .slice(1)
    .map((block) => ({
      header: (block.split('\n')[0] ?? '').trim(),
      gated: block.startsWith('describePosix('),
      executes: HARNESS_CALL.test(block),
    }));

  it('every suite that EXECUTES the release shell is gated to POSIX', () => {
    const executing = suites.filter((s) => s.executes);
    expect(executing.length, 'no suite executes the step — the gate would be vacuous').toBe(6);
    for (const s of executing) {
      expect(s.gated, `${s.header} executes bash but is not gated to POSIX`).toBe(true);
    }
  });

  it('the STATIC workflow assertions are gated to nothing — they hold on every platform', () => {
    const staticSuites = suites.filter((s) => !s.executes);
    expect(staticSuites.length, 'the static half has vanished').toBeGreaterThan(0);
    for (const s of staticSuites) {
      expect(
        s.gated,
        `${s.header} asserts nothing that needs a POSIX shell, but is skipped on Windows`,
      ).toBe(false);
    }
  });
});
