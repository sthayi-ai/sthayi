import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  type CommitReceipt,
  type JournalService,
  type MemoryService,
  type MutationOutcome,
  type StorageDriver,
  committedReceipts,
  describeReceipt,
  isDegradedReceipt,
  maskDeep,
} from '@sthayi/core';
import { z } from 'zod';
import { formatScore, snippet } from '../format.js';
import { getSkill, listSkills } from '../skills.js';
import { VERSION } from '../version.js';

export interface McpServerDeps {
  store: {
    driver: StorageDriver;
    journal: JournalService;
    memory: MemoryService;
  };
  /** Egress mask applied to EVERY tool result — text and structuredContent, success and error
   *  alike. serve wires the vault's secret masker; absent = identity (unit tests). */
  mask?: (s: string) => string;
  now?: () => number;
}

const SERVER_INSTRUCTIONS = [
  "Sthayi is the user's sovereign, local-first memory. It is the source of truth for durable facts",
  'about them and their work.',
  '',
  '- Before asking the user for something you may already know (their name, preferences, current',
  '  projects, past decisions), call memory_search first.',
  '- When the user states a durable fact, preference, or decision, record it with memory_write —',
  '  it enters the review queue as a proposal, so propose freely.',
  '- NEVER write secrets, API keys, tokens, or passwords into memory.',
  '- Everything here belongs to the user; treat it with care.',
].join('\n');

const MEMORY_TYPES = ['episodic', 'semantic', 'procedural'] as const;

/**
 * The durable-but-unanchored outcome, rendered for MCP.
 *
 * A tool whose write COMMITTED while the off-database anchor failed to advance must say so on BOTH
 * channels the protocol gives it — the visible text a model reads and the structuredContent a
 * client parses — and it may NOT come back with `warnings: []`, which is what a caller reads as
 * "clean". It is NOT an `isError` result either: the rows are durable, and a model told the call
 * failed would reasonably retry and duplicate them.
 */
interface DegradedReport {
  messages: string[];
  structured: Record<string, unknown>;
}

function degradedReport(outcomes: readonly MutationOutcome[]): DegradedReport | undefined {
  const receipts: readonly CommitReceipt[] = committedReceipts(outcomes);
  const degraded = receipts.filter((r) => isDegradedReceipt(r));
  if (degraded.length === 0) {
    return undefined;
  }
  return {
    messages: degraded.map((r) => describeReceipt(r)),
    structured: {
      // `outcome`, not `status` — memory_write already publishes a `status` (the memory's
      // proposed/confirmed state) and clobbering it would trade one lost fact for another.
      outcome: 'committed_unanchored',
      committed: true,
      anchor: 'unanchored',
      writesBlocked: true,
      doNotRetry: true,
      degraded: degraded.map((r) => ({
        journalId: r.journalId,
        committed: r.committed,
        anchor: r.anchor,
        writesBlocked: r.writesBlocked,
        doNotRetry: r.doNotRetry,
        reason: r.reason,
        ids: r.ids,
      })),
    },
  };
}

/** Fold a degraded report into a tool result: text first (so it is unmissable), then the
 *  structured fields, then `warnings` — which can therefore never be `[]` in the degraded case. */
function withDegraded(
  text: string,
  structured: Record<string, unknown>,
  warnings: string[],
  report: DegradedReport | undefined,
): { text: string; structured: Record<string, unknown> } {
  const allWarnings = report ? [...warnings, ...report.messages] : warnings;
  // The degraded lines LEAD the text (a model must not read "Wrote 1 memory" and stop) and are not
  // repeated in the trailing warning block, which carries only the masking warnings.
  const lines = [...(report?.messages ?? []), text, ...warnings];
  return {
    text: lines.join('\n'),
    structured: { ...structured, ...(report?.structured ?? {}), warnings: allWarnings },
  };
}

