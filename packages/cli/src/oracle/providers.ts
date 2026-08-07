import type { ProviderPort } from '@sthayi/core';

/** Known provider ids (`google` is an accepted alias for gemini in providerFromEnv). */
const KNOWN_PROVIDERS = new Set(['anthropic', 'openai', 'gemini', 'google']);

/** Sane model-id shape: non-empty, bounded, and a conservative charset. Every real model id
 *  (claude-sonnet-4-5, gpt-5, gemini-2.5-pro, org/model paths) fits; junk that would otherwise
 *  slip through to request time — empty strings, whitespace, shell noise — does not. */
const MODEL_RE = /^[A-Za-z0-9._/-]{1,128}$/;

/**
 * Parse and VALIDATE a `provider:model` spec (every part of the spec is checked here,
 * before any store is opened or request is built — an empty or garbage model must fail the
 * invocation, not surface later as a mid-run provider error after mutations already happened).
 */
export function parseProviderSpec(spec: string): { provider: string; model: string } {
  const idx = spec.indexOf(':');
  if (idx < 0) {
    throw new Error(
      `provider spec must be "provider:model" (e.g. anthropic:claude-sonnet-4-5), got "${spec}"`,
    );
  }
  const provider = spec.slice(0, idx);
  const model = spec.slice(idx + 1);
  if (!KNOWN_PROVIDERS.has(provider)) {
    throw new Error(`unknown provider "${provider}" (use anthropic | openai | gemini)`);
  }
  if (model === '') {
    throw new Error(
      `provider spec "${spec}" is missing a model — the model must be non-empty (e.g. ${provider}:<model-id>)`,
    );
  }
  if (!MODEL_RE.test(model)) {
    throw new Error(
      `invalid model "${model}" in provider spec — a model id must be 1-128 characters from [A-Za-z0-9._/-]`,
    );
  }
  return { provider, model };
}

/**
 * A base-URL override redirects requests that carry the API key, so it must never downgrade the
 * transport: https only, with http allowed solely for loopback (local proxies).
 */
export function safeBaseUrl(raw: string | undefined, envVar: string): string | undefined {
  if (raw === undefined || raw === '') {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${envVar} is not a valid URL: "${raw}"`);
  }
  const loopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(
      `${envVar} must be https:// (http:// is allowed only for localhost) — ` +
        `refusing to send the API key over "${raw}"`,
    );
  }
  return raw;
}

/** Hard cap on ANY provider response body — success or error alike. A real oracle response is a
 *  few KB of JSON; 10 MiB leaves generous headroom while refusing a hostile/misconfigured
 *  endpoint that would otherwise buffer unbounded bytes into memory before `.json()`/`.text()`. */
export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/**
 * Read a response body with the byte cap enforced on the ACTUAL bytes as they stream — never
 * trust Content-Length alone (a lying or absent header must not bypass the cap), but DO fast-fail
 * on a declared length over the cap before consuming a single body byte. Every body read in every
 * provider (success parse AND error-detail read) goes through here; `.json()`/`.text()` are never
 * called on a raw Response.
 */
