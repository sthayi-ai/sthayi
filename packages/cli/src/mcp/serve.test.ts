import { PassThrough } from 'node:stream';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { describe, expect, it } from 'vitest';
import { STDIO_MAX_FRAME_BYTES, describeTransportError } from './serve.js';

/**
 * The MCP SDK's stdio transport enforces a ~10 MiB inbound frame cap (1.30:
 * `STDIO_DEFAULT_MAX_BUFFER_SIZE`). On overflow it fires `onerror` and CLOSES the transport —
 * without a wired onerror handler that is a SILENT server death. These tests pin the SDK
 * behavior empirically and prove our log line makes the failure diagnosable.
 */
describe('stdio frame cap diagnostics', () => {
  it('the SDK errors then closes when a single frame exceeds maxBufferSize (pinned empirically)', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const transport = new StdioServerTransport(stdin, stdout, { maxBufferSize: 1024 });
    const errors: Error[] = [];
    let closed = false;
    transport.onerror = (err) => {
      errors.push(err);
    };
    transport.onclose = () => {
      closed = true;
    };
    await transport.start();

    // 2 KiB with no newline — one oversized frame
    stdin.write(Buffer.alloc(2048, 0x61));
    await new Promise((r) => setImmediate(r));

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/exceeded maximum size/i);
    expect(closed).toBe(true);
  });

  it('describeTransportError turns the overflow into an actionable mcp.log line', () => {
    const line = describeTransportError(
      new Error(`ReadBuffer exceeded maximum size of ${STDIO_MAX_FRAME_BYTES} bytes`),
    );
    expect(line).toMatch(/FATAL/);
    expect(line).toMatch(/10 MiB stdio limit/);
    expect(line).toMatch(/closes the transport/);
    expect(line).toMatch(/split the payload/i); // tells the operator what to DO
  });

  it('describeTransportError passes other errors through with context', () => {
    expect(describeTransportError(new Error('EPIPE'))).toBe('transport error: EPIPE');
  });
});
