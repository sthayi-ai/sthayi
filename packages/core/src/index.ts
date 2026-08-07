// Domain types
export type {
  Memory,
  MemoryDraft,
  MemoryFilter,
  MemoryStatus,
  MemoryType,
  Provenance,
} from './domain/memory.js';
export type { Skill } from './domain/skill.js';
export type { McpEntry, McpTransport } from './domain/mcp.js';
export type { Entity, EntityKind } from './domain/entity.js';
export { PSEUDONYM_RE, formatPseudonym } from './domain/entity.js';
export type { Proposal, ProposalAction } from './domain/proposal.js';
export type {
  AnchorOutcome,
  ChainVerification,
  CommitReceipt,
  JournalDraft,
  JournalRecord,
  MutationOutcome,
  SealedJournalEntry,
} from './domain/journal.js';
export { committedReceipts, describeReceipt, isDegradedReceipt } from './domain/journal.js';
export { newId, isId } from './domain/ids.js';

// Store port + schema/migrations
export type {
  StorageDriver,
  MemorySearchRow,
  SearchOptions,
  AssocEdgeRow,
} from './store/driver.js';
export { BOOTSTRAP_META } from './store/schema.js';
export {
  MIGRATIONS,
  type Migration,
  SCHEMA_VERSION_KEY,
  latestVersion,
  pendingMigrations,
} from './store/migrations.js';

// Journal
export { sha256 } from './journal/sha256.js';
export { stableStringify } from './journal/stable-stringify.js';
export { computeHash, sealEntry, verifyChain } from './journal/journal.js';
export {
  type Checkpoint,
  type CheckpointStore,
  JOURNAL_CHECKPOINT_KEY,
  buildCheckpoint,
  checkpointMac,
  parseCheckpoint,
  verifyCheckpoint,
} from './journal/checkpoint.js';
export {
  type AppliedChange,
  AppliedChangeSchema,
  type ConsolidatePayload,
  ConsolidatePayloadSchema,
  type InsertDigestFields,
  memoryInsertDigest,
  type RollbackPlan,
  planRollback,
} from './journal/rollback.js';
export {
  JOURNAL_TX_TOKEN_KEY,
  type JournalAppend,
  JournalService,
  type JournalServiceOptions,
  type SealResult,
} from './journal/service.js';

// Samskara association layer (journal-folded derived graph + spreading activation)
export {
  EDGE_HALF_LIFE_DAYS,
  coRetrievalDeltas,
  decayedWeight,
  foldRecord,
  type AssocKind,
  type EdgeDelta,
  type FoldStep,
  type Rewire,
} from './assoc/fold.js';
export { GAMMA, FRONTIER, spreadActivation, type SpreadEdge } from './assoc/spread.js';
export { AssocService, ASSOC_CURSOR_KEY } from './assoc/service.js';

// Search + memory service
export { sanitizeFtsQuery, queryTokens } from './search/query.js';
export { compositeScore, recencyBoost } from './search/rank.js';
export {
  type Journaled,
  MemoryService,
  type RankedHit,
  type TransitionOptions,
  type WriteOptions,
  type SearchParams,
  type SecretMasker,
} from './memory/service.js';

// Vault (detectors + pseudonyms + AES-GCM crypto port) and memory packs
export type { CryptoPort } from './vault/crypto.js';
export { maskDeep } from './vault/mask-deep.js';
export { type Detection, detect, detectAtRest, detectSecrets } from './vault/detectors.js';
export {
  VaultService,
  type VaultConfig,
  type SecretMaskResult,
  type Mapping,
} from './vault/vault.js';
export { buildPack, type PackOptions } from './pack/builder.js';

// Consolidation Protocol (deterministic passes + oracle runner)
export {
  shingles,
  minhashSignature,
  estimateJaccard,
  nearDupePairs,
  type NearDupePair,
} from './consolidate/minhash.js';
export {
  effectiveConfidence,
  shouldArchive,
  DEFAULT_DECAY,
  type DecayConfig,
} from './consolidate/decay.js';
export { OracleOutputSchema, type OracleOutput } from './consolidate/oracle/schema.js';
export {
  validateOracleOutput,
  runOracleBatch,
  MAX_BATCH,
  type ProviderPort,
  type BatchItem,
  type OracleRunResult,
} from './consolidate/oracle/runner.js';
export {
  ConsolidationService,
  type DeterministicReport,
  type OracleReport,
  PartialOracleRunError,
  type RollbackRefused,
  type RollbackReport,
  type RollbackReverted,
} from './consolidate/service.js';

// Importers (pure parsers: bytes → proposals)
export type { ImportedMemory, ImportResult, SourceFiles } from './importers/types.js';
export { parseClaudeExport } from './importers/claude.js';
export { parseChatgptExport } from './importers/chatgpt.js';
export { parseGeminiExport, parseGems } from './importers/gemini.js';
export {
  contentHash,
  dedupeKey,
  normalizeContent,
  pick,
  sourceTimestamp,
  truncate,
} from './importers/util.js';
