/**
 * Self-contained SHA-256 over the UTF-8 bytes of a string.
 *
 * Why hand-rolled: `packages/core` is browser-clean (spec §1 invariant 6) — it must not
 * import `node:crypto`. This is used only for the tamper-EVIDENT journal hash chain
 * (integrity, not secrecy), so a pure, dependency-free, deterministic implementation is
 * appropriate and is proven against NIST vectors in the tests. Secrecy (AES-256-GCM entity
 * encryption, B6) goes through an injected crypto port, never this file.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function utf8Bytes(str: string): Uint8Array {
  // Minimal UTF-8 encoder (no TextEncoder dependency, for maximal portability).
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i);
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // surrogate pair
      const next = str.charCodeAt(i + 1);
      code = 0x10000 + ((code & 0x3ff) << 10) + (next & 0x3ff);
      i++;
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    } else {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return Uint8Array.from(out);
}

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/** Returns the lowercase hex SHA-256 digest of the UTF-8 encoding of `input`. */
export function sha256(input: string): string {
  const msg = utf8Bytes(input);
  const bitLen = msg.length * 8;

  // Pad: append 0x80, then zeros, then 64-bit big-endian length.
  const withOne = msg.length + 1;
  const totalLen = withOne + ((56 - (withOne % 64) + 64) % 64) + 8;
  const buf = new Uint8Array(totalLen);
  buf.set(msg);
  buf[msg.length] = 0x80;
  // 64-bit length; JS bit ops are 32-bit, so write the low 32 bits (ample for our payloads).
  const lenHi = Math.floor(bitLen / 0x100000000);
  const lenLo = bitLen >>> 0;
  const dv = new DataView(buf.buffer);
  dv.setUint32(totalLen - 8, lenHi);
  dv.setUint32(totalLen - 4, lenLo);

  // Hash state kept in plain numbers (not a typed array) so noUncheckedIndexedAccess does not
  // widen every read to `number | undefined`.
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const w = new Uint32Array(64);

  for (let off = 0; off < totalLen; off += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = dv.getUint32(off + i * 4);
    }
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15] as number;
      const w2 = w[i - 2] as number;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[i] = (((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) & 0xffffffff) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let hh = h7;

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + (K[i] as number) + (w[i] as number)) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + hh) >>> 0;
  }

  const toHex = (n: number): string => n.toString(16).padStart(8, '0');
  return (
    toHex(h0) + toHex(h1) + toHex(h2) + toHex(h3) + toHex(h4) + toHex(h5) + toHex(h6) + toHex(h7)
  );
}
