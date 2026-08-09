import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ephemeralEntryRefusal } from '../../packages/cli/src/clients/launcher.js';

/**
 * SAFETY-ADJACENT, AND A CLAIM ABOUT WHAT RUNS AFTER A FAILED INSTALL.
 *
 * Every published onboarding line does two things in order: install the package, then run the CLI
 * that install produced. The second half must not run when the first half fails.
 *
 * `&&` gives that for free, and Windows PowerShell 5.1 does not have `&&`. Its separator is `;`,
 * which sequences UNCONDITIONALLY: `npm install …; & "<prefix>\sthayi.cmd" init` runs the init half
 * whether the install succeeded, failed on a network error, or refused the prefix outright. What
 * that init half then invokes is whatever stands at that path — on a prefix where an install has
 * been attempted before, a shim from that attempt, pinned to an entry the failed install did not
 * refresh. The user sees an install error scroll past, then a command that appears to work.
 *
 * So the 5.1 line carries an explicit gate, and the rows below hold every published Windows line to
 * the same rule, in both directions: init runs on a successful install, and does not run on a
 * failed one.
 *
 * AN EXIT CODE ALONE IS NOT THE GATE. `$LASTEXITCODE` is set by NATIVE COMMANDS, and a command that
 * could not be RESOLVED never ran one: PowerShell raises CommandNotFoundException and
 * `$LASTEXITCODE` keeps whatever it already held. In a session where anything succeeded earlier
 * that value is 0 — so `npm` missing from PATH, the most ordinary Windows failure there is, passes
 * an exit-code-only gate on a STALE ZERO and the init half runs against whatever stands at the shim
 * path. The success state has to be read as well, and it has to be captured IMMEDIATELY after the
 * call, because the next statement overwrites it. That is the idiomatic 5.1 shape: `$ok = $?` on the
 * heels of the install, and a condition requiring BOTH.
 *
 * WHAT THESE ROWS ARE. The published lines are EVALUATED against the sequencing rules of the shells
 * they are written for — `&&` runs its right side only after a successful command; `;` sequences
 * unconditionally; `$LASTEXITCODE` carries the exit status of the last native command AND NOTHING
 * ELSE; `$?` carries whether the immediately preceding statement succeeded; an `if` block runs only
 * when its condition holds. No PowerShell or `cmd` process is started here, and no row is evidence
 * that any Windows host has executed these lines: Windows stays designed and unvalidated until
 * hosted Windows CI runs it. A string evaluated here is a claim about the LINE, never about a host.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readme = (): string => fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');

/** A published line, split into the install half and the half that follows it. */
interface Sequenced {
  install: string;
  /** The command the line runs after the install. */
  runs: string;
  /** Does the line run that second half only when the install exited zero? */
  conditional: boolean;
  /** Does it ALSO require the success state captured immediately after the call, so an install
   *  that never ran cannot let the second half through on a stale exit code? */
  guardsResolution: boolean;
}

/**
 * Split a published one-liner into its two halves and say what gates the second.
 *
 * Four shapes are recognised, and nothing else parses: `A && B` (conditional in every shell that has
 * `&&`, and inherently resolution-guarded — `&&` is driven by whether the command SUCCEEDED, and a
 * command that could not be resolved did not), `A; $ok = $?; if ($ok -and $LASTEXITCODE -eq 0) { B }`
 * (conditional and resolution-guarded), `A; if ($LASTEXITCODE -eq 0) { B }` (conditional on the exit
 * code alone), and a bare `A; B` (unconditional). An unrecognised shape returns undefined and the
 * rows below fail rather than pass silently.
 */
function parseLine(line: string): Sequenced | undefined {
  const trimmed = line.trim();
  const bothGates =
    /^(?<install>.+?)\s*;\s*\$(?<ok>\w+)\s*=\s*\$\?\s*;\s*if\s*\(\s*\$\k<ok>\s+-and\s+\$LASTEXITCODE\s+-eq\s+0\s*\)\s*\{\s*(?<then>.+?)\s*\}$/.exec(
      trimmed,
    );
  if (bothGates?.groups) {
    return {
      install: bothGates.groups.install as string,
      runs: bothGates.groups.then as string,
      conditional: true,
      guardsResolution: true,
    };
  }
  const gated =
    /^(?<install>.+?)\s*;\s*if\s*\(\s*\$LASTEXITCODE\s+-eq\s+0\s*\)\s*\{\s*(?<then>.+?)\s*\}$/.exec(
      trimmed,
    );
  if (gated?.groups) {
    return {
      install: gated.groups.install as string,
      runs: gated.groups.then as string,
      conditional: true,
      guardsResolution: false,
    };
  }
  const andand = /^(?<install>.+?)\s*&&\s*(?<then>.+)$/.exec(trimmed);
  if (andand?.groups) {
    return {
      install: andand.groups.install as string,
      runs: andand.groups.then as string,
      conditional: true,
      guardsResolution: true,
    };
  }
  const sequenced = /^(?<install>.+?)\s*;\s*(?<then>.+)$/.exec(trimmed);
  if (sequenced?.groups) {
    return {
      install: sequenced.groups.install as string,
      runs: sequenced.groups.then as string,
      conditional: false,
      guardsResolution: false,
    };
  }
  return undefined;
}

