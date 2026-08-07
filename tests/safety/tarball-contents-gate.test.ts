import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { removeForeignTree } from '../helpers/foreign-tree.js';
import {
  type ArchiveMember,
  bodyOf,
  membersOf,
  packagedFiles,
  replaceMember,
  writeTarball,
} from '../helpers/tarball.js';

/**
 * SAFETY: what the published tarball contains is settled against the ARCHIVE, not against a
 * sentence in a checklist — and against a contract captured BEFORE the pack, not against whatever
 * the pack left in the working tree.
 *
 * WHY THIS LAYER EXISTS. Every other test in this repository reads the working tree, where the
 * prompt pack, the fixtures and the built entry point are all present. A package `files` allowlist
 * that stops shipping one of them is therefore invisible to all of them: the file is on every
 * developer's disk and absent from every user's install. `docs/RELEASE.md` used to assert the
 * tarball's contents as a checklist line, which is a claim nothing could fail.
 *
 * WHY THE CONTRACT IS CAPTURED FIRST. `npm pack` RUNS THE PACKAGE LIFECYCLE. A `prepack` script is
 * arbitrary code with write access to the checkout, so a gate that derives its expectations from
 * the working tree after the pack compares the archive to whatever that code decided the tree
 * should say — rewrite `dist/index.js` and the file it is checked against together and the
 * substitute is compared to itself. The release therefore captures the contract immediately after
 * the tested build and before `npm pack`, and the verifier has NO fallback to the live tree.
 *
 * WHAT IS PROVED HERE:
 *   - PLACEMENT, off `.github/workflows/release.yml`: the contract is captured after the build and
 *     BEFORE the single `npm pack`; the verifier runs on the ONE archive that pack produced,
 *     against that captured contract, BEFORE the checksum and the upload; and the job still builds
 *     once and packs once.
 *   - BEHAVIOUR, by EXECUTING `scripts/verify-tarball-contents.mjs` against archives this file
 *     builds: a complete one passes, dropping any single contracted entry turns it red, and source,
 *     credentials, repository documentation and out-of-prefix entries are refused.
 *   - THE EXACT TREES: `dist/` and `prompts/` are compared as whole trees — same path set, same
 *     bytes. An EXTRA `prompts/fixtures/<op>/*.json` is a case `loadFixtures` would execute; an
 *     EXTRA `dist/*.js` is a module the installed package can load; a SUBSTITUTED `dist/index.js`
 *     is a different program behind the same name. None of those is "missing" anything.
 *   - THE PACKED MANIFEST: parsed as strict UTF-8 and settled field by field against the captured
 *     manifest, with every entry point the PACKED manifest names required to be in the archive, so
 *     a repointed `bin` or an added install-time hook cannot ride along.
 *   - THE CAPTURE IS THE AUTHORITY: a mutation applied AFTER the snapshot is refused even when the
 *     repository source and the packed copy are rewritten together, which is exactly the shape a
 *     hostile `prepack` has.
 *   - STRUCTURE, by building archives no `tar(1)` will produce (`tests/helpers/tarball.ts` writes
 *     raw headers): a required entry that is a SYMLINK, a HARD LINK, a DUPLICATE, a name with a
 *     TRAILING SPACE, a traversal, a device node, and a payload that hides a credential behind a
 *     NUL byte.
 *   - DERIVATION, by adding a prompt op to a synthetic repository's oracle source before the
 *     capture: the same archive then fails, so the required set really does follow the code.
 *
 * Nothing here installs anything, contacts a registry, or runs the package lifecycle. The archives
 * are staged from a SYNTHETIC MIRROR of this repository — the real prompt pack and manifest, stub
 * build output — because `pnpm test` runs BEFORE `pnpm build` in CI and `packages/cli/dist` may not
 * exist yet. Staging from the mirror is what lets `dist` be contracted at all.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const VERIFIER = 'scripts/verify-tarball-contents.mjs';
const verifierPath = path.join(repoRoot, VERIFIER);
const cliDir = path.join(repoRoot, 'packages', 'cli');

const workflowText = (): string =>
  fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8');

/** The `build` job's lines, so placement is read inside the job that packs rather than anywhere. */
function buildJobLines(text: string = workflowText()): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^ {2}build:\s*$/.test(l));
  if (start === -1) return [];
  const end = lines.findIndex((l, i) => i > start && /^ {2}[a-z][a-z-]*:\s*$/.test(l));
  return lines.slice(start, end === -1 ? undefined : end);
}

const stepAt = (lines: string[], name: string): number =>
  lines.findIndex((l) => l.trim() === `- name: ${name}`);

const CAPTURE_STEP = 'Capture the pre-pack release contract';
const PIN_STEP = 'Pin the release authority (contract + the scripts that enforce it)';
const STAGE_STEP = 'Stage the release package (a new tree, settled against the contract)';
const PACK_STEP = 'Pack (exactly once, running NO package lifecycle)';
const ASSERT_STEP = 'Assert the pinned release authority survived the pack';
const VERIFY_STEP = 'Verify packed tarball contents';
const CANARY_STEP = 'Release-contract canary (a post-capture mutation must be refused)';

/** One step of the build job, from its `- name:` to the next line at or above its indentation. */
function stepBlock(lines: string[], name: string): string[] {
  const at = stepAt(lines, name);
  if (at === -1) return [];
  const indent = (lines[at] as string).search(/\S/);
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (line.trim() === '') continue;
    if (line.search(/\S/) <= indent) {
      end = i;
      break;
    }
  }
  return lines.slice(at, end);
}

/** The step's `run:` body, dedented — the shell the runner actually executes, block or one-liner. */
function runBody(block: string[]): string {
  const at = block.findIndex((l) => /^\s*run:/.test(l));
  if (at === -1) return '';
  const inline = /^\s*run:\s*(?![|>])(\S.*?)\s*$/.exec(block[at] as string);
  if (inline !== null) return inline[1] as string;
  const body = block.slice(at + 1);
  const first = body.find((l) => l.trim() !== '');
  const indent = first === undefined ? 0 : first.search(/\S/);
  return body.map((l) => (l.length >= indent ? l.slice(indent) : l.trim())).join('\n');
}

/** The step's `env:` mapping, values kept as the raw workflow expressions they are. */
function stepEnv(block: string[]): Record<string, string> {
  const at = block.findIndex((l) => /^\s*env:\s*$/.test(l));
  if (at === -1) return {};
  const indent = (block[at] as string).search(/\S/);
  const out: Record<string, string> = {};
  for (let i = at + 1; i < block.length; i += 1) {
    const line = block[i] as string;
    if (line.trim() === '') continue;
    if (line.search(/\S/) <= indent) break;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (m) out[m[1] as string] = (m[2] as string).trim();
  }
  return out;
}

/** Executable workflow lines only — a comment naming `npm pack` is not a call to it. */
const executable = (lines: string[]): string[] => lines.filter((l) => !l.trim().startsWith('#'));

