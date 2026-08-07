import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_RESPONSE_BYTES,
  parseProviderSpec,
  providerFromEnv,
  safeBaseUrl,
} from './providers.js';

describe('parseProviderSpec validates the whole spec up front', () => {
  it('parses valid specs for every known provider (dots, slashes, digits in the model)', () => {
    expect(parseProviderSpec('anthropic:claude-sonnet-4-5')).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
    });
    expect(parseProviderSpec('openai:gpt-5')).toEqual({ provider: 'openai', model: 'gpt-5' });
    expect(parseProviderSpec('gemini:gemini-2.5-pro')).toEqual({
      provider: 'gemini',
      model: 'gemini-2.5-pro',
    });
    expect(parseProviderSpec('google:gemini-2.5-pro').provider).toBe('google'); // gemini alias
    expect(parseProviderSpec('openai:org/model_v1.2').model).toBe('org/model_v1.2');
  });

  it('rejects a missing colon with the provider:model shape named', () => {
    expect(() => parseProviderSpec('openai')).toThrow(/provider spec must be "provider:model"/);
  });

  it('rejects an EMPTY model ("openai:") naming the non-empty model requirement', () => {
    expect(() => parseProviderSpec('openai:')).toThrow(/missing a model/);
    expect(() => parseProviderSpec('openai:')).toThrow(/model must be non-empty/);
  });

  it('rejects an empty provider (":model") and unknown providers, listing the known ids', () => {
    expect(() => parseProviderSpec(':model')).toThrow(/unknown provider ""/);
    expect(() => parseProviderSpec('bogus:model')).toThrow(
      /unknown provider "bogus" \(use anthropic \| openai \| gemini\)/,
    );
  });

  it('rejects models over 128 chars', () => {
    expect(() => parseProviderSpec(`openai:${'a'.repeat(129)}`)).toThrow(/1-128 characters/);
    expect(parseProviderSpec(`openai:${'a'.repeat(128)}`).model).toHaveLength(128);
  });

  it('rejects models outside the sane charset (whitespace, colons, shell noise)', () => {
    for (const bad of ['openai:gpt 5', 'openai:gpt\n5', 'anthropic:mo:del', 'openai:$(id)']) {
      expect(() => parseProviderSpec(bad), bad).toThrow(/invalid model/);
    }
  });

  it('providerFromEnv refuses an invalid spec BEFORE reading any env key', () => {
    // no key in env — yet the spec error (not a key error) must surface first
    expect(() => providerFromEnv('openai:', {} as NodeJS.ProcessEnv)).toThrow(/missing a model/);
    expect(() => providerFromEnv('bogus:model', {} as NodeJS.ProcessEnv)).toThrow(
      /unknown provider/,
    );
  });
});