/**
 * What the shell can observe about the install half afterwards.
 *
 * TWO SIGNALS, AND THEY DISAGREE IN EXACTLY ONE CASE. `succeeded` is what `$?` reads immediately
 * after the call (and what `&&` is driven by); `lastExitCode` is what `$LASTEXITCODE` reads. A
 * command that RAN sets both. A command that could not be RESOLVED sets neither — `$?` is false and
 * `$LASTEXITCODE` still holds the value it had before, which in any session that has run something
 * successfully is 0.
 */
interface InstallOutcome {
  succeeded: boolean;
  lastExitCode: number;
}

/** An install that ran and exited with `code`. */
function ran(code: number): InstallOutcome {
  return { succeeded: code === 0, lastExitCode: code };
}

/** An install that never ran: the command could not be resolved, so `$LASTEXITCODE` is whatever the
 *  session already held — `stale`. */
function neverResolved(stale: number): InstallOutcome {
  return { succeeded: false, lastExitCode: stale };
}

/** Does the line's second half run, given what the install half left behind? */
function initRuns(line: Sequenced, outcome: InstallOutcome): boolean {
  if (!line.conditional) {
    return true;
  }
  if (line.guardsResolution && !outcome.succeeded) {
    return false;
  }
  return outcome.lastExitCode === 0;
}

/** Every indented command line the refusal offers. */
function routeCommands(message: string): string[] {
  return message
    .split('\n')
    .filter((l) => /^ {2}\S/.test(l))
    .map((l) => l.trim());
}

/** Strip the separately tested Node preflight so this evaluator sees npm -> init. */
function installSegment(line: string): string {
  const at = line.indexOf('npm install');
  expect(at, `route has no npm install: ${line}`).toBeGreaterThan(-1);
  return line.slice(at);
}

/** The Windows refusal text — the platform is a parameter, so a POSIX run can read it. */
function windowsRoutes(): string[] {
  return routeCommands(
    ephemeralEntryRefusal(
      'C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\deadbeef\\node_modules\\sthayi\\dist\\cli.js',
      'win32',
    ),
  );
}

/** The command inside every fenced block of the README that installs the package. */
function readmeInstallLines(): string[] {
  const out: string[] = [];
  const fence = /```([^\n]*)\n([\s\S]*?)```/g;
  for (let m = fence.exec(readme()); m !== null; m = fence.exec(readme())) {
    for (const line of (m[2] ?? '').split('\n')) {
      if (/npm install .*sthayi\b/.test(line)) {
        out.push(line.trim());
      }
    }
  }
  return out;
}

