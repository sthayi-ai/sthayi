import type { ImportResult, ImportedMemory, SourceFiles } from './types.js';
import { errMsg, pick, sourceTimestamp, truncate } from './util.js';

interface GptNode {
  message?: {
    author?: { role?: string };
    content?: { parts?: unknown[] };
  } | null;
}
interface GptConv {
  title?: string;
  create_time?: number;
  mapping?: Record<string, GptNode>;
}

function collectMessages(mapping: Record<string, GptNode>): { role: string; text: string }[] {
  const out: { role: string; text: string }[] = [];
  for (const node of Object.values(mapping)) {
    const m = node?.message;
    const role = m?.author?.role;
    if (!m || !role) {
      continue;
    }
    const text = (m.content?.parts ?? [])
      .filter((p): p is string => typeof p === 'string')
      .join(' ')
      .trim();
    if (text) {
      out.push({ role, text });
    }
  }
  return out;
}

/**
 * ChatGPT export (`conversations.json` with a `mapping` tree per conversation). Each conversation
 * becomes an episodic digest from its first user message. Defensive over the mapping shape.
 *
 * `user.json` is intentionally NOT parsed into memories: the export's user record carries no name
 * field (only `id`, `email`, `chatgpt_plus_user`, `phone_number` — see
 * tests/fixtures/imports/chatgpt/user.json). Policy: email/phone are not imported as profile
 * facts; if ever added they must flow through the at-rest masking policy (PII is masked at write).
 */
export function parseChatgptExport(files: SourceFiles): ImportResult {
  const warnings: string[] = [];
  const memories: ImportedMemory[] = [];

  const raw = pick(files, 'conversations.json');
  if (raw === undefined) {
    warnings.push('conversations.json not found');
    return { source: 'chatgpt', memories, warnings };
  }

  try {
    const convs = JSON.parse(raw) as GptConv[];
    for (const c of convs) {
      const mapping = c.mapping ?? {};
      const firstUser = collectMessages(mapping).find((m) => m.role === 'user');
      if (!firstUser) {
        continue;
      }
      const title = (c.title ?? '').trim() || 'Untitled chat';
      // create_time is epoch SECONDS in ChatGPT exports — convert to ms explicitly
      // (format knowledge lives here, not in the validator), then validate
      const sourceCreatedAt = sourceTimestamp(
        typeof c.create_time === 'number' ? c.create_time * 1000 : undefined,
      );
      memories.push({
        type: 'episodic',
        scope: 'user',
        confidence: 0.5,
        content: truncate(`[ChatGPT] ${title}: ${firstUser.text}`),
        provenance: {
          source: 'chatgpt',
          conversationId: Object.keys(mapping)[0],
          date: c.create_time ? new Date(c.create_time * 1000).toISOString() : undefined,
        },
        ...(sourceCreatedAt !== undefined && { sourceCreatedAt }),
      });
    }
  } catch (err) {
    warnings.push(`conversations.json: could not parse (${errMsg(err)})`);
  }

  return { source: 'chatgpt', memories, warnings };
}
