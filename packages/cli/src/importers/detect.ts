import { type SourceFiles, pick } from '@sthayi/core';

export type Source = 'claude' | 'chatgpt' | 'gemini';

/**
 * Detect the export type from the extracted files. Claude and ChatGPT both ship `conversations.json`
 * — they are told apart by shape (Claude: `chat_messages`; ChatGPT: `mapping`). Gemini is a Takeout
 * tree with conversation `.txt` files and a gems HTML.
 */
export function detectSource(files: SourceFiles): Source | null {
  const names = Object.keys(files);
  if (
    names.some(
      (name) =>
        (name.includes('Conversation History/') &&
          name.endsWith('.txt') &&
          !name.includes('\n') &&
          !name.includes('\r') &&
          !name.includes('\u2028') &&
          !name.includes('\u2029')) ||
        name.endsWith('gemini_gems_data.html'),
    )
  ) {
    return 'gemini';
  }

  const conv = pick(files, 'conversations.json');
  if (conv !== undefined) {
    try {
      const arr = JSON.parse(conv) as unknown[];
      const first = arr[0] as Record<string, unknown> | undefined;
      if (first && 'mapping' in first) {
        return 'chatgpt';
      }
      if (first && 'chat_messages' in first) {
        return 'claude';
      }
    } catch {
      // fall through to filename heuristics
    }
  }

  if (pick(files, 'users.json') !== undefined) {
    return 'claude';
  }
  if (pick(files, 'user.json') !== undefined) {
    return 'chatgpt';
  }
  return conv !== undefined ? 'claude' : null;
}
