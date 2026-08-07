/**
 * Deterministic JSON serialization: object keys are emitted in sorted order at every depth,
 * so the same logical payload always hashes to the same string regardless of insertion order.
 * Arrays keep their order (order is meaningful). Used only for hashing, never for storage.
 */
export function stableStringify(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  const t = typeof value;
  if (t === 'number') {
    return Number.isFinite(value as number) ? String(value) : 'null';
  }
  if (t === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (t === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(serialize).join(',')}]`;
  }
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts = keys.map((k) => `${JSON.stringify(k)}:${serialize(obj[k])}`);
    return `{${parts.join(',')}}`;
  }
  // functions, symbols, bigint — not expected in journal payloads
  return 'null';
}
