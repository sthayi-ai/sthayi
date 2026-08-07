import type { ImportResult, ImportedMemory, SourceFiles } from './types.js';
import { errMsg, pick, sourceTimestamp, truncate } from './util.js';

interface ClaudeMsg {
  sender?: string;
  text?: string;
  content?: { text?: string }[];
}
interface ClaudeConv {
  uuid?: string;
  name?: string;
  created_at?: string;
  chat_messages?: ClaudeMsg[];
}
interface ClaudeMemories {
  conversations_memory?: string;
  project_memories?: Record<string, string>;
}
interface ClaudeUser {
  uuid?: string;
  full_name?: string;
  email_address?: string;
  verified_phone_number?: string | null;
}

function messageText(m: ClaudeMsg | undefined): string {
  if (!m) {
    return '';
  }
  if (m.text) {
    return m.text;
  }
  return (m.content ?? [])
    .map((c) => c.text ?? '')
    .join(' ')
    .trim();
}

/** Split a markdown memory blob into paragraph-sized semantic memories. */
function splitMarkdown(md: string): string[] {
  return md
    .split(/\n{2,}/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length >= 20)
    .map((s) => truncate(s, 600));
}

/**
 * Claude export (`conversations.json` + optional `memories.json`/`users.json`). Conversations
 * become episodic digests; Claude's own exported memory (`memories.json`) becomes higher-confidence
 * semantic memories; the account profile (`users.json`) yields a single high-confidence semantic
 * memory for the user's name (email/phone are deliberately excluded — see comment at the users.json
 * block). Defensive: unparseable files add a warning, never throw.
 */
export function parseClaudeExport(files: SourceFiles): ImportResult {
  const warnings: string[] = [];
  const memories: ImportedMemory[] = [];

  const convRaw = pick(files, 'conversations.json');
  if (convRaw === undefined) {
    warnings.push('conversations.json not found');
  } else {
    try {
      const convs = JSON.parse(convRaw) as ClaudeConv[];
      let skippedNoHuman = 0;
      for (const c of convs) {
        const msgs = c.chat_messages ?? [];
        const firstHuman = msgs.find((m) => m.sender === 'human');
        const text = messageText(firstHuman);
        if (!text) {
          skippedNoHuman += 1;
          continue;
        }
        const name = (c.name ?? '').trim() || 'Untitled conversation';
        // The export's created_at (ISO string), validated — a plausible source time
        // becomes the memory's createdAt so it ranks/decays as old as the conversation really is
        const sourceCreatedAt = sourceTimestamp(c.created_at);
        memories.push({
          type: 'episodic',
          scope: 'user',
          confidence: 0.5,
          content: truncate(`[Claude] ${name}: ${text}`),
          provenance: { source: 'claude', conversationId: c.uuid, date: c.created_at },
          ...(sourceCreatedAt !== undefined && { sourceCreatedAt }),
        });
      }
      if (skippedNoHuman > 0) {
        warnings.push(`skipped ${skippedNoHuman} conversations with no human message`);
      }
    } catch (err) {
      warnings.push(`conversations.json: could not parse (${errMsg(err)})`);
    }
  }

  const memRaw = pick(files, 'memories.json');
  if (memRaw !== undefined) {
    try {
      const arr = JSON.parse(memRaw) as ClaudeMemories[];
      const first = arr[0];
      if (first) {
        for (const chunk of splitMarkdown(first.conversations_memory ?? '')) {
          memories.push({
            type: 'semantic',
            scope: 'user',
            confidence: 0.75,
            content: chunk,
            provenance: { source: 'claude-memory' },
          });
        }
        for (const [pid, md] of Object.entries(first.project_memories ?? {})) {
          for (const chunk of splitMarkdown(md)) {
            memories.push({
              type: 'semantic',
              scope: `project:${pid}`,
              confidence: 0.75,
              content: chunk,
              provenance: { source: 'claude-project-memory', conversationId: pid },
            });
          }
        }
      }
    } catch (err) {
      warnings.push(`memories.json: could not parse (${errMsg(err)})`);
    }
  }

  const usersRaw = pick(files, 'users.json');
  if (usersRaw !== undefined) {
    try {
      const users = JSON.parse(usersRaw) as ClaudeUser[];
      const u = users[0];
      if (u && typeof u.full_name === 'string' && u.full_name.trim() !== '') {
        memories.push({
          type: 'semantic',
          scope: 'user',
          confidence: 0.9,
          content: `The user's name is ${u.full_name.trim()}.`,
          provenance: { source: 'claude-profile', conversationId: u.uuid },
        });
      }
      // Policy: email/phone are not imported as profile facts. If that ever changes, they must
      // flow through the at-rest masking policy (PII is masked at write, like secrets) — never
      // put email_address or verified_phone_number into memory content or provenance directly.
    } catch (err) {
      warnings.push(`users.json: could not parse (${errMsg(err)})`);
    }
  }

  return { source: 'claude', memories, warnings };
}
