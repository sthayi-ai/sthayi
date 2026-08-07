import { detect, detectAtRest, detectSecrets, sha256 } from '@sthayi/core';
import { describe, expect, it } from 'vitest';

describe('secret detectors', () => {
  it('detects API-key style secrets', () => {
    const text =
      'anthropic sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX openai sk-proj-ABCDEFGHIJKLMNOPQRSTUV github ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 aws AKIAIOSFODNN7EXAMPLE';
    const found = detectSecrets(text);
    expect(found.length).toBeGreaterThanOrEqual(4);
    expect(found.every((d) => d.kind === 'APIKEY' && d.secret)).toBe(true);
  });

  it('detects a PEM private-key block', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nAAAABBBBCCCC\n-----END RSA PRIVATE KEY-----';
    const found = detectSecrets(`key: ${pem} done`);
    expect(found).toHaveLength(1);
    expect(found[0]?.value).toContain('BEGIN RSA PRIVATE KEY');
  });

  it('detects fine-grained PATs, AWS secret keys, JWTs, Stripe, Slack webhooks, npm tokens', () => {
    const samples = [
      `github_pat_${'A'.repeat(22)}_${'B'.repeat(59)}`,
      `aws_secret_access_key = "${'K'.repeat(30)}/+${'k'.repeat(8)}"`,
      `Bearer eyJ${'h'.repeat(17)}.eyJ${'p'.repeat(17)}.${'s'.repeat(17)}`,
      `sk_live_${'S'.repeat(24)}`,
      `sk_test_${'T'.repeat(24)}`,
      [
        'https://hooks.slack.com/services',
        'T0FAKE0AB',
        'B0FAKE0CD',
        'deadbeefdeadbeefdeadbeef',
      ].join('/'),
      `npm_${'N'.repeat(36)}`,
    ];
    for (const sample of samples) {
      const found = detectSecrets(`before ${sample} after`);
      expect(found.length, sample.slice(0, 28)).toBeGreaterThanOrEqual(1);
      expect(found[0]?.kind).toBe('APIKEY');
    }
  });

  it('does not flag a bare 40-char hex digest (e.g. a git SHA) as an AWS secret', () => {
    expect(detectSecrets('commit 3b1f6a29ac0e15c3a9f47b2e9e01d8c4f0a91b7d done')).toHaveLength(0);
  });
});

describe('sthayi HTTP token detector', () => {
  const PAYLOAD = 'CANARYtok3n_-CANARYtok3n_-CANARYtok3n_-CANA'; // 43 base64url chars, like generated
  const TOKEN = `sthayi_tk_${PAYLOAD}`;

  it('detects the generated token shape as a secret', () => {
    const found = detectSecrets(`bearer ${TOKEN} end`);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: 'APIKEY', secret: true, value: TOKEN });
  });

  it('detects bypass variants: quoted, in a URL, in JSON, at line start', () => {
    const variants = [
      `token="${TOKEN}"`,
      `https://example.com/mcp?auth=${TOKEN}`,
      `{"authorization":"Bearer ${TOKEN}"}`,
      `${TOKEN} was my token`,
    ];
    for (const v of variants) {
      const found = detectSecrets(v);
      expect(found.length, v.slice(0, 30)).toBeGreaterThanOrEqual(1);
      expect(found.some((d) => d.value.includes('sthayi_tk_'))).toBe(true);
    }
  });

  it('does NOT flag ordinary base64url strings or prefixless lookalikes (false positives)', () => {
    const innocents = [
      PAYLOAD, // bare base64url, no prefix
      `tk_${PAYLOAD}`, // partial prefix
      `sthayi_${PAYLOAD}`, // missing tk_
      `sthayi_tk_${'a'.repeat(20)}`, // too short to be a generated token
      'the sthayi_tk_ prefix itself, in prose',
    ];
    for (const s of innocents) {
      expect(detectSecrets(s), s.slice(0, 30)).toHaveLength(0);
    }
  });

  it('stays fast on pathological near-miss input (linear-safety)', () => {
    // thousands of prefix hits each followed by a just-too-short payload — a backtracking
    // pattern would go quadratic here; the single bounded class cannot
    const hostile = `sthayi_tk_${'a'.repeat(39)}! `.repeat(4000);
    const started = performance.now();
    const found = detectSecrets(hostile);
    const elapsed = performance.now() - started;
    expect(found).toHaveLength(0);
    expect(elapsed).toBeLessThan(500);
  });
});

describe('detectAtRest (at-rest policy)', () => {
  it('finds secrets AND PII, but never user terms', () => {
    const text = 'key sk-ant-CANARYzzzzzzzzzzzzzzzzzzzz mail a@b.com Project Falcon';
    const kinds = detectAtRest(text).map((d) => d.kind);
    expect(kinds).toContain('APIKEY');
    expect(kinds).toContain('EMAIL');
    expect(kinds).not.toContain('TERM');
  });
});

