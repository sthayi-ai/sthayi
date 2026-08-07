import { buildCheckpoint, checkpointMac, parseCheckpoint, verifyCheckpoint } from '@sthayi/core';
import { describe, expect, it } from 'vitest';
import { sha256 } from './sha256.js';

/** Deterministic fake keyed MAC for unit tests (the real HMAC lives in NodeCrypto). */
const mac = (data: string): string => sha256(`test-key\x00${data}`);
const otherMac = (data: string): string => sha256(`other-key\x00${data}`);

describe('journal checkpoint helpers', () => {
  it('build → parse → verify round-trips', () => {
    const raw = buildCheckpoint(mac, 3, 7, 'abc123');
    const cp = parseCheckpoint(raw);
    expect(cp).toEqual({ v: 1, count: 3, tipId: 7, tipHash: 'abc123', mac: expect.any(String) });
    expect(cp && verifyCheckpoint(mac, cp)).toBe(true);
  });

  it('the MAC commits to every field — changing any of them invalidates it', () => {
    const cp = parseCheckpoint(buildCheckpoint(mac, 3, 7, 'abc123'));
    if (!cp) {
      throw new Error('unreachable');
    }
    expect(verifyCheckpoint(mac, { ...cp, count: 2 })).toBe(false);
    expect(verifyCheckpoint(mac, { ...cp, tipId: 8 })).toBe(false);
    expect(verifyCheckpoint(mac, { ...cp, tipHash: 'zzz' })).toBe(false);
    const flipped = (cp.mac.startsWith('0') ? '1' : '0') + cp.mac.slice(1);
    expect(verifyCheckpoint(mac, { ...cp, mac: flipped })).toBe(false);
  });

  it('a checkpoint minted under a different key never verifies', () => {
    const cp = parseCheckpoint(buildCheckpoint(otherMac, 3, 7, 'abc123'));
    expect(cp && verifyCheckpoint(mac, cp)).toBe(false);
  });

  it('parseCheckpoint rejects malformed shapes', () => {
    expect(parseCheckpoint('not json')).toBeUndefined();
    expect(parseCheckpoint('null')).toBeUndefined();
    expect(parseCheckpoint('[]')).toBeUndefined();
    expect(parseCheckpoint('{}')).toBeUndefined();
    expect(
      parseCheckpoint(JSON.stringify({ v: 2, count: 1, tipId: 1, tipHash: 'x', mac: 'm' })),
    ).toBeUndefined();
    expect(
      parseCheckpoint(JSON.stringify({ v: 1, count: -1, tipId: 1, tipHash: 'x', mac: 'm' })),
    ).toBeUndefined();
    expect(
      parseCheckpoint(JSON.stringify({ v: 1, count: 1.5, tipId: 1, tipHash: 'x', mac: 'm' })),
    ).toBeUndefined();
    expect(
      parseCheckpoint(JSON.stringify({ v: 1, count: 1, tipId: 1, tipHash: 7, mac: 'm' })),
    ).toBeUndefined();
    expect(
      parseCheckpoint(JSON.stringify({ v: 1, count: 1, tipId: 1, tipHash: 'x' })),
    ).toBeUndefined();
  });

  it('checkpointMac is stable regardless of caller field order', () => {
    const a = checkpointMac(mac, { v: 1, count: 2, tipId: 3, tipHash: 'h' });
    const b = checkpointMac(mac, { tipHash: 'h', tipId: 3, count: 2, v: 1 });
    expect(a).toBe(b);
  });
});
