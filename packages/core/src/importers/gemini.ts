import type { ImportResult, ImportedMemory, SourceFiles } from './types.js';
import { decodeEntities, errMsg, sourceTimestamp, stripHtml, truncate } from './util.js';

interface GeminiTurn {
  user_turn?: { prompt?: string };
  system_turn?: { text?: { preamble?: string; data?: string }[] };
}
interface GeminiConv {
  conversation_turns?: GeminiTurn[];
  title?: string;
  creation_time?: string;
}

/** Fixed-token ASCII case folding without copying the input or changing Unicode string indices. */
function startsWithAsciiToken(text: string, token: string, at: number): boolean {
  if (at < 0 || at + token.length > text.length) {
    return false;
  }
  for (let i = 0; i < token.length; i += 1) {
    const source = text.charCodeAt(at + i);
    const folded = source >= 65 && source <= 90 ? source + 32 : source;
    if (folded !== token.charCodeAt(i)) {
      return false;
    }
  }
  return true;
}

function findAsciiToken(text: string, token: string, from: number): number {
  for (let at = Math.max(0, from); at + token.length <= text.length; at += 1) {
    if (startsWithAsciiToken(text, token, at)) {
      return at;
    }
  }
  return -1;
}

/** Parse the exported custom "Gems" HTML into name/instructions pairs. */
export function parseGems(html: string): { name: string; instructions: string }[] {
  const out: { name: string; instructions: string }[] = [];
  // Export HTML is untrusted and may be near the aggregate import cap. The former lazy, repeated
  // regex had quadratic failure cases on repeated markers; fixed-token scans keep this pass linear.
  const nameMarker = '<b>name:</b>';
  const instructionsMarker = '<br><b>instructions:</b>';
  let cursor = 0;
  for (;;) {
    const markerAt = findAsciiToken(html, nameMarker, cursor);
    if (markerAt === -1) {
      break;
    }
    const nameStart = markerAt + nameMarker.length;
    const instructionsAt = findAsciiToken(html, instructionsMarker, nameStart);
    if (instructionsAt === -1) {
      break;
    }
    const instructionsStart = instructionsAt + instructionsMarker.length;
    let end = instructionsStart;
    while (
      end < html.length &&
      !startsWithAsciiToken(html, '<br><br>', end) &&
      !startsWithAsciiToken(html, '<b>name:', end) &&
      !startsWithAsciiToken(html, '</div>', end)
    ) {
      end += 1;
    }
    const name = decodeEntities(stripHtml(html.slice(nameStart, instructionsAt))).trim();
    const instructions = decodeEntities(stripHtml(html.slice(instructionsStart, end))).trim();
    if (name && instructions) {
      out.push({ name, instructions });
    }
    cursor = end;
  }
  return out;
}

/**
 * Gemini / Google Takeout. Conversation-history `.txt` files (each JSON with `conversation_turns`)
 * become episodic digests; exported "Gems" (custom assistant instructions — the user's stated
 * preferences) become procedural memories. Iterates the whole extracted tree.
 */
export function parseGeminiExport(files: SourceFiles): ImportResult {
  const warnings: string[] = [];
  const memories: ImportedMemory[] = [];

  for (const [name, content] of Object.entries(files)) {
    if (
      name.includes('Conversation History/') &&
      name.endsWith('.txt') &&
      !name.includes('\n') &&
      !name.includes('\r') &&
      !name.includes('\u2028') &&
      !name.includes('\u2029')
    ) {
      try {
        const conv = JSON.parse(content) as GeminiConv;
        const firstUser = (conv.conversation_turns ?? [])
          .map((t) => t.user_turn?.prompt)
          .find((p): p is string => Boolean(p));
        if (!firstUser) {
          continue;
        }
        const title = (conv.title ?? '').trim() || 'Untitled';
        // creation_time is an ISO string in Takeout exports — validate, then let
        // importMemories use it as the memory's createdAt
        const sourceCreatedAt = sourceTimestamp(conv.creation_time);
        memories.push({
          type: 'episodic',
          scope: 'user',
          confidence: 0.5,
          content: truncate(`[Gemini] ${title}: ${firstUser}`),
          provenance: { source: 'gemini', date: conv.creation_time },
          ...(sourceCreatedAt !== undefined && { sourceCreatedAt }),
        });
      } catch (err) {
        warnings.push(`${name}: could not parse (${errMsg(err)})`);
      }
    } else if (name.endsWith('gemini_gems_data.html')) {
      for (const gem of parseGems(content)) {
        memories.push({
          type: 'procedural',
          scope: 'user',
          confidence: 0.7,
          content: truncate(`[Gemini Gem: ${gem.name}] ${gem.instructions}`, 800),
          provenance: { source: 'gemini-gem' },
        });
      }
    }
  }

  if (memories.length === 0) {
    warnings.push('no Gemini conversations or gems found');
  }
  return { source: 'gemini', memories, warnings };
}