describe('oracle transport hardening', () => {
  afterEach(() => vi.unstubAllGlobals());

  describe('safeBaseUrl', () => {
    it('accepts https anywhere and http on loopback only', () => {
      expect(safeBaseUrl('https://proxy.corp.example', 'X')).toBe('https://proxy.corp.example');
      expect(safeBaseUrl('http://localhost:8080', 'X')).toBe('http://localhost:8080');
      expect(safeBaseUrl('http://127.0.0.1:4000', 'X')).toBe('http://127.0.0.1:4000');
      expect(safeBaseUrl('http://[::1]:4000', 'X')).toBe('http://[::1]:4000');
      expect(safeBaseUrl(undefined, 'X')).toBeUndefined();
      expect(safeBaseUrl('', 'X')).toBeUndefined();
    });

    it('rejects cleartext non-loopback and junk, naming the env var', () => {
      expect(() => safeBaseUrl('http://api.evil.example', 'ANTHROPIC_BASE_URL')).toThrow(
        /ANTHROPIC_BASE_URL must be https/,
      );
      expect(() => safeBaseUrl('ftp://api.example', 'OPENAI_BASE_URL')).toThrow(/must be https/);
      expect(() => safeBaseUrl('not a url', 'OPENAI_BASE_URL')).toThrow(/not a valid URL/);
      // localhost as a subdomain of an attacker domain must NOT count as loopback
      expect(() => safeBaseUrl('http://localhost.evil.example', 'X')).toThrow(/must be https/);
    });

    it('providerFromEnv enforces the guard for anthropic and openai overrides', () => {
      expect(() =>
        providerFromEnv('anthropic:m', {
          ANTHROPIC_API_KEY: 'k',
          ANTHROPIC_BASE_URL: 'http://evil.example',
        } as NodeJS.ProcessEnv),
      ).toThrow(/ANTHROPIC_BASE_URL must be https/);
      expect(() =>
        providerFromEnv('openai:m', {
          OPENAI_API_KEY: 'k',
          OPENAI_BASE_URL: 'http://evil.example',
        } as NodeJS.ProcessEnv),
      ).toThrow(/OPENAI_BASE_URL must be https/);
    });
  });

  describe('gemini key placement', () => {
    it('sends the key in the x-goog-api-key header, never in the URL', async () => {
      const calls: { url: string; init: RequestInit }[] = [];
      vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
          { status: 200 },
        );
      });

      const provider = providerFromEnv('gemini:test-model', {
        GEMINI_API_KEY: 'CANARY-gem-key',
      } as NodeJS.ProcessEnv);
      const out = await provider.complete('sys', 'usr');

      expect(out).toBe('ok');
      expect(calls).toHaveLength(1);
      const call = calls.at(0);
      if (!call) {
        throw new Error('fetch was not called');
      }
      expect(call.url).not.toContain('CANARY-gem-key');
      expect(call.url).not.toContain('key=');
      const headers = call.init.headers as Record<string, string>;
      expect(headers['x-goog-api-key']).toBe('CANARY-gem-key');
    });
  });
});

// ---------------------------------------------------------------------------
// Redirect-based credential/memory egress. Real loopback servers —
// no fetch stubs — because the invariant under test is transport behavior.
// ---------------------------------------------------------------------------

interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface TestServer {
  port: number;
  origin: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

/** Loopback http server (allowed by safeBaseUrl) that records every request it receives. */
async function startServer(
  respond: (rec: RecordedRequest, res: http.ServerResponse, port: number) => void,
): Promise<TestServer> {
  let port = 0;
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const rec: RecordedRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(rec);
      respond(rec, res, port);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

type ProviderName = 'anthropic' | 'openai' | 'gemini';

const PROVIDERS: Record<
  ProviderName,
  {
    spec: string;
    env(origin: string): NodeJS.ProcessEnv;
    /** [header name (lowercased, as node:http records it), expected value] */
    authHeader: [string, string];
    okBody: string;
    okText: string;
  }
> = {
  anthropic: {
    spec: 'anthropic:test-model',
    env: (origin) =>
      ({ ANTHROPIC_API_KEY: 'CANARY-ant-key', ANTHROPIC_BASE_URL: origin }) as NodeJS.ProcessEnv,
    authHeader: ['x-api-key', 'CANARY-ant-key'],
    okBody: JSON.stringify({ content: [{ type: 'text', text: 'ok-anthropic' }] }),
    okText: 'ok-anthropic',
  },
  openai: {
    spec: 'openai:test-model',
    env: (origin) =>
      ({ OPENAI_API_KEY: 'CANARY-oai-key', OPENAI_BASE_URL: origin }) as NodeJS.ProcessEnv,
    authHeader: ['authorization', 'Bearer CANARY-oai-key'],
    okBody: JSON.stringify({ choices: [{ message: { content: 'ok-openai' } }] }),
    okText: 'ok-openai',
  },
  gemini: {
    spec: 'gemini:test-model',
    env: (origin) =>
      ({ GEMINI_API_KEY: 'CANARY-gem-key', GEMINI_BASE_URL: origin }) as NodeJS.ProcessEnv,
    authHeader: ['x-goog-api-key', 'CANARY-gem-key'],
    okBody: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok-gemini' }] } }] }),
    okText: 'ok-gemini',
  },
};

const BATCH_CONTENT = 'CANARY-memory-batch-content';

/** Let any (buggy) in-flight follow-up request land before asserting the sink saw nothing. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

describe('oracle transport never follows redirects', () => {
  const openServers: TestServer[] = [];
  const track = (s: TestServer): TestServer => {
    openServers.push(s);
    return s;
  };
  afterEach(async () => {
    await Promise.all(openServers.splice(0).map((s) => s.close()));
  });

  describe.each(['anthropic', 'openai', 'gemini'] as ProviderName[])(
    '307 to another origin — %s',
    (name) => {
      it('rejects, sends nothing to the redirect target, and hits the origin exactly once', async () => {
        const cfg = PROVIDERS[name];
        const sink = track(
          await startServer((_rec, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(cfg.okBody);
          }),
        );
        const redirector = track(
          await startServer((_rec, res) => {
            res.writeHead(307, { location: `${sink.origin}/exfil` });
            res.end();
          }),
        );

        const provider = providerFromEnv(cfg.spec, cfg.env(redirector.origin));
        await expect(provider.complete('system prompt', BATCH_CONTENT)).rejects.toThrow(/redirect/);
        await settle();

        // The whole invariant: the redirect target receives NOTHING.
        expect(sink.requests).toHaveLength(0);

        // The configured origin got exactly one POST carrying the credential and the batch.
        expect(redirector.requests).toHaveLength(1);
        const req = redirector.requests[0];
        expect(req?.method).toBe('POST');
        const [headerName, headerValue] = cfg.authHeader;
        expect(req?.headers[headerName]).toBe(headerValue);
        expect(req?.body).toContain(BATCH_CONTENT);
      });
    },
  );

  describe.each([301, 302, 303, 308])('status %i to another origin (anthropic)', (status) => {
    it('rejects and the sink receives nothing', async () => {
      const cfg = PROVIDERS.anthropic;
      const sink = track(
        await startServer((_rec, res) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(cfg.okBody);
        }),
      );
      const redirector = track(
        await startServer((_rec, res) => {
          res.writeHead(status, { location: `${sink.origin}/exfil` });
          res.end();
        }),
      );

      const provider = providerFromEnv(cfg.spec, cfg.env(redirector.origin));
      await expect(provider.complete('system prompt', BATCH_CONTENT)).rejects.toThrow(/redirect/);
      await settle();

      expect(sink.requests).toHaveLength(0);
      expect(redirector.requests).toHaveLength(1);
      expect(redirector.requests[0]?.headers['x-api-key']).toBe('CANARY-ant-key');
    });
  });

  it('redirect loop to self: exactly one request, prompt rejection, no hang', async () => {
    const cfg = PROVIDERS.anthropic;
    const redirector = track(
      await startServer((rec, res, port) => {
        res.writeHead(307, { location: `http://127.0.0.1:${port}${rec.url}` });
        res.end();
      }),
    );

    const provider = providerFromEnv(cfg.spec, cfg.env(redirector.origin));
    await expect(provider.complete('system prompt', BATCH_CONTENT)).rejects.toThrow(/redirect/);
    await settle();

    expect(redirector.requests).toHaveLength(1);
  }, 10_000);

  describe.each(['anthropic', 'openai', 'gemini'] as ProviderName[])(
    'non-redirect responses still work — %s',
    (name) => {
      it('200 returns text through the normal parse path', async () => {
        const cfg = PROVIDERS[name];
        const server = track(
          await startServer((_rec, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(cfg.okBody);
          }),
        );

        const provider = providerFromEnv(cfg.spec, cfg.env(server.origin));
        await expect(provider.complete('system prompt', BATCH_CONTENT)).resolves.toBe(cfg.okText);
        expect(server.requests).toHaveLength(1);
      });
    },
  );

  it('500 still rejects with the existing HTTP error (anthropic)', async () => {
    const cfg = PROVIDERS.anthropic;
    const server = track(
      await startServer((_rec, res) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"error":"boom"}');
      }),
    );

    const provider = providerFromEnv(cfg.spec, cfg.env(server.origin));
    await expect(provider.complete('system prompt', BATCH_CONTENT)).rejects.toThrow(
      /anthropic HTTP 500/,
    );
    expect(server.requests).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Response-body caps. Real loopback servers again — the invariant under test is
// that the cap is enforced on the actual byte stream, before any .json()/.text().
// ---------------------------------------------------------------------------

/** Raw streaming server: the responder gets the response object as soon as the request body has
 *  arrived, and may stream (or deliberately never finish) the response. `close()` force-drops
 *  open connections so a test that rejects mid-stream cannot hang teardown. */
async function startStreamServer(
  respond: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ origin: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    res.on('error', () => {}); // client aborts mid-stream (EPIPE/ECONNRESET) are expected
    req.on('data', () => {});
    req.on('end', () => respond(req, res));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/** Stream `total` bytes of `fill` in 1 MiB chunks, honoring backpressure, then end. */
function streamBytes(res: http.ServerResponse, total: number, fill = 0x61): void {
  const chunk = Buffer.alloc(1024 * 1024, fill);
  let sent = 0;
  const push = (): void => {
    while (sent < total) {
      const n = Math.min(chunk.length, total - sent);
      sent += n;
      if (!res.write(n === chunk.length ? chunk : chunk.subarray(0, n))) {
        res.once('drain', push);
        return;
      }
    }
    res.end();
  };
  push();
}

describe('provider response bodies are capped at 10 MiB — streamed, never trusted', () => {
  const open: { close(): Promise<void> }[] = [];
  const track = <T extends { close(): Promise<void> }>(s: T): T => {
    open.push(s);
    return s;
  };
  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
  });

  describe.each(['anthropic', 'openai', 'gemini'] as ProviderName[])(
    'declared oversize (Content-Length > cap) — %s',
    (name) => {
      it('rejects on the header alone, before the body is consumed', async () => {
        const cfg = PROVIDERS[name];
        const server = track(
          await startStreamServer((_req, res) => {
            // Headers declare 10 MiB + 1; the body NEVER arrives. Only a header-level
            // fast-fail can reject promptly — waiting for body bytes would hang the test.
            res.writeHead(200, {
              'content-type': 'application/json',
              'content-length': String(MAX_RESPONSE_BYTES + 1),
            });
            res.flushHeaders();
          }),
        );
        const provider = providerFromEnv(cfg.spec, cfg.env(server.origin));
        await expect(provider.complete('sys', BATCH_CONTENT)).rejects.toThrow(
          /Content-Length .* over the 10 MiB response cap/,
        );
      }, 15_000);
    },
  );

  describe.each(['anthropic', 'openai', 'gemini'] as ProviderName[])(
    'chunked/undeclared oversize on a 200 — %s',
    (name) => {
      it('is rejected AT the cap while the body streams (no Content-Length to trust)', async () => {
        const cfg = PROVIDERS[name];
        const server = track(
          await startStreamServer((_req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' }); // chunked: no length
            streamBytes(res, MAX_RESPONSE_BYTES + 2 * 1024 * 1024);
          }),
        );
        const provider = providerFromEnv(cfg.spec, cfg.env(server.origin));
        await expect(provider.complete('sys', BATCH_CONTENT)).rejects.toThrow(
          /body exceeded the 10 MiB response cap/,
        );
      }, 15_000);
    },
  );

  it('chunked/undeclared oversize on a 500 (error-detail read) is capped the same way', async () => {
    const cfg = PROVIDERS.anthropic;
    const server = track(
      await startStreamServer((_req, res) => {
        res.writeHead(500, { 'content-type': 'application/json' }); // chunked error body
        streamBytes(res, MAX_RESPONSE_BYTES + 2 * 1024 * 1024);
      }),
    );
    const provider = providerFromEnv(cfg.spec, cfg.env(server.origin));
    await expect(provider.complete('sys', BATCH_CONTENT)).rejects.toThrow(
      /body exceeded the 10 MiB response cap/,
    );
  }, 15_000);

  it('a body of exactly the cap still parses (at-cap succeeds, cap is > not >=)', async () => {
    const cfg = PROVIDERS.anthropic;
    const prefix = '{"content":[{"type":"text","text":"';
    const suffix = '"}]}';
    const pad = MAX_RESPONSE_BYTES - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
    const body = `${prefix}${'a'.repeat(pad)}${suffix}`;
    expect(Buffer.byteLength(body)).toBe(MAX_RESPONSE_BYTES);
    const server = track(
      await startStreamServer((_req, res) => {
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-length': String(MAX_RESPONSE_BYTES),
        });
        res.end(body);
      }),
    );
    const provider = providerFromEnv(cfg.spec, cfg.env(server.origin));
    const out = await provider.complete('sys', BATCH_CONTENT);
    expect(out).toHaveLength(pad);
    expect(out.startsWith('aaa')).toBe(true);
  }, 15_000);
});
