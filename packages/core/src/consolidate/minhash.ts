import { normalizeContent } from '../importers/util.js';

const NUM_HASHES = 64;
const SHINGLE_K = 5;

/** FNV-1a 32-bit — fast, dependency-free, good enough for MinHash bucketing. */
function fnv1a(str: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 5-token shingles over normalized content (spec §6). Short texts become a single shingle. */
export function shingles(content: string, k = SHINGLE_K): string[] {
  const tokens = normalizeContent(content).split(' ').filter(Boolean);
  if (tokens.length < k) {
    return tokens.length > 0 ? [tokens.join(' ')] : [];
  }
  const out: string[] = [];
  for (let i = 0; i <= tokens.length - k; i++) {
    out.push(tokens.slice(i, i + k).join(' '));
  }
  return out;
}

/** MinHash signature: for each of NUM_HASHES seeds, the minimum hash over the shingle set. */
export function minhashSignature(content: string, numHashes = NUM_HASHES): number[] {
  const sh = shingles(content);
  const sig = new Array<number>(numHashes).fill(0xffffffff);
  if (sh.length === 0) {
    return sig;
  }
  for (const s of sh) {
    for (let i = 0; i < numHashes; i++) {
      const h = fnv1a(s, (0x9e3779b1 * (i + 1)) >>> 0);
      if (h < (sig[i] as number)) {
        sig[i] = h;
      }
    }
  }
  return sig;
}

/** Estimated Jaccard similarity = fraction of signature positions that agree. */
export function estimateJaccard(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) {
    return 0;
  }
  let same = 0;
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) {
      same++;
    }
  }
  return same / n;
}

export interface NearDupePair<T> {
  a: T;
  b: T;
  similarity: number;
}

/**
 * Find near-duplicate pairs among items by MinHash similarity ≥ threshold (spec §6: 0.85). O(n²)
 * over precomputed signatures — fine at personal scale; LSH banding is a v1 optimization.
 */
export function nearDupePairs<T>(
  items: T[],
  getContent: (item: T) => string,
  threshold = 0.85,
): NearDupePair<T>[] {
  const sigs = items.map((it) => minhashSignature(getContent(it)));
  const pairs: NearDupePair<T>[] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const similarity = estimateJaccard(sigs[i] as number[], sigs[j] as number[]);
      if (similarity >= threshold) {
        pairs.push({ a: items[i] as T, b: items[j] as T, similarity });
      }
    }
  }
  return pairs;
}
