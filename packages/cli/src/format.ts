/** Compact human-readable age from a millisecond epoch (e.g. "3d", "5h", "just now"). */
export function humanAge(fromMs: number, now: number): string {
  const s = Math.max(0, Math.floor((now - fromMs) / 1000));
  if (s < 60) {
    return 'now';
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return `${m}m`;
  }
  const h = Math.floor(m / 60);
  if (h < 24) {
    return `${h}h`;
  }
  const d = Math.floor(h / 24);
  if (d < 365) {
    return `${d}d`;
  }
  return `${Math.floor(d / 365)}y`;
}

/** Single-line snippet: collapse whitespace and clip to `max` chars. */
export function snippet(text: string, max = 64): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function padEndVisible(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

/**
 * Render a composite search score for display: three SIGNIFICANT figures, so small-but-real
 * scores stay distinguishable (0.0132, 0.00415) instead of flattening to "0.00".
 * Display-only — ranking order and the bm25 sign convention (FTS5 bm25() is negative-is-better;
 * it is negated exactly once, in core search) are untouched: a nonzero score never renders as a
 * flat zero, and formatting never reorders anything.
 */
export function formatScore(score: number): string {
  if (!Number.isFinite(score) || score === 0) {
    return String(score);
  }
  // toPrecision(3) → normalize via Number() to drop trailing zeros ("1.00" → "1"); values too
  // small for fixed notation keep their exponent form ("1.23e-7"), which is still distinguishable.
  return String(Number(score.toPrecision(3)));
}
