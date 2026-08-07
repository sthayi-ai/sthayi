import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { removeOwned } from '../helpers/owned-fs.js';
import { runTempDir } from '../helpers/run-temp.js';

/**
 * SAFETY INVARIANT: the published docs must not hand an owner a copy-pasteable recursive delete or
 * move of a directory chosen by a raw path string.
 *
 * A reset or uninstall snippet naturally takes one of two shapes, and both decide what to destroy
 * from the *string* `${STHAYI_HOME:-$HOME/.sthayi}`. The strongest guard that fits on one line is
 * "is it absolute", "is it not the literal `/` or `$HOME` string", and "does a file named
 * `sthayi.db` exist inside it". None of that is an identity check: `$HOME/` and `$HOME/../home` are
 * the same directory under different strings, `sthayi.db` can be zero bytes or planted, and
 * `rm`/`mv` resolve symlinked ancestors in the path they are handed. A final-component symlink with
 * a trailing slash is worse as guidance because its result varies by `rm` implementation: BSD rm
 * traverses it while GNU rm currently leaves both link and target standing without an error.
 * Sthayi's own trust boundary
 * (`packages/cli/src/fs-safe.ts`) exists because none of that can be done with string comparison.
 *
 * This file is in two halves:
 *
 *   1. EXECUTED DEMONSTRATIONS of both guard shapes against isolated fixtures. The cross-platform
 *      cases destroy something the guard appears to protect; the final-component symlink case pins
 *      the exact installed `rm` behavior instead of claiming incompatible tools act alike. They are
 *      the reason the invariant exists: any proposal to publish guidance in this shape has to
 *      answer them first.
 *   2. CONTENT ASSERTIONS that neither published file carries such a snippet, that the prose does
 *      not claim `sthayi.db` makes a recursive delete safe, and that the Windows scope of the
 *      filesystem trust boundary reaches npm users in the one prose file npm ships.
 *
 * WINDOWS: PowerShell equivalents of both shapes are NOT executed here — there is no `pwsh` on
 * this platform and none in CI's POSIX legs. Their absence from the docs is asserted textually
 * only; nothing in this file verifies any PowerShell behaviour.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readme = (): string => fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
const security = (): string => fs.readFileSync(path.join(repoRoot, 'SECURITY.md'), 'utf8');
const describePosix = describe.skipIf(process.platform === 'win32');

/** A plausible SQLite header — enough to make a planted file look like a store to `[ -f ]`. */
const SQLITE_HEADER = 'SQLite format 3\u0000';

/**
 * SHAPE 1 — a purge guard: absolute-path check, `/`-and-`$HOME` string exclusions, and a
 * `sthayi.db` presence test, then `rm -rf`. Assembled from an array of single-quoted lines because
 * a TS template literal would eat `${...}`.
 */
const STORE_STRING_PURGE_GUARD = [
  'STORE="${STHAYI_HOME:-$HOME/.sthayi}"',
  'case "$STORE" in',
  '  /*) ;;',
  `  *)  echo "refusing: STHAYI_HOME must be an absolute path (got '$STORE')" >&2; false ;;`,
  'esac &&',
  '[ "$STORE" != "/" ] && [ "$STORE" != "$HOME" ] &&',
  '[ -f "$STORE/sthayi.db" ] &&',
  'rm -rf -- "$STORE" ||',
  `  echo "refusing: '$STORE' is not a Sthayi store (no sthayi.db), or is / or your home dir" >&2`,
].join('\n');

/**
 * SHAPE 2 — a move-aside: rename the store to a timestamped sibling, refusing only a destination
 * that already exists. Note what is absent: no absolute-path check, and no store check of any
 * kind — not even shape 1's `sthayi.db` test. Any `sthayi` CLI calls a real procedure would
 * interleave are omitted; they need an installed binary and none of them touch the path handling
 * under test.
 */
const STORE_STRING_MOVE_ASIDE = [
  'set -eu',
  'STORE="${STHAYI_HOME:-$HOME/.sthayi}"',
  'BACKUP="$STORE.backup.$(date +%Y%m%d-%H%M%S)"',
  '[ -e "$BACKUP" ] && { echo "refusing: $BACKUP already exists" >&2; exit 1; }',
  'mv "$STORE" "$BACKUP"',
].join('\n');

