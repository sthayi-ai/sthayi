import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  type CommitReceipt,
  ConsolidationService,
  type JournalRecord,
  type MemoryType,
  type MutationOutcome,
  PartialOracleRunError,
  type ProviderPort,
  buildPack,
  committedReceipts,
  describeReceipt,
  isDegradedReceipt,
} from '@sthayi/core';
import { Command } from 'commander';
import { z } from 'zod';
import { formatScore, humanAge, padEndVisible, snippet } from './format.js';
import { safeWriteFileAtomic, untrustedFileReason, untrustedStatReason } from './fs-safe.js';
import { assertReadOnlySthayiHome, dbPath, keyPath, sthayiHome, sthayiHomeRoot } from './paths.js';
import { assertSupportedNodeRuntime, cliFailureMessage } from './runtime-guard.js';
import {
  EXIT_COMMITTED_UNANCHORED,
  REPAIR_LINES,
  type StartupBlocked,
  type StartupStep,
  StartupUnanchoredError,
  foldAssoc,
  openCliStore,
  reportStartupBlocked,
  settleCliStore,
} from './store.js';
import { VERSION } from './version.js';

/** Single source of truth: ./version.ts (coherence with package.json enforced by version.test.ts). */
export { VERSION };

interface CommandSpec {
  name: string;
  milestone: string;
  summary: string;
}

/** The full v0 CLI surface (spec §0). `--help` lists them all. */
export const COMMANDS: readonly CommandSpec[] = [
  { name: 'init', milestone: 'B4', summary: 'Initialize ~/.sthayi and run the first-run wizard' },
  { name: 'serve', milestone: 'B3', summary: 'Run the stdio MCP server' },
  { name: 'wire', milestone: 'B4', summary: 'Wire Sthayi into detected AI clients' },
  {
    name: 'unwire',
    milestone: 'B4',
    summary: 'Remove Sthayi from client configs (byte-exact restore)',
  },
  { name: 'status', milestone: 'B4', summary: 'Show per-client detection and wiring status' },
  { name: 'add', milestone: 'B2', summary: 'Add a memory' },
  {
    name: 'search',
    milestone: 'B2',
    summary: 'Search memories (FTS5 + confidence/recency ranking)',
  },
  { name: 'review', milestone: 'B2', summary: 'List, confirm, or reject proposed memories' },
  { name: 'import', milestone: 'B5', summary: 'Import a ChatGPT / Claude / Gemini export' },
  {
    name: 'consolidate',
    milestone: 'B7',
    summary: 'Run consolidation passes (deterministic; optional --oracle BYO-LLM pass)',
  },
  { name: 'pack', milestone: 'B6', summary: 'Export a scoped, masked memory pack (context.md)' },
  { name: 'entities', milestone: 'B6', summary: 'List local pseudonym → value mappings' },
  { name: 'journal', milestone: 'B1', summary: 'Show recent journal entries and verify the chain' },
  {
    name: 'index',
    milestone: 'B9',
    summary: 'Derived-index maintenance (rebuild/status of the Samskara association graph)',
  },
  { name: 'rollback', milestone: 'B7', summary: 'Revert a consolidation batch by journal id' },
  {
    name: 'qualify',
    milestone: 'B7',
    summary: 'Run the conformance suite against a provider:model',
  },
  { name: 'doctor', milestone: 'B8', summary: 'Diagnose the install and per-client wiring' },
];

/** Commands with a real implementation (the rest are milestone-tagged stubs). */
const IMPLEMENTED = new Set([
  'add',
  'search',
  'review',
  'index',
  'journal',
  'serve',
  'init',
  'wire',
  'unwire',
  'status',
  'import',
  'pack',
  'entities',
  'consolidate',
  'qualify',
  'rollback',
  'doctor',
]);

const AddOptions = z.object({
  type: z.enum(['episodic', 'semantic', 'procedural']),
  scope: z.string().min(1),
  confidence: z.coerce.number().min(0).max(1),
});

function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

/**
 * The exit code and the repair wording live BESIDE the startup channel in ./store.ts, because the
 * gate that reports the channel is reached from two module layers: this file's commands, and
 * `init`'s wizard in ./clients/commands.ts. Re-exported here so the CLI's public surface still
 * names its own exit code.
 */
export { EXIT_COMMITTED_UNANCHORED };

/**
 * Render every durable-but-unanchored receipt an operation produced, and set the distinct exit
 * code. Returns true when at least one was degraded, so the caller can print the DEGRADED report
 * INSTEAD of its ordinary success line — an operation that left the store unable to accept writes
 * must not look like one that succeeded.
 *
 * It takes OUTCOMES and narrows to the committed ones itself: a command that ran to completion has
 * committed transactions, and any other state is not something to exit 3 over.
 */
function reportOutcomes(outcomes: readonly MutationOutcome[]): boolean {
  const receipts: readonly CommitReceipt[] = committedReceipts(outcomes);
  const degraded = receipts.filter((r) => isDegradedReceipt(r));
  if (degraded.length === 0) {
    return false;
  }
  for (const r of degraded) {
    out(describeReceipt(r));
    for (const line of REPAIR_LINES) {
      out(line);
    }
    out('  Do NOT re-run this command — the write above is already durable.');
  }
  process.exitCode = EXIT_COMMITTED_UNANCHORED;
  return true;
}

function registerAdd(program: Command): void {
  program
    .command('add')
    .description('Add a memory (a proposal by default; --confirm to store it confirmed)')
    .argument('<content...>', 'the memory text')
    .option('-t, --type <type>', 'episodic | semantic | procedural', 'semantic')
    .option('-s, --scope <scope>', 'scope: user | project:<name>', 'user')
    .option('-c, --confidence <n>', 'confidence 0..1', '0.6')
    .option('--confirm', 'store as confirmed instead of a proposal', false)
    .action(
      (
        contentParts: string[],
        raw: { type: string; scope: string; confidence: string; confirm: boolean },
      ) => {
        const parsed = AddOptions.safeParse(raw);
        if (!parsed.success) {
          process.stderr.write(
            `invalid options: ${parsed.error.issues.map((i) => i.message).join('; ')}\n`,
          );
          process.exitCode = 1;
          return;
        }
        const store = openCliStore();
        if (store === undefined) {
          return;
        }
        try {
          const warnings: string[] = [];
          const m = store.memory.add(
            {
              type: parsed.data.type,
              scope: parsed.data.scope,
              content: contentParts.join(' '),
              confidence: parsed.data.confidence,
              source: 'cli',
            },
            { now: Date.now(), actor: 'cli', asProposal: !raw.confirm, warnings },
          );
          for (const w of warnings) {
            out(`  ⚠ ${w}`);
          }
          // The outcome rides on the returned memory and is read AFTER the write returned, i.e.
          // after its transaction committed and the post-commit mirror ran — the only moment the
          // anchor's fate is known.
          if (reportOutcomes([m.outcome])) {
            out(`  the memory IS stored: ${m.status} ${m.type} ${m.id} [scope ${m.scope}]`);
            return;
          }
          out(`added ${m.status} ${m.type} memory ${m.id} [scope ${m.scope}]`);
        } finally {
          store.close();
        }
      },
    );
}

