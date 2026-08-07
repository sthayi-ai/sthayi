import crypto from 'node:crypto';
import fs from 'node:fs';
import type { CryptoPort } from '@sthayi/core';
import { ensureTrustedContainingDir, untrustedContainingDirReason } from '../fs-safe.js';

/** O_NOFOLLOW / O_NONBLOCK where the platform provides them (POSIX); 0 (no-op) where it does not. */
const O_NOFOLLOW: number =
  (fs.constants as unknown as Record<string, number | undefined>).O_NOFOLLOW ?? 0;
const O_NONBLOCK: number =
  (fs.constants as unknown as Record<string, number | undefined>).O_NONBLOCK ?? 0;

/** Byte cap for the key file: the vault key is 32 bytes. Anything remotely near this cap is
 *  already a "restore from backup" situation, so the read never buffers a large planted file. */
const KEY_READ_CAP_BYTES = 4 * 1024;

/**
 * node:crypto implementation of the vault CryptoPort. AES-256-GCM with a 32-byte key stored at
 * `~/.sthayi/key` (chmod 600, generated on first use). Blob layout: iv(12) ‖ tag(16) ‖ ciphertext.
 * Lives in `packages/cli` so `packages/core` stays browser-clean.
 */
export class NodeCrypto implements CryptoPort {
  /** Dedicated MAC key, HKDF-derived from the vault key — the AES key is NEVER used directly. */
  private readonly macKey: Buffer;

  private constructor(private readonly key: Buffer) {
    this.macKey = Buffer.from(
      crypto.hkdfSync('sha256', key, Buffer.alloc(0), 'sthayi/journal-checkpoint/v1', 32),
    );
  }

  /** Shared with loadExisting: the one place the key-shape rule lives. */
  private static assertKeyLength(key: Buffer, keyPath: string): void {
    if (key.length !== 32) {
      throw new Error(
        `${keyPath} is malformed: must be a 32-byte key (found ${key.length} bytes). Remove it to regenerate (this discards vaulted entities).`,
      );
    }
  }

