import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { launcherHealth, launcherScriptBody } from '../../packages/cli/src/clients/launcher.js';
import { type FakeHome, createFakeHome } from '../helpers/fake-home.js';
import { removeOwned } from '../helpers/owned-fs.js';
import { runTempDir } from '../helpers/run-temp.js';

/**
 * SAFETY-ADJACENT, AND A CLAIM ABOUT WHAT AN UPGRADE ACTUALLY DOES.
 *
 * A launcher pins a NODE PATH and an ENTRY PATHNAME. It carries no version, reads no manifest, and
 * compares nothing at launch: it executes whatever file stands at the pathname it names, each time
 * it runs. Two consequences follow, and the published upgrade guidance has to state both.
 *
 *   - REINSTALLING AT THE SAME PREFIX TAKES EFFECT AT THE NEXT LAUNCH. The entry pathname does not
 *     move, so the launchers run the new code without being touched. Describing them as pinning a
 *     version tells a reader the opposite — that the old code keeps running until they repin — and
 *     a reader who believes it will not look for the new behaviour they are already getting.
 *   - REPINNING IS FOR A MOVED ENTRY. An install at a different prefix, a different route, or a
 *     removed package leaves the pathname pointing at something that is no longer there.
 *
 * And removing the package does not remove the launchers: `~/.sthayi/bin/sthayi-mcp` and
 * `~/.sthayi/bin/sthayi` are in the state directory, which no uninstall touches, so they stay on
 * disk pinned at an entry that is gone. `unwire` removes the CLIENT REFERENCES to them; the files
 * themselves are the user's to keep or remove.
 *
 * WHICH MAKES THE ROUTE PART OF THE CLAIM. A launcher pinned at a moved entry is unrunnable, so a
 * repin — and every pre-uninstall `doctor`/`unwire` — has to be invoked from the install's OWN CLI
 * path. Naming the state directory's launcher there names the one binary the reader's situation has
 * already broken. And the state directory is `$STHAYI_HOME` wherever one is configured, so
 * `~/.sthayi/bin` is a default rather than a location any instruction may hardcode.
 *
 * The first rows EXECUTE a generated launcher to establish the property; the rest hold the
 * published text to it — on every authoritative surface, not the README alone.
 * tests/safety/launcher-repin-route.test.ts then EXECUTES the published repin end to end.
 */

const posix = process.platform !== 'win32';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readme = (): string => fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');

/** A named section of the README, up to the next top-level heading. */
function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  expect(start, `${heading} is missing`).toBeGreaterThan(-1);
  const end = text.indexOf('\n## ', start + 1);
  return text.slice(start, end === -1 ? undefined : end);
}

const flatten = (text: string): string => text.replace(/\s+/g, ' ');

