import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ephemeralEntryRefusal, renderLauncher } from '../../packages/cli/src/clients/launcher.js';
import { type FakeHome, createFakeHome } from '../helpers/fake-home.js';
import { removeOwned } from '../helpers/owned-fs.js';
import { claimToolEntry } from '../helpers/owned-fs.js';
import { runTempDir } from '../helpers/run-temp.js';

/**
 * SAFETY-ADJACENT, AND A CORRECTNESS CLAIM ABOUT WHAT STHAYI TELLS PEOPLE TO TYPE.
 *
 * The refusal an ephemeral install earns is the only instruction most users will get, and a refusal
 * that hands out a command which does not run is a refusal that strands them. What is asserted here
 * cannot be established by reading the string:
 *
 *   1. THE ROUTE RUNS AS TYPED, to the end. The printed line is EXECUTED verbatim in bash against a
 *      stub `npm` that lays down exactly the files the real one would, and the sthayi it ends up
 *      invoking has to actually run.
 *   2. THE INSTALL IS SCOPED, ALWAYS. A bare `npm install -g sthayi` installs into whatever prefix
 *      npm is configured for, and where that prefix is root-owned it fails EACCES — so it is never
 *      presented as the answer, in any branch. The stub refuses an unscoped global install the same
 *      way the real npm does, which is what keeps row 1 from passing on a command that only works
 *      on machines like this one.
 *   3. ONE PLATFORM, AND ONE SHELL PER LINE. A POSIX user is shown the POSIX line and nothing else;
 *      the Windows text (reachable because the platform is a parameter) carries one line per shell,
 *      each labelled, and no line mixes two shells' syntax.
 *   4. NO PRIVILEGE ESCALATION IS EVER NAMED, in any branch.
 *
 * THE WINDOWS ROUTES ARE ASSERTED FOR SHAPE, NOT EXECUTED. Nothing here runs PowerShell or `cmd`,
 * and no row should be read as evidence that those lines have been run anywhere.
 */

const posix = process.platform !== 'win32';
const notRoot = typeof process.getuid !== 'function' || process.getuid() !== 0;

/**
 * A stub `npm` that performs only what the printed route asks of it, and lays down the same files
 * the real one would.
 *
 * IT ALSO FAILS THE WAY THE REAL ONE FAILS. An unscoped `-g` install goes to the configured prefix,
 * which on a great many machines is root-owned, and npm exits non-zero rather than installing. The
 * stub does the same, so a message that ever went back to offering the bare form would be caught by
 * the row that EXECUTES what it prints instead of quietly passing here.
 */
const NPM_STUB = `#!/usr/bin/env bash
set -euo pipefail
shim() {
  mkdir -p "$(dirname "$1")"
  printf '#!/usr/bin/env bash\\necho "RAN sthayi $*"\\n' > "$1"
  chmod 755 "$1"
}
case "\${1:-}" in
  install|i)
    shift
    prefix=""
    global=0
    while [ $# -gt 0 ]; do
      case "$1" in
        -g|--global) global=1 ;;
        --prefix) prefix="\${2:-}"; shift ;;
        --prefix=*) prefix="\${1#--prefix=}" ;;
      esac
      shift
    done
    if [ "$global" = 1 ]; then
      if [ -z "$prefix" ]; then
        echo "npm ERR! code EACCES" >&2
        exit 243
      fi
      shim "$prefix/bin/sthayi"
    else
      shim "node_modules/.bin/sthayi"
    fi
    ;;
esac
exit 0
`;

const POSIX_INSTALL_ROUTE =
  'npm install -g --prefix "$HOME/.local" sthayi && "$HOME/.local/bin/sthayi" init';
const UNSCOPED_CONTROL_ROUTE = 'npm install -g sthayi && sthayi init';

