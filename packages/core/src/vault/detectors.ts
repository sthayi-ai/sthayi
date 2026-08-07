import type { EntityKind } from '../domain/entity.js';

export interface Detection {
  kind: EntityKind;
  value: string;
  start: number;
  end: number;
  /** detector class: true = secret (API key/token/private key), false = PII. BOTH classes are
   *  masked at rest; the flag drives warning wording and entity sensitivity. */
  secret: boolean;
}

interface DetectorDef {
  kind: EntityKind;
  secret: boolean;
  re: RegExp;
}

/**
 * The detector pack (spec §7 test 5; spec §1 invariant 5 — no plaintext secrets at rest).
 * SECRETS (API keys, tokens, private-key
 * blocks) AND PII (email/phone/SSN/card) are masked at write so neither is ever plaintext at rest
 * (the SECURITY.md guarantee). User-configured privacy terms remain egress-only.
 * Order = priority for overlaps.
 */
const DETECTORS: DetectorDef[] = [
  // --- SECRETS (masked at write) ---
  {
    kind: 'APIKEY',
    secret: true,
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  { kind: 'APIKEY', secret: true, re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: 'APIKEY', secret: true, re: /\bsk-proj-[A-Za-z0-9_-]{20,}/g },
  { kind: 'APIKEY', secret: true, re: /\bsk-[A-Za-z0-9]{20,}/g },
  { kind: 'APIKEY', secret: true, re: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: 'APIKEY', secret: true, re: /\bgithub_pat_[A-Za-z0-9_]{36,}/g },
  { kind: 'APIKEY', secret: true, re: /\bgh[pousr]_[A-Za-z0-9]{36,}/g },
  { kind: 'APIKEY', secret: true, re: /\bnpm_[A-Za-z0-9]{36,}/g },
  { kind: 'APIKEY', secret: true, re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  {
    kind: 'APIKEY',
    secret: true,
    re: /https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]+/g,
  },
  { kind: 'APIKEY', secret: true, re: /\bAKIA[0-9A-Z]{16}\b/g },
  // AWS secret keys are 40 unprefixed base64-ish chars — anchor on the assignment context so
  // ordinary 40-char strings (git SHAs, digests) are not swallowed. The whole match is masked.
  {
    kind: 'APIKEY',
    secret: true,
    re: /\b(?:aws_?)?secret_?access_?key\b["']?\s*[:=]\s*["']?[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/gi,
  },
  // JWT/JWS: base64url header.payload.signature — both JSON segments start with eyJ ('{"')
  {
    kind: 'APIKEY',
    secret: true,
    re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  },
  { kind: 'APIKEY', secret: true, re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // Sthayi's own HTTP bearer token: serve-http generates `sthayi_tk_<base64url>` so
  // the token is detector-recognizable if it is ever pasted into memory. Literal prefix + one
  // bounded character class — linear-safe. {40,} matches the generated 43-char payload while
  // leaving short lookalikes (and prefixless base64url strings) alone.
  { kind: 'APIKEY', secret: true, re: /\bsthayi_tk_[A-Za-z0-9_-]{40,}/g },
  // --- PII (masked at rest, like secrets) ---
  // Keep every quantifier here bounded: this pack runs over every memory on pack/oracle egress,
  // and an open-ended email form backtracks quadratically (19.2s on 200KB).
  {
    kind: 'EMAIL',
    secret: false,
    re: /\b[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9-]{1,63}\.){1,8}[A-Za-z]{2,24}\b/g,
  },
  { kind: 'SSN', secret: false, re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { kind: 'CARD', secret: false, re: /\b(?:\d[ -]?){13,16}\b/g },
  // PHONE needs a LEFT token boundary as well as the trailing one. Without it the pattern
  // matched a terminal ten-digit run INSIDE a machine identifier — roughly 0.9% of sha256
  // digests end in ten decimal digits, and a ULID can too — so masking rewrote a digest or an
  // id into `PHONE_nn`. In the append-only journal that corruption is sealed in permanently:
  // verification stays green over the mangled value while rollback refuses the batch forever.
  // `(?<![A-Za-z0-9])` is `\b`'s lookbehind form MINUS the underscore, deliberately: `_` may
  // still precede a match, so an underscore-separated phone number (`contact_5551234567`, a
  // filename or form-field value) keeps being masked. Every machine-identifier grammar here is
  // underscore-free — lowercase hex digests, Crockford base32 ULIDs — so excluding `_` from the
  // class would buy no extra protection while opening a real PII bypass.
  {
    kind: 'PHONE',
    secret: false,
    re: /(?<![A-Za-z0-9])(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
  },
];

/** Detect secrets (and, unless `secretsOnly`, PII + user-defined terms). Overlaps resolved by
 *  earliest start, then longest match, then detector priority. */
export function detect(
  text: string,
  opts: { secretsOnly?: boolean; terms?: string[] } = {},
): Detection[] {
  const found: Detection[] = [];
  for (const d of DETECTORS) {
    if (opts.secretsOnly && !d.secret) {
      continue;
    }
    d.re.lastIndex = 0;
    let m: RegExpExecArray | null = d.re.exec(text);
    while (m !== null) {
      found.push({
        kind: d.kind,
        value: m[0],
        start: m.index,
        end: m.index + m[0].length,
        secret: d.secret,
      });
      m = d.re.exec(text);
    }
  }

  if (!opts.secretsOnly && opts.terms) {
    const lower = text.toLowerCase();
    for (const term of opts.terms) {
      if (!term) {
        continue;
      }
      const t = term.toLowerCase();
      let idx = lower.indexOf(t);
      while (idx !== -1) {
        found.push({
          kind: 'TERM',
          value: text.slice(idx, idx + term.length),
          start: idx,
          end: idx + term.length,
          secret: false,
        });
        idx = lower.indexOf(t, idx + term.length);
      }
    }
  }

  found.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const result: Detection[] = [];
  let lastEnd = -1;
  for (const d of found) {
    if (d.start >= lastEnd) {
      result.push(d);
      lastEnd = d.end;
    }
  }
  return result;
}

export function detectSecrets(text: string): Detection[] {
  return detect(text, { secretsOnly: true });
}

/**
 * The at-rest detection policy: secret classes AND PII classes, but NOT user-configured
 * terms (those are egress-only — `maskForEgress` stays the superset). This is what the write-time
 * choke points (memory drafts, journal payloads) run.
 */
export function detectAtRest(text: string): Detection[] {
  return detect(text);
}