describe.skipIf(!posix)('safety: a launcher pins a pathname, and the docs say so', () => {
  let scratch: string;

  beforeEach(() => {
    scratch = runTempDir('sthayi-upgrade-truth-');
  });

  afterEach(() => {
    removeOwned(scratch); // teardown: the recorded allocation, never a pathname walk
  });

  it('the code a launcher runs changes the moment the entry at its pathname changes', () => {
    const entry = path.join(scratch, 'install', 'dist', 'index.js');
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, 'process.stdout.write("FIRST INSTALL\\n");\n');

    const launcher = path.join(scratch, 'sthayi');
    const body = launcherScriptBody(process.execPath, entry, false, 'linux');
    fs.writeFileSync(launcher, body, { mode: 0o755 });
    fs.chmodSync(launcher, 0o755);

    const first = spawnSync(launcher, [], { encoding: 'utf8' });
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain('FIRST INSTALL');

    // The reinstall: the same pathname, different bytes. The launcher is not touched.
    fs.writeFileSync(entry, 'process.stdout.write("REINSTALLED\\n");\n');
    const second = spawnSync(launcher, [], { encoding: 'utf8' });

    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain('REINSTALLED');
    expect(second.stdout).not.toContain('FIRST INSTALL');
    // …and the launcher really is byte-identical: nothing repinned it.
    expect(fs.readFileSync(launcher, 'utf8')).toBe(body);
  });

  it('a launcher whose entry is gone is reported as stale, not as healthy', () => {
    // What "dangling" means in practice: the file is still there, and what it points at is not.
    const home: FakeHome = createFakeHome();
    try {
      // The install sits under the home so it is judged durable: a path in the system temp
      // directory is refused as ephemeral, which is a different diagnosis than the one under test.
      const entry = home.path('install', 'dist', 'index.js');
      fs.mkdirSync(path.dirname(entry), { recursive: true });
      fs.writeFileSync(entry, 'process.stdout.write("installed\\n");\n');
      fs.mkdirSync(home.path('bin'), { recursive: true });
      fs.writeFileSync(
        home.path('bin', 'sthayi-mcp'),
        launcherScriptBody(process.execPath, entry, true, 'linux'),
        { mode: 0o755 },
      );
      fs.writeFileSync(
        home.path('bin', 'sthayi'),
        launcherScriptBody(process.execPath, entry, false, 'linux'),
        { mode: 0o755 },
      );
      expect(launcherHealth().ok).toBe(true);

      // The install goes away one entry at a time — a recursive primitive decides its whole walk
      // inside the call, from a pathname, which is the shape this suite refuses everywhere.
      fs.unlinkSync(entry);
      fs.rmdirSync(path.dirname(entry));
      fs.rmdirSync(path.dirname(path.dirname(entry)));

      const health = launcherHealth();
      expect(health).toMatchObject({ ok: false, state: 'stale-target' });
      expect(health.detail).toContain(entry);
      // The launcher file itself is untouched by the removal of what it pins.
      expect(fs.existsSync(home.path('bin', 'sthayi-mcp'))).toBe(true);
      expect(fs.existsSync(home.path('bin', 'sthayi'))).toBe(true);
    } finally {
      home.cleanup();
    }
  });

  it('the README does not say a launcher pins a version', () => {
    const upgrade = flatten(section(readme(), '## Upgrade & uninstall'));
    expect(upgrade).not.toMatch(/pins? the installed version/i);
    expect(upgrade).not.toMatch(/pins? a version/i);
    expect(upgrade).not.toMatch(/keeps running the install it was written against/i);
  });

  it('the README says what a launcher pins, and that a same-prefix reinstall takes effect at once', () => {
    const upgrade = flatten(section(readme(), '## Upgrade & uninstall'));
    expect(upgrade).toMatch(/pathname|path it names|entry path/i);
    expect(upgrade).toMatch(
      /(?:same prefix|same pathname|same path|in place)[^.]{0,200}(?:immediately|next launch|straight away)/i,
    );
    // …and repinning is named as the answer to a MOVED entry, not to a version bump.
    expect(upgrade).toMatch(/repin[^.]{0,200}(?:moved|different prefix|another route|elsewhere)/i);
  });

  it('the README discloses that an uninstall leaves both launchers dangling', () => {
    const upgrade = flatten(section(readme(), '## Upgrade & uninstall'));
    expect(upgrade).toMatch(/npm uninstall/);
    expect(upgrade).toMatch(/dangling/i);
    expect(upgrade).toContain('~/.sthayi/bin/sthayi-mcp');
    expect(upgrade).toContain('~/.sthayi/bin/sthayi');
    // unwire removes the CLIENT references; the launcher files are not client config.
    expect(upgrade).toMatch(/unwire[^.]{0,240}(?:client|config)/i);
    expect(upgrade).toMatch(/doctor[^.]{0,240}stale/i);
  });
});

// ---------------------------------------------------------------------------------------------
// The same claim, on EVERY authoritative surface — and the route that follows from it.
// ---------------------------------------------------------------------------------------------

/** Every published surface allowed to describe what a launcher pins or how one is repinned. */
const AUTHORITATIVE_DOCS = [
  'README.md',
  'SECURITY.md',
  'docs/RELEASE.md',
  'docs/sthayi-v0-spec.md',
];

/**
 * The surfaces that publish WHERE the launchers live, as a location a reader acts on. SECURITY.md
 * is deliberately not among them: it names `~/.sthayi/bin/sthayi-mcp` once, as a hijack TARGET in
 * the threat model, and never as a path to invoke or to look in.
 */
const LAUNCHER_LOCATION_DOCS = ['README.md', 'docs/RELEASE.md', 'docs/sthayi-v0-spec.md'];

const doc = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

/** Every `.ts` file the CLI package ships from — its comments are read as statements of behaviour. */
function cliSourceFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && full.endsWith('.ts')) {
        found.push(full);
      }
    }
  };
  walk(path.join(repoRoot, 'packages', 'cli', 'src'));
  return found;
}

/** Describing a launcher as carrying a VERSION — it carries a pathname, and compares nothing. */
const VERSION_CLAIMS: readonly RegExp[] = [
  /version[- ]pinned/i,
  /no version drift/i,
  /pins? an? (?:installed )?version/i,
  /pins? the installed version/i,
];

/**
 * The state directory's launcher, invoked with a command a stale pin has already made impossible.
 *
 * `sthayi-mcp` is deliberately not matched: the optional quote and the required whitespace after
 * the name are what separate `…/bin/sthayi wire` from the MCP launcher's filename.
 */
const STATE_LAUNCHER_COMMAND =
  /(?:~\/\.sthayi|\$STHAYI_HOME|\$HOME\/\.sthayi)\/bin\/sthayi"?\s+(?:wire|unwire|doctor)\b/;