describe('PII detectors (masked at rest; detectSecrets stays secrets-only)', () => {
  it('are ignored by detectSecrets but found by full detect', () => {
    const text = 'email alex@example.com ssn 123-45-6789 phone 555-123-4567';
    expect(detectSecrets(text)).toHaveLength(0);
    const kinds = detect(text).map((d) => d.kind);
    expect(kinds).toContain('EMAIL');
    expect(kinds).toContain('SSN');
    expect(kinds).toContain('PHONE');
  });

  it('detects user-defined terms', () => {
    const found = detect('Project Falcon launches soon', { terms: ['Falcon'] });
    expect(found.some((d) => d.kind === 'TERM' && d.value === 'Falcon')).toBe(true);
  });

  it('produces non-overlapping detections', () => {
    const found = detect('a@b.com and 111-22-3333').sort((x, y) => x.start - y.start);
    for (let i = 1; i < found.length; i++) {
      expect(found[i]?.start ?? 0).toBeGreaterThanOrEqual(found[i - 1]?.end ?? 0);
    }
  });
});

/**
 * PHONE needs a LEFT token boundary as well as its trailing one. Without it, a terminal ten-digit
 * run inside a machine identifier matches, and masking rewrites a sha256 digest or a ULID into
 * `PHONE_nn`. Roughly 0.9% of sha256 digests end in ten decimal digits, so the corruption is
 * common enough to hit real stores and rare enough to look like an isolated oddity.
 */
describe('PHONE token boundaries', () => {
  /** A REAL sha256 digest that happens to end in ten decimal digits — found by scanning
   *  `digest-corruption-probe-<n>` and asserted here, never hand-written. */
  const DIGEST_ENDING_IN_TEN_DIGITS = sha256('digest-corruption-probe-60');
  /** A structurally valid ULID (26 Crockford base32 chars) ending in ten decimal digits. */
  const ULID_ENDING_IN_TEN_DIGITS = '01ARZ3NDEKTSV4RR1234567890';

  it('the fixtures really do end in ten digits (so a boundary-less pattern would match them)', () => {
    expect(DIGEST_ENDING_IN_TEN_DIGITS).toMatch(/^[0-9a-f]{64}$/);
    expect(DIGEST_ENDING_IN_TEN_DIGITS).toMatch(/\d{10}$/);
    expect(ULID_ENDING_IN_TEN_DIGITS).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(ULID_ENDING_IN_TEN_DIGITS).toMatch(/\d{10}$/);
  });

  it('still matches every real phone form', () => {
    const phones = [
      '5551234567',
      '555-123-4567',
      '555.123.4567',
      '555 123 4567',
      '(555) 123-4567',
      '+15551234567',
      '+1 555-123-4567',
      '+1-555-123-4567',
      '+1.555.123.4567',
    ];
    for (const p of phones) {
      const found = detect(p).filter((d) => d.kind === 'PHONE');
      expect(found.length, p).toBe(1);
    }
  });

  it('matches at string start, after a quote, and inside prose', () => {
    const cases: [string, string][] = [
      ['5551234567 is my number', '5551234567'],
      ['"5551234567"', '5551234567'],
      ["'555-123-4567' is the office", '555-123-4567'],
      ['call me at 555-123-4567 tomorrow', '555-123-4567'],
      ['(555) 123-4567, ext 9', '(555) 123-4567'],
      // `_` is NOT in the boundary class ON PURPOSE: an underscore-separated phone number in a
      // filename or form-field value must keep being masked.
      ['contact_5551234567', '5551234567'],
      ['phone=5551234567', '5551234567'],
    ];
    for (const [text, expected] of cases) {
      const found = detect(text).filter((d) => d.kind === 'PHONE');
      expect(found.length, text).toBe(1);
      expect(found[0]?.value, text).toBe(expected);
    }
  });

  it('never matches inside a digest, a ULID, or an alphanumeric token', () => {
    const machine = [
      'abc1234567890',
      DIGEST_ENDING_IN_TEN_DIGITS,
      ULID_ENDING_IN_TEN_DIGITS,
      sha256('digest-corruption-probe-223'),
      sha256('digest-corruption-probe-452'),
    ];
    for (const s of machine) {
      expect(
        detect(s).filter((d) => d.kind === 'PHONE'),
        s.slice(0, 32),
      ).toHaveLength(0);
    }
  });

  it('mints NO detection of ANY kind for digests and ULIDs (whole-pack audit)', () => {
    // Every other rule is anchored on a literal prefix (`sk-`, `AKIA`, `eyJ`, `github_pat_`, …),
    // on punctuation a digest/ULID cannot contain (`@` for EMAIL, `3-2-4` hyphens for SSN), or on
    // a left `\b` that a run interior to an alphanumeric token can never satisfy (CARD). This
    // sweeps the whole pack over deterministically derived machine ids to keep that true.
    for (let n = 0; n < 600; n++) {
      const digest = sha256(`detector-audit-${n}`);
      expect(detect(digest), digest).toHaveLength(0);
      // a ULID-shaped id derived from the same digest (Crockford base32 alphabet, 26 chars)
      const crockford = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
      let id = '';
      for (let i = 0; i < 26; i++) {
        id += crockford[Number.parseInt(digest[i] as string, 16) * 2 + (i % 2)] as string;
      }
      expect(detect(id), id).toHaveLength(0);
    }
  });
});

describe('detector performance (ReDoS resistance)', () => {
  it('stays fast on 200KB of "a@a.a.a…", where an unbounded EMAIL regex costs tens of seconds', () => {
    const hostile = `a@${'a.'.repeat(100_000)}`;
    const started = performance.now();
    const found = detect(hostile);
    const elapsed = performance.now() - started;
    expect(found).toHaveLength(0);
    // generous bound for slow CI runners — a quadratic pattern is ~2 orders of magnitude over
    expect(elapsed).toBeLessThan(500);
  });
});
