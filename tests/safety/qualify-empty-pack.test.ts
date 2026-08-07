import fs from 'node:fs';
import path from 'node:path';
import type { ProviderPort } from '@sthayi/core';
import { describe, expect, it } from 'vitest';
import { main } from '../../packages/cli/src/index.js';
import { loadFixtures, resolvePromptsDir } from '../../packages/cli/src/oracle/prompts.js';
import { qualify } from '../../packages/cli/src/oracle/qualify.js';
import { runTempDir } from '../helpers/run-temp.js';

/**
 * A QUALIFICATION NOBODY RAN MUST NOT REPORT ITSELF AS ONE THAT PASSED.
 *
 * `sthayi qualify` is the command an operator runs to decide whether a model is fit to serve as
 * their Oracle. Its answer is a count: "N/M fixtures passed."
 *
 * The prompt pack ships inside the npm tarball (`files: ["dist", "prompts"]`). The `@v1.md`
 * prompts fail CLOSED if that pack is missing — `resolvePromptsDir` refuses to answer without
 * its marker file. The FIXTURES do not: `loadFixtures` answers `[]` for a directory that is not
 * there, because an op is allowed to carry no fixtures.
 *
 * Those two facts compose badly, and they compose badly TWICE:
 *
 *   1. WHOLLY MISSING FIXTURES. An install whose `prompts/fixtures/` never shipped still resolves
 *      its prompts, so `qualify` runs, asks the provider nothing at all, and returns an empty
 *      result set. `0 === 0` is true, so the operator is told the model qualified.
 *   2. PARTIALLY MISSING FIXTURES — the sharper case. One operation's fixtures directory is
 *      absent and the other two are there. A per-op loop that simply skips the empty one still
 *      calls the provider, still returns a full-looking result set, and still reports "N/N
 *      fixtures passed." for a suite that never asked the model to do the thing it skipped. The
 *      count is arithmetically true and factually a lie: the model was qualified on two thirds of
 *      the pack and reported as qualified on the pack.
 *
 * The contract this file pins: qualification PREFLIGHTS the whole pack — every operation's prompt
 * and at least one fixture apiece — BEFORE the first provider call, names EVERY operation it
 * cannot supply, and reaches no provider at all when any is missing. Every probe below therefore
 * hands `qualify` a provider that would fail the test if it were ever consulted, and the CLI half
 * asserts that no "fixtures passed." sentence is printed for a run that was refused.
 *
 * Fixtures come from `runTempDir`, whose trees the run root reclaims — nothing here removes a
 * directory of its own, which is why this file stands no recursive removal in a teardown.
 */

const OPS = ['consolidate', 'distill', 'contradictions'] as const;

/** A fixture whose expectation an all-empty provider response satisfies. */
const EMPTY_EXPECT_FIXTURE = JSON.stringify({
  input: { items: [{ id: 'm1', content: 'a single unremarkable memory' }] },
  expect: { empty: true },
});

/**
 * A pack holding the three marker prompts, with a fixtures directory for `withFixturesFor` only.
 * Passing every op builds a COMPLETE pack; omitting one builds the partial pack that must be
 * refused rather than silently skipped.
 */
function packWith(withFixturesFor: readonly string[]): string {
  const dir = runTempDir('sthayi-qualify-');
  for (const op of OPS) {
    fs.writeFileSync(path.join(dir, `${op}@v1.md`), `# ${op}\n`);
  }
  for (const op of withFixturesFor) {
    const opDir = path.join(dir, 'fixtures', op);
    fs.mkdirSync(opDir, { recursive: true });
    fs.writeFileSync(path.join(opDir, '01.json'), `${EMPTY_EXPECT_FIXTURE}\n`);
  }
  return dir;
}

function restorePromptsDir(previous: string | undefined): void {
  if (previous === undefined) {
    // biome-ignore lint/performance/noDelete: unsetting an env var; assigning undefined coerces to "undefined".
    delete process.env.STHAYI_PROMPTS_DIR;
  } else {
    process.env.STHAYI_PROMPTS_DIR = previous;
  }
}