describe('safety: a failed install never runs the init half', () => {
  it('every published Windows route gates init on the install’s exit status', () => {
    const routes = windowsRoutes();
    expect(routes).toHaveLength(3);
    for (const route of routes) {
      const parsed = parseLine(installSegment(route));
      expect(parsed, `unrecognised sequencing in: ${route}`).toBeDefined();
      const line = parsed as Sequenced;
      expect(line.install, route).toMatch(/npm install/);
      expect(line.runs, route).toMatch(/init/);
      // The two directions, which together are the whole property.
      expect(initRuns(line, ran(0)), `${route} does not run init after a successful install`).toBe(
        true,
      );
      for (const failure of [1, 243]) {
        expect(initRuns(line, ran(failure)), `${route} runs init after a failed install`).toBe(
          false,
        );
      }
    }
  });

  it('every published Windows route survives an install that never RAN', () => {
    // `npm` missing from PATH is the ordinary Windows failure, and it is the one an exit code
    // cannot see: nothing native ran, so `$LASTEXITCODE` is untouched and reads as whatever the
    // session left there. A gate gets no signal from a variable the failure never wrote.
    for (const route of windowsRoutes()) {
      const line = parseLine(installSegment(route)) as Sequenced;
      expect(line, `unrecognised sequencing in: ${route}`).toBeDefined();
      for (const stale of [0, 1]) {
        expect(
          initRuns(line, neverResolved(stale)),
          `${route} runs init after an install that could not be resolved (stale $LASTEXITCODE ${stale})`,
        ).toBe(false);
      }
    }
  });

  it('the PowerShell 5.1 route gates without `&&`, which that shell does not have', () => {
    const ps51 = windowsRoutes().find((r) => r.includes('$nodeOk')) as string;
    expect(ps51, 'no PowerShell 5.1 route is published').toBeDefined();
    expect(ps51).not.toContain('&&');
    expect(ps51).toMatch(/\$LASTEXITCODE\s+-eq\s+0/);
    // The success state is CAPTURED IMMEDIATELY after the install and nowhere else: `$?` describes
    // the statement that just ran, so a capture even one statement later describes the capture.
    expect(ps51).toMatch(/sthayi@latest\s*;\s*\$\w+\s*=\s*\$\?\s*;/);
    expect(ps51).toMatch(
      /node -e "[^"]+";\s*\$(\w+)\s*=\s*\$\?;\s*if\s*\(\$\1\s+-and\s+\$LASTEXITCODE\s+-eq\s+0\)\s*\{\s*npm install/,
    );
    expect(installSegment(ps51)).toMatch(
      /;\s*\$(\w+)\s*=\s*\$\?;\s*if\s*\(\$\1\s+-and\s+\$LASTEXITCODE\s+-eq\s+0\)\s*\{\s*&[^}]+init\s*\}/,
    );
  });

  it('every README install line is gated too, and matches the line the CLI prints', () => {
    const published = readmeInstallLines();
    expect(published.length).toBeGreaterThanOrEqual(4); // POSIX + three Windows shells
    for (const line of published) {
      // An upgrade-only line invokes no Sthayi command after npm, so there is no second half to
      // sequence. Keep that exception exact: first-install lines still have to parse below.
      if (!/\binit\b/.test(line)) {
        continue;
      }
      const parsed = parseLine(installSegment(line));
      expect(parsed, `unrecognised sequencing in README line: ${line}`).toBeDefined();
      const sequenced = parsed as Sequenced;
      if (!/init/.test(sequenced.runs)) {
        continue; // an upgrade line, which runs no CLI afterwards
      }
      expect(
        initRuns(sequenced, ran(1)),
        `README line runs init after a failed install: ${line}`,
      ).toBe(false);
    }
    // The README and the refusal must not drift apart: each Windows route the CLI prints is a line
    // the README publishes verbatim.
    for (const route of windowsRoutes()) {
      expect(published, `README does not publish the route the CLI prints: ${route}`).toContain(
        route,
      );
    }
  });

  it('the README says what the 5.1 gate is for', () => {
    const text = readme().replace(/\s+/g, ' ');
    expect(text).toMatch(/\$LASTEXITCODE/);
    expect(text).toMatch(/PowerShell 5\.1[^.]{0,200}(?:no|not have) `?&&`?/i);
  });

  it('CONTROL — an ungated `;` line is reported as running init after a failure', () => {
    // The rows above are only worth something if the evaluation can tell the two shapes apart.
    const ungated = parseLine(
      'npm install -g --prefix "$env:LOCALAPPDATA\\sthayi" sthayi; & "$env:LOCALAPPDATA\\sthayi\\sthayi.cmd" init',
    ) as Sequenced;
    expect(ungated).toBeDefined();
    expect(ungated.conditional).toBe(false);
    expect(initRuns(ungated, ran(1))).toBe(true);
    expect(initRuns(ungated, ran(0))).toBe(true);
  });

  it('CONTROL — an exit-code-only gate is reported as running init on a stale zero', () => {
    // The row about an install that never ran is only worth something if the evaluation can tell
    // the two gates apart: this is the shape it must catch, evaluated here so the difference
    // between "gated" and "gated on both signals" is visible rather than asserted.
    const exitCodeOnly = parseLine(
      'npm install -g --prefix "$env:LOCALAPPDATA\\sthayi" sthayi; if ($LASTEXITCODE -eq 0) { & "$env:LOCALAPPDATA\\sthayi\\sthayi.cmd" init }',
    ) as Sequenced;
    expect(exitCodeOnly).toBeDefined();
    expect(exitCodeOnly.conditional).toBe(true);
    expect(exitCodeOnly.guardsResolution).toBe(false);
    // It holds against an install that RAN and failed…
    expect(initRuns(exitCodeOnly, ran(1))).toBe(false);
    // …and lets init through when the install never ran at all and the stale value happens to be 0.
    expect(initRuns(exitCodeOnly, neverResolved(0))).toBe(true);
  });
});