describe('the release settles the tarball contents against the archive it just packed', () => {
  it('runs the verifier in the build job, on the packed tarball, against the captured contract', () => {
    const lines = buildJobLines();
    expect(lines.length, 'no `build` job in .github/workflows/release.yml').toBeGreaterThan(0);
    const at = stepAt(lines, VERIFY_STEP);
    expect(at, `the build job has no \`${VERIFY_STEP}\` step`).toBeGreaterThan(-1);

    const body = lines.slice(at, at + 30).join('\n');
    expect(body, `the step does not run ${VERIFIER}`).toContain(`node ${VERIFIER}`);
    // On THE archive, named the way the pack step names it — not on a directory, and not on
    // something rebuilt for the occasion.
    expect(body, 'the verifier is not pointed at the packed tarball').toMatch(
      /\$RUNNER_TEMP\/release-pack\/sthayi-\$\{VERSION\}\.tgz/,
    );
    // And against the CAPTURED contract. Without this the verifier has nothing to compare to.
    expect(body, 'the verify step does not pass the captured release contract').toMatch(
      /--contract "\$RUNNER_TEMP\/release-contract\.json"/,
    );
    // A `--repo` here would reintroduce the hole: the live tree after a pack is whatever the
    // package lifecycle left behind.
    expect(body, 'the verify step points the gate back at the post-pack working tree').not.toMatch(
      /--repo\b/,
    );
  });

  it('captures the release contract after the build and BEFORE the pack', () => {
    const lines = buildJobLines();
    const at = stepAt(lines, CAPTURE_STEP);
    expect(at, `the build job has no \`${CAPTURE_STEP}\` step`).toBeGreaterThan(-1);

    const body = lines.slice(at, at + 30).join('\n');
    expect(body, 'the capture step does not run the verifier in snapshot mode').toContain(
      `node ${VERIFIER} --snapshot`,
    );
    expect(body, 'the captured contract is not written where the verify step reads it').toContain(
      '"$RUNNER_TEMP/release-contract.json"',
    );
  });

  it('runs build → capture → PIN → stage → pack → ASSERT → verify → canary → checksum → upload', () => {
    // Placement is the whole point. A capture taken AFTER the pack is a statement about whatever
    // the package lifecycle left in the checkout; a contents check that ran before the pack would
    // be inspecting something else; and one that ran after the digest was taken would be
    // inspecting bytes the release had already committed to.
    //
    // AND THE PIN AND THE ASSERT BRACKET THE PACK. The capture alone settles nothing: the contract
    // is an ordinary file on the runner, and a lifecycle script inheriting `RUNNER_TEMP` can rewrite
    // a packed file and recompute that file's contracted digest in the same breath. The pin has to
    // be taken while the contract is still what the build produced, and the re-assertion has to
    // happen BEFORE the gate is asked for a verdict — a check that ran afterwards would be
    // validating a verdict already reached, and the verifier that reached it could itself have been
    // the thing that was rewritten.
    const lines = buildJobLines();
    const build = lines.findIndex((l) => /^\s*run: pnpm build\s*$/.test(l));
    const capture = stepAt(lines, CAPTURE_STEP);
    const pin = stepAt(lines, PIN_STEP);
    const stage = stepAt(lines, STAGE_STEP);
    const pack = stepAt(lines, PACK_STEP);
    const assert = stepAt(lines, ASSERT_STEP);
    const verify = stepAt(lines, VERIFY_STEP);
    const canary = stepAt(lines, CANARY_STEP);
    const sums = lines.findIndex((l) => /^\s*- name: Checksums\b/.test(l));
    const upload = lines.findIndex((l) => l.includes('upload-artifact'));

    expect(build, 'the build job no longer builds').toBeGreaterThan(-1);
    expect(capture, 'the build job no longer captures a release contract').toBeGreaterThan(-1);
    expect(pin, 'the build job no longer pins the release authority').toBeGreaterThan(-1);
    expect(stage, 'the build job no longer stages the package it packs').toBeGreaterThan(-1);
    expect(pack, `the build job has no \`${PACK_STEP}\` step`).toBeGreaterThan(-1);
    expect(assert, 'the build job no longer re-asserts the pinned authority').toBeGreaterThan(-1);
    expect(verify, 'the build job no longer verifies the packed tarball').toBeGreaterThan(-1);
    expect(canary, 'the build job no longer proves the contract comparison bites').toBeGreaterThan(
      -1,
    );
    expect(sums, 'the build job no longer has a checksum step').toBeGreaterThan(-1);
    expect(upload, 'the build job no longer uploads the artifact').toBeGreaterThan(-1);

    expect(
      capture,
      'the release contract is captured before the build it describes',
    ).toBeGreaterThan(build);
    expect(
      pin,
      'the authority is pinned before the contract it is supposed to fix exists',
    ).toBeGreaterThan(capture);
    expect(
      pin,
      'the authority is pinned AFTER the pack, so a lifecycle script could have set the pin itself',
    ).toBeLessThan(pack);
    expect(
      stage,
      'the release stage is built before the contract it is settled against',
    ).toBeGreaterThan(capture);
    expect(
      stage,
      'the release stage is built after the pack that is supposed to read it',
    ).toBeLessThan(pack);
    expect(
      capture,
      'the release contract is captured AFTER the pack, so a prepack could have written it',
    ).toBeLessThan(pack);
    expect(
      assert,
      'the pinned authority is re-asserted before the pack it has to survive',
    ).toBeGreaterThan(pack);
    expect(
      assert,
      'the pinned authority is re-asserted only AFTER the gate has already returned a verdict',
    ).toBeLessThan(verify);
    expect(
      verify,
      'the contents gate runs before the pack it is supposed to inspect',
    ).toBeGreaterThan(pack);
    expect(canary, 'the canary runs before the gate it is a control for').toBeGreaterThan(verify);
    expect(verify, 'the contents gate runs after the digest is taken').toBeLessThan(sums);
    expect(verify, 'the contents gate runs after the artifact is uploaded').toBeLessThan(upload);
  });

  it('packs with NO package lifecycle, from the staging tree, never in the package checkout', () => {
    // THE FIX, READ OFF THE WORKFLOW. `npm pack` in `packages/cli` runs `prepack`: arbitrary code
    // with write access to the checkout AND to `$RUNNER_TEMP`, executing between the capture and the
    // archive being read. One script rewrites `dist/index.js` and recomputes its contracted digest,
    // and the gate then reports "byte-identical" about a substitute compared to itself.
    const body = runBody(stepBlock(buildJobLines(), PACK_STEP));
    expect(body, `the build job has no \`${PACK_STEP}\` step with a run body`).not.toBe('');
    expect(body, 'the release pack still runs the package lifecycle').toContain(
      'npm pack --ignore-scripts',
    );
    expect(body, 'the release packs somewhere other than the staged tree').toContain(
      'cd "$RUNNER_TEMP/release-stage"',
    );
    expect(body, 'the release packs the mutable package checkout').not.toMatch(
      /cd\s+packages\/cli\b/,
    );
    // And the archive lands outside the tree being packed, so the pack cannot ingest its own output.
    expect(body, 'the tarball is not written to a directory of its own').toContain(
      '--pack-destination "$RUNNER_TEMP/release-pack"',
    );
  });

  it('pins the contract AND both enforcing scripts as step outputs, not as files', () => {
    // A file on the runner is authority over nothing: whatever can rewrite the artifact can rewrite
    // the expectation beside it. A step output is fixed by the workflow control plane when the step
    // ends, which is the same argument the tarball digest already rests on, taken one step earlier.
    const block = stepBlock(buildJobLines(), PIN_STEP);
    expect(block.length, `the build job has no \`${PIN_STEP}\` step`).toBeGreaterThan(0);
    expect(
      block.join('\n'),
      'the pin step has no id, so nothing can reference its outputs',
    ).toMatch(/^\s*id:\s*authority\s*$/m);
    const body = runBody(block);
    expect(body, 'the contract is not pinned').toContain('"$RUNNER_TEMP/release-contract.json"');
    expect(body, 'the verifier is not pinned').toContain('scripts/verify-tarball-contents.mjs');
    expect(body, 'the stager is not pinned').toContain('scripts/stage-release-package.mjs');
    expect(body, 'the pinned digests never reach the workflow context').toContain('$GITHUB_OUTPUT');
  });

  it('re-asserts the pinned authority from the workflow context, in shell it cannot delegate', () => {
    const block = stepBlock(buildJobLines(), ASSERT_STEP);
    expect(block.length, `the build job has no \`${ASSERT_STEP}\` step`).toBeGreaterThan(0);
    const env = stepEnv(block);
    for (const [name, from] of [
      ['CONTRACT_SHA', 'contract-sha256'],
      ['VERIFIER_SHA', 'verifier-sha256'],
      ['STAGER_SHA', 'stager-sha256'],
    ]) {
      expect(env[name as string], `the assert step does not read ${from} out of the pin step`).toBe(
        `\${{ steps.authority.outputs.${from} }}`,
      );
    }
    const body = runBody(block);
    // Delegating the comparison to a repository script would put the check inside one of the byte
    // sets being compared. It has to be shell in the workflow, which nothing on the runner can edit.
    expect(
      body,
      'the authority check is delegated to a file the authority check covers',
    ).not.toMatch(/\bnode\s+scripts\//);
    for (const target of [
      '"$RUNNER_TEMP/release-contract.json"',
      'scripts/verify-tarball-contents.mjs',
      'scripts/stage-release-package.mjs',
    ]) {
      expect(body, `the assert step never checks ${target}`).toContain(target);
    }
  });

  it('the workflow no longer claims that writing under RUNNER_TEMP makes anything immutable', () => {
    // The sentence this removes was the reason the hole read as closed: the contract was described
    // as unchangeable because of WHERE it was written. `$RUNNER_TEMP` is ordinary runner state, and
    // `npm pack` hands it straight to `prepack` in the environment.
    const job = executable(buildJobLines()).join('\n');
    expect(
      job,
      'the workflow still claims nothing later in the job can change the contract',
    ).not.toMatch(/Nothing later in\s*#?\s*this job can change it/);
    const capture = stepBlock(buildJobLines(), CAPTURE_STEP).join('\n');
    expect(capture, 'the capture step does not say what RUNNER_TEMP actually is').toMatch(
      /DOES NOT MAKE IT IMMUTABLE/,
    );
  });

  it('the canary proves in CI that a divergence from the captured contract is refused', () => {
    // A gate whose comparison silently stopped biting would still be green. The canary re-runs the
    // SAME verifier over the SAME archive against a COPY of the contract with one digest flipped,
    // and fails the release if that is accepted.
    const lines = buildJobLines();
    const at = stepAt(lines, CANARY_STEP);
    expect(at, `the build job has no \`${CANARY_STEP}\` step`).toBeGreaterThan(-1);

    const block = stepBlock(lines, CANARY_STEP);
    const body = runBody(block);
    expect(body, 'the canary does not perturb a contracted digest').toMatch(/copy\.files\[k\]\s*=/);
    expect(body, 'the canary does not re-run the verifier').toContain(`node ${VERIFIER}`);
    expect(body, 'the canary does not fail when the perturbed contract is accepted').toMatch(
      /not load-bearing/,
    );
    // It must work on a COPY: a canary that clobbered the real contract would disarm the gate.
    expect(body, 'the canary writes over the real release contract').toContain(
      'release-contract.canary.',
    );

    // AND IT MUST PERTURB THE ENTRY POINT. The old canary flipped whatever sorted first — `LICENSE`
    // — so a substituted `dist/index.js` with a recomputed contracted digest produced a green gate
    // AND a green canary in the same run: the control demonstrated that a comparison nobody was
    // asking about still worked, and CI reported "canary OK" about a compromised artifact.
    expect(
      body,
      'the canary does not derive the entry point it perturbs from the contract',
    ).toMatch(/c\.manifest\?\.bin/);
    expect(body, 'the canary does not perturb the entry point the artifact actually runs').toMatch(
      /c\.manifest\?\.main/,
    );
    expect(
      body,
      'the canary does not refuse a contract that names no entry point it carries bytes for',
    ).toMatch(/nothing the artifact runs/);

    // AND IT MUST NOT BE EVIDENCE ABOUT A REWRITTEN AUTHORITY. Perturbing a contract that was itself
    // rewritten proves that the verifier refuses the doctored contract's own perturbation, while the
    // gate has just blessed the archive that contract was rewritten to fit.
    expect(
      stepEnv(block).CONTRACT_SHA,
      'the canary does not read the pinned contract digest out of the pin step',
    ).toBe('${{ steps.authority.outputs.contract-sha256 }}');
    expect(
      body,
      'the canary never re-asserts that the contract is the one this release pinned',
    ).toMatch(/pinned before the pack/);
  });

  it('the release checklist points at the verifier instead of asserting the contents itself', () => {
    // The claim this replaced was a checklist line a human ticked, which nothing could fail. The
    // page now delegates, and that delegation is what keeps the two from drifting apart again.
    const doc = fs.readFileSync(path.join(repoRoot, 'docs', 'RELEASE.md'), 'utf8');
    expect(doc, 'the release checklist no longer links the verifier').toContain(`(../${VERIFIER})`);
    expect(doc, 'the checklist does not name the verifier as the authority').toMatch(
      /authority on what a\s+release contains/,
    );
    expect(doc, 'the tarball contents are asserted as a hand-ticked line again').not.toMatch(
      /`npm pack` tarball contains/,
    );
    // The page has to describe what the gate ACTUALLY does. A checklist that promises structural
    // validation the script does not perform is the same defect in a different file.
    expect(doc, 'the page does not say the gate reads the archive rather than a listing').toMatch(
      /reads the archive, not a listing of it, and it never extracts/,
    );
    expect(doc, 'the page does not state the exact published Markdown set').toMatch(
      /prose is an exact set/,
    );
    // The ORDER is the control, so the page has to say the contract predates the pack.
    expect(doc, 'the page does not say the contract is captured before the pack').toMatch(
      /captured\s+\*\*before\*\* `npm pack` runs/,
    );
    expect(doc, 'the page does not state the byte-identity requirement').toMatch(
      /byte-identical to what the\s+contract captured/,
    );
    expect(doc, 'the page does not say dist and prompts are exact trees').toMatch(/exact trees\b/);
    expect(doc, 'the page does not say the packed manifest is compared semantically').toMatch(
      /field by field/,
    );
    // And it has to be HONEST about the limit of the sourcemap path check, which is on the
    // structural fields only — `sourcesContent` is source text that legitimately names such paths.
    expect(doc, 'the page overstates what the sourcemap path check covers').toMatch(
      /structural fields \*\*only\*\*/,
    );

    // AND IT MUST NOT SELL `$RUNNER_TEMP` AS IMMUTABILITY. That sentence was the reason the hole
    // read as closed: the contract was described as unchangeable because of WHERE it was written,
    // while `npm pack` hands `RUNNER_TEMP` straight to `prepack`.
    expect(doc, 'the page still sells a location as immutability').toMatch(
      /does not make it immutable/,
    );
    expect(doc, 'the page does not say the release pack runs no lifecycle').toMatch(
      /npm pack --ignore-scripts/,
    );
    expect(doc, 'the page does not say the package is staged before it is packed').toMatch(
      /\*\*newly created\*\* directory/,
    );
    expect(doc, 'the page does not say a file the contract does not hold is refused').toMatch(
      /debris/,
    );
    expect(doc, 'the page does not say the authority is pinned as a step output').toMatch(
      /\*\*step\s+outputs\*\*/,
    );
    expect(doc, 'the page does not say the pin is re-checked before the verdict').toMatch(
      /re-checks all three \*\*before\*\* the contents gate/,
    );
    expect(doc, 'the page does not say the canary perturbs the entry point').toMatch(
      /perturbs \*\*the entry point the contract\s+names\*\*/,
    );
  });

  it('the checklist names the Node versions CI actually runs', () => {
    // A quality gate that names a different runtime set from the matrix is a page that goes stale
    // silently. The list is READ OFF ci.yml, so adding or removing a runtime without updating the
    // release checklist fails here.
    const doc = fs.readFileSync(path.join(repoRoot, 'docs', 'RELEASE.md'), 'utf8');
    const ci = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
    const versions = [
      ...new Set([...ci.matchAll(/node-version:\s*(\d+)\s*$/gm)].map((m) => m[1])),
    ].sort();
    expect(versions, 'ci.yml no longer declares a multi-runtime node-version matrix').toEqual([
      '22',
      '24',
    ]);
    const matrixBullet = /CI green on the supported matrix:[\s\S]*?(?=\n- \[ \])/i.exec(doc)?.[0];
    expect(
      matrixBullet,
      'the checklist has no bounded supported-matrix release gate',
    ).toBeDefined();
    for (const version of versions) {
      expect(
        matrixBullet,
        `the checklist's supported-matrix gate does not name Node ${version}`,
      ).toContain(`Node ${version}`);
    }
    for (const os of ['Linux', 'macOS', 'Windows']) {
      expect(matrixBullet, `the checklist's supported-matrix gate does not name ${os}`).toContain(
        os,
      );
    }
    expect(
      matrixBullet,
      'the checklist still claims Node 26 as a supported release-matrix leg',
    ).not.toContain('Node 26');
    expect(
      matrixBullet,
      'the checklist does not say the packed tarball is smoke-tested on the supported runtimes',
    ).toMatch(/packed-tarball[\s\S]*22\s*\/\s*24/i);
    expect(
      matrixBullet,
      'the checklist still describes engines.node as an open-ended >=22 range',
    ).not.toMatch(/engines\.node[\s\S]*>=\s*22/i);
  });

  it('packs exactly once, builds exactly once, and keeps no live-tree fallback', () => {
    // Invocations, not mentions: the pack step's own failure message names `npm pack` too.
    const lines = executable(buildJobLines()).filter((l) => !/^\s*echo\b/.test(l));
    const packs = lines.filter((l) => /\bnpm pack\b/.test(l));
    expect(packs, `the build job packs ${packs.length} time(s), not once`).toHaveLength(1);
    const builds = lines.filter((l) => /^\s*run: pnpm build\s*$/.test(l));
    expect(builds, 'the build job builds more than once').toHaveLength(1);
    // EVERY pack must be the lifecycle-free one. A second pack "just to be sure", or one without
    // the flag, reinstates the whole hole.
    expect(packs[0], 'the one pack still runs the package lifecycle').toContain('--ignore-scripts');
    // And no step may hand the verifier back at the working tree: `--repo` at verify time is the
    // fallback the contract exists to replace.
    const verifyRepo = lines.filter(
      (l) => /verify-tarball-contents\.mjs/.test(l) && /--repo\b/.test(l),
    );
    expect(verifyRepo, 'a step points the contents gate back at the live tree').toHaveLength(0);
  });
});

// ===============================================================================================
// THE EXECUTING HALF.
// ===============================================================================================

interface RunResult {
  code: number;
  out: string;
}

const scratchDir = (): string =>
  fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tarball-gate-'));

/** Called from test BODIES only — never a hook, never a `finally`. */
function wipe(dir: string): void {
  removeForeignTree(dir);
}

/**
 * The build output the mirror repository carries, and therefore what the contract holds and the
 * archive ships. `pnpm test` runs before `pnpm build`, so a real `dist` is not available; a stub
 * that the mirror and the staging tree share is what makes `dist` contractable at all.
 */
const DIST_STUB: Record<string, string> = {
  'index.js': '#!/usr/bin/env node\nprocess.exit(0);\n',
  'index.js.map': '{"version":3,"sources":[]}\n',
};

function writeFile(root: string, rel: string, body: string): void {
  const target = path.join(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
}

function copyDir(from: string, to: string): void {
  fs.cpSync(from, to, { recursive: true });
}

/**
 * A SYNTHETIC MIRROR of this repository: the real prompt pack, the real manifest, the real oracle
 * source the requirement set is derived from, the real README and LICENSE — plus a `dist` the test
 * controls. The contract is captured from THIS, so a test can mutate the mirror before or after the
 * capture and see which side the verifier believes.
 */
function mirrorRepo(root: string, dist: Record<string, string> = DIST_STUB): string {
  const repo = path.join(root, 'repo');
  const cli = path.join(repo, 'packages', 'cli');
  fs.mkdirSync(path.join(cli, 'src', 'oracle'), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'README.md'), path.join(repo, 'README.md'));
  fs.copyFileSync(path.join(repoRoot, 'LICENSE'), path.join(repo, 'LICENSE'));
  fs.copyFileSync(path.join(cliDir, 'package.json'), path.join(cli, 'package.json'));
  copyDir(path.join(cliDir, 'prompts'), path.join(cli, 'prompts'));
  for (const f of ['prompts.ts', 'qualify.ts']) {
    fs.copyFileSync(path.join(cliDir, 'src', 'oracle', f), path.join(cli, 'src', 'oracle', f));
  }
  for (const [rel, body] of Object.entries(dist)) {
    writeFile(cli, path.posix.join('dist', rel), body);
  }
  return repo;
}

/**
 * A staging tree shaped like what `npm pack` produces for the mirror: everything under a single
 * `package/` prefix. It lives under `<root>/tree` so the contract and the tarball, which sit in
 * `<root>`, are never themselves packed.
 */
function stageFrom(repo: string, root: string): string {
  const cli = path.join(repo, 'packages', 'cli');
  const pkg = path.join(root, 'tree', 'package');
  fs.mkdirSync(pkg, { recursive: true });
  copyDir(path.join(cli, 'prompts'), path.join(pkg, 'prompts'));
  copyDir(path.join(cli, 'dist'), path.join(pkg, 'dist'));
  fs.copyFileSync(path.join(cli, 'package.json'), path.join(pkg, 'package.json'));
  // `prepack` copies these in from the repo ROOT, and the verifier holds the packed copies to the
  // contract's bytes — a staged stub would be a divergence the real release does not have.
  fs.copyFileSync(path.join(repo, 'README.md'), path.join(pkg, 'README.md'));
  fs.copyFileSync(path.join(repo, 'LICENSE'), path.join(pkg, 'LICENSE'));
  return pkg;
}

function snapshot(repo: string, out: string): RunResult {
  const r = spawnSync(process.execPath, [verifierPath, '--snapshot', out, '--repo', repo], {
    encoding: 'utf8',
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function verify(tarball: string, contract?: string): RunResult {
  const args = [verifierPath, tarball];
  if (contract !== undefined) {
    args.push('--contract', contract);
  }
  const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

interface Bench {
  /** The scratch root. `wipe(bench.root)` at the end of the test body. */
  root: string;
  /** The synthetic repository the contract was captured from. */
  repo: string;
  /** The `package/` staging tree the archive is built out of. */
  pkg: string;
  /** The captured contract file. */
  contract: string;
}

/**
 * Mirror, stage, then CAPTURE — in the order the release does it. `beforeSnapshot` runs with the
 * mirror and the staging tree both in place but the contract not yet taken, which is how a test
 * changes what the release is contracted to. Anything a test does after `bench()` returns is a
 * POST-capture mutation, which is the shape a `prepack` script has.
 */
function bench(opts?: {
  dist?: Record<string, string>;
  beforeSnapshot?: (repo: string, pkg: string) => void;
}): Bench {
  const root = scratchDir();
  const repo = mirrorRepo(root, opts?.dist);
  const pkg = stageFrom(repo, root);
  opts?.beforeSnapshot?.(repo, pkg);
  const contract = path.join(root, 'release-contract.json');
  const captured = snapshot(repo, contract);
  expect(captured.code, `the release contract could not be captured: ${captured.out}`).toBe(0);
  return { root, repo, pkg, contract };
}

/**
 * The archives are assembled from raw headers rather than by shelling out to `tar -czf`. That is
 * not a style choice: the defects below are archives no `tar(1)` will write for you — a duplicate
 * member, a name ending in a space, a required entry that is a link — and on macOS bsdtar adds
 * AppleDouble members of its own, which would put junk in every "healthy" control archive.
 */
const stagedMembers = (b: Bench): ArchiveMember[] => membersOf(path.join(b.root, 'tree'));

const packMembers = async (b: Bench, members: ArchiveMember[]): Promise<string> =>
  writeTarball(path.join(b.root, 'sthayi-0.0.0.tgz'), members);

const pack = async (b: Bench): Promise<string> => packMembers(b, stagedMembers(b));

/** Settles the staged tree as it currently stands against the contract `bench()` captured. */
const settle = async (b: Bench): Promise<RunResult> => verify(await pack(b), b.contract);

/** Every regular file under `packages/cli/prompts`, as tarball-relative paths. */
function promptTree(): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      const here = rel === '' ? name : `${rel}/${name}`;
      if (fs.lstatSync(abs).isDirectory()) walk(abs, here);
      else out.push(path.posix.join('prompts', here));
    }
  };
  walk(path.join(cliDir, 'prompts'), '');
  return out;
}

describe('the verifier reads the archive, and refuses what it says it refuses', () => {
  it('a complete archive passes', async () => {
    const b = bench();
    const r = await settle(b);
    wipe(b.root);

    expect(r.code, `a complete tarball was refused: ${r.out}`).toBe(0);
    expect(r.out, 'the verifier said nothing about what it checked').toContain(
      'tarball contents OK',
    );
  });

  it('refuses to run at all without a captured contract', async () => {
    // THE HOLE THIS CLOSES: a fallback that re-derived the expectation from the working tree would
    // be re-deriving it from whatever the package lifecycle just wrote there.
    const b = bench();
    const r = verify(await pack(b));
    wipe(b.root);

    expect(r.code, `the verifier ran with no release contract: ${r.out}`).toBe(2);
    expect(r.out, 'the usage does not name the contract').toContain('--contract');
  });

  it('refuses a contract file that is not one', async () => {
    const b = bench();
    const bogus = path.join(b.root, 'bogus.json');
    fs.writeFileSync(bogus, '{"files":{"dist/index.js":"deadbeef"}}\n');
    const r = verify(await pack(b), bogus);
    wipe(b.root);

    expect(r.code, `a foreign JSON stood in for a release contract: ${r.out}`).toBe(2);
    expect(r.out, 'the refusal does not name the contract kind').toContain(
      'sthayi-release-contract',
    );
  });

  // THE OMISSION MUTATION, one contracted entry at a time — DERIVED from the prompt pack and the
  // manifest rather than listed, so a prompt or fixture added to the source is covered here with no
  // edit. Each is a real release defect: an entry point the package stopped shipping, a doc npm
  // would have shown on the package page, a prompt `loadPrompt` would fail closed on, a fixture
  // `qualify` would silently stop running.
  const OMISSIONS = [
    ...Object.keys(DIST_STUB).map((k) => path.posix.join('dist', k)),
    ...promptTree(),
    'README.md',
    'LICENSE',
    'package.json',
  ];

  it('the derived omission set covers the whole prompt pack, fixtures included', () => {
    // A guard on the guard: if `promptTree()` ever returned nothing, every case below would be
    // vacuous and the suite would still be green.
    expect(OMISSIONS, 'the omission set is not derived from the prompt pack').toContain(
      'prompts/consolidate@v1.md',
    );
    const fixtures = OMISSIONS.filter((e) => e.startsWith('prompts/fixtures/'));
    expect(
      fixtures.length,
      'no prompt fixtures were derived into the omission set',
    ).toBeGreaterThan(2);
  });

  it.each(OMISSIONS)('dropping %s turns the gate red', async (rel) => {
    const b = bench();
    const dropped = path.join(b.pkg, rel);
    const existed = fs.existsSync(dropped);
    fs.rmSync(dropped, { force: true });
    const r = await settle(b);
    wipe(b.root);

    // The mutation has to have removed something, or its red result would prove nothing.
    expect(existed, `'${rel}' was not in the staged archive — the omission proves nothing`).toBe(
      true,
    );
    expect(r.code, `the tarball was accepted without '${rel}': ${r.out}`).not.toBe(0);
    expect(r.out, 'the failure does not name the missing entry').toContain(
      `does not ship '${rel}'`,
    );
  });

  it('a whole missing prompt fixture directory is caught, not averaged away', async () => {
    const b = bench();
    fs.rmSync(path.join(b.pkg, 'prompts', 'fixtures'), { recursive: true, force: true });
    const r = await settle(b);
    wipe(b.root);

    expect(r.code, `a tarball with no fixtures at all was accepted: ${r.out}`).not.toBe(0);
    expect(r.out, 'the missing fixtures were not named').toContain('prompts/fixtures/');
  });

  it.each([
    ['src/index.ts', '// source\n', 'TypeScript source'],
    ['lib/thing.ts', '// source\n', 'TypeScript source'],
    ['tests/x.test.js', '// test\n', 'a test file'],
    ['docs/RELEASE.md', '# release\n', 'repository documentation'],
    ['SECURITY.md', '# security\n', 'a repository page the package does not publish'],
    ['.npmrc', '//registry.npmjs.org/:_authToken=x\n', 'a credential file'],
    ['deploy.pem', 'x\n', 'a credential file'],
    ['node_modules/left/index.js', '\n', 'a dependency tree'],
    ['pnpm-lock.yaml', 'lockfileVersion: 9\n', 'a lockfile'],
  ])('shipping %s is refused', async (rel, body, why) => {
    const b = bench();
    writeFile(b.pkg, rel, body);
    const r = await settle(b);
    wipe(b.root);

    expect(r.code, `the tarball shipped '${rel}' and was accepted: ${r.out}`).not.toBe(0);
    expect(r.out, `the refusal does not explain why '${rel}' is refused`).toContain(why);
  });

  it.each([
    [
      '.env',
      'ANTHROPIC_API_KEY=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA\n',
      'an Anthropic API key',
    ],
    ['leak.md', 'AKIAABCDEFGHIJKLMNOP\n', 'an AWS access key id'],
    [
      'key.md',
      '-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----\n',
      'a private key block',
    ],
  ])('a secret VALUE inside %s is found in the bytes', async (rel, body, what) => {
    const b = bench();
    writeFile(b.pkg, rel, body);
    const r = await settle(b);
    wipe(b.root);

    expect(r.code, `a tarball carrying ${what} was accepted: ${r.out}`).not.toBe(0);
    expect(r.out, 'the secret was not identified').toContain(what);
  });

  it("the CLI's own masking patterns in shipped code are not mistaken for secrets", async () => {
    // The detectors compile into `dist`, so their pattern text is legitimately in the archive. A
    // scanner that matched the SHAPE rather than a value would refuse every correct release. The
    // chunk is in the MIRROR's `dist`, so this is a single-axis test: the archive matches the
    // contract exactly and only the key scan is in question.
    const b = bench({
      dist: {
        ...DIST_STUB,
        'chunk.js':
          'var D=[{re:/\\bsk-ant-[A-Za-z0-9_-]{20,}/g},{re:/\\bAKIA[0-9A-Z]{16}\\b/g},' +
          '{re:/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g},{re:/\\bnpm_[A-Za-z0-9]{36,}/g}];\n',
        'chunk.js.map': '{"version":3,"sources":["../src/vault/detectors.ts"]}\n',
      },
    });
    const r = await settle(b);
    wipe(b.root);

    expect(r.code, `the masking patterns were read as secrets: ${r.out}`).toBe(0);
  });

  it('an entry outside the package/ prefix is refused', async () => {
    const b = bench();
    const members = stagedMembers(b);
    members.push({ name: 'elsewhere/x', type: 'file', body: Buffer.from('x\n') });
    const r = verify(await packMembers(b, members), b.contract);
    wipe(b.root);

    expect(r.code, `a tarball writing outside package/ was accepted: ${r.out}`).not.toBe(0);
    expect(r.out, 'the stray entry was not named').toContain('outside the package/ prefix');
  });

  it('the required set is DERIVED from the source, not written into the verifier', async () => {
    // The mirror's oracle source declares one more prompt op, and the pack gains the files that op
    // needs — BEFORE the capture. The staging tree is left alone. If the requirement really follows
    // the code, the contract now asks for a prompt and a fixture the archive does not carry, which
    // is what makes adding a prompt to the CLI a release gate with no edit to the verifier.
    const b = bench({
      beforeSnapshot: (repo) => {
        const cli = path.join(repo, 'packages', 'cli');
        writeFile(cli, 'prompts/summarise@v1.md', '# summarise\n');
        writeFile(
          cli,
          'prompts/fixtures/summarise/01.json',
          '{"input":{"items":[]},"expect":{"empty":true}}\n',
        );
        fs.writeFileSync(
          path.join(cli, 'src', 'oracle', 'prompts.ts'),
          "const PROMPT_OPS = new Set(['consolidate', 'distill', 'contradictions', 'summarise']);\n",
        );
        fs.writeFileSync(
          path.join(cli, 'src', 'oracle', 'qualify.ts'),
          "const OPS = ['consolidate', 'distill', 'contradictions', 'summarise'];\n",
        );
      },
    });
    const r = await settle(b);
    wipe(b.root);

    expect(
      r.code,
      `a prompt declared in the source was not required in the tarball: ${r.out}`,
    ).not.toBe(0);
    expect(r.out, 'the newly declared prompt was not required').toContain(
      "does not ship 'prompts/summarise@v1.md'",
    );
    expect(r.out, "the newly declared prompt's fixtures were not required").toContain(
      "does not ship 'prompts/fixtures/summarise/01.json'",
    );
  });

  it('a prompt op the source declares with no file behind it fails the CAPTURE', async () => {
    // The derivation is only worth anything if an undeclarable requirement stops the release rather
    // than quietly dropping out of the contract.
    const root = scratchDir();
    const repo = mirrorRepo(root);
    fs.writeFileSync(
      path.join(repo, 'packages', 'cli', 'src', 'oracle', 'prompts.ts'),
      "const PROMPT_OPS = new Set(['consolidate', 'distill', 'contradictions', 'summarise']);\n",
    );
    const r = snapshot(repo, path.join(root, 'c.json'));
    wipe(root);

    expect(r.code, `a prompt with no file behind it was contracted anyway: ${r.out}`).not.toBe(0);
    expect(r.out, 'the undeclarable prompt was not named').toContain(
      'prompts/summarise@v1.md is not there',
    );
  });
});

// ===============================================================================================
// THE CONTRACTED TREES ARE EXACT SETS.
//
// "Every required entry is present" is not the property that matters. `loadFixtures` reads EVERY
// `.json` in `prompts/fixtures/<op>`, so one extra file there is one extra case `qualify` executes
// on the user's machine; one extra `dist/*.js` is one more module the installed package can load;
// and a `dist/index.js` swapped for different code behind the same name is missing nothing at all.
// Each archive below is a SINGLE mutation applied to an archive that passes without it.
// ===============================================================================================

describe('the archived prompts tree is exactly the pack the release contracted', () => {
  it('an EXTRA prompt fixture the release does not contract is refused', async () => {
    const b = bench();
    writeFile(
      b.pkg,
      'prompts/fixtures/consolidate/99-generated.json',
      '{"input":{"items":[]},"expect":{"empty":true}}\n',
    );
    const r = await settle(b);
    wipe(b.root);

    expect(r.code, `an extra qualify case was accepted: ${r.out}`).not.toBe(0);
    expect(r.out, 'the extra fixture was not named').toContain(
      "the tarball ships 'prompts/fixtures/consolidate/99-generated.json', which the release contract's 'prompts/' tree does not hold",
    );
  });

  it('a fixture directory for an operation the release does not contract is refused', async () => {
    const b = bench();
    writeFile(b.pkg, 'prompts/fixtures/summarise/01.json', '{"input":{},"expect":{}}\n');
    const r = await settle(b);
    wipe(b.root);

    expect(r.code, `a fixture for an unknown operation was accepted: ${r.out}`).not.toBe(0);
    expect(r.out, 'the unknown operation was not named').toContain(
      "the tarball ships 'prompts/fixtures/summarise/01.json', which the release contract's 'prompts/' tree does not hold",
    );
  });

  it('a REWRITTEN prompt fixture is refused', async () => {
    const b = bench();
    const target = path.join(b.pkg, 'prompts', 'fixtures', 'consolidate', '01.json');
    expect(fs.existsSync(target), 'there is no consolidate fixture to rewrite').toBe(true);
    fs.writeFileSync(target, '{"input":{"items":[]},"expect":{"anything":true}}\n');
    const r = await settle(b);
    wipe(b.root);

    expect(r.code, `a rewritten qualify case was accepted: ${r.out}`).not.toBe(0);
    expect(r.out, 'the divergence was not named').toContain(
      "the tarball's 'prompts/fixtures/consolidate/01.json' is not byte-identical to",
    );
  });

  it('an EXTRA generated Markdown file is refused', async () => {
    // `npm pack` runs the package lifecycle. A `prepack` that writes a Markdown file produces a
    // published page that exists nowhere in the repository and that no reviewer ever read.
    const b = bench();
    writeFile(b.pkg, 'prompts/extra.md', '# generated at pack time\n');
    const r = await settle(b);
    wipe(b.root);

    expect(r.code, `a generated Markdown file was accepted: ${r.out}`).not.toBe(0);
    expect(r.out, 'the uncontracted page was not named').toContain(
      "the tarball ships 'prompts/extra.md', a Markdown file the release does not contract",
    );
  });

  it.each([
    ['package/README.md', 'README.md'],
    ['package/prompts/consolidate@v1.md', 'prompts/consolidate@v1.md'],
    ['package/LICENSE', 'LICENSE'],
  ])('a REWRITTEN %s is refused', async (member, entry) => {
    const b = bench();
    const members = stagedMembers(b);
    const original = bodyOf(members, member);
    const mutated = replaceMember(members, member, {
      name: member,
      type: 'file',
      body: Buffer.concat([original, Buffer.from('\nappended at pack time\n')]),
    });
    const r = verify(await packMembers(b, mutated), b.contract);
    wipe(b.root);

    expect(r.code, `a rewritten '${entry}' was accepted: ${r.out}`).not.toBe(0);
    expect(r.out, 'the divergence was not named').toContain(
      `the tarball's '${entry}' is not byte-identical to`,
    );
  });
});

describe('the archived dist tree is exactly the build the release contracted', () => {
  it('a SUBSTITUTED dist/index.js is refused even though its map still matches it', async () => {
    // The shape a lifecycle substitution actually has: the entry point is present, its sourcemap is
    // present, every name a listing would print is unchanged, and the program is different.
    const b = bench();
    writeFile(b.pkg, 'dist/index.js', "#!/usr/bin/env node\nthrow new Error('substituted');\n");
    const r = await settle(b);
    wipe(b.root);

    expect(r.code, `a substituted entry point was accepted: ${r.out}`).not.toBe(0);
    expect(r.out, 'the substitution was not named').toContain(
      "the tarball's 'dist/index.js' is not byte-identical to",
    );
  });

  it('an EXTRA dist module is refused even with a matching sourcemap', async () => {
    const b = bench();
    writeFile(b.pkg, 'dist/generated.js', 'export const evil = 1;\n');
    writeFile(b.pkg, 'dist/generated.js.map', '{"version":3,"sources":[]}\n');
    const r = await settle(b);
    wipe(b.root);

    expect(r.code, `an extra dist module was accepted: ${r.out}`).not.toBe(0);
    expect(r.out, 'the extra module was not named').toContain(
      "the tarball ships 'dist/generated.js', which the release contract's 'dist/' tree does not hold",
    );
    expect(r.out, 'the extra map was not named').toContain(
      "the tarball ships 'dist/generated.js.map', which the release contract's 'dist/' tree does not hold",
    );
  });
});

// ===============================================================================================
// THE ARCHIVE AS A WHOLE IS THE CONTRACTED SET PLUS package.json — IN BOTH DIRECTIONS.
//
// The required-entry loop settles one direction only: nothing contracted is missing. Every rule
// that refuses EXTRAS is scoped — `dist/` and `prompts/` as exact trees, Markdown as an exact set,
// `REJECTED` as a deny-list — so a file at the package ROOT whose name is none of those fell
// through all of them. And that gap is reachable: the release does NOT pack the checkout, it packs
// a STAGING TREE, and the staging gate has already returned by the time `npm pack` reads it, so the
// interval in between is a real boundary a member can be written across.
//
// `npm pack` MAKES THE NAMES CONCRETE. It always ships a root README/LICENSE/LICENCE/NOTICE in
// whatever spelling it finds, `files` allowlist or not — so `package/README` and `package/README.md`
// are two different published files, and only one of them is the page anyone reviewed. Each archive
// below is a SINGLE post-stage injection into a staging tree that passes without it.
// ===============================================================================================

/** Root names npm ships unasked, none of which the release contracts. `.markdown` is not `.md`. */
const UNCONTRACTED_ROOT_NAMES = [
  'README',
  'README.txt',
  'README.markdown',
  'LICENSE.txt',
  'LICENCE',
];

describe('the published archive is the contracted set, never a superset of it', () => {
  it.each(UNCONTRACTED_ROOT_NAMES)(
    'a root %s written into the stage AFTER the staging gate is refused',
    async (name) => {
      const b = bench();
      // The staging tree is settled, and THEN this appears. No tree rule covers the package root,
      // no Markdown rule sees a name that does not end in `.md`, and npm publishes it regardless.
      writeFile(b.pkg, name, 'x\n');
      const r = await settle(b);
      wipe(b.root);

      expect(r.code, `an uncontracted '${name}' was published: ${r.out}`).not.toBe(0);
      expect(r.out, `'${name}' was not named as uncontracted`).toContain(
        `the tarball ships '${name}', which the release does not contract`,
      );
    },
  );

  it('a root README injected BEFORE the capture is refused too — the stage is not the authority', async () => {
    // The contract is derived from the REPOSITORY. Getting a file into the staging tree earlier
    // does not get it into the contract, so it cannot launder itself by being there first.
    const b = bench({ beforeSnapshot: (_repo, pkg) => writeFile(pkg, 'README', 'x\n') });
    const r = await settle(b);
    wipe(b.root);

    expect(r.code, `staging a file before the capture laundered it: ${r.out}`).not.toBe(0);
    expect(r.out, 'the uncontracted page was not named').toContain(
      "the tarball ships 'README', which the release does not contract",
    );
  });

  it('the FAITHFUL archive is exactly the contracted set plus package.json, and passes', async () => {
    // The control the exactness rule has to survive: the real prompt pack, the real build, and the
    // two contracted root pages `README.md` and `LICENSE` — root files under no contracted tree,
    // which the rule must let through because the contract holds them.
    const b = bench();
    const captured = JSON.parse(fs.readFileSync(b.contract, 'utf8')) as {
      files: Record<string, string>;
    };
    const r = await settle(b);
    const shipped = await packagedFiles(await pack(b));
    wipe(b.root);

    expect(r.code, `a faithful archive was refused: ${r.out}`).toBe(0);
    expect([...shipped.keys()].sort(), 'the control archive is not the contracted set').toEqual(
      [...Object.keys(captured.files), 'package.json'].sort(),
    );
    expect(
      [...shipped.keys()],
      'the control does not exercise root files at all, so it proves nothing',
    ).toEqual(expect.arrayContaining(['README.md', 'LICENSE']));
  });
});

// ===============================================================================================
// THE CAPTURE IS THE AUTHORITY, NOT THE WORKING TREE.
//
// The whole reason the contract is taken BEFORE `npm pack`: a lifecycle script can rewrite the
// packed copy AND the source it would be compared to, in one go. Against a live tree that
// substitute is compared to itself and passes. Against a capture it cannot be.
// ===============================================================================================

describe('a mutation applied after the capture is refused, however consistent it is', () => {
  it('rewriting the built entry point AND its source together is still refused', async () => {
    const b = bench();
    const rewritten = "#!/usr/bin/env node\nthrow new Error('substituted');\n";
    // Exactly what a hostile `prepack` has access to: the checkout and the staging tree.
    writeFile(path.join(b.repo, 'packages', 'cli'), 'dist/index.js', rewritten);
    writeFile(b.pkg, 'dist/index.js', rewritten);
    const r = await settle(b);
    wipe(b.root);

    expect(r.code, `a substitution that also rewrote its source was accepted: ${r.out}`).not.toBe(
      0,
    );
    expect(r.out, 'the substitution was not named').toContain(
      "the tarball's 'dist/index.js' is not byte-identical to",
    );
  });

  it('rewriting the README AND the repo copy it is checked against is still refused', async () => {
    const b = bench();
    const rewritten = '# a page no reviewer read\n';
    fs.writeFileSync(path.join(b.repo, 'README.md'), rewritten);
    fs.writeFileSync(path.join(b.pkg, 'README.md'), rewritten);
    const r = await settle(b);
    wipe(b.root);

    expect(r.code, `a rewritten README with a matching source was accepted: ${r.out}`).not.toBe(0);
    expect(r.out, 'the divergence was not named').toContain(
      "the tarball's 'README.md' is not byte-identical to",
    );
  });

  it('adding a fixture to the source AND to the pack after the capture is still refused', async () => {
    const b = bench();
    const body = '{"input":{"items":[]},"expect":{"empty":true}}\n';
    writeFile(
      path.join(b.repo, 'packages', 'cli'),
      'prompts/fixtures/consolidate/99-generated.json',
      body,
    );
    writeFile(b.pkg, 'prompts/fixtures/consolidate/99-generated.json', body);
    const r = await settle(b);
    wipe(b.root);

    expect(r.code, `a post-capture qualify case was accepted: ${r.out}`).not.toBe(0);
    expect(r.out, 'the extra fixture was not named').toContain(
      "which the release contract's 'prompts/' tree does not hold",
    );
  });
});

// ===============================================================================================
// THE PACKED MANIFEST DECIDES WHAT RUNS.
// ===============================================================================================

/** The packed manifest, mutated in place. Returns nothing; the staging tree is the subject. */
function editPackedManifest(pkg: string, edit: (m: Record<string, unknown>) => void): void {
  const at = path.join(pkg, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(at, 'utf8')) as Record<string, unknown>;
  edit(manifest);
  fs.writeFileSync(at, `${JSON.stringify(manifest, null, 2)}\n`);
}

describe('the packed package.json is settled against the manifest the release contracted', () => {
  it('a manifest re-serialised with different key order and indentation still passes', async () => {
    // npm may re-serialise the manifest on the way into the archive, so the comparison is on the
    // FACTS and not on the bytes. Without this control every release would be red for a newline.
    const b = bench();
    const at = path.join(b.pkg, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(at, 'utf8')) as Record<string, unknown>;
    const reversed = Object.fromEntries(Object.entries(manifest).reverse());
    fs.writeFileSync(at, JSON.stringify(reversed));
    const r = await settle(b);
    wipe(b.root);

    expect(r.code, `a re-serialised manifest was refused: ${r.out}`).toBe(0);
  });

  it('a manifest whose bin and main point at a file the archive does not ship is refused', async () => {
    // The bypass this closes: every contracted file is present and byte-perfect, and the installed
    // `sthayi` command resolves to nothing.
    const b = bench();
    editPackedManifest(b.pkg, (m) => {
      m.bin = { sthayi: './dist/not-there.js' };
      m.main = './dist/not-there.js';
    });
    const r = await settle(b);
    wipe(b.root);

    expect(r.code, `a manifest pointing at an absent entry point was accepted: ${r.out}`).not.toBe(
      0,
    );
    expect(r.out, 'the repointed entry was not named').toContain(
      "the tarball's 'package.json' declares 'bin' as",
    );
    // And the target the PACKED manifest names is required, not just the one the contract holds.
    expect(r.out, "the packed manifest's own target was not required").toContain(
      "does not ship 'dist/not-there.js'",
    );
  });

  it.each(['preinstall', 'install', 'postinstall', 'prepare'])(
    'a manifest that adds a %s hook is refused by name',
    async (hook) => {
      const b = bench();
      editPackedManifest(b.pkg, (m) => {
        m.scripts = { ...(m.scripts as Record<string, string>), [hook]: 'node ./dist/index.js' };
      });
      const r = await settle(b);
      wipe(b.root);

      expect(r.code, `an added '${hook}' hook was accepted: ${r.out}`).not.toBe(0);
      expect(r.out, 'the install-time hook was not named as one').toContain(
        `declares a '${hook}' script the release does not contract`,
      );
      expect(r.out, 'the reason an install-time hook matters was not given').toContain(
        "runs on the installing user's machine",
      );
    },
  );

  it('the pack-time hooks the package already declares are allowed, unchanged', async () => {
    // `prepack`/`postpack` are how README.md and LICENSE get into the package at all. The control
    // archive passing is what proves the hook check is a CHANGE detector, not a ban.
    const b = bench();
    const manifest = JSON.parse(fs.readFileSync(path.join(b.pkg, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const r = await settle(b);
    wipe(b.root);

    expect(
      manifest.scripts?.prepack,
      'the package no longer declares a prepack hook',
    ).toBeDefined();
    expect(r.code, `the contracted prepack/postpack hooks were refused: ${r.out}`).toBe(0);
  });

  it('a REWRITTEN prepack hook is refused', async () => {
    const b = bench();
    editPackedManifest(b.pkg, (m) => {
      m.scripts = { ...(m.scripts as Record<string, string>), prepack: 'node ./evil.mjs' };
    });
    const r = await settle(b);
    wipe(b.root);

    expect(r.code, `a rewritten prepack hook was accepted: ${r.out}`).not.toBe(0);
    expect(r.out, 'the rewritten script set was not named').toContain(
      "the tarball's 'package.json' declares 'scripts' as",
    );
  });

  it.each([
    [
      'a dependency the release never resolved',
      (m: Record<string, unknown>) => {
        m.dependencies = { ...(m.dependencies as Record<string, string>), leftpad: '^1.0.0' };
      },
      'dependencies',
    ],
    [
      'a widened engines range',
      (m: Record<string, unknown>) => {
        m.engines = { node: '>=18' };
      },
      'engines',
    ],
    [
      'a widened files allowlist',
      (m: Record<string, unknown>) => {
        m.files = ['dist', 'prompts', 'src'];
      },
      'files',
    ],
    [
      'a different version',
      (m: Record<string, unknown>) => {
        m.version = '99.0.0';
      },
      'version',
    ],
    [
      'a different name',
      (m: Record<string, unknown>) => {
        m.name = 'sthayi-but-not';
      },
      'name',
    ],
    [
      'a different MCP Registry ownership identity',
      (m: Record<string, unknown>) => {
        m.mcpName = 'io.github.someone-else/sthayi';
      },
      'mcpName',
    ],
    [
      'a missing MCP Registry ownership identity',
      (m: Record<string, unknown>) => {
        m.mcpName = undefined;
      },
      'mcpName',
    ],
    [
      'a restricted publishConfig turned public elsewhere',
      (m: Record<string, unknown>) => {
        m.publishConfig = { access: 'restricted', registry: 'https://example.invalid' };
      },
      'publishConfig',
    ],
    [
      'an os restriction the release never declared',
      (m: Record<string, unknown>) => {
        m.os = ['win32'];
      },
      'os',
    ],
    [
      'a bundled-dependency list',
      (m: Record<string, unknown>) => {
        m.bundledDependencies = ['leftpad'];
      },
      'bundledDependencies',
    ],
    [
      'a bundled-dependency list under the other spelling',
      (m: Record<string, unknown>) => {
        m.bundleDependencies = ['leftpad'];
      },
      'bundleDependencies',
    ],
    [
      'an optional dependency',
      (m: Record<string, unknown>) => {
        m.optionalDependencies = { fsevents: '*' };
      },
      'optionalDependencies',
    ],
  ])('a manifest declaring %s is refused', async (_what, edit, field) => {
    const b = bench();
    editPackedManifest(b.pkg, edit);
    const r = await settle(b);
    wipe(b.root);

    expect(r.code, `a manifest declaring a different '${field}' was accepted: ${r.out}`).not.toBe(
      0,
    );
    expect(r.out, `the '${field}' divergence was not named`).toContain(
      `the tarball's 'package.json' declares '${field}' as`,
    );
  });

  it('a packed manifest that is not valid UTF-8 is refused', async () => {
    const b = bench();
    const members = replaceMember(stagedMembers(b), 'package/package.json', {
      name: 'package/package.json',
      type: 'file',
      // A lone continuation byte: no UTF-8 sequence starts with 0x80.
      body: Buffer.concat([Buffer.from('{"name":"'), Buffer.from([0x80]), Buffer.from('"}\n')]),
    });
    const r = verify(await packMembers(b, members), b.contract);
    wipe(b.root);

    expect(r.code, `a manifest that is not UTF-8 was accepted: ${r.out}`).not.toBe(0);
    expect(r.out, 'the encoding failure was not named').toContain(
      "the tarball's 'package.json' is not valid UTF-8",
    );
  });

  it('a packed manifest that is not valid JSON is refused', async () => {
    const b = bench();
    fs.writeFileSync(path.join(b.pkg, 'package.json'), '{"name":"sthayi",\n');
    const r = await settle(b);
    wipe(b.root);

    expect(r.code, `an unparseable manifest was accepted: ${r.out}`).not.toBe(0);
    expect(r.out, 'the parse failure was not named').toContain(
      "the tarball's 'package.json' is not valid JSON",
    );
  });
});

// ===============================================================================================
// THE STRUCTURAL HALF: archives that satisfy a NAME LISTING while shipping something else.
//
// Every archive below was accepted by the previous `tar -tzf` implementation, which trimmed the
// names it read, could not see a member's type, collapsed duplicates into a Set, and then
// EXTRACTED before reading anything — so a required entry could be a link the checker followed
// off the package entirely. These are the exact shapes, one test each.
// ===============================================================================================

describe('a required entry has to be a real regular file, not something that looks like one', () => {
  it('a required README that is a SYMLINK to another entry is refused', async () => {
    const b = bench();
    const members = replaceMember(stagedMembers(b), 'package/README.md', {
      name: 'package/README.md',
      type: 'symlink',
      linkname: 'LICENSE',
    });
    const r = verify(await packMembers(b, members), b.contract);
    wipe(b.root);

    expect(r.code, `a symlinked README was accepted: ${r.out}`).not.toBe(0);
    expect(r.out, 'the member type was not named').toContain('a symbolic link');
    // And it does not count as shipping the file: an install would resolve the link, not read it.
    expect(r.out, 'a link stood in for the required entry').toContain("does not ship 'README.md'");
  });

  it('a required README that is a HARD LINK to another entry is refused', async () => {
    const b = bench();
    const members = replaceMember(stagedMembers(b), 'package/README.md', {
      name: 'package/README.md',
      type: 'link',
      linkname: 'package/LICENSE',
    });
    const r = verify(await packMembers(b, members), b.contract);
    wipe(b.root);

    expect(r.code, `a hardlinked README was accepted: ${r.out}`).not.toBe(0);
    expect(r.out, 'the member type was not named').toContain('a hard link');
    expect(r.out, 'a link stood in for the required entry').toContain("does not ship 'README.md'");
  });

  it('a shipped entry point that is a SYMLINK OUT OF THE PACKAGE is refused', async () => {
    // The worst shape: `dist/index.js` pointing at /etc/hosts. A checker that stats or reads the
    // extracted path sees a perfectly ordinary file and reports the entry point as present.
    const b = bench();
    const members = replaceMember(stagedMembers(b), 'package/dist/index.js', {
      name: 'package/dist/index.js',
      type: 'symlink',
      linkname: '/etc/hosts',
    });
    const r = verify(await packMembers(b, members), b.contract);
    wipe(b.root);

    expect(r.code, `an entry point symlinked to /etc/hosts was accepted: ${r.out}`).not.toBe(0);
    expect(r.out, 'the member type was not named').toContain('a symbolic link');
    expect(r.out, 'the link stood in for the entry point').toContain(
      "does not ship 'dist/index.js'",
    );
  });

  it('a DUPLICATE member is refused rather than deduplicated', async () => {
    // Two members, one name. Which one an extractor keeps is the extractor's business; a listing
    // put through a Set shows one line either way.
    const b = bench();
    const members = stagedMembers(b);
    members.push({
      name: 'package/README.md',
      type: 'file',
      body: Buffer.from('# not the README you reviewed\n'),
    });
    const r = verify(await packMembers(b, members), b.contract);
    wipe(b.root);

    expect(r.code, `a tarball with two READMEs was accepted: ${r.out}`).not.toBe(0);
    expect(r.out, 'the duplicate was not named').toContain(
      "the tarball ships 'package/README.md' more than once",
    );
  });

  it('two members that COLLIDE on a case-insensitive filesystem are refused', async () => {
    const b = bench();
    const members = stagedMembers(b);
    members.push({ name: 'package/readme.md', type: 'file', body: Buffer.from('# other\n') });
    const r = verify(await packMembers(b, members), b.contract);
    wipe(b.root);

    expect(r.code, `a case-colliding pair was accepted: ${r.out}`).not.toBe(0);
    expect(r.out, 'the collision was not named').toContain('resolve to the same path');
  });

  it('a required prompt renamed with a TRAILING SPACE does not satisfy the requirement', async () => {
    // `tar -tzf | trim` reports this as `prompts/consolidate@v1.md`. On disk it is a different
    // file, and `loadPrompt` fails closed on the op.
    const b = bench();
    const members = stagedMembers(b);
    const body = bodyOf(members, 'package/prompts/consolidate@v1.md');
    const mutated = replaceMember(members, 'package/prompts/consolidate@v1.md', {
      name: 'package/prompts/consolidate@v1.md ',
      type: 'file',
      body,
    });
    const r = verify(await packMembers(b, mutated), b.contract);
    wipe(b.root);

    expect(r.code, `a trailing-space prompt name was accepted: ${r.out}`).not.toBe(0);
    expect(r.out, 'the whitespace was not named').toContain(
      'has leading or trailing whitespace in a path segment',
    );
    expect(r.out, 'the trimmed name satisfied the requirement').toContain(
      "does not ship 'prompts/consolidate@v1.md'",
    );
  });

  it('a member that traverses out of the package is refused BY THE VERIFIER', async () => {
    // This one used to "fail" only because bsdtar refused to extract it. The refusal has to come
    // from reading the header, not from whichever extractor happens to be installed.
    const b = bench();
    const members = stagedMembers(b);
    members.push({ name: 'package/../escape', type: 'file', body: Buffer.from('owned\n') });
    const r = verify(await packMembers(b, members), b.contract);
    wipe(b.root);

    expect(r.code, `a traversing member was accepted: ${r.out}`).not.toBe(0);
    expect(r.out, 'the traversal was not named').toContain(
      "has a '..' path segment — that is a directory traversal",
    );
  });

  it('an ABSOLUTE member name is refused', async () => {
    const b = bench();
    const members = stagedMembers(b);
    members.push({ name: '/etc/cron.d/sthayi', type: 'file', body: Buffer.from('* * * * *\n') });
    const r = verify(await packMembers(b, members), b.contract);
    wipe(b.root);

    expect(r.code, `an absolute member name was accepted: ${r.out}`).not.toBe(0);
    expect(r.out, 'the absolute name was not named').toContain('has an absolute name');
  });

  it('a BACKSLASH in a member name is refused', async () => {
    // A backslash is a separator on the platform half this package's users are on.
    const b = bench();
    const members = stagedMembers(b);
    members.push({ name: 'package\\..\\..\\evil.js', type: 'file', body: Buffer.from('x\n') });
    const r = verify(await packMembers(b, members), b.contract);
    wipe(b.root);

    expect(r.code, `a backslash member name was accepted: ${r.out}`).not.toBe(0);
    expect(r.out, 'the backslash was not named').toContain('has a backslash in its name');
  });

  it('a CONTROL CHARACTER in a member name is refused, and reported escaped', async () => {
    const b = bench();
    const members = stagedMembers(b);
    members.push({
      name: `package/quiet${String.fromCharCode(1)}.txt`,
      type: 'file',
      body: Buffer.from('x\n'),
    });
    const r = verify(await packMembers(b, members), b.contract);
    wipe(b.root);

    expect(r.code, `a control character in a name was accepted: ${r.out}`).not.toBe(0);
    expect(r.out, 'the control character was not named').toContain(
      'has a control character in its name',
    );
    expect(r.out, 'the raw control byte was written into the log').toContain('quiet\\x01.txt');
  });

  it.each([
    ['character-device', 'a device node'],
    ['block-device', 'a device node'],
    ['fifo', 'a FIFO'],
  ] as const)('a %s member is refused', async (type, why) => {
    const b = bench();
    const members = stagedMembers(b);
    members.push({ name: 'package/node0', type });
    const r = verify(await packMembers(b, members), b.contract);
    wipe(b.root);

    expect(r.code, `a ${type} member was accepted: ${r.out}`).not.toBe(0);
    expect(r.out, 'the member type was not named').toContain(why);
  });

  it('a credential hidden behind a NUL byte is still found', async () => {
    // The old scanner skipped any member containing a NUL as "binary, not text a credential is
    // pasted into". One NUL in front of the key was the whole bypass.
    const b = bench();
    const members = stagedMembers(b);
    members.push({
      name: 'package/blob.bin',
      type: 'file',
      body: Buffer.concat([
        Buffer.from([0x00, 0x01, 0x02, 0x00]),
        Buffer.from(`sk-proj-${'A'.repeat(28)}\n`),
      ]),
    });
    const r = verify(await packMembers(b, members), b.contract);
    wipe(b.root);

    expect(r.code, `a NUL-shielded credential was accepted: ${r.out}`).not.toBe(0);
    expect(r.out, 'the secret was not identified').toContain('an OpenAI API key');
  });
});

// ===============================================================================================
// SOURCEMAPS STAY — AND ARE HELD TO A CONTRACT.
//
// Each map below is put in the MIRROR's `dist`, so the archive matches the contract byte for byte
// and the only thing in question is the sourcemap rule itself.
// ===============================================================================================

describe('the shipped sourcemaps are complete, parseable and free of build-machine paths', () => {
  it('a shipped JS artifact with no map is refused', async () => {
    const b = bench();
    const members = replaceMember(stagedMembers(b), 'package/dist/index.js.map');
    const r = verify(await packMembers(b, members), b.contract);
    wipe(b.root);

    expect(r.code, `a mapless artifact was accepted: ${r.out}`).not.toBe(0);
    expect(r.out, 'the missing map was not named').toContain(
      "the tarball ships 'dist/index.js' with no 'dist/index.js.map'",
    );
  });

  it('an ORPHAN map, for a JS artifact that is not shipped, is refused', async () => {
    const b = bench({
      dist: { ...DIST_STUB, 'ghost.js.map': '{"version":3,"sources":[]}\n' },
    });
    const r = await settle(b);
    wipe(b.root);

    expect(r.code, `an orphan map was accepted: ${r.out}`).not.toBe(0);
    expect(r.out, 'the orphan was not named').toContain(
      "the tarball ships 'dist/ghost.js.map', a sourcemap for a JS artifact it does not ship",
    );
  });

  it('a map that is not valid JSON is refused', async () => {
    const b = bench({ dist: { ...DIST_STUB, 'index.js.map': '{"version":3,"sources":[\n' } });
    const r = await settle(b);
    wipe(b.root);

    expect(r.code, `a truncated map was accepted: ${r.out}`).not.toBe(0);
    expect(r.out, 'the parse failure was not named').toContain(
      "the tarball's 'dist/index.js.map' is not valid JSON",
    );
  });

  it.each([
    ['an absolute source', '{"version":3,"sources":["/Users/dev/sthayi/packages/cli/src/x.ts"]}'],
    ['a windows source', '{"version":3,"sources":["C:\\\\build\\\\sthayi\\\\src\\\\x.ts"]}'],
    ['a url source', '{"version":3,"sources":["file:///build/sthayi/src/x.ts"]}'],
    [
      'a relative path through a build home',
      '{"version":3,"sources":["../../../Users/dev/checkout/packages/cli/src/x.ts"]}',
    ],
    ['an absolute sourceRoot', '{"version":3,"sources":["../src/x.ts"],"sourceRoot":"/build/"}'],
  ])('a map naming %s is refused', async (_what, json) => {
    const b = bench({ dist: { ...DIST_STUB, 'index.js.map': `${json}\n` } });
    const r = await settle(b);
    wipe(b.root);

    expect(r.code, `a map leaking a build path was accepted: ${r.out}`).not.toBe(0);
    expect(r.out, 'the leaked path was not named').toContain(
      'may name only paths relative to the artifact',
    );
  });

  it("a credential inside a map's sourcesContent is found", async () => {
    // The map carries the TypeScript. Scanning the JS and skipping the map would leave the
    // largest text payload in the package unread.
    const b = bench({
      dist: {
        ...DIST_STUB,
        'index.js.map': `{"version":3,"sources":["../src/x.ts"],"sourcesContent":["const k = 'sk-ant-api03-${'B'.repeat(
          24,
        )}';"]}\n`,
      },
    });
    const r = await settle(b);
    wipe(b.root);

    expect(r.code, `a credential in sourcesContent was accepted: ${r.out}`).not.toBe(0);
    expect(r.out, 'the secret was not identified').toContain('an Anthropic API key');
  });

  it('source text that DISCUSSES absolute paths is not mistaken for a leaked one', async () => {
    // The real maps embed `fs-safe.ts`, whose comments name `/Users`, `/var/folders` and `/tmp`
    // while explaining why they are refused. The path check is on the map's STRUCTURAL fields —
    // `sources`, `sourceRoot`, `file` — precisely so this stays a passing release.
    const b = bench({
      dist: {
        ...DIST_STUB,
        'index.js.map':
          '{"version":3,"sources":["../src/fs-safe.ts"],"sourcesContent":' +
          '["// `/`, `/Users`, `/var/folders`, `/private/tmp` are all root-owned.\\n"]}\n',
      },
    });
    const r = await settle(b);
    wipe(b.root);

    expect(r.code, `a map whose SOURCE TEXT names absolute paths was refused: ${r.out}`).toBe(0);
  });
});

// ===============================================================================================
// THE RELEASE PATH ITSELF, EXECUTED — NOT THE VERIFIER IN ISOLATION.
//
// Everything above settles ONE archive against ONE contract. That is necessary and it is not
// sufficient, because the release's authority gap was never inside the verifier: it was in what
// could happen to the verifier's INPUTS between the capture and the verdict.
//
// THE BYPASS, REPRODUCED. `npm pack` in `packages/cli` runs `prepack` with `RUNNER_TEMP` inherited.
// One script can rewrite `dist/index.js` and recompute `contract.files["dist/index.js"]` inside
// `$RUNNER_TEMP/release-contract.json`, then let the pack proceed. The gate then reports
// "byte-identical, nothing refused" — it is comparing a substitute to itself — and the canary, which
// perturbed whatever contracted path sorted FIRST (`LICENSE`), still reports a refusal. CI prints
// "canary OK" about an artifact whose entry point is a payload. The same lifecycle can rewrite the
// checkout's copy of the verifier, so even the refusal is the attacker's to write.
//
// The steps below are read out of `.github/workflows/release.yml` and RUN — the real shell, in a
// synthetic mirror of this repository — so what is proved is the release's own behaviour and not a
// restatement of it. `describePosix`: this half executes bash and creates a symlink, so on win32 it
// is skipped rather than approximated; the placement half above runs everywhere.
// ===============================================================================================

const describePosix = describe.skipIf(process.platform === 'win32');

/** Bash by absolute path — `spawn('bash')` would resolve through whatever PATH it is handed. */
const REAL_BASH =
  ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', '/opt/homebrew/bin/bash'].find((p) =>
    fs.existsSync(p),
  ) ?? 'bash';

const digestOf = (buf: Buffer): string => crypto.createHash('sha256').update(buf).digest('hex');

interface Rig {
  /** The scratch root. `wipe(rig.root)` at the end of the test body. */
  root: string;
  /** The synthetic checkout the steps run in. */
  repo: string;
  /** What the steps see as `$RUNNER_TEMP`. */
  runnerTemp: string;
  /** Step outputs the workflow context would carry, filled in as steps run. */
  outputs: Record<string, string>;
  version: string;
  step: number;
}

/**
 * A mirror the RELEASE STEPS can run in: `mirrorRepo`'s tree plus the two scripts those steps
 * invoke by relative path, plus a module path (`tar-stream` is resolved by walking up from the
 * script, and the mirror is outside this repository).
 */
function releaseRig(opts?: { dist?: Record<string, string> }): Rig {
  const root = scratchDir();
  const repo = mirrorRepo(root, opts?.dist);
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  for (const s of ['verify-tarball-contents.mjs', 'stage-release-package.mjs']) {
    fs.copyFileSync(path.join(repoRoot, 'scripts', s), path.join(repo, 'scripts', s));
  }
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(repo, 'node_modules'), 'dir');
  const runnerTemp = path.join(root, 'runner-temp');
  fs.mkdirSync(runnerTemp, { recursive: true });
  const version = (
    JSON.parse(fs.readFileSync(path.join(repo, 'packages', 'cli', 'package.json'), 'utf8')) as {
      version: string;
    }
  ).version;
  return { root, repo, runnerTemp, outputs: {}, version, step: 0 };
}

/** The manifest the release will contract, edited in the mirror BEFORE anything is captured. */
function editRepoManifest(repo: string, edit: (m: Record<string, unknown>) => void): void {
  const at = path.join(repo, 'packages', 'cli', 'package.json');
  const manifest = JSON.parse(fs.readFileSync(at, 'utf8')) as Record<string, unknown>;
  edit(manifest);
  fs.writeFileSync(at, `${JSON.stringify(manifest, null, 2)}\n`);
}

/** `${{ }}` the runner would have substituted before the shell ever saw it. */
function resolveExpr(raw: string, rig: Rig): string {
  return raw
    .replace(/\$\{\{\s*needs\.preflight\.outputs\.version\s*\}\}/g, rig.version)
    .replace(
      /\$\{\{\s*steps\.authority\.outputs\.([a-z0-9-]+)\s*\}\}/g,
      (_m, key: string) => rig.outputs[key] ?? '',
    );
}

/**
 * ONE STEP OF THE RELEASE, RUN. The body, the declared `env:` and the `$GITHUB_OUTPUT` handling all
 * come from the workflow, so a step that stops doing what it claims turns these tests red rather
 * than turning a sentence in a comment stale.
 */
function runReleaseStep(
  rig: Rig,
  name: string,
  opts?: { env?: Record<string, string>; rewrite?: (body: string) => string },
): RunResult {
  const block = stepBlock(buildJobLines(), name);
  const body = runBody(block);
  expect(body, `the build job has no runnable \`${name}\` step`).not.toBe('');

  rig.step += 1;
  const ghOutput = path.join(rig.root, `github-output-${rig.step}`);
  fs.writeFileSync(ghOutput, '');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RUNNER_TEMP: rig.runnerTemp,
    GITHUB_OUTPUT: ghOutput,
    ...opts?.env,
  };
  for (const [key, raw] of Object.entries(stepEnv(block))) {
    env[key] = resolveExpr(raw, rig);
  }
  const script = opts?.rewrite === undefined ? body : opts.rewrite(body);
  const r = spawnSync(REAL_BASH, ['-c', script], { cwd: rig.repo, env, encoding: 'utf8' });
  for (const line of fs.readFileSync(ghOutput, 'utf8').split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) rig.outputs[line.slice(0, at)] = line.slice(at + 1);
  }
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** Capture → pin → stage → pack, each asserted green, in the order the workflow declares them. */
function runThroughPack(rig: Rig): void {
  for (const step of [CAPTURE_STEP, PIN_STEP, STAGE_STEP, PACK_STEP]) {
    const r = runReleaseStep(rig, step);
    expect(r.code, `the \`${step}\` step failed on a faithful mirror: ${r.out}`).toBe(0);
  }
}

const packedTarball = (rig: Rig): string =>
  path.join(rig.runnerTemp, 'release-pack', `sthayi-${rig.version}.tgz`);

const contractFile = (rig: Rig): string => path.join(rig.runnerTemp, 'release-contract.json');

/** The move the whole gap is about: rewrite a packed file AND its contracted digest, together. */
function rewriteEntryPointAndContract(rig: Rig): string {
  const payload = '#!/usr/bin/env node\n// MALICIOUS-PAYLOAD\n';
  fs.writeFileSync(path.join(rig.repo, 'packages', 'cli', 'dist', 'index.js'), payload);
  const contract = JSON.parse(fs.readFileSync(contractFile(rig), 'utf8')) as {
    files: Record<string, string>;
  };
  contract.files['dist/index.js'] = digestOf(Buffer.from(payload));
  fs.writeFileSync(contractFile(rig), `${JSON.stringify(contract, null, 2)}\n`);
  return payload;
}

describePosix('the release pack executes no package lifecycle', () => {
  it('a prepack that would write a marker is never executed, and the flag is what stops it', () => {
    const rig = releaseRig();
    const marker = path.join(rig.root, 'PREPACK-RAN');
    // Declared BEFORE the capture, so the contract, the stage and the packed manifest all agree on
    // it — this is a package whose lifecycle hook is legitimate as far as every other gate can see.
    editRepoManifest(rig.repo, (m) => {
      m.scripts = {
        ...(m.scripts as Record<string, string>),
        // Plain shell, so this file never spells a route into `fs` that
        // tests/safety/harness-fs-binding.test.ts has to make an exception for.
        prepack: 'printf ran > "$PREPACK_MARKER"',
        postpack: 'true',
      };
    });
    const env = { PREPACK_MARKER: marker };

    for (const step of [CAPTURE_STEP, PIN_STEP, STAGE_STEP]) {
      expect(runReleaseStep(rig, step, { env }).code, `\`${step}\` failed`).toBe(0);
    }
    const packed = runReleaseStep(rig, PACK_STEP, { env });
    const ranOnTheReleasePath = fs.existsSync(marker);

    // THE CONTROL. The same step, with `--ignore-scripts` taken out. If the marker does not appear
    // here, the assertion above is about a package that never had a working hook, and it proves
    // nothing at all.
    //
    // It also gets its OWN output directory, because the step creates that directory with plain
    // `mkdir` and refuses one that already exists — the run above made it. Renaming the path is the
    // one change needed to give this second run the precondition the step declares; the flag is
    // still the only thing that differs about what npm is asked to do.
    const control = runReleaseStep(rig, PACK_STEP, {
      env,
      rewrite: (body) =>
        body.replace(' --ignore-scripts', '').replace(/release-pack/g, 'release-pack-control'),
    });
    const ranWithoutTheFlag = fs.existsSync(marker);
    const archive = packedTarball(rig);
    const archiveExisted = fs.existsSync(archive);
    wipe(rig.root);

    expect(packed.code, `the release pack failed: ${packed.out}`).toBe(0);
    expect(archiveExisted, 'the release pack produced no archive').toBe(true);
    expect(
      ranOnTheReleasePath,
      "the package's `prepack` ran on the release path — arbitrary code executed between the release contract being captured and the archive being read",
    ).toBe(false);
    expect(
      ranWithoutTheFlag,
      `dropping --ignore-scripts did NOT run the prepack, so the case above proves nothing: ${control.out}`,
    ).toBe(true);
  });
});

describePosix('a lifecycle rewrite of the artifact AND the contract cannot reach a pass', () => {
  it('the pinned authority stops the release before the gate is asked for a verdict', () => {
    const rig = releaseRig();
    expect(runReleaseStep(rig, CAPTURE_STEP).code, 'the capture failed').toBe(0);
    expect(runReleaseStep(rig, PIN_STEP).code, 'the pin failed').toBe(0);
    expect(
      rig.outputs['contract-sha256'],
      'the pin step exported no contract digest into the workflow context',
    ).toMatch(/^[0-9a-f]{64}$/);

    const payload = rewriteEntryPointAndContract(rig);

    // The doctored contract agrees with the doctored tree, so the stage settles and the pack runs.
    // THAT IS THE BYPASS: every comparison downstream of here is the substitute against itself.
    const staged = runReleaseStep(rig, STAGE_STEP);
    const packed = runReleaseStep(rig, PACK_STEP);
    const asserted = runReleaseStep(rig, ASSERT_STEP);
    const shipped = fs.existsSync(packedTarball(rig));
    wipe(rig.root);

    expect(staged.code, `the doctored tree did not even stage: ${staged.out}`).toBe(0);
    expect(packed.code, `the doctored tree did not pack: ${packed.out}`).toBe(0);
    expect(shipped, 'nothing was packed, so the refusal below would be about nothing').toBe(true);
    expect(payload, 'the payload was not the entry point').toContain('MALICIOUS-PAYLOAD');

    expect(
      asserted.code,
      `the release accepted an artifact whose entry point and contracted digest were rewritten together: ${asserted.out}`,
    ).not.toBe(0);
    expect(asserted.out, 'the refusal does not say what changed').toContain(
      'the authority changed across the pack boundary',
    );
  });

  const AUTHORITY = [
    [
      'the release contract',
      (rig: Rig) => contractFile(rig),
      'a contract rewritten after the capture is what every byte comparison is then made against',
    ],
    [
      'the verifier',
      (rig: Rig) => path.join(rig.repo, 'scripts', 'verify-tarball-contents.mjs'),
      'a verifier rewritten after the capture writes its own verdict',
    ],
    [
      'the stager',
      (rig: Rig) => path.join(rig.repo, 'scripts', 'stage-release-package.mjs'),
      'a stager rewritten after the capture decides what is packed at all',
    ],
  ] as const;

  it.each(AUTHORITY)(
    'changing %s after the pin is refused against the prior digest',
    (what, locate, why) => {
      const rig = releaseRig();
      runThroughPack(rig);

      // THE CONTROL, FIRST: on an untouched run the assertion passes, so the refusal below is about
      // the mutation and not about a check that refuses everything.
      const clean = runReleaseStep(rig, ASSERT_STEP);

      const target = locate(rig);
      const before = fs.readFileSync(target);
      fs.writeFileSync(target, Buffer.concat([before, Buffer.from('\n')]));
      const changed = digestOf(fs.readFileSync(target)) !== digestOf(before);
      const mutated = runReleaseStep(rig, ASSERT_STEP);
      wipe(rig.root);

      expect(clean.code, `the assertion refused an untouched release: ${clean.out}`).toBe(0);
      expect(changed, `${what} was not actually changed — the case proves nothing`).toBe(true);
      expect(mutated.code, `${why}: ${mutated.out}`).not.toBe(0);
      expect(mutated.out, 'the refusal does not name the byte set that changed').toContain(
        'is not the byte set this release pinned before the pack',
      );
    },
  );
});

describePosix('the release-contract canary is evidence about THIS release', () => {
  it('it refuses to bless a contract that was rewritten after the pin', async () => {
    const rig = releaseRig();
    expect(runReleaseStep(rig, CAPTURE_STEP).code, 'the capture failed').toBe(0);
    expect(runReleaseStep(rig, PIN_STEP).code, 'the pin failed').toBe(0);
    rewriteEntryPointAndContract(rig);
    expect(runReleaseStep(rig, STAGE_STEP).code, 'the doctored tree did not stage').toBe(0);
    expect(runReleaseStep(rig, PACK_STEP).code, 'the doctored tree did not pack').toBe(0);

    const canary = runReleaseStep(rig, CANARY_STEP);

    // WHY THE OLD CANARY SAID "OK". It perturbed whatever contracted path sorted first. Against the
    // DOCTORED contract that perturbation is still refused — truthfully, and about a file nobody was
    // asking about — while the gate accepts the payload the same contract was rewritten to fit.
    const doctored = JSON.parse(fs.readFileSync(contractFile(rig), 'utf8')) as {
      files: Record<string, string>;
    };
    const first = Object.keys(doctored.files).sort()[0] as string;
    const legacy = path.join(rig.root, 'legacy-canary.json');
    doctored.files[first] = '0'.repeat(64);
    fs.writeFileSync(legacy, JSON.stringify(doctored));
    const legacyResult = verify(packedTarball(rig), legacy);
    const shipped = await packagedFiles(packedTarball(rig));
    const entry = (shipped.get('dist/index.js') as Buffer).toString();
    wipe(rig.root);

    expect(entry, 'the archive does not carry the payload, so nothing is being blessed').toContain(
      'MALICIOUS-PAYLOAD',
    );
    expect(first, 'the legacy canary perturbed the entry point after all').not.toBe(
      'dist/index.js',
    );
    expect(
      legacyResult.code,
      'the legacy perturbation was accepted, so it was never the reason this stayed green',
    ).not.toBe(0);

    expect(
      canary.code,
      `the canary reported a load-bearing comparison over a contract that had been rewritten: ${canary.out}`,
    ).not.toBe(0);
    expect(
      canary.out,
      'the canary does not say whose authority it was asked to vouch for',
    ).toContain('evidence about a rewritten authority');
  });

  it('on a faithful release it passes, and it perturbs the entry point to do it', () => {
    const rig = releaseRig();
    runThroughPack(rig);
    const asserted = runReleaseStep(rig, ASSERT_STEP);
    const verified = runReleaseStep(rig, VERIFY_STEP);
    const canary = runReleaseStep(rig, CANARY_STEP);
    wipe(rig.root);

    expect(
      asserted.code,
      `a faithful release failed the authority assertion: ${asserted.out}`,
    ).toBe(0);
    expect(verified.code, `a faithful release failed the contents gate: ${verified.out}`).toBe(0);
    expect(canary.code, `a faithful release failed its own canary: ${canary.out}`).toBe(0);
    expect(canary.out, 'the canary never perturbed the entry point').toContain(
      'canary OK for dist/index.js',
    );
  });
});

describePosix('the staged tree is exactly what the package publishes, and it is what ships', () => {
  it('the faithful package stages, packs and verifies, with no debris and no lifecycle', async () => {
    const rig = releaseRig();
    runThroughPack(rig);
    const verified = runReleaseStep(rig, VERIFY_STEP);

    const contract = JSON.parse(fs.readFileSync(contractFile(rig), 'utf8')) as {
      files: Record<string, string>;
      manifest: Record<string, unknown>;
    };
    const shipped = await packagedFiles(packedTarball(rig));
    const wanted = [...Object.keys(contract.files), 'package.json'].sort();
    const got = [...shipped.keys()].sort();
    const mismatched = Object.entries(contract.files).filter(
      ([entry, digest]) => digestOf(shipped.get(entry) ?? Buffer.alloc(0)) !== digest,
    );
    const packedManifest = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(shipped.get('package.json') as Buffer),
    ) as Record<string, unknown>;
    wipe(rig.root);

    expect(verified.code, `the staged archive was refused: ${verified.out}`).toBe(0);
    // EXACTLY the contracted set: the `dist` tree, the `prompts` tree, README.md, LICENSE and the
    // manifest. Not a minimum, and nothing that was merely lying around next to them.
    expect(got, 'the archive is not exactly the contracted set plus the manifest').toEqual(wanted);
    expect(got, 'the archive does not ship the README').toContain('README.md');
    expect(got, 'the archive does not ship the LICENSE').toContain('LICENSE');
    expect(got.filter((e) => e.startsWith('dist/')).length, 'no dist tree shipped').toBeGreaterThan(
      0,
    );
    expect(
      got.filter((e) => e.startsWith('prompts/')).length,
      'no prompts tree shipped',
    ).toBeGreaterThan(3);
    expect(
      mismatched.map(([e]) => e),
      'the archive diverges from the contracted bytes',
    ).toEqual([]);
    expect(packedManifest.name, 'the packed manifest is not this package').toBe(
      contract.manifest.name,
    );
    expect(packedManifest.version, 'the packed manifest is not this version').toBe(
      contract.manifest.version,
    );
  });

  it('a file that appears in dist after the capture is refused as debris, not packed', () => {
    const rig = releaseRig();
    expect(runReleaseStep(rig, CAPTURE_STEP).code, 'the capture failed').toBe(0);
    expect(runReleaseStep(rig, PIN_STEP).code, 'the pin failed').toBe(0);
    writeFile(path.join(rig.repo, 'packages', 'cli'), 'dist/dropped.js', 'export const x = 1;\n');
    const staged = runReleaseStep(rig, STAGE_STEP);
    const packedAnyway = fs.existsSync(
      path.join(rig.runnerTemp, 'release-stage', 'dist/dropped.js'),
    );
    wipe(rig.root);

    expect(
      staged.code,
      `a file the contract never held was staged for packing: ${staged.out}`,
    ).not.toBe(0);
    expect(staged.out, 'the debris was not named').toContain("holds 'dist/dropped.js'");
    expect(staged.out, 'the debris was not called what it is').toContain(
      'stage debris is not published',
    );
    expect(packedAnyway, 'the stage was left holding the debris').toBe(true);
  });

  it('a stage directory that already exists is refused rather than reused', () => {
    const rig = releaseRig();
    expect(runReleaseStep(rig, CAPTURE_STEP).code, 'the capture failed').toBe(0);
    fs.mkdirSync(path.join(rig.runnerTemp, 'release-stage'), { recursive: true });
    fs.writeFileSync(path.join(rig.runnerTemp, 'release-stage', 'left-over.js'), 'x\n');
    const staged = runReleaseStep(rig, STAGE_STEP);
    wipe(rig.root);

    expect(
      staged.code,
      `the release swept an existing directory into the stage: ${staged.out}`,
    ).not.toBe(0);
    expect(staged.out, 'the reuse was not named').toContain('created fresh, never reused');
  });

  it('a manifest RE-SERIALISED after the capture still stages — facts, not bytes', () => {
    // npm may re-serialise a manifest, and so may a formatter. The stage is settled on what the
    // manifest SAYS, exactly as the archive is; a byte comparison here would fail every release
    // whose manifest was reformatted, which is not a property a correct release has.
    const rig = releaseRig();
    expect(runReleaseStep(rig, CAPTURE_STEP).code, 'the capture failed').toBe(0);
    const at = path.join(rig.repo, 'packages', 'cli', 'package.json');
    const before = fs.readFileSync(at);
    const manifest = JSON.parse(before.toString('utf8')) as Record<string, unknown>;
    fs.writeFileSync(at, JSON.stringify(Object.fromEntries(Object.entries(manifest).reverse())));
    const reserialised = digestOf(fs.readFileSync(at)) !== digestOf(before);
    const staged = runReleaseStep(rig, STAGE_STEP);
    wipe(rig.root);

    expect(reserialised, 'the manifest was not actually re-serialised').toBe(true);
    expect(staged.code, `a re-serialised manifest was refused by the stage: ${staged.out}`).toBe(0);
  });

  it('a manifest whose FACTS changed after the capture is refused by the stage', () => {
    // The control for the case above: re-serialisation passes, a changed claim does not.
    const rig = releaseRig();
    expect(runReleaseStep(rig, CAPTURE_STEP).code, 'the capture failed').toBe(0);
    editRepoManifest(rig.repo, (m) => {
      m.scripts = { ...(m.scripts as Record<string, string>), postinstall: 'node ./dist/index.js' };
    });
    const staged = runReleaseStep(rig, STAGE_STEP);
    wipe(rig.root);

    expect(
      staged.code,
      `an added install-time hook was staged for packing: ${staged.out}`,
    ).not.toBe(0);
    expect(staged.out, 'the changed manifest field was not named').toContain(
      "the staged 'package.json' declares 'scripts' as",
    );
  });
});

// ===============================================================================================
// ONE ARCHIVE LEAVES THIS RELEASE, AND EVERY PUBLICATION PATH NAMES IT.
//
// The contents gate settles the archive it is pointed at. It says nothing about what ELSE is in the
// directory that archive sits in — and the release published out of that directory BY GLOB:
// `ls sthayi-*.tgz` chose what to scan, `release-pack/sthayi-*.tgz` chose what to upload, and
// `sthayi-*.tgz SHA256SUMS` chose what to attach to the draft release. A second archive dropped in
// beside the real one therefore rode out with it: gated by nothing, covered by no digest, and
// served from the project's own release page. `mkdir -p` is what made the drop survivable, because
// it accepts a directory that is already there and says nothing about what was in it.
//
// Docker and npm publish were never exposed: both pin the exact version. The artifact and the
// draft release were, so both are named exactly here, and the directory itself is enumerated before
// anything optional runs.
// ===============================================================================================

const CHECKSUM_STEP = "Checksums (and export the digest as this job's immutable output)";
const SCAN_STEP = 'Scan tarball with VirusTotal (optional — runs only if the secret is set)';
const DRAFT_STEP = 'Create draft release with artifacts';

/** One job's lines, by name. `buildJobLines` is this for `build`. */
function jobLines(job: string, text: string = workflowText()): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^ {2}${job}:\\s*$`).test(l));
  if (start === -1) return [];
  const end = lines.findIndex((l, i) => i > start && /^ {2}[a-z][a-z-]*:\s*$/.test(l));
  return lines.slice(start, end === -1 ? undefined : end);
}

/** The `upload-artifact` step of the build job — it carries a `uses:`, not a `- name:`. */
function uploadArtifactBlock(): string[] {
  const lines = buildJobLines();
  const at = lines.findIndex((l) => /^\s*-\s+uses:\s*actions\/upload-artifact@/.test(l));
  if (at === -1) return [];
  const indent = (lines[at] as string).search(/\S/);
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (line.trim() === '') continue;
    if (line.search(/\S/) <= indent) {
      end = i;
      break;
    }
  }
  return lines.slice(at, end);
}

describe('every path that publishes the tarball names it, and none of them globs', () => {
  it('no executable line in the workflow selects a tarball by wildcard', () => {
    // The one assertion that covers paths nobody thought to enumerate. A comment may still discuss
    // the glob it replaced; a line the runner executes may not contain one.
    const text = executable(workflowText().split('\n')).join('\n');
    expect(text, 'a wildcard still decides what this release publishes').not.toMatch(/sthayi-\*/);
  });

  it('creates the release output directory fresh, refusing one that already exists', () => {
    const body = runBody(stepBlock(buildJobLines(), PACK_STEP));
    expect(body, `the build job has no runnable \`${PACK_STEP}\` step`).not.toBe('');
    expect(body, 'the release output directory is still created with `mkdir -p`').not.toMatch(
      /mkdir\s+-p\s+"\$RUNNER_TEMP\/release-pack"/,
    );
    expect(body, 'the release output directory is not created fresh').toMatch(
      /mkdir\s+"\$RUNNER_TEMP\/release-pack"/,
    );
    expect(body, 'reuse is not refused').toContain('created fresh, never reused');
  });

  it('enumerates the pack directory after the checksum and BEFORE anything optional runs', () => {
    const lines = buildJobLines();
    const sums = stepAt(lines, CHECKSUM_STEP);
    const scan = stepAt(lines, SCAN_STEP);
    expect(sums, `the build job has no \`${CHECKSUM_STEP}\` step`).toBeGreaterThan(-1);
    expect(scan, `the build job has no \`${SCAN_STEP}\` step`).toBeGreaterThan(-1);
    expect(sums, 'the optional scan runs before the directory is settled').toBeLessThan(scan);

    const body = runBody(stepBlock(lines, CHECKSUM_STEP));
    expect(body, 'the checksums step never enumerates the output directory').toContain(
      'LC_ALL=C ls -A',
    );
    expect(
      body,
      'the enumeration is not compared against exactly the archive and its manifest',
    ).toContain('"SHA256SUMS $TARBALL_NAME "');
  });

  it('the optional scan names the pinned archive and writes its response elsewhere', () => {
    const block = stepBlock(buildJobLines(), SCAN_STEP);
    expect(block.length, `the build job has no \`${SCAN_STEP}\` step`).toBeGreaterThan(0);
    const body = runBody(block);
    expect(body, 'the scan still searches the directory for something to send').not.toMatch(
      /\bls\s+sthayi/,
    );
    expect(
      stepEnv(block).TARBALL_NAME,
      'the scan does not take its target from the checksums step',
    ).toBe('${{ steps.checksums.outputs.tarball-name }}');
    expect(body, 'the scan does not send the pinned archive').toContain(
      '"file=@$RUNNER_TEMP/release-pack/$TARBALL_NAME"',
    );
    // An optional, `continue-on-error` step may not add a file to the directory the release
    // publishes out of — the enumeration above has already run by then.
    expect(body, "the scan writes its response into the release's output directory").not.toMatch(
      /tee\s+"?vt-analysis\.json/,
    );
  });

  it('the uploaded artifact is two exact paths, not a glob over the pack directory', () => {
    const block = uploadArtifactBlock();
    expect(block.length, 'the build job uploads no artifact').toBeGreaterThan(0);
    const text = executable(block).join('\n');
    expect(text, 'the artifact is still assembled by wildcard').not.toMatch(/sthayi-\*/);
    expect(text, 'the artifact does not carry the archive the checksums step pinned').toContain(
      '${{ runner.temp }}/release-pack/${{ steps.checksums.outputs.tarball-name }}',
    );
    expect(text, 'the artifact does not carry the checksum manifest').toContain(
      '${{ runner.temp }}/release-pack/SHA256SUMS',
    );
  });

  it('the draft release attaches the build job’s pinned name and enumerates the download', () => {
    const block = stepBlock(jobLines('draft-release'), DRAFT_STEP);
    expect(block.length, `there is no \`${DRAFT_STEP}\` step`).toBeGreaterThan(0);
    expect(
      stepEnv(block).TARBALL_NAME,
      'the draft release does not take its name from the build job output',
    ).toBe('${{ needs.build.outputs.tarball-name }}');
    const body = runBody(block);
    expect(body, 'the draft release still attaches whatever matches a wildcard').not.toMatch(
      /sthayi-\*/,
    );
    expect(body, 'the draft release does not attach the pinned archive by name').toContain(
      '"$TARBALL_NAME" SHA256SUMS',
    );
    expect(body, 'the draft release never enumerates what it downloaded').toContain(
      'LC_ALL=C ls -A',
    );
    expect(body, 'the download is not held to exactly the archive and its manifest').toContain(
      '"SHA256SUMS $TARBALL_NAME "',
    );
  });
});

