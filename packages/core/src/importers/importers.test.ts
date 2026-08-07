import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JournalService,
  MemoryService,
  type SourceFiles,
  dedupeKey,
  parseChatgptExport,
  parseClaudeExport,
  parseGeminiExport,
  parseGems,
  sourceTimestamp,
} from '@sthayi/core';
import { describe, expect, it } from 'vitest';
import { FakeStore } from '../../../../tests/helpers/fake-store.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const importsDir = path.join(repoRoot, 'tests', 'fixtures', 'imports');
const read = (rel: string): string => fs.readFileSync(path.join(importsDir, rel), 'utf8');

describe('parseClaudeExport', () => {
  const files: SourceFiles = {
    'conversations.json': read('claude/conversations.json'),
    'memories.json': read('claude/memories.json'),
    'users.json': read('claude/users.json'),
  };

  it('makes an episodic memory per non-empty conversation and semantic from memories.json', () => {
    const result = parseClaudeExport(files);
    const episodic = result.memories.filter((m) => m.type === 'episodic');
    const semantic = result.memories.filter((m) => m.type === 'semantic');
    expect(episodic).toHaveLength(1); // conv-0002 is empty and skipped
    expect(episodic[0]?.content).toMatch(/\[Claude\] Widget CLI design/);
    expect(episodic[0]?.provenance).toMatchObject({
      source: 'claude',
      conversationId: 'conv-0001',
    });
    expect(semantic.length).toBeGreaterThanOrEqual(2);
    expect(semantic.some((m) => m.scope.startsWith('project:'))).toBe(true);
    // conv-0002 has no human message → counted in the P2 skip warning
    expect(result.warnings).toEqual(['skipped 1 conversations with no human message']);
  });

  it('emits one high-confidence profile memory from users.json full_name', () => {
    const result = parseClaudeExport(files);
    const profile = result.memories.filter((m) => m.provenance.source === 'claude-profile');
    expect(profile).toHaveLength(1);
    expect(profile[0]).toMatchObject({
      type: 'semantic',
      scope: 'user',
      confidence: 0.9,
      content: "The user's name is Alex Doe.",
      provenance: {
        source: 'claude-profile',
        conversationId: '00000000-0000-0000-0000-0000000000a1',
      },
    });
  });

  it('never puts email or phone into any memory content or provenance', () => {
    const result = parseClaudeExport(files);
    for (const m of result.memories) {
      expect(m.content).not.toContain('alex@example.com');
      expect(JSON.stringify(m.provenance)).not.toContain('alex@example.com');
    }
  });

  it('emits no profile memory when users.json is absent, and warns (not throws) when malformed', () => {
    const absent = parseClaudeExport({ 'conversations.json': files['conversations.json'] ?? '' });
    expect(absent.memories.some((m) => m.provenance.source === 'claude-profile')).toBe(false);
    expect(absent.warnings.some((w) => w.includes('users.json'))).toBe(false);

    const malformed = parseClaudeExport({
      'conversations.json': files['conversations.json'] ?? '',
      'users.json': 'not json {',
    });
    expect(malformed.memories.some((m) => m.provenance.source === 'claude-profile')).toBe(false);
    expect(malformed.warnings.some((w) => /users\.json: could not parse/.test(w))).toBe(true);
  });

  it('emits no profile memory when full_name is empty or missing', () => {
    const empty = parseClaudeExport({ 'users.json': '[{"uuid":"u-1","full_name":"   "}]' });
    expect(empty.memories.some((m) => m.provenance.source === 'claude-profile')).toBe(false);
    const missing = parseClaudeExport({ 'users.json': '[{"uuid":"u-1"}]' });
    expect(missing.memories.some((m) => m.provenance.source === 'claude-profile')).toBe(false);
  });
});