/**
 * The JSON form of one {@link MutationOutcome} — `search --json`'s second member.
 *
 * The four states of the domain union survive as `state`, and the 'committed' branch carries the
 * receipt's facts flattened alongside it: `committed` (always true on that branch), the journal id,
 * the anchor, `writesBlocked` and `doNotRetry` as booleans a script can branch on, and `message` as
 * the same sentence the human-readable surfaces print. A consumer that reads only `anchor` learns
 * enough; a consumer that reads only `message` learns enough; neither has to infer the other.
 */
type MutationJson =
  | { state: 'no-entry' | 'in-flight' | 'rolled-back' }
  | {
      state: 'committed';
      committed: true;
      journalId: number;
      anchor: CommitReceipt['anchor'];
      writesBlocked: boolean;
      doNotRetry: boolean;
      ids?: string[];
      reason?: string;
      message: string;
    };

/**
 * The JSON form of ONE startup step that COMMITTED while the off-database anchor did not advance —
 * `search --json`'s report when the command itself never ran.
 *
 * Opening the store is not read-only, so a `--json` invocation can be over before its own work
 * starts: the first-run seal or the legacy-PII migration commits, the anchor does not follow, the
 * store stops accepting writes, and the search is refused. The human surfaces print that as prose.
 * A machine surface may NOT — prose beside the payload does not warn a parser, it makes the whole
 * stream unparseable — so every fact the prose states is a FIELD here instead: which step
 * (`step`), that it is durable (`committed`), that re-running cannot undo or redo it
 * (`doNotRetry`), that the store refuses further writes (`writesBlocked`), the journal id and
 * anchor for the step that appends an entry, and the one repair, worded once in
 * {@link REPAIR_LINES} so the JSON and the prose cannot describe the same state two ways.
 * `message` carries the identical sentence a human reads, as a value inside the document.
 */
interface StartupJson {
  step: StartupStep;
  state: 'committed-unanchored';
  committed: true;
  doNotRetry: true;
  writesBlocked: true;
  journalId?: number;
  anchor?: CommitReceipt['anchor'];
  message: string;
  repair: string;
}

/**
 * The three booleans are the DEFINITION of the state rather than a re-reading of the receipt: a
 * step is in the `committed-unanchored` branch precisely when its database half is durable, its
 * anchor did not follow, and further writes are blocked. The receipt adds the journal id and the
 * anchor for the steps that append an entry (the PII migration); the first-run seal has none, so
 * those two members are absent rather than invented.
 */
function startupJson(blocked: StartupBlocked): StartupJson {
  const r = blocked.receipt;
  return {
    step: blocked.step,
    state: 'committed-unanchored',
    committed: true,
    doNotRetry: true,
    writesBlocked: true,
    ...(r === undefined ? {} : { journalId: r.journalId, anchor: r.anchor }),
    message: blocked.message,
    repair: REPAIR_LINES.map((l) => l.trim()).join(' '),
  };
}

/**
 * The `search --json` document — ONE per invocation, whatever happened, discriminated by `ran`.
 *
 * `ran: false` carries the blocked startup and NO `hits` member, deliberately: a consumer reading
 * `hits.length` off an empty array would conclude "no matches" about a search that never ran. The
 * absent member makes that reading impossible, `ran` makes the state explicit, and the exit code
 * is still {@link EXIT_COMMITTED_UNANCHORED}. `startup` is present on both branches — empty when
 * the store opened cleanly — so "read `startup`" is always a valid thing for a script to do.
 */
type SearchJson =
  | { ran: false; startup: StartupJson[] }
  | { ran: true; startup: StartupJson[]; hits: unknown; mutation: MutationJson };

function mutationJson(outcome: MutationOutcome): MutationJson {
  if (outcome.state !== 'committed') {
    return { state: outcome.state };
  }
  const r = outcome.receipt;
  return {
    state: 'committed',
    committed: r.committed,
    journalId: r.journalId,
    anchor: r.anchor,
    writesBlocked: r.writesBlocked,
    doNotRetry: r.doNotRetry,
    ...(r.ids === undefined ? {} : { ids: r.ids }),
    ...(r.reason === undefined ? {} : { reason: r.reason }),
    message: describeReceipt(r),
  };
}

function registerSearch(program: Command): void {
  program
    .command('search')
    .description('Search memories, ranked by bm25 × confidence × recency (+ associative recall)')
    .argument('<query...>', 'search text')
    .option('-k, --k <n>', 'max results', '8')
    .option('-s, --scope <scope>', 'only search this scope (e.g. user, project:<name>)')
    .option('--json', 'output JSON', false)
    .option('--no-assoc', 'disable Samskara associative recall (lexical ranking only)')
    .action(
      (queryParts: string[], raw: { k: string; scope?: string; json: boolean; assoc: boolean }) => {
        const now = Date.now();
        const k = Number.parseInt(raw.k, 10) || 8;
        // THE GATE IS SETTLED WITHOUT PRINTING, so each output mode reports the same facts in the
        // shape this invocation promised. Opening the store can commit the first-run seal or the
        // PII migration unanchored, and the prose report that fact deserves would land on stdout
        // AHEAD of a `--json` payload the caller pipes into a parser — one stream, two documents,
        // neither of them parseable. Under `--json` the blocked startup becomes the document.
        const opened = settleCliStore();
        if (!opened.ok) {
          if (raw.json) {
            const doc: SearchJson = { ran: false, startup: opened.blocked.map(startupJson) };
            out(JSON.stringify(doc, null, 2));
            process.exitCode = EXIT_COMMITTED_UNANCHORED;
            return;
          }
          reportStartupBlocked(opened.blocked);
          return;
        }
        const store = opened.store;
        try {
          const hits = store.memory.search(queryParts.join(' '), {
            now,
            k,
            actor: 'cli',
            assoc: raw.assoc,
            scope: raw.scope,
          });
          if (raw.json) {
            // ONE JSON DOCUMENT, and nothing else on stdout. `--json` is a machine contract: a
            // consumer pipes this into a parser, so prose printed beside the payload does not warn
            // it — it makes the whole stream unparseable, and the warning is lost along with the
            // hits. The mutation outcome therefore travels INSIDE the document, as structure, and
            // the exit code still says 3. `startup` is empty here by construction: the gate above
            // returned a store, so nothing opening it committed unanchored.
            const doc: SearchJson = {
              ran: true,
              startup: [],
              hits,
              mutation: mutationJson(hits.outcome),
            };
            out(JSON.stringify(doc, null, 2));
            if (committedReceipts([hits.outcome]).some((r) => isDegradedReceipt(r))) {
              process.exitCode = EXIT_COMMITTED_UNANCHORED;
            }
            return;
          }
          // search MUTATES (retrieval bump + a memory_retrieve entry), so it too can commit while
          // the off-database anchor fails to advance.
          reportOutcomes([hits.outcome]);
          if (hits.length === 0) {
            out('no matches.');
            return;
          }
          // proposals are searchable by design — label them so a consumer can tell
          const typeWidth = hits.some((h) => h.memory.status === 'proposed') ? 21 : 11;
          // 3-significant-figure scores vary in width — size the column to the batch
          const scores = hits.map((h) => formatScore(h.score));
          const scoreWidth = Math.max(5, ...scores.map((s) => s.length)) + 2;
          out(
            `${padEndVisible('score', scoreWidth)}${padEndVisible('type', typeWidth)}${padEndVisible('age', 6)}snippet`,
          );
          for (const [i, h] of hits.entries()) {
            const typeCell =
              h.memory.status === 'proposed' ? `${h.memory.type}·proposed` : h.memory.type;
            out(
              padEndVisible(scores[i] as string, scoreWidth) +
                padEndVisible(typeCell, typeWidth) +
                padEndVisible(humanAge(h.memory.createdAt, now), 6) +
                (h.via === 'associative' ? '≈ ' : '') +
                snippet(h.memory.content),
            );
          }
          if (hits.some((h) => h.via === 'associative')) {
            out('  ≈ associative recall (no query-keyword overlap; linked by usage)');
          }
        } finally {
          store.close();
        }
      },
    );
}

