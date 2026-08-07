import { VaultService, maskDeep } from '@sthayi/core';
import { describe, expect, it } from 'vitest';
import { FakeStore } from '../../../../tests/helpers/fake-store.js';

const CANARY = `sk-proj-${'X'.repeat(24)}`;

const upper = (s: string): string => s.toUpperCase();

describe('maskDeep', () => {
  it('masks string leaves, array elements, object values AND object keys', () => {
    const input = {
      plain: 'a',
      list: ['b', 1, null, ['c']],
      nested: { deep: { keyed: 'd' } },
    };
    expect(maskDeep(input, upper)).toEqual({
      PLAIN: 'A',
      LIST: ['B', 1, null, ['C']],
      NESTED: { DEEP: { KEYED: 'D' } },
    });
  });

  it('passes non-string primitives and null/undefined through untouched', () => {
    expect(maskDeep(7, upper)).toBe(7);
    expect(maskDeep(true, upper)).toBe(true);
    expect(maskDeep(null, upper)).toBeNull();
    expect(maskDeep(undefined, upper)).toBeUndefined();
  });

  it('never mutates the input', () => {
    const input = { k: 'v', arr: ['x'] };
    const copy = structuredClone(input);
    maskDeep(input, upper);
    expect(input).toEqual(copy);
  });

  it('masks a detector-valid canary wherever it hides — including an object KEY', () => {
    const vault = new VaultService(
      new FakeStore(),
      { encrypt: (s) => new TextEncoder().encode(s), decrypt: (b) => new TextDecoder().decode(b) },
      {},
    );
    const mask = (s: string): string => vault.maskSecrets(s).masked;
    const out = maskDeep(
      { [CANARY]: 'value', note: `token ${CANARY}`, nested: [{ [CANARY]: CANARY }] },
      mask,
    );
    expect(JSON.stringify(out)).not.toContain(CANARY);
    expect(JSON.stringify(out)).toMatch(/APIKEY_\d\d/);
  });

  it('is idempotent under the vault masker (pseudonyms never re-match the detectors)', () => {
    const vault = new VaultService(
      new FakeStore(),
      { encrypt: (s) => new TextEncoder().encode(s), decrypt: (b) => new TextDecoder().decode(b) },
      {},
    );
    const mask = (s: string): string => vault.maskSecrets(s).masked;
    const input = { [CANARY]: `key ${CANARY}`, list: [CANARY] };
    const once = maskDeep(input, mask);
    const twice = maskDeep(once, mask);
    expect(twice).toEqual(once);
  });
});
