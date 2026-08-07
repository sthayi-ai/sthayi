import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VERSION } from '../../packages/cli/src/version.js';
import { ensureBuiltCli } from '../helpers/build-cli.js';
import { claimToolEntry, removeOwned } from '../helpers/owned-fs.js';
import { runTempDir } from '../helpers/run-temp.js';

/**
 * SAFETY-ADJACENT, AND THE ONE ROUTE A REPIN CAN ACTUALLY BE RUN BY.
 *
 * A launcher pins a PATHNAME. `<state>/bin/sthayi` and `<state>/bin/sthayi-mcp` exec whatever file
 * stands at the CLI entry path they were written from, so the moment that entry moves — an install
 * at a different prefix, a move, a switch of route — the launchers are pinned at a pathname holding
 * nothing. That is precisely the state a user is in when they go looking for repinning guidance.
 *
 * So the repin has to be invoked from THE NEW INSTALL'S OWN CLI PATH. Telling a reader with a stale
 * pin to run the launcher in their state directory names the one binary their situation has already
 * broken: it is pinned at the old pathname, and running it cannot reach any code at all.
 *
 * These rows do not paraphrase that. They build two REAL installs of the built CLI at two different
 * durable prefixes, wire from the first, delete the entry the launchers name, prove the launchers
 * are then unrunnable, and run THE COMMAND THE README PUBLISHES — read out of the README itself, not
 * written here — from the second. The launcher bodies are then required to name the new entry, and
 * the launcher is EXECUTED to prove it runs.
 *
 * The state directory is a CUSTOM `STHAYI_HOME` throughout, and `$HOME/.sthayi` is asserted never to
 * appear: `~/.sthayi/bin` is where the launchers land by DEFAULT, never a path to hardcode.
 */

const posix = process.platform !== 'win32';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliRoot = path.join(repoRoot, 'packages', 'cli');
const readme = (): string => fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');

/** A named section of the README, up to the next top-level heading. */
function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  expect(start, `${heading} is missing`).toBeGreaterThan(-1);
  const end = text.indexOf('\n## ', start + 1);
  return text.slice(start, end === -1 ? undefined : end);
}

/**
 * The repin command the README publishes for the headline route — READ OUT OF THE README, so the
 * row below executes the published text rather than a rewrite of it.
 *
 * Two conditions, both required: a repin command that names an install's own CLI path must be
 * published at all, and NO published repin command may name the state directory's launcher. The
 * second is the whole point — that file is pinned at the entry that just went away.
 */