/** Page size for the `review --confirm-all` keyset loop: bounded work per round trip, few
 *  enough round trips that a large queue still drains quickly. */
const CONFIRM_ALL_PAGE = 100;

/** Default page size for `review` listing. */
const REVIEW_PAGE_DEFAULT = 50;
/**
 * HARD MAXIMUM for one `review -n` page — the same 200-row family the MCP `memory_review` tool
 * enforces on its `limit` (packages/cli/src/mcp/server.ts), so both front doors bound a single
 * response identically and neither can be talked into materializing an arbitrary slice of the
 * queue. Over-limit is REFUSED, not clamped: a caller who asked for 1000 rows must learn that
 * paging is the answer rather than silently receive 200 and believe it was everything.
 */
export const REVIEW_PAGE_MAX = 200;

function registerReview(program: Command): void {
  program
    .command('review')
    .description('List the proposal queue (paged), or confirm/reject by id')
    .option('--confirm <ids...>', 'confirm these proposal ids')
    .option('--reject <ids...>', 'reject these proposal ids')
    .option('--confirm-all', 'confirm every proposal (optionally filtered by --type)', false)
    .option('--type <type>', 'with --confirm-all: only episodic | semantic | procedural')
    .option(
      '-n, --n <n>',
      `list: max proposals shown per page (1-${REVIEW_PAGE_MAX})`,
      String(REVIEW_PAGE_DEFAULT),
    )
    .option('--offset <n>', 'list: skip this many proposals (paging)', '0')
    .action(
      (raw: {
        confirm?: string[];
        reject?: string[];
        confirmAll?: boolean;
        type?: string;
        n: string;
        offset: string;
      }) => {
        const now = Date.now();
        let type: MemoryType | undefined;
        if (raw.type !== undefined) {
          if (raw.type !== 'episodic' && raw.type !== 'semantic' && raw.type !== 'procedural') {
            process.stderr.write(
              `--type must be episodic | semantic | procedural, got "${raw.type}"\n`,
            );
            process.exitCode = 1;
            return;
          }
          type = raw.type;
        }
        // Page bounds are validated BEFORE the store is opened: a bad or oversized -n must not
        // cost a database open, and it is REFUSED rather than clamped so the caller learns that
        // the page they asked for is not the page they would have received. Number(), not
        // parseInt(): parseInt('1e21') silently yields 1 and parseInt('50nonsense') yields 50,
        // and isSafeInteger closes NaN, Infinity, fractions and >2^53 in one check before any
        // of it reaches SQL as a LIMIT.
        const limit = Number(raw.n);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > REVIEW_PAGE_MAX) {
          process.stderr.write(
            `-n must be a whole number from 1 to ${REVIEW_PAGE_MAX}, got "${raw.n}" — page through a larger queue with --offset\n`,
          );
          process.exitCode = 1;
          return;
        }
        const offset = Number(raw.offset);
        if (!Number.isSafeInteger(offset) || offset < 0) {
          process.stderr.write(
            `--offset must be a whole number of 0 or more, got "${raw.offset}"\n`,
          );
          process.exitCode = 1;
          return;
        }
        const store = openCliStore();
        if (store === undefined) {
          return;
        }
        try {
          if (raw.confirmAll) {
            // Repeated-first-page keyset loop: confirming CHANGES each row's status, so "the
            // first page of remaining proposals" is a fresh query every iteration — every
            // proposal is visited exactly once (offset stays 0; nothing is skipped) and the
            // full queue is never materialized in memory. Storage-bounded pages throughout.
            const first = store.memory.listProposals({
              limit: CONFIRM_ALL_PAGE,
              offset: 0,
              type,
            });
            // Sane iteration cap: every iteration must confirm ≥1 proposal or the loop exits,
            // so the initial queue needs at most ceil(total/PAGE) rounds; the slack absorbs
            // proposals written concurrently mid-drain before we stop and report.
            const maxIters = Math.ceil(first.total / CONFIRM_ALL_PAGE) + 16;
            let confirmed = 0;
            let rows = first.rows;
            let iters = 0;
            while (rows.length > 0) {
              if (iters >= maxIters) {
                process.stderr.write(
                  `review --confirm-all: the proposal queue kept refilling after ${confirmed} confirmation(s) — stopping; re-run to drain the rest\n`,
                );
                process.exitCode = 1;
                break;
              }
              iters++;
              const done = store.memory.confirm(
                rows.map((m) => m.id),
                { now, actor: 'cli' },
              );
              confirmed += done.length;
              // THIS PAGE, INSPECTED NOW — before another page is even listed. Each page is its
              // own transaction and its own durable commit, so accumulating outcomes and reading
              // them after the loop means the page that committed unanchored is followed by a
              // page whose append the store REFUSES: that refusal throws, and a hundred durable
              // confirmations leave as a generic exit-1 failure with nothing on stdout. Stopping
              // here reports the exact number that IS committed, at the exit code that says so.
              if (reportOutcomes([done.outcome])) {
                out(
                  `  ${confirmed} ${type ? `${type} ` : ''}memory(ies) WERE confirmed — they are durable; the rest of the queue was NOT attempted.`,
                );
                return;
              }
              if (done.length === 0) {
                break; // rows changed status under us and nothing transitioned — never spin
              }
              rows = store.memory.listProposals({ limit: CONFIRM_ALL_PAGE, offset: 0, type }).rows;
            }
            out(`confirmed ${confirmed} ${type ? `${type} ` : ''}memory(ies) as trusted.`);
            return;
          }
          if (raw.confirm && raw.confirm.length > 0) {
            const done = store.memory.confirm(raw.confirm, { now, actor: 'cli' });
            if (reportOutcomes([done.outcome])) {
              out(`  ${done.length} memory(ies) WERE confirmed.`);
              return;
            }
            out(`confirmed ${done.length} memory(ies).`);
            return;
          }
          if (raw.reject && raw.reject.length > 0) {
            const done = store.memory.reject(raw.reject, { now, actor: 'cli' });
            if (reportOutcomes([done.outcome])) {
              out(`  ${done.length} memory(ies) WERE rejected.`);
              return;
            }
            out(`rejected ${done.length} memory(ies).`);
            return;
          }
          // Bounded listing: one storage-layer page (SQL LIMIT/OFFSET + COUNT) — listing a
          // large queue never materializes the whole queue in this process, and `limit` was
          // capped at REVIEW_PAGE_MAX above, before this store was even opened.
          const { rows: proposals, total } = store.memory.listProposals({ limit, offset });
          if (total === 0) {
            out('no proposals in the queue.');
            return;
          }
          out(`${total} proposal(s) — confirm with: sthayi review --confirm <id...>`);
          for (const m of proposals) {
            out(`  ${m.id}  ${padEndVisible(m.type, 11)}${snippet(m.content)}`);
          }
          if (offset > 0 || total > offset + proposals.length) {
            out(
              `  showing ${proposals.length} of ${total} (offset ${offset}) — next page: sthayi review -n ${limit} --offset ${offset + proposals.length}`,
            );
          }
        } finally {
          store.close();
        }
      },
    );
}

