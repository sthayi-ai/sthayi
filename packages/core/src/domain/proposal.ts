import type { MemoryDraft } from './memory.js';

/**
 * The unit of "the oracle proposes; the runtime disposes". Every write (from an agent,
 * an importer, or a consolidation job) enters as a proposal and is confirmed/rejected
 * through the journal — nothing is ever silently applied.
 */
export interface Proposal {
  draft: MemoryDraft;
  /** why this was proposed — surfaced in the review queue */
  reason?: string;
}

export type ProposalAction = 'list' | 'confirm' | 'reject';
