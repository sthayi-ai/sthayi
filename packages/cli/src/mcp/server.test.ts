import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { JournalService, type Memory, MemoryService, VaultService } from '@sthayi/core';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeHome, createFakeHome } from '../../../../tests/helpers/fake-home.js';
import { FakeStore } from '../../../../tests/helpers/fake-store.js';
import { FileCheckpoint } from '../drivers/checkpoint-file.js';
import { NodeCrypto } from '../drivers/crypto.js';
import { SqliteDriver } from '../drivers/sqlite.js';
import { ensureSkillsDir } from '../skills.js';
import { buildMcpServer } from './server.js';

interface StructResult {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<StructResult> {
  return (await client.callTool({ name, arguments: args })) as unknown as StructResult;
}

describe('MCP server (keyless, in-memory transport)', () => {
  let home: FakeHome;
  let driver: SqliteDriver;
  let client: Client;
  let memory: MemoryService;

  beforeEach(async () => {
    home = createFakeHome();
    driver = SqliteDriver.openMemory();
    driver.migrate();
    const journal = new JournalService(driver);
    memory = new MemoryService(driver, journal);
    ensureSkillsDir();
    const server = buildMcpServer({ store: { driver, journal, memory } });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-client', version: '0.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    driver.close();
    home.cleanup();
  });

  it('exposes exactly the seven v0 tools with honest annotations', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'journal_recent',
        'mcp_lookup',
        'memory_review',
        'memory_search',
        'memory_write',
        'skill_get',
        'skill_list',
      ].sort(),
    );
    const search = tools.find((t) => t.name === 'memory_search');
    const write = tools.find((t) => t.name === 'memory_write');
    const review = tools.find((t) => t.name === 'memory_review');
    // memory_search MUTATES (retrieval bump + journal append) — it must not claim
    // read-only; the side-effect test below proves the journal actually grows.
    expect(search?.annotations?.readOnlyHint).toBe(false);
    expect(search?.description).toMatch(/NOT read-only/);
    expect(write?.annotations?.readOnlyHint).toBe(false);
    // reject archives proposals — destructive from the caller's perspective
    expect(review?.annotations?.destructiveHint).toBe(true);
    // genuinely read-only tools keep the hint
    for (const name of ['skill_list', 'skill_get', 'mcp_lookup', 'journal_recent']) {
      expect(
        tools.find((t) => t.name === name)?.annotations?.readOnlyHint,
        `${name} should stay readOnlyHint: true`,
      ).toBe(true);
    }
    for (const t of tools) {
      expect(t.annotations?.openWorldHint).toBe(false);
    }
  });

  it('memory_search annotations are truthful: a search grows the journal', async () => {
    await callTool(client, 'memory_write', {
      items: [{ type: 'semantic', content: 'annotation truth fixture' }],
    });
    const before = driver.allJournal().length;
    const res = await callTool(client, 'memory_search', { query: 'annotation truth' });
    expect(res.isError).not.toBe(true);
    const after = driver.allJournal().length;
    // the observed side effect (journal grew, retrieval bumped) is exactly why the tool must
    // not advertise readOnlyHint: true
    expect(after).toBeGreaterThan(before);
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === 'memory_search')?.annotations?.readOnlyHint).toBe(false);
  });

  it('teaches agents the contract via the instructions field', () => {
    const instructions = client.getInstructions();
    expect(instructions ?? '').toMatch(/memory_search/);
    expect(instructions ?? '').toMatch(/NEVER write secrets/i);
  });

  it('memory_write → memory_search round-trips through the tools', async () => {
    const write = await callTool(client, 'memory_write', {
      items: [{ type: 'semantic', content: 'The user deploys on Fridays and uses pnpm' }],
    });
    const ids = (write.structuredContent?.ids as string[]) ?? [];
    expect(ids).toHaveLength(1);

    const search = await callTool(client, 'memory_search', { query: 'deploy pnpm', k: 5 });
    const hits = (search.structuredContent?.hits as { id: string }[]) ?? [];
    expect(hits.map((h) => h.id)).toContain(ids[0]);
    expect(search.content[0]?.text).toMatch(/pnpm/);
  });

  it('memory_search honors the scope param (spec §4)', async () => {
    await callTool(client, 'memory_write', {
      items: [
        { type: 'semantic', content: 'release ritual: tag then publish', scope: 'user' },
        { type: 'semantic', content: 'release ritual: atlas pipeline', scope: 'project:atlas' },
      ],
    });
    const scoped = await callTool(client, 'memory_search', {
      query: 'release ritual',
      scope: 'project:atlas',
    });
    const hits = (scoped.structuredContent?.hits as { scope: string }[]) ?? [];
    expect(hits).toHaveLength(1);
    expect(hits[0]?.scope).toBe('project:atlas');

    const all = await callTool(client, 'memory_search', { query: 'release ritual' });
    expect((all.structuredContent?.hits as unknown[]) ?? []).toHaveLength(2);
  });

  it('memory_search identifies proposals until they are confirmed', async () => {
    const write = await callTool(client, 'memory_write', {
      items: [{ type: 'semantic', content: 'unicorn deployment fixture' }],
    });
    const id = (write.structuredContent?.ids as string[])[0];

    const search = await callTool(client, 'memory_search', { query: 'unicorn deployment' });
    const hits = (search.structuredContent?.hits as { id: string; status: string }[]) ?? [];
    expect(hits.find((h) => h.id === id)?.status).toBe('proposed');
    expect(search.content[0]?.text).toMatch(/proposed/);

    await callTool(client, 'memory_review', { action: 'confirm', ids: [id] });
    const after = await callTool(client, 'memory_search', { query: 'unicorn deployment' });
    const confirmedHits = (after.structuredContent?.hits as { id: string; status: string }[]) ?? [];
    expect(confirmedHits.find((h) => h.id === id)?.status).toBe('confirmed');
    expect(after.content[0]?.text).not.toMatch(/proposed/);
  });

  it('memory_review lists then confirms a proposal', async () => {
    const write = await callTool(client, 'memory_write', {
      items: [{ type: 'semantic', content: 'likes dark mode' }],
    });
    const id = (write.structuredContent?.ids as string[])[0];

    const list = await callTool(client, 'memory_review', { action: 'list' });
    expect((list.structuredContent?.proposals as unknown[]).length).toBe(1);

    const confirm = await callTool(client, 'memory_review', { action: 'confirm', ids: [id] });
    expect(confirm.structuredContent?.applied).toEqual([id]);

    const afterList = await callTool(client, 'memory_review', { action: 'list' });
    expect((afterList.structuredContent?.proposals as unknown[]).length).toBe(0);
  });

  it('memory_review confirm without ids returns an actionable error', async () => {
    const res = await callTool(client, 'memory_review', { action: 'confirm' });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toMatch(/requires an ids array/);
  });

  it('skill_list + skill_get read the sample SKILL.md', async () => {
    const list = await callTool(client, 'skill_list', {});
    const skills = (list.structuredContent?.skills as { name: string }[]) ?? [];
    expect(skills.map((s) => s.name)).toContain('using-sthayi-memory');

    const get = await callTool(client, 'skill_get', { name: 'using-sthayi-memory' });
    expect(get.content[0]?.text).toMatch(/# Using Sthayi memory/);

    const missing = await callTool(client, 'skill_get', { name: 'nope' });
    expect(missing.isError).toBe(true);
  });

  it('mcp_lookup returns an empty registry cleanly', async () => {
    const res = await callTool(client, 'mcp_lookup', {});
    expect(res.content[0]?.text).toMatch(/No MCP servers registered/);
    expect(res.structuredContent?.entries).toEqual([]);
  });

  it('journal_recent reflects writes and retrievals', async () => {
    await callTool(client, 'memory_write', {
      items: [{ type: 'semantic', content: 'alpha beta' }],
    });
    await callTool(client, 'memory_search', { query: 'alpha' });
    const res = await callTool(client, 'journal_recent', { n: 10 });
    const ops = (res.structuredContent?.entries as { op: string }[]).map((e) => e.op);
    expect(ops).toContain('memory_write');
    expect(ops).toContain('memory_retrieve');
  });

  it('caps input sizes: 32KB content, 50 items, 1KB query', async () => {
    const bigContent = await callTool(client, 'memory_write', {
      items: [{ type: 'semantic', content: 'x'.repeat(32_769) }],
    });
    expect(bigContent.isError).toBe(true);
    expect(bigContent.content[0]?.text).toMatch(/content too large/);

    const manyItems = await callTool(client, 'memory_write', {
      items: Array.from({ length: 51 }, () => ({ type: 'semantic', content: 'ok' })),
    });
    expect(manyItems.isError).toBe(true);
    expect(manyItems.content[0]?.text).toMatch(/too many items/);

    const bigQuery = await callTool(client, 'memory_search', { query: 'q'.repeat(1025) });
    expect(bigQuery.isError).toBe(true);
    expect(bigQuery.content[0]?.text).toMatch(/query too long/);

    // at-limit inputs still work
    const write = await callTool(client, 'memory_write', {
      items: [{ type: 'semantic', content: `pnpm ${'y'.repeat(32_763)}` }],
    });
    expect(write.isError).not.toBe(true);
    const search = await callTool(client, 'memory_search', { query: 'z'.repeat(1024) });
    expect(search.isError).not.toBe(true);
  });

  it('bounds memory_review ids: max 100 ids, 64 chars each, rejected before any write', async () => {
    // at the limits: accepted (no matching proposals — a clean no-op)
    const atLimit = await callTool(client, 'memory_review', {
      action: 'confirm',
      ids: Array.from({ length: 100 }, (_, i) => `id-${i}`.padEnd(64, 'x')),
    });
    expect(atLimit.isError).not.toBe(true);
    expect(atLimit.structuredContent?.applied).toEqual([]);

    const before = driver.allJournal().length;
    const tooMany = await callTool(client, 'memory_review', {
      action: 'confirm',
      ids: Array.from({ length: 101 }, (_, i) => `id-${i}`),
    });
    expect(tooMany.isError).toBe(true);
    expect(tooMany.content[0]?.text).toMatch(/too many ids/);

    const tooLong = await callTool(client, 'memory_review', {
      action: 'confirm',
      ids: ['x'.repeat(65)],
    });
    expect(tooLong.isError).toBe(true);
    expect(tooLong.content[0]?.text).toMatch(/id too long/);
    // zod rejected both BEFORE any handler ran — no transaction, no journal growth
    expect(driver.allJournal().length).toBe(before);
  });

  it('memory_search: structuredContent carries the UNROUNDED score; text renders 3 sig figs', async () => {
    const tiny = 0.0001234567891234;
    const fixture: Memory = {
      id: '01TINYSCOREFIXTURE00000000',
      type: 'semantic',
      scope: 'user',
      content: 'tiny score fixture',
      provenance: { source: 'test' },
      confidence: 0.9,
      boosts: 0,
      status: 'confirmed',
      source: 'test',
      createdAt: 1,
      updatedAt: 1,
      lastRetrievedAt: null,
      decayAt: null,
    };
    // A stub still has to carry an outcome: the tool reads one from every mutating call, and
    // `search` mutates. 'no-entry' is the honest answer for a stub that journals nothing.
    memory.search = () =>
      Object.defineProperty([{ memory: fixture, score: tiny }], 'outcome', {
        value: { state: 'no-entry' },
        enumerable: false,
      }) as ReturnType<MemoryService['search']>;

    const res = await callTool(client, 'memory_search', { query: 'tiny' });
    expect(res.isError).not.toBe(true);
    const hits = (res.structuredContent?.hits as { score: number }[]) ?? [];
    // data position: the FULL float — a consumer thresholding or re-ranking must never
    // receive a rounded (or flattened-to-zero) score
    expect(hits[0]?.score).toBe(tiny);
    // display position: the 3-significant-figure rendering — never "0.00"
    expect(res.content[0]?.text).toContain('(score 0.000123)');
    expect(res.content[0]?.text).not.toContain('(score 0)');
    expect(res.content[0]?.text).not.toContain('0.00)');
  });

  it('memory_review list is paginated and bounded (limit default 50, max 200)', async () => {
    await callTool(client, 'memory_write', {
      items: Array.from({ length: 50 }, (_, i) => ({
        type: 'semantic' as const,
        content: `proposal fixture number ${String(i).padStart(3, '0')} alpha`,
      })),
    });
    await callTool(client, 'memory_write', {
      items: Array.from({ length: 10 }, (_, i) => ({
        type: 'semantic' as const,
        content: `proposal fixture number ${String(i + 50).padStart(3, '0')} beta`,
      })),
    });

    // default limit 50 of 60 total
    const page1 = await callTool(client, 'memory_review', { action: 'list' });
    expect((page1.structuredContent?.proposals as unknown[]).length).toBe(50);
    expect(page1.structuredContent?.total).toBe(60);
    expect(page1.content[0]?.text).toMatch(/showing 50 of 60/);

    // offset walks the rest
    const page2 = await callTool(client, 'memory_review', { action: 'list', offset: 50 });
    expect((page2.structuredContent?.proposals as unknown[]).length).toBe(10);
    expect(page2.structuredContent?.offset).toBe(50);

    // explicit limit at the cap works; above the cap is a clean zod error
    const capped = await callTool(client, 'memory_review', { action: 'list', limit: 200 });
    expect(capped.isError).not.toBe(true);
    const over = await callTool(client, 'memory_review', { action: 'list', limit: 201 });
    expect(over.isError).toBe(true);
  });
});

