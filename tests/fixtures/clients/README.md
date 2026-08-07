# Synthetic client-config fixtures

These are **hand-authored, fully synthetic** configs with fake values, committed for the
wire/unwire safety suite (spec §7 tests 1–2). They mirror the exact structure of the real
per-client config files without containing any personal data.

Each client has:
- `clean.*`   — no Sthayi entry; `populated.*` may lack an `mcpServers` block entirely
  (Claude Desktop on a fresh machine has no `mcpServers` key — the adapter must create it).
- `populated.*` — already contains **other** `mcpServers` entries, so tests prove wire adds Sthayi
  alongside them. Unwire restores an untouched-since-wire file **byte-exact**; separate drift cases
  prove that later user edits survive while only Sthayi's entry is removed and the backup is kept.

Real local configs (used only as gitignored integration inputs) live in `real-local/`
(git-ignored). Nothing under `real-local/` is ever committed.