/** The separate deletion step a move-aside implies: erasing the sibling it just created. */
const BACKUP_TREE_DELETE = ['set -eu', 'rm -rf "$BACKUP"'].join('\n');

interface ShellResult {
  status: number;
  stderr: string;
}

/** Run a snippet under /bin/sh with a scrubbed env, exactly as an owner would paste it. */
function runSnippet(
  script: string,
  env: Record<string, string>,
  cwd: string = repoRoot,
): ShellResult {
  const r = spawnSync('/bin/sh', ['-c', script], {
    cwd,
    env: { PATH: '/usr/bin:/bin', ...env },
    encoding: 'utf8',
  });
  return { status: r.status ?? -1, stderr: r.stderr };
}

/** A fake home with the kind of unrelated content a real one holds. Never the live `$HOME`. */
function fakeHome(prefix: string): { root: string; home: string } {
  const root = runTempDir(prefix);
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, '.profile'), 'canary: shell profile');
  fs.mkdirSync(path.join(home, 'Documents'));
  fs.writeFileSync(path.join(home, 'Documents', 'taxes.pdf'), 'canary: unrelated user file');
  return { root, home };
}

/** A directory that satisfies shape 1's entire notion of "is a Sthayi store". */
function plantStore(dir: string, dbBytes = SQLITE_HEADER): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'sthayi.db'), dbBytes);
  return dir;
}

const exists = (p: string): boolean => fs.existsSync(p);
const lexists = (p: string): boolean => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * Does the exact `rm` reached by runSnippet traverse a final-component symlink carrying a slash?
 * Probe once in an independent owned fixture: BSD and GNU have deliberately different answers, and
 * selecting by capability is more precise than selecting by operating-system name.
 */
function rmDereferencesFinalSymlink(): boolean {
  const root = runTempDir('sthayi-docs-rm-capability-');
  const target = plantStore(path.join(root, 'target'));
  const link = path.join(root, 'link');
  fs.symlinkSync(target, link);
  const r = runSnippet('rm -rf -- "$PROBE/"', { HOME: root, PROBE: link });
  expect(r.status).toBe(0);
  expect(lexists(link)).toBe(true);
  const dereferences = !exists(target);
  removeOwned(root);
  return dereferences;
}

