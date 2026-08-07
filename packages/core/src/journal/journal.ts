import type {
  ChainVerification,
  JournalDraft,
  JournalRecord,
  SealedJournalEntry,
} from '../domain/journal.js';
import { sha256 } from './sha256.js';
import { stableStringify } from './stable-stringify.js';

/**
 * Canonical bytes that a journal entry's hash commits to. The store-assigned `id` is
 * deliberately NOT included — it is a presentation sequence, while the chain integrity comes
 * from `prevHash` linking. `payload` is stable-stringified so key order can never change a hash.
 */
function canonicalize(draft: JournalDraft, prevHash: string | null): string {
  return stableStringify({
    prevHash: prevHash ?? null,
    ts: draft.ts,
    actor: draft.actor,
    op: draft.op,
    payload: draft.payload ?? null,
    promptVersion: draft.promptVersion ?? null,
    model: draft.model ?? null,
  });
}

/** Compute the hash a draft would have when appended after `prevHash`. */
export function computeHash(draft: JournalDraft, prevHash: string | null): string {
  return sha256(canonicalize(draft, prevHash));
}

/**
 * Hash-what-you-persist: the store serializes payloads with JSON.stringify, which
 * drops undefined-valued keys and applies toJSON (Dates → ISO strings). A payload hashed BEFORE
 * that round-trip would legitimately verify as tampered after being read back. Normalizing
 * through the same JSON round-trip up front guarantees the hashed value and the persisted value
 * are the same value.
 */
function normalizePayload(payload: unknown): unknown {
  if (payload == null) {
    return null;
  }
  const json = JSON.stringify(payload);
  return json === undefined ? null : (JSON.parse(json) as unknown);
}

/** Turn a draft into a fully-hashed entry ready for the store to persist (id assigned there).
 *  Both the hash AND the persisted entry use the JSON-normalized payload. */
export function sealEntry(draft: JournalDraft, prevHash: string | null): SealedJournalEntry {
  const payload = normalizePayload(draft.payload);
  const normalized: JournalDraft = { ...draft, payload };
  return {
    ts: draft.ts,
    actor: draft.actor,
    op: draft.op,
    payload,
    promptVersion: draft.promptVersion ?? null,
    model: draft.model ?? null,
    prevHash: prevHash ?? null,
    hash: computeHash(normalized, prevHash),
  };
}

/**
 * Walk the chain in id order. Verifies two things per entry:
 *  1. its stored `prevHash` equals the previous entry's `hash` (link integrity)
 *  2. its stored `hash` matches a recomputation from its own fields (tamper detection)
 */
export function verifyChain(records: readonly JournalRecord[]): ChainVerification {
  const ordered = [...records].sort((a, b) => a.id - b.id);
  let prev: string | null = null;
  for (const r of ordered) {
    const storedPrev = r.prevHash ?? null;
    if (storedPrev !== prev) {
      return {
        ok: false,
        length: ordered.length,
        brokenAt: r.id,
        reason: `broken link at entry ${r.id}: prevHash does not match the previous entry's hash`,
      };
    }
    const expected = computeHash(r, storedPrev);
    if (expected !== r.hash) {
      return {
        ok: false,
        length: ordered.length,
        brokenAt: r.id,
        reason: `tampered entry ${r.id}: recomputed hash does not match the stored hash`,
      };
    }
    prev = r.hash;
  }
  return { ok: true, length: ordered.length };
}
