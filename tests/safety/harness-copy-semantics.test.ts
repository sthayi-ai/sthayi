import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { removeOwned } from '../helpers/owned-fs.js';
import { PeerFixtures } from '../helpers/peer-fixtures.js';
import { runTempDir } from '../helpers/run-temp.js';

/**
 * SAFETY: the harness may WITNESS the code under test, and it may not CHANGE it.
 *
 * `owned-fs.ts` replaces several `fs` entry points so it can record what this run creates. Every one
 * of those is also an entry point the code under test calls, so a replacement that behaves even
 * slightly differently makes the whole suite an examination of the harness rather than of the
 * product. `cpSync` is where that risk is sharpest, because it is not one operation: it walks a
 * tree, and its treatment of a SYMLINK is a rewriting rule rather than a copy. Unless
 * `verbatimSymlinks` says otherwise the real call resolves the link target to an absolute path — it
 * does so for text that was already absolute, and it keeps doing it under `dereference` instead of
 * following the link. A replacement that recreates the raw `readlink` text passes every test that
 * only checks "a symlink arrived", while a relative `../x` that pointed inside the source silently
 * begins pointing inside the destination.
 *
 * So the two are compared rather than reasoned about. One fixed matrix of calls runs TWICE — once
 * against an untouched `node:fs`, once with the wrapper installed — in two separate processes,
 * because a module cannot be un-imported. Outcomes, permissions and refusals must match to the
 * character, including which error code comes back and what it says.
 *
 * The matrix deliberately includes shapes the wrapper does not reproduce itself and hands to the
 * real call: that is the other half of the invariant. Replacing an entry point is only acceptable
 * where the replacement is exact, so anything else has to fall through — and falling through has to
 * be tested, or it is a claim rather than a behaviour.
 */