function registerIndex(program: Command): void {
  const index = program
    .command('index')
    .description('Derived-index maintenance (the Samskara association graph)');
  index
    .command('rebuild')
    .description('Re-derive the association graph from the journal (drops and re-folds)')
    .action(() => {
      const store = openCliStore();
      if (store === undefined) {
        return;
      }
      try {
        const edges = store.assoc.rebuild();
        out(`association graph rebuilt from the journal: ${edges} edge(s).`);
      } finally {
        store.close();
      }
    });
  index
    .command('status')
    .description('Show association-graph size and journal cursor')
    .action(() => {
      const store = openCliStore();
      if (store === undefined) {
        return;
      }
      try {
        const edges = store.driver.countAssocEdges();
        const cursor = store.driver.getMeta('assoc_cursor') ?? '0';
        out(`association graph: ${edges} edge(s), folded through journal #${cursor}.`);
      } finally {
        store.close();
      }
    });
}

/** Chunk size for the `journal --op` whole-history scan: bounded memory per chunk, few
 *  round trips. */
const JOURNAL_SCAN_CHUNK = 500;

function registerJournal(program: Command): void {
  /** One journal row, plus — with details — each contradiction pair's ids and the COMPLETE
   *  journaled reason. The reason was masked and bounded (280 chars) at write time (oracle
   *  boundary); this view renders exactly that journaled value, never truncating it further. */
  const printEntry = (r: JournalRecord, details: boolean): void => {
    out(
      `#${padEndVisible(String(r.id), 5)}${new Date(r.ts).toISOString()}  ${padEndVisible(r.actor, 18)}${r.op}`,
    );
    if (details && r.op === 'consolidate_contradictions') {
      const pairs = (
        r.payload as { pairs?: { a?: unknown; b?: unknown; reason?: unknown }[] } | null
      )?.pairs;
      for (const p of Array.isArray(pairs) ? pairs : []) {
        out(`      contradiction: ${String(p.a)} ↔ ${String(p.b)}`);
        out(`        reason: ${String(p.reason)}`);
      }
    }
  };

  const journal = program
    .command('journal')
    .description('Show recent journal entries, or verify the hash chain and its checkpoint')
    .option('-n, --n <n>', 'number of entries', '20')
    .option('--verify', 'verify the append-only hash chain and authenticated checkpoint', false)
    .option(
      '--details',
      'render full entry details (contradiction pairs: both memory ids + the journaled reason)',
      false,
    )
    .option(
      '--op <op>',
      'list EVERY entry with this operation across the WHOLE journal (e.g. consolidate_contradictions) — guaranteed reachability regardless of recency; overrides -n',
    )
    .action((raw: { n: string; verify: boolean; details: boolean; op?: string }) => {
      const store = openCliStore();
      if (store === undefined) {
        return;
      }
      try {
        if (raw.verify) {
          const r = store.journal.verify();
          if (r.ok) {
            const detail =
              r.state === 'pristine'
                ? 'pristine store (no entries yet)'
                : r.state === 'checkpoint-disabled'
                  ? 'chain intact (checkpoint disabled)'
                  : 'chain + authenticated checkpoint intact';
            out(`journal OK — ${r.length} entries, ${detail}.`);
          } else {
            out(
              r.brokenAt !== undefined
                ? `JOURNAL TAMPER at entry ${r.brokenAt}: ${r.reason}`
                : `JOURNAL VERIFY FAILED: ${r.reason}`,
            );
          }
          process.exitCode = r.ok ? 0 : 1;
          return;
        }
        if (raw.op !== undefined) {
          // Guaranteed reachability (the consolidate summary points here): scan the ENTIRE
          // journal oldest-first in bounded chunks — a matching entry can never age out of the
          // recent-N window, and no chunk materializes more than JOURNAL_SCAN_CHUNK rows.
          let cursor = 0;
          let matched = 0;
          for (;;) {
            const chunk = store.driver.journalSince(cursor, JOURNAL_SCAN_CHUNK);
            const last = chunk[chunk.length - 1];
            if (last === undefined) {
              break;
            }
            cursor = last.id;
            for (const r of chunk) {
              if (r.op === raw.op) {
                matched++;
                printEntry(r, raw.details);
              }
            }
          }
          if (matched === 0) {
            out(`no journal entries with op '${raw.op}'.`);
          }
          return;
        }
        const rows = store.journal.recent(Number.parseInt(raw.n, 10) || 20);
        if (rows.length === 0) {
          out('journal is empty.');
          return;
        }
        for (const r of rows) {
          printEntry(r, raw.details);
        }
      } finally {
        store.close();
      }
    });

  journal
    .command('reseal')
    .description(
      'Accept the CURRENT journal history as trusted and write a fresh authenticated checkpoint (use after an intentional backup restore or vault-key rotation)',
    )
    // What the two outcomes MEAN, on the surface an installed user can actually reach: `--help`.
    // The docs tree is not shipped in the package, and this command is the one an owner runs while
    // something is already wrong, so the semantics have to travel with the binary.
    .addHelpText(
      'after',
      `
Reseal is a trust decision you are making, not a repair the tool performs for you.
It blesses whatever history is in the store right now, so read the history first
(\`sthayi journal -n 50\`) and reseal only if you recognise it.

  resealed         The store and the checkpoint file outside it verify TOGETHER over the
                   history as it now stands, and the count is that history. On a store
                   shared with other Sthayi processes this includes the case where a
                   healthy peer's own write has already carried the anchor past the
                   checkpoint this command minted — the two still agree about the store
                   you have, which is what the reseal was for.

  reseal           Half done. The trust decision is committed and durable in the
  INCOMPLETE       database, and no current anchor outside it was confirmed for the
                   store. Treat it as unfinished: \`sthayi journal --verify\` stays red and
                   further writes refuse until it is repaired. Clear whatever is blocking
                   the checkpoint file — a stale \`journal.checkpoint.lock\`, permissions,
                   a full disk — then run \`sthayi journal reseal\` again.

  reseal refused   Nothing was written. The store is exactly as it was.
`,
    )
    .action(() => {
      const store = openCliStore();
      if (store === undefined) {
        return;
      }
      try {
        const r = store.journal.seal('cli', Date.now());
        if (r.ok) {
          // Reached ONLY after seal() read the checkpoint file back and confirmed it holds the new
          // authenticated checkpoint. The "store meta + journal.checkpoint file" claim is the whole
          // point of the command, so it may never be printed on an unconfirmed write.
          //
          // THE COUNT COMES OUT OF THE SEAL, never from a read taken before it. The store is
          // shared, and the sealing transaction takes its snapshot under the writer lock: a peer
          // that commits in between would make an earlier sample describe a store that no longer
          // exists — fewer entries than the checkpoint actually covers, reported to the owner as
          // the thing they just decided to trust. `entries` is that transaction's own count,
          // including the seal's auditable entry, and it is what `journal verify` counts too.
          // A seal that reported no count (nothing of ours was written) gets no number invented
          // for it.
          if (r.entries !== undefined) {
            const n = r.entries;
            out(`resealed: accepted ${n} journal entr${n === 1 ? 'y' : 'ies'} as trusted history.`);
          } else {
            out('resealed: accepted the current journal history as trusted.');
          }
          out('  authenticated checkpoint rewritten (store meta + journal.checkpoint file).');
        } else if (r.partial) {
          // Half-done, and said so: the database committed, the file did not. Nonzero exit, and no
          // claim about the file — `sthayi journal verify` will still be red until it is fixed.
          out(`reseal INCOMPLETE: ${r.reason}`);
          out(
            '  the store meta checkpoint was rewritten; the journal.checkpoint file was NOT — verification stays red until it is.',
          );
          process.exitCode = 1;
        } else {
          out(`reseal refused: ${r.reason}`);
          process.exitCode = 1;
        }
      } finally {
        store.close();
      }
    });
}