/**
 * `sha256sum` for machines that ship `shasum` instead. The checksums step is written for the
 * ubuntu runner's coreutils; shimming the name here is what lets the step's OWN bytes be executed
 * rather than a second spelling of it being maintained in the workflow for the tests' benefit.
 */
function coreutilsShim(rig: Rig): Record<string, string> {
  const bin = path.join(rig.root, 'shim-bin');
  fs.mkdirSync(bin, { recursive: true });
  if (spawnSync('sha256sum', ['--version'], { encoding: 'utf8' }).status !== 0) {
    const at = path.join(bin, 'sha256sum');
    fs.writeFileSync(at, '#!/bin/sh\nexec shasum -a 256 "$@"\n');
    fs.chmodSync(at, 0o755);
  }
  return { PATH: `${bin}:${process.env.PATH ?? ''}` };
}

const packDir = (rig: Rig): string => path.join(rig.runnerTemp, 'release-pack');

describePosix('the release output directory is created fresh and holds exactly one archive', () => {
  it('refuses to pack into a release output directory that already exists', () => {
    // THE PRESEED, EXACTLY AS INDEPENDENT REVIEW FOUND IT. `release-pack` is an ordinary path under
    // `$RUNNER_TEMP`; a previous step, an untrusted action, or a reused runner can put an archive
    // there before the release packs. `mkdir -p` accepted that directory without a word, the real
    // tarball packed and verified green beside the extra, and both stayed inside the publication
    // globs. Refusing EEXIST is what makes the reuse visible.
    const rig = releaseRig();
    for (const step of [CAPTURE_STEP, PIN_STEP, STAGE_STEP]) {
      expect(
        runReleaseStep(rig, step).code,
        `the \`${step}\` step failed on a faithful mirror`,
      ).toBe(0);
    }
    const preseeded = path.join(packDir(rig), 'sthayi-backdoor.tgz');
    fs.mkdirSync(packDir(rig), { recursive: true });
    fs.writeFileSync(preseeded, 'not an archive\n');

    const packed = runReleaseStep(rig, PACK_STEP);
    const survived = fs.existsSync(preseeded);
    const realOne = fs.existsSync(packedTarball(rig));
    wipe(rig.root);

    expect(
      packed.code,
      `the release packed into a directory it did not create: ${packed.out}`,
    ).not.toBe(0);
    expect(packed.out, 'the reuse was not named').toContain('created fresh, never reused');
    expect(realOne, 'the release packed anyway, straight in beside the preseeded archive').toBe(
      false,
    );
    // It REFUSES; it does not quietly delete somebody else's file and carry on.
    expect(survived, 'the step deleted the preseeded file instead of stopping').toBe(true);
  });

  it('refuses to checksum a pack directory that gained a second archive', () => {
    // The other half of the same reuse: the directory WAS created fresh and the right archive is in
    // it, and then one more appears. Naming the versioned tarball downstream stops the extra being
    // COLLECTED; only enumerating the directory stops it being there at all.
    const rig = releaseRig();
    runThroughPack(rig);
    fs.writeFileSync(path.join(packDir(rig), 'sthayi-backdoor.tgz'), 'not an archive\n');
    const sums = runReleaseStep(rig, CHECKSUM_STEP, { env: coreutilsShim(rig) });
    wipe(rig.root);

    expect(
      sums.code,
      `a second archive in the release's own output directory was accepted: ${sums.out}`,
    ).not.toBe(0);
    expect(sums.out, 'the extra archive was not named').toContain('sthayi-backdoor.tgz');
    expect(sums.out, 'the refusal does not say what the directory must hold').toContain(
      'not exactly',
    );
  });

  it('refuses any other leftover in the pack directory, not just another .tgz', () => {
    // The enumeration is about the DIRECTORY, not about a file extension: a `.tgz` is the shape
    // that publishes itself, but a check that only looked for one would be a deny-list again.
    const rig = releaseRig();
    runThroughPack(rig);
    fs.writeFileSync(path.join(packDir(rig), 'left-over.json'), '{}\n');
    const sums = runReleaseStep(rig, CHECKSUM_STEP, { env: coreutilsShim(rig) });
    wipe(rig.root);

    expect(sums.code, `a leftover file in the output directory was accepted: ${sums.out}`).not.toBe(
      0,
    );
    expect(sums.out, 'the leftover was not named').toContain('left-over.json');
  });

  it('on a faithful release the pack directory is exactly the archive and its manifest', () => {
    // THE CONTROL. Without it the three refusals above are consistent with a step that refuses
    // everything, which would gate nothing and break every release.
    const rig = releaseRig();
    runThroughPack(rig);
    const sums = runReleaseStep(rig, CHECKSUM_STEP, { env: coreutilsShim(rig) });
    const entries = fs.readdirSync(packDir(rig)).sort();
    const name = rig.outputs['tarball-name'];
    const digest = rig.outputs['tarball-sha256'] ?? '';
    wipe(rig.root);

    expect(sums.code, `a faithful release failed its own checksums step: ${sums.out}`).toBe(0);
    expect(entries, 'the faithful pack directory is not the archive plus its manifest').toEqual([
      'SHA256SUMS',
      `sthayi-${rig.version}.tgz`,
    ]);
    expect(name, 'the one tarball name never reached the workflow context').toBe(
      `sthayi-${rig.version}.tgz`,
    );
    expect(digest, 'the digest never reached the workflow context').toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('every block in this file that spawns a shell is gated to POSIX', () => {
  it('gates each describe that reaches for bash, and keeps the gate itself', () => {
    // A `describe` that shells out and is NOT gated turns the whole suite red on the Windows leg of
    // the CI matrix, which is a way of deleting the coverage rather than reporting it. This reads
    // the file: a new executing block that forgets the gate is caught here rather than on the runner.
    const source = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(
      source.includes("describe.skipIf(process.platform === 'win32')"),
      'the POSIX gate is gone, so the executing half either runs on win32 or does not run at all',
    ).toBe(true);

    const lines = source.split('\n');
    const heads = lines
      .map((line, at) => ({ line, at }))
      .filter(({ line }) => /^describe(?:Posix)?\(/.test(line));
    expect(heads.length, 'this file declares no describe blocks at all').toBeGreaterThan(4);

    // The block runs to its own closing `});` at column 0, so top-level helpers declared BETWEEN
    // two describes are attributed to neither. The detector is written with escapes so that this
    // very assertion is not what it matches.
    const spawnsShell = /\brunReleaseStep\(rig\b|\brunThroughPack\(rig\b/;
    const ungated: string[] = [];
    for (const head of heads) {
      let end = lines.length;
      for (let i = head.at + 1; i < lines.length; i += 1) {
        if (lines[i] === '});') {
          end = i;
          break;
        }
      }
      const block = lines.slice(head.at, end).join('\n');
      if (spawnsShell.test(block) && !head.line.startsWith('describePosix(')) {
        ungated.push(head.line);
      }
    }
    expect(ungated, 'a describe block spawns a shell without the POSIX gate').toEqual([]);
  });
});