/** A repin invoked from an install's own CLI path — the only route that can still run. */
const NEW_INSTALL_ROUTE =
  /(?:"\$HOME\/\.local\/bin\/sthayi"|\.\/node_modules\/\.bin\/sthayi)\s+wire\b/;

const flatDoc = (rel: string): string => flatten(doc(rel));

describe('safety: every authoritative source says a launcher pins a pathname', () => {
  it('no published doc attributes a version to a launcher', () => {
    for (const rel of [...AUTHORITATIVE_DOCS, 'demo.tape']) {
      const text = flatDoc(rel);
      for (const claim of VERSION_CLAIMS) {
        expect(
          claim.test(text),
          `${rel} describes a launcher as carrying a version: ${claim}`,
        ).toBe(false);
      }
    }
  });

  it('no shipped CLI source describes the launcher as version-pinned either', () => {
    // The comment beside the write is as authoritative as the spec: it is what the next reader of
    // that code believes the file it produces does.
    for (const file of cliSourceFiles()) {
      const text = flatten(fs.readFileSync(file, 'utf8'));
      for (const claim of VERSION_CLAIMS) {
        expect(
          claim.test(text),
          `${path.relative(repoRoot, file)} describes a launcher as carrying a version: ${claim}`,
        ).toBe(false);
      }
    }
  });

  it('no doc repins, unwires or diagnoses through the launcher in the state directory', () => {
    // That file is pinned at the OLD entry path. A moved install is exactly the situation these
    // three commands are reached for, and exactly the situation in which it cannot run.
    for (const rel of [...AUTHORITATIVE_DOCS, 'demo.tape']) {
      const text = flatDoc(rel);
      const hit = STATE_LAUNCHER_COMMAND.exec(text);
      expect(
        hit,
        `${rel} invokes the state directory's launcher for a command a stale pin has already ` +
          `broken: ${text.slice(Math.max(0, (hit?.index ?? 0) - 100), (hit?.index ?? 0) + 120)}`,
      ).toBeNull();
    }
  });

  it('every doc that documents repinning names an install’s own CLI path', () => {
    for (const rel of AUTHORITATIVE_DOCS) {
      const text = flatDoc(rel);
      if (!/repin/i.test(text)) {
        continue;
      }
      expect(
        NEW_INSTALL_ROUTE.test(text),
        `${rel} documents repinning without naming the CLI path to run \`wire\` from`,
      ).toBe(true);
    }
  });

  it('the README’s pre-uninstall steps run from the install that is about to be removed', () => {
    const uninstall = section(readme(), '## Upgrade & uninstall');
    const from = uninstall.indexOf('**Uninstalling');
    expect(from, 'the README has no uninstall step list').toBeGreaterThan(-1);
    const open = uninstall.indexOf('```bash', from);
    expect(open).toBeGreaterThan(-1);
    const steps = uninstall.slice(open, uninstall.indexOf('```', open + 7));

    expect(steps, 'the uninstall block does not run doctor from the install’s own path').toContain(
      '"$HOME/.local/bin/sthayi" doctor',
    );
    expect(steps, 'the uninstall block does not run unwire from the install’s own path').toContain(
      '"$HOME/.local/bin/sthayi" unwire',
    );
    // …and never through the state directory, whose launcher a moved install has already stranded.
    expect(STATE_LAUNCHER_COMMAND.test(steps)).toBe(false);
    // The other route a reader may be standing in is named too, by its own path.
    expect(steps).toContain('./node_modules/.bin/sthayi doctor');
    expect(steps).toContain('./node_modules/.bin/sthayi unwire');
  });

  it('every doc that publishes the launcher location publishes the configurable form too', () => {
    // `~/.sthayi/bin` is the DEFAULT, and a reader who has set `$STHAYI_HOME` will not find a
    // launcher there at all. Naming the variable somewhere else in the document does not fix a
    // printed path: the alternative spelling has to stand beside the default one.
    for (const rel of LAUNCHER_LOCATION_DOCS) {
      const text = flatDoc(rel);
      if (!/~\/\.sthayi\/bin/.test(text)) {
        continue;
      }
      expect(
        /\$STHAYI_HOME\/bin/.test(text),
        `${rel} publishes ~/.sthayi/bin as the launcher location without the $STHAYI_HOME/bin form`,
      ).toBe(true);
    }
  });

  it('every doc that names the launcher directory says the home is configurable', () => {
    // `~/.sthayi/bin` is where the launchers land by DEFAULT. `$STHAYI_HOME` moves them, so a doc
    // that prints the default without saying so is publishing a path that is wrong for that reader.
    for (const rel of AUTHORITATIVE_DOCS) {
      const text = flatDoc(rel);
      if (!/~\/\.sthayi\/bin/.test(text)) {
        continue;
      }
      expect(
        /STHAYI_HOME/.test(text),
        `${rel} names ~/.sthayi/bin without saying the home is $STHAYI_HOME where one is set`,
      ).toBe(true);
    }
  });
});
