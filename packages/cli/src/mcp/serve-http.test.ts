import fs from 'node:fs';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { JournalService, MemoryService } from '@sthayi/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeHome, createFakeHome } from '../../../../tests/helpers/fake-home.js';
import { FileCheckpoint } from '../drivers/checkpoint-file.js';
import { NodeCrypto } from '../drivers/crypto.js';
import { SqliteDriver } from '../drivers/sqlite.js';
import {
  type HttpServeHandle,
  ensureHttpToken,
  httpTokenPath,
  startHttpServer,
} from './serve-http.js';

const TOKEN = 'test-token-of-sufficient-length-123456';

function makeDeps() {
  const driver = SqliteDriver.openMemory();
  driver.migrate();
  const journal = new JournalService(driver);
  const memory = new MemoryService(driver, journal);
  return { store: { driver, journal, memory }, close: () => driver.close() };
}

function rawRequest(
  port: number,
  opts: { host?: string; token?: string; body?: string },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          ...(opts.host ? { host: opts.host } : {}),
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          body += c;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    // The server's overflow contract is 413-then-drain: Sthayi never intentionally closes or
    // resets the connection to refuse a body, so a socket error here is a real failure on
    // loopback (no intermediary can reset it) — no reset tolerance.
    req.on('error', reject);
    req.end(opts.body ?? JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }));
  });
}

