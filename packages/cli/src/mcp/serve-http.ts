import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import path from 'node:path';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { safeReadTextFile, safeWriteFileAtomic } from '../fs-safe.js';
import { ensureSthayiHome, sthayiHomeRoot } from '../paths.js';
import { fileLog } from './logger.js';
import { type McpServerDeps, buildMcpServer } from './server.js';

/**
 * `sthayi serve --http` — the same MCP server over authenticated Streamable HTTP, for clients
 * that only speak remote MCP (ChatGPT custom connectors). Sovereignty posture: binds loopback
 * only; exposing it further is the USER's explicit act (a reverse proxy, Tailscale, their VPS)
 * — "optional transport you can self-host; local is the product". The bearer token is generated
 * locally into ~/.sthayi/http-token (0600) — it is a local credential, not an account.
 */

const TOKEN_BYTES = 32;

/**
 * Recognizable token prefix: an unprefixed base64url blob is invisible to secret
 * detectors, so a pasted token could land plaintext in memory. `sthayi_tk_<base64url>` has a
 * dedicated detector in the vault pack — the token masks like any other secret.
 */
const TOKEN_PREFIX = 'sthayi_tk_';

/** Reject request bodies larger than this BEFORE buffering more. */
const MAX_BODY_BYTES = 1024 * 1024;

/** Session-map bounds: hard cap + idle expiry, so an abusive or leaky client cannot
 *  grow the transport map without bound. Overridable per-server for tests. */
const DEFAULT_MAX_SESSIONS = 32;
const DEFAULT_SESSION_IDLE_MS = 30 * 60 * 1000;

export function httpTokenPath(): string {
  return path.join(sthayiHomeRoot(), 'http-token');
}

