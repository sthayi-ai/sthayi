import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ISOLATED_WINDOWS_CI_TEST_JOB_ENV,
  isIsolatedWindowsCiTestJob,
} from '../helpers/build-cli.js';

/**
 * SAFETY: A WORKFLOW THAT CANNOT BOOTSTRAP ITSELF GATES NOTHING.
 *
 * Every claim this repository makes about its own correctness — the safety suite, the keyless
 * matrix, the tarball gate — is made by a CI job. A job that dies before it has a toolchain makes
 * none of them, and it dies in a way that reads like infrastructure noise rather than a broken
 * gate.
 *
 * Two ordering assumptions had exactly that shape, and this file forbids both:
 *
 *   1. `corepack enable` ran BEFORE `actions/setup-node`. Corepack is a shim distributed with
 *      (some) Node builds, so running it first asks the RUNNER IMAGE's Node for a package manager
 *      — on an image that ships no Corepack the step fails outright, and on an image whose Node
 *      differs from the one the job is about to install it enables a shim for the wrong runtime.
 *      The package manager must be bootstrapped after the runtime, at the version this repository
 *      pins, and the bootstrap must PROVE the version it got.
 *   2. `cache: pnpm` on setup-node. That option resolves the pnpm store path by RUNNING pnpm —
 *      the very binary that does not exist yet at that point in the job. It is the same assumption
 *      wearing a different name, so it goes with it.
 *
 * And one claim that has to stay true in the manifests, wording and matrices: **Node 22 and Node
 * 24 are the complete supported runtime set.** The native SQLite dependency makes an accidentally
 * widened range particularly dangerous: a runtime accepted by the package but never exercised by
 * CI can fail with an ABI error before the CLI can explain what happened. Both supported majors
 * therefore run the full suite on all three platforms, and no other major is admitted.
 *
 * Everything here is read off the files as text: no YAML parser is a dependency of this repo, and
 * a text reading is what the assertions below need anyway (a step's ORDER inside a job, and
 * whether a token is executable shell or a comment about one).
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p: string[]): string => fs.readFileSync(path.join(repoRoot, ...p), 'utf8');

const CI = '.github/workflows/ci.yml';
const RELEASE = '.github/workflows/release.yml';
const NODE_MANIFESTS = ['package.json', 'packages/core/package.json', 'packages/cli/package.json'];
const SUPPORTED_NODE_MAJORS = [22, 24];

/** Executable workflow lines only — a comment naming corepack is not a call to it. */
const executableLines = (text: string): string[] =>
  text
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));

/** The pnpm version this repository pins, from the one place that is allowed to say it. */
function pinnedPnpm(): string {
  const pm = (JSON.parse(read('package.json')) as { packageManager?: string }).packageManager;
  expect(pm, 'package.json has no packageManager pin').toMatch(/^pnpm@\d+\.\d+\.\d+$/);
  return (pm as string).slice('pnpm@'.length);
}

/** The exact major-only alternatives a manifest's `engines.node` admits. */
function engineMajors(manifest: string): number[] {
  const engines = (JSON.parse(read(manifest)) as { engines?: { node?: string } }).engines;
  const range = engines?.node ?? '';
  expect(
    range,
    `${manifest} engines.node '${range}' is not an explicit 'N.x || M.x' major-only set`,
  ).toMatch(/^\d+\.x(?:\s*\|\|\s*\d+\.x)*$/);
  return range
    .split('||')
    .map((term) => Number(term.trim().slice(0, -2)))
    .sort((a, b) => a - b);
}

/** Every `os` / `node-version` pair in the CI job's matrix include list. */
function ciMatrix(): { os: string; node: number }[] {
  const lines = executableLines(read(CI));
  const legs: { os: string; node: number }[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const os = /^\s*- os:\s*(\S+)\s*$/.exec(lines[i] as string);
    if (!os) continue;
    const node = /^\s*node-version:\s*(\d+)\s*$/.exec(lines[i + 1] ?? '');
    expect(
      node,
      `matrix leg for ${os[1]} declares no node-version on the next line`,
    ).not.toBeNull();
    legs.push({ os: os[1] as string, node: Number((node as RegExpMatchArray)[1]) });
  }
  return legs;
}

