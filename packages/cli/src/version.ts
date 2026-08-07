/**
 * Single source of truth for the Sthayi version, read at BUILD time (a literal — no runtime
 * fs read, so the CLI works from any install layout). Coherence with packages/cli/package.json
 * is enforced by version.test.ts (drift fails `pnpm test`); the Registry contract test additionally
 * pins both server.json version fields and package.json mcpName. The release workflow asserts the
 * tag, package, CLI, MCP handshake and Registry manifest identities before publishing.
 */
export const VERSION = '0.1.1';