/** Freshly minted `sthayi_tk_` token (32 random bytes, base64url). */
function mintToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString('base64url')}`;
}

/**
 * Read the shared-secret token, generating it (0600, `sthayi_tk_` prefixed) on first use.
 *
 * Trust boundary (fs-safe): the token file is a credential, so reads refuse a symlinked,
 * hard-linked, foreign-owned, or group/world-accessible file with an actionable error, and
 * writes are exclusive-create random-temp + atomic rename, mode 0600 — never through a link.
 *
 * Legacy migration: a token file from before the `sthayi_tk_` prefix existed holds an
 * UNPREFIXED blob that secret detectors cannot recognize — pasted into a memory it would land
 * in plaintext. On the next `serve --http` start such a token is ROTATED in place to the
 * detectable format: the old value stops authenticating immediately and one actionable log
 * line tells the user their HTTP clients must pick up the new value.
 */
export function ensureHttpToken(): string {
  ensureSthayiHome();
  const p = httpTokenPath();
  const existing = safeReadTextFile(p, 'HTTP token file', { modePolicy: 'private' });
  if (existing !== undefined) {
    const current = existing.trim();
    if (current.startsWith(TOKEN_PREFIX)) {
      return current; // healthy modern token — rotating a live credential is the user's call
    }
    const rotated = mintToken();
    safeWriteFileAtomic(p, `${rotated}\n`, { mode: 0o600 });
    fileLog(
      `http token ROTATED: ${p} held a legacy unprefixed token (invisible to secret detectors) — it was replaced with a detectable ${TOKEN_PREFIX} token; the old value no longer authenticates, update your HTTP clients with the new value from ${p}`,
    );
    return rotated;
  }
  const token = mintToken();
  safeWriteFileAtomic(p, `${token}\n`, { mode: 0o600 });
  return token;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function rpcError(res: ServerResponse, status: number, code: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

function bearerToken(req: IncomingMessage): string | undefined {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
  return m?.[1];
}

function tokenMatches(presented: string | undefined, expected: string): boolean {
  const a = Buffer.from(presented ?? '');
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The overflow contract: respond 413 immediately, then DRAIN the rest of the request without
 *  buffering. Sthayi does NOT send `connection: close` and does NOT destroy the socket itself —
 *  doing either would race Node's socket teardown against the client's in-flight upload (an
 *  ECONNRESET the client may hit before it reads the status). Instead the remaining upload is
 *  discarded in flowing mode (nothing retained) so the full 413 flushes. The drain is bounded by
 *  the connection: chunks are dropped on arrival and Node's request timeout
 *  (`server.requestTimeout`) reaps a client that never finishes.
 *
 *  SCOPE OF THE CLAIM: what is controlled and tested here is Sthayi's own behavior — no
 *  deliberate close or reset on an oversized upload, and a complete 413 written while draining.
 *  Whether the underlying TCP connection actually survives is not solely ours to promise: the
 *  peer, the OS, or an intermediary can still reset it. */
function payloadTooLarge(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(413, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Payload too large (max 1 MiB)' },
      id: null,
    }),
  );
  req.resume(); // discard whatever is still inbound — flowing mode, no listener buffering it
}

/**
 * Buffer a request body with the 1 MiB cap enforced INCREMENTALLY: an honest oversized request
 * dies on its Content-Length header before we read a byte; a chunked one is cut off at the first
 * chunk past the cap. Either way the contract is DETERMINISTIC: the full 413 is sent and the rest
 * of the upload is drained without buffering (see payloadTooLarge) — Sthayi never intentionally
 * closes or resets an oversized upload. Resolves undefined when
 * the response has already been handled (413 or a dead connection). Event-based on purpose: an
 * early exit from `for await` destroys the socket before the 413 could flush.
 */
function readBodyCapped(req: IncomingMessage, res: ServerResponse): Promise<Buffer | undefined> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    req.on('error', () => {
      // the client may abort its doomed upload once it reads the 413 — nothing left to answer
    });
    payloadTooLarge(req, res);
    return Promise.resolve(undefined);
  }
  return new Promise((resolve) => {
    let chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (v: Buffer | undefined): void => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    req.on('data', (c: Buffer) => {
      if (settled) {
        return; // over the cap already — the rest of the upload is discarded, never buffered
      }
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        chunks = []; // release everything buffered so far — nothing over the cap is retained
        payloadTooLarge(req, res);
        finish(undefined);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => finish(Buffer.concat(chunks)));
    req.on('error', () => finish(undefined)); // connection died — nothing left to answer
  });
}

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  lastSeen: number;
}

export interface HttpServeHandle {
  server: Server;
  port: number;
  close(): Promise<void>;
}

/**
 * Start the HTTP MCP endpoint. One McpServer + transport PER SESSION (the SDK protocol binds one
 * transport per server instance); the store is shared. `port` 0 picks a free port (tests).
 * Limits: 1 MiB body cap enforced before buffering, session map bounded by
 * `maxSessions` (idlest evicted) with `idleMs` expiry swept on every request.
 */
export function startHttpServer(
  deps: McpServerDeps,
  opts: {
    token: string;
    port: number;
    host?: string;
    maxSessions?: number;
    idleMs?: number;
    now?: () => number;
  },
): Promise<HttpServeHandle> {
  const sessions = new Map<string, SessionEntry>();
  const host = opts.host ?? '127.0.0.1';
  const maxSessions = opts.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const idleMs = opts.idleMs ?? DEFAULT_SESSION_IDLE_MS;
  const now = opts.now ?? (() => Date.now());

  const dropSession = (sid: string, reason: string): void => {
    const entry = sessions.get(sid);
    if (!entry) {
      return;
    }
    sessions.delete(sid); // delete first — transport.onclose deleting again is a no-op
    fileLog(`http session ${reason}: ${sid}`);
    void entry.transport.close().catch(() => {
      // already closing/closed — eviction must never throw into the request path
    });
  };

  /** Lazy expiry: swept on every request — no timer to leak, and the map is small by cap. */
  const sweepIdle = (): void => {
    const cutoff = now() - idleMs;
    for (const [sid, entry] of sessions) {
      if (entry.lastSeen < cutoff) {
        dropSession(sid, 'expired (idle)');
      }
    }
  };

  const server = createServer(
    async (req: IncomingMessage & { auth?: AuthInfo }, res: ServerResponse) => {
      try {
        // DNS-rebinding guard: the SDK's built-in allowedHosts option is deprecated in 1.29 —
        // enforce loopback Host ourselves (a browser can be tricked into resolving an attacker
        // domain to 127.0.0.1; the Host header betrays it).
        const hostHeader = (req.headers.host ?? '').replace(/:\d+$/, '');
        if (!LOOPBACK_HOSTS.has(hostHeader)) {
          rpcError(res, 403, -32000, 'Forbidden: invalid host');
          return;
        }
        if (!tokenMatches(bearerToken(req), opts.token)) {
          rpcError(res, 401, -32001, 'Unauthorized: bad or missing bearer token');
          return;
        }
        const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
        if (url.pathname !== '/mcp') {
          rpcError(res, 404, -32000, 'Not found (the MCP endpoint is /mcp)');
          return;
        }
        sweepIdle();
        // surfaces to tool handlers as extra.authInfo
        req.auth = { token: opts.token, clientId: 'sthayi-http', scopes: [] };

        // Every POST body is buffered by US under the cap and handed to the transport as
        // parsedBody — the transport never reads an unbounded stream.
        let parsed: unknown;
        if (req.method === 'POST') {
          const body = await readBodyCapped(req, res);
          if (body === undefined) {
            return; // 413 already sent
          }
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            rpcError(res, 400, -32700, 'Parse error');
            return;
          }
        }

        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        if (sessionId) {
          const entry = sessions.get(sessionId);
          if (!entry) {
            rpcError(res, 404, -32001, 'Session not found (re-initialize)');
            return;
          }
          entry.lastSeen = now();
          await entry.transport.handleRequest(req, res, parsed);
          return;
        }

        // No session header: only a POST initialize may create a session.
        if (req.method !== 'POST') {
          rpcError(res, 400, -32000, 'Bad request: mcp-session-id header required');
          return;
        }
        if (!isInitializeRequest(parsed)) {
          rpcError(res, 400, -32000, 'Bad request: expected an initialize request');
          return;
        }

        // Session cap: evict the idlest session rather than grow without bound. The
        // evicted client gets a clean 404 on its next request and re-initializes.
        while (sessions.size >= maxSessions) {
          let idlest: string | undefined;
          let idlestSeen = Number.POSITIVE_INFINITY;
          for (const [sid, entry] of sessions) {
            if (entry.lastSeen < idlestSeen) {
              idlestSeen = entry.lastSeen;
              idlest = sid;
            }
          }
          if (idlest === undefined) {
            break;
          }
          dropSession(idlest, 'evicted (session cap)');
        }

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            sessions.set(sid, { transport, lastSeen: now() });
            fileLog(`http session initialized: ${sid}`);
          },
          onsessionclosed: (sid) => {
            sessions.delete(sid);
            fileLog(`http session closed: ${sid}`);
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) {
            sessions.delete(transport.sessionId);
          }
        };
        const mcp = buildMcpServer(deps);
        await mcp.connect(transport); // starts the transport — never call start() ourselves
        // We consumed the body above, so it MUST travel as parsedBody (the stream is spent).
        await transport.handleRequest(req, res, parsed);
      } catch (err) {
        fileLog(`http request error: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) {
          rpcError(res, 500, -32603, 'Internal error');
        }
      }
    },
  );

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, host, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      resolve({
        server,
        port,
        close: async () => {
          for (const { transport } of sessions.values()) {
            await transport.close();
          }
          sessions.clear();
          await new Promise<void>((r) => server.close(() => r()));
        },
      });
    });
  });
}
