# Sthayi — v0 Build Spec (v0.1)

**Owner:** Gopal Raja · **Target:** viral-ready v0 (Tier A native)
**Purpose:** the single source of truth a contributor builds against.

---

## 0. What we are building (and not building)

**Sthayi** is a sovereign, local-first memory/skills/MCP-registry plane exposed over MCP, so supported AI clients on a user's machine can read and write one shared local memory the user owns. v0 optimizes for adoption through a short guided setup: **one copy-paste line** — `node -e "const m=Number(process.versions.node.split('.')[0]);if(m===22||m===24){}else{console.error('Sthayi requires Node.js 22 or 24 (24 LTS recommended). Detected '+process.version+'. Install Node.js 24 LTS: https://nodejs.org/en/download');process.exit(1)}" && npm install -g --prefix "$HOME/.local" --engine-strict sthayi@latest && "$HOME/.local/bin/sthayi" init` (bash/zsh) — with no account and no telemetry. Ordinary core operation needs no API key; explicitly invoked Oracle jobs and `sthayi qualify` use the provider and key the user selects. Sthayi v0.1.2 supports Node.js 22 and 24, with Node 24 LTS recommended, and requires npm. The first clause actively refuses unsupported majors—including Node 25—before npm can resolve an older compatible release; the package's early runtime guard remains a second refusal before the native SQLite dependency loads. Once those prerequisites are available, installing Sthayi through this user-space route needs no admin rights and no `sudo`; installing Node.js itself is separate and may require administrator approval depending on the operating system and install method. The line is an install followed by `init` because `npx sthayi init` is refused: `npx` runs the CLI out of npm's download cache, and `init` will not pin a launcher at an entry that disappears when that cache is pruned (§1 invariant 7).

**Why that exact line, and not the shorter one.** "No admin rights for the Sthayi user-space install once Node.js and npm are available" is a BINDING promise. The Node clause must complete before npm is invoked. The explicit `sthayi@latest` spec prevents npm from silently selecting an older release whose engine range admits the active unsupported Node, while `--engine-strict` makes a package/engine mismatch fatal. A bare `npm install -g sthayi` also requires npm's default global prefix to be writable by the invoking account; where it is root-owned that line fails with `EACCES`, and the shorter workaround is often `sudo`, which this spec does not permit for Sthayi. `--prefix` and `--engine-strict` are **per-invocation flags** — they mutate no npm configuration and write no `~/.npmrc` — and `--prefix` redirects this one install under the user's home: package at `~/.local/lib/node_modules/sthayi`, npm's shim at `~/.local/bin/sthayi`. Since that prefix adds nothing to PATH, the final clause invokes `init` by the path the install actually produced, so the whole line runs as typed. The user's memory remains a SEPARATE directory (`~/.sthayi/`): the package prefix holds code, the state directory holds memory, and neither is "everything".

**Windows.** The equivalent line performs the same Node preflight, uses `--engine-strict sthayi@latest`, and sets `--prefix "$env:LOCALAPPDATA\sthayi"` (PowerShell) or `--prefix "%LOCALAPPDATA%\sthayi"` (cmd), with the shims landing directly in `<dir>\` and the package under `<dir>\node_modules` — npm's Windows layout has no `lib/node_modules` and no `bin/` level. PowerShell 5.1 has no `&&` and uses `;`, so it separately gates npm on the Node command and `init` on npm's captured success. The three shell forms published in `README.md` are **host-validated for v0.1.0** on Windows 11 Pro 24H2 x64 under Node 22.23.2, using a standard (non-administrator) account and the checksum-verified packed tarball. Windows PowerShell 5.1, PowerShell 7.6.4 and `cmd.exe` all completed install and init; native SQLite, CLI, MCP and package-lifecycle checks also passed. That packed-tarball evidence does not itself cover delivery from the npm registry; the npm package-name fetch smoke is a separate pre-announcement release gate.

**v0 scope (IN):**
- Local store: SQLite in `~/.sthayi/` (memories, skills, MCP registry, entities/pseudonyms, hash-chained journal)
- FTS5 lexical search with confidence/recency ranking (keyless — no embeddings)
- Local MCP server with typed tools: stdio by default, plus optional authenticated loopback HTTP
- **First-run wizard (centerpiece):** auto-detect installed AI clients, wire Sthayi into all of them in one keystroke, offer importers
- Importers: ChatGPT export, Claude export, Gemini Takeout
- Entity vault + egress-lite masking (regex detectors incl. secrets/API keys) applied to consolidation egress and memory-pack export
- Consolidation Protocol: deterministic local passes (dedupe, MinHash near-dupe, decay) + BYO-key oracle jobs with open versioned prompts + conformance runner
- CLI, as registered today: `init | serve | wire | unwire | status | doctor | add | search | review | index | journal | reseal | entities | import | consolidate | qualify | rollback | pack`. `index` is a command group with the subcommands `index rebuild` (re-derive the association graph from the journal) and `index status` (graph size and journal cursor); `reseal` accepts the current journal history as trusted and writes a fresh authenticated checkpoint (after an intentional backup restore or a vault-key rotation); `entities` lists the local pseudonym → value mappings. Any command named in this spec that is not yet implemented is still registered and answers "not implemented yet — arrives in milestone B*n*".
- MIT + DCO, README with bill of rights + never-paywall list, CI

**Future scope, not included in v0.1.x:** browser/PWA concept, E2EE sync, a hosted or publicly exposed remote endpoint, Git vault, mobile, embeddings, and accounts/telemetry of any kind. No release number or date is promised for these concepts.

---

## 1. Architecture & golden invariants

```
 AI clients (Claude Desktop/Code, Cursor, Gemini CLI, Codex)
        │ stdio MCP by default
        ▼
  packages/cli  ── wizard / commands / MCP server entry
        │
  packages/core ── domain logic (browser-clean: no fs/net/process imports)
        │ StorageDriver port
  better-sqlite3 driver  →  ~/.sthayi/sthayi.db (+ key file, config.json, bin/)
