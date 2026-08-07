import type { CryptoPort } from '@sthayi/core';
import { VaultService } from '@sthayi/core';
import { describe, expect, it } from 'vitest';
import { FakeStore } from '../../../../tests/helpers/fake-store.js';

// Reversible passthrough "crypto" for unit tests (real AES lives in the safety test).
const fakeCrypto: CryptoPort = {
  encrypt: (s) => new TextEncoder().encode(s),
  decrypt: (b) => new TextDecoder().decode(b),
};

function vault(): VaultService {
  return new VaultService(new FakeStore(), fakeCrypto, {});
}

describe('VaultService', () => {
  it('allocates stable pseudonyms (same value → same pseudonym)', () => {
    const v = vault();
    expect(v.allocate('EMAIL', 'a@b.com')).toBe('EMAIL_01');
    expect(v.allocate('EMAIL', 'a@b.com')).toBe('EMAIL_01');
    expect(v.allocate('EMAIL', 'c@d.com')).toBe('EMAIL_02');
    expect(v.allocate('APIKEY', 'sk-xyz')).toBe('APIKEY_01');
  });

  it('masks secrets at write and reports a warning', () => {
    const v = vault();
    const { masked, warnings } = v.maskSecrets(
      'token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 end',
    );
    expect(masked).not.toContain('ghp_');
    expect(masked).toMatch(/APIKEY_01/);
    expect(warnings).toHaveLength(1);
  });

  it('masks PII at rest too, warning with the class and pseudonym', () => {
    const v = vault();
    const { masked, warnings } = v.maskAtRest('reach me at a@b.com or 555-123-4567');
    expect(masked).toBe('reach me at EMAIL_01 or PHONE_01');
    expect(warnings).toContain('masked a EMAIL at write → EMAIL_01');
    expect(warnings).toContain('masked a PHONE at write → PHONE_01');
    // egress still masks it identically (same pseudonym, stable)
    expect(v.maskForEgress('reach me at a@b.com')).toBe('reach me at EMAIL_01');
  });

  it('maskSecrets is the maskAtRest alias — the write-time masker interfaces get PII too', () => {
    const v = vault();
    expect(v.maskSecrets('ssn 123-45-6789').masked).toBe('ssn SSN_01');
  });

  it('user-configured terms are egress-only — never masked at rest', () => {
    const v = new VaultService(new FakeStore(), fakeCrypto, { terms: ['Falcon'] });
    expect(v.maskAtRest('Project Falcon launches soon').masked).toBe(
      'Project Falcon launches soon',
    );
    expect(v.maskForEgress('Project Falcon launches soon')).toBe('Project TERM_01 launches soon');
  });

  it('lists mappings decrypted for local viewing', () => {
    const v = vault();
    v.allocate('EMAIL', 'a@b.com');
    expect(v.listMappings()).toEqual([{ kind: 'EMAIL', pseudonym: 'EMAIL_01', value: 'a@b.com' }]);
  });
});