describe('parseChatgptExport', () => {
  it('makes an episodic digest from each conversation mapping', () => {
    const result = parseChatgptExport({ 'conversations.json': read('chatgpt/conversations.json') });
    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]?.type).toBe('episodic');
    expect(result.memories[0]?.content).toMatch(
      /\[ChatGPT\] Preferences and stack: I use TypeScript/,
    );
    expect(result.memories[0]?.provenance.source).toBe('chatgpt');
  });

  it('emits no profile memory from user.json — the export schema has no name field', () => {
    // ChatGPT's user.json carries only id/email/chatgpt_plus_user/phone_number (see the fixture,
    // which mirrors real exports). There is no name field to import. Policy: email/phone are not
    // imported as profile facts; if ever added they must flow through at-rest masking.
    const result = parseChatgptExport({
      'conversations.json': read('chatgpt/conversations.json'),
      'user.json': read('chatgpt/user.json'),
    });
    expect(result.memories.some((m) => m.provenance.source === 'chatgpt-profile')).toBe(false);
    for (const m of result.memories) {
      expect(m.content).not.toContain('alex@example.com');
      expect(JSON.stringify(m.provenance)).not.toContain('alex@example.com');
    }
  });
});

describe('parseGeminiExport', () => {
  it('makes episodic from conversations and procedural from Gems', () => {
    const files: SourceFiles = {
      'Takeout/Gemini in Workspace/Conversation History/conversation_100.txt': read(
        'gemini/Takeout/Gemini in Workspace/Conversation History/conversation_100.txt',
      ),
      'Takeout/Gemini/gemini_gems_data.html': read('gemini/Takeout/Gemini/gemini_gems_data.html'),
    };
    const result = parseGeminiExport(files);
    expect(result.memories.filter((m) => m.type === 'episodic')).toHaveLength(1);
    const gems = result.memories.filter((m) => m.type === 'procedural');
    expect(gems.length).toBe(2);
    expect(gems.some((g) => g.content.includes('Widget Helper'))).toBe(true);
    expect(gems[0]?.provenance.source).toBe('gemini-gem');
  });

  it('handles adversarial repeated Gems markers and unterminated tag text in one pass', () => {
    expect(parseGems('<b>Name:</b>a'.repeat(100_000))).toEqual([]);

    const instructions = '<'.repeat(400_000);
    expect(parseGems(`<b>Name:</b>Linear<br><b>Instructions:</b>${instructions}`)).toEqual([
      { name: 'Linear', instructions },
    ]);
    expect(parseGems('<b>Name:</b>Literal<br><b>Instructions:</b>x<>y')).toEqual([
      { name: 'Literal', instructions: 'x<>y' },
    ]);
    expect(
      parseGems(
        'İ<B>NaMe:</B>One<BR><B>InStructions:</B>First<BR><BR><b>name:</b>Two<br><b>instructions:</b>Second</DIV>',
      ),
    ).toEqual([
      { name: 'One', instructions: 'First' },
      { name: 'Two', instructions: 'Second' },
    ]);
  });

  it('matches hostile conversation path names in linear time and rejects line terminators', () => {
    const repeated = 'Conversation History/'.repeat(30_000);
    const conversation = JSON.stringify({
      title: 'Hostile path probe',
      conversation_turns: [{ user_turn: { prompt: 'Remember this.' } }],
    });
    const started = performance.now();
    const accepted = parseGeminiExport({ [`${repeated}chat.txt`]: conversation });
    const wrongExtension = parseGeminiExport({ [`${repeated}chat.bin`]: conversation });
    const lineTerminator = parseGeminiExport({
      'Takeout/Conversation History/chat\n.txt': conversation,
    });
    expect(performance.now() - started).toBeLessThan(500);
    expect(accepted.memories).toHaveLength(1);
    expect(wrongExtension.memories).toHaveLength(0);
    expect(lineTerminator.memories).toHaveLength(0);
  });
});

describe('defensive parsing', () => {
  it('warns instead of throwing on malformed JSON', () => {
    const result = parseClaudeExport({ 'conversations.json': 'this is not json {' });
    expect(result.memories).toHaveLength(0);
    expect(result.warnings.some((w) => /could not parse/.test(w))).toBe(true);
  });

  it('warns when the expected files are missing', () => {
    expect(parseClaudeExport({}).warnings).toContain('conversations.json not found');
    expect(parseGeminiExport({}).warnings.some((w) => /no Gemini/.test(w))).toBe(true);
  });
});

