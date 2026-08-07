/**
 * Sink-complete masking primitive: apply `mask` to EVERY string in a value — string
 * leaves, array elements, object values AND object keys. Persisted/egressed structures (journal
 * payloads, provenance, MCP structuredContent) are attacker-influenceable in every string
 * position, including key names, so nothing may skip the mask. Non-string primitives pass
 * through; the result is a fresh structure (inputs are never mutated). Idempotent whenever
 * `mask` is (vault pseudonyms never re-match the detectors).
 */
export function maskDeep<T>(value: T, mask: (s: string) => string): T {
  if (typeof value === 'string') {
    return mask(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => maskDeep(v, mask)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[mask(k)] = maskDeep(v, mask);
    }
    return out as unknown as T;
  }
  return value;
}
