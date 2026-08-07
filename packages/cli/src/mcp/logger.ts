import fs from 'node:fs';
import path from 'node:path';
import { establishTrustedDir, openAppendNoFollow } from '../fs-safe.js';
import { ensureSthayiHome, logsDir } from '../paths.js';

/**
 * File logger for the stdio MCP server. THE RULE THAT SAVES A LOST AFTERNOON (mcp-server-ts skill):
 * never write to stdout in a stdio server — `console.log` corrupts the JSON-RPC stream and shows up
 * as inexplicable "client failed to connect" errors. Diagnostics go to `~/.sthayi/logs/mcp.log`.
 *
 * Hardened path (fs-safe): the WHOLE chain is validated per call — ensureSthayiHome refuses a
 * symlinked/foreign home, and establishTrustedDir refuses a `logs` entry that is a symlink:
 * mkdir'ing blindly through one would let `<home>/logs -> outside` redirect every append into an
 * attacker-chosen tree. The log itself is opened O_NOFOLLOW (lstat-guarded where the platform
 * lacks it) and fstat-verified on the open fd — a symlinked, hard-linked, or foreign-owned
 * mcp.log is REFUSED. Every refusal is turned by the catch below into a dropped line: a hijacked
 * target is never written through. A fresh log file is created 0600 in a 0700 logs dir.
 */
export function fileLog(message: string): void {
  try {
    ensureSthayiHome();
    const dir = logsDir();
    establishTrustedDir(dir, 'MCP log directory', { mode: 0o700 });
    const fd = openAppendNoFollow(path.join(dir, 'mcp.log'), 0o600);
    try {
      fs.writeSync(fd, `${new Date().toISOString()} ${message}\n`);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // logging must never crash the server — and a REFUSED (symlinked/hijacked) log target means
    // the line is dropped rather than written through the link
  }
}
