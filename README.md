<h1 align="center">sthayi</h1>

<p align="center"><strong>AI memory you own.</strong></p>

<p align="center">
  A sovereign, local-first memory / skills / MCP-registry plane — so supported AI clients on your
  machine can read and write <em>one shared local</em> memory that <em>you</em> own.
</p>

---

> **sthayi** (Sanskrit): *permanent, enduring*. The *sthāyī bhāva* is the enduring emotion
> beneath transient states; the *sthāyī* in Hindustani music is the refrain a raga always
> returns to. Pronounced **"STAY-ee."**

Your memory today can be scattered across Claude, ChatGPT, Gemini, Cursor, and CLI agents —
multiple apps, multiple fragments, none of them yours. Sthayi is not another silo and not a
replacement: it coexists with each app's built-in memory — *in addition, not instead* — as one
shared local memory exposed to supported clients over
[MCP](https://modelcontextprotocol.io). There is no hosted Sthayi service and no Sthayi account —
only the local MCP server running on your machine. Theirs stay theirs. This one is yours.

## Quickstart

### Prerequisite: Node.js 22 or 24

Sthayi v0.1.3 supports Node.js 22 and 24, with Node 24 LTS recommended, and requires npm. Check
both before installing:

```text
node --version
npm --version
```

`node --version` must begin with `v22.` or `v24.`. If Node is missing or reports any other major
version—including Node 25—install Node 24 LTS from the
[official Node.js download page](https://nodejs.org/en/download) using the normal/default location
offered for your operating system. npm is included with the standard Node.js distribution. Reopen
your terminal afterward, then run both checks again. Sthayi refuses an unsupported Node major
before loading its native SQLite dependency and explains this repair.

Node.js does not need to be installed inside Sthayi's prefix. Installing Node.js is a separate
prerequisite and may require administrator approval, depending on the operating system and install
method. Once Node.js and npm are available, the Sthayi installation below stays in user space and
needs neither `sudo` nor administrator rights.

### Install and initialize

> Sthayi v0 uses a `better-sqlite3`-backed local store. The user-space command below first refuses
> any Node major other than 22 or 24, then requests the npm `latest` tag explicitly and makes npm
> enforce the package's engine declaration. Those two npm qualifiers prevent an unsupported Node
> runtime from silently selecting an older compatible release. Do not substitute `npx sthayi init`.

Contributing from a source checkout instead? Use the [Development](#development) workflow.

```bash
# macOS / Linux — bash or zsh
node -e "const m=Number(process.versions.node.split('.')[0]);if(m===22||m===24){}else{console.error('Sthayi requires Node.js 22 or 24 (24 LTS recommended). Detected '+process.version+'. Install Node.js 24 LTS: https://nodejs.org/en/download');process.exit(1)}" && npm install -g --prefix "$HOME/.local" --engine-strict sthayi@latest && "$HOME/.local/bin/sthayi" init
```

One line: install once somewhere durable, then detect your AI clients and wire them in one
keystroke.

After the wizard completes, verify the default installation and state directory:

```bash
"$HOME/.local/bin/sthayi" doctor
```

This invokes the package from the durable install prefix; `doctor` reports the configured state
directory, including a custom absolute `STHAYI_HOME` when one is set.

**Why the npm flags, and what they do not touch.** `--prefix` and `--engine-strict` are
**per-invocation flags**: they tell this one `npm install` where to put the package and to refuse an
unsupported engine, while changing **nothing** in your npm
configuration. No `~/.npmrc` is written, `npm config get prefix` reads exactly what it read before,
and every other npm command you run is unaffected. The install lands under your home directory, so
installing **Sthayi itself** needs no admin rights once Node.js and npm are available — including on
machines where npm's default global prefix is root-owned and a plain `npm install -g sthayi` fails
with `EACCES`.

Where things land:

| Path | What |
|---|---|
| `~/.local/lib/node_modules/sthayi` | the package itself — the durable install the launcher pins |
| `~/.local/bin/sthayi` | npm's shim, a relative symlink into the line above |
| `~/.sthayi/` | **your memory** — `sthayi.db`, the vault `key`, `journal.checkpoint`, `skills/`, `bin/` |

The package and the memory are **two separate directories**, and they are removed by two separate
acts: `npm uninstall` takes the first, and the second is yours alone (see
[Upgrade & uninstall](#upgrade--uninstall)).

No account. No required API key for ordinary core operation. No telemetry. No administrator rights
for the Sthayi user-space install once Node.js and npm are available. Wiring, however, edits each
AI client's own config file (after saving a `*.sthayi-bak-*` backup beside it) — so removing Sthayi
starts with `sthayi unwire`, which restores or surgically updates those configs as described below.
Removal of the state directory itself is a separate decision, and one Sthayi leaves to you; see
“Upgrade & uninstall” below.

**`npx sthayi init` is refused, and this is why.** `npx` runs the CLI out of npm's *download
cache*, which is pruned without warning. `init` writes launchers that pin the exact CLI they were
written from, so a launcher pinned into that cache is wiring that breaks the next time npm cleans
up. Sthayi refuses to write one and tells you where to install instead — onboarding is a durable
install first, then `sthayi init`. (Commands that write no launcher — `npx sthayi@latest status`,
`npx sthayi@latest doctor`, `npx sthayi@latest search` — do run from the cache. `search` is **not**
read-only, though: every search journals a `memory_retrieve`, bumps recency, and strengthens the
association graph.)

**What “durable” means: anywhere you keep, not anywhere privileged.** Only three locations are
ephemeral — an `_npx`/`_cacache` path, your system temp directory, and your npm cache. *Everything
else* is pinned exactly where it stands. **No Sthayi installation route below needs admin rights or
`sudo` once Node.js and npm are available** — where a route cannot proceed it fails outright, and
the answer is a different route, never elevation. Each is one copy-pasteable bash/zsh line that
runs as typed:

```bash
# 1. THE HEADLINE ROUTE — a prefix inside your own home. This is the durable user-space route.
node -e "const m=Number(process.versions.node.split('.')[0]);if(m===22||m===24){}else{console.error('Sthayi requires Node.js 22 or 24 (24 LTS recommended). Detected '+process.version+'. Install Node.js 24 LTS: https://nodejs.org/en/download');process.exit(1)}" && npm install -g --prefix "$HOME/.local" --engine-strict sthayi@latest && "$HOME/.local/bin/sthayi" init

# 2. npm's default global prefix. Available ONLY when your account can already write that prefix
#    — version managers normally put it inside your home. A default single-user Homebrew install
#    normally makes its prefix writable by the installing user. Check: npm config get prefix.
#    If your account cannot write that prefix, use route 1; never add sudo. Its bin is usually on PATH.
node -e "const m=Number(process.versions.node.split('.')[0]);if(m===22||m===24){}else{console.error('Sthayi requires Node.js 22 or 24 (24 LTS recommended). Detected '+process.version+'. Install Node.js 24 LTS: https://nodejs.org/en/download');process.exit(1)}" && npm install -g --engine-strict sthayi@latest && sthayi init

# 3. A plain local install is durable too. Its binary lives in node_modules/.bin.
mkdir ~/sthayi && cd ~/sthayi && node -e "const m=Number(process.versions.node.split('.')[0]);if(m===22||m===24){}else{console.error('Sthayi requires Node.js 22 or 24 (24 LTS recommended). Detected '+process.version+'. Install Node.js 24 LTS: https://nodejs.org/en/download');process.exit(1)}" && npm i --engine-strict sthayi@latest && ./node_modules/.bin/sthayi init
```

Route 1 is the headline because a normal per-user home is the most reliable writable location.
Route 2 is the shorter line, and it is worth using when you know the prefix is writable by your
account — but it is **not** universally admin-free.

**PATH is optional, and irrelevant to the MCP integration.** Your AI clients invoke
`~/.sthayi/bin/sthayi-mcp` **by absolute path**, so wiring works whether or not anything is on your
PATH. PATH only decides whether you can type `sthayi` in a terminal. `init` also writes
`~/.sthayi/bin/sthayi`, a launcher pinned to the same install, so the `sthayi <command>` forms
below work by full path (`~/.sthayi/bin/sthayi status`) — or on PATH, once. Both launchers live in
your state directory, so where you have set `$STHAYI_HOME` they are `$STHAYI_HOME/bin/…` instead;
`sthayi doctor` reports the home in use:

```bash
export PATH="$HOME/.sthayi/bin:$PATH"    # add this line to your shell profile
```

**Windows:** the same architecture and the same user-space prefix. The per-shell forms below are
**host-validated** (evidence recorded at v0.1.0) with the checksum-verified packed tarball under a standard
(non-administrator) account. That packed-tarball evidence does not itself cover delivery from the
npm registry; the npm package-name fetch smoke is a separate pre-announcement release gate.
Sthayi never modifies PATH itself, on any platform.

**Windows security scope.** Sthayi's hardened filesystem discipline — the trust boundary that
protects your state directory — is a **POSIX (macOS/Linux) guarantee**. Windows has neither uids
nor POSIX mode bits, and no `O_NOFOLLOW`, so every part that depends on them is skipped there. On
Windows there is **no ownership check, no permission-bit policy, no hard-link check, no ancestor
ownership/writability check, and no trust-boundary directory-identity check**: a state directory
deleted and recreated at the same pathname is accepted, and Sthayi claims
**no root-replacement protection on Windows**. What applies on every platform: symlink and
non-directory refusals at any depth, one-level-at-a-time creation, exclusive-create temp names,
atomic rename, and descriptor-level re-validation with byte caps. Full statement:
[`docs/sthayi-v0-spec.md`](docs/sthayi-v0-spec.md) §1.

**Windows commands — one shell per block, never mixed.** The three Windows shells disagree about
statement separators and about how an environment variable is spelled, so each block below is
written for exactly one of them. Do not paste a line from one block into another. In particular
Windows PowerShell 5.1 has no `&&` operator at all. Its separator is `;`, which runs the next
statement **unconditionally** — so that block checks the install's **success state (`$?`) and its
exit code (`$LASTEXITCODE`)**, both, before it runs `init`. Both are needed because they fail in
different ways: `$LASTEXITCODE` is written only by a native command that actually ran, so an npm
that could not be resolved at all never touches it and an exit-code-only gate reads a stale zero
left by some earlier command. `$?` reports the immediately preceding statement's success, and it is
captured into `$ok` before anything else can overwrite it. Without both checks a failed install is
followed by an `init` attempt against
whatever stands at the shim path, which on a prefix you have installed into before is a shim from
that earlier attempt, still pinned at an entry this install never refreshed.

```powershell
# PowerShell 7
node -e "const m=Number(process.versions.node.split('.')[0]);if(m===22||m===24){}else{console.error('Sthayi requires Node.js 22 or 24 (24 LTS recommended). Detected '+process.version+'. Install Node.js 24 LTS: https://nodejs.org/en/download');process.exit(1)}" && npm install -g --prefix "$env:LOCALAPPDATA\sthayi" --engine-strict sthayi@latest && & "$env:LOCALAPPDATA\sthayi\sthayi.cmd" init
```

```powershell
# Windows PowerShell 5.1
node -e "const m=Number(process.versions.node.split('.')[0]);if(m===22||m===24){}else{console.error('Sthayi requires Node.js 22 or 24 (24 LTS recommended). Detected '+process.version+'. Install Node.js 24 LTS: https://nodejs.org/en/download');process.exit(1)}"; $nodeOk = $?; if ($nodeOk -and $LASTEXITCODE -eq 0) { npm install -g --prefix "$env:LOCALAPPDATA\sthayi" --engine-strict sthayi@latest; $installOk = $?; if ($installOk -and $LASTEXITCODE -eq 0) { & "$env:LOCALAPPDATA\sthayi\sthayi.cmd" init } }
```

```bat
:: Windows cmd
node -e "const m=Number(process.versions.node.split('.')[0]);if(m===22||m===24){}else{console.error('Sthayi requires Node.js 22 or 24 (24 LTS recommended). Detected '+process.version+'. Install Node.js 24 LTS: https://nodejs.org/en/download');process.exit(1)}" && npm install -g --prefix "%LOCALAPPDATA%\sthayi" --engine-strict sthayi@latest && "%LOCALAPPDATA%\sthayi\sthayi.cmd" init
```

After `init` completes, verify the default state directory with the block for your shell:

```powershell
# PowerShell 5.1 or 7
& "$env:LOCALAPPDATA\sthayi\sthayi.cmd" doctor
```

```bat
:: Windows cmd
"%LOCALAPPDATA%\sthayi\sthayi.cmd" doctor
```

These invoke the package from the durable install prefix; `doctor` reports the configured state
directory, including a custom absolute `STHAYI_HOME` when one is set.

**Windows layout differs from POSIX, by npm's own design.** With `--prefix <dir>` on Windows npm
puts the command shims **directly in `<dir>\`** and the package under **`<dir>\node_modules`** —
there is no `lib/node_modules` and no `bin/` level, which is why the invocation above is
`<dir>\sthayi.cmd` rather than `<dir>\bin\sthayi`. By default, your memory lives at
`%USERPROFILE%\.sthayi\`, with launchers under its `bin\` directory. If `STHAYI_HOME` is set, the
state and launchers live under that absolute directory instead. Invoke Sthayi by full path, or add
the applicable `bin\` directory to your *user* `Path` once (Settings → search “environment
variables” → edit `Path` → New) for a persistent `sthayi` command in new terminals.
The Windows user-space prefix, layout, shim and init path is **host-validated** (evidence recorded at v0.1.0) on
Windows 11 Pro 24H2 x64 under Node 22.23.2, using a standard (non-administrator) account and the
checksum-verified packed tarball. Windows PowerShell 5.1, PowerShell 7.6.4 and `cmd.exe` all
completed their install-and-init forms; the CLI, native SQLite binding, MCP server and
reinstall/repin/unwire/uninstall lifecycle also passed. That packed-tarball evidence does not itself
cover delivery from the npm registry; the npm package-name fetch smoke is a separate
pre-announcement release gate.

Then ask any wired assistant: *"Use Sthayi memory: what do you know about my current projects?"* —
and they all answer from the same memory.

## Memory bill of rights

Your memory is:

- **Portable** — Sthayi uses an open, versioned SQLite schema. A memory pack is a masked context
  document, not a restorable backup.
- **Private** — ordinary core operation is local and sends nothing to Sthayi. An explicitly invoked
  Oracle job sends bounded, masked batches to your chosen provider; a pack leaves the machine only
  when you deliberately export or share it.
- **Inspectable** — an append-only, hash-chained journal records every write and retrieval.
- **Deletable** — your memory is one local state directory (`$STHAYI_HOME` when you set it,
  `~/.sthayi` otherwise; `sthayi doctor` reports the one in use). Sthayi keeps its state in that
  local directory and retains no hosted copy, so the end of it is yours alone to decide and needs
  no permission from anyone. `sthayi unwire` restores client configs (untouched-since-wire configs
  come back byte-exact; edited ones lose only the Sthayi entry and preserve the other edits).
  Sthayi does not yet ship a validated erase command, and this page publishes no procedure for
  erasing a state directory by hand — see [Upgrade & uninstall](#upgrade--uninstall) for why a
  printed location is not a verified removal target.
- **Yours** — MIT-licensed, no CLA, no lock-in; run it forever without us.

## Never-paywall list

These are free and open forever:

- the store · the schema · the MCP server · the importers · the prompt pack

## How it works

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

`sthayi serve --http` optionally serves the same MCP tools over authenticated loopback HTTP at
`127.0.0.1`; it is not a hosted or remote Sthayi endpoint. Exposing that listener through a tunnel,
reverse proxy, Tailscale, or VPS is an explicit user action outside Sthayi.

- **The diary (journal).** Every change is written to an append-only, tamper-evident log — you
  can always answer "why does it think that?"
- **The safe (vault).** Secrets are detected on write and masked to pseudonyms; detected canonicals
  remain encrypted locally, while Oracle batches and packs contain their pseudonyms instead.
- **The front door (MCP).** Supported AI clients connect through one standard plug; wiring is one
  command. Unwire restores an untouched-since-wire configuration byte-for-byte. If it changed
  afterward, unwire removes only Sthayi's entry, preserves the other edits, and retains the
  pre-wire backup.
- **The housekeeping (consolidation).** Duplicates merge, stale facts fade — every action
  journaled and reversible.
- **Keyless core.** Ordinary store, search, write, deterministic consolidation, and MCP operation
  need zero API keys. Only explicitly invoked Oracle jobs and `sthayi qualify` need a provider key
  and contact your selected provider. Oracle sends bounded, masked memory batches; `qualify` sends
  the shipped synthetic conformance fixtures, not user memories.
- **Lexical FTS5 search** ranked by `bm25 × confidence × recency`. Search is lexical: matching is
  done by SQLite's FTS5 index over your text. There are no embeddings — no vectors are computed,
  stored, or queried anywhere in Sthayi, and no model is called to search.
  `sthayi search <query> --scope <scope>` restricts results to a single scope (e.g. `--scope user`
  or `--scope project:acme`).
- **Associative recall (Samskara).** Memories retrieved together wire together: every search
  strengthens a Hebbian association graph derived purely from the journal, and spreading
  activation then surfaces memories that share *zero* keywords with your query — keyless and
  offline. The graph accumulates associations from co-retrievals as you use it. `sthayi index
  rebuild` re-creates this derived state from the journal bit-for-bit; `--no-assoc` gives you plain
  lexical ranking.
- **The oracle proposes; the runtime disposes.** The Oracle is Sthayi's *optional*
  bring-your-own-LLM memory-consolidation pass: it examines bounded, masked batches of your
  memories and *proposes* merges, archives, distilled memories, and contradictions — nothing
  more. Sthayi validates every response against a schema before applying anything, and records
  each applied change in the journal (one command to roll back). Deterministic consolidation
  works without any Oracle provider at all.

## Upgrade & uninstall

**Upgrading** never requires rewiring clients: they are wired to the stable launcher
`~/.sthayi/bin/sthayi-mcp`, not to `npx` or a versioned path. **A launcher pins a pathname, not a
version.** It names a Node binary and the CLI entry path it was written from, and it executes
whatever file stands at that pathname each time a client starts it — it reads no manifest and
compares no version. Upgrade the package **the same way you installed it**: for the headline route
that is `npm install -g --prefix "$HOME/.local" --engine-strict sthayi@latest`, which replaces
`~/.local/lib/node_modules/sthayi` in place (or `npm i --engine-strict sthayi@latest` in a local
install directory, whose CLI stays at `./node_modules/.bin/sthayi`). Reinstalling at the same prefix therefore takes
effect immediately — the entry path
does not move, so both launchers run the new code at the very next client launch, and nothing needs
repinning. Your memory is untouched: the data in `~/.sthayi/` is a different directory from the
package and survives any reinstall.

On Windows, upgrade through the same user-space prefix used for installation:

```powershell
# PowerShell 5.1 or 7
npm install -g --prefix "$env:LOCALAPPDATA\sthayi" --engine-strict sthayi@latest
```

```bat
:: Windows cmd
npm install -g --prefix "%LOCALAPPDATA%\sthayi" --engine-strict sthayi@latest
```

**Repinning is for an entry path that has moved** — after you move the install, install at a
different prefix, install by another route, or see a stale pin reported. **Run it from the new
install's own CLI path, never from the launcher in your state directory.** `wire` rewrites both
launchers at the install it is *running from*, and a stale pin is exactly the case where
`~/.sthayi/bin/sthayi` has stopped working: it names the old entry path, so it can no longer reach
any code to run. Use the path the route you installed by actually produced:

```bash
"$HOME/.local/bin/sthayi" wire     # the headline route — the shim its --prefix install wrote
./node_modules/.bin/sthayi wire    # a retained local install, from that directory
```

On Windows the same rule, by that route's own path:
`& "$env:LOCALAPPDATA\sthayi\sthayi.cmd" wire` in PowerShell, `"%LOCALAPPDATA%\sthayi\sthayi.cmd"
wire` in cmd. These forms were included in the v0.1.0 Windows host validation described above.
Diagnose from the same route's path: use `& "$env:LOCALAPPDATA\sthayi\sthayi.cmd" doctor` in
PowerShell or `"%LOCALAPPDATA%\sthayi\sthayi.cmd" doctor` in cmd. On macOS/Linux, use
`"$HOME/.local/bin/sthayi" doctor` for the headline route. A package problem is fixed by
reinstalling the prefix, a wiring problem by `wire`, and neither touches your memory.

**Sthayi never copies the package anywhere.** Both launchers reference your install **in place** —
`~/.local/lib/node_modules/sthayi` on the headline route, and wherever you put it on any other.
Nothing is written under `~/.sthayi/runtime/`; that directory is not created,
not refreshed, and not garbage-collected. Sthayi reads it only to refuse it: if a launcher on your
machine points at an entry inside `~/.sthayi/runtime/`, `doctor` reports it as a stale runtime pin,
and `wire` — run from your install's own CLI path, `"$HOME/.local/bin/sthayi" wire` on the headline
route — repins it at your real install. The directory itself is inert, and
yours to delete or keep — Sthayi neither removes nor maintains it.

**Uninstalling.** Run the steps that need a working CLI *first*, and run them **by the path of the
install you are about to remove** — the route you installed by, not a default state-directory path
that a moved or repinned install may already have made stale. Both `doctor` and `unwire` run from
that install, and removing the package takes the launchers' target with it — your install is
referenced **in place**, so there is no copy to fall back on:

```bash
# The headline route's own shim. Installed another way? use that route's path: a retained local
# install is ./node_modules/.bin/sthayi doctor and ./node_modules/.bin/sthayi unwire; route 2
# puts `sthayi` on your PATH already.
"$HOME/.local/bin/sthayi" doctor   # 1. read the "Home directory" line and write that path down NOW
"$HOME/.local/bin/sthayi" unwire   # 2. remove sthayi from every wired client config
                                   # 3. remove the PACKAGE — the prefix you installed with:
npm uninstall -g --prefix "$HOME/.local" sthayi
                                   #    installed via route 2? then step 3 is: npm rm -g sthayi
```

On Windows, run these commands one at a time and stop if `doctor` or `unwire` reports a failure:

```powershell
# PowerShell 5.1 or 7
& "$env:LOCALAPPDATA\sthayi\sthayi.cmd" doctor
& "$env:LOCALAPPDATA\sthayi\sthayi.cmd" unwire
npm uninstall -g --prefix "$env:LOCALAPPDATA\sthayi" sthayi
```

```bat
:: Windows cmd
"%LOCALAPPDATA%\sthayi\sthayi.cmd" doctor
"%LOCALAPPDATA%\sthayi\sthayi.cmd" unwire
npm uninstall -g --prefix "%LOCALAPPDATA%\sthayi" sthayi
```

Step 3 removes `~/.local/lib/node_modules/sthayi` and the `~/.local/bin/sthayi` shim. It does not
touch `~/.sthayi/`, and that is the whole point of the two-directory layout: **your memory outlives
the uninstall.** Whether it ends at all is step 4, it belongs to you alone, and Sthayi neither
performs nor scripts it — see below for why a printed location is not a verified removal target.

**What step 3 leaves behind: two dangling launchers.** `~/.sthayi/bin/sthayi-mcp` and
`~/.sthayi/bin/sthayi` — under `$STHAYI_HOME/bin/` when you have set a custom home — live inside
your state directory, so no uninstall removes them. After step 3
both files are still there, still executable, and still pinned at an entry that is gone — run either
one and it fails at the pathname it names. Step 2 removed the client references to them, so nothing
launches them on your behalf any more; the two files are yours to delete or keep. While a CLI is
still available to ask, `doctor` reports a launcher whose pinned entry has gone as a **stale** pin.
Reinstalling and then running `wire` **from the new install's CLI path** repins both at it; deleting
the two files ends them.

**Read the `Home directory` line before you rely on it.** Doctor prints one line per check,
prefixed `✓` or `✗`:

- `✓ Home directory  <path>` — the check passed, and the text is the canonical location of your
  state directory, with every symlink already resolved.
- `✗ Home directory  <text>` — the check **failed**, and the text is a diagnostic, not a location.
  A refusal such as “… is a symlink (possible hijack)” names the path the link resolves to so you
  can see what is planted there; Sthayi validated nothing and resolved nothing on your behalf, and
  that path is not a target to act on.
- **No `Home directory` line at all** — doctor stopped before it got there: the home could not be
  trusted, the store or key could not be inspected, or there is no store to report on. Nothing
  about your state directory has been established.

Without a `✓ Home directory` line, stop, fix what doctor reported, and run it again.

**Removal of the memory itself is a separate, optional decision, and Sthayi does not automate it.**
Step 3 removes the package only; your memory — db, journal, key — is untouched, and Sthayi retains
no hosted copy. Sthayi ships no reset or erase command, and this page publishes no procedure for
erasing a state directory, because a printed location is not a verified removal target:

- `STHAYI_HOME=$HOME` is legal, and then the path doctor prints **is your whole home directory**.
- So is a filesystem root, a mounted volume, or a network share.
- So is a directory you already keep your own files in — nothing stops `STHAYI_HOME` pointing at
  one, and doctor reports it exactly the same way.
- A `sthayi.db` file inside a directory does not make that directory a Sthayi store: it can be
  empty or planted, and a directory that holds a store can hold your other files too.
- A path *string* is not a directory. An unset or mistyped variable, a trailing slash, a `..`
  segment, or a symlink at any depth all resolve somewhere other than the string reads, and both a
  recursive delete and a rename follow the resolution, not the string — so string tests like “is
  it `/`” or “is it `$HOME`” pass on aliases of exactly those directories.

Sthayi's own code canonicalizes paths and refuses the applicable symlink, ownership, permission and
directory-identity hazards ([`packages/cli/src/fs-safe.ts`](packages/cli/src/fs-safe.ts)), but it
does not certify a directory as a safe whole-tree removal target. Any non-empty absolute
`STHAYI_HOME` is a legal state directory
([`packages/cli/src/paths.ts`](packages/cli/src/paths.ts)), so your OS home, a filesystem, volume
or share root, and a directory full of your own files each validate exactly like a dedicated one.
A copy-pasteable one-liner establishes less still, which is why this page carries none.

**Known gap, stated plainly.** The safe form of “remove my memory” is a Sthayi command that
re-validates the trust boundary and touches only the entries Sthayi itself created — refusing a
home that is your OS home, a filesystem/volume/share root, reached through a symlink, or holding
anything Sthayi did not write. That command does not exist yet, and until it does this page
publishes no procedure for erasing a state directory. Any removal is an unvalidated action you
take yourself, on a directory you have opened and inspected.

Unwire honors the bill of rights above: configs untouched since wire are restored byte-exact,
configs you've edited since lose only the sthayi entry, and a `*.sthayi-bak-*` backup of every
pre-wire config is kept either way. Unwire *first* — removing the package before unwiring leaves
clients pointing at a launcher whose install is gone. That is recoverable, by the same rule as every
other repin above: reinstall, then run `wire` **from the new install's own CLI path**. On the
headline route that is `"$HOME/.local/bin/sthayi" wire` (bash/zsh), because a `--prefix` install
puts nothing on PATH; from a retained local install it is `./node_modules/.bin/sthayi wire`, run in
that directory; on Windows it is the shim that prefix produced —
`& "$env:LOCALAPPDATA\sthayi\sthayi.cmd" wire` in PowerShell, `"%LOCALAPPDATA%\sthayi\sthayi.cmd"
wire` in cmd. These Windows forms were included in the v0.1.0 host validation. The command name
typed on its own reaches the CLI only where a route has already put it on PATH.

## Troubleshooting

**“… is a symlink (possible hijack)” about your home directory.** Sthayi refuses a state directory
reached through a symlink at *any* depth: a link can be repointed after it is validated, and the db,
the key, and the launcher path recorded in every client config would follow it. Some systems hand
you exactly that as `$HOME` — `/home -> /usr/home` on several BSDs, or a network-mounted
`/Users/you -> /net/home/you`. The refusal names the resolved real path; point `STHAYI_HOME` at the
canonical location (it must be **absolute** — no `~`, no relative path):

```bash
export STHAYI_HOME="$(cd ~ && pwd -P)/.sthayi"   # or: realpath ~/.sthayi · readlink -f ~/.sthayi
"$HOME/.local/bin/sthayi" status                 # the headline route adds nothing to PATH
```

Put the export in your shell profile so every client launch resolves the same home, then re-run
`"$HOME/.local/bin/sthayi" wire` to record the canonical launcher path in your client configs.

**“NODE_MODULE_VERSION” or “was compiled against a different Node.js version.”** Sthayi's local
SQLite driver is a native dependency. If you switch between supported Node majors after installing
Sthayi, reinstall the package from the new active Node before running it again. On the headline
macOS/Linux route:

```bash
node --version   # must begin with v22. or v24.
npm install -g --prefix "$HOME/.local" --engine-strict sthayi@latest
"$HOME/.local/bin/sthayi" doctor
```

On Windows, use the PowerShell or cmd upgrade command in [Upgrade & uninstall](#upgrade--uninstall),
then run the matching install-prefix `doctor` command. The reinstall replaces the native module for
the active Node ABI; it does not remove or rewrite the separate Sthayi state directory.

## Development

```bash
nvm use && corepack enable   # Node 22 LTS first, then the pnpm shim that Node ships
pnpm install
pnpm verify                  # lint + typecheck + tests
pnpm dev -- --help           # run the CLI from source
```

Corepack is a shim that Node itself ships, so switch runtime first: enabling it before `nvm use`
wires it to whichever Node happened to be active. `.nvmrc` (22) is the runtime development happens
on. The published runtime contract is the explicit set `22.x || 24.x`, not an open-ended minimum:
CI runs the full verify on Node 22 and Node 24 across Linux, macOS, and Windows.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) (DCO sign-off required) and
[`docs/sthayi-v0-spec.md`](docs/sthayi-v0-spec.md) for the full spec and golden invariants.

## Contributing a client adapter

Sthayi ships adapters for 14 clients — the `ClientAdapter` interface is public so the community
adds the next one. The procedure: verify the client's current config format against official docs,
capture a fixture under `tests/fixtures/clients/`, implement `detect/isWired/wire/unwire` with
surgical edits (jsonc-parser / smol-toml), and back up first. The safety suite must prove both
outcomes: byte-exact restoration when the config is untouched after wiring, and removal of only
Sthayi's entry while preserving later user edits when it has changed. The non-negotiable rule:
never corrupt a user's config.

## Contributing an importer

Importers turn an existing product export into proposed Sthayi memories. Keep the parser pure and
defensive: add it beside [the existing ChatGPT parser](packages/core/src/importers/chatgpt.ts). It
accepts the in-memory `SourceFiles` map, returns `ImportResult`, performs no filesystem or network
access, and reports a bad or missing record as a warning rather than crashing the whole import.

Wire a new source through all of these points in one pull request:

1. Export the parser from [the core public index](packages/core/src/index.ts).
2. Add the source and its unambiguous file/shape rules to
   [source detection](packages/cli/src/importers/detect.ts).
3. Add it to [import dispatch](packages/cli/src/importers/run.ts); do not bypass the shared archive
   loader, masking, deduplication, journal, or commit-receipt path.
4. Add minimal, synthetic fixtures under `tests/fixtures/imports/<source>/` and parser/detection/run
   tests. Cover a valid export, missing and malformed records, source timestamps, re-import dedupe,
   warnings, and any fields that could contain secrets or personal data.
5. Run `pnpm verify`, commit with DCO sign-off (`git commit -s`), and open a PR from your fork as
   described in `CONTRIBUTING.md`.

Never commit a real user export, credential, conversation, email address, phone number, or other
personal data as a fixture. Reviewers will require synthetic data and load-bearing safety tests.

## Good first issues

- **New client adapter** (e.g. Continue) — self-contained, well-documented above.
- **New importer** — another export format, following `packages/core/src/importers/`.
- **Prompt-pack improvements** — the `packages/cli/prompts/` conformance suite (ships in the npm
  tarball) is the community's first surface;
  improve a prompt and prove it with `sthayi qualify <provider:model>`.

## License

[MIT licensed](LICENSE) © 2026 Gopal Raja · No CLA.
