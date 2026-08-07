import { MIGRATION_001, MIGRATION_002 } from './schema.js';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Forward-only migrations, ordered by version. A driver applies every migration whose version
 * is greater than `meta.schema_version`, in order, each in its own transaction, then stamps the
 * new version. Never edit a shipped migration — add a new one.
 */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'initial-schema', sql: MIGRATION_001 },
  { version: 2, name: 'assoc-graph', sql: MIGRATION_002 },
];

export const SCHEMA_VERSION_KEY = 'schema_version';

/** The target (latest) schema version. */
export function latestVersion(): number {
  return MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);
}

/** Pure helper: which migrations still need to run given the current stored version. */
export function pendingMigrations(currentVersion: number): Migration[] {
  return MIGRATIONS.filter((m) => m.version > currentVersion).sort((a, b) => a.version - b.version);
}
