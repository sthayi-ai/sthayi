import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ensureSkillsDir } from '../skills.js';
import { type OpenedStore, StartupUnanchoredError, openStore, startupBlockers } from '../store.js';
import { fileLog } from './logger.js';
import { buildMcpServer } from './server.js';

/**
 * Inbound stdio frame cap, in bytes. This is the MCP SDK's own default (1.30:
 * `STDIO_DEFAULT_MAX_BUFFER_SIZE`), passed explicitly so the limit is a deliberate, documented
 * choice rather than an invisible SDK behavior. When a single JSON-RPC frame exceeds it, the
 * SDK's ReadBuffer throws, the transport fires `onerror` and then CLOSES — without our onerror
 * handler that is a SILENT server death ("client failed to connect", nothing in the log).
 * See `describeTransportError` for the actionable diagnosis.
 */
export const STDIO_MAX_FRAME_BYTES = 10 * 1024 * 1024;

/**
 * Turn a transport-level error into an actionable log line. The one failure worth special-casing
 * is the ReadBuffer overflow above — it kills the server by design (SDK closes the transport),
 * so the log must say what happened and what to do about it.
 */
export function describeTransportError(err: Error): string {
  if (/exceeded maximum size/i.test(err.message)) {
    const mib = STDIO_MAX_FRAME_BYTES / (1024 * 1024);
    return [
      `FATAL: an inbound JSON-RPC frame exceeded the ${mib} MiB stdio limit —`,
      'the MCP SDK drops the buffer and closes the transport, so the client sees a silent disconnect.',
      'Cause: one oversized tool call or notification. Fix: split the payload (memory_write caps are',
      `50 items × 32KB content per call). (${err.message})`,
    ].join(' ');
  }
  return `transport error: ${err.message}`;
}

/**
 * Open the store for a SERVER, and refuse to serve one whose startup already committed something
 * the anchor did not follow.
 *
 * A server has no exit code and no success line to withhold — its whole report is "it is running".
 * So the outcome has to be reported by NOT running: a store in the durable-but-unanchored state has
 * stopped accepting writes, and a model that calls memory_write against it gets a refusal it cannot
 * act on, on a store whose startup work is already durable. The blocked outcomes go to the log (the
 * only channel a stdio server owns) and travel on the error for the CLI layer to render.
 */
function openServerStore(): OpenedStore {
  const store = openStore();
  const blocked = startupBlockers(store.startup);
  if (blocked.length === 0) {
    return store;
  }
  store.close();
  for (const b of blocked) {
    fileLog(`REFUSING TO SERVE: ${b.message}`);
  }
  throw new StartupUnanchoredError(blocked);
}

/**
 * Start the HTTP MCP endpoint (`serve --http`) and return where it listens. Printing is the
 * CLI layer's job — NOTHING under mcp/ may write to stdout (safety test: in stdio mode stdout
 * is the JSON-RPC channel, and this module must stay clean regardless of mode).
 *
 * THE GATE IS THE FIRST THING THIS FUNCTION DOES, and the ordering is the safety property: see
 * {@link runServer}. A refusal that has already seeded the skills sample and minted a bearer token
 * has performed a server's initialization while reporting that no server ran.
 */
export async function runHttpServer(opts: {
  port: number;
}): Promise<{ port: number; tokenPath: string }> {
  const store = openServerStore();
  const { ensureHttpToken, httpTokenPath, startHttpServer } = await import('./serve-http.js');
  ensureSkillsDir();
  const token = ensureHttpToken();
  const handle = await startHttpServer(
    // FULL egress policy: every tool result — text, structuredContent, errors — is
    // masked for egress: secrets + PII + user-configured terms, not just secrets.
    { store, mask: (s) => store.vault.maskForEgress(s) },
    { token, port: opts.port },
  );
  fileLog(`sthayi MCP server started (http, port ${handle.port})`);
  const shutdown = async (): Promise<void> => {
    await handle.close();
    store.close();
  };
  process.once('SIGINT', () => void shutdown().then(() => process.exit(0)));
  process.once('SIGTERM', () => void shutdown().then(() => process.exit(0)));
  return { port: handle.port, tokenPath: httpTokenPath() };
}

/**
 * Run the Sthayi stdio MCP server. Keeps the process alive until the client disconnects. Writes
 * NOTHING to stdout (that stream is the JSON-RPC channel); diagnostics go to ~/.sthayi/logs/mcp.log.
 *
 * THE STARTUP GATE IS SETTLED FIRST, BEFORE ANY SERVER ARTIFACT EXISTS — before the skills sample
 * is seeded, before a transport is constructed, before a single log line claims a server is
 * starting. `openServerStore()` is what decides whether this process may serve at all, and a
 * refusal that has already written the assistant-facing skills tree has done a server's setup work
 * on a machine it is simultaneously telling the operator no server ran on. Every other artifact a
 * transport owns follows the same rule by following this call.
 */
export async function runServer(): Promise<void> {
  const store = openServerStore();
  ensureSkillsDir();
  // FULL egress policy: secrets + PII + user-configured terms on every tool result.
  const server = buildMcpServer({ store, mask: (s) => store.vault.maskForEgress(s) });
  // The undefined pair keeps the SDK's stdin/stdout defaults — naming the streams here would
  // trip the "nothing under mcp/ touches stdout" safety scan; only the frame cap is explicit.
  const transport = new StdioServerTransport(undefined, undefined, {
    maxBufferSize: STDIO_MAX_FRAME_BYTES,
  });

  transport.onerror = (err) => {
    fileLog(describeTransportError(err));
  };
  transport.onclose = () => {
    fileLog('transport closed — shutting down');
    store.close();
  };

  fileLog('sthayi MCP server starting (stdio)');
  await server.connect(transport);
  fileLog('connected — serving tools');
}
