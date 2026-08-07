/**
 * Single source of truth for the Sthayi version, read at BUILD time (a literal — no runtime
 * fs read, so the CLI works from any install layout). Coherence with packages/cli/package.json
 * is enforced by version.test.ts (drift fails `pnpm test`), and the release workflow asserts
 * tag == package.json == `sthayi --version` == MCP serverInfo.version before publishing.
 */
export const VERSION = '0.1.0';
