import { type OracleOutput, OracleOutputSchema } from './schema.js';

/** A provider that turns a bounded, egress-masked batch into a JSON-only oracle response. */
export interface ProviderPort {
  readonly id: string;
  complete(systemPrompt: string, userContent: string): Promise<string>;
}

export interface BatchItem {
  id: string;
  content: string;
}

export type OracleRunResult =
  | { applied: true; ops: OracleOutput }
  | { applied: false; reason: string };

/** Max items per oracle batch (spec §6). */
export const MAX_BATCH = 40;

/**
 * Strip a markdown code fence that wraps the ENTIRE response (```` ```json … ``` ````). Providers
 * often fence JSON despite instructions. Only a full-wrapping fence is removed — arbitrary prose
 * around JSON is deliberately NOT extracted, so prose-wrapped output still fails validation.
 */
function stripFence(raw: string): string {
  const s = raw.trim();
  // Provider output is untrusted (and bounded but still large). Slicing a full wrapper is linear;
  // the former optional/lazy regex backtracked quadratically on long whitespace runs.
  if (!s.startsWith('```') || !s.endsWith('```') || s.length < 6) {
    return s;
  }
  let body = s.slice(3, -3);
  if (body.startsWith('json')) {
    body = body.slice('json'.length);
  }
  return body.trim();
}

/**
 * Validate a raw oracle response: strict JSON (after stripping a full-wrapping code fence), strict
 * schema, and every referenced id must be in the batch. Any failure → `applied:false` (the caller
 * journals a 'rejected' entry and applies nothing). This is the release-gate rejection matrix
 * (safety test 4).
 */
export function validateOracleOutput(raw: string, batchIds: ReadonlySet<string>): OracleRunResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFence(raw));
  } catch {
    return { applied: false, reason: 'response is not valid JSON' };
  }
  const result = OracleOutputSchema.safeParse(parsed);
  if (!result.success) {
    return {
      applied: false,
      reason: `schema violation: ${result.error.issues[0]?.message ?? 'invalid'}`,
    };
  }
  const ops = result.data;
  const referenced = [
    ...ops.merge.flat().map((id, i) => ({ id, where: `merge[${i}]` })),
    ...ops.archive.map((id, i) => ({ id, where: `archive[${i}]` })),
    ...ops.promote.map((p, i) => ({ id: p.from, where: `promote[${i}].from` })),
    ...ops.contradictions.flatMap((c, i) => [
      { id: c.a, where: `contradictions[${i}].a` },
      { id: c.b, where: `contradictions[${i}].b` },
    ]),
  ];
  for (const [i, ref] of referenced.entries()) {
    if (!batchIds.has(ref.id)) {
      // Position-based wording only: the id is attacker-controlled model output and
      // must NOT be echoed into the (journaled) reason — the location keeps it actionable.
      return {
        applied: false,
        reason: `referenced id not in batch at ${ref.where} (reference ${i + 1} of ${referenced.length})`,
      };
    }
  }
  return { applied: true, ops };
}

/** Send one batch to the provider and validate the response. Provider errors → rejection. */
export async function runOracleBatch(
  items: BatchItem[],
  provider: ProviderPort,
  systemPrompt: string,
): Promise<OracleRunResult> {
  let raw: string;
  try {
    raw = await provider.complete(systemPrompt, JSON.stringify({ items }));
  } catch (err) {
    return {
      applied: false,
      reason: `provider error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return validateOracleOutput(raw, new Set(items.map((i) => i.id)));
}
