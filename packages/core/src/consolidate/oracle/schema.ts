import { z } from 'zod';

/**
 * Resource bounds for one oracle output. A batch holds at most MAX_BATCH (40) items, so honest
 * output sits far below every one of these — the caps exist so a misbehaving oracle cannot make
 * the runtime allocate, journal, or apply unbounded structures. Violations reject the WHOLE
 * batch (discard, never repair — invariant 2).
 */
const MAX_MERGE_GROUPS = 50;
const MIN_GROUP_MEMBERS = 2;
const MAX_GROUP_MEMBERS = 20;
const MAX_ARCHIVE = 200;
const MAX_PROMOTE = 100;
const MAX_CONTRADICTIONS = 100;
const MAX_ID_LENGTH = 64;
/** Cap on the TOTAL number of id references across every op array combined. */
const MAX_TOTAL_REFERENCES = 500;

/** Referenced ids are model output: bounded length, never trusted. (Real ids are 26-char ULIDs;
 *  64 leaves headroom without letting an id become a payload.) */
const IdSchema = z
  .string()
  .min(1, 'referenced id must be non-empty')
  .max(MAX_ID_LENGTH, `referenced id too long (max ${MAX_ID_LENGTH} chars)`);

/**
 * The ONLY shape a consolidation oracle may return (spec §6). `.strict()` everywhere so any extra
 * field is a rejection — the model proposes, the runtime disposes; malformed output is discarded,
 * never repaired (invariant 2).
 */
export const OracleOutputSchema = z
  .object({
    merge: z
      .array(
        z
          .array(IdSchema)
          .min(MIN_GROUP_MEMBERS, `merge group too small (min ${MIN_GROUP_MEMBERS} members)`)
          .max(MAX_GROUP_MEMBERS, `merge group too large (max ${MAX_GROUP_MEMBERS} members)`),
      )
      .max(MAX_MERGE_GROUPS, `too many merge groups (max ${MAX_MERGE_GROUPS})`)
      .default([]),
    archive: z
      .array(IdSchema)
      .max(MAX_ARCHIVE, `too many archive ids (max ${MAX_ARCHIVE})`)
      .default([]),
    // to_content is bounded so a misbehaving oracle cannot mint unbounded rows
    promote: z
      .array(z.object({ from: IdSchema, to_content: z.string().max(4000) }).strict())
      .max(MAX_PROMOTE, `too many promote ops (max ${MAX_PROMOTE})`)
      .default([]),
    // reason is bounded like to_content: contradiction pairs are journaled (append-only, at
    // rest permanently), so a misbehaving oracle must not be able to mint unbounded strings
    contradictions: z
      .array(z.object({ a: IdSchema, b: IdSchema, reason: z.string().max(2000) }).strict())
      .max(MAX_CONTRADICTIONS, `too many contradictions (max ${MAX_CONTRADICTIONS})`)
      .default([]),
  })
  .strict()
  // Whole-output bounds the per-array caps cannot express. (1) Total reference count across every
  // op array. (2) Duplicate MUTATING references: the same id merged twice, merged AND archived,
  // archived AND promoted, etc. is incoherent output — discarded whole, never reconciled.
  // Contradictions are deliberately outside the mutation-duplicate scan: a pair is an
  // OBSERVATION (journaled, never applied), and a memory being merged may legitimately also be
  // party to a contradiction — but each pair must itself be coherent (a ≠ b) and no unordered
  // pair may be flagged twice.
  .superRefine((ops, ctx) => {
    const mutating = [
      ...ops.merge.flatMap((g, gi) => g.map((id, mi) => ({ id, where: `merge[${gi}][${mi}]` }))),
      ...ops.archive.map((id, i) => ({ id, where: `archive[${i}]` })),
      ...ops.promote.map((p, i) => ({ id: p.from, where: `promote[${i}].from` })),
    ];
    const totalRefs = mutating.length + 2 * ops.contradictions.length;
    if (totalRefs > MAX_TOTAL_REFERENCES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `too many referenced ids across all ops (${totalRefs} > max ${MAX_TOTAL_REFERENCES})`,
      });
      return; // oversized output: don't also scan it for duplicates
    }
    // Position-based wording only in every message below: ids are model output and the
    // rejection reason is journaled — never echo them (same rule as the runner's in-batch check).
    const seen = new Set<string>();
    for (const ref of mutating) {
      if (seen.has(ref.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate reference at ${ref.where} — the same id appears in more than one mutating op`,
        });
        return;
      }
      seen.add(ref.id);
    }
    const pairs = new Set<string>();
    for (const [i, c] of ops.contradictions.entries()) {
      if (c.a === c.b) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `contradictions[${i}] pairs an id with itself`,
        });
        return;
      }
      const key = c.a < c.b ? `${c.a}\u0000${c.b}` : `${c.b}\u0000${c.a}`;
      if (pairs.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate contradiction pair at contradictions[${i}]`,
        });
        return;
      }
      pairs.add(key);
    }
  });

export type OracleOutput = z.infer<typeof OracleOutputSchema>;
