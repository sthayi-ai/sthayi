/**
 * Crypto port. Entity canonicals are AES-256-GCM encrypted at rest (spec §1 invariant 5). The
 * concrete implementation (node:crypto + the `~/.sthayi/key` file, chmod 600) is injected from
 * `packages/cli` so `packages/core` stays browser-clean; a possible future browser/PWA build could
 * supply a WebCrypto implementation.
 */
export interface CryptoPort {
  /** Encrypt UTF-8 plaintext → opaque blob (iv‖tag‖ciphertext). */
  encrypt(plaintext: string): Uint8Array;
  /** Decrypt a blob produced by `encrypt`. Throws on tamper (GCM auth failure). */
  decrypt(blob: Uint8Array): string;
  /**
   * Keyed MAC over UTF-8 `data` → lowercase hex (HMAC-SHA-256). The key MUST be derived from the
   * vault key (never the raw AES key itself — NodeCrypto uses HKDF with a dedicated info label).
   * Authenticates journal checkpoints: without the vault key, checkpoints cannot be
   * forged, so journal truncation/replacement is detectable. Optional so minimal fakes and future
   * ports stay valid — an implementation without `mac` disables checkpointing
   * (verify() reports state 'checkpoint-disabled').
   */
  mac?(data: string): string;
}