/** Run `body` with the prompt pack pointed at `dir`, restoring the caller's environment after. */
function withPromptsDir<T>(dir: string, body: () => T): T {
  const previous = process.env.STHAYI_PROMPTS_DIR;
  process.env.STHAYI_PROMPTS_DIR = dir;
  try {
    return body();
  } finally {
    restorePromptsDir(previous);
  }
}

/**
 * The awaiting form. The synchronous one restores the variable the moment `body` RETURNS, which
 * for an async body is the moment it yields — long before the pack is read. Everything below that
 * crosses an `await` uses this one, or it would silently qualify against the developer's own
 * installed pack instead of the fixture pack under test.
 */
async function withPromptsDirAsync<T>(dir: string, body: () => Promise<T>): Promise<T> {
  const previous = process.env.STHAYI_PROMPTS_DIR;
  process.env.STHAYI_PROMPTS_DIR = dir;
  try {
    return await body();
  } finally {
    restorePromptsDir(previous);
  }
}

interface Probe extends ProviderPort {
  /** Every (system, input) pair the provider was asked to complete. Empty means untouched. */
  calls: string[];
}

/**
 * A provider that RECORDS every call and refuses to answer. Reaching it at all is the defect —
 * the throw makes a stray call loud, and the record makes it provable after the fact even if
 * something downstream swallowed the error.
 */
function untouchableProvider(): Probe {
  const calls: string[] = [];
  return {
    id: 'must-not-be-called',
    calls,
    complete: async (system: string, input: string): Promise<string> => {
      calls.push(`${system} ${input}`);
      throw new Error('the provider was consulted for a pack that qualification must refuse');
    },
  };
}

/** A provider that answers every prompt with a valid, all-empty operation set. */
function countingProvider(): Probe {
  const calls: string[] = [];
  return {
    id: 'mock:empty',
    calls,
    complete: async (system: string, input: string): Promise<string> => {
      calls.push(`${system} ${input}`);
      return '{"merge":[],"archive":[],"promote":[],"contradictions":[]}';
    },
  };
}

describe('a prompt pack missing ANY operation cannot qualify a model', () => {
  it('loadFixtures still answers [] for a missing directory — the fail-open it guards is real', () => {
    const dir = packWith([]);
    expect(fs.existsSync(path.join(dir, 'fixtures'))).toBe(false);

    withPromptsDir(dir, () => {
      // The pack resolves — this is a "working" installation as far as the prompts go.
      expect(resolvePromptsDir()).toBe(fs.realpathSync(dir));
      for (const op of OPS) {
        expect(loadFixtures(op)).toEqual([]);
      }
    });
  });

  it('a pack with NO fixtures at all is refused, naming every operation, provider untouched', async () => {
    const dir = packWith([]);
    const provider = untouchableProvider();

    await expect(withPromptsDirAsync(dir, () => qualify(provider))).rejects.toThrow(/incomplete/i);
    expect(provider.calls, 'the provider was consulted for a pack with no fixtures').toEqual([]);

    const message = await withPromptsDirAsync(dir, () =>
      qualify(provider).then(
        () => '',
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      ),
    );
    for (const op of OPS) {
      expect(message, `the refusal does not name '${op}'`).toContain(op);
    }
    expect(provider.calls, 'the provider was consulted for a pack with no fixtures').toEqual([]);
  });

  // THE PARTIAL PACK, one operation at a time. Two thirds of a qualification suite is not a
  // qualification suite, and the operation that went missing has to be the one named.
  it.each(OPS)(
    'a pack missing ONLY the %s fixtures is refused, naming it, provider untouched',
    async (missing) => {
      const present = OPS.filter((op) => op !== missing);
      const dir = packWith(present);
      const provider = untouchableProvider();

      const message = await withPromptsDirAsync(dir, () =>
        qualify(provider).then(
          () => '',
          (err: unknown) => (err instanceof Error ? err.message : String(err)),
        ),
      );

      expect(message, `a pack missing '${missing}' qualified anyway`).not.toBe('');
      expect(message, `the refusal does not name the missing operation '${missing}'`).toContain(
        missing,
      );
      // ...and names ONLY it: a refusal that lists operations the install really has is a refusal
      // an operator cannot act on.
      for (const op of present) {
        expect(message, `the refusal names '${op}', whose fixtures are present`).not.toContain(op);
      }
      // THE POINT OF THE WHOLE FILE: the two operations that DO have fixtures were not qualified
      // either. A partial pack buys nothing — not one provider call.
      expect(
        provider.calls,
        `the provider ran the ${present.join(' and ')} fixtures for a pack missing '${missing}'`,
      ).toEqual([]);
    },
  );

  it('the CONTROL: a complete pack qualifies, and the provider is reached for every fixture', async () => {
    const dir = packWith(OPS);
    const provider = countingProvider();
    const results = await withPromptsDirAsync(dir, () => qualify(provider));

    expect(results.map((r) => r.op).sort()).toEqual([...OPS].sort());
    expect(
      results.every((r) => r.pass),
      'the complete-pack control did not pass',
    ).toBe(true);
    expect(provider.calls.length, 'a fixture was not sent to the provider').toBe(results.length);
  });
});