function documentedHeadlineRepin(): string {
  const upgrade = section(readme(), '## Upgrade & uninstall');
  // Both surfaces a command can be published on: an inline code span, and a line of a fenced block
  // (trailing `#` comment stripped, so what is collected is the command a reader would copy).
  const spans = [...upgrade.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] as string);
  const fenced = [...upgrade.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].flatMap((m) =>
    (m[1] as string).split('\n').map((line) => line.replace(/\s+#.*$/, '').trim()),
  );
  const repins = [...spans, ...fenced].filter((s) => /\/bin\/sthayi"?\s+wire\b/.test(s));
  expect(
    repins.length,
    'the README publishes no repin command that names the CLI path to run it from',
  ).toBeGreaterThan(0);
  for (const cmd of repins) {
    expect(
      /\.sthayi\/bin\/sthayi"?\s+wire\b/.test(cmd),
      `the README repins with \`${cmd}\` — the launcher in the state directory, which is the binary a stale pin has already broken`,
    ).toBe(false);
  }
  const headline = repins.find((s) => s.includes('$HOME/.local/bin/sthayi'));
  expect(
    headline,
    `no published repin command names the headline route's CLI path: ${repins.join(' | ')}`,
  ).toBeDefined();
  return headline as string;
}

// -----------------------------------------------------------------------------------------------
// EVERY RECOVERY COMMAND, JUDGED ONE AT A TIME.
//
// The rows above prove that A published repin command runs. That is not the same property as EVERY
// published recovery command running, and the difference is the whole failure mode: a document can
// carry a correct, fully-pathed repin in one section and a bare `sthayi wire` in another, and a
// check that asks "does a good command exist?" is satisfied by the first while the reader who lands
// on the second is handed a command not found.
//
// So the scan below is PER OCCURRENCE. It walks every place a command can be published — every line
// of every fenced block, and every inline code span — and requires each recovery invocation to
// stand on its own. A correct command elsewhere in the file licenses nothing here.
//
// WHY THIS BITES AT ALL: none of the durable install routes puts the CLI on PATH. A `--prefix`
// install writes its shim under that prefix and touches no shell profile, and a local install
// leaves the binary in `node_modules/.bin` — so the command name typed alone runs only on the one
// route that happens to have a `bin` already on PATH, and a recovery instruction is read precisely
// by people whose wiring is already broken.
//
// NAMING A COMMAND IS NOT ISSUING ONE. "Removing Sthayi starts with `sthayi unwire`" identifies a
// subcommand; "just run `sthayi wire` again" tells a reader to type something. Only the second has
// to be runnable as typed, so an unpathed occurrence is allowed exactly where the surrounding
// sentence does not tell the reader to run it — and a fenced block line is always an instruction.
// -----------------------------------------------------------------------------------------------

/** The published surfaces this scan owns. Both are docs a reader recovers from. */
const RECOVERY_DOCS = ['README.md', 'SECURITY.md'] as const;

const docText = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

/** One command exactly as a doc publishes it, with the prose that introduces it. */
interface Published {
  /** What a reader would copy, whitespace-flattened (markdown hard-wraps inside spans too). */
  command: string;
  /** A fenced-block line is always an instruction; a span is judged by its introduction. */
  fenced: boolean;
  /** The flattened prose immediately before an inline span. */
  before: string;
}

/**
 * Every command a doc publishes, from both surfaces.
 *
 * Fenced blocks are lifted out FIRST and replaced by their own newlines, so the inline-span pass
 * cannot run its backtick pair across a fence marker — and so a span that hard-wraps mid-command
 * (`"%LOCALAPPDATA%\sthayi\sthayi.cmd"` on one line, `wire` on the next) is still collected whole,
 * which a newline-excluding span pattern silently drops.
 */
function publishedCommands(text: string): Published[] {
  const out: Published[] = [];
  const prose = text.replace(/```[^\n]*\n[\s\S]*?```/g, (block) => {
    for (const m of block.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
      for (const raw of (m[1] as string).split('\n')) {
        // trailing `#` comment and a `::`-commented cmd line are annotation, not the command
        const line = raw.replace(/\s+#.*$/, '').trim();
        if (line !== '' && !line.startsWith('#') && !line.startsWith('::')) {
          out.push({ command: line.replace(/\s+/g, ' '), fenced: true, before: '' });
        }
      }
    }
    return '\n'.repeat((block.match(/\n/g) ?? []).length);
  });
  for (const m of prose.matchAll(/`([^`]+)`/g)) {
    out.push({
      command: (m[1] as string).replace(/\s+/g, ' '),
      fenced: false,
      before: prose.slice(Math.max(0, m.index - 160), m.index).replace(/\s+/g, ' '),
    });
  }
  return out;
}

/**
 * An invocation of the CLI with one of the two RECOVERY verbs, capturing the binary AS WRITTEN.
 *
 * `init` is onboarding rather than recovery and is held to its own contract by
 * docs-onboarding-contract; `wire` and `unwire` are what a reader with broken wiring is sent to.
 */
const RECOVERY_INVOCATION =
  /(?:^|[\s"'(&])((?:[^\s"'(&]*[/\\])?sthayi(?:\.cmd)?)"?\s+((?:un)?wire)\b/g;

/** A binary that names a path is one a reader can run without anything being on PATH. */
const isPathed = (binary: string): boolean => /[/\\]/.test(binary);

/** Does the sentence introducing this span tell the reader to RUN it? Sentence-scoped: the window
 *  stops at the previous full stop, so an imperative two sentences back is not borrowed. */
const ISSUES_A_COMMAND =
  /\b(?:run|runs|re-?run|rerun|just|type|repin|repins|recoverable)\b[^.]{0,90}$/i;

describe('safety: every published recovery command runs as typed', () => {
  it('no doc issues an unpathed `wire`/`unwire` — scanned occurrence by occurrence', () => {
    for (const rel of RECOVERY_DOCS) {
      for (const entry of publishedCommands(docText(rel))) {
        RECOVERY_INVOCATION.lastIndex = 0;
        for (
          let m = RECOVERY_INVOCATION.exec(entry.command);
          m !== null;
          m = RECOVERY_INVOCATION.exec(entry.command)
        ) {
          const binary = m[1] as string;
          if (isPathed(binary)) {
            continue;
          }
          // Unpathed: legal only where the doc is NAMING the command, never where it issues it.
          const issued = entry.fenced || ISSUES_A_COMMAND.test(entry.before);
          expect(
            issued,
            `${rel} tells a reader to run \`${entry.command}\` — no durable install route puts \`${binary}\` on PATH, so this one is a command not found. A correct, fully-pathed recovery command elsewhere in the file does not make this occurrence runnable.${entry.fenced ? '' : ` Introduced by: "…${entry.before.slice(-90)}"`}`,
          ).toBe(false);
        }
      }
    }
  });

  it('no published `wire` anywhere names the state directory’s own launcher', () => {
    // The existing rule, lifted off one section and onto the whole document: that binary is pinned
    // at the entry a stale pin has already taken away, so it cannot reach code to run.
    for (const rel of RECOVERY_DOCS) {
      for (const entry of publishedCommands(docText(rel))) {
        RECOVERY_INVOCATION.lastIndex = 0;
        for (
          let m = RECOVERY_INVOCATION.exec(entry.command);
          m !== null;
          m = RECOVERY_INVOCATION.exec(entry.command)
        ) {
          if ((m[2] as string) !== 'wire') {
            continue;
          }
          expect(
            /(?:\.sthayi|STHAYI_HOME)[/\\]bin[/\\]sthayi/.test(m[1] as string),
            `${rel} repins with \`${entry.command}\` — the launcher in the state directory, which is the binary a stale pin has already broken`,
          ).toBe(false);
        }
      }
    }
  });

  it('the README publishes a runnable repin for each route it documents installing by', () => {
    // Route-specific, because the routes land the CLI in three different places. A reader on the
    // local-install route is not served by the headline route's shim path.
    const commands = publishedCommands(docText('README.md'))
      .map((e) => e.command)
      .filter((c) => {
        RECOVERY_INVOCATION.lastIndex = 0;
        return RECOVERY_INVOCATION.test(c);
      });
    const routes: readonly { name: string; re: RegExp }[] = [
      {
        name: 'the headline user-space prefix shim',
        re: /\$HOME\/\.local\/bin\/sthayi"?\s+wire\b/,
      },
      { name: 'a retained local install', re: /node_modules\/\.bin\/sthayi\s+wire\b/ },
      { name: 'the Windows shim that prefix produces', re: /sthayi\.cmd"?\s+wire\b/ },
    ];
    for (const route of routes) {
      expect(
        commands.some((c) => route.re.test(c)),
        `README.md publishes no runnable repin for ${route.name}: ${commands.join(' | ')}`,
      ).toBe(true);
    }
  });
});

