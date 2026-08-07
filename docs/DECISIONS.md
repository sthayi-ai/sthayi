# DECISIONS — the blessed list

Architectural and dependency decisions. **Adding a runtime dependency or changing one of these
requires a new dated entry here with a written reason**. Keep it short.

## Runtime dependencies (the whole allowed set)

| Dependency | Where | Why |
|---|---|---|
| `better-sqlite3` | cli driver | Synchronous, embedded SQLite with FTS5; the store. Native — kept `external` in the CLI bundle. |
| `commander` | cli | CLI arg parsing. |
| `zod` | cli (+later core) | Validate ALL external inputs: CLI args, LLM oracle output, import files, MCP params. |
| `ulid` | core | Lexicographically-sortable ids. |
| `@modelcontextprotocol/sdk` | cli (B3) | Local MCP server: stdio by default, optional authenticated loopback HTTP. |
| `jsonc-parser` | cli adapters (B4) | Surgical JSON client-config edits (`modify`/`applyEdits`) that PRESERVE comments/formatting/unknown keys. Never `JSON.parse`→`JSON.stringify` a user's config. |
| `smol-toml` | cli adapters (B4) | Codex `config.toml` edits preserving structure. |
| `yauzl` | cli importers (B5) | Stream-read export `.zip` archives. |

No other runtime deps without a new entry here.

## Build / tooling decisions

- **Node support is the explicit set `22.x || 24.x`; Node 24 LTS is recommended.** This is not an
  open-ended minimum: v0.1.0 refuses every other major—including Node 23, 25, and 26—before the CLI
  or its native SQLite dependency loads. `.nvmrc` (22) pins the development baseline only. CI runs
  the full suite on **Node 22 and Node 24 across Linux, macOS, and Windows**, and the release
  smoke-installs the packed tarball on 22 / 24; freshtest stays on Node 22. `better-sqlite3` ships
  native binaries per Node ABI, so the advertised fixed user-space prefix can retain an old binary
  if a user changes Node major after installation. The bootstrap therefore reports unsupported
  majors before native loading and converts a native ABI mismatch on 22/24 into a reinstall-under-
  the-current-Node repair. Supporting another major requires an explicit manifest, six-leg matrix,
  packed-artifact, documentation, and runtime-policy update—not merely widening `engines.node`.
- **pnpm is bootstrapped AFTER `actions/setup-node`, at the exact `packageManager` version.** CI and
  the release install pnpm with `npm install --global pnpm@<packageManager>` (version read from
  `package.json`) and then assert `pnpm --version` matches exactly. `corepack enable` used to run
  FIRST, which assumed a Corepack on the runner image before the job had chosen its Node — an
  assumption that fails outright on an image that ships none. `cache: pnpm` on setup-node went with
  it: that option resolves the store path by running pnpm, the binary that does not exist yet at
  that point in the job. Locally, corepack remains fine — after `nvm use`, not before it.
- **pnpm native builds** approved via `onlyBuiltDependencies` (`better-sqlite3`, `esbuild`, `@biomejs/biome`).
- **tsup** builds both packages; the CLI bundles `@sthayi/core` (`noExternal`) into the published
  package, while `better-sqlite3` remains an external runtime dependency installed with it.
- **vitest** for tests; **Biome** for lint+format. **`.gitattributes` `eol=lf`** so Windows CI matches.
- **`pnpm verify` = lint + typecheck + test**; `test` already includes `tests/safety`, so the release
  gate is covered in one pass. `better-sqlite3` is also a root devDep so root safety tests resolve it.
- **vhs** (charmbracelet) for the README GIF (B8): `demo.tape` is committed and `pnpm gif` regenerates it.

## Algorithm / invariant decisions