/**
 * memory_review list must be bounded AT THE STORAGE LAYER: the page comes from
 * listMemoriesPage (SQL LIMIT/OFFSET + COUNT), and the full proposal queue is never
 * materialized through listMemories to serve one page.
 */
describe('memory_review list pagination is SQL-bounded (300-proposal queue)', () => {
  let home: FakeHome;
  let driver: SqliteDriver;
  let client: Client;
  let listMemoriesCalls: number;

  const proposal = (i: number): Memory => ({
    id: `01PAGEFIXTURE${String(i).padStart(13, '0')}`,
    type: 'semantic',
    scope: 'user',
    content: `queued proposal ${i}`,
    provenance: { source: 'seed' },
    confidence: 0.6,
    boosts: 0,
    status: 'proposed',
    source: 'seed',
    createdAt: 1000 + i,
    updatedAt: 1000 + i,
    lastRetrievedAt: null,
    decayAt: null,
  });

  beforeEach(async () => {
    home = createFakeHome();
    driver = SqliteDriver.openMemory();
    driver.migrate();
    for (let i = 0; i < 300; i++) {
      driver.insertMemory(proposal(i));
    }
    // Spy: any full-queue materialization through listMemories on the list path is a failure.
    listMemoriesCalls = 0;
    const original = driver.listMemories.bind(driver);
    driver.listMemories = (filter) => {
      listMemoriesCalls += 1;
      return original(filter);
    };
    const journal = new JournalService(driver);
    const memory = new MemoryService(driver, journal);
    ensureSkillsDir();
    const server = buildMcpServer({ store: { driver, journal, memory } });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-client', version: '0.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    driver.close();
    home.cleanup();
  });

  it('returns one bounded page + the exact total, without ever calling listMemories', async () => {
    const res = await callTool(client, 'memory_review', { action: 'list', limit: 50, offset: 120 });
    expect(res.isError).not.toBe(true);
    const proposals = (res.structuredContent?.proposals as { id: string }[]) ?? [];
    expect(proposals).toHaveLength(50);
    expect(res.structuredContent?.total).toBe(300);
    expect(res.structuredContent?.offset).toBe(120);
    // newest-first: offset 120 of 300 walks createdAt 1000+179 down to 1000+130
    expect(proposals[0]?.id).toBe(proposal(179).id);
    expect(proposals[49]?.id).toBe(proposal(130).id);
    expect(res.content[0]?.text).toMatch(/showing 50 of 300/);
    expect(listMemoriesCalls).toBe(0);
  });

  it('the driver page itself is LIMIT/OFFSET + COUNT with a correct total at the tail', () => {
    const page = driver.listMemoriesPage({ status: 'proposed' }, { limit: 50, offset: 290 });
    expect(page.rows).toHaveLength(10);
    expect(page.total).toBe(300);
    expect(page.rows[0]?.createdAt).toBe(1000 + 9);
    expect(page.rows[9]?.createdAt).toBe(1000);
    expect(listMemoriesCalls).toBe(0);
  });

  it('FakeStore mirrors the port: paged listProposals never touches listMemories', () => {
    const fake = new FakeStore();
    for (let i = 0; i < 300; i++) {
      fake.insertMemory(proposal(i));
    }
    const svc = new MemoryService(fake, new JournalService(fake));
    const page = svc.listProposals({ limit: 40, offset: 10 });
    expect(page.rows).toHaveLength(40);
    expect(page.total).toBe(300);
    expect(page.rows[0]?.createdAt).toBe(1000 + 289);
    expect(fake.listMemoriesCalls).toBe(0);
  });
});