function registerServe(program: Command): void {
  program
    .command('serve')
    .description(
      'Run the MCP server (stdio by default; --http for remote-MCP clients like ChatGPT)',
    )
    .option('--http', 'serve over authenticated Streamable HTTP on loopback', false)
    .option('--port <n>', 'port for --http mode', '3737')
    .action(async (raw: { http: boolean; port: string }) => {
      // Dynamic import: the MCP SDK loads only when actually serving.
      const { runHttpServer, runServer } = await import('./mcp/serve.js');
      try {
        if (raw.http) {
          const info = await runHttpServer({ port: Number.parseInt(raw.port, 10) || 3737 });
          out(`sthayi MCP endpoint listening on http://127.0.0.1:${info.port}/mcp`);
          out(
            `  auth:  Authorization: Bearer <token>   (token file: ${info.tokenPath}, chmod 600)`,
          );
          out(
            '  bound to loopback only — exposing it further (reverse proxy, Tailscale, your VPS)',
          );
          out('  is your explicit act. Local is the product; this transport is optional.');
          out('  stop with Ctrl-C.');
          return;
        }
        await runServer();
      } catch (err) {
        // Opening the store committed something the anchor did not follow, so neither transport
        // started. Reported on STDERR: in stdio mode stdout is the JSON-RPC channel, and a client
        // must not receive a report where it expects a frame.
        if (err instanceof StartupUnanchoredError) {
          reportStartupBlocked(err.blocked, (line) => process.stderr.write(`${line}\n`));
          return;
        }
        throw err;
      }
    });
}

function registerClients(program: Command): void {
  program
    .command('init')
    .description('Initialize ~/.sthayi and run the first-run wizard')
    .option('-y, --yes', 'wire all detected clients without prompting', false)
    .option('--dry-run', 'show what would happen without writing anything', false)
    .action(async (raw: { yes: boolean; dryRun: boolean }) => {
      const { runInit } = await import('./clients/commands.js');
      await runInit({ yes: raw.yes, dryRun: raw.dryRun });
    });

  program
    .command('wire')
    .description('Wire Sthayi into detected AI clients')
    .option('--client <id>', 'only wire this client (e.g. claude-desktop)')
    .option('--dry-run', 'show what would happen without writing anything', false)
    .action(async (raw: { client?: string; dryRun: boolean }) => {
      const { runWire } = await import('./clients/commands.js');
      runWire({ client: raw.client, dryRun: raw.dryRun });
    });

  program
    .command('unwire')
    .description('Remove Sthayi from client configs (byte-exact restore)')
    .option('--client <id>', 'only unwire this client')
    .option('--dry-run', 'show what would happen without writing anything', false)
    .action(async (raw: { client?: string; dryRun: boolean }) => {
      const { runUnwire } = await import('./clients/commands.js');
      runUnwire({ client: raw.client, dryRun: raw.dryRun });
    });

  program
    .command('status')
    .description('Show per-client detection and wiring status')
    .action(async () => {
      const { runStatus } = await import('./clients/commands.js');
      runStatus();
    });
}

function registerDoctor(program: Command): void {
  program
    .command('doctor')
    .description('Diagnose the install, store, journal, and per-client wiring')
    .action(async () => {
      const { runDoctor } = await import('./doctor.js');
      const checks = runDoctor();
      let failures = 0;
      for (const c of checks) {
        out(`${c.ok ? '✓' : '✗'} ${padEndVisible(c.name, 22)} ${c.detail}`);
        if (!c.ok) {
          failures++;
          if (c.fix) {
            out(`  → fix: ${c.fix}`);
          }
        }
      }
      out('');
      out(failures === 0 ? 'All checks passed.' : `${failures} issue(s) found.`);
      process.exitCode = failures === 0 ? 0 : 1;
    });
}