describe('serve --http (authenticated Streamable HTTP endpoint)', () => {
  let deps: ReturnType<typeof makeDeps>;
  let handle: HttpServeHandle;

  beforeEach(async () => {
    deps = makeDeps();
    handle = await startHttpServer({ store: deps.store }, { token: TOKEN, port: 0 });
  });
  afterEach(async () => {
    await handle.close();
    deps.close();
  });

  it('serves the full tool surface over HTTP with bearer auth (write→search round-trip)', async () => {
    const client = new Client({ name: 'test-http-client', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${handle.port}/mcp`),
      { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } },
    );
    await client.connect(transport);

    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toContain('memory_write');
    expect(names).toContain('memory_search');

    await client.callTool({
      name: 'memory_write',
      arguments: { items: [{ type: 'semantic', content: 'the http transport round trip fact' }] },
    });
    const found = await client.callTool({
      name: 'memory_search',
      arguments: { query: 'round trip fact' },
    });
    expect(JSON.stringify(found.content)).toContain('round trip');
    await client.close();
  });

  it('rejects a missing or wrong bearer token with 401 before any MCP handling', async () => {
    expect((await rawRequest(handle.port, {})).status).toBe(401);
    expect((await rawRequest(handle.port, { token: 'wrong-token' })).status).toBe(401);
    // and the SDK client fails to connect outright
    const client = new Client({ name: 'bad', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${handle.port}/mcp`),
      { requestInit: { headers: { authorization: 'Bearer nope' } } },
    );
    await expect(client.connect(transport)).rejects.toThrow();
  });

  it('rejects non-loopback Host headers (DNS-rebinding guard) with 403', async () => {
    const r = await rawRequest(handle.port, { host: 'evil.example', token: TOKEN });
    expect(r.status).toBe(403);
  });

  it('concurrent sessions are isolated transports over one shared store', async () => {
    const connect = async () => {
      const c = new Client({ name: 'c', version: '0.0.0' });
      await c.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
        }),
      );
      return c;
    };
    const [a, b] = await Promise.all([connect(), connect()]);
    const [ta, tb] = await Promise.all([a.listTools(), b.listTools()]);
    expect(ta.tools.length).toBe(tb.tools.length);
    await Promise.all([a.close(), b.close()]);
  });

  it('a Content-Length over the cap fast-fails with 413 BEFORE any body byte is sent', async () => {
    // Deterministic by construction: the header alone triggers the 413, and the client sends
    // headers only — not one body byte ever leaves it, so nothing can race the response.
    const r = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: handle.port,
          path: '/mcp',
          method: 'POST',
          headers: {
            authorization: `Bearer ${TOKEN}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'content-length': String(8 * 1024 * 1024), // declared 8 MiB — never actually sent
          },
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => {
            body += c;
          });
          res.on('end', () => {
            resolve({ status: res.statusCode ?? 0, body });
            req.destroy(); // the assertion has its response; abandon the never-sent upload
          });
        },
      );
      req.on('error', reject);
      req.flushHeaders(); // headers on the wire, body withheld
    });
    expect(r.status).toBe(413);
    expect(r.body).toContain('Payload too large');

    // the server is immediately healthy for the next client
    expect((await rawRequest(handle.port, { token: TOKEN })).status).toBe(400);
  });

  it('a chunked (no Content-Length) >1 MiB body gets the FULL 413 — drained, no deliberate reset', async () => {
    // Node's http client streams a body with no content-length as chunked, so the cap can only
    // trip mid-stream. Contract under test: the server responds 413 and DRAINS the rest of the
    // upload without buffering, never destroying the socket itself — so the client
    // deterministically reads the complete response (a reset would reject rawRequest and fail).
    const big = JSON.stringify({
      jsonrpc: '2.0',
      method: 'ping',
      id: 1,
      pad: 'x'.repeat(1_200_000),
    });
    const r = await rawRequest(handle.port, { token: TOKEN, body: big });
    expect(r.status).toBe(413);
    const rpc = JSON.parse(r.body) as { error?: { message?: string } };
    expect(rpc.error?.message).toContain('Payload too large');

    // at/under the cap the body is read fully — a ~1 MiB non-initialize request reaches MCP
    // handling and fails with 400 (bad request), NOT 413: the cap did not fire at the boundary
    const under = JSON.stringify({
      jsonrpc: '2.0',
      method: 'ping',
      id: 1,
      pad: 'x'.repeat(1_000_000),
    });
    expect(under.length).toBeLessThanOrEqual(1024 * 1024);
    const r2 = await rawRequest(handle.port, { token: TOKEN, body: under });
    expect(r2.status).toBe(400);

    // and the server serves a healthy request immediately after the overflow
    const r3 = await rawRequest(handle.port, { token: TOKEN });
    expect(r3.status).toBe(400);
  });
});

describe('serve --http session bounds', () => {
  const connect = async (port: number) => {
    const c = new Client({ name: 'c', version: '0.0.0' });
    await c.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
      }),
    );
    return c;
  };

  it('caps the session map: the idlest session is evicted and gets a clean 404', async () => {
    const deps = makeDeps();
    const handle = await startHttpServer(
      { store: deps.store },
      { token: TOKEN, port: 0, maxSessions: 1 },
    );
    try {
      const a = await connect(handle.port);
      await a.listTools(); // a works while it is the only session
      const b = await connect(handle.port); // cap 1 → evicts a
      await b.listTools();
      await expect(a.listTools()).rejects.toThrow(); // 404 Session not found (re-initialize)
      await a.close().catch(() => {}); // its server-side transport is already gone
      await b.close();
    } finally {
      await handle.close();
      deps.close();
    }
  });

  it('expires idle sessions: after idleMs of silence the session is swept', async () => {
    const deps = makeDeps();
    const handle = await startHttpServer(
      { store: deps.store },
      { token: TOKEN, port: 0, idleMs: 50 },
    );
    try {
      const a = await connect(handle.port);
      await a.listTools();
      await new Promise((r) => setTimeout(r, 120)); // idle past the 50ms window
      await expect(a.listTools()).rejects.toThrow(); // swept on the next request → 404
      await a.close().catch(() => {}); // its server-side transport is already gone
    } finally {
      await handle.close();
      deps.close();
    }
  });

  it('an active session is NOT evicted while under the cap, and survives sweeps', async () => {
    const deps = makeDeps();
    const handle = await startHttpServer(
      { store: deps.store },
      { token: TOKEN, port: 0, maxSessions: 2, idleMs: 60_000 },
    );
    try {
      const a = await connect(handle.port);
      const b = await connect(handle.port);
      await a.listTools();
      await b.listTools(); // both fit under the cap — nobody evicted
      await Promise.all([a.close(), b.close()]);
    } finally {
      await handle.close();
      deps.close();
    }
  });
});

describe('http token file', () => {
  let home: FakeHome;
  beforeEach(() => {
    home = createFakeHome();
  });
  afterEach(() => home.cleanup());

  it.skipIf(process.platform === 'win32')('is generated once, 0600, and stable', () => {
    const t1 = ensureHttpToken();
    const t2 = ensureHttpToken();
    expect(t1).toBe(t2);
    expect(t1.length).toBeGreaterThanOrEqual(40);
    expect(fs.statSync(httpTokenPath()).mode & 0o777).toBe(0o600);
  });

  it('generates the detector-recognizable sthayi_tk_ format', () => {
    const token = ensureHttpToken();
    // exact generated shape: prefix + 43 base64url chars (32 random bytes)
    expect(token).toMatch(/^sthayi_tk_[A-Za-z0-9_-]{43}$/);
  });

  it('a pre-existing MODERN (sthayi_tk_) token file is honored as-is — never rotated', () => {
    const t1 = ensureHttpToken();
    expect(ensureHttpToken()).toBe(t1); // rotating a live credential is the user's call
  });

  it('a legacy UNPREFIXED token file is rotated to the sthayi_tk_ format on start (0600, stable)', () => {
    const legacy = 'legacy-unprefixed-token-abcdef1234567890';
    fs.writeFileSync(home.path('http-token'), `${legacy}\n`, { mode: 0o600 });
    const rotated = ensureHttpToken(); // what `sthayi serve --http` startup calls
    expect(rotated).toMatch(/^sthayi_tk_[A-Za-z0-9_-]{43}$/);
    expect(rotated).not.toBe(legacy);
    // the file now holds the rotated token, still owner-only
    expect(fs.readFileSync(home.path('http-token'), 'utf8')).toBe(`${rotated}\n`);
    if (process.platform !== 'win32') {
      expect(fs.statSync(home.path('http-token')).mode & 0o777).toBe(0o600);
    }
    // rotation is one-time: the next start returns the SAME rotated token
    expect(ensureHttpToken()).toBe(rotated);
  });

  it('after legacy rotation the OLD token is refused (401) and the NEW one authenticates', async () => {
    const legacy = 'legacy-unprefixed-token-abcdef1234567890';
    fs.writeFileSync(home.path('http-token'), `${legacy}\n`, { mode: 0o600 });
    const token = ensureHttpToken(); // rotates
    const deps = makeDeps();
    const handle = await startHttpServer({ store: deps.store }, { token, port: 0 });
    try {
      expect((await rawRequest(handle.port, { token: legacy })).status).toBe(401);
      const client = new Client({ name: 'rotated', version: '0.0.0' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }),
      );
      const tools = await client.listTools();
      expect(tools.tools.length).toBeGreaterThan(0);
      await client.close();
    } finally {
      await handle.close();
      deps.close();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a SYMLINKED token file — never follows it, external target untouched',
    () => {
      const victim = home.path('victim.txt');
      fs.writeFileSync(victim, 'victim bytes', { mode: 0o600 });
      fs.symlinkSync(victim, home.path('http-token'));
      expect(() => ensureHttpToken()).toThrow(/symlink/);
      expect(fs.lstatSync(home.path('http-token')).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(victim, 'utf8')).toBe('victim bytes');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a group/world-readable token file with an actionable chmod message',
    () => {
      fs.writeFileSync(home.path('http-token'), 'sthayi_tk_whatever\n', { mode: 0o644 });
      expect(() => ensureHttpToken()).toThrow(/chmod 600/);
      // fail closed means fail untouched — the loose file was not rewritten or deleted
      expect(fs.readFileSync(home.path('http-token'), 'utf8')).toBe('sthayi_tk_whatever\n');
    },
  );

  it('the generated token authenticates end-to-end over HTTP', async () => {
    const token = ensureHttpToken();
    const driver = SqliteDriver.openMemory();
    driver.migrate();
    const journal = new JournalService(driver);
    const memory = new MemoryService(driver, journal);
    const handle = await startHttpServer(
      { store: { driver, journal, memory } },
      { token, port: 0 },
    );
    try {
      // wrong token still 401s; the real one connects and serves tools
      expect((await rawRequest(handle.port, { token: 'sthayi_tk_wrong' })).status).toBe(401);
      const client = new Client({ name: 'tok', version: '0.0.0' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }),
      );
      const tools = await client.listTools();
      expect(tools.tools.length).toBeGreaterThan(0);
      await client.close();
    } finally {
      await handle.close();
      driver.close();
    }
  });
});
/**
 * SAFETY: the HTTP transport is the SAME server (serve-http builds it with buildMcpServer), so the
 * durable-but-unanchored outcome must reach a remote client on both channels too — not just the
 * stdio one. Real SQLite, real FileCheckpoint, a DIRECTORY planted at `journal.checkpoint.lock`.
 */
describe('serve --http: a committed-but-unanchored write reaches the remote client', () => {
  let home: FakeHome;
  let driver: SqliteDriver;
  let handle: HttpServeHandle;
  let cpFile: string;

  beforeEach(async () => {
    home = createFakeHome();
    cpFile = home.path('journal.checkpoint');
    driver = SqliteDriver.open(home.path('sthayi.db'));
    driver.migrate();
    const crypto = NodeCrypto.open(home.path('key'));
    const journal = new JournalService(driver, {
      crypto,
      external: new FileCheckpoint(cpFile),
      warn: () => {},
    });
    const memory = new MemoryService(driver, journal);
    expect(journal.seal('http-test', 1).ok).toBe(true);
    handle = await startHttpServer(
      { store: { driver, journal, memory } },
      { token: TOKEN, port: 0 },
    );
  });

  afterEach(async () => {
    await handle.close();
    driver.close();
    fs.rmSync(`${cpFile}.lock`, { recursive: true, force: true });
    home.cleanup();
  });

  async function connect(): Promise<Client> {
    const client = new Client({ name: 'degraded-http-client', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
      }),
    );
    return client;
  }

  it('degraded memory_write: text AND structuredContent carry it, warnings is not []', async () => {
    fs.mkdirSync(`${cpFile}.lock`, { recursive: true });
    const client = await connect();
    try {
      const res = (await client.callTool({
        name: 'memory_write',
        arguments: { items: [{ type: 'semantic', content: 'an unanchored http fact' }] },
      })) as unknown as {
        content: { text: string }[];
        structuredContent?: Record<string, unknown>;
        isError?: boolean;
      };
      const text = res.content[0]?.text ?? '';
      expect(res.isError).toBeFalsy();
      expect(text).toMatch(/DEGRADED/);
      expect(text).toMatch(/COMMITTED/);
      expect(text).toMatch(/DO NOT RETRY/);
      expect(text).toMatch(/Further writes are BLOCKED/);
      const sc = res.structuredContent as Record<string, unknown>;
      expect(sc.committed).toBe(true);
      expect(sc.anchor).toBe('unanchored');
      expect(sc.writesBlocked).toBe(true);
      expect(sc.doNotRetry).toBe(true);
      expect(
        (sc.warnings as string[]).length,
        'warnings came back empty over HTTP',
      ).toBeGreaterThan(0);
      expect(driver.countMemories()).toBe(1); // the write really committed
    } finally {
      await client.close();
    }
  });

  it('CONTROL: a healthy memory_write over HTTP is clean', async () => {
    const client = await connect();
    try {
      const res = (await client.callTool({
        name: 'memory_write',
        arguments: { items: [{ type: 'semantic', content: 'a healthy http fact' }] },
      })) as unknown as {
        content: { text: string }[];
        structuredContent?: Record<string, unknown>;
      };
      expect(res.content[0]?.text ?? '').not.toMatch(/DEGRADED/);
      expect((res.structuredContent as Record<string, unknown>).warnings).toEqual([]);
      expect(fs.readFileSync(cpFile, 'utf8')).toBe(driver.getMeta('journal_checkpoint'));
    } finally {
      await client.close();
    }
  });
});
