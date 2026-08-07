/**
 * FTS5 MATCH query sanitization (sqlite-fts5 skill). Raw user text throws on FTS5 operators
 * (`-`, `"`, `*`, parens, AND/OR/NOT), so we tokenize and double-quote each token. Tokens are
 * combined with **OR** (not implicit AND) so natural-language queries recall memories matching ANY
 * term; bm25 then ranks by how many/how-rare the matched terms are, so the most relevant hit wins.
 * Callers wrap the MATCH in try/catch and fall back to a LIKE scan so search never hard-fails.
 */
export function sanitizeFtsQuery(raw: string): string {
  const tokens = raw
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) {
    return '';
  }
  return tokens.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
}

/** Extract bare tokens (for the LIKE fallback). */
export function queryTokens(raw: string): string[] {
  return raw
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 0);
}
