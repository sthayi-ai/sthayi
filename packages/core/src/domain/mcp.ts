export type McpTransport = 'stdio' | 'sse' | 'http';

/**
 * A registry entry. `credEnv` holds the NAME of an env var only — never a secret value
 * (spec §3, invariant: mcp_lookup never returns credentials).
 */
export interface McpEntry {
  id: string;
  name: string;
  transport: McpTransport;
  spec: Record<string, unknown>;
  credEnv: string | null;
  addedAt: number;
}
