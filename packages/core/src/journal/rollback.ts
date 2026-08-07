import { z } from 'zod';
import type { JournalDraft, JournalRecord } from '../domain/journal.js';
import type { Memory, MemoryStatus } from '../domain/memory.js';
import { sha256 } from './sha256.js';
import { stableStringify } from './stable-stringify.js';

/**
 * A change an op applied to the store, recorded in its journal payload under `changes`.
 * Rollback (spec §1 invariant 3) never rewrites history — it computes the inverse of these
 * and appends compensating entries. B1 provides the *planner*; B7 wires the *executor*.
 *
 * There is deliberately NO `memory_delete` kind: nothing produces one (no op hard-deletes a
 * memory as a recorded change), and accepting it in the schema would hand journal-file editors a
 * primitive whose rollback claims to re-insert a row it never snapshotted. Undoing a
 * `memory_insert` is expressed by carrying the same `memory_insert` change into the inverse
 * list — the executor deletes the inserted row after verifying its recorded post-state digest.
 */
export type AppliedChange =
  // `mergedInto`: when a merge archived this memory, the id it was folded into (provenance).
  | { kind: 'memory_status'; id: string; from: MemoryStatus; to: MemoryStatus; mergedInto?: string }
  | { kind: 'memory_content'; id: string; from: string; to: string }
  // `distilledFrom`: for an oracle-distilled memory, the source memory ids it was distilled from.
  // `digest`: authenticated full post-state digest of the row AS INSERTED (memoryInsertDigest) —
  // rollback recomputes it from the current row and refuses to delete an edited proposal.
  | { kind: 'memory_insert'; id: string; digest: string; distilledFrom?: string[] };

/** The identity fields a memory_insert digest commits to. Volatile retrieval state (`boosts`,
 *  `lastRetrievedAt`, `updatedAt`) is deliberately excluded — a retrieval bump must never break
 *  rollback — and `status` is checked separately (only an untouched 'proposed' row may go). */
export type InsertDigestFields = Pick<
  Memory,
  'content' | 'type' | 'scope' | 'source' | 'confidence' | 'provenance'
>;

/**
 * Post-state digest for a `memory_insert` change: sha256 over the stable-stringified
 * identity fields of the row as inserted. Recorded at creation time inside the same journal
 * entry (hash-chained + checkpointed, so it cannot be quietly rewritten); recomputed from the
 * CURRENT row at rollback time — inequality means the proposal was edited since.
 */
export function memoryInsertDigest(m: InsertDigestFields): string {
  return sha256(
    stableStringify({
      content: m.content,
      type: m.type,
      scope: m.scope,
      source: m.source,
      confidence: m.confidence,
      provenance: m.provenance,
    }),
  );
}

/**
 * The grammar of a `memory_insert` post-state digest: lowercase sha256 hex, exactly what
 * {@link memoryInsertDigest} emits. Single-sourced deliberately — the strict rollback schema
 * below and the journal's op-aware masking policy (journal/service.ts) must agree on what
 * "is a digest" means, or a value one of them accepts is corrupted or rejected by the other.
 */
export const MEMORY_INSERT_DIGEST_RE = /^[0-9a-f]{64}$/;

const MemoryStatusSchema = z.enum(['proposed', 'confirmed', 'archived']);

/**
 * Strict schema for one recorded change. Journal payloads live in a SQLite file the
 * user (or anything on the machine) can edit, so the rollback executor treats them as EXTERNAL
 * input: discriminated union over the three kinds, `.strict()` everywhere — an unknown kind
 * (including the removed 'memory_delete') or a smuggled extra field is a refusal, never a guess.
 */
export const AppliedChangeSchema: z.ZodType<AppliedChange> = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('memory_status'),
      id: z.string().min(1),
      from: MemoryStatusSchema,
      to: MemoryStatusSchema,
      mergedInto: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('memory_content'),
      id: z.string().min(1),
      from: z.string(),
      to: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('memory_insert'),
      id: z.string().min(1),
      digest: z.string().regex(MEMORY_INSERT_DIGEST_RE),
      distilledFrom: z.array(z.string().min(1)).optional(),
    })
    .strict(),
]);

/** Strict shape of a rollback-eligible 'consolidate' journal payload. */
export const ConsolidatePayloadSchema = z
  .object({
    batch: z.string().min(1),
    mode: z.enum(['deterministic', 'oracle']),
    changes: z.array(AppliedChangeSchema).min(1),
  })
  .strict();

export type ConsolidatePayload = z.infer<typeof ConsolidatePayloadSchema>;

export interface RollbackPlan {
  /** journal id being rolled back */
  targetId: number;
  /** store mutations the executor must apply, in order, to undo the target */
  inverse: AppliedChange[];
  /** the compensating journal entry to append AFTER applying `inverse` */
  entry: JournalDraft;
}

function invert(change: AppliedChange): AppliedChange {
  switch (change.kind) {
    case 'memory_status':
      return { kind: 'memory_status', id: change.id, from: change.to, to: change.from };
    case 'memory_content':
      return { kind: 'memory_content', id: change.id, from: change.to, to: change.from };
    case 'memory_insert':
      // In an inverse list, `memory_insert` means "delete this inserted row" — the executor
      // requires the current row to still match `digest` (and status 'proposed') before deleting.
      return change;
  }
}

/**
 * Extract the recorded changes IF they validate strictly; anything else — no `changes` key, a
 * non-array, one malformed item — yields an empty list (the planner consumes only
 * validated changes; a partially-valid batch is never partially undone).
 */
function extractChanges(payload: unknown): AppliedChange[] {
  const parsed = z.object({ changes: z.array(AppliedChangeSchema) }).safeParse(payload);
  return parsed.success ? parsed.data.changes : [];
}

/**
 * Compute how to undo `target`. The inverse list is the reversed, individually-inverted set of
 * changes the target applied; the returned `entry` is the compensating journal record to append.
 */
export function planRollback(target: JournalRecord, now: number, actor = 'cli'): RollbackPlan {
  const inverse = extractChanges(target.payload).map(invert).reverse();
  return {
    targetId: target.id,
    inverse,
    entry: {
      ts: now,
      actor,
      op: 'rollback',
      payload: { rollsBack: target.id, originalOp: target.op, inverse },
    },
  };
}