/** One named Actions step, through (but not including) the next step at the same indentation. */
function workflowStep(text: string, name: string): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  if (start === -1) return [];
  const indent = (lines[start] as string).search(/\S/);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (line.search(/\S/) === indent && line.trim().startsWith('- name: ')) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end);
}

describe('CI bootstraps its own toolchain in an order that can actually run', () => {
  it.each([CI, RELEASE])(
    '%s never invokes corepack, and never caches pnpm it has not got',
    (wf) => {
      const lines = executableLines(read(wf));
      const corepack = lines.filter((l) => /\bcorepack\b/.test(l));
      expect(
        corepack,
        'a workflow step invokes corepack — a Node-bundled shim the runner image may not carry',
      ).toEqual([]);
      const cache = lines.filter((l) => /^\s*cache:\s*pnpm\s*$/.test(l));
      expect(
        cache,
        '`cache: pnpm` asks setup-node to resolve the pnpm store by RUNNING pnpm, before pnpm exists',
      ).toEqual([]);
    },
  );

  it.each([CI, RELEASE])('%s sets up Node BEFORE anything reaches for pnpm', (wf) => {
    const lines = executableLines(read(wf));
    const setupNode = lines.findIndex((l) => /uses:\s*actions\/setup-node@/.test(l));
    expect(setupNode, `${wf} never sets up Node`).toBeGreaterThan(-1);

    const firstPnpm = lines.findIndex((l) => /\bpnpm\b/.test(l));
    expect(firstPnpm, `${wf} never uses pnpm`).toBeGreaterThan(-1);
    expect(
      firstPnpm,
      `${wf} reaches for pnpm at line "${lines[firstPnpm]}" before actions/setup-node has chosen a Node`,
    ).toBeGreaterThan(setupNode);
  });

  it.each([CI, RELEASE])('%s installs the EXACT pinned pnpm with npm, and proves it', (wf) => {
    const text = read(wf);
    const lines = executableLines(text);
    const expected = pinnedPnpm();

    // The version is read from package.json rather than copied into the workflow, so the
    // bootstrap cannot drift from the lockfile it is about to install with.
    expect(
      lines.some((l) => /node -p "require\('\.\/package\.json'\)\.packageManager"/.test(l)),
      'the workflow does not derive the pnpm version from package.json packageManager',
    ).toBe(true);
    expect(
      lines.some((l) => /npm install --global "pnpm@\$EXPECTED"/.test(l)),
      'the workflow does not install pnpm with npm at the derived version',
    ).toBe(true);
    // ...AND ASSERTS WHAT IT GOT. An install that silently resolves to another pnpm — an image
    // shim, a stale global — would otherwise install a tree this lockfile never described.
    expect(
      lines.some((l) => /GOT="\$\(pnpm --version\)"/.test(l)),
      'the workflow never reads back the pnpm version it bootstrapped',
    ).toBe(true);
    expect(
      lines.some((l) => /if \[ "\$GOT" != "\$EXPECTED" \]; then/.test(l)),
      'the workflow does not fail when the bootstrapped pnpm is not the pinned version',
    ).toBe(true);

    // And the pin itself is an exact release, not a range — `pnpm@11` would satisfy every
    // assertion above while installing a different package manager on any two days.
    expect(expected).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('the bounded Node support contract is identical in manifests and release gates', () => {
  it('every manifest admits Node 22 and 24 only', () => {
    for (const manifest of NODE_MANIFESTS) {
      const majors = engineMajors(manifest);
      expect(majors, `${manifest} has drifted from the supported runtime set`).toEqual(
        SUPPORTED_NODE_MAJORS,
      );
      for (const unsupported of [21, 23, 25, 26]) {
        expect(
          majors,
          `${manifest} accidentally admits unsupported Node ${unsupported}`,
        ).not.toContain(unsupported);
      }
    }
  });

  it('runs every supported major on Linux, macOS and Windows, and no other major', () => {
    const legs = ciMatrix();
    const asPairs = legs.map((l) => `${l.os}@${l.node}`).sort();

    expect(asPairs, 'the CI matrix is not the agreed support matrix').toEqual(
      [
        'macos-latest@22',
        'macos-latest@24',
        'ubuntu-latest@22',
        'ubuntu-latest@24',
        'windows-latest@22',
        'windows-latest@24',
      ].sort(),
    );

    // Path handling, launcher wiring, fs identity and native-module loading are platform
    // properties. Every supported runtime must exercise those properties on every claimed OS.
    for (const node of SUPPORTED_NODE_MAJORS) {
      for (const os of ['ubuntu-latest', 'macos-latest', 'windows-latest']) {
        expect(
          legs.some((leg) => leg.os === os && leg.node === node),
          `supported Node ${node} is not exercised on ${os}`,
        ).toBe(true);
      }
    }

    for (const leg of legs) {
      expect(
        SUPPORTED_NODE_MAJORS,
        `CI runs unsupported Node ${leg.node}, widening the tested support claim`,
      ).toContain(leg.node);
    }
  });

  it('the release smoke-installs the tarball on every supported runtime', () => {
    const line = executableLines(read(RELEASE)).find((l) => /^\s*node-version:\s*\[/.test(l));
    expect(line, 'the smoke-install job declares no Node matrix').toBeDefined();
    const versions = ((line as string).match(/\[([^\]]*)\]/)?.[1] ?? '')
      .split(',')
      .map((v) => Number(v.trim()))
      .filter((v) => !Number.isNaN(v));
    expect(versions.sort((a, b) => a - b)).toEqual(SUPPORTED_NODE_MAJORS);
  });

  it('the freshtest container stays on the oldest supported runtime', () => {
    expect(read('Dockerfile.freshtest')).toMatch(/^FROM node:22/m);
  });
});

describe('Windows CI prepares the exact built CLI before any worker is dispatched', () => {
  it('grants the isolated pre-worker authority only on the unfiltered Windows Test step', () => {
    const workflow = read(CI);
    const block = workflowStep(workflow, 'Test').join('\n');

    expect(block, 'CI has no Test step').not.toBe('');
    expect(block, 'the Windows preparation flag is not scoped to the Test step').toContain(
      `${ISOLATED_WINDOWS_CI_TEST_JOB_ENV}:`,
    );
    expect(
      block,
      'the lock-free preparation authority is not derived solely from runner.os == Windows',
    ).toMatch(/runner\.os\s*==\s*'Windows'\s*&&\s*'1'\s*\|\|\s*'0'/);
    expect(
      block,
      'Windows CI filters out product suites instead of running the full test command',
    ).toMatch(/\n\s*run:\s*pnpm test\s*$/);

    const test = executableLines(workflow).findIndex((line) => line.trim() === '- name: Test');
    const build = executableLines(workflow).findIndex((line) => line.trim() === '- name: Build');
    expect(test, 'CI has no Test step').toBeGreaterThan(-1);
    expect(build, 'CI has no final Build step').toBeGreaterThan(-1);
    expect(test, 'the ordinary final build moved ahead of the test run').toBeLessThan(build);
  });

  it('requires Windows, GitHub Actions, CI, and the explicit workflow flag together', () => {
    const granted: NodeJS.ProcessEnv = {
      CI: 'true',
      GITHUB_ACTIONS: 'true',
      [ISOLATED_WINDOWS_CI_TEST_JOB_ENV]: '1',
    };
    expect(isIsolatedWindowsCiTestJob(granted, 'win32')).toBe(true);

    expect(isIsolatedWindowsCiTestJob(granted, 'linux')).toBe(false);
    expect(isIsolatedWindowsCiTestJob({ ...granted, CI: 'false' }, 'win32')).toBe(false);
    expect(isIsolatedWindowsCiTestJob({ ...granted, GITHUB_ACTIONS: 'false' }, 'win32')).toBe(
      false,
    );
    expect(
      isIsolatedWindowsCiTestJob({ ...granted, [ISOLATED_WINDOWS_CI_TEST_JOB_ENV]: '0' }, 'win32'),
    ).toBe(false);
    expect(isIsolatedWindowsCiTestJob({}, 'win32')).toBe(false);
  });

  it('publishes the real worker NODE_OPTIONS before the guarded exact build and marker', () => {
    expect(
      read('vitest.config.ts'),
      'the pre-worker setup is no longer wired into Vitest',
    ).toContain("globalSetup: [path.resolve(__dirname, 'tests/helpers/temp-sweep.ts')]");
    const setup = read('tests/helpers/temp-sweep.ts');
    expect(
      setup,
      'direct fixture setup calls can enter the CI-only build path outside global setup',
    ).toContain("const isVitestGlobalSetup = typeof invocation?.provide === 'function';");
    const root = setup.indexOf('process.env[RUN_ROOT_ENV] = realRoot;');
    const gate = setup.indexOf('if (isVitestGlobalSetup && isIsolatedWindowsCiTestJob())');
    const publish = setup.indexOf('publishChildRecorder();', gate);
    const prepare = setup.indexOf('prepareBuiltCliForIsolatedWindowsCi();', publish);
    const assertCurrent = setup.indexOf('if (!distIsCurrent())', prepare);

    expect(root, 'global setup no longer publishes the run root').toBeGreaterThan(-1);
    expect(gate, 'global setup has no pre-worker Windows-CI gate').toBeGreaterThan(root);
    expect(publish, 'the exact child recorder is not published inside that gate').toBeGreaterThan(
      gate,
    );
    expect(
      prepare,
      'the guarded critical section does not run after NODE_OPTIONS is final',
    ).toBeGreaterThan(publish);
    expect(
      assertCurrent,
      'global setup never proves the marker current before workers start',
    ).toBeGreaterThan(prepare);
    expect(setup, 'the run-specific NODE_OPTIONS leaks beyond test teardown').toContain(
      "restore('NODE_OPTIONS', previousNodeOptions);",
    );

    const helper = read('tests/helpers/build-cli.ts');
    const guarded = helper.indexOf('export function prepareBuiltCliForIsolatedWindowsCi()');
    const refusal = helper.indexOf('if (!isIsolatedWindowsCiTestJob())', guarded);
    const consume = helper.indexOf(
      'Reflect.deleteProperty(process.env, ISOLATED_WINDOWS_CI_TEST_JOB_ENV);',
      refusal,
    );
    const critical = helper.indexOf('return runBuildCriticalSection();', consume);
    expect(guarded, 'the isolated preparation entry point is absent').toBeGreaterThan(-1);
    expect(refusal, 'the entry point does not fail closed outside its exact job').toBeGreaterThan(
      guarded,
    );
    expect(
      consume,
      'the one-shot lock-free authority is inherited by workers instead of consumed before build',
    ).toBeGreaterThan(refusal);
    expect(
      critical,
      'the entry point bypasses the real build/record critical section',
    ).toBeGreaterThan(consume);
  });
});

describe('the documented development order matches the one that works', () => {
  it('README switches the runtime BEFORE enabling the shim that Node ships', () => {
    const readme = read('README.md');
    const nvm = readme.indexOf('nvm use');
    const corepack = readme.indexOf('corepack enable');
    expect(nvm, 'the README no longer tells a contributor to select the runtime').toBeGreaterThan(
      -1,
    );
    expect(corepack, 'the README no longer mentions corepack').toBeGreaterThan(-1);
    expect(
      nvm,
      '`corepack enable` is documented BEFORE `nvm use` — that wires the shim to whichever Node happened to be active',
    ).toBeLessThan(corepack);
  });

  it('README and DECISIONS publish a bounded supported set, not an open-ended floor', () => {
    for (const doc of ['README.md', 'docs/DECISIONS.md']) {
      const text = read(doc);
      expect(text, `${doc} does not state the exact engines.node runtime set`).toContain(
        '22.x || 24.x',
      );
      expect(text, `${doc} still describes engines.node as an open-ended >=22 floor`).not.toMatch(
        /engines\.node[^.\n]*>=\s*22/i,
      );
    }

    // ...and DECISIONS names both complete cross-platform legs.
    const decisions = read('docs/DECISIONS.md');
    for (const leg of ['22', '24']) {
      expect(decisions, `DECISIONS.md does not name the Node ${leg} leg`).toContain(`Node ${leg}`);
    }
    for (const os of ['Linux', 'macOS', 'Windows']) {
      expect(decisions, `DECISIONS.md does not name ${os} in the support matrix`).toContain(os);
    }
  });
});
