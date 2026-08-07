/**
 * Migration v1 — the full v0 schema (spec §3). FTS5 external-content table + sync triggers are
 * created in the SAME migration as `memories` (per the sqlite-fts5 skill: external-content tables
 * do not auto-sync; the triggers are mandatory and the UPDATE/DELETE paths must use the special
 * 'delete' insert form). `meta.schema_version` is managed by the runner, not the DDL.
 */
export const MIGRATION_001 = /* sql */ `
CREATE TABLE memories (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL,
  scope         TEXT NOT NULL DEFAULT 'user',
  content       TEXT NOT NULL,
  provenance    TEXT,
  confidence    REAL NOT NULL DEFAULT 0.5,
  boosts        INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'proposed',
  source        TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  last_retrieved_at INTEGER,
  decay_at      INTEGER
);

-- Porter stemming so query "deploy" matches stored "deploys"/"deploying" — good-enough lexical
-- recall for personal memory without embeddings (spec §10).
CREATE VIRTUAL TABLE memories_fts USING fts5(
  content,
  content='memories',
  content_rowid='rowid',
  tokenize='porter'
);

CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;

CREATE TRIGGER memories_au AFTER UPDATE OF content ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE INDEX idx_memories_status ON memories(status);
CREATE INDEX idx_memories_scope  ON memories(scope);
CREATE INDEX idx_memories_type   ON memories(type);

CREATE TABLE skills (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  version  TEXT,
  path     TEXT,
  tags     TEXT,
  added_at INTEGER NOT NULL
);

CREATE TABLE mcp_registry (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  transport TEXT,
  spec      TEXT,
  cred_env  TEXT,
  added_at  INTEGER NOT NULL
);

CREATE TABLE entities (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  value_enc   BLOB,
  pseudonym   TEXT UNIQUE,
  sensitivity TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE journal (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             INTEGER NOT NULL,
  actor          TEXT,
  op             TEXT NOT NULL,
  payload        TEXT,
  prompt_version TEXT,
  model          TEXT,
  prev_hash      TEXT,
  hash           TEXT NOT NULL
);
`;

/**
 * Migration v2 — Samskara association graph (derived state; see packages/core/src/assoc/).
 * A NEW table only: the memories table and its three FTS5 sync triggers are deliberately
 * untouched (external-content trigger discipline).
 * Edges are undirected, stored once with a < b; weight is stored pre-decayed to
 * last_reinforced_at (decay arithmetic lives in core, never in SQL).
 */
export const MIGRATION_002 = /* sql */ `
CREATE TABLE assoc_edges (
  a                  TEXT NOT NULL,
  b                  TEXT NOT NULL,
  kind               TEXT NOT NULL,
  weight             REAL NOT NULL,
  events             INTEGER NOT NULL DEFAULT 1,
  last_reinforced_at INTEGER NOT NULL,
  created_at         INTEGER NOT NULL,
  PRIMARY KEY (a, b, kind)
) WITHOUT ROWID;

CREATE INDEX idx_assoc_a ON assoc_edges(a);
CREATE INDEX idx_assoc_b ON assoc_edges(b);
`;

// The `meta` k/v table (spec §3) is migration bookkeeping itself, so the driver bootstraps it
// with CREATE TABLE IF NOT EXISTS *before* reading schema_version — it is never inside a versioned
// migration (that would be a chicken-and-egg: you cannot read the version from a table a migration
// has not yet created).
export const BOOTSTRAP_META = /* sql */ `
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);
`;