describe('source timestamps', () => {
  it('claude: episodic memories carry the conversation created_at as sourceCreatedAt', () => {
    const result = parseClaudeExport({ 'conversations.json': read('claude/conversations.json') });
    const episodic = result.memories.find((m) => m.type === 'episodic');
    expect(episodic?.sourceCreatedAt).toBe(Date.parse('2026-01-02T10:00:00Z'));
  });

  it('chatgpt: create_time (epoch seconds) converts to epoch ms', () => {
    const result = parseChatgptExport({ 'conversations.json': read('chatgpt/conversations.json') });
    expect(result.memories[0]?.sourceCreatedAt).toBe(1_767_348_000_000);
  });

  it('gemini: creation_time ISO string becomes sourceCreatedAt', () => {
    const result = parseGeminiExport({
      'Takeout/Gemini in Workspace/Conversation History/conversation_100.txt': read(
        'gemini/Takeout/Gemini in Workspace/Conversation History/conversation_100.txt',
      ),
    });
    const episodic = result.memories.find((m) => m.type === 'episodic');
    expect(episodic?.sourceCreatedAt).toBe(Date.parse('2026-02-10T12:00:00.000000+00:00'));
  });

  it('claude: an invalid created_at is omitted, never a bogus timestamp', () => {
    const conv = (createdAt: unknown): string =>
      JSON.stringify([
        {
          uuid: 'c1',
          name: 'T',
          created_at: createdAt,
          chat_messages: [{ sender: 'human', text: 'hello there, remember this' }],
        },
      ]);
    for (const bad of ['not-a-date', '1970-05-01T00:00:00Z', null, 1e18]) {
      const result = parseClaudeExport({ 'conversations.json': conv(bad) });
      expect(result.memories[0]?.sourceCreatedAt, String(bad)).toBeUndefined();
    }
  });

  it('sourceTimestamp validates: finite, after 2000-01-01, at most 24h in the future', () => {
    const now = Date.parse('2026-06-15T00:00:00Z');
    expect(sourceTimestamp('2026-01-02T10:00:00Z', now)).toBe(Date.parse('2026-01-02T10:00:00Z'));
    expect(sourceTimestamp(1_767_348_000_000, now)).toBe(1_767_348_000_000);
    // just inside the future-skew window is accepted (clock drift tolerance)
    expect(sourceTimestamp(now + 3_600_000, now)).toBe(now + 3_600_000);
    expect(sourceTimestamp('garbage', now)).toBeUndefined();
    expect(sourceTimestamp('', now)).toBeUndefined();
    expect(sourceTimestamp(Number.NaN, now)).toBeUndefined();
    expect(sourceTimestamp(Number.POSITIVE_INFINITY, now)).toBeUndefined();
    expect(sourceTimestamp(0, now)).toBeUndefined();
    expect(sourceTimestamp(-1, now)).toBeUndefined();
    expect(sourceTimestamp('1999-12-31T23:59:59Z', now)).toBeUndefined(); // before 2000-01-01
    expect(sourceTimestamp(now + 2 * 86_400_000, now)).toBeUndefined(); // too far in the future
    expect(sourceTimestamp(undefined, now)).toBeUndefined();
    expect(sourceTimestamp({}, now)).toBeUndefined();
  });
});

describe('dedupeKey field separation', () => {
  it('a scope/type boundary shift can no longer collide (explicit separator)', () => {
    const content = 'same content';
    // without an explicit separator these concatenate to the identical 'usersemantic<hash>' string
    expect(dedupeKey('user', 'semantic', content)).not.toBe(dedupeKey('users', 'emantic', content));
    // and identical inputs still produce identical keys
    expect(dedupeKey('user', 'semantic', content)).toBe(dedupeKey('user', 'semantic', content));
  });
});

describe('import dedup (re-import → zero dupes)', () => {
  it('skips items whose normalized content already exists', () => {
    const store = new FakeStore();
    const memory = new MemoryService(store, new JournalService(store));
    const items = parseGeminiExport({
      'Takeout/Gemini in Workspace/Conversation History/conversation_100.txt': read(
        'gemini/Takeout/Gemini in Workspace/Conversation History/conversation_100.txt',
      ),
      'Takeout/Gemini/gemini_gems_data.html': read('gemini/Takeout/Gemini/gemini_gems_data.html'),
    }).memories;

    const first = memory.importMemories(items, { now: 1, source: 'gemini' });
    expect(first.imported).toBe(items.length);
    expect(first.skipped).toBe(0);

    const second = memory.importMemories(items, { now: 2, source: 'gemini' });
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(items.length);

    // journal recorded both import ops
    expect(store.allJournal().filter((r) => r.op === 'import')).toHaveLength(2);
  });
});
