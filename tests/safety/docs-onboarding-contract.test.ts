import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * SAFETY: every published onboarding instruction must run as typed, in the shell it is written for,
 * and must not claim a property the machine does not have.
 *
 * THE INSTALL CONTRACT. Once supported Node.js 22 or 24 and npm are available, "No admin rights for the Sthayi
 * user-space install" is a binding promise, so the published line has to satisfy it on EVERY
 * machine rather than on the lucky ones. Installing Node.js is a separate prerequisite and may
 * require administrator approval. A bare `npm install -g sthayi` needs npm's default global prefix
 * to be writable by the invoking account; where that prefix is root-owned the line fails `EACCES`,
 * and the only shorter fix is `sudo`. The canonical line therefore redirects this one install into
 * a directory the user already owns:
 *
 *     npm install -g --prefix "$HOME/.local" sthayi && "$HOME/.local/bin/sthayi" init
 *
 * `--prefix` is a PER-INVOCATION FLAG. It mutates no npm configuration and writes no `~/.npmrc`, so
 * a reader's other npm commands are unaffected — and because that prefix adds nothing to PATH, the
 * second half of the line has to invoke `init` by the path the first half actually produced.
 *
 * `npx sthayi init` is REFUSED: `npx` runs the CLI out of npm's download cache, and `init` will not
 * pin a launcher at an entry that disappears when that cache is pruned.
 *
 * TWO DIRECTORIES, NOT ONE. The package lands under the prefix
 * (`~/.local/lib/node_modules/sthayi`); the user's memory lives in `~/.sthayi/`. An uninstall
 * removes the first and must leave the second standing, so no doc may describe either as holding
 * "everything".
 *
 * SHELLS ARE NOT INTERCHANGEABLE. `$HOME`, `$env:LOCALAPPDATA` and `%LOCALAPPDATA%` belong to three
 * different shells, and PowerShell 5.1 has no `&&`. A block that mixes two of them cannot run as
 * typed in either, so each command block is written for exactly one shell and says which.
 *
 * WINDOWS VALIDATION IS BOUNDED. The v0.1.0 packed artifact was exercised on one Windows 11 Pro
 * 24H2 x64 host under Node 22.23.2 and a standard non-administrator account, using Windows
 * PowerShell 5.1, PowerShell 7.6.4 and cmd. That evidence may be stated, but it must not be widened
 * to every Windows version, architecture or Node release. Packed-tarball evidence does not prove
 * registry delivery, so fetching by package name remains a separate pre-announcement release gate.
 *
 * Plus one accuracy rule with a privacy edge: `search` is NOT read-only. It journals a
 * `memory_retrieve`, bumps recency and updates the association graph (spec §4: `memory_search` is
 * `readOnlyHint: false`). Calling it read-only tells a reader their queries leave no trace.
 *
 * Nothing here spawns a process or writes to the filesystem.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Every published surface that carries onboarding text. */
const ONBOARDING_DOCS = [
  'README.md',
  'SECURITY.md',
  'docs/RELEASE.md',
  'docs/sthayi-v0-spec.md',
  'demo.tape',
] as const;

const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

/** Markdown hard-wraps, so a claim routinely straddles a newline. Judge the flattened text. */
const flat = (rel: string): string => read(rel).replace(/\s+/g, ' ');

/** The one line the docs publish: a user-space prefix, then the binary that prefix produced. */
const QUICKSTART =
  'npm install -g --prefix "$HOME/.local" sthayi && "$HOME/.local/bin/sthayi" init';

/** The shorter line, which is NOT universally admin-free. `-g` followed immediately by the name. */
const BARE_GLOBAL = /npm install -g sthayi\b/g;

/** What makes a mention of the bare line honest rather than a headline. */
const GLOBAL_QUALIFIER =
  /EACCES|root-owned|can already write|already write it|writable global prefix|not[^.]{0,60}universally/i;

/** A demo can have a runtime; onboarding cannot promise that an arbitrary machine finishes in it. */
const FIXED_SETUP_TIME_CLAIM =
  /(?:\b(?:setup|onboarding|install(?:ation)?|quickstart)[^.]{0,100}\b(?:in|within|under|takes?)\s+(?:\d+|one|two|three|five|ten|thirty|sixty)\s*(?:seconds?|minutes?)\b)|(?:\b(?:\d+|one|two|three|five|ten|thirty|sixty)\s*(?:seconds?|minutes?)\b[^.]{0,100}\b(?:to (?:running|run|install|wire)|setup|onboarding)\b)/i;