describePosix('safety: a path-string purge guard destroys what it appears to protect', () => {
  it('a trailing slash defeats the "!= $HOME" test and deletes the whole home', () => {
    const { home } = fakeHome('sthayi-docs-purge-slash-');
    // The layout an owner gets from `STHAYI_HOME=$HOME`: the store files sit directly in the home.
    fs.writeFileSync(path.join(home, 'sthayi.db'), SQLITE_HEADER);

    const r = runSnippet(STORE_STRING_PURGE_GUARD, { HOME: home, STHAYI_HOME: `${home}/` });

    // `"$HOME/" != "$HOME"` is true as strings and false as directories. Nothing refused; the
    // home, the shell profile and the unrelated documents are gone.
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(exists(home)).toBe(false);
  });

  it('a dot-dot alias of the home defeats the same test and deletes the whole home', () => {
    const { home } = fakeHome('sthayi-docs-purge-dotdot-');
    fs.writeFileSync(path.join(home, 'sthayi.db'), SQLITE_HEADER);

    // `$HOME/../home` — absolute, not `/`, not the `$HOME` string, and the same directory.
    const r = runSnippet(STORE_STRING_PURGE_GUARD, {
      HOME: home,
      STHAYI_HOME: `${home}/../${path.basename(home)}`,
    });

    expect(r.status).toBe(0);
    expect(exists(home)).toBe(false);
  });

  it('a broad directory that merely contains sthayi.db takes its unrelated files with it', () => {
    const { root } = fakeHome('sthayi-docs-purge-broad-');
    const shared = plantStore(path.join(root, 'shared'));
    fs.writeFileSync(path.join(shared, 'payroll.csv'), 'canary: unrelated');
    fs.mkdirSync(path.join(shared, 'photos'));
    fs.writeFileSync(path.join(shared, 'photos', 'wedding.jpg'), 'canary: unrelated');

    const r = runSnippet(STORE_STRING_PURGE_GUARD, {
      HOME: path.join(root, 'home'),
      STHAYI_HOME: shared,
    });

    // The guard never asked whether anything else lived there.
    expect(r.status).toBe(0);
    expect(exists(path.join(shared, 'payroll.csv'))).toBe(false);
    expect(exists(path.join(shared, 'photos', 'wedding.jpg'))).toBe(false);
    expect(exists(shared)).toBe(false);
  });

  it('a symlinked ancestor redirects the delete to a directory that was never checked', () => {
    const { root } = fakeHome('sthayi-docs-purge-ancestor-');
    const intended = plantStore(path.join(root, 'intended', '.sthayi'));
    const elsewhere = plantStore(path.join(root, 'elsewhere', '.sthayi'));
    fs.writeFileSync(path.join(elsewhere, 'canary.txt'), 'canary: not the store the user meant');
    // An ancestor of the configured path is a link — planted, or a plain network/BSD home layout.
    fs.symlinkSync(path.join(root, 'elsewhere'), path.join(root, 'alias'));

    const r = runSnippet(STORE_STRING_PURGE_GUARD, {
      HOME: path.join(root, 'home'),
      STHAYI_HOME: path.join(root, 'alias', '.sthayi'),
    });

    // `rm -rf` followed the link. The checked-looking path was destroyed somewhere else entirely,
    // and the store the owner actually configured is untouched.
    expect(r.status).toBe(0);
    expect(exists(elsewhere)).toBe(false);
    expect(exists(path.join(intended, 'sthayi.db'))).toBe(true);
  });

  it('a final-component symlink plus a trailing slash follows rm semantics, not the guard', () => {
    const dereferences = rmDereferencesFinalSymlink();
    const { root } = fakeHome('sthayi-docs-purge-linkslash-');
    const target = plantStore(path.join(root, 'target'));
    fs.writeFileSync(path.join(target, 'canary.txt'), 'canary: link target contents');
    const link = path.join(root, 'storelink');
    fs.symlinkSync(target, link);

    const r = runSnippet(STORE_STRING_PURGE_GUARD, {
      HOME: path.join(root, 'home'),
      STHAYI_HOME: `${link}/`,
    });

    expect(r.status).toBe(0);
    expect(exists(target)).toBe(!dereferences);
    // Neither implementation removes the symlink itself. BSD leaves it dangling after traversing
    // the target; GNU leaves both objects standing. The string guard predicts neither outcome.
    expect(lexists(link)).toBe(true);
  });

  it('a ZERO-BYTE sthayi.db satisfies the entire "is this a Sthayi store" test', () => {
    const { root } = fakeHome('sthayi-docs-purge-zerobyte-');
    const decoy = path.join(root, 'not-a-store');
    fs.mkdirSync(decoy);
    fs.writeFileSync(path.join(decoy, 'sthayi.db'), ''); // 0 bytes: `[ -f ]` does not read content
    fs.writeFileSync(path.join(decoy, 'thesis.md'), 'canary: unrelated');

    const r = runSnippet(STORE_STRING_PURGE_GUARD, {
      HOME: path.join(root, 'home'),
      STHAYI_HOME: decoy,
    });

    expect(fs.existsSync(path.join(decoy, 'sthayi.db'))).toBe(false);
    expect(exists(path.join(decoy, 'thesis.md'))).toBe(false);
    expect(r.status).toBe(0);
  });
});

