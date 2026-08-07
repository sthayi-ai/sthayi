import { isId, newId } from '@sthayi/core';
import { describe, expect, it } from 'vitest';

describe('ids', () => {
  it('generates 26-char ULIDs', () => {
    const id = newId();
    expect(id).toHaveLength(26);
    expect(isId(id)).toBe(true);
  });

  it('generates unique ids', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId()));
    expect(ids.size).toBe(1000);
  });

  it('rejects non-ULID strings', () => {
    expect(isId('not-a-ulid')).toBe(false);
    expect(isId('')).toBe(false);
  });
});
