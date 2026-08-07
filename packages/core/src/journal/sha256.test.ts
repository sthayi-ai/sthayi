import { describe, expect, it } from 'vitest';
import { sha256 } from './sha256.js';

// NIST / RFC 6234 known-answer vectors — proves the hand-rolled implementation is correct.
describe('sha256', () => {
  it('hashes the empty string', () => {
    expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('hashes "abc"', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('hashes the 448-bit message', () => {
    expect(sha256('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('hashes multi-byte UTF-8 (emoji + accents)', () => {
    // Verified against Node's crypto.createHash('sha256').update(s,'utf8').
    expect(sha256('héllo 🌍')).toBe(
      'cbbcee01a3fc5f1c0db23e02be25316adf28ede876031fdbabe5f4fabe47ed7f',
    );
  });

  it('is deterministic', () => {
    expect(sha256('sthayi')).toBe(sha256('sthayi'));
  });

  it('avalanches on a one-char change', () => {
    expect(sha256('sthayi')).not.toBe(sha256('sthayj'));
  });
});