/**
 * The MCP surface wired the way `sthayi serve` wires it — real vault masker on writes
 * AND on every tool result (text + structuredContent, success + error). Detector-valid canaries
 * placed in EVERY memory_write field must reach neither the store nor the client.
 */
describe('MCP server — sink-complete masking', () => {
  const CANARY = `sk-proj-MCPCANARY${'a'.repeat(24)}`;
  const NEEDLE = 'MCPCANARY';

  let home: FakeHome;
  let driver: SqliteDriver;
  let memory: MemoryService;
  let client: Client;
  let dbFile: string;

  beforeEach(async () => {
    home = createFakeHome();
    dbFile = home.path('sthayi.db');
    driver = SqliteDriver.open(dbFile);
    driver.migrate();
    const crypto = NodeCrypto.open(home.path('key'));
    const vault = new VaultService(driver, crypto, { now: () => 1 });
    const journal = new JournalService(driver, { crypto, masker: vault });
    memory = new MemoryService(driver, journal, vault);
    ensureSkillsDir();
    const server = buildMcpServer({
      store: { driver, journal, memory },
      // mirror production wiring (serve.ts): the FULL egress policy on every result
      mask: (s) => vault.maskForEgress(s),
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-client', version: '0.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    driver.close();
    home.cleanup();
  });

  it('a canary in EVERY memory_write field reaches neither the result nor the store', async () => {
    const res = await callTool(client, 'memory_write', {
      items: [
        {
          type: 'semantic',
          content: `the key is ${CANARY}`,
          scope: `project:${CANARY}`,
          provenance: {
            [CANARY]: 'canary as a provenance KEY',
            note: `canary value ${CANARY}`,
            nested: { deeper: [CANARY] },
          },
        },
      ],
    });
    expect(res.isError).not.toBe(true);

    // nothing egressed to the client carries the canary — text or structuredContent
    const egress = JSON.stringify(res);
    expect(egress.includes(NEEDLE), 'canary leaked into the tool result').toBe(false);
    // the masking left the result meaningful (warnings surface the pseudonyms)
    expect(egress).toMatch(/APIKEY_\d\d/);

    // nothing at rest carries the canary: memories columns, journal JSON, raw db bytes
    const raw = new Database(dbFile);
    const dump = JSON.stringify({
      memories: raw.prepare('SELECT * FROM memories').all(),
      journal: raw.prepare('SELECT * FROM journal').all(),
    });
    raw.close();
    expect(dump.includes(NEEDLE), 'canary leaked into the store').toBe(false);

    // …and a follow-up search result is clean too
    const search = await callTool(client, 'memory_search', { query: 'the key' });
    expect(JSON.stringify(search).includes(NEEDLE)).toBe(false);
  });

  it('a forced handler error carrying a canary comes back masked but still actionable', async () => {
    memory.write = () => {
      throw new Error(`store exploded while writing ${CANARY}`);
    };
    const res = await callTool(client, 'memory_write', {
      items: [{ type: 'semantic', content: 'anything' }],
    });
    expect(res.isError).toBe(true);
    const text = res.content[0]?.text ?? '';
    expect(text).toMatch(/memory_write failed/); // still says what failed
    expect(text).toMatch(/store exploded/); // still carries the diagnostic
    expect(text.includes(NEEDLE), 'canary leaked through the error path').toBe(false);
    expect(text).toMatch(/APIKEY_\d\d/); // masked, not stripped
  });
});

/**
 * The MCP surface applies the FULL egress policy — secrets + PII +
 * user-configured terms — to every result position (text, structuredContent, errors), the way
 * `sthayi serve` wires it (maskForEgress). PII and term canaries are planted RAW via the driver
 * (bypassing write-time masking) to prove the egress mask stands on its own.
 */
describe('MCP server — full egress policy: PII + configured terms', () => {
  const EMAIL = 'egress.canary@example-leak.com';
  const TERM = 'ProjectNightingale';

  let home: FakeHome;
  let driver: SqliteDriver;
  let memory: MemoryService;
  let client: Client;
  let dbFile: string;

  const rawMemory = (id: string, content: string, status: 'proposed' | 'confirmed') => ({
    id,
    type: 'semantic' as const,
    scope: 'user',
    content,
    provenance: { source: 'raw-test' },
    confidence: 0.9,
    boosts: 0,
    status,
    source: 'raw-test',
    createdAt: 1,
    updatedAt: 1,
    lastRetrievedAt: null,
    decayAt: null,
  });

  beforeEach(async () => {
    home = createFakeHome();
    dbFile = home.path('sthayi.db');
    driver = SqliteDriver.open(dbFile);
    driver.migrate();
    const crypto = NodeCrypto.open(home.path('key'));
    const vault = new VaultService(driver, crypto, { terms: [TERM], now: () => 1 });
    const journal = new JournalService(driver, { crypto, masker: vault });
    memory = new MemoryService(driver, journal, vault);
    ensureSkillsDir();
    const server = buildMcpServer({
      store: { driver, journal, memory },
      mask: (s) => vault.maskForEgress(s),
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-client', version: '0.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    driver.close();
    home.cleanup();
  });

  it('memory_search masks PII and terms in text AND structuredContent', async () => {
    driver.insertMemory(
      rawMemory('01RAWPII0000000000000000EG', `mail ${EMAIL} about ${TERM} rollout`, 'confirmed'),
    );
    const res = await callTool(client, 'memory_search', { query: 'rollout' });
    const egress = JSON.stringify(res);
    expect(egress.includes(EMAIL), 'PII leaked from memory_search').toBe(false);
    expect(egress.includes(TERM), 'term leaked from memory_search').toBe(false);
    expect(egress).toMatch(/EMAIL_\d\d/);
    expect(egress).toMatch(/TERM_\d\d/);
  });

  it('memory_review list masks PII and terms in every position', async () => {
    driver.insertMemory(
      rawMemory('01RAWPII0000000000000001EG', `ssn 123-45-6789 for ${TERM}`, 'proposed'),
    );
    const res = await callTool(client, 'memory_review', { action: 'list' });
    const egress = JSON.stringify(res);
    expect(egress.includes('123-45-6789'), 'SSN leaked from memory_review').toBe(false);
    expect(egress.includes(TERM), 'term leaked from memory_review').toBe(false);
    expect(egress).toMatch(/SSN_\d\d/);
  });

  it('error results mask PII and terms too', async () => {
    memory.search = () => {
      throw new Error(`lookup failed for ${EMAIL} on ${TERM}`);
    };
    const res = await callTool(client, 'memory_search', { query: 'anything' });
    expect(res.isError).toBe(true);
    const text = res.content[0]?.text ?? '';
    expect(text).toMatch(/memory_search failed/); // still actionable
    expect(text.includes(EMAIL), 'PII leaked through the error path').toBe(false);
    expect(text.includes(TERM), 'term leaked through the error path').toBe(false);
    expect(text).toMatch(/EMAIL_\d\d/);
  });

  it('mcp_lookup masks a term smuggled into a registry entry', async () => {
    const raw = new Database(dbFile);
    raw
      .prepare(
        'INSERT INTO mcp_registry (id, name, transport, spec, cred_env, added_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run('mcp-1', `${TERM}-server`, 'stdio', '{}', null, 1);
    raw.close();
    const res = await callTool(client, 'mcp_lookup', {});
    const egress = JSON.stringify(res);
    expect(egress.includes(TERM), 'term leaked from mcp_lookup').toBe(false);
    expect(egress).toMatch(/TERM_\d\d/);
  });
});

/**
 * SAFETY: the MCP surface must state a durable-but-unanchored outcome, and a long-lived
 * JournalService must never inherit a rolled-back transaction's mirror exemption.
 *
 * THE HAZARD. An MCP client reads `warnings: []` as clean. When `memory_write` commits but the
 * off-database anchor cannot advance — forced here by a DIRECTORY at `journal.checkpoint.lock`, so
 * the O_CREAT|O_EXCL lock can never be taken — the rows are durable AND the store has stopped
 * accepting further writes. Both channels must say so: the visible text a human reads and the
 * structuredContent a program reads. Silence on either one leaves the caller believing a store
 * that will refuse its next write is healthy.
 */
describe('MCP: durable-but-unanchored outcomes and the long-lived JournalService', () => {
  let home: FakeHome;
  let driver: SqliteDriver;
  let journal: JournalService;
  let memory: MemoryService;
  let client: Client;
  let cpFile: string;

  beforeEach(async () => {
    home = createFakeHome();
    cpFile = home.path('journal.checkpoint');
    driver = SqliteDriver.open(home.path('sthayi.db'));
    driver.migrate();
    const crypto = NodeCrypto.open(home.path('key'));
    const vault = new VaultService(driver, crypto, { now: () => 1 });
    // ONE JournalService for the whole server lifetime — exactly what `sthayi serve` holds.
    journal = new JournalService(driver, {
      crypto,
      external: new FileCheckpoint(cpFile),
      masker: vault,
      warn: () => {},
    });
    memory = new MemoryService(driver, journal, vault);
    expect(journal.seal('mcp-test', 1).ok).toBe(true);
    ensureSkillsDir();
    const server = buildMcpServer({ store: { driver, journal, memory }, now: () => 2 });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'degraded-client', version: '0.0.0' });
    await server.connect(st);
    await client.connect(ct);
  });

  afterEach(async () => {
    await client.close();
    driver.close();
    fs.rmSync(`${cpFile}.lock`, { recursive: true, force: true });
    home.cleanup();
  });

  function jam(): void {
    fs.mkdirSync(`${cpFile}.lock`, { recursive: true });
  }

  it('memory_write: the degraded status is in the TEXT and the structured output, warnings is not []', async () => {
    jam();
    const res = await callTool(client, 'memory_write', {
      items: [{ type: 'semantic', content: 'a durable but unanchored MCP fact' }],
    });
    const text = res.content[0]?.text ?? '';
    // it is NOT an error — the rows are durable and a retry would duplicate them
    expect(res.isError).toBeFalsy();
    expect(text).toMatch(/DEGRADED/);
    expect(text).toMatch(/COMMITTED/);
    expect(text).toMatch(/DO NOT RETRY/);
    expect(text).toMatch(/Further writes are BLOCKED/);
    expect(text).toMatch(/Wrote 1 proposed memory/); // the durable half is still reported

    const sc = res.structuredContent as Record<string, unknown>;
    expect(sc.committed).toBe(true);
    expect(sc.anchor).toBe('unanchored');
    expect(sc.writesBlocked).toBe(true);
    expect(sc.doNotRetry).toBe(true);
    expect(sc.outcome).toBe('committed_unanchored');
    expect(sc.status).toBe('proposed'); // the memory's own status is not clobbered
    expect(Array.isArray(sc.warnings)).toBe(true);
    expect((sc.warnings as string[]).length, 'warnings came back empty').toBeGreaterThan(0);
    expect((sc.warnings as string[]).join(' ')).toMatch(/DO NOT RETRY/);
    expect(Array.isArray(sc.degraded)).toBe(true);
    expect((sc.degraded as { journalId: number }[])[0]?.journalId).toBeTypeOf('number');

    // the write really committed
    expect(driver.countMemories()).toBe(1);
  });

  it('memory_search: the retrieval bump is a WRITE, and its degraded outcome surfaces too', async () => {
    memory.add({ type: 'semantic', content: 'searchable mcp fact' }, { now: 2 });
    jam();
    const res = await callTool(client, 'memory_search', { query: 'searchable' });
    const text = res.content[0]?.text ?? '';
    expect(text).toMatch(/DEGRADED/);
    expect(text).toMatch(/searchable mcp fact/); // the hits are still returned
    const sc = res.structuredContent as Record<string, unknown>;
    expect(sc.anchor).toBe('unanchored');
    expect((sc.warnings as string[]).length).toBeGreaterThan(0);
  });

  it('memory_review: a degraded confirm says it applied, and does not come back clean', async () => {
    const m = memory.add({ type: 'semantic', content: 'reviewable mcp fact' }, { now: 2 });
    jam();
    const res = await callTool(client, 'memory_review', { action: 'confirm', ids: [m.id] });
    const text = res.content[0]?.text ?? '';
    expect(text).toMatch(/DEGRADED/);
    expect(text).toMatch(/confirmed 1 memory/);
    const sc = res.structuredContent as Record<string, unknown>;
    expect(sc.committed).toBe(true);
    expect((sc.warnings as string[]).length).toBeGreaterThan(0);
    expect(driver.getMemory(m.id)?.status).toBe('confirmed');
  });

  it('CONTROL: a healthy memory_write is clean — no DEGRADED text, no degraded structure', async () => {
    const res = await callTool(client, 'memory_write', {
      items: [{ type: 'semantic', content: 'a healthy MCP fact' }],
    });
    const text = res.content[0]?.text ?? '';
    expect(text).toMatch(/^Wrote 1 proposed memory/);
    expect(text).not.toMatch(/DEGRADED/);
    const sc = res.structuredContent as Record<string, unknown>;
    expect(sc.anchor).toBeUndefined();
    expect(sc.outcome).toBeUndefined();
    expect(sc.warnings).toEqual([]);
  });

  it("the long-lived JournalService cannot reuse a ROLLED-BACK transaction's exemption", async () => {
    // A tool call that fails mid-transaction rolls the whole transaction back — and the server's
    // ONE JournalService lives on. With the anchor then frozen by a peer's committed write, the
    // next tool call must REFUSE rather than inherit the dead exemption.
    const peer = SqliteDriver.open(home.path('sthayi.db'));
    const peerJournal = new JournalService(peer, {
      crypto: NodeCrypto.open(home.path('key')),
      external: new FileCheckpoint(cpFile),
      warn: () => {},
    });
    try {
      // (1) an in-transaction write of the SERVER's own journal that rolls back
      expect(() =>
        driver.writeTransaction(() => {
          memory.add({ type: 'semantic', content: 'doomed mcp fact' }, { now: 2 });
          throw new Error('tool failed mid-transaction');
        }),
      ).toThrow('tool failed mid-transaction');
      expect(driver.countMemories()).toBe(0);

      // (2) the anchor freezes, and a peer commits the ONE post-gate write whose mirror fails
      jam();
      peerJournal.append({ ts: 3, actor: 'peer', op: 'memory_write', payload: { ids: [] } });
      expect(driver.allJournal()).toHaveLength(2);

      // (3) the next MCP tool call must be REFUSED, not excused by the dead exemption
      const res = await callTool(client, 'memory_write', {
        items: [{ type: 'semantic', content: 'must not be admitted' }],
      });
      expect(res.isError, JSON.stringify(res)).toBe(true);
      expect(res.content[0]?.text ?? '').toMatch(/refusing to append/);
      expect(driver.allJournal(), 'a third row was admitted on a frozen anchor').toHaveLength(2);
      expect(driver.countMemories()).toBe(0);
    } finally {
      peer.close();
    }
  });
});