```

`sthayi serve --http` optionally exposes the same tools over authenticated loopback HTTP at
`127.0.0.1`. It is not a hosted or remote Sthayi endpoint; tunnelling or proxying it beyond the
machine is an explicit user action outside Sthayi.

**Golden invariants (enforced by tests; violations block merge):**
1. **Keyless core:** ordinary store, search, write, deterministic consolidation and MCP operation work with zero API keys. Explicitly invoked LLM Oracle jobs and `sthayi qualify` require a provider key and contact the provider the user selects; Oracle sends bounded, masked memory batches, while `qualify` sends shipped synthetic conformance fixtures rather than user memories.
2. **Oracle proposes; runtime disposes:** no LLM output is ever applied without zod schema validation; malformed output is discarded, never repaired; all applications go through the journal.
3. **Journal is append-only and hash-chained** (`prev_hash`→`hash`); `sthayi rollback` reverts a consolidation batch by writing compensating entries — history is never rewritten.
4. **Client-config safety:** every wire/unwire backs up the target config first (`*.sthayi-bak-<ts>`) and is idempotent (re-running never duplicates). `unwire` restores an untouched-since-wire configuration byte-for-byte; if it changed afterward, unwire removes only Sthayi's entry, preserves the other edits, and retains the pre-wire backup. Dry-run supported everywhere.
5. **No plaintext secrets at rest:** `memory_write` scans content with the secret detectors (API keys, tokens, private keys); detected secrets are masked to vault pseudonyms at write time with a warning. Entity canonicals are AES-256-GCM encrypted with the local key file (chmod 600).
6. **Browser-clean core:** `packages/core` imports no Node-only APIs (fs, net, child_process); all I/O flows through ports. That discipline keeps a future browser build possible without rewriting the domain core, but no browser build is part of v0.1.x.
7. **Wire with a stable launcher, never raw `npx`:** the wizard writes `~/.sthayi/bin/sthayi-mcp` — `$STHAYI_HOME/bin/sthayi-mcp` wherever a custom home is configured — and points client configs at it, avoiding dependence on an ephemeral npx download/cache path and avoiding rewiring when the package is upgraded. **A launcher pins an absolute PATHNAME, not a version.** It names a Node binary and the CLI entry path it was written from, reads no manifest and compares no version, and executes whatever file stands at that pathname on every launch: a reinstall at the same prefix therefore takes effect at the next client launch with nothing to repin, and an install that MOVES the entry leaves the launchers pinned at a path that holds nothing. Repinning is `wire` **run from the new install's own CLI path** (`"$HOME/.local/bin/sthayi" wire` on the headline route, `./node_modules/.bin/sthayi wire` for a retained local install, the route-appropriate `sthayi.cmd` on Windows) — never the launcher in the state directory, which is the binary a stale pin has already broken. The launcher references the installed package **in place**; Sthayi copies no runtime into `~/.sthayi/`. An entry that would vanish with npm's caches (an `_npx`/`_cacache` path, the system temp directory, the npm cache) is REFUSED at plan time, so `npx sthayi init` refuses and `--dry-run` refuses identically. Onboarding is a durable install and then `sthayi init`.

**Platform scope of the filesystem trust boundary (`packages/cli/src/fs-safe.ts`).** The hardened
state-directory discipline is a **POSIX (macOS/Linux) guarantee**. Every part of it that depends on
POSIX semantics is skipped on Windows, which has neither uids nor POSIX mode bits and no
`O_NOFOLLOW`. On Windows there is therefore **no ownership check, no permission-bit policy, no
hard-link check, no ancestor ownership/writability check, and no trust-boundary identity check** —
a boundary root deleted and recreated at the same pathname is accepted, because the device/inode
comparison that catches it elsewhere is not run and no Windows-native directory-identity mechanism
is implemented. **Sthayi claims no root-replacement protection on Windows.** What does apply on
every platform: symlink and non-directory refusals at any depth, one-level-at-a-time creation
(never a recursive `mkdir` through a link), exclusive-create random temp names, atomic rename, and
descriptor-level `fstat` re-validation with byte caps.

---

## 2. Repo layout (pnpm workspaces)

```
sthayi/
  docs/sthayi-v0-spec.md    # this document
  LICENSE (MIT)  CONTRIBUTING.md (DCO)  README.md
  package.json  pnpm-workspace.yaml  biome.json  vitest.config.ts
  prompts/                   # the Consolidation Protocol (open artifacts)
    consolidate@v1.md  distill@v1.md  contradictions@v1.md
    fixtures/ (golden input/output pairs per prompt)
  packages/
    core/src/
      domain/    # types: Memory, Skill, McpEntry, Entity, JournalEntry, Proposal
      store/     # StorageDriver port + schema DDL + migrations
      search/    # FTS query builder + ranking (bm25 × confidence × recency-boost)
      journal/   # hash chain, append, verify, rollback planning
      vault/     # detectors (regex pack), pseudonyms, AES-GCM crypto port
      consolidate/ # deterministic passes (hashDedupe, minhashNearDupe, decay) + oracle runner + zod schemas
      importers/ # chatgpt.ts claude.ts gemini.ts (pure parsers: bytes→Proposal[])
      pack/      # memory-pack builder (masked context.md)
    cli/src/
      index.ts   # commander entry
      wizard/    # first-run flow
      clients/   # ClientAdapter port + adapters: claudeDesktop, claudeCode, cursor, geminiCli, codexCli
      mcp/       # stdio-default + authenticated loopback HTTP via @modelcontextprotocol/sdk
      drivers/   # better-sqlite3 StorageDriver, node crypto, fs/keychain glue
  tests/ (unit + safety/ — the release gate)
