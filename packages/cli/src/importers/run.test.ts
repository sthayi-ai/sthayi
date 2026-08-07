import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AssocService,
  type CryptoPort,
  JournalService,
  MemoryService,
  VaultService,
} from '@sthayi/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeHome, createFakeHome } from '../../../../tests/helpers/fake-home.js';
import { SqliteDriver } from '../drivers/sqlite.js';
import type { Store } from '../store.js';
import { detectSource } from './detect.js';
import { loadArchive } from './load.js';
import { runImport } from './run.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const importsDir = path.join(repoRoot, 'tests', 'fixtures', 'imports');

const fakeCrypto: CryptoPort = {
  encrypt: (s) => new TextEncoder().encode(s),
  decrypt: (b) => new TextDecoder().decode(b),
};

function makeStore(): { store: Store; driver: SqliteDriver } {
  const driver = SqliteDriver.openMemory();
  driver.migrate();
  const journal = new JournalService(driver);
  const vault = new VaultService(driver, fakeCrypto, {});
  const assoc = new AssocService(driver);
  const memory = new MemoryService(driver, journal, vault, assoc);
  return { store: { driver, journal, memory, vault, assoc, close: () => driver.close() }, driver };
}

describe('importer end-to-end (folder archives)', () => {
  let home: FakeHome;
  beforeEach(() => {
    home = createFakeHome();
  });
  afterEach(() => home.cleanup());

  it('detects each source type from an extracted folder', async () => {
    expect(detectSource(await loadArchive(path.join(importsDir, 'claude')))).toBe('claude');
    expect(detectSource(await loadArchive(path.join(importsDir, 'chatgpt')))).toBe('chatgpt');
    expect(detectSource(await loadArchive(path.join(importsDir, 'gemini')))).toBe('gemini');
  });

  it('detects hostile Gemini path names in linear time and rejects line terminators', () => {
    const repeated = 'Conversation History/'.repeat(30_000);
    const started = performance.now();
    expect(detectSource({ [`${repeated}chat.txt`]: '{}' })).toBe('gemini');
    expect(detectSource({ [`${repeated}chat.bin`]: '{}' })).toBeNull();
    expect(detectSource({ 'Takeout/Conversation History/chat\n.txt': '{}' })).toBeNull();
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('imports the Claude fixture as proposals', async () => {
    const { store, driver } = makeStore();
    const s = await runImport(path.join(importsDir, 'claude'), store, 1_700_000_000_000);
    expect(s.source).toBe('claude');
    expect(s.imported).toBeGreaterThan(0);
    expect(driver.listMemories({ status: 'proposed' }).length).toBe(s.imported);
    driver.close();
  });

  it('imports the Gemini fixture and re-import adds zero (dedup)', async () => {
    const { store, driver } = makeStore();
    const first = await runImport(path.join(importsDir, 'gemini'), store, 1);
    expect(first.source).toBe('gemini');
    expect(first.imported).toBe(3);

    const second = await runImport(path.join(importsDir, 'gemini'), store, 2);
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(3);
    driver.close();
  });

  it('throws an actionable error on an unrecognized folder', async () => {
    await expect(runImport(home.home, makeStore().store, 1)).rejects.toThrow(/could not detect/);
  });

  it('surfaces loader containment warnings (skipped symlink) in the import summary', async () => {
    const { store, driver } = makeStore();
    const archive = home.path('claude-export');
    fs.mkdirSync(archive, { recursive: true });
    fs.copyFileSync(
      path.join(importsDir, 'claude', 'conversations.json'),
      path.join(archive, 'conversations.json'),
    );
    try {
      fs.symlinkSync(
        path.join(importsDir, 'claude', 'memories.json'),
        path.join(archive, 'memories.json'),
      );
    } catch {
      driver.close();
      return; // platform without symlink privilege — POSIX runners cover this row
    }
    const s = await runImport(archive, store, 1_700_000_000_000);
    expect(s.source).toBe('claude');
    expect(s.warnings.some((w) => w.includes('memories.json') && w.includes('symlink'))).toBe(true);
    driver.close();
  });
});
