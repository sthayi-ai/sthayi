import { sha256 } from '../journal/sha256.js';
import type { SourceFiles } from './types.js';

/** Collapse whitespace, trim, and clip to `max` chars (adds an ellipsis when clipped). */
export function truncate(text: string, max = 500): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Normalize for dedup: collapse whitespace, trim, lowercase. */
export function normalizeContent(content: string): string {
  return content.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Stable hash of normalized content — import-time dedup (B5) and exact dedup (B7) share this. */
export function contentHash(content: string): string {
  return sha256(normalizeContent(content));
}

/** Dedupe identity: exact/near dedupe and import dedup never cross scope or type. The `\x00`
 *  separator (escape sequence only — never a literal control byte in source) keeps the fields
 *  from colliding on boundary shifts (e.g. scope 'users' + type 'emantic' vs 'user'+'semantic');
 *  the key is in-memory only, never persisted. */
export function dedupeKey(scope: string, type: string, content: string): string {
  return `${scope}\x00${type}\x00${contentHash(content)}`;
}

/** Epoch ms for 2000-01-01T00:00:00Z — the oldest source timestamp we believe. */
const SOURCE_TS_MIN = 946_684_800_000;
/** Tolerated clock skew for "in the future" source timestamps. */
const SOURCE_TS_MAX_SKEW_MS = 86_400_000;

/**
 * Validate a source-creation timestamp from an export. Accepts epoch MILLISECONDS
 * (callers convert epoch-seconds formats explicitly — that is per-format knowledge) or a
 * date string `Date.parse` understands. Returns epoch ms only when the value is finite, after
 * 2000-01-01, and at most 24h in the future; anything else → undefined (fall back to import time).
 */
export function sourceTimestamp(value: unknown, now: number = Date.now()): number | undefined {
  let ms: number | undefined;
  if (typeof value === 'number') {
    ms = value;
  } else if (typeof value === 'string' && value.trim() !== '') {
    ms = Date.parse(value);
  }
  if (ms === undefined || !Number.isFinite(ms)) {
    return undefined;
  }
  if (ms <= SOURCE_TS_MIN || ms > now + SOURCE_TS_MAX_SKEW_MS) {
    return undefined;
  }
  return ms;
}

/** Find an archive entry by basename (handles both top-level and nested paths). */
export function pick(files: SourceFiles, basename: string): string | undefined {
  if (files[basename] !== undefined) {
    return files[basename];
  }
  const key = Object.keys(files).find((k) => k.endsWith(`/${basename}`) || k === basename);
  return key ? files[key] : undefined;
}

/** Strip HTML tags and collapse whitespace. */
export function stripHtml(html: string): string {
  // A regex such as /<[^>]+>/g backtracks quadratically on hostile runs of '<'. Export content is
  // untrusted and can be hundreds of MiB, so scan it once. Preserve the old behavior for an
  // unclosed '<' by copying that tail literally; only a '<' that reaches a later '>' is a tag.
  const chunks: string[] = [];
  let cursor = 0;
  for (;;) {
    const tagStart = html.indexOf('<', cursor);
    if (tagStart === -1) {
      chunks.push(html.slice(cursor));
      break;
    }
    const tagEnd = html.indexOf('>', tagStart + 1);
    if (tagEnd === -1) {
      chunks.push(html.slice(cursor));
      break;
    }
    if (tagEnd === tagStart + 1) {
      // The prior regex required at least one character inside a tag, so preserve '<>' literally.
      chunks.push(html.slice(cursor, tagEnd + 1));
    } else {
      chunks.push(html.slice(cursor, tagStart), ' ');
    }
    cursor = tagEnd + 1;
  }
  return chunks.join('').replace(/\s+/g, ' ').trim();
}

/** Decode the handful of HTML entities that appear in export dumps. */
export function decodeEntities(text: string): string {
  return text
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