```

Stack: TypeScript strict, Node 22 or 24 (`22.x || 24.x`; Node 24 recommended), pnpm, tsup build, vitest, Biome, `@modelcontextprotocol/sdk`, `better-sqlite3`, `commander`, `zod`, `ulid`. No other runtime deps without a written reason in docs/DECISIONS.md.

---

## 3. Data model (SQLite, in `~/.sthayi/sthayi.db`)

```sql
memories(id TEXT pk /*ulid*/, type TEXT /*episodic|semantic|procedural*/, scope TEXT /*user|project:<name>*/,
         content TEXT, provenance TEXT/*json*/, confidence REAL, boosts INT DEFAULT 0,
         status TEXT /*proposed|confirmed|archived*/, source TEXT,
         created_at INT, updated_at INT, last_retrieved_at INT, decay_at INT)
memories_fts (FTS5 content-sync'd on memories.content)
skills(id, name, version, path, tags TEXT/*json*/, added_at)
mcp_registry(id, name, transport, spec TEXT/*json*/, cred_env TEXT /*env-var NAME only, never values*/, added_at)
entities(id, kind /*EMAIL|PHONE|SSN|APIKEY|TERM*/, value_enc BLOB, pseudonym TEXT UNIQUE, sensitivity TEXT, created_at)
journal(id INTEGER pk, ts INT, actor TEXT, op TEXT, payload TEXT/*json*/,
        prompt_version TEXT, model TEXT, prev_hash TEXT, hash TEXT)
meta(k TEXT pk, v TEXT)  -- schema_version, install_id(local-only), etc.
```
Pseudonym format `KIND_NN` (regex `\b(EMAIL|PHONE|SSN|APIKEY|TERM)_\d{2,}\b`). Ranking: `bm25(fts) × confidence × recencyBoost(last_retrieved_at, boosts)`; retrievals bump `last_retrieved_at` and log a journal entry.

---

## 4. MCP surface (stdio; follow MCP TS SDK current patterns)

Tools (zod schemas; annotations set honestly):
- `memory_search({query, k=8, scope?})` → ranked memories with ids + scores. readOnlyHint: false — retrieval bumps recency/boosts and journals a `memory_retrieve`.
- `memory_write({items:[{type, scope?, content, provenance?, confidence?}], as_proposals=true})` → ids. Secrets auto-masked (invariant 5). destructiveHint: false, idempotentHint: false.
- `memory_review({action:'list'|'confirm'|'reject', ids?})` → proposal queue ops.
- `skill_list({tag?})` / `skill_get({name})` → SKILL.md content from `~/.sthayi/skills/`.
- `mcp_lookup({name?})` → registry entries (never credentials).
- `journal_recent({n=20})` → recent ops. readOnlyHint: true.
Server `instructions` field teaches agents the contract: search before asking the user for known context; write durable facts/preferences/decisions as proposals; never write secrets. Errors are actionable (e.g., "store not initialized — run `sthayi init`").

---

## 5. The Wizard (milestone B4 — the growth loop)

Flow on `sthayi init` (first run, after the durable install the quickstart line performs — `npx sthayi init` is refused):
1. Create `~/.sthayi/` (db via migrations, key file chmod 600, config.json, `bin/sthayi-mcp` launcher).
2. **Detect clients** via `ClientAdapter[]`. `defaultAdapters()` in `packages/cli/src/clients/index.ts` returns **fourteen** adapters, and that function is the authority — this list is a description of it:

   | Adapter id | Label | User-level config it resolves |
   |---|---|---|
   | `claude-desktop` | Claude Desktop | `claude_desktop_config.json` (macOS `~/Library/Application Support/Claude/`, Windows `%APPDATA%\Claude\`) |
   | `claude-code` | Claude Code | `~/.claude.json` |
   | `cursor` | Cursor | `~/.cursor/mcp.json` |
   | `gemini-cli` | Gemini CLI | `~/.gemini/settings.json` |
   | `codex` | Codex CLI | `~/.codex/config.toml` (TOML, `mcp_servers`) |
   | `vscode` | VS Code (Copilot MCP) | `<VS Code User>/mcp.json`, `servers` container, explicit stdio type |
   | `windsurf` | Windsurf | `~/.codeium/windsurf/mcp_config.json` |
   | `cline` | Cline | `<VS Code User>/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` |
   | `lmstudio` | LM Studio | `~/.lmstudio/mcp.json` |
   | `warp` | Warp | `~/.warp/.mcp.json` |
   | `junie` | JetBrains Junie | `~/.junie/mcp/mcp.json` |
   | `zed` | Zed | `<Zed config dir>/settings.json` |
   | `roo-code` | Roo Code | `<VS Code User>/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json` |
   | `visual-studio` | Visual Studio | `~/.mcp.json`, `servers` container (detected on Windows only) |

   Thirteen are JSON (`JsonMcpAdapter`); Codex CLI is TOML (`TomlMcpAdapter`). Each adapter implements `detect() / isWired() / wire() / unwire()` with backup + idempotency (invariant 4). An undetected client reports `detected:false` and is excluded from wiring. **Config formats drift — check each against the client's current official documentation before changing an adapter.**
3. One-keystroke "Wire all N detected clients? [Enter]" → per-client result lines.
4. Offer importers: scan `~/Downloads` for known export archives; or accept a path; run as proposals.
5. Print the **Quick Demo** card: "Restart your clients, then ask any of them: *'Use sthayi memory: what do you know about me?'*" plus `sthayi status` to verify wiring.
`sthayi wire|unwire [--client x] [--dry-run]` and `sthayi status` (table: client / detected / wired / config path) exist standalone. `unwire` is the exit right: an untouched-since-wire config is restored byte-for-byte; a config edited afterward loses only Sthayi's entry and keeps the other edits and pre-wire backup.

## 6. Consolidation Protocol (milestone B7)

- **Deterministic (always, local, keyless):** exact dedupe (sha256 of normalized content), near-dupe (5-token shingles + MinHash, threshold 0.85 → merge proposal), decay (`confidence·e^(−λ·daysSinceRetrieval)`+boost offsets; below floor → archive), TTL, journal verify.
- **Oracle jobs (only if a provider key is configured):** bounded batches (≤40 items, egress-masked via vault) → prompt from `prompts/<op>@vN.md` → **JSON only** response parsed with zod (`{merge:[[ids]], archive:[ids], promote:[{from,to_content}], contradictions:[{a,b,reason}]}`) → applied as journal-attributed proposals or auto-ops per config. Provider adapters: anthropic | openai | gemini (keys via env vars only).
- **`sthayi qualify <provider:model>`:** sends the shipped synthetic `prompts/fixtures/` golden pairs to the user-selected provider and reports pass/fail per prompt — the conformance suite that makes "any model that reasons well" testable. It sends no user memories.
- **`sthayi rollback <journal-id>`** reverts a batch via compensating entries.

## 7. Safety test suite (release gate — Sthayi's leak-suite equivalent)

`tests/safety/`: (1) wire→unwire restores untouched configs byte-for-byte for every adapter and, after post-wire edits, removes only Sthayi while preserving the other edits and backup (fixture configs include pre-existing `mcpServers` entries); (2) wire idempotency (run ×3 → single entry); (3) journal hash-chain verify + tamper detection; (4) Oracle runner rejects malformed/extra-field/out-of-range LLM output (fixture attack set) and applies nothing; (5) secret canaries (fake OpenAI/Anthropic/GitHub keys, private key block) written via `memory_write` are stored masked and never appear in db plaintext, packs, or Oracle batches; (6) keyless matrix — every CLI command except `consolidate --oracle` and `qualify` succeeds with zero env vars. **CI blocks on any safety failure.**

## 8. The Quick Demo (v0 acceptance = all five beats)

1. `node -e "const m=Number(process.versions.node.split('.')[0]);if(m===22||m===24){}else{console.error('Sthayi requires Node.js 22 or 24 (24 LTS recommended). Detected '+process.version+'. Install Node.js 24 LTS: https://nodejs.org/en/download');process.exit(1)}" && npm install -g --prefix "$HOME/.local" --engine-strict sthayi@latest && "$HOME/.local/bin/sthayi" init` → wizard detects ≥3 clients → Enter → all wired
2. `sthayi import ~/Downloads/chatgpt-export.zip` → "214 episodic, 37 semantic proposals"
3. Claude Desktop: "Use sthayi memory: what do you know about my current projects?" → answers from memory
4. Gemini CLI (or Codex): same question → same memory
5. `sthayi journal` shows both retrievals; `sthayi pack --scope user` → masked `context.md`

## 9. Milestones (B1–B9, the v0 build order)

B1–B9 are this spec's nine delivery milestones, in build order: each one lands a shippable slice and is done only when its acceptance column passes. They are the labels the CLI itself uses when a command is not implemented yet ("arrives in milestone B7"), so the milestone a section names is the milestone the shipped tool names.

| Milestone | Deliverable | Acceptance |
|---|---|---|
| B1 | Monorepo scaffold, core domain+driver, migrations, journal hash chain, CI, MIT+DCO+README skeleton | `pnpm test` green; `sthayi --help`; journal verify test passes |
| B2 | Memory CRUD + FTS5 search + ranking + proposals flow; `add/search/review` | search returns ranked hits; retrieval bumps + journals |
| B3 | local MCP server + tools + instructions | stdio tools green in MCP Inspector; authenticated loopback HTTP transport green; ordinary MCP operation keyless |
| B4 | **The Wizard** + client adapters + wire/unwire/status + launcher | Quick Demo beats 1,3,4 pass on ≥2 real clients; safety tests 1–2 green |
| B5 | Importers (ChatGPT, Claude, Gemini) | beat 2 passes; re-import creates zero dupes |
| B6 | Vault + detectors + masking on pack/oracle egress; `pack` | safety test 5 green; masked context.md renders |
| B7 | Consolidation Protocol + prompt pack + fixtures + `qualify`/`rollback` | deterministic passes green keyless; qualify passes on one real model; rollback reverts a batch |
| B8 | Launch polish: `doctor`, cross-platform paths (macOS/Win/Linux), README GIF script, npm publish dry-run under final name | fresh-machine VM run of full demo; `npm pack` artifact installs and runs |
| B9 | Samskara associative recall: journal-folded graph, spreading activation, and `index rebuild/status` | co-retrieval forms associations; no-evidence ranking preserves the legacy result; rebuild reproduces the derived graph; keyless index gates pass |

## 10. Non-goals & honesty notes

Search is lexical and stays lexical: ranking is FTS5 `bm25` scaled by confidence and recency, with associative recall coming from the journal-derived association graph. Sthayi computes no embeddings and stores no vectors — there is no vector index in the schema and no model is called to search. Client config formats WILL drift: adapters fail with actionable messages rather than corrupting configs, and every wire/unwire backs the target file up first. The wizard's client list ships with **fourteen** adapters and a documented `ClientAdapter` interface, so a new client is added by implementing that interface rather than by changing the wizard.
