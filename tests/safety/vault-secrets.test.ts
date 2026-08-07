import fs from 'node:fs';
import { createRequire } from 'node:module';
import {
  ConsolidationService,
  type EntityKind,
  JournalService,
  MemoryService,
  VaultService,
  buildPack,
} from '@sthayi/core';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { NodeCrypto } from '../../packages/cli/src/drivers/crypto.js';
import { SqliteDriver } from '../../packages/cli/src/drivers/sqlite.js';
import { ensureHttpToken } from '../../packages/cli/src/mcp/serve-http.js';
import { buildMcpServer } from '../../packages/cli/src/mcp/server.js';
import { createFakeHome } from '../helpers/fake-home.js';

// The MCP SDK is a packages/cli dependency (pnpm strict layout) — resolve it from THERE for the
// MCP-egress legs below. The CJS require is deliberate: this file sits outside the cli package,
// and the client half only exchanges structural JSON-RPC messages with the (ESM) server half, so
// the dual module instance is harmless.
interface McpToolClient {
  connect(transport: unknown): Promise<void>;
  callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
  close(): Promise<void>;
}
const cliRequire = createRequire(new URL('../../packages/cli/package.json', import.meta.url));
const { Client } = cliRequire('@modelcontextprotocol/sdk/client/index.js') as {
  Client: new (info: { name: string; version: string }) => McpToolClient;
};
const { InMemoryTransport } = cliRequire('@modelcontextprotocol/sdk/inMemory.js') as {
  InMemoryTransport: { createLinkedPair(): [unknown, unknown] };
};

/**
 * SAFETY TEST 5 (spec §7): fake secret canaries written via memory_write must be stored MASKED,
 * be absent from the raw SQLite file (real AES-GCM at rest), and be absent from exported packs.
 * Also covers two masking bypass paths that must stay closed: search queries entering the
 * append-only journal, and oracle promote content entering the store.
 */
const CANARIES = {
  openai: 'sk-proj-CANARYaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  anthropic: 'sk-ant-api03-CANARYbbbbbbbbbbbbbbbbbbbbbbbb',
  github: 'ghp_CANARYcccccccccccccccccccccccccccccccc',
  aws: 'AKIAIOSFODNN7EXAMPLE',
  pem: '-----BEGIN RSA PRIVATE KEY-----\nCANARYddddCANARYdddd\n-----END RSA PRIVATE KEY-----',
  githubFine: 'github_pat_CANARYeeeeCANARYeeee_CANARYeeeeCANARYeeeeCANARYeeee',
  awsSecret: 'aws_secret_access_key = "CANARYffffCANARYffffCANARYffffCANARYffff"',
  jwt: 'eyJCANARYgggggggggg.eyJCANARYgggggggggg.CANARYgggggggggg',
  // assembled at runtime so the fake never looks like a live Stripe key to push-protection scanners
  stripe: ['sk', 'live', 'CANARYhhhhCANARYhhhhCANARYhhhh'].join('_'),
  // assembled at runtime so the fake never looks like a live webhook to push-protection scanners
  slackWebhook: [
    'https://hooks.slack.com/services',
    'T0CANARY00',
    'B0CANARY00',
    'CANARYiiiiCANARYiiiiCANARYii',
  ].join('/'),
  npm: 'npm_CANARYjjjjCANARYjjjjCANARYjjjjCANARY',
};
const NEEDLES = {
  openai: 'CANARYaaaa',
  anthropic: 'CANARYbbbb',
  github: 'CANARYcccc',
  aws: 'AKIAIOSFODNN7EXAMPLE',
  pem: 'CANARYdddd',
  githubFine: 'CANARYeeee',
  awsSecret: 'CANARYffff',
  jwt: 'CANARYgggg',
  stripe: 'CANARYhhhh',
  slackWebhook: 'CANARYiiii',
  npm: 'CANARYjjjj',
};

