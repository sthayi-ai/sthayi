import {
  type ImportResult,
  type MutationOutcome,
  parseChatgptExport,
  parseClaudeExport,
  parseGeminiExport,
} from '@sthayi/core';
import type { Store } from '../store.js';
import { detectSource } from './detect.js';
import { loadArchive } from './load.js';

export interface ImportSummary {
  source: string;
  total: number;
  imported: number;
  skipped: number;
  warnings: string[];
  /**
   * WHAT THE IMPORT'S JOURNAL ENTRY ACHIEVED — REQUIRED, not an optional extra.
   *
   * An import is one journaled write of potentially thousands of rows, so it has the same three
   * outcomes every other write has, and the middle one is the expensive one to lose: the rows and
   * the `import` entry are DURABLE while the off-database anchor did not advance, so the store has
   * stopped accepting writes and re-running the import would duplicate every memory it just wrote.
   * `MemoryService.importMemories` returns that outcome attached to its counts; a summary that
   * simply did not have a field for it turned the whole archive into "Imported N memories" at exit
   * 0. Required here means the summary CANNOT be built without carrying it forward.
   *
   * A LIVE view of the underlying write, read on access — the same rule the domain values follow,
   * so a composed import inside a caller's transaction cannot freeze at 'in-flight'.
   */
  readonly outcome: MutationOutcome;
}

/** Load → detect → parse (core) → dedup + write proposals + journal. Loader containment
 *  warnings (skipped symlinks, hostile entry names) surface in the summary's warnings; loader
 *  LIMIT violations throw before any store transaction opens. */
export async function runImport(
  archivePath: string,
  store: Store,
  now: number,
): Promise<ImportSummary> {
  const loadWarnings: string[] = [];
  const files = await loadArchive(archivePath, { warn: (m) => loadWarnings.push(m) });
  const source = detectSource(files);
  if (!source) {
    const found = Object.keys(files).slice(0, 8).join(', ') || '(no recognized files)';
    throw new Error(
      `could not detect an export type in ${archivePath}. Recognized files found: ${found}`,
    );
  }

  const result: ImportResult =
    source === 'claude'
      ? parseClaudeExport(files)
      : source === 'chatgpt'
        ? parseChatgptExport(files)
        : parseGeminiExport(files);

  const written = store.memory.importMemories(result.memories, {
    now,
    actor: 'import',
    source,
  });
  return {
    source,
    total: result.memories.length,
    imported: written.imported,
    skipped: written.skipped,
    warnings: [...loadWarnings, ...result.warnings],
    // Destructuring the counts and dropping the rest is what lost this: `outcome` is
    // NON-ENUMERABLE on the returned value, so `{ ...written }` and `const { imported, skipped }`
    // both leave it behind silently. Named explicitly, and as a getter so it stays the live view.
    get outcome(): MutationOutcome {
      return written.outcome;
    },
  };
}
