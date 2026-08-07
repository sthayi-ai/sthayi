import { stableStringify } from './stable-stringify.js';

/**
 * Authenticated journal checkpoints. The hash chain alone is tamper-EVIDENT for
 * edits but blind to suffix deletion: whoever can rewrite the SQLite file can also recompute
 * the unkeyed hashes. A checkpoint commits to the chain's count + tip under a keyed MAC
 * (derived from the vault key), and is stored twice: in the db's meta table (updated in the
 * same transaction as every append) and in a file OUTSIDE the database (so replacing the whole
 * db with an older, internally-valid snapshot is still detected). Without the vault key,
 * neither copy can be forged.
 */

/** meta-table key holding the JSON checkpoint (written transactionally with every append). */
export const JOURNAL_CHECKPOINT_KEY = 'journal_checkpoint';

/**
 * Port for the checkpoint copy stored OUTSIDE the database (the CLI keeps it at
 * `~/.sthayi/journal.checkpoint`, written tmp-then-rename, mode 0600). `read` returns the raw
 * stored string or undefined when absent.
 *
 * REPLACEMENT IS COMPARE-AND-SWAP. Both writers of this file (the post-commit mirror
 * `JournalService.flushExternal` and the healing arm of `JournalService.verify`) READ the file
 * and validate the bytes they got back BEFORE they replace them, so the destination can change in
 * between. A replacement that consulted only the earlier value would overwrite whatever arrived in
 * that window — and when what arrived is tamper evidence (unparseable bytes, or a checkpoint that
 * does not authenticate under the vault key) the only record that anything happened is destroyed
 * and verification goes GREEN over the tampering. `replace` therefore takes BOTH the exact
 * expected old bytes and the new bytes, and must re-read the destination under its own
 * serialization before deciding.
 */
export interface CheckpointStore {
  read(): string | undefined;
  /**
   * UNCONDITIONAL replacement. Retained so pre-CAS implementations of this port keep type-checking
   * (and as the fallback `replaceCheckpoint` synthesizes a compare-and-swap from); JournalService
   * itself never calls it directly, because a blind write is exactly the hazard `replace` exists to
   * close.
   */
  write(value: string): void;
  /**
   * Compare-and-swap replacement. Under the implementation's own serialization (the file-backed
   * store takes an interprocess lock), RE-READ the destination and write `next` ONLY while the
   * current bytes still equal `expected` — where `expected === undefined` means "expect absent /
   * create". Returns true when the destination holds `next` afterwards (replaced, or already
   * equal), and false on CONFLICT: the bytes changed under us, they were LEFT BYTE-IDENTICAL, and
   * nothing was written.
   *
   * `opts.force` is the explicit owner-authorized trust decision (`sthayi journal reseal`): it
   * skips the equality check but still runs through the same serialized path. Ordinary appends and
   * verify-healing must NEVER pass it.
   *
   * IT MAY THROW, and a throw says NOTHING about the destination. Failing closed is the correct
   * response to a contended or unreclaimable lock, to an I/O error, and to a destination that
   * turned into a symlink, a special file, an oversized file or a foreign-owned one — the
   * implementation is not required to distinguish them, and callers must not try to infer which
   * happened. What callers MUST NOT do is treat a throw as "unchanged": the bytes passed as
   * `expected` may no longer be at the path at all. Every caller therefore RE-READS and re-validates
   * the destination after a throw (JournalService.verify) or reads it back before claiming success
   * (JournalService.seal), and reports red / partial rather than vouching for stale bytes.
   *
   * Optional so existing stores keep compiling; `replaceCheckpoint` below synthesizes the same
   * semantics from read+write for them (see its honest-boundary note).
   */
  replace?(expected: string | undefined, next: string, opts?: { force?: boolean }): boolean;
}

/**
 * Replace a checkpoint through the store's compare-and-swap when it has one.
 *
 * FALLBACK for stores that predate `replace` (the read-only doctor wrapper, in-memory test
 * doubles): re-read immediately before the write and compare. For a single-process in-memory store
 * that IS a genuine CAS — JavaScript runs the read/compare/write without interleaving. For a
 * file-backed store it only NARROWS the window rather than closing it, which is why the real
 * `FileCheckpoint` implements `replace` itself. What the fallback never does, however narrow the
 * window, is write UNCONDITIONALLY.
 */
export function replaceCheckpoint(
  store: CheckpointStore,
  expected: string | undefined,
  next: string,
  opts?: { force?: boolean },
): boolean {
  if (store.replace) {
    return store.replace(expected, next, opts);
  }
  const current = store.read();
  if (current === next) {
    return true; // already the desired bytes — nothing to write, nothing to destroy
  }
  if (opts?.force !== true && current !== expected) {
    return false;
  }
  store.write(next);
  return true;
}

export interface Checkpoint {
  v: 1;
  /** number of journal entries the checkpoint commits to */
  count: number;
  /** id of the chain tip at seal time */
  tipId: number;
  /** hash of the chain tip at seal time — via prevHash linking this commits to ALL history */
  tipHash: string;
  /** keyed MAC over the other four fields (stable-stringified) */
  mac: string;
}

type MacFn = (data: string) => string;

/** The exact bytes the checkpoint MAC commits to (stable key order, no mac field). */
export function checkpointMac(mac: MacFn, cp: Omit<Checkpoint, 'mac'>): string {
  return mac(stableStringify({ v: cp.v, count: cp.count, tipId: cp.tipId, tipHash: cp.tipHash }));
}

/** Build the serialized checkpoint for a chain of `count` entries ending at (tipId, tipHash). */
export function buildCheckpoint(mac: MacFn, count: number, tipId: number, tipHash: string): string {
  const body = { v: 1 as const, count, tipId, tipHash };
  return JSON.stringify({ ...body, mac: checkpointMac(mac, body) });
}

/** Parse a stored checkpoint. Returns undefined for anything that is not shape-valid v1 JSON. */
export function parseCheckpoint(raw: string): Checkpoint | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') {
    return undefined;
  }
  const p = parsed as Record<string, unknown>;
  if (
    p.v === 1 &&
    typeof p.count === 'number' &&
    Number.isInteger(p.count) &&
    p.count >= 0 &&
    typeof p.tipId === 'number' &&
    Number.isInteger(p.tipId) &&
    typeof p.tipHash === 'string' &&
    typeof p.mac === 'string'
  ) {
    return { v: 1, count: p.count, tipId: p.tipId, tipHash: p.tipHash, mac: p.mac };
  }
  return undefined;
}

/** True iff the checkpoint's MAC recomputes under `mac` (i.e. it was minted with our key). */
export function verifyCheckpoint(mac: MacFn, cp: Checkpoint): boolean {
  return checkpointMac(mac, cp) === cp.mac;
}
