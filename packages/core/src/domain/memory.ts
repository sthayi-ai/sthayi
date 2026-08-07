export type MemoryType = 'episodic' | 'semantic' | 'procedural';

export type MemoryStatus = 'proposed' | 'confirmed' | 'archived';

/**
 * Provenance travels with every memory so a fact can always be traced back to its origin
 * (which import, which conversation, which client wrote it). Free-form JSON beyond `source`.
 */
export interface Provenance {
  source: string;
  conversationId?: string;
  date?: string;
  /** epoch ms of the import run that created this memory (audit trail); set by
   *  `importMemories`. The memory's `createdAt` may be older — the validated source time. */
  importedAt?: number;
  [key: string]: unknown;
}

/** A single durable memory. Maps 1:1 to a row in the `memories` table (spec §3). */
export interface Memory {
  id: string;
  type: MemoryType;
  /** 'user' | 'project:<name>' */
  scope: string;
  content: string;
  provenance: Provenance;
  /** 0..1 */
  confidence: number;
  boosts: number;
  status: MemoryStatus;
  /** where it came from, e.g. 'cli', 'mcp:claude-desktop', 'import:chatgpt' */
  source: string;
  createdAt: number;
  updatedAt: number;
  lastRetrievedAt: number | null;
  decayAt: number | null;
}

/** Fields a caller may supply when creating a memory; the rest are defaulted by the store layer. */
export interface MemoryDraft {
  type: MemoryType;
  content: string;
  scope?: string;
  provenance?: Provenance;
  confidence?: number;
  status?: MemoryStatus;
  source?: string;
}

export interface MemoryFilter {
  status?: MemoryStatus;
  type?: MemoryType;
  scope?: string;
  limit?: number;
}