function registerConsolidation(program: Command): void {
  program
    .command('consolidate')
    .description(
      'Run consolidation passes — deterministic always (no key needed); --oracle adds the optional Oracle pass: your own LLM examines bounded, masked memory batches and proposes merges/archives, which Sthayi validates and journals before applying anything',
    )
    .option(
      '--oracle',
      'also run the optional BYO-LLM Oracle pass (proposes changes; Sthayi validates and journals every application)',
      false,
    )
    .option('--provider <spec>', 'provider:model for --oracle (e.g. anthropic:claude-sonnet-4-5)')
    .option(
      '--prompt <op>',
      'oracle prompt op (consolidate | distill | contradictions)',
      'consolidate',
    )
    .option('--limit <n>', 'oracle: only process the latest N memories')
    .option('--type <type>', 'oracle: only process episodic | semantic | procedural')
    .action(
      async (
        raw: {
          oracle: boolean;
          provider?: string;
          prompt: string;
          limit?: string;
          type?: string;
        },
        cmd: Command,
      ) => {
        // Validate EVERY option and precondition BEFORE openStore() — an invalid
        // invocation must exit 1 with zero state changes, and on a fresh machine it must not
        // even create ~/.sthayi.
        let oracle:
          | { provider: ProviderPort; systemPrompt: string; promptVersion: string }
          | undefined;
        let limit: number | undefined;
        let type: 'episodic' | 'semantic' | 'procedural' | undefined;
        try {
          if (raw.limit !== undefined) {
            const n = Number(raw.limit);
            if (!Number.isInteger(n) || n <= 0) {
              throw new Error(`--limit must be a positive integer, got "${raw.limit}"`);
            }
            limit = n;
          }
          if (raw.type !== undefined) {
            if (raw.type !== 'episodic' && raw.type !== 'semantic' && raw.type !== 'procedural') {
              throw new Error(`--type must be episodic | semantic | procedural, got "${raw.type}"`);
            }
            type = raw.type;
          }
          if (!raw.oracle) {
            // Oracle-only flags are REJECTED without --oracle, never silently ignored: a user
            // typing `consolidate --provider …` believes an oracle pass will run. Checked here,
            // pre-store, so the invocation fails with zero filesystem effects. (Value errors
            // above still win for malformed --limit/--type — both paths exit 1 pre-store.)
            for (const flag of ['provider', 'prompt', 'limit', 'type'] as const) {
              if (cmd.getOptionValueSource(flag) === 'cli') {
                throw new Error(
                  `--${flag} requires --oracle (it configures only the optional Oracle pass; deterministic consolidation takes no flags)`,
                );
              }
            }
          }
          if (raw.oracle) {
            if (!raw.provider) {
              throw new Error(
                '--oracle requires --provider <provider:model> (and the matching env key)',
              );
            }
            const { providerFromEnv } = await import('./oracle/providers.js');
            const { loadPrompt } = await import('./oracle/prompts.js');
            oracle = {
              provider: providerFromEnv(raw.provider), // validates the spec AND the env key
              systemPrompt: loadPrompt(raw.prompt), // validates the prompt op
              promptVersion: `${raw.prompt}@v1`,
            };
          }
        } catch (err) {
          process.stderr.write(
            `consolidate failed: ${err instanceof Error ? err.message : String(err)}\n`,
          );
          process.exitCode = 1;
          return;
        }

        const store = openCliStore();
        if (store === undefined) {
          return;
        }
        // Hoisted out of the try: a run that STOPPED after committing has to report those
        // outcomes from the catch, and a report the catch cannot reach is a report nobody sees.
        const outcomes: MutationOutcome[] = [];
        try {
          const now = Date.now();
          const cs = new ConsolidationService(store.driver, store.journal, store.vault);
          const det = cs.runDeterministic({ now });
          outcomes.push(...det.outcomes);
          const detCounts = `${det.exactDupes} exact dupes, ${det.nearDupes} near-dupes, ${det.decayed} decayed → ${det.changed} archived`;
          // THE DETERMINISTIC PHASE IS SETTLED HERE, before its ordinary line is printed and
          // before a single Oracle byte leaves the machine. It is a durable commit of its own, and
          // the Oracle pass that would follow is a SEPARATE set of writes against the store it
          // just left: read at the end of the command instead, a deterministic pass that committed
          // while the anchor did not advance is announced as an ordinary success, and then the
          // Oracle pass runs into the store it blocked — surfacing as a generic failure at exit 1
          // over changes that are archived and durable. A refusal invites the one response that
          // duplicates work.
          if (reportOutcomes(det.outcomes)) {
            out(
              `  Deterministic consolidation IS applied and durable: ${detCounts}. Roll it back with \`sthayi rollback <journal id>\` once the anchor is repaired — do NOT re-run this command.`,
            );
            if (oracle) {
              out(
                '  The Oracle pass was NOT started: further writes are blocked, so it could only refuse — and no batch was sent to the provider.',
              );
            }
            // derived index only, and it journals nothing — the merge rewires still move
            foldAssoc(store);
            return;
          }
          out(`Deterministic: ${detCounts}.`);
          if (oracle) {
            const rep = await cs.runOracle({
              now,
              provider: oracle.provider,
              systemPrompt: oracle.systemPrompt,
              promptVersion: oracle.promptVersion,
              mask: (c) => store.vault.maskForEgress(c),
              limit,
              type,
            });
            outcomes.push(...rep.outcomes);
            out(
              `Oracle (${oracle.provider.id}): ${rep.appliedBatches}/${rep.batches} batches applied, ${rep.rejectedBatches} rejected, ${rep.changed} changes.`,
            );
            if (rep.ended === 'committed-unanchored') {
              // The run stopped ITSELF rather than attempting another batch against a store that
              // has stopped accepting writes — so say which batches never ran.
              out(
                `  STOPPED after ${rep.batchesRun} of ${rep.batches} batch(es): the batch above committed while the off-database anchor did not advance, so the remaining batch(es) were NOT attempted.`,
              );
            }
            if (rep.contradictions > 0) {
              // The pointer names the GUARANTEED route: `journal --op` scans the whole journal,
              // so the flagged pairs stay reachable however many entries land after them
              // (the default recent view shows only the latest 20).
              out(
                `  ${rep.contradictions} contradiction(s) flagged for review — list them all with \`sthayi journal --op consolidate_contradictions --details\` (each pair's ids + the complete journaled reason, masked and bounded at write time; nothing was auto-modified).`,
              );
            }
            if (rep.rejectedBatches > 0) {
              for (const r of store.journal.recent(rep.batches)) {
                const reason = (r.payload as { reason?: string })?.reason;
                if (r.op === 'consolidate_rejected' && reason) {
                  out(`  rejected: ${reason}`);
                }
              }
            }
          }
          // The batch above APPLIED and COMMITTED; if its anchor did not advance, that is not a
          // consolidation failure and must never be re-run — it is a store that has stopped
          // accepting writes with the changes already in place.
          reportOutcomes(outcomes);
          // fold merge rewires now — associative mass moves to survivors without waiting for
          // the next search's catchUp
          foldAssoc(store);
        } catch (err) {
          // A failure that arrived AFTER batches had already committed is not a failed run. The
          // typed partial result carries every committed outcome and the exact counts, so durable
          // progress is reported FIRST — printing a bare `consolidate failed` here would invite
          // the one response that duplicates work: re-running it.
          if (err instanceof PartialOracleRunError) {
            outcomes.push(...err.report.outcomes);
            out(
              `Oracle: STOPPED after ${err.report.batchesRun} of ${err.report.batches} batch(es) — ${err.report.appliedBatches} batch(es) applied and ${err.report.changed} change(s) are COMMITTED and durable. Do NOT re-run: the committed changes would be applied twice.`,
            );
            if (!reportOutcomes(outcomes)) {
              // every committed batch was properly anchored; the run itself still failed
              process.exitCode = 1;
            }
            process.stderr.write(
              `consolidate stopped after committed work: ${err.failure instanceof Error ? err.failure.message : String(err.failure)}\n`,
            );
            foldAssoc(store);
            return;
          }
          process.stderr.write(
            `consolidate failed: ${err instanceof Error ? err.message : String(err)}\n`,
          );
          process.exitCode = 1;
        } finally {
          store.close();
        }
      },
    );

  program
    .command('qualify')
    .description(
      'Run the prompt-pack conformance suite against a provider:model (needs an env key) — checks the model can serve as your Oracle, the optional BYO-LLM consolidation pass whose proposals Sthayi validates before applying',
    )
    .argument('<provider:model>', 'e.g. anthropic:claude-sonnet-4-5')
    .action(async (spec: string) => {
      try {
        const { providerFromEnv } = await import('./oracle/providers.js');
        const { qualify } = await import('./oracle/qualify.js');
        const provider = providerFromEnv(spec);
        out(`Qualifying ${provider.id} against the prompt pack …`);
        const results = await qualify(provider);
        for (const r of results) {
          out(`  ${r.pass ? '✓' : '✗'} ${r.op}/${r.fixture}${r.pass ? '' : ` — ${r.reason}`}`);
        }
        // A pack with no fixtures at all is a BROKEN INSTALL, not a clean run: `loadFixtures`
        // answers `[]` for a missing directory rather than throwing, so an install whose
        // `prompts/fixtures/` never shipped would otherwise print "0/0 fixtures passed." and
        // exit 0 — a qualification nobody ran, reported as one that passed. `qualify` now
        // preflights the whole pack and refuses a partial one before it calls the provider, so
        // reaching here with nothing is a backstop; it stays because the count sentence below is
        // the thing an operator reads, and it must never be printed for a run that did not happen.
        // THE REFUSAL COMES FIRST: no "fixtures passed." sentence is emitted before the result set
        // has been accepted as a real one.
        if (results.length === 0) {
          process.stderr.write(
            'qualify failed: the prompt pack shipped no fixtures — this installation is incomplete; reinstall sthayi, or point STHAYI_PROMPTS_DIR at a trusted pack\n',
          );
          process.exitCode = 1;
          return;
        }
        const passed = results.filter((r) => r.pass).length;
        out(`${passed}/${results.length} fixtures passed.`);
        process.exitCode = passed === results.length ? 0 : 1;
      } catch (err) {
        process.stderr.write(
          `qualify failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exitCode = 1;
      }
    });

  program
    .command('rollback')
    .description('Revert a consolidation batch by its journal id (compensating entries)')
    .argument('<journal-id>', 'journal id of the consolidate batch (see: sthayi journal)')
    .action((idStr: string) => {
      const store = openCliStore();
      if (store === undefined) {
        return;
      }
      try {
        const id = Number.parseInt(idStr, 10);
        if (!Number.isFinite(id)) {
          out('journal id must be a number.');
          process.exitCode = 1;
          return;
        }
        const cs = new ConsolidationService(store.driver, store.journal, store.vault);
        const r = cs.rollback(id, Date.now());
        if (r.ok) {
          foldAssoc(store);
          // `r.outcome` needs no presence check: on the `ok: true` branch of the union it is a
          // required member, so a successful rollback whose outcome went unread is not a shape
          // this code could have been written in.
          if (reportOutcomes([r.outcome])) {
            // The compensating entry and every reverted row ARE committed. Printing the ordinary
            // "Journal chain intact: false" success line here would make a degraded rollback
            // indistinguishable from a clean one at exit code 0.
            out(`  rollback #${id} DID revert ${r.reverted} change(s) — it must not be re-run.`);
            return;
          }
          const chain = store.journal.verify();
          out(
            `Rolled back #${id}: reverted ${r.reverted} change(s). Journal chain intact: ${chain.ok}.`,
          );
        } else {
          out(`rollback failed: ${r.reason}`);
          process.exitCode = 1;
        }
      } finally {
        store.close();
      }
    });
}