/** The refusal text for an ephemeral entry, taken from the real refusal path. */
function refusalFor(entry: string): string {
  try {
    renderLauncher({ cliEntry: entry });
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error(`renderLauncher did not refuse ${entry}`);
}

/** The indented command lines the message offers. */
function routeCommands(message: string): string[] {
  return message.split('\n').filter((l) => /^ {2}\S/.test(l));
}

describe.skipIf(!posix)(
  'safety: the ephemeral-install refusal tells people something that works',
  () => {
    let home: FakeHome;
    let scratch: string;
    let entry: string;
    const savedPrefix = process.env.npm_config_prefix;

    beforeEach(() => {
      home = createFakeHome();
      scratch = runTempDir('sthayi-refusal-');
      entry = path.join(scratch, 'cache', 'node_modules', 'sthayi', 'dist', 'index.js');
      fs.mkdirSync(path.dirname(entry), { recursive: true });
      fs.writeFileSync(entry, '// an ephemeral entry\n');
    });

    afterEach(() => {
      if (savedPrefix === undefined) {
        // biome-ignore lint/performance/noDelete: assigning undefined coerces to the string "undefined"
        delete process.env.npm_config_prefix;
      } else {
        process.env.npm_config_prefix = savedPrefix;
      }
      // the ownership-aware teardown, never a recursive primitive handed a pathname
      removeOwned(scratch);
      home.cleanup();
    });

    let made = 0;
    /**
     * A uniquely named directory inside the fixture.
     *
     * `mkdirSync`, never `mkdtempSync`: the harness records the directories a run CREATES, and that
     * record is the only authority its teardown ever has. A `mkdtemp` directory carries no such
     * record, so teardown would reach it, find nothing vouching for it, and leak the whole tree
     * rather than delete on the strength of a pathname.
     */
    function freshDir(name: string): string {
      made += 1;
      const dir = path.join(scratch, `${name}-${made}`);
      fs.mkdirSync(dir);
      return dir;
    }

    /** A prefix directory the message will read, at the mode the branch under test needs. One
     *  directory per mode, so no branch ever has to remove another branch’s. */
    function usePrefix(mode: number): string {
      const prefix = path.join(scratch, `npm-prefix-${mode.toString(8)}`);
      if (!fs.existsSync(prefix)) {
        fs.mkdirSync(prefix, { mode });
      }
      process.env.npm_config_prefix = prefix;
      return prefix;
    }

    /**
     * Force the branch that runs when npm's prefix cannot be read at all: no `npm_config_prefix`, a
     * HOME with no `.npmrc` in it, and a node whose location says nothing (a relative execPath).
     */
    function withUnreadablePrefix<T>(act: () => T): T {
      const savedHome = process.env.HOME;
      const savedExec = process.execPath;
      // biome-ignore lint/performance/noDelete: assigning undefined coerces to the string "undefined"
      delete process.env.npm_config_prefix;
      process.env.HOME = freshDir('nohome');
      Object.defineProperty(process, 'execPath', {
        value: 'node',
        configurable: true,
        writable: true,
      });
      try {
        return act();
      } finally {
        Object.defineProperty(process, 'execPath', {
          value: savedExec,
          configurable: true,
          writable: true,
        });
        if (savedHome === undefined) {
          // biome-ignore lint/performance/noDelete: assigning undefined coerces to the string "undefined"
          delete process.env.HOME;
        } else {
          process.env.HOME = savedHome;
        }
      }
    }

    /** One message per branch: writable prefix, unwritable prefix, unreadable prefix. */
    function everyBranch(): string[] {
      const out: string[] = [];
      for (const mode of [0o700, 0o500]) {
        if (mode === 0o500 && !notRoot) {
          continue;
        }
        usePrefix(mode);
        out.push(refusalFor(entry));
      }
      out.push(withUnreadablePrefix(() => refusalFor(entry)));
      return out;
    }

    it('names no privilege escalation, in any branch', () => {
      for (const message of everyBranch()) {
        expect(message).not.toMatch(/\bsudo\b/i);
        expect(message).not.toMatch(/\bdoas\b|\brunas\b|administrator|\bas root\b/i);
        expect(message).toMatch(/no elevated privileges/);
      }
    });

    it('never offers a bare unscoped global install, in any branch', () => {
      // The route that fails EACCES on a root-owned prefix. It is not "the quickstart with a
      // caveat" — it is a command that cannot run for a large share of users, so it is not printed.
      for (const message of everyBranch()) {
        for (const command of routeCommands(message)) {
          expect(command).toContain('--prefix');
        }
        expect(message).not.toMatch(/npm install -g sthayi\b/);
        expect(message).not.toMatch(/npm i(?:nstall)? -g\s+sthayi/);
      }
    });

    it('prints the SAME scoped route whatever npm’s prefix turns out to be', () => {
      // Situation-awareness is retained as a STATEMENT about the machine, not as a branch between
      // routes: the scoped install is correct in all three cases, so all three print it.
      const routes = everyBranch().map((m) => routeCommands(m));
      for (const commands of routes) {
        expect(commands).toEqual([`  ${POSIX_INSTALL_ROUTE}`]);
      }
    });

    it('still reads npm’s prefix and says what it found', () => {
      const writable = usePrefix(0o700);
      expect(refusalFor(entry)).toContain(writable);
      if (notRoot) {
        const locked = usePrefix(0o500);
        const message = refusalFor(entry);
        expect(message).toContain(locked);
        expect(message).toMatch(/cannot write/);
      }
      expect(withUnreadablePrefix(() => refusalFor(entry))).toMatch(/could not be read here/);
    });

    it('shows a POSIX user the POSIX shell only', () => {
      for (const message of everyBranch()) {
        expect(routeCommands(message)).toHaveLength(1);
        expect(message).not.toContain('LOCALAPPDATA');
        expect(message).not.toContain('PowerShell');
        expect(message).not.toContain('sthayi.cmd');
      }
    });

    /**
     * EXECUTE the route, verbatim, and require the sthayi it ends on to run.
     *
     * The route gets its own HOME so `~/.local` starts clean, a stub `npm` on PATH, and the default
     * global bin on PATH exactly as a real global install would have it.
     */
    function runRoute(command: string): { status: number | null; out: string } {
      const box = freshDir('route');
      const fakeHome = path.join(box, 'home');
      const defaultPrefix = path.join(box, 'prefix');
      const stubDir = path.join(box, 'stub');
      fs.mkdirSync(fakeHome);
      fs.mkdirSync(path.join(defaultPrefix, 'bin'), { recursive: true });
      fs.mkdirSync(path.join(fakeHome, '.local', 'bin'), { recursive: true });
      fs.mkdirSync(stubDir);
      fs.writeFileSync(path.join(stubDir, 'npm'), NPM_STUB, { mode: 0o755 });
      fs.chmodSync(path.join(stubDir, 'npm'), 0o755);

      const options = {
        encoding: 'utf8',
        cwd: fakeHome,
        env: {
          PATH: `${stubDir}:${path.join(defaultPrefix, 'bin')}:/usr/bin:/bin`,
          HOME: fakeHome,
        },
      } as const;
      // Execute only the two literal scripts this test owns. The equality gate still proves the
      // user-facing route is byte-for-byte the expected command, while no dynamic text reaches
      // bash's command argument.
      const normalized = command.trim();
      const r =
        normalized === POSIX_INSTALL_ROUTE
          ? spawnSync('bash', ['-c', POSIX_INSTALL_ROUTE], options)
          : normalized === UNSCOPED_CONTROL_ROUTE
            ? spawnSync('bash', ['-c', UNSCOPED_CONTROL_ROUTE], options)
            : (() => {
                throw new Error(`refusing to execute an unexpected route: ${command}`);
              })();
      // The route installs through a stub `npm` written in bash, whose syscalls arrive outside
      // every binding this process wraps. The stub publishes one launcher per bin directory and
      // those two entries are named here, so teardown has a basis for removing exactly them.
      claimToolEntry(path.join(defaultPrefix, 'bin', 'sthayi'));
      claimToolEntry(path.join(fakeHome, '.local', 'bin', 'sthayi'));
      return { status: r.status, out: `${r.stdout}${r.stderr}` };
    }

    it('the route the message prints runs as typed, all the way to `sthayi init`', () => {
      for (const mode of [0o700, 0o500]) {
        if (mode === 0o500 && !notRoot) {
          continue;
        }
        usePrefix(mode);
        const commands = routeCommands(refusalFor(entry));
        expect(commands).toHaveLength(1);
        for (const command of commands) {
          const { status, out } = runRoute(command);
          expect(status, `${command}\n${out}`).toBe(0);
          expect(out, `${command}\n${out}`).toContain('RAN sthayi init');
        }
      }
    });

    it('CONTROL — the stub really does refuse an unscoped global install', () => {
      // Without this, the row above would pass just as happily on a message that printed the bare
      // form: the assertion "it runs" is only worth something if a command that should NOT run
      // demonstrably fails here.
      const { status, out } = runRoute(UNSCOPED_CONTROL_ROUTE);
      expect(status, out).not.toBe(0);
      expect(out).not.toContain('RAN sthayi init');
    });
  },
);

/**
 * The Windows text, asserted from a POSIX run because the platform is a PARAMETER — the same reason
 * assertLauncherSafe and launcherBodyDeviation take one. Guidance only one platform can produce is
 * guidance only one platform can check, and Windows is the platform least likely to be the one the
 * suite is running on.
 *
 * SHAPE ONLY. Nothing here executes PowerShell or `cmd`; these rows say what the lines ARE, never
 * that they have been run.
 */
describe('safety: the Windows install guidance is per-shell and never mixed', () => {
  /** The Windows refusal for an npx-cache entry — the same text renderLauncher raises there. */
  function windowsRefusal(): string {
    return ephemeralEntryRefusal(
      'C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\deadbeef\\node_modules\\sthayi\\dist\\cli.js',
      'win32',
    );
  }

  it('prints one labelled line per Windows shell, and no POSIX line', () => {
    const message = windowsRefusal();
    const commands = routeCommands(message);
    expect(commands).toHaveLength(3);
    expect(message).toContain('PowerShell 7:');
    expect(message).toContain('PowerShell 5.1');
    expect(message).toContain('cmd:');
    expect(message).not.toContain('$HOME');
    expect(message).not.toContain('~/.local');
  });

  it('never mixes two shells’ syntax in one line, and 5.1 never uses `&&`', () => {
    const [ps7, ps51, cmd] = routeCommands(windowsRefusal()) as [string, string, string];
    for (const line of [ps7, ps51]) {
      expect(line).toContain('$env:LOCALAPPDATA');
      expect(line).not.toContain('%LOCALAPPDATA%');
    }
    expect(cmd).toContain('%LOCALAPPDATA%');
    expect(cmd).not.toContain('$env:');
    expect(ps7).toContain('&&');
    // PowerShell 5.1 has no `&&` at all — a line carrying one is a line that does not run there.
    expect(ps51).not.toContain('&&');
    expect(ps51).toContain(';');
  });

  it('scopes the install and names no privilege escalation', () => {
    const message = windowsRefusal();
    for (const command of routeCommands(message)) {
      expect(command).toContain('--prefix');
    }
    expect(message).not.toMatch(/\bsudo\b|\brunas\b|administrator/i);
    expect(message).not.toMatch(/npm install -g sthayi\b/);
  });

  it('claims nothing about having been tested', () => {
    // These lines are designed, not exercised. The message must not suggest otherwise.
    expect(windowsRefusal()).not.toMatch(/tested|verified|validated|known to work/i);
  });
});