- **2026-07-30 — the fs-safe trust boundary is a POSIX guarantee; Windows is explicitly narrowed,
  not silently weaker.** `fs-safe.ts` binds an established boundary to its canonical path PLUS the
  directory's device/inode and re-checks that identity on every use, which is what refuses a
  boundary root deleted and recreated at the same pathname mid-command. That comparison is skipped
  on Windows, as are the uid and mode-bit checks the rest of the discipline rests on. Two options
  were on the table: implement a Windows-native directory identity (`FILE_ID_INFO` via a handle),
  or narrow the stated guarantee. **Narrowing was chosen.** A Windows identity mechanism cannot be
  executed or regression-tested from the development platform, and shipping an unexecuted
  security-critical comparison into the `windows-latest` CI matrix trades a known, documented gap
  for an unknown one — a false refusal loop or a silently ineffective check, either of which is
  worse than an honest limitation. The narrowing is stated in the `fs-safe.ts` header, at each
  identity check, and in spec §1; no code comment, doc, or user-facing string claims Windows
  root-replacement protection. Revisiting means implementing the mechanism AND landing a Windows CI
  job that actually executes the regression — the claim does not move before the evidence does.
- **2026-07-30 — outside a trust boundary, the WHOLE pre-existing ancestor chain is checked for
  OWNERSHIP and WRITABILITY, not just for symlinks.** Symlink status is one of three ways an
  ancestor steers us; a non-sticky group/world-writable directory lets any local peer rename our
  entry away, and a foreign unprivileged owner can replace any descendant path. Checking only the
  immediate creation context let an existing 0700 `STHAYI_HOME` under a 0777 non-sticky parent be
  established as a boundary, and let the memory database, vault key and journal checkpoint be
  created inside such a parent directly. The rule is now: every pre-existing ancestor must be
  non-shared-writable **or sticky**, and owned by the current user **or root**; every level created
  (or raced in) during the walk must additionally be owner-only. Root-owned sticky `/tmp`
  (mode 1777, uid 0) is the deliberate carve-out — it is what every macOS/Linux temp path uses, and
  sticky is exactly the bit that removes a peer's power to replace our entry.

- **MinHash near-dupe (B7) is hand-rolled in core** — no dependency; 5-token shingles, threshold 0.85.
- **SHA-256 for the journal is hand-rolled pure JS in core** (DEV-3) — keeps core browser-clean
  (no `node:crypto`); integrity-only (tamper-evident chain), proven against NIST vectors. Secrecy
  (AES-256-GCM entity encryption, B6) goes through an injected crypto port, never that file.
- **`meta` table is bootstrapped by the driver** (`CREATE TABLE IF NOT EXISTS`), not inside a
  versioned migration (DEV-4) — you cannot read `schema_version` from a table a migration hasn't made.
- **bm25 sign (B2):** `bm25()` returns lower=better; the composite score negates it first
  (`score = (-bm25) × confidence × recencyBoost`). Proven by a ranking unit test, not trusted.
- **Samskara association graph (B9) is journal-folded derived state.** Co-retrieval events
  (`memory_retrieve` journal entries — recorded since day one) fold into an `assoc_edges` table
  behind a cursor (`meta.assoc_cursor`); nothing else ever writes an edge. Consequences: the graph
  is rebuildable bit-for-bit from the journal (`sthayi index rebuild`, tested), a rollback entry is
  a deliberate no-op fold (live-status joins hide rolled-back nodes at read), and merge
  consolidations rewire the loser's mass onto the survivor. Ranking fusion is
  `(lexNorm + 0.5·assoc) × confidence × recencyBoost` with spreading activation over 2 hops
  (ACT-R fan normalization, share = w/(W+1)); with no association evidence the legacy
  `(-bm25) × confidence × recencyBoost` path runs byte-identically. Zero new dependencies; decay
  arithmetic lives in core (never SQL math functions). Chosen over RM3 pseudo-relevance feedback,
  which needs a second retrieval round and corpus statistics Sthayi does not keep, and over a
  bi-temporal supersedence lattice, whose write-time cost and schema complexity are not justified
  at v0 scale. The content-derived co-occurrence channel and supersedence remain explicit
  follow-ups.