const section = (text: string, heading: string): string => {
  const start = text.indexOf(heading);
  expect(start, `${heading} is missing`).toBeGreaterThan(-1);
  const end = text.indexOf('\n## ', start + 1);
  return text.slice(start, end === -1 ? undefined : end);
};

/** Every fenced code block in a markdown file, with its info string. */
function fencedBlocks(text: string): { lang: string; body: string }[] {
  const out: { lang: string; body: string }[] = [];
  const re = /```([^\n]*)\n([\s\S]*?)```/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    out.push({ lang: (m[1] ?? '').trim(), body: m[2] ?? '' });
  }
  return out;
}

describe('safety: the published quickstart is the one line that actually works', () => {
  it('README, SECURITY, the release checklist and the spec all carry the same line', () => {
    for (const rel of ['README.md', 'SECURITY.md', 'docs/RELEASE.md', 'docs/sthayi-v0-spec.md']) {
      expect(flat(rel), `${rel} does not carry the canonical quickstart line`).toContain(
        QUICKSTART,
      );
    }
  });

  it('the README headline install is that line, after its prerequisite checks', () => {
    const quickstart = section(read('README.md'), '## Quickstart');
    const blocks = fencedBlocks(quickstart);
    const prerequisite = blocks.findIndex(({ body }) => /node --version/.test(body));
    const install = blocks.findIndex(({ body }) => body.includes(QUICKSTART));
    expect(prerequisite, 'the Quickstart has no Node/npm prerequisite check').toBeGreaterThan(-1);
    expect(install, 'the Quickstart has no user-space install block').toBeGreaterThan(-1);
    expect(prerequisite, 'the prerequisite check must appear before the install').toBeLessThan(
      install,
    );
    const headline = blocks[install];
    const body = (headline as { body: string }).body;
    expect(body, 'the headline block is not the user-space install line').toContain(QUICKSTART);
    expect(
      BARE_GLOBAL.test(body),
      'the headline block offers `npm install -g sthayi`, which needs a writable global prefix',
    ).toBe(false);
    BARE_GLOBAL.lastIndex = 0;
    // The headline block is one shell's, and says so.
    expect(`${(headline as { lang: string }).lang} ${body}`).toMatch(/bash|zsh/i);
  });

  it('every human onboarding doc states the runtime prerequisite and admin boundary', () => {
    for (const rel of ['README.md', 'SECURITY.md', 'docs/RELEASE.md', 'docs/sthayi-v0-spec.md']) {
      const text = flat(rel);
      expect(text, `${rel} omits supported Node.js 22/24 and npm as prerequisites`).toMatch(
        /Node\.js 22 and 24[^.]{0,80}(?:requires|and requires) npm/i,
      );
      expect(text, `${rel} hides that installing Node.js may need administrator approval`).toMatch(
        /Installing Node\.js[^.]{0,140}may require administrator approval/i,
      );
      expect(text, `${rel} does not condition the Sthayi admin promise on Node.js and npm`).toMatch(
        /(?:once Node\.js and npm are available[^.]{0,180}(?:no admin rights|neither[^.]{0,40}administrator rights|entirely in user space)|no admin rights[^.]{0,100}Sthayi[^.]{0,100}once Node\.js and npm are available)/i,
      );
    }
  });

  it('no doc presents a bare `npm install -g sthayi` as universally admin-free', () => {
    for (const rel of ONBOARDING_DOCS) {
      const text = flat(rel);
      BARE_GLOBAL.lastIndex = 0;
      for (let m = BARE_GLOBAL.exec(text); m !== null; m = BARE_GLOBAL.exec(text)) {
        const window = text.slice(Math.max(0, m.index - 420), m.index + 260);
        expect(
          GLOBAL_QUALIFIER.test(window),
          `${rel} names \`npm install -g sthayi\` without saying it needs a writable global ` +
            `prefix: ${window.slice(0, 200)}`,
        ).toBe(true);
      }
    }
  });

  it('every doc discloses that --prefix does not mutate npm config', () => {
    for (const rel of ['README.md', 'SECURITY.md', 'docs/RELEASE.md', 'docs/sthayi-v0-spec.md']) {
      const text = flat(rel);
      expect(text, `${rel} does not call --prefix a per-invocation flag`).toMatch(
        /per-invocation/i,
      );
      expect(text, `${rel} does not say no \`~/.npmrc\` is written`).toMatch(/npmrc/);
    }
  });

  it('published onboarding makes no fixed setup-time promise', () => {
    for (const rel of ONBOARDING_DOCS) {
      expect(
        flat(rel),
        `${rel} promises a fixed setup time that cannot hold across arbitrary machines`,
      ).not.toMatch(FIXED_SETUP_TIME_CLAIM);
    }
  });

  it('the spec promises one copy-paste line and bounds the admin claim to Sthayi', () => {
    const spec = flat('docs/sthayi-v0-spec.md');
    expect(spec).toMatch(/one copy-paste line/i);
    expect(spec).toMatch(/Node\.js 22 and 24[^.]{0,80}(?:requires|and requires) npm/i);
    expect(spec).toMatch(
      /Once those prerequisites are available, installing Sthayi[^.]{0,100}no admin rights/i,
    );
    expect(spec).toMatch(
      /installing Node\.js itself is separate[^.]{0,100}may require administrator approval/i,
    );
  });

  it('no doc issues `npx sthayi init` as an instruction', () => {
    for (const rel of ONBOARDING_DOCS) {
      const text = flat(rel);
      let from = 0;
      for (;;) {
        const found = text.slice(from).search(/npx\s+sthayi\s+init/);
        if (found === -1) {
          break;
        }
        const start = from + found;
        // Markdown hard-wraps, so "is refused" routinely lands on the next source line: judge a
        // flattened window around the mention, not the line it happens to start on.
        const window = text.slice(Math.max(0, start - 120), start + 160);
        expect(
          /refus|reject|never|\bnot\b|instead/i.test(window),
          `${rel} tells a reader to run a command the CLI refuses: ${window}`,
        ).toBe(true);
        from = start + 1;
      }
    }
  });

  it('demo.tape records the durable install, not an npx run', () => {
    const tape = read('demo.tape');
    // VHS strings may be double- or single-quoted; the canonical line contains double quotes, so
    // the tape necessarily uses the single-quoted form for it.
    const typed = tape.split('\n').filter((l) => /^Type\s+["']/.test(l));
    expect(typed.some((l) => l.includes(QUICKSTART))).toBe(true);
    for (const line of typed) {
      expect(/npx\s+sthayi/.test(line), `demo.tape types an npx run: ${line}`).toBe(false);
    }
  });
});

describe('safety: every bootstrap command runs as typed', () => {
  /**
   * `npm config set prefix ~/.local` MUTATES the user's npm configuration, which the contract above
   * does not do. If a doc ever offers it anyway, it still has to name the binary by the path it
   * actually lands at, within the same sentence — a bare `sthayi init` afterwards is a command not
   * found.
   */
  it('the ~/.local prefix route invokes init by its real path', () => {
    for (const rel of ONBOARDING_DOCS) {
      const text = flat(rel);
      let from = 0;
      for (;;) {
        const at = text.indexOf('npm config set prefix ~/.local', from);
        if (at === -1) {
          break;
        }
        const window = text.slice(at, at + 220);
        expect(
          window.includes('~/.local/bin/sthayi'),
          `${rel} offers the ~/.local prefix route without naming ~/.local/bin/sthayi — ` +
            `a bare \`sthayi init\` does not run after it: ${window.slice(0, 160)}`,
        ).toBe(true);
        from = at + 1;
      }
    }
  });

  /**
   * The `--prefix` install adds NOTHING to PATH: npm writes its shim at `<prefix>/bin/sthayi` and
   * no shell profile is touched. Every occurrence of the install half must therefore be followed by
   * an invocation that names a real path — and the only path an install is entitled to name is the
   * shim IT just wrote.
   *
   * THE STATE DIRECTORY'S LAUNCHER IS NOT THAT PATH. It is pinned at whatever entry it was last
   * written from, and an install at a prefix the launcher was not written from is exactly the case
   * where that pin is stale — so "install here, then run `~/.sthayi/bin/sthayi`" sends a reader to
   * the one binary their own install just stranded.
   */
  it('the user-space prefix install is followed by the shim that install writes', () => {
    for (const rel of ONBOARDING_DOCS) {
      const text = flat(rel);
      let from = 0;
      for (;;) {
        const at = text.indexOf('npm install -g --prefix "$HOME/.local" sthayi', from);
        if (at === -1) {
          break;
        }
        const window = text.slice(at, at + 240);
        const isUpgrade = /sthayi@latest/.test(window.slice(0, 60));
        expect(
          isUpgrade || window.includes('"$HOME/.local/bin/sthayi"'),
          `${rel} installs into the user-space prefix and then names no path the CLI is ` +
            `reachable by — that prefix is not on PATH: ${window.slice(0, 180)}`,
        ).toBe(true);
        from = at + 1;
      }
    }
  });

  /**
   * A plain local install puts the binary in `node_modules/.bin`, and nothing on PATH. The command
   * that follows must therefore name that path — for a first install AND for an upgrade. The
   * state directory's launcher is not a substitute for it: it carries a pathname, so an install
   * that lands anywhere the launcher was not written from leaves it pinned at an entry that has
   * moved. A bare `sthayi` is the other form that does not run.
   */
  it('the plain local-install route invokes the CLI by the path that install produces', () => {
    for (const rel of ONBOARDING_DOCS) {
      const text = flat(rel);
      let from = 0;
      for (;;) {
        const found = text.slice(from).search(/npm i(?:nstall)? sthayi(?:@\S+)?\b(?! -g)/);
        if (found === -1) {
          break;
        }
        const start = from + found;
        const window = text.slice(start, start + 220);
        expect(
          window.includes('node_modules/.bin/sthayi'),
          `${rel} offers a plain local install and then names no path the CLI is reachable by — ` +
            `a bare \`sthayi\` does not run after it: ${window.slice(0, 160)}`,
        ).toBe(true);
        from = start + 1;
      }
    }
  });

  it('no doc ever instructs sudo', () => {
    for (const rel of ONBOARDING_DOCS) {
      const text = flat(rel);
      let from = 0;
      for (;;) {
        const found = text.slice(from).search(/\bsudo\b/);
        if (found === -1) {
          break;
        }
        const start = from + found;
        // "needs no sudo" / "needs neither sudo nor admin" is the property being claimed, not an
        // instruction — and the negation is frequently on the previous source line, so flatten.
        const window = text.slice(Math.max(0, start - 120), start + 60);
        expect(
          /\b(no|not|never|without|none|neither)\b/i.test(window),
          `${rel} instructs sudo: ${window}`,
        ).toBe(true);
        from = start + 1;
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------
// One shell per block. A mixed block runs as typed in NO shell.
// ---------------------------------------------------------------------------------------------

/** The three families, by the token only that shell understands. */
const SHELL_FAMILY: readonly { name: string; re: RegExp }[] = [
  { name: 'posix', re: /\$HOME\b/ },
  { name: 'powershell', re: /\$env:/ },
  { name: 'cmd', re: /%[A-Z_]+%/ },
];

/** How a block declares which shell it is for: the fence info string or its first comment line. */
function declaredShell(lang: string, body: string): string | undefined {
  const head = `${lang}\n${body.split('\n').slice(0, 2).join('\n')}`;
  if (/powershell\s*5\.1|windows powershell 5\.1/i.test(head)) {
    return 'ps5';
  }
  if (/powershell\s*7/i.test(head)) {
    return 'ps7';
  }
  if (/(^|\W)cmd(\W|$)|^bat$/im.test(head)) {
    return 'cmd';
  }
  if (/bash|zsh|sh$/im.test(head)) {
    return 'posix';
  }
  return undefined;
}

describe('safety: no command block mixes two shells', () => {
  it('every fenced block uses exactly one shell family', () => {
    for (const rel of ['README.md', 'SECURITY.md', 'docs/RELEASE.md', 'docs/sthayi-v0-spec.md']) {
      for (const { lang, body } of fencedBlocks(read(rel))) {
        const families = SHELL_FAMILY.filter(({ re }) => re.test(body)).map(({ name }) => name);
        expect(
          families.length <= 1,
          `${rel} has a block mixing ${families.join(' + ')} syntax, which runs as typed in ` +
            `neither shell: ${body.slice(0, 160)}`,
        ).toBe(true);
      }
    }
  });

  it('every block carrying Windows syntax names the shell it is for', () => {
    for (const rel of ['README.md', 'SECURITY.md', 'docs/RELEASE.md', 'docs/sthayi-v0-spec.md']) {
      for (const { lang, body } of fencedBlocks(read(rel))) {
        if (!/\$env:|%[A-Z_]+%/.test(body)) {
          continue;
        }
        const shell = declaredShell(lang, body);
        expect(
          shell === 'ps5' || shell === 'ps7' || shell === 'cmd',
          `${rel} has a Windows command block that does not name its shell: ${body.slice(0, 160)}`,
        ).toBe(true);
      }
    }
  });

  it('a PowerShell 5.1 install block never uses `&&` and gates init on success', () => {
    for (const rel of ['README.md', 'SECURITY.md', 'docs/RELEASE.md', 'docs/sthayi-v0-spec.md']) {
      for (const { lang, body } of fencedBlocks(read(rel))) {
        if (
          declaredShell(lang, body) !== 'ps5' ||
          !/npm install/.test(body) ||
          !/\binit\b/.test(body)
        ) {
          continue;
        }
        expect(
          body.includes('&&'),
          `${rel} gives a PowerShell 5.1 block an \`&&\`: ${body.slice(0, 160)}`,
        ).toBe(false);
        // `;` is the separator 5.1 has — and it sequences UNCONDITIONALLY, so the block must carry
        // the gate `&&` would have provided. BOTH HALVES OF IT, in one condition:
        //
        //   - `$LASTEXITCODE` is written only by a NATIVE command that actually ran. An `npm` that
        //     could not be resolved at all never writes it, so an exit-code-only gate reads a stale
        //     zero from some earlier command and runs `init` after an install that never happened;
        //   - `$?` carries the immediately preceding statement's success, including that resolution
        //     failure — and it is clobbered by the very next statement, so it has to be captured
        //     into a variable before the `if` and tested through that variable.
        //
        // The backreference is what ties the two together: the name the success state was captured
        // into must be the name the condition tests.
        expect(
          body,
          `${rel}'s PowerShell 5.1 block does not gate init on BOTH the install's captured success state and its exit code`,
        ).toMatch(
          /;\s*\$(\w+)\s*=\s*\$\?\s*;\s*if\s*\(\s*\$\1\s+-and\s+\$LASTEXITCODE\s+-eq\s+0\s*\)\s*\{\s*&/,
        );
      }
    }
  });

  it('the README publishes all three Windows forms, each in its own block', () => {
    const blocks = fencedBlocks(read('README.md'));
    const shells = blocks
      .filter(({ body }) => /\$env:|%[A-Z_]+%/.test(body))
      .map(({ lang, body }) => declaredShell(lang, body));
    for (const want of ['ps7', 'ps5', 'cmd']) {
      expect(shells, `README.md has no ${want} Windows install block`).toContain(want);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The package prefix and state directory are distinct, and Windows evidence stays host-bounded.
// ---------------------------------------------------------------------------------------------

describe('safety: the docs state only properties the machine actually has', () => {
  it('no doc claims everything lives under ~/.sthayi — the package lives in the prefix', () => {
    for (const rel of ONBOARDING_DOCS) {
      const text = flat(rel);
      expect(
        /everything[^.]{0,40}under[^.]{0,20}`?~\/\.sthayi/i.test(text),
        `${rel} says everything lives under ~/.sthayi; the package lives in the install prefix`,
      ).toBe(false);
    }
  });

  it('the release checklist names the package prefix as well as the state directory', () => {
    const text = flat('docs/RELEASE.md');
    expect(text).toContain('~/.local/lib/node_modules/sthayi');
    expect(text).toContain('~/.sthayi/');
  });

  it('the uninstall step list removes the package from the prefix, after doctor and unwire', () => {
    const uninstall = section(read('README.md'), '## Upgrade & uninstall');
    const from = uninstall.indexOf('**Uninstalling');
    expect(from).toBeGreaterThan(-1);
    const open = uninstall.indexOf('```bash', from);
    expect(open).toBeGreaterThan(-1);
    const steps = uninstall.slice(open, uninstall.indexOf('```', open + 7));

    const doctorIdx = steps.indexOf('sthayi doctor');
    const unwireIdx = steps.indexOf('sthayi unwire');
    const removeIdx = steps.indexOf('npm uninstall -g --prefix "$HOME/.local" sthayi');
    expect(doctorIdx, 'the uninstall block does not run doctor').toBeGreaterThan(-1);
    expect(unwireIdx, 'the uninstall block does not run unwire').toBeGreaterThan(-1);
    expect(
      removeIdx,
      'the uninstall block does not remove the package from the prefix',
    ).toBeGreaterThan(-1);
    expect(doctorIdx).toBeLessThan(removeIdx);
    expect(unwireIdx).toBeLessThan(removeIdx);
    // …and the memory is stated to survive it. The uninstall removes code, never memory.
    const after = uninstall.slice(uninstall.indexOf('```', open + 7));
    expect(after.replace(/\s+/g, ' ')).toMatch(/does not touch `?~\/\.sthayi/i);
  });

  it('every Windows validation summary states the tested host boundary and registry gap', () => {
    for (const rel of ['README.md', 'SECURITY.md', 'docs/RELEASE.md', 'docs/sthayi-v0-spec.md']) {
      const text = flat(rel);
      expect(text, `${rel} does not pin validation to the tested Windows host`).toContain(
        'Windows 11 Pro 24H2 x64',
      );
      expect(text, `${rel} does not pin validation to the tested Node release`).toContain(
        'Node 22.23.2',
      );
      expect(text, `${rel} does not pin validation to a standard non-admin account`).toMatch(
        /standard\s*(?:\(non-administrator\)|non-administrator)\s+account/i,
      );
      expect(text, `${rel} does not scope the evidence to v0.1.0`).toContain('v0.1.0');
      expect(text, `${rel} does not identify the checksum-verified packed artifact`).toMatch(
        /checksum-verified packed(?: v0\.1\.0)? tarball/i,
      );
      expect(text, `${rel} does not preserve the registry-name pre-announcement gate`).toMatch(
        /registry(?:-fetch| delivery| package)?[^.]{0,140}(?:pre-announcement|release) gate/i,
      );
    }
  });

  it('the authoritative Windows summaries name the three shell versions actually exercised', () => {
    for (const rel of ['README.md', 'docs/sthayi-v0-spec.md']) {
      const text = flat(rel);
      expect(text, `${rel} omits Windows PowerShell 5.1 from the host evidence`).toMatch(
        /(?:Windows )?PowerShell 5\.1/i,
      );
      expect(text, `${rel} omits PowerShell 7.6.4 from the host evidence`).toMatch(
        /PowerShell 7\.6\.4/i,
      );
      expect(text, `${rel} omits cmd.exe from the host evidence`).toMatch(/cmd(?:\.exe)?/i);
    }
  });

  it('no doc universalizes the bounded Windows host evidence', () => {
    const universalWindowsValidation =
      /(?:\b(?:all|every|any)\s+Windows\s+(?:versions?|machines?|hosts?|environments?|systems?)[^.]{0,80}\b(?:tested|validated|verified)\b)|(?:\bWindows[^.]{0,80}\b(?:fully|universally)\s+(?:tested|validated|verified)\b)|(?:\bWindows\s+(?:install|onboarding|commands?)[^.]{0,40}\b(?:is|are|was|were)\s+(?:fully\s+)?(?:tested|validated|verified)\b)/i;
    for (const rel of ONBOARDING_DOCS) {
      expect(
        flat(rel),
        `${rel} widens one Windows 11/Node 22 host result into a universal claim`,
      ).not.toMatch(universalWindowsValidation);
    }
  });

  it('no doc places Homebrew’s prefix inside the home directory', () => {
    for (const rel of ONBOARDING_DOCS) {
      const text = flat(rel);
      let from = 0;
      for (;;) {
        const at = text.toLowerCase().indexOf('homebrew', from);
        if (at === -1) {
          break;
        }
        const window = text.slice(at, at + 200);
        expect(
          /prefix is (?:already )?(?:in|inside) (?:your|the user'?s?) home/i.test(window),
          `${rel} says Homebrew's prefix is inside the home. It is /opt/homebrew or /usr/local — ` +
            `user-owned (so no sudo), but not in the home: ${window.slice(0, 160)}`,
        ).toBe(false);
        from = at + 1;
      }
    }
  });

  it('a doc that relies on Homebrew prefix ownership tells the reader to check the real prefix', () => {
    for (const rel of ONBOARDING_DOCS) {
      const text = flat(rel);
      if (!/homebrew/i.test(text)) {
        continue;
      }
      expect(
        text,
        `${rel} relies on a Homebrew default without telling the reader to inspect npm's prefix`,
      ).toMatch(/Homebrew.{0,220}npm config get prefix/i);
    }
  });

  it('no doc calls search read-only', () => {
    // `search` journals a memory_retrieve, bumps recency and updates the association graph.
    for (const rel of ONBOARDING_DOCS) {
      const text = flat(rel);
      let from = 0;
      for (;;) {
        const found = text.slice(from).search(/read[- ]only/i);
        if (found === -1) {
          break;
        }
        const start = from + found;
        const window = text.slice(Math.max(0, start - 120), start + 120);
        // A sentence that says search is NOT read-only is the correction, not the claim.
        const denies = /\bnot\b[^.]{0,30}read[- ]only|read[- ]only[^.]{0,20}\bnot\b/i.test(window);
        expect(
          /\bsearch\b/i.test(window) && !denies,
          `${rel} calls search read-only: ${window}`,
        ).toBe(false);
        from = start + 1;
      }
    }
  });

  it('README and SECURITY say plainly what a search does write', () => {
    for (const rel of ['README.md', 'SECURITY.md']) {
      const text = flat(rel);
      expect(text).toMatch(/search[^.]{0,80}\bnot\b[^.]{0,20}read[- ]only/i);
      expect(text).toMatch(/memory_retrieve/);
    }
  });
});

describe('safety: the docs describe only what this build does', () => {
  /**
   * The runtime-copy rule is the claim a reader has to be able to take at face value, so it is
   * pinned as the sentences the pages publish TODAY. Each is asserted whole and exactly: a
   * sentence that is dropped fails, and a sentence that grows a qualifier fails with it, because
   * the pinned text stops occurring. Stating what the page says is a stronger guarantee than
   * searching it for phrasings someone thought to forbid, which can only ever catch what was
   * already imagined.
   */
  const RUNTIME_RULE: readonly { rel: string; sentences: readonly string[] }[] = [
    {
      rel: 'README.md',
      sentences: [
        '**Sthayi never copies the package anywhere.**',
        'Both launchers reference your install **in place**',
        'Nothing is written under `~/.sthayi/runtime/`; that directory is not created, not refreshed, and not garbage-collected.',
        'Sthayi reads it only to refuse it:',
        '`doctor` reports it as a stale runtime pin',
        'The directory itself is inert, and yours to delete or keep — Sthayi neither removes nor maintains it.',
      ],
    },
    {
      rel: 'SECURITY.md',
      sentences: [
        '### Cached and temporary installs are refused; Sthayi creates no runtime copy',
        '`~/.sthayi/runtime/` is never created, on any platform.',
        'Nothing is copied, staged, marked complete, refreshed or garbage-collected there, and no launcher Sthayi writes points inside it.',
        'The shape is refused rather than hardened',
        'Sthayi reads that path only to refuse a launcher that points inside it.',
      ],
    },
  ];

  for (const { rel, sentences } of RUNTIME_RULE) {
    it(`${rel} states the runtime-copy rule in exactly the words it publishes`, () => {
      const text = flat(rel);
      for (const sentence of sentences) {
        expect(text, `${rel} no longer states: ${sentence}`).toContain(sentence);
      }
    });
  }

  it('the rule is stated unconditionally — one claim, holding everywhere, for this build', () => {
    // `on any platform` is the whole scope SECURITY.md gives the rule, and README.md gives the
    // same rule its whole scope by naming both launchers. Neither is narrowed to a route, a
    // platform or a moment.
    expect(flat('SECURITY.md')).toContain('is never created, on any platform.');
    expect(flat('README.md')).toContain('Both launchers reference your install **in place**');
  });

  it('README and SECURITY still state that nothing is copied into the home', () => {
    for (const rel of ['README.md', 'SECURITY.md']) {
      const text = flat(rel);
      expect(text).toMatch(
        /never (?:copies|copied)|copies no|Nothing is (?:copied|written under)/i,
      );
      expect(text).toContain('.sthayi/runtime');
    }
  });
});