/** Capture everything the CLI writes while `body` runs, and restore the streams afterwards. */
async function captureCli(body: () => Promise<void>): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | string | undefined;
}> {
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  const previousExit = process.exitCode;
  let stdout = '';
  let stderr = '';
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  process.exitCode = undefined;
  try {
    await body();
    return { stdout, stderr, exitCode: process.exitCode };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
    process.exitCode = previousExit;
  }
}

/**
 * Run `sthayi qualify` in-process against `dir`. The provider spec needs a key to construct at
 * all, so a synthetic one is supplied together with a LOOPBACK base URL pointing at the discard
 * port: if this command ever reached the network the request would fail there, and it would never
 * be the operator's real credential or a real endpoint either way.
 */
async function runQualify(dir: string): Promise<Awaited<ReturnType<typeof captureCli>>> {
  const before = {
    key: process.env.OPENAI_API_KEY,
    base: process.env.OPENAI_BASE_URL,
  };
  process.env.OPENAI_API_KEY = 'canary-not-a-real-key';
  process.env.OPENAI_BASE_URL = 'http://127.0.0.1:9';
  try {
    return await captureCli(() =>
      withPromptsDirAsync(dir, () => main(['node', 'sthayi', 'qualify', 'openai:gpt-5'])),
    );
  } finally {
    for (const [name, value] of [
      ['OPENAI_API_KEY', before.key],
      ['OPENAI_BASE_URL', before.base],
    ] as const) {
      if (value === undefined) {
        // unsetting an env var: assigning `undefined` would coerce to the string "undefined"
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

/** Every shape of incomplete pack: nothing at all, then each single operation left out. */
const INCOMPLETE_PACKS: { label: string; present: string[] }[] = [
  { label: 'nothing', present: [] },
  ...OPS.map((missing) => ({
    label: `everything but ${missing}`,
    present: OPS.filter((op) => op !== missing),
  })),
];

describe('the CLI never prints a count for a qualification it refused', () => {
  it.each(INCOMPLETE_PACKS)(
    'an incomplete pack (fixtures for: $label) exits nonzero with no "fixtures passed." sentence',
    async ({ present }) => {
      const missing = OPS.filter((op) => !present.includes(op));
      const run = await runQualify(packWith(present));

      expect(run.exitCode, 'the CLI exited 0 for a pack it cannot qualify against').not.toBe(0);
      expect(run.exitCode).toBeDefined();
      // THE SENTENCE THE OPERATOR READS. "0/0 fixtures passed." and "6/6 fixtures passed." are
      // both catastrophic here: one is a run that never happened, the other a run that skipped an
      // operation. Neither may be printed at all.
      expect(
        `${run.stdout}${run.stderr}`,
        'the CLI announced a fixture count for a qualification it refused',
      ).not.toContain('fixtures passed.');
      expect(run.stderr, 'the refusal is not on stderr').toContain('qualify failed:');
      for (const op of missing) {
        expect(run.stderr, `the CLI refusal does not name '${op}'`).toContain(op);
      }
    },
  );
});