/** An install as npm leaves it under a `--prefix`: the package beneath `lib/node_modules/sthayi`,
 *  and the command shim at `bin/sthayi` written as the relative symlink npm itself writes. */
interface Install {
  prefix: string;
  /** The CLI entry a launcher written from this install pins. */
  entry: string;
  /** The shim a user invokes — what `process.argv[1]` is, and what gets realpath'd to the entry. */
  cli: string;
}

function installAt(prefix: string): Install {
  const pkg = path.join(prefix, 'lib', 'node_modules', 'sthayi');
  fs.mkdirSync(pkg, { recursive: true });
  fs.copyFileSync(path.join(cliRoot, 'package.json'), path.join(pkg, 'package.json'));
  fs.cpSync(path.join(cliRoot, 'dist'), path.join(pkg, 'dist'), { recursive: true });
  fs.cpSync(path.join(cliRoot, 'prompts'), path.join(pkg, 'prompts'), { recursive: true });
  const bin = path.join(prefix, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const entry = path.join(pkg, 'dist', 'index.js');
  const cli = path.join(bin, 'sthayi');
  fs.symlinkSync(path.relative(bin, entry), cli);
  return { prefix, entry, cli };
}

/**
 * The runtime dependencies the built CLI statically imports, laid out flat the way npm hoists them.
 * ONE copy, planted ABOVE both prefixes: Node resolves a bare specifier by walking up from the
 * importing file, so both installs reach the same set without either owning it.
 *
 * `bindings` and `file-uri-to-path` are better-sqlite3's runtime transitives. If a future re-chunk
 * of the dist pulls another dependency into the static import graph, the spawns below fail with
 * MODULE_NOT_FOUND naming it — add it here.
 */
function plantDependencies(nodeModules: string): void {
  const cliNm = path.join(cliRoot, 'node_modules');
  const pnpmSibling = (realDir: string, name: string): string =>
    fs.realpathSync(path.join(path.dirname(realDir), name));
  const bsql = fs.realpathSync(path.join(cliNm, 'better-sqlite3'));
  const bindings = pnpmSibling(bsql, 'bindings');
  const deps: Record<string, string> = {
    commander: fs.realpathSync(path.join(cliNm, 'commander')),
    zod: fs.realpathSync(path.join(cliNm, 'zod')),
    ulid: fs.realpathSync(path.join(cliNm, 'ulid')),
    'jsonc-parser': fs.realpathSync(path.join(cliNm, 'jsonc-parser')),
    'smol-toml': fs.realpathSync(path.join(cliNm, 'smol-toml')),
    'better-sqlite3': bsql,
    bindings,
    'file-uri-to-path': pnpmSibling(bindings, 'file-uri-to-path'),
  };
  for (const [name, realDir] of Object.entries(deps)) {
    fs.cpSync(realDir, path.join(nodeModules, name), { recursive: true, dereference: true });
  }
}

/**
 * A hermetic child environment.
 *
 * `TMPDIR` is the child's OWN temp directory, so an install beside it is judged durable for the
 * reason a real one is — the durability refusal measures against `os.tmpdir()`, and a fixture cut
 * from the system temp root would be refused as ephemeral, which is a different diagnosis than the
 * one under test. `HOME` is a fixture so no real client config is ever read or written, and
 * `STHAYI_HOME` is set EXPLICITLY to a directory that is not `$HOME/.sthayi`.
 */
function childEnv(osHome: string, stateHome: string, tmp: string): NodeJS.ProcessEnv {
  return {
    // node for the shim's shebang, plus `env` and `bash` for the generated launcher.
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    TMPDIR: tmp,
    HOME: osHome,
    USERPROFILE: osHome,
    STHAYI_HOME: stateHome,
  };
}

const label = (r: SpawnSyncReturns<string>): string =>
  `--- stdout ---\n${r.stdout ?? ''}\n--- stderr ---\n${r.stderr ?? ''}`;

describe.skipIf(!posix)(
  'safety: a repin is run from the new install, never from the stale pin',
  () => {
    let base: string;

    beforeEach(() => {
      base = runTempDir('sthayi-repin-route-');
    });

    afterEach(() => {
      removeOwned(base); // teardown: the recorded allocation, never a pathname walk
      // A LEAKED FIXTURE IS SILENT. Every row above can pass while a state directory holding
      // launchers — and in other suites a vault key and a store — is stranded in the shared temp
      // root, because nothing that fails is what strands it: teardown correctly REFUSES an entry it
      // cannot account for, and a refusal is not an error. Only a census of the temp root would ever
      // find it. So the removal is asserted in the one place that can see it.
      expect(fs.existsSync(base), `${base} survived teardown`).toBe(false);
    });

    it('the documented command, run from the new install, moves both launchers onto the new entry', () => {
      ensureBuiltCli();
      const osHome = path.join(base, 'home');
      // A CUSTOM state directory, deliberately not `$HOME/.sthayi`.
      const stateHome = path.join(base, 'state');
      const tmp = path.join(base, 'tmp');
      for (const dir of [osHome, stateHome, tmp]) {
        fs.mkdirSync(dir, { mode: 0o700 });
      }
      // `<state>/bin` IS MADE HERE, not left to the spawned CLI. `writeLauncher()` accepts a `bin`
      // that already exists — it probes before it creates, precisely so a pre-existing directory is
      // judged rather than assumed — and making it here is what gives this run a creation record for
      // it. A directory a CHILD PROCESS creates is witnessed by nothing in this process, so teardown
      // would have no way to account for it and would rightly leave the whole state directory
      // standing. (The create-it-itself branch is covered by launcher-bin-identity.)
      fs.mkdirSync(path.join(stateHome, 'bin'), { mode: 0o700 });
      plantDependencies(path.join(osHome, 'node_modules'));

      // Two real installs of the built CLI, at two different durable prefixes. The second is the
      // headline route's own prefix, so the README's published command runs against it as typed.
      const stale = installAt(path.join(osHome, 'opt', 'sthayi-old'));
      const fresh = installAt(path.join(osHome, '.local'));
      const env = childEnv(osHome, stateHome, tmp);
      const cliLauncher = path.join(stateHome, 'bin', 'sthayi');
      const mcpLauncher = path.join(stateHome, 'bin', 'sthayi-mcp');
      const run = (exe: string, args: string[], cwd = osHome): SpawnSyncReturns<string> =>
        spawnSync(exe, args, { env, cwd, encoding: 'utf8', timeout: 180_000 });

      /**
       * Take a receipt for each launcher THE SPAWNED CLI JUST WROTE.
       *
       * `writeLauncher()` runs in a child process, so no binding in this process sees the create —
       * the entries are this run's own product output and yet are unaccountable to its teardown.
       * The claim reads the identity from a descriptor on the published name, which is the same
       * discipline the in-process launcher tests use for the same files.
       *
       * CALLED AFTER EVERY WRITE, not once: publication is a rename, so each `wire` puts a NEW inode
       * at the same name and a receipt naming the previous one would no longer authorise anything.
       */
      const claimLaunchers = (): void => {
        claimToolEntry(cliLauncher);
        claimToolEntry(mcpLauncher);
      };

      // 1. WIRED FROM THE FIRST INSTALL. Both launchers pin that install's entry pathname.
      const wired = run(stale.cli, ['wire']);
      claimLaunchers();
      expect(wired.status, label(wired)).toBe(0);
      for (const launcher of [cliLauncher, mcpLauncher]) {
        expect(fs.readFileSync(launcher, 'utf8'), launcher).toContain(stale.entry);
      }
      // The CUSTOM home is where they landed — the default one was never created.
      expect(fs.existsSync(path.join(osHome, '.sthayi'))).toBe(false);
      const before = run(cliLauncher, ['--version']);
      expect(before.status, label(before)).toBe(0);
      expect(before.stdout.trim(), label(before)).toBe(VERSION);

      // 2. THE PIN GOES STALE: the entry at the pathname the launchers name is gone. Nothing else has
      //    to happen — the launchers carry a pathname, and that pathname now holds nothing.
      fs.unlinkSync(stale.entry);
      fs.unlinkSync(stale.cli);

      // 3. AND THE LAUNCHERS ARE UNRUNNABLE — including for the very command an instruction to
      //    "repin with the launcher in your state directory" would have the reader type.
      const staleVersion = run(cliLauncher, ['--version']);
      expect(staleVersion.status, label(staleVersion)).not.toBe(0);
      const staleWire = run(cliLauncher, ['wire']);
      expect(staleWire.status, label(staleWire)).not.toBe(0);
      expect(fs.readFileSync(cliLauncher, 'utf8')).toContain(stale.entry);

      // 4. THE PUBLISHED REPIN, RUN AS TYPED, from the new install's own CLI path. `$HOME/.local` is
      //    the fixture prefix, so the README's line executes without being rewritten.
      const command = documentedHeadlineRepin();
      const repin = run('/bin/sh', ['-c', command]);
      claimLaunchers();
      expect(repin.status, `${command}\n${label(repin)}`).toBe(0);

      // 5. BOTH launchers now name the NEW entry, and neither still names the old one…
      for (const launcher of [cliLauncher, mcpLauncher]) {
        const body = fs.readFileSync(launcher, 'utf8');
        expect(body, launcher).toContain(fresh.entry);
        expect(body, launcher).not.toContain(stale.entry);
      }
      // …and the launcher runs again, out of the only install left on disk.
      const after = run(cliLauncher, ['--version']);
      expect(after.status, label(after)).toBe(0);
      expect(after.stdout.trim(), label(after)).toBe(VERSION);
      expect(fs.existsSync(path.join(osHome, '.sthayi'))).toBe(false);
    }, 600_000);
  },
);
