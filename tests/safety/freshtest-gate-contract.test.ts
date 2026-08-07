import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { removeForeignTree } from '../helpers/foreign-tree.js';

/**
 * SAFETY: the Docker fresh-install gate must test the install route the README advertises, must do
 * its work when the container RUNS, and must never clean up anything it did not create.
 *
 * THE PROPERTIES OF `Dockerfile.freshtest`, `.dockerignore`, `scripts/freshtest.sh` AND THE
 * RELEASE WORKFLOW THAT NOTHING ELSE IN THE SUITE CAN SEE.
 *
 *   1. THE BUILD CONTEXT. `.dockerignore` denies everything and re-admits exactly the Dockerfile
 *      and the packed tarball. Without deny-by-default the context is the whole working tree —
 *      `seed/`, `.env`, a dev home, an unrelated agent's scratch files — all uploaded to the
 *      daemon and reachable by any later `COPY`.
 *   1b. WHAT IS HANDED TO THE DAEMON AT ALL. Deny-by-default is a filter over whatever directory
 *      the build is pointed at, and a filter is one edit away from admitting more. The gate
 *      therefore stages: it assembles a directory holding exactly the Dockerfile, the ignore file
 *      and the tarball, asserts those three and only those three, and builds from inside it. The
 *      checkout is never offered to the daemon in the first place.
 *   1c. WHO OWNS THE ARTIFACT. The tarball is packed straight into that run-owned directory with
 *      `npm pack --pack-destination`. A FIXED path — a repo-root `freshtest.tgz`, say — is one name
 *      shared by every run on the machine and may pre-date all of them: concurrent runs overwrite
 *      each other's artifact and can build the wrong one, and an unconditional cleanup of that
 *      path destroys a file this run never created.
 *   1d. AND THE STATE THAT PRODUCES THE ARTIFACT IS SHARED TOO. A unique DESTINATION isolates the
 *      tarball, not the work: tsup runs `clean: true` over the shared `packages/cli/dist`, and
 *      `npm pack` runs prepack/postpack, which copy the repo-root `README.md`/`LICENSE` into the
 *      shared `packages/cli` and then delete them. Two overlapping runs pack a half-written
 *      `dist`, or pack after the other run's postpack removed the docs. The whole build+pack
 *      section is therefore serialised under a stale-safe `mkdir` lock, and the lock is proved
 *      here AND exercised by two genuinely overlapping runs below.
 *   2. THE INSTALL ROUTE. The README headline is
 *      `npm install -g --prefix "$HOME/.local" sthayi`, run as an ordinary user. A root
 *      `npm install -g` into the image's system prefix proves a route no reader is told to take
 *      and hides every permission, PATH and shim consequence of the route they are.
 *   3. WHERE THE MATRIX EXECUTES. Build-time `RUN` steps bake their result into a layer: the
 *      built image then does nothing, a cached layer can satisfy a later build, and `docker run`
 *      cannot fail. The matrix is the test, so it has to be the container's entrypoint.
 *   4. THE CLEANUP BLAST RADIUS. This gate runs on a developer's own machine. A fixed image tag is
 *      shared with every other run there, and `docker system prune` / `docker image prune` /
 *      a wildcard `rmi` / a dangling-image sweep all delete images this gate never created.
 *   4c. AND REMOVAL IS BOUND TO CREATION, NOT TO A NAME. A cleanup that removes whatever the tag
 *      variable spells deletes a PRE-EXISTING image wearing that name whenever the run failed
 *      before it ever built one — so the tag is unnamed until this run has a validated allocation
 *      to derive unguessable entropy from, and the removal is gated on a flag set only by a
 *      `docker build` that returned 0. Both halves are exercised against a fake `docker` below.
 *   4b. WHAT THE TRAP IS ALLOWED TO NAME. The EXIT trap removes whatever `$ctx` holds, and it is
 *      armed before anything is created — so `$ctx` stays empty until a validation guard has
 *      accepted the `mktemp -d` path. Refusing an odd path leaks a directory; promoting one
 *      deletes a directory. No removal in the script may name a fixed path.
 *   5. THE RELEASE GATE BUILDS THE SAME THREE FILES, AGAINST A DIGEST THAT DOES NOT MOVE. The
 *      workflow's promise is that the EXACT artifact `SHA256SUMS` covers is what gets installed.
 *      Verifying the manifest is a statement about the bytes at one instant, and staging puts a
 *      `cp` after that instant — so the ONE expected digest is parsed and strictly validated out
 *      of `SHA256SUMS`, and BOTH the source tarball (immediately before staging) and the staged
 *      copy are compared against that fixed value. Deriving the expectation by hashing the source
 *      again compares the artifact to ITSELF: a replacement landing between the verification and
 *      the copy is copied, hashed, agreed with, and built. That is reproduced below.
 *
 * WHY IT IS A GATE IN THE ORDINARY SUITE. The real gate only runs where Docker runs — a release
 * tag, or a developer who has Docker up. `pnpm test` runs on every change, which is where a claim
 * about the release path has to be checked.
 *
 * MOST OF THIS FILE IS FILE READS AND STRING ASSERTIONS, AND THEY FAIL CLOSED — a shape this file
 * cannot resolve is a failure, not a pass. The last three suites are different in kind: text alone
 * cannot show that a cleanup is bound to CREATION rather than to a name, that a replacement made
 * after a checksum was verified is refused, or that two overlapping runs do not corrupt each
 * other. Those run the real `scripts/freshtest.sh` and the real workflow step against fake
 * `docker`/`pnpm`/`npm` commands on PATH, inside a throwaway mini-checkout. NO DOCKER DAEMON IS
 * EVER CONTACTED and the repository under test is never written to.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readRepoFile = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const dockerignoreText = (): string => readRepoFile('.dockerignore');
const dockerfileText = (): string => readRepoFile('Dockerfile.freshtest');
const scriptText = (): string => readRepoFile('scripts/freshtest.sh');

/**
 * The FRESH-INSTALL SMOKE SUBSET the container must prove on a clean install.
 *
 * NAMED FOR WHAT IT IS. These six are not "the keyless matrix": the matrix is every registered CLI
 * command except `consolidate --oracle` and `qualify`, and eleven of them are not here. Calling six
 * commands the matrix would advertise a fresh-machine guarantee the other eleven never received.
 * The container's job is the MACHINE (no toolchain, no repo, no cache); command coverage is gated
 * by tests/safety/keyless-matrix.test.ts (built CLI) and by
 * tests/safety/packaged-keyless-matrix.test.ts (the installed tarball, in the release workflow).
 */
const SMOKE_SUBSET = ['--version', '--help', 'init --yes', 'doctor', 'status', 'journal'] as const;

type Instruction = { keyword: string; args: string; at: number };

/**
 * Dockerfile instructions with comments dropped and `\` continuations joined. `text` defaults to
 * the file on disk; passing a MUTATED copy is how the analysis below is shown to catch what it
 * claims to catch, rather than being trusted to.
 */
function instructions(text: string = dockerfileText()): Instruction[] {
  const out: Instruction[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? '';
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;
    let joined = raw;
    const at = i + 1;
    while (joined.trimEnd().endsWith('\\') && i + 1 < lines.length) {
      joined = `${joined.trimEnd().slice(0, -1)} ${lines[i + 1] ?? ''}`;
      i += 1;
    }
    const m = joined.trim().match(/^([A-Za-z]+)\s+([\s\S]*)$/);
    if (!m) continue;
    out.push({ keyword: (m[1] ?? '').toUpperCase(), args: (m[2] ?? '').trim(), at });
  }
  return out;
}

const ofKeyword = (keyword: string, text?: string): Instruction[] =>
  instructions(text).filter((ins) => ins.keyword === keyword);

/** Executable shell lines only — a comment naming a hazard is not the hazard. */
function shellLines(text: string = scriptText()): { line: string; at: number }[] {
  return text
    .split('\n')
    .map((line, i) => ({ line: line.trim(), at: i + 1 }))
    .filter(({ line }) => line !== '' && !line.startsWith('#'));
}

/** Everything the container executes at `docker run` time: the ENTRYPOINT and CMD arguments. */
function runtimeCommand(text?: string): string {
  return [...ofKeyword('ENTRYPOINT', text), ...ofKeyword('CMD', text)]
    .map((ins) => ins.args)
    .join('\n');
}

const isNpmInstall = (ins: Instruction): boolean =>
  ins.keyword === 'RUN' && /\bnpm\s+(?:install|i|add|ci)\b/.test(ins.args);

/** The one shell line that invokes `docker build`, whatever it is wrapped in. */
const dockerBuildLine = (text?: string): { line: string; at: number } | undefined =>
  shellLines(text).find((l) => /\bdocker\s+build\b/.test(l.line));

/**
 * The context operand of a `docker build` — the last word after the subcommand, ignoring the shell
 * punctuation a subshell wrapper leaves behind. This is the single argument that decides what the
 * daemon receives, so it is read positionally rather than searched for.
 */
function buildContextOperand(line: string): string {
  const after = line.slice(line.search(/\bdocker\s+build\b/));
  const words = after
    .split(/\s+/)
    .map((w) => w.replace(/[)&|;]+$/, ''))
    .filter((w) => w !== '');
  return words[words.length - 1] ?? '';
}

/**
 * Shell removals: `rm`, `rmdir`, `unlink` as words. `docker image rm` is a different verb on a
 * different noun and is covered by its own assertions, so lines that drive docker are excluded
 * here rather than being force-fitted into the filesystem rule.
 */
const removalLines = (text?: string): { line: string; at: number }[] =>
  shellLines(text).filter(
    ({ line }) => /(?<![\w-])(?:rm|rmdir|unlink)(?![\w-])/.test(line) && !/\bdocker\b/.test(line),
  );

/**
 * The body of a shell function, from its `name() {` header to the first line that is a bare `}`.
 * Empty when the function is not there, so a rename fails the assertion instead of vacating it.
 */
function shellFunction(name: string, text: string = scriptText()): string {
  const start = text.indexOf(`${name}() {`);
  if (start === -1) return '';
  const end = text.indexOf('\n}\n', start);
  if (end === -1) return '';
  return text.slice(start, end + 2);
}

const cleanupBody = (text?: string): string => shellFunction('cleanup', text);

const workflowText = (): string => readRepoFile('.github/workflows/release.yml');

/** A named job, sliced out of the workflow by indentation. Empty when it is not there. */
function jobBlock(name: string, text: string = workflowText()): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start === -1) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}\S/.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

/** The `freshtest-docker` job, sliced out of the workflow by indentation. */
function freshtestJob(text: string = workflowText()): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^ {2}freshtest-docker:\s*$/.test(l));
  if (start === -1) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}\S/.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

describe('.dockerignore denies the build context by default', () => {
  it('is exactly the deny-all line plus the two files the gate needs', () => {
    const lines = dockerignoreText().split('\n');
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    // Exact, not "contains": every extra line is another path handed to the daemon, and an
    // allow-list that has grown a fourth entry is exactly how a working tree leaks into an image.
    expect(lines).toEqual(['**', '!Dockerfile.freshtest', '!freshtest.tgz']);
  });

  it('re-admits the very files the gate builds with', () => {
    const build = shellLines().find((l) => /\bdocker\s+build\b/.test(l.line));
    expect(build, 'scripts/freshtest.sh no longer runs `docker build`').toBeDefined();
    const dockerfile = build?.line.match(/-f\s+(\S+)/)?.[1];
    const tarball = build?.line.match(/--build-arg\s+TGZ=(\S+)/)?.[1];
    // Deny-by-default turns a rename into a silent context miss, so the names must stay in step.
    expect(dockerignoreText()).toContain(`!${dockerfile}`);
    expect(dockerignoreText()).toContain(`!${tarball}`);
  });
});

describe('Dockerfile.freshtest proves the advertised non-root install', () => {
  it('installs into the user prefix the README advertises, never a system-wide global', () => {
    const installs = instructions().filter(isNpmInstall);
    expect(installs.length, 'no npm install step left in Dockerfile.freshtest').toBeGreaterThan(0);
    for (const ins of installs) {
      // `npm install -g <tgz>` with no prefix is the root system install nobody is told to run.
      expect(ins.args, `Dockerfile.freshtest:${ins.at}`).toMatch(/--prefix\s+"\$HOME\/\.local"/);
    }
  });

  it('installs as a non-root user and never switches back to root', () => {
    const all = instructions();
    const firstUser = all.findIndex((ins) => ins.keyword === 'USER');
    expect(firstUser, 'no USER instruction — the image installs and runs as root').toBeGreaterThan(
      -1,
    );
    for (const ins of all) {
      if (ins.keyword !== 'USER') continue;
      const root = /^(?:root|0)(?::|\s|$)/.test(ins.args);
      expect(root, `Dockerfile.freshtest:${ins.at} switches the image back to root`).toBe(false);
    }
    const firstInstall = all.findIndex(isNpmInstall);
    expect(firstInstall, 'the install runs before the USER switch, i.e. as root').toBeGreaterThan(
      firstUser,
    );
  });

  it('invokes the CLI through the shim the --prefix install wrote, not through PATH', () => {
    // The headline route adds nothing to PATH; resolving `sthayi` any other way inside the image
    // would test an installation the README never produces.
    expect(runtimeCommand()).toContain('$HOME/.local/bin/sthayi');
  });
});

