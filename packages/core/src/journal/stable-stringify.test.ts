import { describe, expect, it } from 'vitest';
import { stableStringify } from './stable-stringify.js';

describe('stableStringify', () => {
  it('sorts object keys at every depth', () => {
    const a = stableStringify({ b: 1, a: { d: 4, c: 3 } });
    const b = stableStringify({ a: { c: 3, d: 4 }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":3,"d":4},"b":1}');
  });

  it('preserves array order (order is meaningful)', () => {
    expect(stableStringify([3, 1, 2])).toBe('[3,1,2]');
  });

  it('treats null and undefined the same (both null)', () => {
    expect(stableStringify({ a: null })).toBe('{"a":null}');
    expect(stableStringify({ a: undefined })).toBe('{"a":null}');
  });

  it('escapes strings via JSON semantics', () => {
    expect(stableStringify('a"b\n')).toBe('"a\\"b\\n"');
  });
});