interface ToolResult {
  // The SDK's tool-callback return type carries an index signature; mirror it so our typed
  // helpers are assignable.
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * Build the Sthayi stdio MCP server (spec §4). Stateless handlers — all state lives in the store.
 * Every tool: zod inputSchema, honest annotations, actionable errors; the server never crashes on
 * bad input. NEVER writes to stdout (see mcp/logger.ts).
 */
export function buildMcpServer(deps: McpServerDeps): McpServer {
  const { store } = deps;
  const now = deps.now ?? (() => Date.now());
  const mask = deps.mask ?? ((s: string) => s);

  // Factory-scoped result helpers: every byte a tool egresses — success text, error
  // text, and the whole structuredContent tree (keys included) — passes the mask exactly here,
  // so no individual handler can forget it.
  const ok = (text: string, structuredContent?: Record<string, unknown>): ToolResult =>
    structuredContent
      ? {
          content: [{ type: 'text', text: mask(text) }],
          structuredContent: maskDeep(structuredContent, mask),
        }
      : { content: [{ type: 'text', text: mask(text) }] };

  const fail = (text: string): ToolResult => ({
    content: [{ type: 'text', text: mask(text) }],
    isError: true,
  });

  const server = new McpServer(
    { name: 'sthayi', version: VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool(
    'memory_search',
    {
      title: 'Search memory',
      description:
        'Search the user\'s memory, ranked by relevance × confidence × recency. Example: {"query":"deployment preferences","k":5}. ' +
        "Note: NOT read-only — each search bumps the returned memories' retrieval recency/boosts, appends a journal entry, and may update the association graph.",
      inputSchema: {
        query: z.string().max(1024, 'query too long (max 1KB)').describe('search text (max 1KB)'),
        k: z.number().int().positive().max(50).optional().describe('max results (default 8)'),
        scope: z.string().optional().describe('optional scope filter, e.g. user or project:<name>'),
      },
      // Honest annotations: search MUTATES — it bumps retrieval bookkeeping, appends
      // a memory_retrieve journal entry, and may fold the association graph. Advertising
      // readOnlyHint true here would be a lie a client could act on.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    ({ query, k, scope }) => {
      try {
        const hits = store.memory.search(query, {
          now: now(),
          k: k ?? 8,
          actor: 'mcp',
          scope,
        });
        const structured = {
          hits: hits.map((h) => ({
            id: h.memory.id,
            // UNROUNDED: structuredContent is data, not display — a consumer re-ranking or
            // thresholding on score must see the full float (rounding lives in the text render).
            score: h.score,
            type: h.memory.type,
            scope: h.memory.scope,
            // proposals are searchable by design — every surface must say so
            status: h.memory.status,
            confidence: h.memory.confidence,
            content: h.memory.content,
          })),
        };
        const text =
          hits.length === 0
            ? 'No matching memories.'
            : hits
                .map(
                  (h, i) =>
                    `${i + 1}. [${h.memory.type}${h.memory.status === 'proposed' ? ', proposed' : ''}] ${snippet(h.memory.content, 120)} (score ${formatScore(h.score)})`,
                )
                .join('\n');
        // search MUTATES (retrieval bump + a memory_retrieve entry): its commit can be unanchored.
        const report = degradedReport([hits.outcome]);
        if (report === undefined) {
          return ok(text, structured);
        }
        const folded = withDegraded(text, structured, [], report);
        return ok(folded.text, folded.structured);
      } catch (err) {
        return fail(`memory_search failed: ${asMessage(err)}`);
      }
    },
  );

  server.registerTool(
    'memory_write',
    {
      title: 'Write memory (proposals)',
      description:
        'Record durable facts/preferences/decisions. They enter as proposals by default. Example: {"items":[{"type":"semantic","content":"Prefers pnpm"}]}',
      inputSchema: {
        items: z
          .array(
            z.object({
              type: z.enum(MEMORY_TYPES),
              content: z.string().min(1).max(32_768, 'content too large (max 32KB per memory)'),
              scope: z.string().optional(),
              confidence: z.number().min(0).max(1).optional(),
              provenance: z
                .record(z.string(), z.unknown())
                .refine(
                  (p) => JSON.stringify(p).length <= 4096,
                  'provenance too large (max 4KB per memory)',
                )
                .optional(),
            }),
          )
          .min(1)
          .max(50, 'too many items (max 50 per call)')
          .describe('one or more memories to write (max 50, 32KB each)'),
        as_proposals: z.boolean().optional().describe('default true — write to the review queue'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    ({ items, as_proposals }) => {
      try {
        const warnings: string[] = [];
        const written = store.memory.write(
          items.map((it) => ({
            type: it.type,
            content: it.content,
            scope: it.scope,
            confidence: it.confidence,
            provenance: it.provenance ? { source: 'mcp', ...it.provenance } : undefined,
            source: 'mcp',
          })),
          { now: now(), actor: 'mcp', asProposal: as_proposals !== false, warnings },
        );
        const ids = written.map((m) => m.id);
        const folded = withDegraded(
          `Wrote ${written.length} ${written[0]?.status ?? 'proposed'} memory(ies): ${ids.join(', ')}`,
          { ids, status: written[0]?.status },
          warnings,
          degradedReport([written.outcome]),
        );
        return ok(folded.text, folded.structured);
      } catch (err) {
        return fail(`memory_write failed: ${asMessage(err)}`);
      }
    },
  );

  server.registerTool(
    'memory_review',
    {
      title: 'Review proposals',
      description:
        'List the proposal queue (paginated), or confirm/reject by id. Rejecting ARCHIVES the proposal. Example: {"action":"confirm","ids":["01H..."]}',
      inputSchema: {
        action: z.enum(['list', 'confirm', 'reject']),
        ids: z
          .array(z.string().max(64, 'id too long (max 64 chars)'))
          .max(100, 'too many ids (max 100 per call)')
          .optional()
          .describe('required for confirm/reject (max 100 ids, 64 chars each)'),
        limit: z
          .number()
          .int()
          .positive()
          .max(200)
          .optional()
          .describe('list: max proposals returned (default 50, max 200)'),
        offset: z.number().int().min(0).optional().describe('list: skip this many (default 0)'),
      },
      // Honest annotations: reject archives proposals — that is destructive from the
      // caller's perspective (the proposal leaves the queue for good).
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    ({ action, ids, limit, offset }) => {
      try {
        if (action === 'list') {
          // Bounded response AND bounded work: the page comes from the store via SQL
          // LIMIT/OFFSET + COUNT (listMemoriesPage) — the full proposal queue is never
          // materialized in memory to serve one page.
          const start = offset ?? 0;
          const { rows: page, total } = store.memory.listProposals({
            limit: limit ?? 50,
            offset: start,
          });
          const shown = total > page.length ? ` (showing ${page.length} of ${total})` : '';
          return ok(
            total === 0
              ? 'No proposals in the queue.'
              : `${page.map((m) => `${m.id} [${m.type}] ${snippet(m.content, 100)}`).join('\n')}${shown}`,
            {
              proposals: page.map((m) => ({ id: m.id, type: m.type, content: m.content })),
              total,
              offset: start,
            },
          );
        }
        if (!ids || ids.length === 0) {
          return fail(`memory_review action '${action}' requires an ids array`);
        }
        const applied =
          action === 'confirm'
            ? store.memory.confirm(ids, { now: now(), actor: 'mcp' })
            : store.memory.reject(ids, { now: now(), actor: 'mcp' });
        const report = degradedReport([applied.outcome]);
        if (report === undefined) {
          return ok(`${action}ed ${applied.length} memory(ies).`, { applied });
        }
        const folded = withDegraded(
          `${action}ed ${applied.length} memory(ies).`,
          { applied },
          [],
          report,
        );
        return ok(folded.text, folded.structured);
      } catch (err) {
        return fail(`memory_review failed: ${asMessage(err)}`);
      }
    },
  );

  server.registerTool(
    'skill_list',
    {
      title: 'List skills',
      description: 'List installed skills from ~/.sthayi/skills/. Example: {"tag":"memory"}',
      inputSchema: { tag: z.string().optional().describe('optional tag filter') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ tag }) => {
      // Every OTHER tool routes its failures through fail() — i.e. through the egress mask. These
      // two threw instead, and a throw leaves the handler entirely: the SDK turns it into a
      // protocol error whose text never passes `mask`. The skills subtree is the one place whose
      // refusals name planted paths, so it is the last place that should egress unmasked.
      try {
        const skills = listSkills(tag);
        return ok(
          skills.length === 0
            ? 'No skills installed.'
            : skills.map((s) => `${s.name} — ${s.description}`).join('\n'),
          {
            skills: skills.map((s) => ({
              name: s.name,
              description: s.description,
              tags: s.tags,
            })),
          },
        );
      } catch (err) {
        return fail(`skill_list failed: ${asMessage(err)}`);
      }
    },
  );

  server.registerTool(
    'skill_get',
    {
      title: 'Get a skill',
      description:
        'Return a skill\'s full SKILL.md content. Example: {"name":"using-sthayi-memory"}',
      inputSchema: { name: z.string().describe('the skill name') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ name }) => {
      try {
        const skill = getSkill(name);
        if (!skill) {
          return fail(`unknown skill '${name}' — list skills with skill_list {}`);
        }
        return ok(skill.content, { name: skill.name, content: skill.content });
      } catch (err) {
        // Same reason as skill_list: a refusal is a tool result, masked like every other byte
        // this server egresses — not an unmasked protocol error.
        return fail(`skill_get failed: ${asMessage(err)}`);
      }
    },
  );

  server.registerTool(
    'mcp_lookup',
    {
      title: 'Look up MCP registry',
      description:
        'List registered MCP servers (never returns credentials — only the env-var name). Example: {"name":"github"}',
      inputSchema: { name: z.string().optional().describe('optional exact name filter') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ name }) => {
      const entries = store.driver.listMcpEntries(name);
      return ok(
        entries.length === 0
          ? 'No MCP servers registered.'
          : entries
              .map((e) => `${e.name} (${e.transport})${e.credEnv ? ` — needs $${e.credEnv}` : ''}`)
              .join('\n'),
        {
          entries: entries.map((e) => ({
            name: e.name,
            transport: e.transport,
            credEnv: e.credEnv,
            spec: e.spec,
          })),
        },
      );
    },
  );

  server.registerTool(
    'journal_recent',
    {
      title: 'Recent journal',
      description:
        'Show recent journal operations (writes, retrievals, consolidations). Example: {"n":10}',
      inputSchema: { n: z.number().int().positive().max(200).optional().describe('default 20') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ n }) => {
      const rows = store.journal.recent(n ?? 20);
      return ok(
        rows.length === 0
          ? 'Journal is empty.'
          : rows
              .map((r) => `#${r.id} ${new Date(r.ts).toISOString()} ${r.actor} ${r.op}`)
              .join('\n'),
        {
          entries: rows.map((r) => ({ id: r.id, ts: r.ts, actor: r.actor, op: r.op })),
        },
      );
    },
  );

  return server;
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