describe('the fresh-install smoke subset executes when the container RUNS', () => {
  it('runs the whole subset from the container entrypoint', () => {
    const run = runtimeCommand();
    expect(run, 'Dockerfile.freshtest declares no ENTRYPOINT or CMD').not.toBe('');
    for (const cmd of SMOKE_SUBSET) {
      expect(run, `'${cmd}' is not executed at container start`).toContain(cmd);
    }
  });

  it('never bakes the subset into a build layer', () => {
    for (const ins of ofKeyword('RUN')) {
      for (const cmd of SMOKE_SUBSET) {
        const baked = ins.args.includes(cmd);
        const why = `Dockerfile.freshtest:${ins.at} runs '${cmd}' at BUILD time — the built image
          then cannot fail, and a cached layer can satisfy the next build`;
        expect(baked, why).toBe(false);
      }
    }
  });

  it('does not call six commands the keyless matrix', () => {
    // HONESTY, NOT COSMETICS. The container proves six commands. The spec's keyless matrix is the
    // whole command surface bar two, so a success line reading "keyless matrix OK" tells a reader
    // that a fresh machine ran eleven commands it never ran. The claim has to match the coverage,
    // and the fuller claim has to exist somewhere — hence the second layer.
    const run = runtimeCommand();
    expect(run, 'the container still announces itself as the keyless matrix').not.toMatch(
      /keyless matrix/i,
    );
    expect(run, 'the container start-up no longer says what it proved').toMatch(
      /fresh-install smoke subset/i,
    );
    expect(
      scriptText(),
      'scripts/freshtest.sh still reports the container run as a keyless matrix',
    ).not.toMatch(/PASSED \([^)]*keyless[^)]*matrix/i);
    // And the honest name is only honest while the fuller layer it defers to actually exists.
    expect(
      fs.existsSync(path.join(repoRoot, 'tests', 'safety', 'packaged-keyless-matrix.test.ts')),
      'the subset defers to a packaged full-matrix gate that is not in the tree',
    ).toBe(true);
  });
});

