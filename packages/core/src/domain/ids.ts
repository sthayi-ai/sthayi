import { ulid } from 'ulid';

/**
 * App-level ids are ULIDs (lexicographically sortable, time-ordered).
 * The SQLite FTS join uses the integer rowid internally — never expose rowid above the port.
 */
export function newId(): string {
  return ulid();
}

/** ULID shape guard: 26 chars, Crockford base32. */
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isId(value: string): boolean {
  return ULID_RE.test(value);
}