export async function readBodyCapped(
  res: Response,
  capBytes: number,
  label: string,
): Promise<string> {
  const capMiB = Math.floor(capBytes / (1024 * 1024));
  const declared = res.headers.get('content-length');
  if (declared !== null) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > capBytes) {
      // Declared oversize: reject before reading any body bytes (and drop the stream).
      await res.body?.cancel().catch(() => {});
      throw new Error(
        `${label}: response declares Content-Length ${n} bytes — over the ${capMiB} MiB response cap; refusing to read the body (a real oracle response is far smaller — check the endpoint and model)`,
      );
    }
  }
  if (!res.body) {
    return '';
  }
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > capBytes) {
      // Enforced on real bytes: a chunked/undeclared (or lying) body is aborted AT the cap.
      await reader.cancel().catch(() => {});
      throw new Error(
        `${label}: response body exceeded the ${capMiB} MiB response cap — aborting the read (a real oracle response is far smaller — check the endpoint and model)`,
      );
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

async function asText(res: Response, label: string): Promise<unknown> {
  if (!res.ok) {
    const detail = await readBodyCapped(res, MAX_RESPONSE_BYTES, label);
    throw new Error(`${label} HTTP ${res.status}: ${detail.slice(0, 300)}`);
  }
  const body = await readBodyCapped(res, MAX_RESPONSE_BYTES, label);
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${label}: response is not valid JSON`);
  }
}

/**
 * `safeBaseUrl()` validates only the initial URL, but `fetch()` follows redirects by
 * default — a 3xx from the configured endpoint would replay the POST body (memory content) and
 * the credential header to an arbitrary other origin. Detect undici's `redirect: 'error'`
 * rejection, which on Node 22 surfaces as `TypeError: fetch failed` with
 * `cause: Error: unexpected redirect` (verified empirically; matched by message across the
 * cause chain to survive shape changes).
 */
function isRedirectRejection(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; cur instanceof Error && depth < 8; depth++) {
    if (/redirect/i.test(cur.message)) {
      return true;
    }
    cur = cur.cause;
  }
  return false;
}

/** All provider HTTP goes through here: never follow a redirect, fail closed. */
async function providerFetch(url: string, init: RequestInit, label: string): Promise<Response> {
  try {
    return await fetch(url, { ...init, redirect: 'error' });
  } catch (err) {
    if (isRedirectRejection(err)) {
      throw new Error(
        `${label}: server responded with a redirect — refusing to follow (credentials and memory content are only ever sent to the configured origin)`,
      );
    }
    throw err;
  }
}

function anthropic(model: string, apiKey: string, baseUrl?: string): ProviderPort {
  const base = (baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
  return {
    id: `anthropic:${model}`,
    async complete(system, user) {
      const j = (await asText(
        await providerFetch(
          `${base}/v1/messages`,
          {
            method: 'POST',
            signal: AbortSignal.timeout(120_000),
            headers: {
              'content-type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
              model,
              max_tokens: 8192,
              system,
              messages: [{ role: 'user', content: user }],
            }),
          },
          'anthropic',
        ),
        'anthropic',
      )) as { content?: { type: string; text?: string }[] };
      return (j.content ?? [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('');
    },
  };
}

function openai(model: string, apiKey: string, baseUrl?: string): ProviderPort {
  const base = (baseUrl ?? 'https://api.openai.com').replace(/\/$/, '');
  return {
    id: `openai:${model}`,
    async complete(system, user) {
      const j = (await asText(
        await providerFetch(
          `${base}/v1/chat/completions`,
          {
            method: 'POST',
            signal: AbortSignal.timeout(120_000),
            headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
              model,
              messages: [
                { role: 'system', content: system },
                { role: 'user', content: user },
              ],
              response_format: { type: 'json_object' },
            }),
          },
          'openai',
        ),
        'openai',
      )) as { choices?: { message?: { content?: string } }[] };
      return j.choices?.[0]?.message?.content ?? '';
    },
  };
}

function gemini(model: string, apiKey: string, baseUrl?: string): ProviderPort {
  const base = (baseUrl ?? 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
  return {
    id: `gemini:${model}`,
    async complete(system, user) {
      // Key travels in a header, never the URL — URLs leak into logs/history.
      const url = `${base}/v1beta/models/${model}:generateContent`;
      const j = (await asText(
        await providerFetch(
          url,
          {
            method: 'POST',
            signal: AbortSignal.timeout(120_000),
            headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: system }] },
              contents: [{ role: 'user', parts: [{ text: user }] }],
              generationConfig: {
                responseMimeType: 'application/json',
                maxOutputTokens: 8192,
                // High reasoning: dynamic thinking budget (model thinks as much as it needs).
                // Ignored by models that don't support thinking.
                thinkingConfig: { thinkingBudget: -1 },
              },
            }),
          },
          'gemini',
        ),
        'gemini',
      )) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      return (j.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
    },
  };
}

/** Build a provider from `provider:model`, reading the API key from env (never from a file/flag). */
export function providerFromEnv(spec: string, env: NodeJS.ProcessEnv = process.env): ProviderPort {
  const { provider, model } = parseProviderSpec(spec);
  switch (provider) {
    case 'anthropic': {
      const key = env.ANTHROPIC_API_KEY;
      if (!key) {
        throw new Error('ANTHROPIC_API_KEY is not set');
      }
      return anthropic(model, key, safeBaseUrl(env.ANTHROPIC_BASE_URL, 'ANTHROPIC_BASE_URL'));
    }
    case 'openai': {
      const key = env.OPENAI_API_KEY;
      if (!key) {
        throw new Error('OPENAI_API_KEY is not set');
      }
      return openai(model, key, safeBaseUrl(env.OPENAI_BASE_URL, 'OPENAI_BASE_URL'));
    }
    case 'gemini':
    case 'google': {
      const key = env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY;
      if (!key) {
        throw new Error('GEMINI_API_KEY is not set');
      }
      return gemini(model, key, safeBaseUrl(env.GEMINI_BASE_URL, 'GEMINI_BASE_URL'));
    }
    default:
      throw new Error(`unknown provider "${provider}" (use anthropic | openai | gemini)`);
  }
}