describe('scripts/freshtest.sh owns its image and nothing else', () => {
  it('tags the image per run, never with a tag other runs share', () => {
    const lines = shellLines();
    const build = lines.find((l) => /\bdocker\s+build\b/.test(l.line));
    expect(build, 'scripts/freshtest.sh no longer runs `docker build`').toBeDefined();
    expect(build?.line.match(/\s-t\s+(\S+)/)?.[1]).toBe('"$image_tag"');

    const assigns = lines.filter((l) => /^image_tag=/.test(l.line));
    expect(
      assigns.map(({ line }) => line),
      'image_tag is not initialised-empty once and then named once',
    ).toHaveLength(2);
    const [init, named] = assigns as [{ line: string; at: number }, { line: string; at: number }];

    // Same rule the staging directory obeys: the EXIT trap reads this variable and is armed before
    // any tag can exist, so the value it can see until then must be one that removes nothing.
    expect(init.line, 'image_tag is not initialised empty').toBe('image_tag=""');
    const trap = lines.find((l) => /\btrap\b[^\n]*\bEXIT\b/.test(l.line));
    expect(trap, 'no EXIT trap').toBeDefined();
    expect(init.at, 'image_tag is initialised only after the EXIT trap is armed').toBeLessThan(
      (trap as { at: number }).at,
    );

    // PER-RUN ENTROPY, TAKEN FROM THE ALLOCATION THIS RUN ALREADY VALIDATED. The PID separates
    // concurrent runs; the `mktemp -d` suffix is unguessable before the fact and cannot be held by
    // any other run, because that run would have to hold the same directory. A wall-clock
    // component is neither — two runs can start inside the same second and PIDs are recycled — so
    // a tag built from it can already have an image behind it.
    expect(named.line, 'image_tag carries no per-process component').toMatch(/\$\$/);
    expect(named.line, 'image_tag is not derived from the validated run allocation').toContain(
      '$run_suffix',
    );

    const promote = lines.findIndex(({ line }) => /^ctx="\$candidate"$/.test(line));
    expect(promote, 'the mktemp path is never promoted into $ctx').toBeGreaterThan(-1);
    const suffix = lines.findIndex(({ line }) => /^run_suffix=/.test(line));
    expect(suffix, 'no run identifier is cut from the validated staging directory').toBeGreaterThan(
      promote,
    );
    expect(lines[suffix]?.line, 'run_suffix is not cut from $ctx').toBe('run_suffix="${ctx##*.}"');
    const namedIdx = lines.findIndex((l) => l === named);
    // The suffix is a mktemp allocation, not an arbitrary string: a guard stands between cutting it
    // and spelling a tag with it, and it aborts rather than warns.
    const shapeGuard = lines
      .slice(suffix + 1, namedIdx)
      .map(({ line }) => line)
      .join('\n');
    expect(shapeGuard, 'nothing validates the run identifier before it becomes a tag').toMatch(
      /\bexit\s+[1-9]/,
    );
    expect(shapeGuard, 'the run identifier is not checked for the mktemp suffix shape').toMatch(
      /(\[A-Za-z0-9\]){8}/,
    );

    const run = lines.find((l) => /\bdocker\s+run\b/.test(l.line));
    expect(run?.line, '`docker run` does not run the image this run built').toContain(
      '"$image_tag"',
    );
  });

  it('removes exactly that one tag on exit', () => {
    const lines = shellLines();
    expect(
      lines.some((l) => /\btrap\b[^\n]*\bEXIT\b/.test(l.line)),
      'no EXIT trap — a failed run leaves its image behind',
    ).toBe(true);
    const removals = lines.filter((l) => /\bdocker\s+(?:image\s+rm|rmi)\b/.test(l.line));
    expect(removals.length, "nothing removes this run's image").toBeGreaterThan(0);
    for (const r of removals) {
      const why = `scripts/freshtest.sh:${r.at} removes something other than "$image_tag"`;
      expect(r.line, why).toMatch(/\bdocker\s+image\s+rm\s+"\$image_tag"/);
    }
  });

  it('removes the tag only because THIS run created the image behind it', () => {
    const lines = shellLines();
    // A cleanup bound to the NAME removes whatever is wearing it, including an image that was
    // already there when a run failed before ever building one. The flag is therefore the permit,
    // and it is issued by `docker build` returning 0 — not by the tag being spelled.
    const flags = lines.filter(({ line }) => /^image_created=/.test(line));
    expect(
      flags.map(({ line }) => line),
      'image_created is not initialised-clear once and then set once',
    ).toEqual(['image_created=0', 'image_created=1']);

    const build = lines.findIndex(({ line }) => /\bdocker\s+build\b/.test(line));
    expect(build, 'scripts/freshtest.sh no longer runs `docker build`').toBeGreaterThan(-1);
    const claim = lines.findIndex(({ line }) => line === 'image_created=1');
    expect(
      claim,
      'ownership of the tag is claimed before the build that would create it',
    ).toBeGreaterThan(build);

    const body = cleanupBody();
    expect(body, 'no cleanup body found').not.toBe('');
    expect(body, 'the trap removes the tag without asking whether this run created it').toMatch(
      /if\s+\[\s+"\$image_created"\s+-eq\s+1\s+\]\s+&&\s+\[\s+-n\s+"\$image_tag"\s+\]\s*;\s*then/,
    );

    // And nothing may ADOPT a name something else already answers to: a pre-existing tag is a
    // refusal, never a build that would make this run believe it owns the image.
    const inspect = lines.findIndex(({ line }) =>
      /\bdocker\s+image\s+inspect\s+"\$image_tag"/.test(line),
    );
    expect(inspect, 'nothing checks the tag is free before the build claims it').toBeGreaterThan(
      -1,
    );
    expect(inspect, 'the tag is checked for pre-existence only after the build').toBeLessThan(
      build,
    );
    const branch = lines
      .slice(inspect, build)
      .map(({ line }) => line)
      .join('\n');
    expect(branch, 'a tag that already exists only warns instead of aborting').toMatch(
      /\bexit\s+[1-9]/,
    );
  });

  it('packs the tarball into the run-owned directory, not wherever npm defaults to', () => {
    const pack = shellLines().find((l) => /\bnpm\s+pack\b/.test(l.line));
    expect(pack, 'scripts/freshtest.sh no longer packs the CLI').toBeDefined();
    // Without a destination npm writes into the package directory and the artifact then has to be
    // MOVED somewhere — and the obvious somewhere is a fixed repo-root path, which is one name
    // every run on the machine shares.
    const dest = pack?.line.match(/--pack-destination\s+("[^"]*"|[^\s"]+)/)?.[1];
    expect(dest, '`npm pack` has no --pack-destination: the artifact lands outside this run').toBe(
      // The pack runs inside the locked section, which is executed by the lock tool as a separate
      // process — so the destination is handed to it through the environment rather than inherited
      // as a shell variable. It is bound to the run-owned staged context, and to nothing else.
      '"$FRESHTEST_PACK_DEST"',
    );
    expect(
      shellLines().some(({ line }) => line === 'export FRESHTEST_PACK_DEST="$build_ctx"'),
      'the pack destination handed to the locked section is not this run’s staged context',
    ).toBe(true);
  });

  it('never names a fixed shared artifact path anywhere', () => {
    for (const { line, at } of shellLines()) {
      // The repo-root `freshtest.tgz` is one name shared by every run on the machine, and it can
      // pre-date all of them: writing it lets a concurrent run build the wrong bytes, and removing
      // it destroys an artifact this invocation never created.
      // Anchored to the checkout, the home directory or an absolute path — anywhere but "$ctx".
      const fixed =
        /(?:\$\{?(?:root|PWD|OLDPWD|HOME)\}?|~|(?:^|[\s"'=])\/[^\s"']*)\/freshtest\.tgz/.test(line);
      expect(fixed, `scripts/freshtest.sh:${at} uses a fixed shared freshtest.tgz path`).toBe(
        false,
      );
    }
  });

  it('never prunes broadly', () => {
    const banned: [RegExp, string][] = [
      [/\bdocker\s+system\s+prune\b/, 'docker system prune'],
      [/\bdocker\s+(?:image|container|volume|network|builder)\s+prune\b/, 'docker <object> prune'],
      [/\bdocker\s+(?:image\s+rm|rmi)\b[^\n]*\*/, 'wildcard image removal'],
      [/\bdangling\b/, 'dangling/untagged image sweep'],
      [/\bdocker\s+images\b/, 'removal driven by a `docker images` listing'],
    ];
    for (const { line, at } of shellLines()) {
      for (const [pattern, label] of banned) {
        expect(pattern.test(line), `scripts/freshtest.sh:${at} — ${label}`).toBe(false);
      }
    }
  });
});

describe('the daemon receives a staged directory, never the checkout', () => {
  it('builds from inside the run-owned directory, with a context operand that cannot reach the repo', () => {
    const build = dockerBuildLine();
    expect(build, 'scripts/freshtest.sh no longer runs `docker build`').toBeDefined();
    const line = build?.line ?? '';

    // Pointing the build at the checkout and relying on `.dockerignore` to subtract it means the
    // whole working tree is still what is offered; one edit to the allow-list re-admits it.
    expect(line, 'the build never enters the run-owned staged context directory').toMatch(
      /\bcd\s+"\$build_ctx"\s*&&/,
    );
    expect(
      buildContextOperand(line),
      'the `docker build` context operand is not the staged directory',
    ).toBe('.');
    for (const outward of ['$root', '$PWD', '$OLDPWD', '$HOME']) {
      expect(
        line.includes(outward),
        `scripts/freshtest.sh:${build?.at} lets the build context reach the checkout via ${outward}`,
      ).toBe(false);
    }
  });

  it('stages exactly the Dockerfile, the ignore file and the tarball — and nothing else', () => {
    const lines = shellLines();
    const build = dockerBuildLine();
    expect(build, 'scripts/freshtest.sh no longer runs `docker build`').toBeDefined();

    // Nothing may rake the checkout into the context wholesale.
    for (const { line, at } of lines) {
      const bulk = /\b(?:cp\s+-[a-zA-Z]*[Rr]|rsync|tar\s+-c|ditto)\b/.test(line);
      expect(bulk, `scripts/freshtest.sh:${at} copies a tree into the build context`).toBe(false);
    }
    // Copies INTO the staged context: each one is a file the daemon will receive. The tarball is
    // not among them because `npm pack` writes it there directly.
    const staged = lines.filter(({ line }) => /^cp\s.*"\$build_ctx\//.test(line));
    expect(
      staged.map(({ line }) => line.match(/"\$build_ctx\/([^"]+)"/)?.[1]).sort(),
      'something other than the Dockerfile and the ignore file is copied into the build context',
    ).toEqual(['.dockerignore', 'Dockerfile.freshtest']);

    // THE CONTEXT IS A SUBDIRECTORY OF THE RUN'S STAGING DIRECTORY, not the staging directory
    // itself. This run's own scratch — the marker proving it entered the locked section — has to
    // live somewhere, and anything sitting beside the three gate files would be uploaded to the
    // daemon as a fourth context entry.
    expect(
      lines.some(({ line }) => line === 'build_ctx="$ctx/context"'),
      'the build context is not a subdirectory of the run-owned staging directory',
    ).toBe(true);
    expect(
      lines.some(({ line }) => /^entered_marker="\$ctx\/[^"]+"$/.test(line)),
      "the run's own scratch marker is not kept outside the build context",
    ).toBe(true);

    // ...and the script refuses to build unless the directory holds those three and only those.
    const listing = lines.find(({ line }) => /^context_entries=/.test(line));
    expect(listing?.line, 'nothing enumerates the staged context before the build').toMatch(
      /cd\s+"\$build_ctx"/,
    );
    const guard = lines.find(({ line }) => /^if\s+\[\s+"\$context_entries"\s+!=/.test(line));
    expect(
      guard,
      'the staging directory is enumerated but the result is never checked',
    ).toBeDefined();
    const admitted = (guard?.line.match(/!=\s+"([^"]*)"/)?.[1] ?? '').trim().split(/\s+/).sort();
    expect(
      admitted,
      'the guard admits something other than the three files the gate needs',
    ).toEqual(['.dockerignore', 'Dockerfile.freshtest', 'freshtest.tgz'].sort());

    const guardIdx = lines.findIndex((l) => l === guard);
    const buildIdx = lines.findIndex(({ line }) => /\bdocker\s+build\b/.test(line));
    expect(guardIdx, 'the contents guard runs after the build it is supposed to gate').toBeLessThan(
      buildIdx,
    );
    const branch = lines
      .slice(guardIdx, buildIdx)
      .map(({ line }) => line)
      .join('\n');
    expect(branch, 'an unexpected staging directory only warns instead of aborting').toMatch(
      /\bexit\s+[1-9]/,
    );
  });
});

describe('scripts/freshtest.sh deletes only the run directory it validated', () => {
  it('has exactly ONE filesystem removal: the validated run directory', () => {
    const removals = removalLines();
    // An empty scan would let this whole assertion pass by deleting the cleanup instead of fixing
    // it, so the count is asserted before the shape — and the shape is enumerated exactly, so a
    // second removal cannot be smuggled in beside it.
    expect(
      removals.length,
      'exactly one filesystem removal is expected — the validated run directory; fewer means the staging directory is never cleaned up, more means something beyond it is being deleted',
    ).toBe(1);
    expect(
      removals.map(({ line }) => line),
      `scripts/freshtest.sh removes a path other than the validated run directory: ${removals
        .map(({ line, at }) => `${at}: ${line}`)
        .join(' | ')}`,
    ).toEqual(['rm -rf -- "$ctx"']);

    // AND THE LOCK FILE IS NEVER ONE OF THEM. A kernel lock is attached to an open file, not to
    // the existence of a name: unlinking the file while another run holds it does not release
    // anything — it just means the next arrival creates a NEW file, locks that, and walks into the
    // section beside the holder. Nothing in this script may remove, rename or truncate it.
    const text = scriptText();
    for (const { line, at } of shellLines()) {
      expect(
        /(?<![\w-])(?:rm|rmdir|unlink|mv)(?![\w-])[^\n]*lock/.test(line),
        `scripts/freshtest.sh:${at} removes or renames the build lock: ${line}`,
      ).toBe(false);
    }
    expect(text, 'the script still carries a stale-lock reclamation').not.toMatch(/\.stale\./);
    expect(text, 'the script still tracks lock ownership by hand').not.toMatch(/lock_held/);
    expect(
      text,
      'the script still records a holder PID — kernel locks have no owner metadata to race',
    ).not.toMatch(/lock_dir\/pid|kill\s+-0/);
  });

  it('leaves the trap holding nothing until a guard has accepted the mktemp path', () => {
    const lines = shellLines();
    const at = (pred: (l: string) => boolean): number => lines.findIndex(({ line }) => pred(line));

    const init = at((l) => /^ctx=(?:""|'')$/.test(l));
    expect(init, 'ctx is never initialised empty — the trap can fire on an unset/stale value').toBe(
      // The trap removes whatever `$ctx` holds and is armed before anything exists, so the value
      // it can see between arming and validation must be one that removes nothing.
      lines.findIndex(({ line }) => /^ctx=/.test(line)),
    );
    expect(init, 'no empty ctx initialisation found').toBeGreaterThan(-1);

    const trap = at((l) => /\btrap\b[^\n]*\bEXIT\b/.test(l));
    expect(trap, 'no EXIT trap').toBeGreaterThan(-1);
    expect(init, 'ctx is initialised only after the EXIT trap is already armed').toBeLessThan(trap);

    const mk = at((l) => /\bmktemp\s+-d\b/.test(l));
    expect(mk, 'the run directory is not created with `mktemp -d`').toBeGreaterThan(trap);

    const promote = lines.findIndex(({ line }, i) => i > mk && /^ctx="\$candidate"$/.test(line));
    expect(
      promote,
      'the mktemp path is never promoted into the variable the trap removes',
    ).toBeGreaterThan(mk);

    // A guard has to STAND BETWEEN creation and promotion, and it has to abort rather than warn.
    const guard = lines
      .slice(mk + 1, promote)
      .map(({ line }) => line)
      .join('\n');
    expect(guard, 'nothing validates the mktemp path before the trap may delete it').toMatch(
      /\bexit\s+[1-9]/,
    );
    expect(guard, 'the guard never checks the path shape').toMatch(/sthayi-freshtest\./);
    expect(guard, 'the guard never checks the path is a real, non-symlink directory').toMatch(
      /-d\s+"\$candidate"/,
    );
    expect(guard, 'the guard never rejects a symlinked run directory').toMatch(
      /-L\s+"\$candidate"/,
    );
    // AND THE PATH ITSELF MUST BE CANONICAL. `-L "$candidate"` only rules out the LAST component
    // being a link; a link anywhere above it is just as good a way to move the directory the trap
    // deletes. Requiring the candidate to resolve to itself rules out every component at once.
    expect(guard, 'the run directory is never proved to resolve to itself').toMatch(
      /candidate_real/,
    );
    expect(guard, 'a run directory that resolves somewhere else is accepted anyway').toMatch(
      /if\s+\[\s+"\$candidate_real"\s+!=\s+"\$candidate"\s+\]/,
    );
  });

  it('canonicalises the staging PARENT before mktemp is allowed to use it', () => {
    // THE ORDER IS THE WHOLE FIX. `mktemp -d "$TMPDIR/sthayi-freshtest.XXXXXXXX"` on a TMPDIR that
    // is a SYMLINK creates the directory through the link and returns a path that still contains
    // it. Retarget the link afterwards and every later use of that path — above all the `rm -rf`
    // — resolves somewhere else entirely and deletes whatever is standing at the same name there.
    // Resolving the parent to its physical path BEFORE the allocation removes the link from the
    // pathname, so there is no longer anything to retarget.
    const lines = shellLines();
    const canon = lines.findIndex(({ line }) =>
      /^staging_parent_real="\$\(cd\s+"\$staging_parent"[^)]*pwd\s+-P\)"/.test(line),
    );
    expect(canon, 'the staging parent is never resolved to a physical path').toBeGreaterThan(-1);

    const mk = lines.findIndex(({ line }) => /\bmktemp\s+-d\b/.test(line));
    expect(mk, 'the run directory is not created with `mktemp -d`').toBeGreaterThan(-1);
    expect(canon, 'the parent is canonicalised only after mktemp already used it').toBeLessThan(mk);

    // And the allocation must be made IN the canonical parent, not in the pathname it came from.
    expect(
      lines[mk]?.line,
      'mktemp still allocates through the unresolved TMPDIR pathname',
    ).toMatch(/mktemp\s+-d\s+"\$staging_parent_real\/sthayi-freshtest\.XXXXXXXX"/);
    expect(
      lines.slice(canon, mk).some(({ line }) => /\bexit\s+[1-9]/.test(line)),
      'an unusable TMPDIR only warns instead of aborting',
    ).toBe(true);

    // The shape guard must compare against the CANONICAL parent too — comparing against the
    // unresolved one would re-admit exactly the pathname the canonicalisation removed.
    expect(
      scriptText(),
      'the run directory shape is still validated against the unresolved TMPDIR',
    ).toMatch(/"\$staging_parent_real"\/sthayi-freshtest\.\?{8}\)/);
  });

  it('guards the removal itself on the directory being named, canonical and real', () => {
    const text = scriptText();
    const body = text.slice(text.indexOf('cleanup()'), text.indexOf('\ntrap cleanup EXIT'));
    expect(body, 'no cleanup body found between `cleanup()` and the trap').not.toBe('');
    expect(body, 'the trap removes the run directory unguarded').toMatch(
      /if\s+\[\s+-n\s+"\$ctx"\s+\]\s+&&\s+\[\s+!\s+-L\s+"\$ctx"\s+\]\s+&&\s+\[\s+-d\s+"\$ctx"\s+\]\s*;\s*then/,
    );
  });
});

describe('scripts/freshtest.sh serialises the build+pack section with a KERNEL lock', () => {
  it('runs BOTH the build and the pack as children of the lock tool', () => {
    const text = scriptText();
    const section = text.slice(
      text.indexOf('critical_section='),
      text.indexOf('export FRESHTEST_ROOT='),
    );
    expect(section, 'no critical section body found').not.toBe('');
    // tsup's `clean: true` deletes the SHARED `packages/cli/dist`, and npm's prepack/postpack copy
    // and then delete the SHARED `packages/cli/README.md` and `LICENSE`. BOTH have to be inside the
    // section: a lock taken after the build isolates nothing that matters.
    expect(section, 'the CLI build is outside the locked section').toMatch(
      /pnpm\s+--filter\s+sthayi\s+build/,
    );
    expect(section, 'the pack is outside the locked section').toMatch(/npm\s+pack\b/);

    // The section is EXECUTED BY the lock tool, which is what makes the lock airtight: the kernel
    // holds it for exactly as long as that child lives. A lock "acquired" and "released" by two
    // separate statements is a lock this script could release on someone else's behalf.
    const lines = shellLines();
    const invoke = lines.findIndex(({ line }) =>
      /^"\$\{lock_cmd\[@\]\}"\s+bash\s+-c\s+"\$critical_section"/.test(line),
    );
    expect(invoke, 'the critical section is not run as a child of the lock tool').toBeGreaterThan(
      -1,
    );
    const build = lines.findIndex(({ line }) => /\bdocker\s+build\b/.test(line));
    expect(invoke, 'the container build runs before the tarball exists').toBeLessThan(build);

    // The container build (the long part) must NOT be inside the section.
    expect(section, 'the container build is serialised along with the pack').not.toMatch(
      /docker\s+build/,
    );

    // Nothing in this script releases the lock — the kernel does, when the child exits.
    for (const { line, at } of lines) {
      expect(
        /release_build_lock|acquire_build_lock/.test(line),
        `scripts/freshtest.sh:${at} still hand-rolls lock acquire/release: ${line}`,
      ).toBe(false);
    }
  });

  it('takes a kernel advisory lock — flock on Linux, lockf on macOS — and fails closed with neither', () => {
    const text = scriptText();
    const lines = shellLines();

    // Detection is by TOOL PRESENCE, which is the exact question ("can this section be serialised
    // at all?"), rather than by `uname`, which is a proxy for it.
    expect(text, 'flock is never looked for').toMatch(/command\s+-v\s+flock\b/);
    expect(text, 'lockf is never looked for').toMatch(/command\s+-v\s+lockf\b/);

    const flockCmd = lines.find(({ line }) => /^flock\)\s+lock_cmd=\(/.test(line));
    expect(flockCmd?.line, 'the flock invocation is not a bounded-wait command form').toMatch(
      /lock_cmd=\(flock\s+-w\s+"\$lock_wait"\s+"\$lock_file"\)/,
    );
    const lockfCmd = lines.find(({ line }) => /^lockf\)\s+lock_cmd=\(/.test(line));
    // `-k` KEEPS the lock file: without it lockf unlinks the file on release, and the next arrival
    // creates and locks a different inode — two runs, two locks, both inside the section.
    expect(lockfCmd?.line, 'the lockf invocation drops -k or the timeout').toMatch(
      /lock_cmd=\(lockf\s+-k\s+-t\s+"\$lock_wait"\s+"\$lock_file"\)/,
    );

    // FAIL CLOSED. Building unserialised because a tool is missing is the one outcome that is
    // worse than not building at all: it corrupts the OTHER run, which never asked for anything.
    const detect = text.slice(text.indexOf("lock_tool=''"), text.indexOf('lock_file='));
    expect(detect, 'a machine with neither lock tool proceeds anyway').toMatch(/\bexit\s+[1-9]/);
    expect(detect, 'the refusal does not name flock').toMatch(/flock/);
    expect(detect, 'the refusal does not name lockf').toMatch(/lockf/);

    // The wait is bounded, and the bound is the one passed to the tool.
    expect(
      lines.some(({ line }) => /^lock_wait=\d+$/.test(line)),
      'the wait for the lock is unbounded — a wedged holder blocks this checkout forever',
    ).toBe(true);
  });

  it('locks a stable repo-private file, never package-manager state', () => {
    const lockFile = shellLines().find(({ line }) => /^lock_file=/.test(line));
    expect(lockFile?.line, 'the lock is not one fixed repo-private path').toBe(
      'lock_file="$root/.sthayi-freshtest.lock"',
    );
    // `node_modules` is package-manager state: a `pnpm install`, a prune or an `rm -rf` deletes it
    // mid-run, and every run that arrives afterwards locks a NEW file. Two runs then hold two
    // different locks and both enter the section — the lock has silently stopped existing.
    expect(
      lockFile?.line.includes('node_modules'),
      'the build lock lives under node_modules, where a package manager can delete it mid-run',
    ).toBe(false);
    // ...and it must be ignored, or every developer who runs the gate gets an untracked file.
    expect(readRepoFile('.gitignore'), 'the build lock file is not git-ignored').toContain(
      '.sthayi-freshtest.lock',
    );
  });

  it('decides whether the section ran from a FACT, not from an exit code', () => {
    const lines = shellLines();
    const marker = lines.findIndex(({ line }) => /^:\s>\s"\$FRESHTEST_ENTERED"$/.test(line));
    expect(marker, 'nothing records that the locked section was actually entered').toBeGreaterThan(
      -1,
    );
    // "The lock timed out" and "the build failed" are different diagnoses with different advice,
    // and flock, lockf, pnpm and npm can all spell them with the same exit status. The marker is
    // written by the first statement inside the section, so its absence is unambiguous.
    const check = lines.findIndex(({ line }) =>
      /^if\s+\[\s+!\s+-f\s+"\$entered_marker"\s+\]/.test(line),
    );
    expect(check, 'the timeout is diagnosed from an exit code alone').toBeGreaterThan(marker);
    const text = scriptText();
    const diag = text.slice(text.indexOf('if [ ! -f "$entered_marker" ]'));
    expect(diag, 'the timeout path does not abort').toMatch(/\bexit\s+[1-9]/);
    // The manual-cleanup guidance has to match the mechanism: with a kernel lock there is nothing
    // to clean up, and telling a developer to delete the lock file would teach them to break it.
    expect(diag, 'the timeout diagnostic does not say the lock needs no manual cleanup').toMatch(
      /NOTHING NEEDS CLEANING UP BY HAND/,
    );
    expect(diag, 'the timeout diagnostic tells the developer to remove the lock').not.toMatch(
      /rm\s+[^\n]*lock/,
    );
  });
});

describe('the release freshtest builds the checksummed artifact from a staged context', () => {
  const jobLines = (): { line: string; at: number }[] =>
    freshtestJob()
      .split('\n')
      .map((line, i) => ({ line: line.trim(), at: i + 1 }))
      .filter(({ line }) => line !== '' && !line.startsWith('#'));

  it('is still a job in the release workflow', () => {
    expect(freshtestJob(), 'no `freshtest-docker` job in .github/workflows/release.yml').not.toBe(
      '',
    );
  });

  it('takes its expected digest from the BUILD JOB, not from a file on the runner', () => {
    // THE REBINDING THIS CLOSES. `sha256sum -c SHA256SUMS` proves a tarball agrees with the
    // manifest lying beside it. Replace BOTH — the manifest and the tarball — and the pair agrees
    // with itself; a digest then parsed out of that manifest is the substitute's own digest, and
    // every later comparison passes. The expectation therefore has to come from somewhere the
    // runner's filesystem cannot reach: a job output, fixed by the workflow control plane when the
    // build job ended.
    const build = jobBlock('build');
    expect(build, 'no `build` job in the workflow').not.toBe('');
    expect(
      build,
      'the build job does not publish the packed tarball digest as a job output',
    ).toMatch(
      /outputs:[\s\S]*tarball-sha256:\s*\$\{\{\s*steps\.checksums\.outputs\.tarball-sha256/,
    );
    expect(build, 'the digest output is not computed from the tarball this job packed').toMatch(
      /SHA="\$\(sha256sum\s+"\$TARBALL_NAME"\s*\|\s*cut\s+-d\s+' '\s+-f\s+1\)"/,
    );

    // ...and the freshtest job must consume THAT, through its env block.
    expect(freshtestJob(), 'the freshtest job does not receive the build job digest').toMatch(
      /EXPECTED_SHA:\s*\$\{\{\s*needs\.build\.outputs\.tarball-sha256\s*\}\}/,
    );

    // NO SECOND READ OF MUTABLE AUTHORITY. The step may not assign EXPECTED_SHA at all: the moment
    // it does, the value is whatever the runner's disk said, and the job output was decoration.
    for (const { line } of jobLines()) {
      expect(
        /^EXPECTED_SHA=/.test(line),
        `the step re-derives its own expectation on the runner: ${line}`,
      ).toBe(false);
    }
    // A missing or malformed output must abort rather than compare everything to an empty string.
    const guard = jobLines().findIndex(({ line }) =>
      /printf\s+'%s'\s+"\$EXPECTED_SHA"\s*\|\s*grep\s+-Eq\s+'\^\[0-9a-f\]\{64\}\$'/.test(line),
    );
    expect(guard, 'an empty build-job digest is never rejected').toBeGreaterThan(-1);
    expect(
      jobLines()
        .slice(guard, guard + 4)
        .map(({ line }) => line)
        .join('\n'),
      'a missing build-job digest only warns',
    ).toMatch(/\bexit\s+[1-9]/);
    const built = jobLines().findIndex(({ line }) => /\bdocker\s+build\b/.test(line));
    expect(guard, 'the image is built before the digest authority is checked').toBeLessThan(built);
  });

  it('requires the published manifest to AGREE with the build job, and never to supply the value', () => {
    const lines = jobLines();
    // Not "find a line that looks usable": exactly one entry, 64 lowercase hex digits, and the
    // filename compared as a literal string against this release's. A manifest that says anything
    // else is refused rather than mined for a digest.
    expect(
      lines.some(({ line }) => /if\s+\[\s+"\$SUMS_LINES"\s+!=\s+"1"\s+\]/.test(line)),
      'the manifest is not required to hold exactly one entry',
    ).toBe(true);
    expect(
      lines.some(({ line }) => line.startsWith('SUMS_RE=') && line.includes('[0-9a-f]{64}')),
      'the manifest entry is not parsed against a strict 64-hex-digit pattern',
    ).toBe(true);
    const named = lines.findIndex(({ line }) =>
      /if\s+\[\s+"\$SUMS_NAME"\s+!=\s+"\$TARBALL_NAME"\s+\]/.test(line),
    );
    expect(
      named,
      'the manifest entry is not required to name this release artifact',
    ).toBeGreaterThan(-1);
    expect(
      lines
        .slice(named, named + 4)
        .map(({ line }) => line)
        .join('\n'),
      'a manifest naming some other file only warns',
    ).toMatch(/\bexit\s+[1-9]/);

    // THE DUAL-REPLACEMENT CHECK. The manifest is demoted to a published claim that must equal the
    // build job's output; a manifest rewritten alongside the tarball fails here.
    const agrees = lines.findIndex(({ line }) =>
      /if\s+\[\s+"\$SUMS_SHA"\s+!=\s+"\$EXPECTED_SHA"\s+\]/.test(line),
    );
    expect(
      agrees,
      'the downloaded manifest is never required to equal the build job digest',
    ).toBeGreaterThan(-1);
    expect(
      lines
        .slice(agrees, agrees + 4)
        .map(({ line }) => line)
        .join('\n'),
      'a manifest that disagrees with the build job only warns',
    ).toMatch(/\bexit\s+[1-9]/);
  });

  it('compares BOTH the source and the staged copy to that fixed digest, never to each other', () => {
    const lines = jobLines();
    expect(
      lines.some(({ line }) => /sha256sum\s+"\$ctx\/freshtest\.tgz"/.test(line)),
      'the staged tarball is never checksummed',
    ).toBe(true);

    // THE WHOLE POINT. Verifying SHA256SUMS is a statement about the bytes at one instant, and the
    // `cp` that stages them happens at a later one. Re-deriving the expectation by hashing the
    // source again compares the artifact to ITSELF: a replacement landing in between is copied,
    // hashed, agreed with, and built.
    const sourceCmp = lines.findIndex(({ line }) =>
      /if\s+\[\s+"\$SOURCE_SHA"\s+!=\s+"\$EXPECTED_SHA"\s+\]/.test(line),
    );
    expect(sourceCmp, 'the source tarball is never compared to the pinned digest').toBeGreaterThan(
      -1,
    );
    const stagedCmp = lines.findIndex(({ line }) =>
      /if\s+\[\s+"\$STAGED_SHA"\s+!=\s+"\$EXPECTED_SHA"\s+\]/.test(line),
    );
    expect(stagedCmp, 'the staged copy is never compared to the pinned digest').toBeGreaterThan(-1);
    for (const { line } of lines) {
      expect(
        /"\$SOURCE_SHA"\s*!=\s*"\$STAGED_SHA"|"\$STAGED_SHA"\s*!=\s*"\$SOURCE_SHA"/.test(line),
        'the staged copy is compared to a freshly hashed source instead of to the pinned digest',
      ).toBe(false);
    }

    // The source is judged BEFORE it is staged, and the staged copy BEFORE the build.
    const copy = lines.findIndex(({ line }) =>
      /^cp\s+"freshtest-artifact\/\$TARBALL_NAME"\s+"\$ctx\/freshtest\.tgz"$/.test(line),
    );
    expect(copy, 'the artifact is never staged').toBeGreaterThan(-1);
    expect(sourceCmp, 'the source is judged only after it has already been staged').toBeLessThan(
      copy,
    );
    const build = lines.findIndex(({ line }) => /\bdocker\s+build\b/.test(line));
    expect(stagedCmp, 'the digests are compared only after the image is built').toBeLessThan(build);

    for (const at of [sourceCmp, stagedCmp]) {
      expect(
        lines
          .slice(at, at + 4)
          .map(({ line }) => line)
          .join('\n'),
        'a tarball that is not the pinned release artifact only warns',
      ).toMatch(/\bexit\s+[1-9]/);
    }
  });

  it('hands the daemon the staged directory, not the checkout', () => {
    const build = jobLines().find(({ line }) => /\bdocker\s+build\b/.test(line))?.line ?? '';
    expect(build, 'the release gate no longer builds the image').not.toBe('');
    expect(build, 'the release build never enters a staged directory').toMatch(
      /\bcd\s+"\$ctx"\s*&&/,
    );
    expect(
      buildContextOperand(build),
      'the release build context operand is not the staged directory',
    ).toBe('.');
    // `actions/checkout` put the whole repository at the workspace root; copying the artifact
    // there and building `.` hands the daemon the entire checkout.
    for (const { line } of jobLines()) {
      expect(
        /^cp\s.*\sfreshtest\.tgz$/.test(line),
        'the release gate stages the artifact in the checkout root',
      ).toBe(false);
    }
  });

  it('enumerates the staged context before the build, admitting exactly three entries', () => {
    // The same assertion scripts/freshtest.sh makes, on the release path. Deny-by-default in
    // `.dockerignore` is a FILTER over whatever directory is offered; this is a statement about
    // what is offered at all. A fourth entry is a file uploaded to the daemon that nobody decided
    // to send, and any later `COPY` could reach it.
    const lines = jobLines();
    const listing = lines.findIndex(({ line }) => /^CONTEXT_ENTRIES=/.test(line));
    expect(listing, 'the release gate never enumerates the staged context').toBeGreaterThan(-1);
    expect(lines[listing]?.line, 'the enumeration is not of the staged directory').toMatch(
      /cd\s+"\$ctx"/,
    );
    const guard = lines.find(({ line }) => /^if\s+\[\s+"\$CONTEXT_ENTRIES"\s+!=/.test(line));
    expect(guard, 'the staged context is enumerated but never checked').toBeDefined();
    const admitted = (guard?.line.match(/!=\s+"([^"]*)"/)?.[1] ?? '').trim().split(/\s+/).sort();
    expect(
      admitted,
      'the release guard admits something other than the three files the gate needs',
    ).toEqual(['.dockerignore', 'Dockerfile.freshtest', 'freshtest.tgz'].sort());
    const guardIdx = lines.findIndex((l) => l === guard);
    const build = lines.findIndex(({ line }) => /\bdocker\s+build\b/.test(line));
    expect(guardIdx, 'the context guard runs after the build it is supposed to gate').toBeLessThan(
      build,
    );
    expect(
      lines
        .slice(guardIdx, build)
        .map(({ line }) => line)
        .join('\n'),
      'an unexpected staged context only warns instead of aborting',
    ).toMatch(/\bexit\s+[1-9]/);
  });

  it('publishes only bytes the build job vouched for', () => {
    // The publish job is the last consumer and the only one that leaves the system, so the same
    // rebinding matters most there: `sha256sum -c SHA256SUMS` before `npm publish` proves nothing
    // once the manifest travels with the artifact.
    const publish = jobBlock('publish');
    expect(publish, 'no `publish` job in the workflow').not.toBe('');
    expect(publish, 'the publish job does not receive the build job digest').toMatch(
      /EXPECTED_SHA:\s*\$\{\{\s*needs\.build\.outputs\.tarball-sha256\s*\}\}/,
    );
    expect(
      publish,
      'the publish job never compares the bytes it is about to publish to that digest',
    ).toMatch(/if\s+\[\s+"\$GOT_SHA"\s+!=\s+"\$EXPECTED_SHA"\s+\]/);
    expect(
      /sha256sum\s+-c\s+SHA256SUMS/.test(publish),
      'the publish job still treats the co-located manifest as its authority',
    ).toBe(false);
  });
});

// ===============================================================================================
// THE EXECUTING HALF.
//
// Three of the claims above cannot be settled by reading text. That a cleanup is bound to CREATION
// rather than to a NAME, that a replacement made after a checksum was verified is refused, and
// that two overlapping runs leave each other's state alone are all statements about what happens
// when the thing RUNS. So they are run: the real `scripts/freshtest.sh` and the real workflow step,
// taken byte-for-byte off disk, inside a throwaway mini-checkout.
//
// NO DOCKER DAEMON IS EVER CONTACTED. `docker`, `pnpm`, `npm`, `mktemp` and `sha256sum` are shell
// scripts placed AHEAD of everything on PATH; the fake `docker` appends its arguments to a log and
// keeps a one-file registry of image tags, and never execs the real binary. The repository under
// test is never written to — every path below is inside the throwaway directory, and every
// directory is removed inside the test body that made it.
// ===============================================================================================

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** A throwaway scratch root. Named so it can never be confused with a run fixture. */
const scratchDir = (): string =>
  fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'freshgate-'));

const writeExec = (file: string, body: string): void => {
  fs.writeFileSync(file, body, { mode: 0o700 });
};

/**
 * Remove a scratch tree. Called from test BODIES only — never a hook, never a `finally` — so the
 * classifier in tests/safety/harness-fs-binding.test.ts keeps holding.
 */
function wipe(dir: string): void {
  removeForeignTree(dir);
}

const FAKE_DOCKER = `#!/bin/sh
# Stand-in for the docker CLI: logs what it was asked to do and keeps a one-file image registry.
# It contacts no daemon and never execs the real binary.
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1 $2" in
  'image inspect')
    grep -qxF "$3" "$FAKE_DOCKER_IMAGES" 2>/dev/null && exit 0
    exit 1
    ;;
  'image rm')
    grep -vxF "$3" "$FAKE_DOCKER_IMAGES" > "$FAKE_DOCKER_IMAGES.next" 2>/dev/null || :
    mv "$FAKE_DOCKER_IMAGES.next" "$FAKE_DOCKER_IMAGES"
    exit 0
    ;;
esac
if [ "$1" = build ]; then
  tag=''
  prev=''
  operand=''
  for a in "$@"; do
    [ "$prev" = '-t' ] && tag="$a"
    operand="$a"
    prev="$a"
  done
  [ -n "$tag" ] && printf '%s\\n' "$tag" >> "$FAKE_DOCKER_IMAGES"
  # WHAT THE DAEMON WAS ACTUALLY POINTED AT. The build cwd and the exact entries of the context
  # operand, recorded from the daemon's side of the call: the gate's own pre-build enumeration is
  # the gate asserting about itself, and an edit could delete both together.
  printf 'cwd %s\\n' "$PWD" >> "$FAKE_DOCKER_CONTEXT"
  printf 'context %s :: %s\\n' "$operand" \\
    "$(cd "$operand" 2>/dev/null && LC_ALL=C ls -A | LC_ALL=C sort | tr '\\n' ' ')" \\
    >> "$FAKE_DOCKER_CONTEXT"
fi
exit 0
`;

const FAKE_PNPM = `#!/bin/sh
printf 'pnpm %s\\n' "$*" >> "$FAKE_CMD_LOG"
# THE MUTUAL-EXCLUSION LEDGER. The build is the first thing inside the critical section and the
# pack is the last, so a correctly serialised pair of runs writes strictly alternating
# enter/exit lines. Any interleaving is two runs standing in the section together.
printf 'enter %s\\n' "$FAKE_RUN_ID" >> "$FAKE_SECTION_LEDGER"
if [ "\${FAKE_PNPM_FAILS:-0}" = 1 ]; then
  printf 'exit %s\\n' "$FAKE_RUN_ID" >> "$FAKE_SECTION_LEDGER"
  echo 'fake pnpm: build failed' >&2
  exit 3
fi
# tsup is configured clean: true — the SHARED dist is deleted and recreated on every build, and
# stamped with the id of the run that made it.
rm -rf "$FAKE_ROOT/packages/cli/dist"
mkdir -p "$FAKE_ROOT/packages/cli/dist"
printf '%s\\n' "$FAKE_RUN_ID" > "$FAKE_ROOT/packages/cli/dist/owner"
printf '%s\\n' "$FAKE_RUN_ID" > "$FAKE_ROOT/phase-building-$FAKE_RUN_ID"
sleep "\${FAKE_BUILD_SECONDS:-0}"
exit 0
`;

const FAKE_NPM = `#!/bin/sh
printf 'npm %s\\n' "$*" >> "$FAKE_CMD_LOG"
dest=''
prev=''
for a in "$@"; do
  [ "$prev" = '--pack-destination' ] && dest="$a"
  prev="$a"
done
# prepack copies the repo-root docs into the SHARED package directory.
cp "$FAKE_ROOT/README.md" "$FAKE_ROOT/packages/cli/README.md"
cp "$FAKE_ROOT/LICENSE" "$FAKE_ROOT/packages/cli/LICENSE"
sleep "\${FAKE_PACK_SECONDS:-0}"
owner="$(cat "$FAKE_ROOT/packages/cli/dist/owner" 2>/dev/null || echo MISSING)"
if [ "$owner" != "$FAKE_RUN_ID" ]; then
  echo "fake npm pack: dist belongs to '$owner', not '$FAKE_RUN_ID'" >&2
  exit 91
fi
if [ ! -f "$FAKE_ROOT/packages/cli/README.md" ] || [ ! -f "$FAKE_ROOT/packages/cli/LICENSE" ]; then
  echo 'fake npm pack: the prepack docs went away before the pack read them' >&2
  exit 92
fi
printf 'tarball owned by %s\\n' "$FAKE_RUN_ID" > "$dest/sthayi-0.0.0.tgz"
# postpack removes the SHARED copies again.
rm -f "$FAKE_ROOT/packages/cli/README.md" "$FAKE_ROOT/packages/cli/LICENSE"
printf 'sthayi-0.0.0.tgz\\n'
printf 'exit %s\\n' "$FAKE_RUN_ID" >> "$FAKE_SECTION_LEDGER"
exit 0
`;

function harnessEnv(rootDir: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${path.join(rootDir, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`,
    HOME: path.join(rootDir, 'home'),
    TMPDIR: path.join(rootDir, 'tmp'),
    FAKE_ROOT: rootDir,
    FAKE_CMD_LOG: path.join(rootDir, 'cmd.log'),
    FAKE_DOCKER_LOG: path.join(rootDir, 'docker.log'),
    FAKE_DOCKER_IMAGES: path.join(rootDir, 'images.txt'),
    FAKE_DOCKER_CONTEXT: path.join(rootDir, 'context.log'),
    FAKE_SECTION_LEDGER: path.join(rootDir, 'section.log'),
    FAKE_REAL_PATH: process.env.PATH ?? '',
    ...extra,
  };
}

/** The three files the staged build context is allowed to hold — in `ls -A | sort` order. */
const CONTEXT_EXACT = '.dockerignore Dockerfile.freshtest freshtest.tgz ';

/**
 * The context entry lists the FAKE DOCKER recorded, one per `build`. Asserting against what the
 * daemon was handed — rather than against the gate's own pre-build enumeration — is the point:
 * both the enumeration and the guard live in the file under test and one edit removes both.
 */
const recordedContexts = (rootDir: string): string[] =>
  logLines(rootDir, 'context.log')
    .filter((l) => l.startsWith('context '))
    .map((l) => l.slice(l.indexOf(' :: ') + 4));

const recordedBuildCwds = (rootDir: string): string[] =>
  logLines(rootDir, 'context.log')
    .filter((l) => l.startsWith('cwd '))
    .map((l) => l.slice(4));

const runSync = (args: string[], cwd: string, env: NodeJS.ProcessEnv): RunResult => {
  const r = spawnSync('bash', args, { cwd, env, encoding: 'utf8' });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

/**
 * Bash by absolute path. `spawn('bash')` resolves the interpreter through the PATH IT IS GIVEN, so
 * a probe that deliberately hands the script a stripped PATH cannot also use it to find the shell:
 * the run would die at exec with nothing to assert about.
 */
const REAL_BASH =
  ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', '/opt/homebrew/bin/bash'].find((p) =>
    fs.existsSync(p),
  ) ?? 'bash';

const runSyncAbsoluteShell = (args: string[], cwd: string, env: NodeJS.ProcessEnv): RunResult => {
  const r = spawnSync(REAL_BASH, args, { cwd, env, encoding: 'utf8' });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

const logLines = (rootDir: string, name: string): string[] =>
  fs
    .readFileSync(path.join(rootDir, name), 'utf8')
    .split('\n')
    .filter((l) => l !== '');

/** A mini-checkout holding the REAL script plus the three files it stages. */
function miniCheckout(): string {
  const rootDir = scratchDir();
  for (const rel of ['scripts', 'node_modules', 'bin', 'tmp', 'home', 'packages/cli']) {
    fs.mkdirSync(path.join(rootDir, ...rel.split('/')), { recursive: true });
  }
  // Byte-for-byte off disk: a regression in the real file is what fails these tests.
  fs.writeFileSync(path.join(rootDir, 'scripts', 'freshtest.sh'), scriptText());
  fs.writeFileSync(path.join(rootDir, 'Dockerfile.freshtest'), dockerfileText());
  fs.writeFileSync(path.join(rootDir, '.dockerignore'), dockerignoreText());
  fs.writeFileSync(path.join(rootDir, 'README.md'), 'mini README\n');
  fs.writeFileSync(path.join(rootDir, 'LICENSE'), 'mini LICENSE\n');
  for (const name of ['images.txt', 'docker.log', 'cmd.log', 'context.log', 'section.log']) {
    fs.writeFileSync(path.join(rootDir, name), '');
  }
  writeExec(path.join(rootDir, 'bin', 'docker'), FAKE_DOCKER);
  writeExec(path.join(rootDir, 'bin', 'pnpm'), FAKE_PNPM);
  writeExec(path.join(rootDir, 'bin', 'npm'), FAKE_NPM);
  return rootDir;
}

const freshtestScript = (rootDir: string): string[] => [
  path.join(rootDir, 'scripts', 'freshtest.sh'),
];

/** A tag the harness plants in the registry BEFORE the run, and that must still be there after. */
const BYSTANDER = 'sthayi-freshtest:an-image-this-run-never-made';
const describePosix = describe.skipIf(process.platform === 'win32');

describePosix('scripts/freshtest.sh contains optional user shell initialisation', () => {
  it('an nvm startup file that exits cannot terminate the release gate', () => {
    const rootDir = miniCheckout();
    const nvmDir = path.join(rootDir, 'home', '.nvm');
    fs.mkdirSync(nvmDir, { recursive: true });
    // This is the failure mode the containment exists for: `exit` cannot be caught by appending
    // `|| true` when a startup file is sourced into the release gate's own shell.
    fs.writeFileSync(path.join(nvmDir, 'nvm.sh'), 'exit 3\n');

    const run = runSync(freshtestScript(rootDir), rootDir, harnessEnv(rootDir, {}));
    const docker = logLines(rootDir, 'docker.log');
    wipe(rootDir);

    expect(run.code, `${run.stdout}${run.stderr}`).toBe(0);
    expect(
      docker.filter((line) => line.startsWith('build ')),
      'the gate stopped before building after optional nvm startup failed',
    ).toHaveLength(1);
  }, 60_000);

  it.each([21, 23, 25, 26])(
    'refuses unsupported host Node %i before build or pack',
    (nodeMajor) => {
      const rootDir = miniCheckout();
      writeExec(
        path.join(rootDir, 'bin', 'node'),
        `#!/bin/sh\nif [ "$1" = "-p" ]; then printf "${nodeMajor}\\n"; exit 0; fi\nprintf "v${nodeMajor}.0.0\\n"\n`,
      );

      const run = runSync(freshtestScript(rootDir), rootDir, harnessEnv(rootDir, {}));
      const docker = logLines(rootDir, 'docker.log');
      const commands = logLines(rootDir, 'cmd.log');
      wipe(rootDir);

      expect(run.code).not.toBe(0);
      expect(`${run.stdout}${run.stderr}`).toContain('Node 22 or 24 is required');
      expect(docker, 'an unsupported host runtime reached Docker').toEqual([]);
      expect(commands, 'an unsupported host runtime reached the build or pack section').toEqual([]);
    },
  );
});

describePosix('scripts/freshtest.sh removes an image only when it created one', () => {
  it('a run that fails BEFORE the build issues no image removal at all', () => {
    const rootDir = miniCheckout();
    fs.writeFileSync(path.join(rootDir, 'images.txt'), `${BYSTANDER}\n`);

    // Fails in the pack phase, which is BEFORE the build — the exact window in which a cleanup
    // bound to the tag NAME rather than to the act of creating an image goes off.
    const run = runSync(
      freshtestScript(rootDir),
      rootDir,
      harnessEnv(rootDir, { FAKE_RUN_ID: 'A', FAKE_PNPM_FAILS: '1' }),
    );
    const docker = logLines(rootDir, 'docker.log');
    const images = logLines(rootDir, 'images.txt');
    wipe(rootDir);

    expect(run.code, `the run was expected to fail before the build: ${run.stderr}`).not.toBe(0);
    // Not "it removed the wrong tag" — it must issue NO removal. Any removal here is aimed at a
    // name this invocation never created, and whatever image is wearing that name goes with it.
    expect(
      docker.filter((l) => l.startsWith('image rm')),
      'the EXIT trap removed an image although this run never built one',
    ).toEqual([]);
    expect(
      docker.filter((l) => l.startsWith('build ')),
      'the build ran even though the pack phase failed',
    ).toEqual([]);
    expect(images, 'a pre-existing image was destroyed by a run that built nothing').toEqual([
      BYSTANDER,
    ]);
  }, 60_000);

  it('a successful run removes EXACTLY its own tag, and nothing beside it', () => {
    const rootDir = miniCheckout();
    fs.writeFileSync(path.join(rootDir, 'images.txt'), `${BYSTANDER}\n`);

    const run = runSync(
      freshtestScript(rootDir),
      rootDir,
      harnessEnv(rootDir, { FAKE_RUN_ID: 'A' }),
    );
    const docker = logLines(rootDir, 'docker.log');
    const images = logLines(rootDir, 'images.txt');
    const contexts = recordedContexts(rootDir);
    const cwds = recordedBuildCwds(rootDir);
    wipe(rootDir);

    expect(run.code, `${run.stdout}${run.stderr}`).toBe(0);

    // ITEM 7, ON THE LOCAL PATH: the context the daemon was actually pointed at, recorded by the
    // fake docker rather than asserted by the script about itself. Exactly three entries — a
    // fourth is a file uploaded to the daemon that nobody decided to send, and this run's own
    // scratch (the locked-section marker) is exactly the kind of file that would otherwise be it.
    expect(contexts, 'the local build handed the daemon an unexpected context').toEqual([
      CONTEXT_EXACT,
    ]);
    expect(cwds[0] ?? '', 'the local build did not run from inside the staged context').toMatch(
      /\/sthayi-freshtest\.[A-Za-z0-9]{8}\/context$/,
    );
    const built = docker.filter((l) => l.startsWith('build '));
    expect(built, 'the fake docker was never asked to build exactly one image').toHaveLength(1);
    const tag = /\s-t\s+(\S+)/.exec(built[0] as string)?.[1] ?? '';
    // The entropy is the mktemp suffix of the staging directory this run validated, plus the PID.
    expect(tag, 'the built tag is not run-scoped and unguessable').toMatch(
      /^sthayi-freshtest:run-\d+-[A-Za-z0-9]{8}$/,
    );
    expect(docker, 'the tag was adopted without checking it was free').toContain(
      `image inspect ${tag}`,
    );
    expect(
      docker.filter((l) => l.startsWith('image rm ')),
      "cleanup removed something other than exactly this run's own tag",
    ).toEqual([`image rm ${tag}`]);
    expect(images, 'the pre-existing image did not survive a successful run').toEqual([BYSTANDER]);
  }, 60_000);
});

/**
 * The `run:` body of the release job's fresh-install step, dedented out of the workflow. Empty when
 * the step is not there, so a rename fails the assertions instead of vacating them.
 */
function releaseFreshtestScript(text: string = workflowText()): string {
  const lines = text.split('\n');
  const nameAt = lines.findIndex((l) =>
    /^\s*- name: Fresh-install the exact release tarball/.test(l),
  );
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

const RELEASE_VERSION = '9.9.9';
const RELEASE_BYTES = 'the exact bytes SHA256SUMS covers\n';
const REPLACEMENT_BYTES = 'substituted after SHA256SUMS was verified\n';

const FAKE_MKTEMP = `#!/bin/sh
# The real allocation — plus the substitution this harness exists to model. \`mktemp -d\` is called
# AFTER the manifest was verified and BEFORE the staging copy reads the tarball, which is exactly
# the interval in which a swap is invisible to a gate that re-derives its expectation by hashing
# the source again.
d="$(PATH="$FAKE_REAL_PATH" mktemp "$@")"
if [ -n "\${FAKE_REPLACE_TARBALL:-}" ]; then
  printf '%s' "$FAKE_REPLACEMENT" > "$FAKE_REPLACE_TARBALL"
fi
# ...and the MANIFEST alongside it. A substitution that rewrites SHA256SUMS to cover the
# replacement is the case a file-derived expectation cannot survive: the pair agrees with itself.
if [ -n "\${FAKE_REPLACE_SUMS:-}" ]; then
  printf '%s' "$FAKE_REPLACEMENT_SUMS" > "$FAKE_REPLACE_SUMS"
fi
printf '%s\\n' "$d"
`;

const SHA256SUM_MJS = `import crypto from 'node:crypto';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

if (argv[0] === '-c') {
  let failed = 0;
  for (const line of fs.readFileSync(argv[1], 'utf8').split('\\n')) {
    if (line.trim() === '') continue;
    const m = /^([0-9a-f]+)[ ]{1,2}[*]?(.+)$/.exec(line);
    if (m === null) {
      process.stdout.write(\`\${line}: FAILED\\n\`);
      failed += 1;
      continue;
    }
    const ok = digest(m[2]) === m[1];
    process.stdout.write(\`\${m[2]}: \${ok ? 'OK' : 'FAILED'}\\n\`);
    if (!ok) failed += 1;
  }
  process.exit(failed === 0 ? 0 : 1);
}
for (const file of argv) {
  process.stdout.write(\`\${digest(file)}  \${file}\\n\`);
}
`;

/** A mini-runner-workspace: the downloaded artifact, its manifest, and the two staged files. */
function releaseCheckout(): string {
  const rootDir = scratchDir();
  for (const rel of ['freshtest-artifact', 'bin', 'tmp', 'home']) {
    fs.mkdirSync(path.join(rootDir, rel), { recursive: true });
  }
  const name = `sthayi-${RELEASE_VERSION}.tgz`;
  fs.writeFileSync(path.join(rootDir, 'freshtest-artifact', name), RELEASE_BYTES);
  const digest = crypto.createHash('sha256').update(RELEASE_BYTES).digest('hex');
  fs.writeFileSync(path.join(rootDir, 'freshtest-artifact', 'SHA256SUMS'), `${digest}  ${name}\n`);
  fs.writeFileSync(path.join(rootDir, 'Dockerfile.freshtest'), dockerfileText());
  fs.writeFileSync(path.join(rootDir, '.dockerignore'), dockerignoreText());
  for (const file of ['images.txt', 'docker.log', 'cmd.log', 'context.log', 'section.log']) {
    fs.writeFileSync(path.join(rootDir, file), '');
  }
  writeExec(path.join(rootDir, 'bin', 'docker'), FAKE_DOCKER);
  writeExec(path.join(rootDir, 'bin', 'mktemp'), FAKE_MKTEMP);
  fs.writeFileSync(path.join(rootDir, 'bin', 'sha256sum.mjs'), SHA256SUM_MJS);
  writeExec(
    path.join(rootDir, 'bin', 'sha256sum'),
    `#!/bin/sh\nexec ${process.execPath} "${path.join(rootDir, 'bin', 'sha256sum.mjs')}" "$@"\n`,
  );
  // The step, byte-for-byte out of the workflow.
  fs.writeFileSync(path.join(rootDir, 'step.sh'), releaseFreshtestScript());
  return rootDir;
}

/** The digest the (fake) build job published for the (fake) release artifact. */
const RELEASE_SHA = crypto.createHash('sha256').update(RELEASE_BYTES).digest('hex');
const REPLACEMENT_SHA = crypto.createHash('sha256').update(REPLACEMENT_BYTES).digest('hex');
const TARBALL_FILE = `sthayi-${RELEASE_VERSION}.tgz`;

const releaseEnv = (rootDir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv =>
  harnessEnv(rootDir, {
    VERSION: RELEASE_VERSION,
    RUNNER_TEMP: path.join(rootDir, 'tmp'),
    // The build job's output, arriving the way the workflow delivers it: through the environment,
    // not through any file this step can read.
    EXPECTED_SHA: RELEASE_SHA,
    ...extra,
  });

describePosix('the release freshtest refuses an artifact rebound to a replaced manifest', () => {
  it('the control: an untouched artifact stages, is enumerated, and is built', () => {
    // Without this, every assertion below would pass on a step that fails for any reason at all,
    // including one that never gets as far as looking at the tarball.
    const rootDir = releaseCheckout();
    const run = runSync(['-e', path.join(rootDir, 'step.sh')], rootDir, releaseEnv(rootDir));
    const docker = logLines(rootDir, 'docker.log');
    const contexts = recordedContexts(rootDir);
    const cwds = recordedBuildCwds(rootDir);
    wipe(rootDir);

    expect(run.code, `${run.stdout}${run.stderr}`).toBe(0);
    expect(
      docker.filter((l) => l.startsWith('build ')),
      'the release gate never reached the build',
    ).toHaveLength(1);
    expect(docker, 'the built image was never run').toContain('run --rm sthayi-freshtest');

    // ITEM 7, ON THE RELEASE PATH: what the daemon was pointed at, recorded from docker's side.
    expect(contexts, 'the release build handed the daemon an unexpected context').toEqual([
      CONTEXT_EXACT,
    ]);
    expect(cwds[0] ?? '', 'the release build did not run from inside the staged directory').toMatch(
      /\/sthayi-freshtest\.[A-Za-z0-9]{8}$/,
    );
  }, 60_000);

  it('a DUAL replacement of the tarball AND its manifest, before the step reads either, is refused', () => {
    // THE ATTACK A FILE-DERIVED EXPECTATION CANNOT SURVIVE. Substitute the artifact and rewrite
    // SHA256SUMS to cover the substitute: `sha256sum -c` passes, a digest parsed out of that
    // manifest is the substitute's own, and every later comparison agrees. Only an expectation
    // that never came off this disk — the build job's output — disagrees.
    const rootDir = releaseCheckout();
    fs.writeFileSync(path.join(rootDir, 'freshtest-artifact', TARBALL_FILE), REPLACEMENT_BYTES);
    fs.writeFileSync(
      path.join(rootDir, 'freshtest-artifact', 'SHA256SUMS'),
      `${REPLACEMENT_SHA}  ${TARBALL_FILE}\n`,
    );

    const run = runSync(['-e', path.join(rootDir, 'step.sh')], rootDir, releaseEnv(rootDir));
    const docker = logLines(rootDir, 'docker.log');
    wipe(rootDir);

    expect(
      run.code,
      `the gate accepted a self-consistent forgery: ${run.stdout}${run.stderr}`,
    ).not.toBe(0);
    expect(
      `${run.stdout}${run.stderr}`,
      'the failure is not the manifest being caught disagreeing with the build job',
    ).toContain('replaced together');
    expect(docker, 'the substituted tarball reached the daemon anyway').toEqual([]);
  }, 60_000);

  it('a DUAL replacement landing AFTER the manifest check, between it and the copy, is refused', () => {
    // The same forgery, timed into the window the manifest check has already left behind: both
    // files are rewritten at `mktemp` time, after the manifest was read and before the artifact is
    // staged. The manifest agrees with the substitute by then; the build job's digest still does
    // not, and the SOURCE comparison — the last look before the copy — is what catches it.
    const rootDir = releaseCheckout();
    const run = runSync(
      ['-e', path.join(rootDir, 'step.sh')],
      rootDir,
      releaseEnv(rootDir, {
        FAKE_REPLACE_TARBALL: path.join(rootDir, 'freshtest-artifact', TARBALL_FILE),
        FAKE_REPLACEMENT: REPLACEMENT_BYTES,
        FAKE_REPLACE_SUMS: path.join(rootDir, 'freshtest-artifact', 'SHA256SUMS'),
        FAKE_REPLACEMENT_SUMS: `${REPLACEMENT_SHA}  ${TARBALL_FILE}\n`,
      }),
    );
    const docker = logLines(rootDir, 'docker.log');
    wipe(rootDir);

    expect(
      run.code,
      `the gate accepted a tarball and manifest replaced after the manifest check: ${run.stdout}`,
    ).not.toBe(0);
    expect(
      `${run.stdout}${run.stderr}`,
      'the failure is not the substitution being caught',
    ).toContain('is not the artifact the build job packed');
    expect(docker, 'the substituted tarball reached the daemon anyway').toEqual([]);
  }, 60_000);

  it('an empty build-job digest fails closed rather than comparing everything to nothing', () => {
    // If the output ever goes missing — a renamed step id, a typo'd output key — every comparison
    // below it becomes `"" != ""` and the gate silently accepts anything.
    const rootDir = releaseCheckout();
    const run = runSync(
      ['-e', path.join(rootDir, 'step.sh')],
      rootDir,
      releaseEnv(rootDir, { EXPECTED_SHA: '' }),
    );
    const docker = logLines(rootDir, 'docker.log');
    wipe(rootDir);

    expect(run.code, 'a missing build-job digest was treated as an expectation').not.toBe(0);
    expect(`${run.stdout}${run.stderr}`, 'the refusal does not name the cause').toContain(
      'no usable tarball digest',
    );
    expect(docker, 'the gate built an image with nothing to pin it to').toEqual([]);
  }, 60_000);
});

function startRun(rootDir: string, env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('bash', [path.join(rootDir, 'scripts', 'freshtest.sh')], {
      cwd: rootDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout?.on('data', (chunk) => {
      out += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      err += String(chunk);
    });
    child.on('close', (code) => {
      resolve({ code: code ?? -1, stdout: out, stderr: err });
    });
  });
}

/** Resolves `true` once the file exists, `false` on timeout — never throws, so nothing leaks. */
function waitForFile(file: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const poll = (): void => {
      if (fs.existsSync(file)) {
        resolve(true);
        return;
      }
      if (Date.now() > deadline) {
        resolve(false);
        return;
      }
      setTimeout(poll, 20);
    };
    poll();
  });
}

describePosix('two overlapping runs share a checkout without corrupting each other', () => {
  it("the second run waits, and neither packs the other run's build output", async () => {
    // DETERMINISTIC OVERLAP, NOT A TIMING HOPE. Run A is not merely started first: the second run
    // is not launched until A has signalled from INSIDE its build that it is standing in the
    // critical section, and A stays there for a fixed interval afterwards. Without serialisation
    // B's build deletes and re-stamps the shared `packages/cli/dist` while A is still inside it,
    // and A's pack then finds another run's output where its own should be (fake exit 91), or
    // finds that B's postpack has removed the shared docs (exit 92).
    const rootDir = miniCheckout();
    const first = startRun(
      rootDir,
      harnessEnv(rootDir, { FAKE_RUN_ID: 'A', FAKE_BUILD_SECONDS: '3' }),
    );
    const entered = await waitForFile(path.join(rootDir, 'phase-building-A'), 30_000);
    const second = startRun(
      rootDir,
      harnessEnv(rootDir, { FAKE_RUN_ID: 'B', FAKE_BUILD_SECONDS: '0' }),
    );
    const [a, b] = await Promise.all([first, second]);
    const docker = logLines(rootDir, 'docker.log');
    const ledger = logLines(rootDir, 'section.log');
    wipe(rootDir);

    expect(entered, 'run A never signalled that it was inside its build').toBe(true);
    expect(a.code, `run A failed: ${a.stdout}${a.stderr}`).toBe(0);
    expect(b.code, `run B failed: ${b.stdout}${b.stderr}`).toBe(0);
    expect(
      `${a.stderr}${b.stderr}`,
      'one run packed build state or docs belonging to the other',
    ).not.toContain('fake npm pack:');

    // SERIALISATION, NOT LUCK, AND PROVED FROM THE LEDGER. Each run writes `enter` as it starts
    // the build and `exit` as it finishes the pack. A correctly serialised pair is strictly
    // alternating; any `enter` seen while another run is still inside is two runs in the section.
    expect(
      sectionOverlaps(ledger),
      `the critical section was entered twice: ${ledger.join(' | ')}`,
    ).toEqual([]);
    expect(ledger.filter((l) => l.startsWith('enter ')).length, 'both runs did not run').toBe(2);

    // Two runs, two unguessable tags, and each removed exactly its own.
    const built = docker
      .filter((l) => l.startsWith('build '))
      .map((l) => /\s-t\s+(\S+)/.exec(l)?.[1] ?? '');
    expect(new Set(built).size, 'the two runs shared one image tag').toBe(2);
    const removed = docker
      .filter((l) => l.startsWith('image rm '))
      .map((l) => l.slice('image rm '.length));
    expect(removed.sort(), 'a run removed a tag other than the one it built').toEqual(
      [...built].sort(),
    );

    // And nothing ever treated the other run's lock as debris to be taken over.
    expect(a.stderr + b.stderr, 'a live lock was reclaimed as if it were debris').not.toContain(
      'reclaim',
    );
  }, 120_000);
});

// ===============================================================================================
// THE LOCK, EXERCISED.
//
// Everything above about the build lock is a claim about a MECHANISM, and the two races a lock
// asserted by a PATHNAME is open to are both invisible to text: a pathname ABA (two waiters act on
// one stale name, and the second takes over a lock that has since become live), and an
// acquire→metadata gap (a winner descheduled before publishing its owner reads as debris). Neither
// can exist against a kernel lock, because the lock is held against an OPEN FILE by a live process
// and there is no owner metadata and no reclaim. These probes prove that, by running it.
// ===============================================================================================

/**
 * Ledger lines whose `enter` arrived while another run was still inside. Empty means the critical
 * section was never occupied twice.
 */
function sectionOverlaps(ledger: string[]): string[] {
  const inside = new Set<string>();
  const bad: string[] = [];
  for (const line of ledger) {
    const [verb, id] = line.split(' ');
    if (verb === 'enter') {
      if (inside.size > 0) {
        bad.push(line);
      }
      inside.add(id ?? '');
    } else if (verb === 'exit') {
      inside.delete(id ?? '');
    }
  }
  return bad;
}

interface RunHandle {
  pid: number;
  done: Promise<RunResult>;
}

/**
 * Start a run in its OWN PROCESS GROUP so a probe can kill the whole run — the script, the lock
 * tool, and the locked child — the way a machine dying takes all three. Killing only the top-level
 * shell would leave the lock holder alive and prove nothing about release.
 */
function startRunGroup(rootDir: string, env: NodeJS.ProcessEnv): RunHandle {
  const child = spawn('bash', [path.join(rootDir, 'scripts', 'freshtest.sh')], {
    cwd: rootDir,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout?.on('data', (chunk) => {
    out += String(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    err += String(chunk);
  });
  const done = new Promise<RunResult>((resolve) => {
    child.on('close', (code) => resolve({ code: code ?? -1, stdout: out, stderr: err }));
  });
  return { pid: child.pid ?? -1, done };
}

const killGroup = (pid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-pid, signal);
  } catch {
    // already gone — nothing to do
  }
};

/** The lock file's identity, as an inode string. `''` when it is not there. */
function lockIdentity(rootDir: string): string {
  const st = fs.statSync(path.join(rootDir, '.sthayi-freshtest.lock'), { throwIfNoEntry: false });
  return st === undefined ? '' : `${st.dev}:${st.ino}`;
}

/** A lock file already standing when a run arrives — what a pathname protocol would read as debris. */
function plantStaleLock(rootDir: string): string {
  const file = path.join(rootDir, '.sthayi-freshtest.lock');
  fs.writeFileSync(file, 'a lock file with no live holder\n');
  return lockIdentity(rootDir);
}

describePosix('the build lock cannot be reclaimed, stolen, or ABA-swapped', () => {
  it('two waiters arriving on a STALE lock never take it over, and never both enter', async () => {
    // THE PATHNAME ABA, RUN AGAINST THE MECHANISM. The lock file is already standing when all
    // three runs arrive — exactly the "stale" state a pathname protocol would reclaim. Under such
    // a protocol two waiters can both authorise a takeover of the NAME, and the second one's
    // rename lands on the first one's LIVE lock. Here there is nothing to take over: the
    // file is just the object the kernel lock hangs on, and the only question anyone asks is
    // whether the kernel will grant the lock.
    const rootDir = miniCheckout();
    const before = plantStaleLock(rootDir);

    const first = startRun(
      rootDir,
      harnessEnv(rootDir, { FAKE_RUN_ID: 'A', FAKE_BUILD_SECONDS: '3' }),
    );
    const entered = await waitForFile(path.join(rootDir, 'phase-building-A'), 30_000);
    // TWO waiters, not one: the ABA needs a second waiter still holding an authorisation it formed
    // before the state changed under it.
    const second = startRun(rootDir, harnessEnv(rootDir, { FAKE_RUN_ID: 'B' }));
    const third = startRun(rootDir, harnessEnv(rootDir, { FAKE_RUN_ID: 'C' }));
    const [a, b, c] = await Promise.all([first, second, third]);
    const ledger = logLines(rootDir, 'section.log');
    const after = lockIdentity(rootDir);
    const debris = fs.readdirSync(rootDir).filter((n) => n.includes('.lock'));
    wipe(rootDir);

    expect(entered, 'run A never signalled that it was inside its build').toBe(true);
    for (const [name, r] of [
      ['A', a],
      ['B', b],
      ['C', c],
    ] as const) {
      expect(r.code, `run ${name} failed: ${r.stdout}${r.stderr}`).toBe(0);
    }
    expect(
      sectionOverlaps(ledger),
      `two runs stood in the critical section together: ${ledger.join(' | ')}`,
    ).toEqual([]);
    expect(ledger.filter((l) => l.startsWith('enter ')).length, 'not all three runs ran').toBe(3);

    // THE ANTI-ABA ASSERTION ITSELF: the lock is the same OBJECT throughout. A protocol that
    // renames or replaces the lock to reclaim it changes the inode, and that is precisely how a
    // second waiter ends up acting on a lock that is no longer the one it inspected.
    expect(after, 'the lock file was replaced — a reclaim raced under the waiters').toBe(before);
    expect(debris, 'a reclaimed/renamed lock was left in the checkout').toEqual([
      '.sthayi-freshtest.lock',
    ]);
  }, 120_000);

  it('a holder that has published NOTHING about itself is still respected', async () => {
    // THE ACQUIRE→METADATA GAP. A winner that has to PUBLISH its ownership is only safe once it
    // has done so; a waiter that looks in between sees an ownerless lock and treats it as debris.
    // A kernel lock has no metadata at all — there is no window because there is nothing to
    // publish — and the holder below never writes one byte identifying itself.
    const rootDir = miniCheckout();
    const first = startRun(
      rootDir,
      harnessEnv(rootDir, { FAKE_RUN_ID: 'A', FAKE_BUILD_SECONDS: '4' }),
    );
    const entered = await waitForFile(path.join(rootDir, 'phase-building-A'), 30_000);
    const heldSize = fs.statSync(path.join(rootDir, '.sthayi-freshtest.lock')).size;
    const second = startRun(rootDir, harnessEnv(rootDir, { FAKE_RUN_ID: 'B' }));
    const [a, b] = await Promise.all([first, second]);
    const ledger = logLines(rootDir, 'section.log');
    const strays = fs
      .readdirSync(rootDir, { recursive: true })
      .map(String)
      .filter((n) => /lock.*(pid|owner|stale)|pid.*lock/i.test(n));
    wipe(rootDir);

    expect(entered, 'run A never signalled that it was inside its build').toBe(true);
    expect(a.code, `run A failed: ${a.stdout}${a.stderr}`).toBe(0);
    expect(b.code, `run B failed: ${b.stdout}${b.stderr}`).toBe(0);
    // B waited for a holder it could learn nothing about, instead of concluding "no owner ⇒ debris".
    expect(
      sectionOverlaps(ledger),
      `an ownerless holder was displaced: ${ledger.join(' | ')}`,
    ).toEqual([]);
    expect(heldSize, 'the holder wrote owner metadata into the lock — there is a gap to race').toBe(
      0,
    );
    expect(strays, 'owner metadata was written beside the lock').toEqual([]);
  }, 120_000);

  it('a run that fails before locking, and a waiter that dies waiting, disturb nothing', async () => {
    // OWNERSHIP-SAFE RELEASE. Nothing in the script releases the lock, so no run can release one it
    // does not hold — but the property worth proving is the consequence: a run that never got the
    // lock, and a run that was still queueing for it, must both be able to die without the HOLDER
    // losing anything.
    const rootDir = miniCheckout();
    const first = startRun(
      rootDir,
      harnessEnv(rootDir, { FAKE_RUN_ID: 'A', FAKE_BUILD_SECONDS: '5' }),
    );
    const entered = await waitForFile(path.join(rootDir, 'phase-building-A'), 30_000);
    const before = lockIdentity(rootDir);

    // (i) a run that aborts before it ever reaches the lock
    const rejected = runSync(
      [path.join(rootDir, 'scripts', 'freshtest.sh'), '--nope'],
      rootDir,
      harnessEnv(rootDir, { FAKE_RUN_ID: 'X' }),
    );
    // (ii) a waiter, killed while it is still queueing behind A
    const waiter = startRunGroup(rootDir, harnessEnv(rootDir, { FAKE_RUN_ID: 'W' }));
    await new Promise((r) => setTimeout(r, 500));
    killGroup(waiter.pid, 'SIGKILL');
    await waiter.done;

    const a = await first;
    const ledger = logLines(rootDir, 'section.log');
    const after = lockIdentity(rootDir);
    wipe(rootDir);

    expect(entered, 'run A never signalled that it was inside its build').toBe(true);
    expect(rejected.code, 'the bad-argument run did not abort').not.toBe(0);
    expect(a.code, `the holder was disturbed by runs that never held its lock: ${a.stderr}`).toBe(
      0,
    );
    expect(after, "a run that never held the lock replaced the holder's lock file").toBe(before);
    expect(
      sectionOverlaps(ledger),
      `something entered the section beside the holder: ${ledger.join(' | ')}`,
    ).toEqual([]);
    // The killed waiter never entered, so it never wrote an `enter`.
    expect(
      ledger.map((l) => l.split(' ')[1]),
      'a killed waiter got into the section',
    ).not.toContain('W');
  }, 120_000);
});

describePosix(
  'the build lock survives a crash, and refuses to run without a kernel to hold it',
  () => {
    it('a run killed INSIDE the section leaves the lock free — the kernel released it', async () => {
      // CRASH RECOVERY, WHICH IS THE ONLY REASON A RECLAIM WOULD EXIST. A `mkdir` lock outlives its
      // holder, so something has to decide the holder is gone and delete it — and that decision is
      // the ABA. A kernel lock has no such problem: it is attached to an open file
      // description, and the kernel drops it when the last holder exits, SIGKILL included. The whole
      // process GROUP is killed here, so the lock tool and the locked child die with the script.
      const rootDir = miniCheckout();
      const victim = startRunGroup(
        rootDir,
        harnessEnv(rootDir, { FAKE_RUN_ID: 'A', FAKE_BUILD_SECONDS: '30' }),
      );
      const entered = await waitForFile(path.join(rootDir, 'phase-building-A'), 30_000);
      killGroup(victim.pid, 'SIGKILL');
      await victim.done;
      const beforeLock = lockIdentity(rootDir);

      const startedAt = Date.now();
      const next = await startRun(rootDir, harnessEnv(rootDir, { FAKE_RUN_ID: 'B' }));
      const elapsedMs = Date.now() - startedAt;
      const afterLock = lockIdentity(rootDir);
      const ledger = logLines(rootDir, 'section.log');
      wipe(rootDir);

      expect(entered, 'the victim never reached the critical section').toBe(true);
      expect(next.code, `the follow-up run failed: ${next.stdout}${next.stderr}`).toBe(0);
      // If the lock were NOT released by the kernel, this run would sit out the whole bounded wait.
      expect(elapsedMs, 'the follow-up run had to wait for a dead holder to time out').toBeLessThan(
        60_000,
      );
      // ...and it got in WITHOUT anything having to declare the dead holder stale and delete its lock.
      expect(
        next.stderr,
        'the follow-up run reclaimed the lock instead of just taking it',
      ).not.toMatch(/reclaim|stale/i);
      expect(afterLock, 'the lock file was replaced to get past a dead holder').toBe(beforeLock);
      expect(
        ledger.filter((l) => l === 'enter B'),
        'the follow-up run never entered',
      ).toHaveLength(1);
    }, 180_000);

    it('a machine with neither flock nor lockf FAILS CLOSED and builds nothing', () => {
      // The one outcome worse than not building is building unserialised: the damage lands on the
      // OTHER run, which never asked for anything. So a missing lock tool is a refusal, with both
      // tool names in the message, and nothing is packed or built.
      const rootDir = miniCheckout();
      // THE PATH IS STRIPPED OF EXACTLY ONE THING: the lock tools. Everything else the script needs
      // is shimmed straight back in, so a run that DID proceed would proceed all the way to a
      // successful build — which is what makes this probe load-bearing rather than a run that dies
      // of a missing `mktemp` and looks like a refusal.
      for (const name of [
        'bash',
        'cat',
        'cp',
        'dirname',
        'env',
        'ls',
        'mkdir',
        'mktemp',
        'mv',
        'rm',
        'sleep',
        'sort',
        'tr',
      ]) {
        writeExec(
          path.join(rootDir, 'bin', name),
          `#!/bin/sh\nfor d in /bin /usr/bin /usr/local/bin /opt/homebrew/bin; do\n  if [ -x "$d/${name}" ]; then exec "$d/${name}" "$@"; fi\ndone\nexit 127\n`,
        );
      }
      const run = runSyncAbsoluteShell(
        freshtestScript(rootDir),
        rootDir,
        harnessEnv(rootDir, { FAKE_RUN_ID: 'A', PATH: path.join(rootDir, 'bin') }),
      );
      const docker = logLines(rootDir, 'docker.log');
      const cmds = logLines(rootDir, 'cmd.log');
      wipe(rootDir);

      expect(run.code, `the gate ran unserialised: ${run.stdout}`).not.toBe(0);
      expect(run.stderr, 'the refusal does not name flock').toContain('flock');
      expect(run.stderr, 'the refusal does not name lockf').toContain('lockf');
      expect(run.stderr, 'the refusal does not say what it refused to do').toMatch(
        /serialis|lock/i,
      );
      expect(cmds, 'the build+pack section ran without a lock').toEqual([]);
      expect(
        docker.filter((l) => l.startsWith('build ')),
        'an image was built without the section being serialised',
      ).toEqual([]);
    }, 60_000);
  },
);

/**
 * A `mktemp` that allocates for real and then RETARGETS the symlink the allocation was reached
 * through — planting an unrelated directory of the same name in the new target first. That is the
 * whole TMPDIR-parent hazard in one command: everything the run does with its path afterwards,
 * above all the cleanup, resolves somewhere it has never been.
 */
const FAKE_RETARGETING_MKTEMP = `#!/bin/sh
d="$(PATH="$FAKE_REAL_PATH" mktemp "$@")"
printf '%s\\n' "$d" >> "$FAKE_ALLOC_LOG"
base="\${d##*/}"
mkdir -p "$FAKE_RETARGET_TO/$base"
printf 'a directory this run has never heard of\\n' > "$FAKE_RETARGET_TO/$base/SENTINEL"
rm -f "$FAKE_RETARGET_LINK"
ln -s "$FAKE_RETARGET_TO" "$FAKE_RETARGET_LINK"
printf '%s\\n' "$d"
`;

describePosix('a retargeted TMPDIR symlink cannot redirect the run directory cleanup', () => {
  it('cleans the CANONICAL path it created, leaving an unrelated same-named directory intact', () => {
    // THE SHAPE. TMPDIR is a symlink. The run allocates through it, and while the run is working
    // the link is repointed at a different tree that happens to hold a directory of the same name.
    // A gate that kept the link in its pathname then hands `rm -rf` a path that now resolves into
    // that other tree — and deletes a stranger's directory instead of its own. Resolving the
    // parent to its physical path BEFORE the allocation is what makes the path unmovable.
    const rootDir = miniCheckout();
    const realA = path.join(rootDir, 'tmp-a');
    const realB = path.join(rootDir, 'tmp-b');
    const link = path.join(rootDir, 'tmp-link');
    fs.mkdirSync(realA);
    fs.mkdirSync(realB);
    fs.symlinkSync(realA, link);
    writeExec(path.join(rootDir, 'bin', 'mktemp'), FAKE_RETARGETING_MKTEMP);
    fs.writeFileSync(path.join(rootDir, 'alloc.log'), '');

    const run = runSync(
      freshtestScript(rootDir),
      rootDir,
      harnessEnv(rootDir, {
        FAKE_RUN_ID: 'A',
        TMPDIR: link,
        FAKE_ALLOC_LOG: path.join(rootDir, 'alloc.log'),
        FAKE_RETARGET_LINK: link,
        FAKE_RETARGET_TO: realB,
      }),
    );
    const allocated = logLines(rootDir, 'alloc.log');
    const base = path.basename(allocated[0] ?? '');
    const sentinel = path.join(realB, base, 'SENTINEL');
    const sentinelSurvived = base !== '' && fs.existsSync(sentinel);
    const ownDirGone = base !== '' && !fs.existsSync(path.join(realA, base));
    const allocatedUnderA = (allocated[0] ?? '').startsWith(`${realA}/`);
    wipe(rootDir);

    expect(base, 'the harness never saw an allocation').not.toBe('');
    // THE ASSERTION THIS PROBE EXISTS FOR — checked FIRST, so a regression is reported as the
    // stranger's directory being destroyed rather than as some earlier symptom of it.
    expect(
      sentinelSurvived,
      'cleanup followed the retargeted symlink and deleted an unrelated directory of the same name',
    ).toBe(true);
    expect(run.code, `${run.stdout}${run.stderr}`).toBe(0);
    // The allocation was made in the RESOLVED parent, so the symlink is not in the path at all.
    expect(allocatedUnderA, `the run allocated through the symlink: ${allocated[0]}`).toBe(true);
    // ...and it did still clean up after itself.
    expect(ownDirGone, "the run's own staging directory was left behind").toBe(true);
  }, 60_000);
});

/**
 * A PATHNAME IS NOT AN OBJECT.
 *
 * `cleanup` is armed with `ctx`, a pathname, and the guards it applies — non-empty, not a symlink,
 * is a directory — all ask about whatever is standing at that name when they look. None of them
 * asks whether it is the SAME directory the run allocated.
 *
 * A same-uid peer needs no privilege to exploit that: rename this run's validated leaf aside, then
 * `mkdir` an ordinary directory at the canonical path it vacated. The replacement is a real
 * directory and not a link, so every name-shaped guard passes and `rm -rf` destroys a tree this run
 * never created — while the run's own scratch survives, unreferenced, under its new name.
 *
 * These run the REAL `dir_identity` and the REAL `cleanup` body sliced out of `scripts/freshtest.sh`,
 * so deleting the identity check from the script turns them red rather than leaving them green
 * against a copy that still has it.
 */
describePosix(
  'freshtest cleanup removes the directory it allocated, not the name it remembers',
  () => {
    /** The real helper and the real cleanup body, wired to a caller-supplied allocation. */
    const harness = (root: string, body: string): string =>
      [
        'set -u',
        shellFunction('dir_identity'),
        'image_created=0',
        'image_tag=""',
        'ctx=""',
        'ctx_identity=""',
        cleanupBody(),
        `PARENT=${JSON.stringify(root)}`,
        'ctx="$(mktemp -d "$PARENT/sthayi-freshtest.XXXXXXXX")"',
        'ctx_identity="$(dir_identity "$ctx" || printf %s "")"',
        'printf %s\\\\n run-owned > "$ctx/owned-file"',
        body,
        'cleanup',
        'printf %s\\\\n "CTX=$ctx"',
      ].join('\n');

    it('the real helper reports a per-directory identity on this host', () => {
      const root = scratchDir();
      const probe = [
        'set -u',
        shellFunction('dir_identity'),
        `cd ${JSON.stringify(root)}`,
        'mkdir a b',
        'printf %s\\\\n "A=$(dir_identity a)" "B=$(dir_identity b)"',
      ].join('\n');
      const r = runSync(['-c', probe], root, process.env);
      const a = /A=(.*)/.exec(r.stdout)?.[1] ?? '';
      const b = /B=(.*)/.exec(r.stdout)?.[1] ?? '';
      wipe(root);
      // Both well-formed AND different. A probe order that answered with FILESYSTEM stats would give
      // one identical value for every directory on the mount, and could never see a substitution.
      expect(a, `dir_identity produced no usable identity: ${r.stderr}`).toMatch(/^[0-9]+:[0-9]+$/);
      expect(b).toMatch(/^[0-9]+:[0-9]+$/);
      expect(a, 'dir_identity cannot tell two directories apart').not.toBe(b);
    });

    it('a REAL directory substituted at the staging path is NOT deleted', () => {
      const root = scratchDir();
      const program = harness(
        root,
        [
          // The exact hostile control: rename the validated leaf aside, then stand a different real
          // directory at the canonical path it left behind.
          'mv "$ctx" "$PARENT/original-aside"',
          'mkdir "$ctx"',
          'printf %s\\\\n stranger > "$ctx/stranger-file"',
        ].join('\n'),
      );
      const r = runSync(['-c', program], root, process.env);
      const ctx = /CTX=(.*)/.exec(r.stdout)?.[1] ?? '';
      const replacementSurvived = ctx !== '' && fs.existsSync(path.join(ctx, 'stranger-file'));
      const asideSurvived = fs.existsSync(path.join(root, 'original-aside', 'owned-file'));
      wipe(root);

      expect(ctx, 'the harness never allocated a staging directory').not.toBe('');
      expect(
        replacementSurvived,
        'cleanup recursively deleted a directory this run never created',
      ).toBe(true);
      // The run-owned tree is leaked under its new name, and that is the intended trade: a stale
      // temp directory is recoverable, a deleted stranger is not.
      expect(asideSurvived, "the run's own tree should be leaked aside, not destroyed").toBe(true);
    });

    it('an UNCHANGED run-owned staging directory is still removed', () => {
      const root = scratchDir();
      const r = runSync(['-c', harness(root, ':')], root, process.env);
      const ctx = /CTX=(.*)/.exec(r.stdout)?.[1] ?? '';
      const stillThere = ctx !== '' && fs.existsSync(ctx);
      wipe(root);

      expect(ctx, 'the harness never allocated a staging directory').not.toBe('');
      expect(stillThere, 'the ordinary successful cleanup stopped removing its own directory').toBe(
        false,
      );
    });

    it('a staging path replaced by a SYMLINK is not followed', () => {
      const root = scratchDir();
      const program = harness(
        root,
        [
          'mkdir "$PARENT/elsewhere"',
          'printf %s\\\\n foreign > "$PARENT/elsewhere/foreign-file"',
          'mv "$ctx" "$PARENT/original-aside"',
          'ln -s "$PARENT/elsewhere" "$ctx"',
        ].join('\n'),
      );
      const r = runSync(['-c', program], root, process.env);
      const foreignSurvived = fs.existsSync(path.join(root, 'elsewhere', 'foreign-file'));
      wipe(root);
      expect(foreignSurvived, 'cleanup followed a symlink standing at the staging path').toBe(true);
    });

    it('the identity check is in the shipped cleanup, not only in this test', () => {
      const body = cleanupBody();
      expect(body, 'no cleanup body found').not.toBe('');
      // The recursive delete must be reached only through an identity comparison.
      expect(body).toMatch(/dir_identity/);
      expect(body).toMatch(/ctx_identity/);
      expect(shellFunction('dir_identity'), 'the identity helper is gone').not.toBe('');
      // And the script must capture it before the trap is allowed to name the path.
      const text = scriptText();
      expect(text.indexOf('ctx_identity="$candidate_identity"')).toBeGreaterThan(-1);
      expect(text.indexOf('ctx_identity="$candidate_identity"')).toBeLessThan(
        text.indexOf('ctx="$candidate"'),
      );
    });
  },
);