  /**
   * The trust rules for the key file itself, shared by the lstat (path) form and the fstat (open
   * fd) form so a path swapped between them cannot buy a weaker check. A regular file (never a
   * symlink), owned by the current user, with NO group/world access at all (a readable key is a
   * leaked key). POSIX ownership/mode checks are meaningless on Windows and are skipped there.
   *
   * NOT checked: hard-link count. The first-run publish deliberately hard-links a private temp
   * into place (publishKeyExclusive), so a sibling process legitimately observes nlink 2 for an
   * instant; ownership plus the 0600 requirement already exclude an alias to a foreign file.
   */
  private static untrustedKeyStatReason(st: fs.Stats, keyPath: string): string | undefined {
    if (st.isSymbolicLink()) {
      return `${keyPath} is a symlink — refusing to use it; restore the real key file (the link target was not touched)`;
    }
    if (!st.isFile()) {
      return `${keyPath} is not a regular file — refusing to use it; remove whatever occupies that path and restore the key from backup`;
    }
    if (process.platform !== 'win32') {
      if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
        return `${keyPath} is not owned by the current user — refusing to use it; restore ownership or restore the key from backup`;
      }
      if ((st.mode & 0o077) !== 0) {
        return `${keyPath} is group- or world-accessible (mode ${(st.mode & 0o777).toString(8)}) — refusing to use it; run: chmod 600 ${keyPath}`;
      }
    }
    return undefined;
  }

  /**
   * Validate the key path before ANY use (the key is the vault's trust anchor — same fail-closed
   * treatment as FileCheckpoint.assertSafePath). Absent is fine: open() creates, loadExisting()
   * reports the loss.
   *
   * The WHOLE chain leading to the key is validated first — every ancestor down to the containing
   * directory must be a real, non-symlink directory (up to the established home boundary when one
   * exists, from the filesystem ROOT otherwise). Validating only the key FILE leaves the same
   * raw-parent hole any path-based open has: an lstat of `<hop>/key` says nothing about `hop`, so
   * a symlinked ancestor at any depth would serve (or receive) a vault key from a tree that was
   * never validated, and could be repointed afterwards. An ABSENT containing directory is simply
   * "no key here" — the create path builds it, one validated level at a time.
   */
  private static assertSafeKeyPath(keyPath: string): void {
    const chainReason = untrustedContainingDirReason(keyPath, `vault key at ${keyPath}`);
    if (chainReason === 'absent') {
      return; // no containing directory — the key cannot exist, and nothing was read
    }
    if (chainReason) {
      throw new Error(chainReason);
    }
    let st: fs.Stats;
    try {
      st = fs.lstatSync(keyPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return; // absent — open() creates it, loadExisting() throws its restore-from-backup error
      }
      throw new Error(
        `vault key at ${keyPath} could not be inspected (${(err as NodeJS.ErrnoException).code ?? 'unknown error'}) — refusing to use it`,
      );
    }
    const reason = NodeCrypto.untrustedKeyStatReason(st, keyPath);
    if (reason) {
      throw new Error(reason);
    }
  }

  static open(keyPath: string): NodeCrypto {
    NodeCrypto.assertSafeKeyPath(keyPath);
    // ABSENCE — and nothing else — is what falls through to minting a key; every other failure
    // propagates. Wrapping the read in a bare `catch` that generated a fresh key on ANY failure
    // would turn a refusal or an unreadable key file into the silent orphaning of every vaulted
    // entity, because a regenerated key cannot decrypt what the previous one sealed.
    let key = NodeCrypto.readKeyRetrying(keyPath);
    if (key === undefined) {
      // Whole-chain validated creation, one level at a time — never a recursive mkdir, which
      // would resolve a symlinked ancestor in the kernel and mint the vault key inside it.
      ensureTrustedContainingDir(keyPath, `refusing to create the vault key at ${keyPath}`, {
        mode: 0o700,
      });
      key = NodeCrypto.publishKeyExclusive(keyPath, crypto.randomBytes(32));
      try {
        fs.chmodSync(keyPath, 0o600);
      } catch {
        // best-effort on platforms without POSIX modes
      }
    }
    NodeCrypto.assertKeyLength(key, keyPath);
    return new NodeCrypto(key);
  }

  /**
   * Publish a freshly generated key so its name becomes visible ATOMICALLY with its full
   * content. A direct 'wx' write has a window where the name exists with 0 bytes and a
   * concurrent first-run sibling spuriously fails its length check; writing a private temp and
   * hardlinking it into place keeps the exactly-one-winner semantics (link fails EEXIST) with
   * no partial-content state ever visible. Returns the winning key — ours, or the fully
   * published one another process linked first.
   */
  private static publishKeyExclusive(keyPath: string, key: Buffer): Buffer {
    const tmp = `${keyPath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, key, { mode: 0o600, flag: 'wx' });
    try {
      fs.linkSync(tmp, keyPath);
      return key;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        // Another process won the race — validate what it published, then adopt it.
        return NodeCrypto.adoptPublishedKey(keyPath);
      }
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS' || code === 'EOPNOTSUPP') {
        // Filesystem without hardlink support: fall back to the direct exclusive create.
        // Readers tolerate the (now again possible) transient short state via readKeyRetrying.
        try {
          fs.writeFileSync(keyPath, key, { mode: 0o600, flag: 'wx' });
          return key;
        } catch (err2) {
          if ((err2 as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw err2;
          }
          return NodeCrypto.adoptPublishedKey(keyPath);
        }
      }
      throw err;
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // already consumed by a successful link, or never created
      }
    }
  }

  /** Re-validate and adopt a key another process published while we were racing it. */
  private static adoptPublishedKey(keyPath: string): Buffer {
    NodeCrypto.assertSafeKeyPath(keyPath);
    const adopted = NodeCrypto.readKeyRetrying(keyPath);
    if (adopted === undefined) {
      throw new Error(
        `${keyPath} was published by a concurrent process and then vanished — refusing to mint a replacement key (a regenerated key cannot decrypt existing entities); re-run the command`,
      );
    }
    return adopted;
  }

  /**
   * Read the key through a descriptor WE opened: O_NOFOLLOW so a symlink swapped in after the
   * lstat gate is refused rather than followed, O_NONBLOCK so a planted FIFO cannot hang the
   * process, the trust rules REPEATED via fstat on that very fd (what we validate is the inode we
   * hold open, immune to a path swap), and a capped read loop with a limit+1 sentinel so a file
   * that GROWS after the fstat is refused instead of buffered. A plain `fs.readFileSync(keyPath)`
   * has none of it: a path-based, unbounded read of the vault's trust anchor.
   *
   * Returns undefined when the key is ABSENT — the one condition open() may answer by creating.
   */
  private static readKeyOnce(keyPath: string): Buffer | undefined {
    let fd: number;
    try {
      fd = fs.openSync(keyPath, fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return undefined; // absent — never a retry, never an error
      }
      if (code === 'ELOOP') {
        throw new Error(
          `${keyPath} is a symlink — refusing to use it; restore the real key file (the link target was not touched)`,
        );
      }
      throw err;
    }
    try {
      const st = fs.fstatSync(fd);
      const reason = NodeCrypto.untrustedKeyStatReason(st, keyPath);
      if (reason) {
        throw new Error(reason);
      }
      if (st.size > KEY_READ_CAP_BYTES) {
        throw new Error(
          `${keyPath} is ${st.size} bytes — over the ${KEY_READ_CAP_BYTES}-byte cap for a 32-byte vault key; refusing to read it (remove or restore the real key file)`,
        );
      }
      const buf = Buffer.alloc(KEY_READ_CAP_BYTES + 1);
      let total = 0;
      for (;;) {
        const n = fs.readSync(fd, buf, total, KEY_READ_CAP_BYTES + 1 - total, null);
        if (n === 0) {
          break;
        }
        total += n;
        if (total > KEY_READ_CAP_BYTES) {
          throw new Error(
            `${keyPath} produced more than the ${KEY_READ_CAP_BYTES}-byte cap (it grew while being read) — refusing to read it`,
          );
        }
      }
      return Buffer.from(buf.subarray(0, total));
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * Read the key, tolerating the tiny window where a FALLBACK direct-create writer (no-hardlink
   * filesystems only) has made the name visible but not yet written its bytes. Absence is
   * reported immediately (undefined) — absent means absent, never a retry.
   */
  private static readKeyRetrying(keyPath: string): Buffer | undefined {
    let key = NodeCrypto.readKeyOnce(keyPath);
    for (let attempt = 0; key !== undefined && key.length < 32 && attempt < 20; attempt++) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      key = NodeCrypto.readKeyOnce(keyPath);
    }
    return key;
  }

  /**
   * Load an EXISTING key or throw — NEVER generates or writes one. `doctor` uses this
   * so a missing key is a diagnosable disaster (restore from backup), not a silent regeneration
   * that permanently orphans every encrypted entity.
   */
  static loadExisting(keyPath: string): NodeCrypto {
    NodeCrypto.assertSafeKeyPath(keyPath);
    // Trust refusals from the hardened read propagate verbatim; only genuine ABSENCE becomes the
    // restore-from-backup message (reporting a hijack as "missing" would send the user to a
    // restore instead of to the planted file).
    const key = NodeCrypto.readKeyOnce(keyPath);
    if (key === undefined) {
      throw new Error(
        `vault key missing at ${keyPath} (ENOENT) — restore it from backup; a regenerated key cannot decrypt existing entities`,
      );
    }
    NodeCrypto.assertKeyLength(key, keyPath);
    return new NodeCrypto(key);
  }

  encrypt(plaintext: string): Uint8Array {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return new Uint8Array(Buffer.concat([iv, cipher.getAuthTag(), enc]));
  }

  decrypt(blob: Uint8Array): string {
    const b = Buffer.from(blob);
    const iv = b.subarray(0, 12);
    const tag = b.subarray(12, 28);
    const enc = b.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  }

  /** Keyed MAC (HMAC-SHA-256, hex) over the HKDF-derived checkpoint key — see CryptoPort.mac. */
  mac(data: string): string {
    return crypto.createHmac('sha256', this.macKey).update(data, 'utf8').digest('hex');
  }
}