describePosix('safety: a path-string move-aside relocates trees it never validated', () => {
  it('a relative STHAYI_HOME is accepted and moves whatever matches in the current directory', () => {
    const { root } = fakeHome('sthayi-docs-move-relative-');
    const workdir = path.join(root, 'workdir');
    const notes = path.join(workdir, 'notes');
    fs.mkdirSync(notes, { recursive: true });
    fs.writeFileSync(path.join(notes, 'draft.md'), 'canary: not a store at all');

    // No absolute-path check exists in this shape, and no store check either.
    const r = runSnippet(
      STORE_STRING_MOVE_ASIDE,
      { HOME: path.join(root, 'home'), STHAYI_HOME: 'notes' },
      workdir,
    );

    expect(r.status).toBe(0);
    expect(exists(notes)).toBe(false);
    const moved = fs.readdirSync(workdir).filter((e) => e.startsWith('notes.backup.'));
    expect(moved).toHaveLength(1);
  });

  it('a symlinked ancestor redirects the mv to a store the owner did not configure', () => {
    const { root } = fakeHome('sthayi-docs-move-ancestor-');
    const intended = plantStore(path.join(root, 'intended', '.sthayi'));
    const elsewhere = plantStore(path.join(root, 'elsewhere', '.sthayi'));
    fs.symlinkSync(path.join(root, 'elsewhere'), path.join(root, 'alias'));

    const r = runSnippet(STORE_STRING_MOVE_ASIDE, {
      HOME: path.join(root, 'home'),
      STHAYI_HOME: path.join(root, 'alias', '.sthayi'),
    });

    expect(r.status).toBe(0);
    expect(exists(elsewhere)).toBe(false);
    expect(
      fs.readdirSync(path.join(root, 'elsewhere')).filter((e) => e.startsWith('.sthayi.backup.')),
    ).toHaveLength(1);
    expect(exists(path.join(intended, 'sthayi.db'))).toBe(true);
  });

  it('a home-equivalent alias moves the entire home, and the implied cleanup then erases it', () => {
    const { root, home } = fakeHome('sthayi-docs-move-home-');
    fs.writeFileSync(path.join(home, 'sthayi.db'), SQLITE_HEADER);

    const alias = `${home}/../${path.basename(home)}`;
    const moved = runSnippet(STORE_STRING_MOVE_ASIDE, { HOME: home, STHAYI_HOME: alias });

    expect(moved.status).toBe(0);
    expect(exists(home)).toBe(false);
    const backups = fs.readdirSync(root).filter((e) => e.startsWith('home.backup.'));
    expect(backups).toHaveLength(1);
    const backup = path.join(root, backups[0] as string);
    // The whole home went into the "backup", unrelated files and all.
    expect(exists(path.join(backup, 'Documents', 'taxes.pdf'))).toBe(true);

    // Step two of such a procedure deletes the backup. That is now the owner's home.
    const purged = runSnippet(BACKUP_TREE_DELETE, { HOME: home, BACKUP: backup });
    expect(purged.status).toBe(0);
    expect(exists(backup)).toBe(false);
    expect(exists(path.join(root, 'home'))).toBe(false);
  });
});

