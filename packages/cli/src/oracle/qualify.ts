import { type OracleOutput, type ProviderPort, validateOracleOutput } from '@sthayi/core';
import { type Fixture, loadFixtures, loadPrompt } from './prompts.js';

export interface QualifyResult {
  op: string;
  fixture: string;
  pass: boolean;
  reason?: string;
}

const OPS = ['consolidate', 'distill', 'contradictions'];

function checkExpect(
  ops: OracleOutput,
  expect: Fixture['expect'],
): { ok: boolean; reason?: string } {
  if (expect.empty) {
    const empty =
      ops.merge.length === 0 &&
      ops.archive.length === 0 &&
      ops.promote.length === 0 &&
      ops.contradictions.length === 0;
    return empty ? { ok: true } : { ok: false, reason: 'expected no operations, got some' };
  }
  for (const group of expect.redundant ?? []) {
    const inMerge = ops.merge.some((g) => group.every((id) => g.includes(id)));
    const archived = group.filter((id) => ops.archive.includes(id)).length;
    if (!inMerge && archived < group.length - 1) {
      return { ok: false, reason: `did not consolidate [${group.join(', ')}]` };
    }
  }
  for (const id of expect.promote ?? []) {
    if (!ops.promote.some((p) => p.from === id)) {
      return { ok: false, reason: `did not promote ${id}` };
    }
  }
  for (const [a, b] of expect.contradiction ?? []) {
    const found = ops.contradictions.some(
      (c) => (c.a === a && c.b === b) || (c.a === b && c.b === a),
    );
    if (!found) {
      return { ok: false, reason: `did not flag contradiction [${a}, ${b}]` };
    }
  }
  return { ok: true };
}

/** One operation's qualification material, resolved before anything is sent to a provider. */
interface PreparedOp {
  op: string;
  system: string;
  fixtures: Fixture[];
}

/**
 * RESOLVE THE WHOLE PACK BEFORE THE FIRST PROVIDER CALL, AND REFUSE A PARTIAL ONE.
 *
 * `loadFixtures` answers `[]` for an operation whose fixtures directory is not there rather than
 * throwing, because an op is permitted to carry none. Qualification cannot accept that reading:
 * skipping an op with no fixtures means an install missing (say) `fixtures/contradictions/` still
 * qualifies a model on the other two and reports "N/N fixtures passed." — a partial run wearing a
 * complete run's answer. Every op must therefore carry at least one fixture, and the refusal names
 * EVERY op that does not, so one round of reinstalling fixes all of them.
 *
 * This runs to completion first so that a pack found wanting costs nothing: no prompt is sent, no
 * token is spent, and no half-finished result set exists to be summarised.
 */
function preflight(): PreparedOp[] {
  const prepared: PreparedOp[] = [];
  const missing: string[] = [];
  for (const op of OPS) {
    let system: string;
    try {
      system = loadPrompt(op);
    } catch (err) {
      missing.push(`${op} (prompt: ${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    let fixtures: Fixture[];
    try {
      fixtures = loadFixtures(op);
    } catch (err) {
      missing.push(`${op} (fixtures: ${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    if (fixtures.length === 0) {
      missing.push(`${op} (no fixtures)`);
      continue;
    }
    prepared.push({ op, system, fixtures });
  }
  if (missing.length > 0) {
    throw new Error(
      `the prompt pack is incomplete — qualification needs a prompt and at least one fixture for every operation, and this installation cannot supply: ${missing.join('; ')}. Nothing was sent to the provider. Reinstall sthayi, or point STHAYI_PROMPTS_DIR at a trusted pack`,
    );
  }
  return prepared;
}

/** Run every fixture through the provider and check schema-validity + the expected operation. */
export async function qualify(provider: ProviderPort): Promise<QualifyResult[]> {
  // Preflight FIRST: a provider call before this line would be a call made on behalf of a run that
  // is about to be refused.
  const plan = preflight();
  const results: QualifyResult[] = [];
  for (const { op, system, fixtures } of plan) {
    for (const fx of fixtures) {
      const ids = new Set(fx.input.items.map((i) => i.id));
      let raw: string;
      try {
        raw = await provider.complete(system, JSON.stringify(fx.input));
      } catch (err) {
        results.push({
          op,
          fixture: fx.name,
          pass: false,
          reason: `provider error: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }
      const validated = validateOracleOutput(raw, ids);
      if (!validated.applied) {
        results.push({ op, fixture: fx.name, pass: false, reason: validated.reason });
        continue;
      }
      const check = checkExpect(validated.ops, fx.expect);
      results.push({ op, fixture: fx.name, pass: check.ok, reason: check.reason });
    }
  }
  return results;
}