function registerVault(program: Command): void {
  program
    .command('pack')
    .description(
      'Export a scoped, masked memory pack (context.md) — safe to paste anywhere. Builds the whole document in memory: memory use is proportional to the number of matching memories.',
    )
    .option('-s, --scope <scope>', 'scope to export (e.g. user, project:<name>)', 'user')
    .option('--include-proposals', 'also include unreviewed proposals in a labeled section', false)
    .action((raw: { scope: string; includeProposals: boolean }) => {
      const store = openCliStore();
      if (store === undefined) {
        return;
      }
      try {
        const now = Date.now();
        // Pack policy: confirmed-only by default; proposals only on explicit opt-in,
        // and even then buildPack segregates them under a labeled "Unreviewed proposals" section.
        const confirmed = store.driver.listMemories({ scope: raw.scope, status: 'confirmed' });
        const proposed = raw.includeProposals
          ? store.driver.listMemories({ scope: raw.scope, status: 'proposed' })
          : [];
        const md = buildPack([...confirmed, ...proposed], {
          scope: raw.scope,
          now,
          mask: (c) => store.vault.maskForEgress(c),
        });
        const dir = path.join(sthayiHomeRoot(), 'export');
        const file = path.join(
          dir,
          `context-${new Date(now).toISOString().replace(/[:.]/g, '-')}.md`,
        );
        // Hardened write (fs-safe family): a symlink/hard link/FIFO planted at the export path
        // is refused with the victim untouched. Explicit 0644 — exports are user-shareable
        // documents, not secrets.
        safeWriteFileAtomic(file, md, { mode: 0o644 });
        out(`Wrote masked memory pack: ${file}`);
        out(
          `  ${confirmed.length} confirmed${raw.includeProposals ? ` + ${proposed.length} proposed` : ''} memory(ies) [scope ${raw.scope}]. Real values are masked — see: sthayi entities`,
        );
        if (!raw.includeProposals) {
          const pending = store.driver.countMemories({ scope: raw.scope, status: 'proposed' });
          if (pending > 0) {
            out(
              `  ${pending} unreviewed proposal(s) not included — add --include-proposals, or review with: sthayi review`,
            );
          }
        }
      } finally {
        store.close();
      }
    });

  program
    .command('entities')
    .description('List local pseudonym → value mappings (never leaves this machine)')
    .action(() => {
      const store = openCliStore();
      if (store === undefined) {
        return;
      }
      try {
        const maps = store.vault.listMappings();
        if (maps.length === 0) {
          out('no vaulted entities yet.');
          return;
        }
        out(`${padEndVisible('pseudonym', 14)}${padEndVisible('kind', 8)}value`);
        for (const m of maps) {
          out(`${padEndVisible(m.pseudonym, 14)}${padEndVisible(m.kind, 8)}${m.value}`);
        }
      } finally {
        store.close();
      }
    });
}