describe('safety: neither published doc carries an automated recursive delete or move', () => {
  it('README.md carries no recursive delete of a path-string-derived directory', () => {
    const text = readme();
    expect(text).not.toMatch(/rm\s+-[rR]f?[a-zA-Z]*\s/);
    expect(text).not.toContain('rm -rf');
    // PowerShell is excluded on the same grounds and asserted textually only, because no
    // PowerShell is executed anywhere in this suite.
    expect(text).not.toMatch(/Remove-Item[^\n]*-Recurse/);
  });

  it('SECURITY.md carries no move-aside or backup deletion of a path-string-derived directory', () => {
    const text = security();
    expect(text).not.toMatch(/^\s*mv\s/m);
    expect(text).not.toContain('rm -rf');
    expect(text).not.toMatch(/Remove-Item[^\n]*-Recurse/);
    expect(text).not.toMatch(/Move-Item[^\n]*-LiteralPath/);
  });

  it('neither doc builds a destructive command around a shell variable holding the store path', () => {
    for (const text of [readme(), security()]) {
      expect(text).not.toContain('$STORE');
      expect(text).not.toContain('STORE=');
      expect(text).not.toContain('$BACKUP');
      expect(text).not.toContain('BACKUP=');
    }
  });

  it('README.md does not claim the sthayi.db check makes a recursive delete safe', () => {
    const text = readme();
    expect(text).not.toContain('The `sthayi.db` check is the point');
    expect(text).not.toMatch(/can only remove a directory that actually holds a store/);
    // …and says the opposite, in so many words.
    expect(text).toMatch(/`sthayi\.db`[^\n]*(does not|cannot)|not a safety check/i);
  });

  it('SECURITY.md says the same about sthayi.db, since the reset discussion lives there', () => {
    expect(security()).toMatch(/`sthayi\.db`[^\n]*(does not|cannot)|not a safety check/i);
  });

  it('the Memory bill of rights points at the CONFIGURED state location, not always ~/.sthayi', () => {
    const text = readme();
    const start = text.indexOf('## Memory bill of rights');
    expect(start).toBeGreaterThan(-1);
    const bill = text.slice(start, text.indexOf('\n## ', start + 1));
    const deletable = bill.slice(bill.indexOf('- **Deletable**'));
    expect(deletable).toContain('STHAYI_HOME');
    expect(deletable).not.toMatch(/removing\s+`~\/\.sthayi\/`\s+deletes the memory itself/);
    // …and it does not turn that location into an operation. A bill of rights is the wrong place
    // for a whole-tree removal in ANY grammatical form — it carries none of the checks the
    // uninstall section spends a page on, and it is three screens above them.
    expect(deletable).not.toMatch(/\bdeleting\b[^.\n]{0,60}\bstate directory\b/i);
    expect(deletable).toContain('Upgrade & uninstall');
  });

  it('neither doc DESCRIBES a whole-tree removal it never spells as an imperative', () => {
    // The snippet shapes above are the executed half of this invariant. The prose half is that no
    // sentence performs the same authorisation in the gerund — a line of the form "then removing
    // the selected archive folder removes the notes themselves" reads as fact and authorises a
    // recursive delete of a path string exactly as the snippets do. Full-file, both files.
    const GERUND_AT_A_DEFINITE_DIRECTORY =
      /\b(?:deleting|removing|erasing|renaming|moving|wiping|purging)\s+(?:the|that|this|your|its)\s+(?:[\w'’-]+\s+){0,3}?(?:director(?:y|ies)|folder|tree|store|home|path|memory)\b/i;
    const CHAINED_TO_A_STEP =
      /\b(?:then|now|next|finally|lastly|by)\s+(?:deleting|removing|erasing|renaming|moving|wiping|purging)\b/i;
    for (const text of [readme(), security()]) {
      expect(text).not.toMatch(GERUND_AT_A_DEFINITE_DIRECTORY);
      expect(text).not.toMatch(CHAINED_TO_A_STEP);
    }
  });

  it('the uninstall guidance tells the owner to read the path from the CLI, not to script it', () => {
    const text = readme();
    const start = text.indexOf('## Upgrade & uninstall');
    expect(start).toBeGreaterThan(-1);
    const section = text.slice(start, text.indexOf('\n## ', start + 1));
    expect(section).toContain('sthayi doctor');
    expect(section).not.toContain('$STORE');
    expect(section).not.toContain('STORE=');
  });

  it('the Quickstart hands a first-time reader no whole-tree deletion step', () => {
    const text = readme();
    const start = text.indexOf('## Quickstart');
    expect(start).toBeGreaterThan(-1);
    const section = text.slice(start, text.indexOf('\n## ', start + 1));
    // "unwire, then delete `~/.sthayi/`" is the shape under test: an imperative to remove the
    // whole tree, three paragraphs into the page, with none of the checks the uninstall section
    // requires. The Quickstart defers to that section instead.
    expect(section).not.toMatch(/\bdelete\b[^.\n]*~\/\.sthayi/i);
    expect(section).not.toMatch(/\brm\b\s+-[rR]/);
    expect(section).toContain('Upgrade & uninstall');
  });
});

describe('safety: the Windows scope of the trust boundary is disclosed where npm users see it', () => {
  // The gap is stated in packages/cli/src/fs-safe.ts, docs/sthayi-v0-spec.md §1 and
  // docs/DECISIONS.md — none of which reach an `npx sthayi` user. Neither does SECURITY.md: the
  // npm tarball's prose surface is README.md alone (asserted below), so README must carry the
  // whole disclosure by itself. SECURITY.md carries it for readers of the repository.
  const REQUIRED = [
    /ownership/i,
    /permission/i,
    /hard[- ]link/i,
    /O_NOFOLLOW/,
    /ancestor/i,
    /identity/i,
    /no root-replacement protection/i,
  ];

  it('the npm tarball has README.md as its prose surface and does not ship SECURITY.md', () => {
    const pkgDir = path.join(repoRoot, 'packages', 'cli');
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as {
      files?: string[];
    };
    // `files` globs resolve inside the package directory, and npm's own always-include set is
    // package.json + README* + LICENSE*. SECURITY.md lives at the repo root, is not listed here,
    // and is not copied into the package directory — so no path puts it in the tarball.
    for (const entry of pkg.files ?? []) {
      expect(entry).not.toMatch(/SECURITY/i);
      expect(entry.startsWith('..')).toBe(false);
    }
    expect(fs.existsSync(path.join(pkgDir, 'SECURITY.md'))).toBe(false);
    // README.md is the file that does ship, so the disclosure has to survive in it.
    expect(fs.existsSync(path.join(repoRoot, 'README.md'))).toBe(true);
  });

  it('README.md discloses it beside the Windows installation guidance and links the spec', () => {
    const text = readme();
    const marker = text.indexOf('**Windows:**');
    expect(marker).toBeGreaterThan(-1);
    // Same paragraph block as the Windows install instructions, not buried elsewhere.
    const block = text.slice(marker, marker + 2000);
    const scope = block.slice(
      0,
      block.indexOf('\n## ') === -1 ? undefined : block.indexOf('\n## '),
    );
    for (const re of REQUIRED) {
      expect(scope).toMatch(re);
    }
    expect(scope).toContain('docs/sthayi-v0-spec.md');
  });

  it('SECURITY.md discloses it and links the spec', () => {
    const text = security();
    for (const re of REQUIRED) {
      expect(text).toMatch(re);
    }
    expect(text).toContain('docs/sthayi-v0-spec.md');
  });

  it('neither doc claims Windows CI covers root-replacement protection', () => {
    // Those tests are `skipIf(process.platform === 'win32')` and are SKIPPED on Windows.
    for (const text of [readme(), security()]) {
      expect(text).not.toMatch(/Windows[^.\n]*\b(CI|tested|verified)\b[^.\n]*root[- ]replacement/i);
      expect(text).not.toMatch(/root[- ]replacement[^.\n]*\b(tested|verified)\b[^.\n]*Windows/i);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// A HAND-CLEARED LOCK IS THE SAME MISTAKE ONE DIRECTORY DOWN.
// ---------------------------------------------------------------------------------------------

/**
 * `rm ~/.sthayi/journal.checkpoint.lock` looks far too small to belong in this file. It is the same
 * error as the snippets above, at a smaller radius: a destructive command aimed at a path STRING
 * that the reader has not been shown is the right one.
 *
 * Three things are wrong with it at once, and the two executed below are the ones a reader cannot
 * detect from the output they get:
 *
 *   1. THE HOME IS NOT `~/.sthayi`. `packages/cli/src/paths.ts` accepts any non-empty absolute
 *      `STHAYI_HOME`, so on a machine that sets one this line names a path in a directory the
 *      product is not using. `rm` then reports "No such file or directory" — which reads exactly
 *      like "there was no stale lock", the conclusion the owner was checking for.
 *   2. THE LOCK IS NOT ALWAYS A FILE. `packages/cli/src/drivers/checkpoint-file.ts` refuses a lock
 *      path occupied by anything that is not a regular file, which is precisely the state a plain
 *      `rm` cannot clear. A squatting DIRECTORY is the blocking case that most needs clearing and
 *      the one case the published line silently fails on.
 *   3. IT IS INVOKED AS A BARE `sthayi`. The headline install is `--prefix "$HOME/.local"`, which
 *      puts nothing on PATH (see docs-onboarding-contract.test.ts), so the surrounding commands do
 *      not run as typed for a reader who followed the quickstart.
 *
 * The product's own guidance travels with the binary instead, on the surface an owner can reach
 * while something is already wrong — asserted at the end of this section.
 */

/** The lock path relative to whatever state directory is actually in use. */
const LOCK_NAME = 'journal.checkpoint.lock';

/** The published shape, reproduced exactly: a bare `rm` at a `~/.sthayi`-derived string. */
const HAND_CLEARED_LOCK = `rm "$HOME/.sthayi/${LOCK_NAME}"`;

describePosix('safety: a hand-cleared lock path fails on exactly the case worth clearing', () => {
  it('a DIRECTORY at the lock path survives the published `rm`, which is the blocking case', () => {
    const root = runTempDir('sthayi-docs-lock-dir-');
    const home = path.join(root, 'home');
    const store = path.join(home, '.sthayi');
    fs.mkdirSync(store, { recursive: true });
    // The state the CLI refuses with "is not a regular file — remove whatever occupies that path".
    const lock = path.join(store, LOCK_NAME);
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'squatter'), 'canary: whatever took the path');

    const r = runSnippet(HAND_CLEARED_LOCK, { HOME: home });

    // `rm` without -r refuses a directory, so the owner runs the documented repair, sees an error
    // they were not told to expect, and the lock is exactly as blocking as before.
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/directory/i);
    expect(fs.existsSync(lock)).toBe(true);
    expect(fs.existsSync(path.join(lock, 'squatter'))).toBe(true);
  });

  it('a custom STHAYI_HOME makes the same line report success-shaped nothing', () => {
    const root = runTempDir('sthayi-docs-lock-elsewhere-');
    const home = path.join(root, 'home');
    const configured = path.join(root, 'custom-state');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(configured, { recursive: true });
    // The REAL lock, in the state directory this machine is actually configured to use.
    const realLock = path.join(configured, LOCK_NAME);
    fs.writeFileSync(realLock, '4242\n');

    const r = runSnippet(HAND_CLEARED_LOCK, { HOME: home, STHAYI_HOME: configured });

    // The line never consults STHAYI_HOME. It reports on a path nothing was ever written to…
    expect(r.stderr).toMatch(/No such file or directory/i);
    // …and the lock that was actually blocking the checkpoint write is untouched.
    expect(fs.existsSync(realLock)).toBe(true);
    expect(fs.readFileSync(realLock, 'utf8')).toBe('4242\n');
  });
});

/** README, SECURITY and every page under docs/ — the whole prose tree, not the shipped subset. */
function publishedDocs(): string[] {
  const out = ['README.md', 'SECURITY.md'];
  const dir = path.join(repoRoot, 'docs');
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir).sort()) {
      if (name.endsWith('.md')) {
        out.push(path.join('docs', name));
      }
    }
  }
  return out;
}

describe('safety: no published page hands the owner a lock path to clear by hand', () => {
  it('the prose tree issues no removal aimed at a lock file', () => {
    // Naming the lock is fine — describing what occupies a state directory is inventory. Pointing a
    // removal command at it is the instruction, in any of the three shells the docs address.
    const REMOVAL_AT_A_LOCK = /(?:^|\s)(?:rm|del|erase|unlink|Remove-Item)\b[^\n]{0,120}\.lock\b/im;
    for (const rel of publishedDocs()) {
      const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
      const m = REMOVAL_AT_A_LOCK.exec(text);
      expect(
        m === null,
        `${rel} tells the owner to remove a lock by hand — a destructive command at a path ` +
          `string, which fails on the one state worth clearing: ${m?.[0]?.trim() ?? ''}`,
      ).toBe(true);
    }
  });

  it('no published page hardcodes the state directory as the lock’s location', () => {
    // `STHAYI_HOME` may name any absolute directory (paths.ts), so `~/.sthayi/<lock>` is a guess.
    for (const rel of publishedDocs()) {
      const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8').replace(/\s+/g, ' ');
      expect(
        /~\/\.sthayi\/[\w.]*\.lock\b/.test(text),
        `${rel} publishes ~/.sthayi/…lock as the lock path; the state directory is configurable`,
      ).toBe(false);
    }
  });

  /**
   * WHAT REPLACES A RECOVERY PAGE. The docs tree is not in the npm tarball (`files` is `dist` +
   * `prompts`), and `journal reseal` is run precisely when something is already wrong — so the
   * semantics are attached to the command itself, where an installed owner can reach them. This is
   * the reason no published page needs to carry them.
   */
  it('the reseal outcomes travel with the binary, on its own --help', () => {
    const cli = fs.readFileSync(path.join(repoRoot, 'packages', 'cli', 'src', 'index.ts'), 'utf8');
    const at = cli.indexOf(`.command('reseal')`);
    expect(at, 'the CLI declares no reseal command').toBeGreaterThan(-1);
    const help = cli.slice(at, at + 3000);
    expect(help, 'reseal attaches no help text').toContain('addHelpText');
    for (const outcome of ['resealed', 'INCOMPLETE', 'reseal refused']) {
      expect(help, `reseal --help does not explain the \`${outcome}\` outcome`).toContain(outcome);
    }
    // …including what to clear, named without asserting where it lives or how to remove it.
    expect(help).toContain('journal.checkpoint.lock');
    // …and the trust decision itself, which is the part that must not be presented as a repair.
    expect(help).toMatch(/trust decision/i);
  });

  it('the docs tree is not shipped, so a page there could not have reached an installed owner', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'packages', 'cli', 'package.json'), 'utf8'),
    ) as { files?: string[] };
    for (const entry of pkg.files ?? []) {
      expect(entry).not.toMatch(/docs/i);
    }
  });
});
