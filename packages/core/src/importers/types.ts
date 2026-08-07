import type { MemoryType, Provenance } from '../domain/memory.js';

/** A memory extracted from an export, ready to enter the store as a proposal. */
export interface ImportedMemory {
  type: MemoryType;
  content: string;
  scope: string;
  confidence: number;
  provenance: Provenance;
  /**
   * Validated source creation time, epoch ms. Parsers set it only when the export
   * carries a plausible timestamp (finite, after 2000-01-01, no more than 24h in the future);
   * `importMemories` then uses it as the memory's `createdAt` so ranking/decay treat the memory
   * as old as its source. Absent → `createdAt` falls back to import time.
   */
  sourceCreatedAt?: number;
}

export interface ImportResult {
  source: string;
  memories: ImportedMemory[];
  /** non-fatal problems (missing files, unparseable entries) — surfaced, never thrown */
  warnings: string[];
}

/** Extracted archive: map of entry path → text content. Parsers are pure over this. */
export type SourceFiles = Record<string, string>;