describe('safety: the recording wrapper does not change what cpSync does', () => {
  const props: string[] = [];
  /** The probe runs in a child, so nothing here witnesses what it made; see `peer-fixtures.ts`. */
  const peer = new PeerFixtures();

  afterEach(() => {
    peer.clear();
    for (const p of props.splice(0).reverse()) {
      removeOwned(p);
    }
  });

  const probe = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'helpers',
    'cp-semantics-probe.mts',
  );

  /**
   * Run the matrix in a child, with or without the wrapper.
   *
   * `process.execPath` rather than the `tsx` shim, which resolves whatever `node` is on PATH: two
   * halves of a comparison run on two different runtimes would compare `fs` internals rather than
   * the wrapper, and no assertion here would say so. The recorder is kept out of the child's
   * `NODE_OPTIONS` for the same reason — this measures `cpSync`, not the ledger.
   */
  function runProbe(dir: string, wrapped: boolean): string {
    const r = spawnSync(process.execPath, ['--import', 'tsx', probe, dir], {
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_OPTIONS: '',
        STHAYI_CP_PROBE_WRAPPED: wrapped ? '1' : '0',
      },
    });
    peer.adopt(dir);
    expect(r.stderr ?? '', `probe(wrapped=${wrapped}) failed`).toBe('');
    expect(r.status, `probe(wrapped=${wrapped}) failed`).toBe(0);
    return r.stdout ?? '';
  }

  /**
   * `cpSync` resolves a copied relative symlink against its SOURCE directory by default. The two
   * probes deliberately have different source roots, so their correct absolute answers differ in
   * that one incidental prefix. Fold only an absolute target that is actually below this probe's
   * root; relative link text (the behaviour `verbatimSymlinks` promises) stays byte-for-byte.
   */
  function normalizeProbeAbsolute(value: string, probeRoot: string): string {
    const withoutWindowsNamespace = (p: string): string => {
      if (process.platform !== 'win32') return p;
      if (p.startsWith('\\\\?\\') || p.startsWith('\\??\\')) return p.slice(4);
      return p;
    };
    const target = withoutWindowsNamespace(value);
    if (!path.isAbsolute(target)) return value;

    // Windows can hand the fixture to the probe through an 8.3 spelling and return a copied link
    // target through the corresponding long spelling. Both names identify the same probe root;
    // compare against the native canonical spelling too so that alias is not mistaken for a copy
    // semantic difference. Only an absolute target genuinely inside one of these roots is folded.
    const roots = [probeRoot];
    if (process.platform === 'win32') {
      try {
        roots.push(fs.realpathSync.native(probeRoot));
      } catch {
        // The direct spelling remains the only candidate; an outside or missing target stays exact.
      }
    }
    for (const candidate of new Set(roots.map(withoutWindowsNamespace))) {
      const relative = path.relative(candidate, target);
      const isInside =
        relative === '' ||
        (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
      if (!isInside) continue;
      const suffix = relative === '' ? '' : `/${relative.split(path.sep).join('/')}`;
      return `<PROBE_ROOT>${suffix}`;
    }
    return value;
  }

  function normalizeProbeResults(
    values: Record<string, string>,
    probeRoot: string,
  ): Record<string, string> {
    return Object.fromEntries(
      Object.entries(values).map(([key, value]) => {
        // The dereference control describes a surviving link instead of returning only its target.
        // Normalize that exact, known envelope without folding arbitrary paths out of refusals or
        // other results: those still have to compare byte-for-byte.
        const prefix = 'symlink -> ';
        const normalized = value.startsWith(prefix)
          ? `${prefix}${normalizeProbeAbsolute(value.slice(prefix.length), probeRoot)}`
          : normalizeProbeAbsolute(value, probeRoot);
        return [key, normalized];
      }),
    );
  }

  it('every copy in the matrix produces exactly what the untouched call produces', () => {
    const fixture = runTempDir('sthayi-cpsem-');
    props.push(fixture);
    const bare = path.join(fixture, 'bare');
    const wrapped = path.join(fixture, 'wrapped');

    const fromBare = runProbe(bare, false);
    const fromWrapped = runProbe(wrapped, true);

    // A parse first, so a probe that crashed halfway cannot pass by producing two identical
    // fragments of nothing.
    const expected = normalizeProbeResults(JSON.parse(fromBare) as Record<string, string>, bare);
    const actual = normalizeProbeResults(
      JSON.parse(fromWrapped) as Record<string, string>,
      wrapped,
    );
    expect(Object.keys(expected).length).toBeGreaterThanOrEqual(23);
    expect(Object.keys(actual)).toEqual(Object.keys(expected));

    // Compared case by case rather than as one blob: a mismatch has to name the shape that broke.
    for (const key of Object.keys(expected)) {
      expect(actual[key], `cpSync case ${key} differs from the untouched call`).toBe(expected[key]);
    }

    // Keep the Windows regressions that extended this matrix load-bearing. Equality alone could
    // go vacuous if a probe were renamed or if both sides produced a similarly corrupted result.
    expect(expected['ordinary-tree-modes']).toContain('content=F');
    expect(expected['direct-same-path']).toBe('SAME');
    expect(expected['direct-hard-link-alias']).toBe('src=ALIASED alias=ALIASED');
    expect(expected['direct-directory-chmod']).toMatch(/^mode=0/);
    expect(expected['direct-directory-chmod']).not.toContain('THROW');
    expect(expected['direct-file-chmod']).toContain('content=CHMOD');
    expect(expected['direct-file-chmod']).not.toContain('THROW');

    // The matrix has to keep exercising the rewriting rule, or it stops being able to catch the
    // defect it exists for. A verbatim copy and a resolved one must be visibly different answers.
    const verbatimRelativeTarget = path.join('..', 'target');
    expect(expected['relative-symlink-verbatim']).toBe(verbatimRelativeTarget);
    expect(expected['relative-symlink-default']).not.toBe(verbatimRelativeTarget);
    expect(expected['relative-symlink-default']).toContain('target');
  });
});
