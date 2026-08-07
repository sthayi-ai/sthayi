import { type EntityKind, formatPseudonym } from '../domain/entity.js';
import { newId } from '../domain/ids.js';
import type { StorageDriver } from '../store/driver.js';
import type { CryptoPort } from './crypto.js';
import { type Detection, detect, detectAtRest } from './detectors.js';

export interface VaultConfig {
  terms?: string[];
  now?: () => number;
}

export interface SecretMaskResult {
  masked: string;
  warnings: string[];
}

export interface Mapping {
  kind: EntityKind;
  pseudonym: string;
  value: string;
}

/**
 * The entity vault (spec §1 invariant 5, §6). Allocates stable `KIND_NN` pseudonyms, encrypts the
 * real value (AES-256-GCM via the crypto port), and masks content: SECRETS AND PII at write
 * (the at-rest policy), plus user-configured terms on egress. Same value → same
 * pseudonym, always.
 */
export class VaultService {
  private index: Map<string, string> | null = null;
  private readonly terms: string[];
  private readonly now: () => number;

  constructor(
    private readonly store: StorageDriver,
    private readonly crypto: CryptoPort,
    config: VaultConfig = {},
  ) {
    this.terms = config.terms ?? [];
    this.now = config.now ?? (() => 0);
  }

  /** Build the canonical→pseudonym map and per-kind max counters from the store. Pure read —
   *  never touches instance state (entities are few, so a rebuild per call is cheap). */
  private buildIndex(): { index: Map<string, string>; counts: Map<EntityKind, number> } {
    const index = new Map<string, string>();
    const counts = new Map<EntityKind, number>();
    for (const e of this.store.listEntities()) {
      const value = e.valueEnc ? this.crypto.decrypt(e.valueEnc) : '';
      index.set(`${e.kind}\x00${value}`, e.pseudonym);
      const n = Number.parseInt(e.pseudonym.slice(e.pseudonym.lastIndexOf('_') + 1), 10);
      if (Number.isFinite(n)) {
        counts.set(e.kind, Math.max(counts.get(e.kind) ?? 0, n));
      }
    }
    return { index, counts };
  }

  /** The lookup map: the warm instance cache, else a fresh build. The instance cache is
   *  installed ONLY while no transaction is open — a cache built mid-transaction would hold
   *  UNCOMMITTED mints and outlive their rollback (phantom pseudonyms with no entity row, and
   *  the next mint of a different value re-derives counts from the empty table and collides). */
  private lookupIndex(): Map<string, string> {
    if (this.index) {
      return this.index;
    }
    const { index } = this.buildIndex();
    if (!this.store.inTransaction?.()) {
      this.index = index;
    }
    return index;
  }

  /**
   * Get (or mint) the stable pseudonym for a canonical value. The DATABASE is the allocation
   * authority: the cache is only a fast path for already-known values. A miss re-reads the
   * entities table inside a write transaction (lock held before the read), so a value minted by
   * another process since our cache loaded is found — never re-minted into a collision. When the
   * caller (a memory write) already holds the write transaction, the mint joins it, so a failed
   * containing write leaves no orphan entity row.
   */
  allocate(kind: EntityKind, value: string): string {
    const key = `${kind}\x00${value}`;
    const cached = this.lookupIndex().get(key);
    if (cached) {
      return cached;
    }
    return this.store.writeTransaction(() => {
      // Re-derive from the table INSIDE the write lock, into locals — never instance state.
      const { index, counts } = this.buildIndex();
      const existing = index.get(key);
      if (existing) {
        return existing;
      }
      const n = (counts.get(kind) ?? 0) + 1;
      const pseudonym = formatPseudonym(kind, n);
      this.store.insertEntity({
        id: newId(),
        kind,
        valueEnc: this.crypto.encrypt(value),
        pseudonym,
        sensitivity: kind === 'APIKEY' ? 'secret' : 'pii',
        createdAt: this.now(),
      });
      // Never cache a mint from inside an open transaction: if the containing write rolls back,
      // a cached mapping would point at a row that no longer exists. Invalidate instead — the
      // next lookup re-reads (and mid-transaction still sees this row on the same connection,
      // via the transaction-local build above).
      this.index = null;
      return pseudonym;
    });
  }

  private replace(content: string, dets: Detection[]): string {
    let out = content;
    for (const d of [...dets].sort((a, b) => b.start - a.start)) {
      out = out.slice(0, d.start) + this.allocate(d.kind, d.value) + out.slice(d.end);
    }
    return out;
  }

  /**
   * The at-rest masking policy (invariant 5): mask SECRETS and PII (email/phone/SSN/
   * card) at write time so neither is ever plaintext at rest — memory content/scope/source/
   * provenance and journal payloads all pass through here. User-configured terms are deliberately
   * NOT masked at rest (egress-only; `maskForEgress` is the superset). Each first sighting of a
   * value warns, e.g. 'masked a EMAIL at write → EMAIL_01'.
   */
  maskAtRest(content: string): SecretMaskResult {
    const dets = detectAtRest(content);
    if (dets.length === 0) {
      return { masked: content, warnings: [] };
    }
    const masked = this.replace(content, dets);
    const warnings: string[] = [];
    const seen = new Set<string>();
    for (const d of dets) {
      if (!seen.has(d.value)) {
        seen.add(d.value);
        warnings.push(
          `masked a ${d.kind === 'APIKEY' ? 'secret' : d.kind} at write → ${this.allocate(d.kind, d.value)}`,
        );
      }
    }
    return { masked, warnings };
  }

  /**
   * Alias for {@link maskAtRest}, retained because the write-time masker interfaces bind by this
   * name (`SecretMasker` in memory/service and `JournalServiceOptions.masker`) and the store
   * wiring passes the vault itself. The write-time policy covers PII too — the
   * name understates it; prefer `maskAtRest` in new code.
   */
  maskSecrets(content: string): SecretMaskResult {
    return this.maskAtRest(content);
  }

  /** Mask secrets AND PII AND user terms for egress (packs, oracle batches). */
  maskForEgress(content: string): string {
    return this.replace(content, detect(content, { terms: this.terms }));
  }

  /** Local pseudonym→value mapping for `sthayi entities` (never leaves the machine). */
  listMappings(): Mapping[] {
    return this.store.listEntities().map((e) => ({
      kind: e.kind,
      pseudonym: e.pseudonym,
      value: e.valueEnc ? this.crypto.decrypt(e.valueEnc) : '',
    }));
  }
}