function registerImport(program: Command): void {
  program
    .command('import')
    .description('Import a ChatGPT / Claude / Gemini export (a .zip or an extracted folder)')
    .argument('<path>', 'path to the export archive or folder')
    .action(async (archivePath: string) => {
      const { runImport } = await import('./importers/run.js');
      const store = openCliStore();
      if (store === undefined) {
        return;
      }
      try {
        out(`Importing ${archivePath} …`);
        const s = await runImport(archivePath, store, Date.now());
        // An import is ONE journaled write of the whole archive. If it committed while the anchor
        // did not advance, every imported row is durable, the store has stopped accepting writes,
        // and re-running the import would write the whole archive a second time — so the DEGRADED
        // report replaces the ordinary "Imported N …" line rather than sitting next to it.
        if (reportOutcomes([s.outcome])) {
          out(
            `  the ${s.source} export IS imported: ${s.imported} memory(ies) are stored as proposals${s.skipped > 0 ? ` (${s.skipped} skipped as duplicates)` : ''}. Do NOT re-import.`,
          );
          for (const w of s.warnings) {
            out(`  warning: ${w}`);
          }
          return;
        }
        out(`Detected ${s.source} export.`);
        out(
          `Imported ${s.imported} memory(ies) as proposals${s.skipped > 0 ? ` (${s.skipped} skipped as duplicates)` : ''}.`,
        );
        for (const w of s.warnings) {
          out(`  warning: ${w}`);
        }
        if (s.imported > 0) {
          out('Review them with:  sthayi review');
        }
      } catch (err) {
        process.stderr.write(
          `import failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exitCode = 1;
      } finally {
        store.close();
      }
    });
}

/** Outcome of probeStateFile: absent (first-run), trusted (a real Sthayi state file), or untrusted
 *  WITH the specific fs-safe reason — the reason is what the refusal prints, so the user learns
 *  which policy they tripped rather than a generic "something is wrong". */
type StateProbe =
  | { state: 'absent' }
  | { state: 'regular' }
  | { state: 'untrusted'; reason: string };

/**
 * NO-FOLLOW, FULL-TRUST-POLICY probe for one file of Sthayi state.
 *
 * `fs.existsSync` (and every `stat`-family call) FOLLOWS symlinks, so asking it whether
 * `~/.sthayi/sthayi.db` exists reaches THROUGH a planted link and answers about the target: it
 * discloses the existence and type of a path outside the home, and it lets a link to any readable
 * file masquerade as an initialized store. `lstatSync` never follows the final component, so what
 * is inspected here is the entry itself — never what it points at.
 *
 * NO-FOLLOW ALONE IS NOT THE POLICY. Accepting ANY regular file here accepted three hostile
 * shapes that the rest of Sthayi has always refused, and every one of them bought the attacker a
 * confident "Sthayi is initialized." plus a full `sthayi status` render:
 *   - a HARD LINK (nlink > 1) aliasing a file outside the home — no symlink to see, and unlinking
 *     ours never detaches theirs, so every later write lands in the victim's inode;
 *   - a FOREIGN-OWNED file — its owner can rewrite the store's bytes under us at any moment;
 *   - a GROUP- or WORLD-WRITABLE file — anyone who can write it can already steer us.
 * So the single lstat is handed to fs-safe's `untrustedStatReason`, the SAME predicate that guards
 * every hardened read and write (safeReadTextFile, safeWriteFileAtomic, openAppendNoFollow,
 * SqliteDriver's fstat re-validation). One policy, one place — a second hand-rolled copy here is
 * exactly how the three shapes above got through.
 *
 * ONE lstat, not two: the stats that decide presence are the very stats the policy judges, so no
 * hostile entry can be raced in between "is it there" and "is it trustworthy".
 *
 * 'untrusted' also covers any stat error other than absence (a permission failure is not evidence
 * of absence). It is deliberately NOT collapsed into 'absent': treating a hostile or uninspectable
 * entry as "nothing here" would route the bare command into the first-run initializer on top of it.
 */
function probeStateFile(p: string, what: string): StateProbe {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { state: 'absent' };
    }
    // Uninspectable: let fs-safe phrase it, so this path cannot drift from the shared wording.
    return {
      state: 'untrusted',
      reason:
        untrustedFileReason(p, what) ??
        `${what} at ${p} could not be inspected (${code ?? 'unknown error'}) — refusing to use it`,
    };
  }
  // Default 'no-shared-write' policy: regular file, exactly one hard link, owned by us, not
  // group/world-writable. (Not 'private': a 0640 state file is a hygiene problem for `sthayi
  // doctor` to report, not a reason for the bare command to refuse to start.)
  const reason = untrustedStatReason(st, p, what, {});
  return reason === undefined ? { state: 'regular' } : { state: 'untrusted', reason };
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('sthayi')
    .description(
      'Sthayi — the you that persists. Sovereign, local-first memory for every AI, over MCP.',
    )
    .version(VERSION, '-v, --version', 'print the Sthayi version')
    .showHelpAfterError();

  registerAdd(program);
  registerSearch(program);
  registerReview(program);
  registerIndex(program);
  registerJournal(program);
  registerServe(program);
  registerClients(program);
  registerImport(program);
  registerVault(program);
  registerConsolidation(program);
  registerDoctor(program);

  for (const spec of COMMANDS) {
    if (IMPLEMENTED.has(spec.name)) {
      continue;
    }
    program
      .command(spec.name)
      .description(spec.summary)
      .allowUnknownOption(true)
      .allowExcessArguments(true)
      .argument('[args...]', 'arguments (accepted but ignored until this command is implemented)')
      .action(() => {
        out(`sthayi ${spec.name}: not implemented yet — arrives in milestone ${spec.milestone}.`);
      });
  }

  // Bare `sthayi` is the DOCUMENTED first-run entry point, not a help printer.
  // Uninitialized (no db and no key) → run the init flow. Interactivity is preserved by the
  // flow itself: without a TTY its confirm() refuses, so a piped bare run creates only
  // ~/.sthayi and never touches client configs without consent. Initialized → say so + status.
  //
  // ORDER IS THE SAFETY PROPERTY: the HOME is validated before anything inside it is inspected,
  // and the inspection itself never follows a link. Probing the db/key first (with existsSync,
  // which follows symlinks) reached through a symlinked home or a symlinked `sthayi.db` and
  // answered about a path OUTSIDE the home — leaking that an attacker-named file exists there and
  // printing "Sthayi is initialized" over a link to it. assertReadOnlySthayiHome refuses a
  // symlinked/foreign-owned/group-writable home (and creates and chmods NOTHING — an absent home
  // is still the legitimate first-run state), and it establishes the CANONICAL root the two paths
  // below are then derived from.
  //
  // And the per-file probe applies the SAME trust policy the home gate applies to the directory —
  // fs-safe's untrustedStatReason, not merely "is it a regular file". A hard-linked, foreign-owned
  // or shared-writable db is a hijack the home gate cannot see (all three live INSIDE a perfectly
  // healthy 0700 home), so none of them may be reported as an initialized store.
  program.action(async () => {
    assertReadOnlySthayiHome();
    const db = probeStateFile(dbPath(), 'memory database');
    const key = probeStateFile(keyPath(), 'vault key');
    const bad = db.state === 'untrusted' ? db : key.state === 'untrusted' ? key : undefined;
    if (bad !== undefined) {
      // TWO lines on purpose. The first is the SPECIFIC fs-safe reason — a hard-linked db, a
      // foreign-owned key and a world-writable store each name their own failure, because a user
      // told only "symlink or not a regular file" about a HARD LINK has been told nothing they
      // can act on. The second names the whole policy, so the refusal is self-describing
      // whichever clause fired.
      process.stderr.write(
        `sthayi: ${bad.reason}\nsthayi: refusing to inspect it further, and refusing to initialize over it. Every Sthayi state file must be a regular file with exactly one hard link, owned by you, and not group- or world-writable — a symlink, an extra hard link, a directory or FIFO/socket/device, a foreign owner, group/world-writable permission bits, or an entry that cannot be inspected at all are each refused here. Remove or restore it, then run \`sthayi doctor\`.\n`,
      );
      process.exitCode = 1;
      return;
    }
    if (db.state === 'absent' && key.state === 'absent') {
      const { runInit } = await import('./clients/commands.js');
      await runInit({});
      return;
    }
    out('Sthayi is initialized. (`sthayi --help` for commands; `sthayi doctor` to diagnose.)');
    const { runStatus } = await import('./clients/commands.js');
    runStatus();
  });

  return program;
}

export async function main(argv: readonly string[]): Promise<void> {
  assertSupportedNodeRuntime();
  const program = buildProgram();
  await program.parseAsync(argv as string[]);
}

// Only run when invoked directly as the `sthayi` bin — not when imported by tests.
// npm installs the bin as a SYMLINK (node_modules/.bin/sthayi → dist/index.js) while
// import.meta.url is already the realpath — compare realpaths, or every npm-installed
// invocation silently no-ops (exit 0, no output).
const invokedPath = process.argv[1];
if (invokedPath) {
  let invokedReal = invokedPath;
  try {
    invokedReal = fs.realpathSync(invokedPath);
  } catch {
    // unresolvable argv[1] — keep the literal path and let the comparison decide
  }
  if (import.meta.url === pathToFileURL(invokedReal).href) {
    main(process.argv).catch((err: unknown) => {
      process.stderr.write(`${cliFailureMessage(err)}\n`);
      process.exitCode = 1;
    });
  }
}