describe('safety: no plaintext secrets at rest', () => {
  it('masks secrets at write; raw db file and packs never contain them', () => {
    const home = createFakeHome();
    try {
      const dbFile = home.path('sthayi.db');
      const driver = SqliteDriver.open(dbFile);
      driver.migrate();
      const vault = new VaultService(driver, NodeCrypto.open(home.path('key')), { now: () => 1 });
      const memory = new MemoryService(driver, new JournalService(driver), vault);

      const content = Object.entries(CANARIES)
        .map(([name, canary]) => `${name} ${canary}`)
        .join(' ');
      const written = memory.write([{ type: 'semantic', content }], { now: 1, actor: 'cli' });
      const id = written[0]?.id ?? '';

      // a search whose QUERY carries canaries must not leak them into the append-only journal
      memory.search(`openai ${CANARIES.openai} aws ${CANARIES.aws}`, { now: 2, actor: 'cli' });

      // 1. stored content is masked
      const stored = driver.getMemory(id);
      expect(stored).toBeDefined();
      expect(stored?.content).toMatch(/APIKEY_0\d/);
      for (const needle of Object.values(NEEDLES)) {
        expect(stored?.content.includes(needle)).toBe(false);
      }
      driver.close();

      // 2. the raw SQLite file bytes contain no canary (masked content + AES-GCM entities)
      const fileBytes = fs.readFileSync(dbFile);
      for (const [name, needle] of Object.entries(NEEDLES)) {
        expect(fileBytes.includes(Buffer.from(needle)), `${name} leaked into the db file`).toBe(
          false,
        );
      }

      // 3. a scan of every text column also finds nothing
      const raw = new Database(dbFile);
      const dump = ['memories', 'memories_fts', 'journal', 'entities', 'meta']
        .map((t) => {
          try {
            return JSON.stringify(raw.prepare(`SELECT * FROM ${t}`).all());
          } catch {
            return '';
          }
        })
        .join('\n');
      raw.close();
      for (const needle of Object.values(NEEDLES)) {
        expect(dump.includes(needle)).toBe(false);
      }

      // 4. an exported pack never contains a canary
      const reopened = SqliteDriver.open(dbFile);
      const vault2 = new VaultService(reopened, NodeCrypto.open(home.path('key')), {});
      const pack = buildPack(reopened.listMemories(), {
        scope: 'user',
        now: 1,
        mask: (c) => vault2.maskForEgress(c),
      });
      for (const needle of Object.values(NEEDLES)) {
        expect(pack.includes(needle)).toBe(false);
      }
      reopened.close();
    } finally {
      home.cleanup();
    }
  });

  // Masking must be sink-complete — scope, source, provenance KEYS and nested values
  // are attacker-reachable string positions too, and the journal (append-only!) must never see
  // a canary either. Scans: every memories text column, raw db bytes, WAL bytes, journal JSON.
  it('masks canaries in scope, source, provenance keys and nested provenance values', () => {
    const home = createFakeHome();
    try {
      const dbFile = home.path('sthayi.db');
      const driver = SqliteDriver.open(dbFile);
      driver.migrate();
      const crypto = NodeCrypto.open(home.path('key'));
      const vault = new VaultService(driver, crypto, { now: () => 1 });
      const journal = new JournalService(driver, { crypto, masker: vault });
      const memory = new MemoryService(driver, journal, vault);

      const warnings: string[] = [];
      const written = memory.write(
        [
          {
            type: 'semantic',
            content: 'innocuous content',
            scope: `project:${CANARIES.openai}`,
            source: `client ${CANARIES.github}`,
            provenance: {
              source: 'test',
              [CANARIES.anthropic]: 'canary-as-a-KEY',
              nested: { deeper: [{ [CANARIES.npm]: `value ${CANARIES.aws}` }] },
            },
          },
        ],
        { now: 1, actor: `actor-${CANARIES.githubFine}`, warnings },
      );
      expect(written).toHaveLength(1);

      // every memories text column is clean
      const raw = new Database(dbFile);
      const memDump = JSON.stringify(raw.prepare('SELECT * FROM memories').all());
      const journalDump = JSON.stringify(raw.prepare('SELECT * FROM journal').all());
      raw.close();
      for (const [name, needle] of Object.entries(NEEDLES)) {
        expect(memDump.includes(needle), `${name} leaked into a memories column`).toBe(false);
        expect(journalDump.includes(needle), `${name} leaked into journal JSON`).toBe(false);
      }
      // masked forms actually landed (scope + provenance carry pseudonyms, not empty strings)
      const stored = driver.getMemory(written[0]?.id ?? '');
      expect(stored?.scope).toMatch(/^project:APIKEY_\d\d$/);
      expect(JSON.stringify(stored?.provenance)).toMatch(/APIKEY_\d\d/);

      // raw db bytes AND WAL bytes (read while the connection is still open) are clean
      const fileBytes = fs.readFileSync(dbFile);
      const walBytes = fs.existsSync(`${dbFile}-wal`)
        ? fs.readFileSync(`${dbFile}-wal`)
        : Buffer.alloc(0);
      expect(walBytes.length, 'expected a non-empty WAL to scan').toBeGreaterThan(0);
      for (const [name, needle] of Object.entries(NEEDLES)) {
        expect(fileBytes.includes(Buffer.from(needle)), `${name} leaked into db bytes`).toBe(false);
        expect(walBytes.includes(Buffer.from(needle)), `${name} leaked into WAL bytes`).toBe(false);
      }
      driver.close();
    } finally {
      home.cleanup();
    }
  });

  it('masks a canary smuggled through the pack SCOPE header', () => {
    const home = createFakeHome();
    try {
      const driver = SqliteDriver.open(home.path('sthayi.db'));
      driver.migrate();
      const vault = new VaultService(driver, NodeCrypto.open(home.path('key')), { now: () => 1 });
      const scope = `project:${CANARIES.openai}`;
      const pack = buildPack([], {
        scope,
        now: 1,
        mask: (c) => vault.maskForEgress(c),
      });
      expect(pack.includes(NEEDLES.openai)).toBe(false);
      expect(pack).toMatch(/scope: project:APIKEY_\d\d/);
      driver.close();
    } finally {
      home.cleanup();
    }
  });

  it('oracle rejection reasons never echo an out-of-batch canary id; journal bytes stay clean', async () => {
    const home = createFakeHome();
    try {
      const dbFile = home.path('sthayi.db');
      const driver = SqliteDriver.open(dbFile);
      driver.migrate();
      const crypto = NodeCrypto.open(home.path('key'));
      const vault = new VaultService(driver, crypto, { now: () => 1 });
      const journal = new JournalService(driver, { crypto, masker: vault });
      const memory = new MemoryService(driver, journal, vault);
      const consolidate = new ConsolidationService(driver, journal, vault);

      const src = memory.add(
        { type: 'episodic', content: 'note about deployments' },
        { now: 1, asProposal: false },
      );
      // canary as an out-of-batch id — an id is NOT detector-shaped by definition, so the
      // defence must be positional wording, not masking; use a canary that IS detector-valid to
      // prove even the worst case never reaches the journal
      const evilId = CANARIES.openai;
      const provider = {
        id: 'mock:test',
        complete: async () => JSON.stringify({ archive: [evilId] }),
      };
      const rep = await consolidate.runOracle({
        now: 2,
        provider,
        systemPrompt: 's',
        promptVersion: 'consolidate@v1',
        mask: (c) => vault.maskForEgress(c),
      });
      expect(rep.rejectedBatches).toBe(1);
      expect(driver.getMemory(src.id)?.status).toBe('confirmed'); // nothing applied

      const rejected = driver.allJournal().find((r) => r.op === 'consolidate_rejected');
      const reason = (rejected?.payload as { reason?: string })?.reason ?? '';
      // still actionable: says WHAT failed and WHERE, without echoing the raw id
      expect(reason).toMatch(/not in batch/);
      expect(reason).toMatch(/archive\[0\]/);
      expect(reason.includes(NEEDLES.openai)).toBe(false);

      const fileBytes = fs.readFileSync(dbFile);
      expect(fileBytes.includes(Buffer.from(NEEDLES.openai))).toBe(false);
      driver.close();
    } finally {
      home.cleanup();
    }
  });

  it('a provider ERROR carrying a canary is masked before it reaches the journal', async () => {
    const home = createFakeHome();
    try {
      const dbFile = home.path('sthayi.db');
      const driver = SqliteDriver.open(dbFile);
      driver.migrate();
      const crypto = NodeCrypto.open(home.path('key'));
      const vault = new VaultService(driver, crypto, { now: () => 1 });
      const journal = new JournalService(driver, { crypto, masker: vault });
      const memory = new MemoryService(driver, journal, vault);
      const consolidate = new ConsolidationService(driver, journal, vault);

      memory.add({ type: 'episodic', content: 'note' }, { now: 1, asProposal: false });
      const provider = {
        id: 'mock:test',
        complete: async (): Promise<string> => {
          throw new Error(`401 unauthorized for key ${CANARIES.anthropic}`);
        },
      };
      const rep = await consolidate.runOracle({
        now: 2,
        provider,
        systemPrompt: 's',
        promptVersion: 'consolidate@v1',
        mask: (c) => vault.maskForEgress(c),
      });
      expect(rep.rejectedBatches).toBe(1);

      const rejected = driver.allJournal().find((r) => r.op === 'consolidate_rejected');
      const reason = (rejected?.payload as { reason?: string })?.reason ?? '';
      // actionable (still a provider error with its context) but the canary is a pseudonym now
      expect(reason).toMatch(/provider error/);
      expect(reason).toMatch(/401 unauthorized/);
      expect(reason.includes(NEEDLES.anthropic)).toBe(false);
      expect(reason).toMatch(/APIKEY_\d\d/);

      const fileBytes = fs.readFileSync(dbFile);
      expect(fileBytes.includes(Buffer.from(NEEDLES.anthropic))).toBe(false);
      driver.close();
    } finally {
      home.cleanup();
    }
  });

  it('masks PII at rest: every PII class, every write position, zero needles anywhere', async () => {
    const PII = {
      email: 'pii.canary@example-leak.io',
      phone: '+15550123456',
      ssn: '123-45-6789',
      card: '4111111111111111',
    };
    const PII_NEEDLES = {
      email: 'pii.canary@example-leak.io',
      phone: '15550123456',
      ssn: '123-45-6789',
      card: '4111111111111111',
    };
    const home = createFakeHome();
    try {
      const dbFile = home.path('sthayi.db');
      const driver = SqliteDriver.open(dbFile);
      driver.migrate();
      const crypto = NodeCrypto.open(home.path('key'));
      const vault = new VaultService(driver, crypto, { now: () => 1 });
      const journal = new JournalService(driver, { crypto, masker: vault });
      const memory = new MemoryService(driver, journal, vault);

      // 1. memory_write: canaries in content, scope, provenance KEY and nested provenance value
      const warnings: string[] = [];
      const written = memory.write(
        [
          {
            type: 'semantic',
            content: `reach me at ${PII.email} or ${PII.phone}`,
            scope: `project:${PII.email}`,
            provenance: {
              source: 'test',
              [PII.phone]: 'canary-as-a-KEY',
              nested: { deeper: [{ note: `ssn ${PII.ssn} card ${PII.card}` }] },
            },
          },
        ],
        { now: 1, actor: 'cli', warnings },
      );
      expect(written).toHaveLength(1);
      // PII masks warn exactly like secrets do
      expect(warnings.some((w) => /^masked a EMAIL at write → EMAIL_\d\d$/.test(w))).toBe(true);
      expect(warnings.some((w) => /^masked a PHONE at write → PHONE_\d\d$/.test(w))).toBe(true);

      // 2. the import path masks PII the same way
      memory.importMemories(
        [
          {
            type: 'episodic',
            content: `imported note with card ${PII.card}`,
            scope: 'user',
            confidence: 0.5,
            provenance: { source: 'import-test', contact: PII.email },
          },
        ],
        { now: 2, source: 'test-import' },
      );

      // 3. a search QUERY carrying PII must reach the append-only journal masked ('reach'
      // guarantees a hit, so the retrieve entry IS journaled)
      memory.search(`reach ${PII.ssn} and ${PII.email}`, { now: 3, actor: 'cli' });

      // 4. MCP surface wired like `sthayi serve`: results carry pseudonyms, never PII
      const server = buildMcpServer({
        store: { driver, journal, memory },
        mask: (s) => vault.maskForEgress(s),
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'safety', version: '0.0.0' });
      await server.connect(serverTransport as Parameters<typeof server.connect>[0]);
      await client.connect(clientTransport);
      const searchResult = await client.callTool({
        name: 'memory_search',
        arguments: { query: 'reach me' },
      });
      const mcpEgress = JSON.stringify(searchResult);
      for (const [name, needle] of Object.entries(PII_NEEDLES)) {
        expect(mcpEgress.includes(needle), `${name} leaked into an MCP result`).toBe(false);
      }
      await client.close();

      // 5. pack output is clean
      const pack = buildPack(driver.listMemories(), {
        scope: 'user',
        now: 4,
        mask: (c) => vault.maskForEgress(c),
      });
      for (const [name, needle] of Object.entries(PII_NEEDLES)) {
        expect(pack.includes(needle), `${name} leaked into the pack`).toBe(false);
      }

      // 6. every text column of every table is clean; the stored row carries pseudonyms
      const raw = new Database(dbFile);
      const dump = ['memories', 'memories_fts', 'journal', 'entities', 'meta']
        .map((t) => {
          try {
            return JSON.stringify(raw.prepare(`SELECT * FROM ${t}`).all());
          } catch {
            return '';
          }
        })
        .join('\n');
      raw.close();
      for (const [name, needle] of Object.entries(PII_NEEDLES)) {
        expect(dump.includes(needle), `${name} leaked into a SQLite text column`).toBe(false);
      }
      const stored = driver.getMemory(written[0]?.id ?? '');
      expect(stored?.content).toMatch(/EMAIL_\d\d/);
      expect(stored?.content).toMatch(/PHONE_\d\d/);
      expect(stored?.scope).toMatch(/^project:EMAIL_\d\d$/);
      expect(JSON.stringify(stored?.provenance)).toMatch(/SSN_\d\d/);
      expect(JSON.stringify(stored?.provenance)).toMatch(/CARD_\d\d/);

      // 7. raw db bytes AND WAL bytes (connection still open) are clean
      const fileBytes = fs.readFileSync(dbFile);
      const walBytes = fs.existsSync(`${dbFile}-wal`)
        ? fs.readFileSync(`${dbFile}-wal`)
        : Buffer.alloc(0);
      expect(walBytes.length, 'expected a non-empty WAL to scan').toBeGreaterThan(0);
      for (const [name, needle] of Object.entries(PII_NEEDLES)) {
        expect(fileBytes.includes(Buffer.from(needle)), `${name} leaked into db bytes`).toBe(false);
        expect(walBytes.includes(Buffer.from(needle)), `${name} leaked into WAL bytes`).toBe(false);
      }

      // 8. the entities table holds the ENCRYPTED canonicals — recoverable locally, only there
      const mappings = vault.listMappings();
      for (const [kind, value] of [
        ['EMAIL', PII.email],
        ['PHONE', PII.phone],
        ['SSN', PII.ssn],
        ['CARD', PII.card],
      ] as [EntityKind, string][]) {
        expect(
          mappings.some((m) => m.kind === kind && m.value === value),
          `${kind} canonical missing from the vault`,
        ).toBe(true);
      }
      for (const e of driver.listEntities()) {
        expect(e.valueEnc, `entity ${e.pseudonym} stored without encryption`).not.toBeNull();
      }
      driver.close();
    } finally {
      home.cleanup();
    }
  });

  it('masks the generated sthayi_tk_ HTTP token everywhere; lookalikes stay untouched', async () => {
    const home = createFakeHome();
    try {
      const token = ensureHttpToken(); // the EXACT token `serve --http` would use
      expect(token).toMatch(/^sthayi_tk_[A-Za-z0-9_-]{43}$/);
      const needle = token.slice('sthayi_tk_'.length); // the secret payload itself

      const dbFile = home.path('sthayi.db');
      const driver = SqliteDriver.open(dbFile);
      driver.migrate();
      const crypto = NodeCrypto.open(home.path('key'));
      const vault = new VaultService(driver, crypto, { now: () => 1 });
      const journal = new JournalService(driver, { crypto, masker: vault });
      const memory = new MemoryService(driver, journal, vault);

      const written = memory.write(
        [{ type: 'semantic', content: `my sthayi http token is ${token}` }],
        { now: 1, actor: 'cli' },
      );
      expect(driver.getMemory(written[0]?.id ?? '')?.content).toMatch(/APIKEY_\d\d/);
      memory.search(`what was ${token} again`, { now: 2, actor: 'cli' });

      // MCP result leg, wired like serve
      const server = buildMcpServer({
        store: { driver, journal, memory },
        mask: (s) => vault.maskForEgress(s),
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'safety', version: '0.0.0' });
      await server.connect(serverTransport as Parameters<typeof server.connect>[0]);
      await client.connect(clientTransport);
      const res = await client.callTool({
        name: 'memory_search',
        arguments: { query: 'http token' },
      });
      expect(JSON.stringify(res).includes(needle), 'token leaked into an MCP result').toBe(false);
      await client.close();

      const pack = buildPack(driver.listMemories(), {
        scope: 'user',
        now: 3,
        mask: (c) => vault.maskForEgress(c),
      });
      expect(pack.includes(needle), 'token leaked into the pack').toBe(false);

      // FALSE POSITIVES: ordinary base64url strings and prefixless lookalikes are NOT masked
      const innocentB64 = 'Zm9vYmFyYmF6cXV4QUJDREVGMDEyMzQ1Njc4OWFiY2RlZm';
      const lookalike = `tk_${innocentB64}`;
      const w2 = memory.write(
        [{ type: 'semantic', content: `sha ${innocentB64} and ${lookalike} are fine` }],
        { now: 4, actor: 'cli' },
      );
      const storedInnocent = driver.getMemory(w2[0]?.id ?? '');
      expect(storedInnocent?.content).toContain(innocentB64);
      expect(storedInnocent?.content).toContain(lookalike);

      // raw db + WAL bytes: the real token appears nowhere
      const fileBytes = fs.readFileSync(dbFile);
      const walBytes = fs.existsSync(`${dbFile}-wal`)
        ? fs.readFileSync(`${dbFile}-wal`)
        : Buffer.alloc(0);
      expect(fileBytes.includes(Buffer.from(needle)), 'token leaked into db bytes').toBe(false);
      expect(walBytes.includes(Buffer.from(needle)), 'token leaked into WAL bytes').toBe(false);
      driver.close();
    } finally {
      home.cleanup();
    }
  });

  it('masks oracle promote content before insert; raw db bytes stay canary-free', async () => {
    const home = createFakeHome();
    try {
      const dbFile = home.path('sthayi.db');
      const driver = SqliteDriver.open(dbFile);
      driver.migrate();
      const journal = new JournalService(driver);
      const vault = new VaultService(driver, NodeCrypto.open(home.path('key')), { now: () => 1 });
      const memory = new MemoryService(driver, journal, vault);
      const consolidate = new ConsolidationService(driver, journal, vault);

      const src = memory.add(
        { type: 'episodic', content: 'we rotated the openai key today' },
        { now: 1, asProposal: false },
      );
      const provider = {
        id: 'mock:test',
        complete: async () =>
          JSON.stringify({
            promote: [{ from: src.id, to_content: `the openai key is ${CANARIES.openai}` }],
          }),
      };
      const rep = await consolidate.runOracle({
        now: 2,
        provider,
        systemPrompt: 's',
        promptVersion: 'consolidate@v1',
        mask: (c) => vault.maskForEgress(c),
      });
      expect(rep.changed).toBe(1);

      const minted = driver
        .listMemories({ type: 'semantic' })
        .find((m) => m.provenance.source === 'oracle-distill');
      expect(minted?.content).toMatch(/APIKEY_\d\d/);
      expect(minted?.content.includes(NEEDLES.openai)).toBe(false);
      driver.close();

      const fileBytes = fs.readFileSync(dbFile);
      expect(fileBytes.includes(Buffer.from(NEEDLES.openai))).toBe(false);
    } finally {
      home.cleanup();
    }
  });
});
