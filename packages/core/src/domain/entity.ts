export type EntityKind = 'EMAIL' | 'PHONE' | 'SSN' | 'CARD' | 'APIKEY' | 'TERM';

/**
 * A vaulted entity. The canonical value is AES-256-GCM encrypted at rest (`valueEnc`);
 * only the stable pseudonym (`KIND_NN`) ever appears in memory content or egress.
 */
export interface Entity {
  id: string;
  kind: EntityKind;
  valueEnc: Uint8Array | null;
  pseudonym: string;
  sensitivity: string | null;
  createdAt: number;
}

/** Pseudonym format: KIND_NN (e.g. EMAIL_01, APIKEY_07). */
export const PSEUDONYM_RE = /\b(EMAIL|PHONE|SSN|CARD|APIKEY|TERM)_\d{2,}\b/g;

export function formatPseudonym(kind: EntityKind, n: number): string {
  return `${kind}_${String(n).padStart(2, '0')}`;
}
