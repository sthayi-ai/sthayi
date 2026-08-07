# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately via GitHub:
**Security → Report a vulnerability** on this repository (GitHub private vulnerability
reporting). Do **not** open a public issue for anything security-sensitive.

You can expect an acknowledgement within a few days. Please include reproduction steps
and the version (`sthayi --version`).

## Supported versions

Only the latest published `0.x` release receives security fixes.

## Platform scope of the filesystem trust boundary

Sthayi's hardened filesystem discipline — the trust boundary in `packages/cli/src/fs-safe.ts` that
protects the state directory, the vault key and the journal — is a **POSIX (macOS/Linux)
guarantee**. Windows has neither uids nor POSIX mode bits, and no `O_NOFOLLOW`, so every part that
depends on them is skipped there. On Windows there is **no ownership check, no permission-bit
policy, no hard-link check, no ancestor ownership/writability check, and no trust-boundary
directory-identity check**: a state directory deleted and recreated at the same pathname is
accepted, and **Sthayi claims no root-replacement protection on Windows**. The suite's
root-replacement tests are POSIX-only and skip themselves on Windows, so nothing proves the
property there.

What applies on every platform: symlink and non-directory refusals at any depth,
one-level-at-a-time creation (never a recursive `mkdir` through a link), exclusive-create random
temp names, atomic rename, and descriptor-level `fstat` re-validation with byte caps.

This is a documented limitation rather than a vulnerability — the full statement is in
[`docs/sthayi-v0-spec.md`](docs/sthayi-v0-spec.md) §1. A Windows report is in scope when it breaks
something in the paragraph directly above.

### Cached and temporary installs are refused; Sthayi creates no runtime copy

`~/.sthayi/runtime/` is never created, on any platform. Nothing is copied, staged, marked complete,
refreshed or garbage-collected there, and no launcher Sthayi writes points inside it. The shape is
refused rather than hardened, because a runtime copy under the state directory means a tree whose
contents come from an unpacked tarball, assembled into a tree Node then executes on every client
launch — persistent code execution in the user's home, built out of supply-chain input. Sthayi
reads that path only to refuse a launcher that points inside it.

An ephemeral CLI entry (an `_npx`/`_cacache` path, the system temp directory, or the npm cache) is
instead REFUSED at plan time — so `--dry-run` refuses too — with a message pointing at a durable
install. Onboarding is therefore a durable install and then `sthayi init`, in one copy-paste line
(bash/zsh):

Sthayi v0.1.1 supports Node.js 22 and 24, with Node 24 LTS recommended, and requires npm. The
[README Quickstart](README.md#quickstart) explains how to check and install that separate
prerequisite. Unsupported majors—including Node 25—are refused before the native SQLite dependency
loads. Installing Node.js may require administrator approval depending on the operating system and
install method; once Node.js and npm are available, the Sthayi route below is entirely in user
space.

```bash
npm install -g --prefix "$HOME/.local" sthayi && "$HOME/.local/bin/sthayi" init
```

`--prefix` is a **per-invocation flag**: it changes no npm configuration and writes no `~/.npmrc`,
so `npm config get prefix` reads exactly what it read before and every other npm command is
unaffected. It puts the package at `~/.local/lib/node_modules/sthayi` and npm's shim at
`~/.local/bin/sthayi` — inside the user's own home, which is why installing Sthayi through this
route needs no admin rights and no `sudo` once Node.js and npm are available, even on a machine
whose default global prefix is root-owned, where a plain
`npm install -g sthayi` fails with `EACCES` instead. Durable means *anywhere you keep*: that
user-space prefix, npm's default global prefix **where the account can already write it**, or a
plain `npm i sthayi` in an ordinary directory (then `./node_modules/.bin/sthayi init`). Commands
that write no launcher (`status`, `doctor`, `search`) do keep working straight from the cache —
note that `search` is **not** read-only: it journals a `memory_retrieve`, bumps recency, and
updates the association graph.

The Windows forms of the same command are documented in
[`README.md`](README.md). Their user-space prefix, layout, shim and init mechanics are
**host-validated for v0.1.0** on Windows 11 Pro 24H2 x64 under Node 22.23.2, using a standard
(non-administrator) account and the checksum-verified packed tarball. That packed-tarball evidence
does not itself cover delivery from the npm registry; the npm package-name fetch smoke is a
separate pre-announcement release gate.

### Optional loopback HTTP transport

Sthayi uses stdio MCP by default. `sthayi serve --http` optionally serves the same tools over
authenticated loopback HTTP at `127.0.0.1`; it is not a hosted or remote Sthayi endpoint. Its bearer
token lives under the configured Sthayi home (`~/.sthayi/http-token` by default). Exposing the
listener through a tunnel, reverse proxy, Tailscale, or VPS is an explicit user action outside
Sthayi's default local transport.

### Four intervals Sthayi cannot close, and the precondition that governs them

These are stated at full weight rather than rounded down. They are **KNOWN LIMITATIONS, not fixes**.

Portable Node exposes no `mkdirat`, `openat`, `renameat` or `unlinkat`. Several operations are
therefore aimed at a **name** rather than at an object, and a name can be made to denote something
else between the check that approved it and the syscall that acts on it. Four intervals follow, and
they do not all have the same consequence.

**1. Ancestor retargeting.** The path leading to the state directory is validated component by
component, and the `realpathSync`, `open` and `mkdir` calls that follow resolve those same names
again inside the kernel. An attacker who controls a directory in that chain and retargets it after
the walk moves the boundary into a tree that was never validated; the directory identity Sthayi
records is then captured — correctly — from the wrong directory. Closing this needs `openat`-relative
resolution from a held ancestor handle, which Node does not expose.

**2. A fresh home, adopted silently.** `mkdir` is exclusive but returns no descriptor, so the
directory the call made and the directory standing at that name are two different questions. Between
the `mkdir` that creates a missing `STHAYI_HOME` (or any level beneath it) and the first `open` that
reads its identity, an empty, 0700, same-uid directory standing at the name is **adopted as the
trust boundary**. On a first establishment there is no previously recorded identity to compare it
against, so nothing refuses it: **both launchers are written into the adopted directory and the
command reports success.** That outcome is **silent** — not detected, not reported, and afterwards
indistinguishable from an ordinary first run. A boundary already established in the same process is
a different case: re-establishing it compares the recorded identity and refuses a replacement.

**3. Launcher publication.** Between the final inode re-read and the `rename` that publishes a
launcher, the temporary file's random name can be made to denote a different inode, and the rename
then carries that inode onto the launcher name. This one **is** caught after the fact: the published
name is re-read and compared against the inode the run created, the write refuses to report itself
as successful, and the foreign entry is left standing rather than removed. That is detection, not
prevention — a client launching in between executes what is there, and a process killed between the
two syscalls reports nothing at all.

**4. Cleanup.** The failure path removes its own temporary file, and re-reads the file's identity
immediately before doing so. In the interval between that read and the `unlink`, the same name can
be made to denote a replacement — and the `unlink` then removes **an entry this run did not
create**. Nothing notices afterwards: the removal is indistinguishable from the cleanup it was
meant to be.

**What a won cleanup race costs, bounded PER UNLINK ATTEMPT.** The call is one `unlink` of one name,
aimed inside a directory the kernel is holding, so a race that is actually WON costs **at most one
directory entry per unlink attempt** — the one wearing that name at the instant that particular
syscall lands. A race that is not won costs nothing: the identity re-read refuses, and the entry is
left standing rather than removed.

**The unit of that bound is the attempt, not the cleanup, the invocation or the run.** Every unlink
in a cleanup opens its own interval, and an attacker with write on the directory can win each one
independently — replacing the name in front of one attempt does not stop the next attempt from
being replaced too. **Under repeated same-uid interference the total loss reaches the number of
attempted unlinks**: a cleanup that attempts three removals can lose all three entries, and one that
attempts N can lose N. No smaller cleanup-wide ceiling is claimed anywhere in this document.

Three things follow, and none of them is softened anywhere else in this document:

- **A single `unlink` never removes a tree.** It removes one entry naming a non-directory and does
  not descend; handed a directory it fails rather than recursing.
- **Directory removal remains non-recursive** throughout this path. Nothing here reaches for a
  recursive delete, on any branch, including the failure branches.
- **Repeated wins in ONE cleanup remove one entry EACH.** "At most one entry" is a statement about a
  single unlink attempt and must never be read as a statement about a cleanup, a command or a run: a
  write that publishes two launchers has a cleanup per file, a walk that removes several entries
  makes an attempt per entry, and each attempt carries its own one-entry loss. They add up to the
  number of attempts.

**The precondition is the same for all four, and it is not "an unprivileged local peer."** Winning
any of these intervals requires WRITE on the containing directory — a directory in the ancestor
chain for the first, the home's parent for the second, `<home>/bin` for the third and fourth. Sthayi
already requires every pre-existing ancestor to be owned by this user or by root and to be neither
group- nor world-writable unless STICKY, and the sticky bit is precisely the rule that forbids
unlinking an entry you do not own; `<home>/bin` sits inside a 0700 home. **Within the POSIX
uid/ownership/mode-bit model Sthayi enforces, and only within it,** the principals who can reach any
of these intervals are therefore root and processes running as the user's own uid.

**That bound is a consequence of the enforcement model, not a property of the filesystem.** Every
check above reads two things — the owning uid and the permission bits — so "root or the user's own
uid" holds exactly where those two fields are what decides who may write. Where something else
decides it, the bound does not hold, and the set of principals who can reach these intervals is
whatever that mechanism grants:

- **Extended ACLs.** The two platform families do not behave the same way here, and one sentence
  covering both would be wrong about one of them.

  On **macOS, and NFSv4-style ACLs generally**, the ACL is a separate ordered list of entries,
  manipulated by `chmod +a` through an extension to the symbolic mode grammar rather than as part
  of the mode. An entry can grant a DIFFERENT user write, add-file, add-subdirectory or delete on a
  directory whose mode bits read `0700` and whose owner is the user — and can equally deny the
  owner. Adding one changes neither the owning uid nor the permission bits: they read identically
  with an entry present and without one. Such a principal is therefore invisible to every check
  described above, and excluded by none of them.

  On **Linux (POSIX.1e, `setfacl`)** the mode does **not** stay unchanged, and describing it as
  though it does gets the mechanism backwards. There the ACL's group class and the group permission
  bits are the same field: `acl(5)` states that where an ACL holds an `ACL_MASK` entry the group
  permissions correspond to the permissions of that mask entry, and that modification of those ACL
  entries results in modification of the file permission bits. `setfacl(1)` recalculates the mask
  by default unless a mask is given explicitly (`-n` suppresses the recalculation), so granting a
  named user write raises the mask and with it the group-class bits `stat` reports. A `0700`
  directory does not read `0700` afterwards.

  That difference does not hand the guarantee back, because the mode bits never carried the fact
  that matters. A group-class bit says what the group class may do; it does not say WHICH
  principals the ACL names, and a mask-derived bit is indistinguishable from an ordinary group
  permission. Sthayi reads no access control list on either platform, so on Linux what a
  permission-bit rule sees is a permission bit and never the entry behind it, while on macOS there
  is no bit at all. The scope statement below is therefore the same for both: these are places the
  uid/ownership/mode-bit model does not decide who may write.
- **Network filesystems** (NFS, SMB/CIFS, sshfs, and container or VM shared mounts). Who may write
  is decided by the server's identity mapping, by `no_root_squash` / `all_squash`-style export
  semantics, or by a mount-wide uid/gid override, so the owner and mode read on the client may
  describe no principal set at all. "Root" and "the user's own uid" are then names for whatever the
  export maps them to, which can include principals on other machines.

**Sthayi does not detect either condition and does not warn about it.** Portable Node exposes no
ACL interface: nothing in `fs` reads or writes an access control list, and the stat structure
carries no field that reflects one. Nor can the filesystem be classified — `fs.statfs` reports a
platform-specific numeric type with no filesystem name, no mount source and no mount flags, which
does not portably distinguish a network mount from a local one. Shelling out to a platform ACL tool
would be neither portable nor sound: it aims at a pathname, which reopens the very interval this
section is about. Reading ACLs properly would take the same compiled addon the next paragraph
declines — and even a correct filesystem classification would not answer the question that matters
here, which is WHICH principals the export or the ACL grants. So this is a statement of where the
model applies, not a check that runs: on a state directory carrying an extended ACL, or living on a
network filesystem, these intervals are reachable by whoever that mechanism lets write, and Sthayi
reports nothing unusual.

**Winning gains them nothing they do not already have.** Whoever can write the parent of
`STHAYI_HOME` can create, replace or fill the home outright at any moment without racing anything;
whoever can write `<home>/bin` can overwrite `bin/sthayi-mcp` directly. Each interval is a slower
route to a capability the attacker already holds, and closing it would not remove that capability.

**What a compiled addon would buy, and what it would not.** A `mkdirat`/`openat`/`renameat`/
`unlinkat` addon is the construction usually reached for here, and it does not close all four.
What descriptor-relative calls fix is **directory resolution**: a name resolved against a held
directory descriptor has no ancestor left for a substitution to re-resolve. Interval 1 is exactly
that problem and closes. Intervals 2, 3 and 4 **narrow** rather than close — the question stops
being "which directory did this syscall land in" and becomes only "what did this one name denote
there" — and 2 keeps a window even so, because `mkdirat` returns no descriptor for the directory
it just made: the identity must still be fetched by looking the name up again, and a peer standing
its own directory at that name in between still supplies it.

**The final entry race is not one of them, and no primitive POSIX has would close it.** `renameat`
and `unlinkat` are still aimed at a NAME. **POSIX has no inode-conditional unlink** — nothing that
says "remove this entry only while it still denotes the inode I created" — and no inode-conditional
rename either. The identity read and the syscall that acts on it therefore remain two operations
with a gap between them, so intervals 3 and 4 keep precisely the residue described above however
the call is spelled. An addon would move where the problem sits rather than remove it, and it would
add a binary dependency and its supply chain to a deliberately dependency-light local-first tool;
that trade is declined.

**What the surrounding defences do and do not buy.** They make the third interval detectable: the
boundary identity check refuses a replacement at every later use, and publication verification
refuses to report a file as written when it is not the file this run created. They do **not** do the
same for the others — the fresh-home adoption in 2 is accepted silently with success reported, and
the cleanup removal in 4 leaves nothing behind to notice. Detection is therefore claimed for one of
the four intervals, and prevention for none of them. On Windows the inode half of every comparison
here is weaker than on POSIX, for the same reason as the platform-scope section above.

**Sthayi therefore makes no claim of protection against root, or against a compromised process
running as the user** — the same limit already stated for the 0700 home: where mode bits are what
decides, they exclude other unprivileged users; they cannot exclude the account itself, and where an
ACL or a network export decides instead, they exclude nobody.

## What counts as a vulnerability here

Sthayi is a local-first memory plane with a keyless ordinary core — its security invariants are explicit
(see `docs/sthayi-v0-spec.md` §1 invariants). Reports that break any of these are in scope:

- **Secrets & PII at rest:** any way a detected API key/token (including Sthayi's own
  `sthayi_tk_` HTTP bearer token) or detected PII (email/phone/SSN/card) **written by the
  current build** lands unmasked in the SQLite store (WAL included), the append-only journal,
  a `pack` export, or an oracle egress payload. Both classes are masked at write time.

  *Compatibility boundary — legacy unmasked stores.* A store written by a build that predates
  at-rest PII masking holds plaintext PII in two places, and the two are treated differently:

  - **Memory rows and the database bytes** are remediated. Opening the store with the current
    build remasks every memory row to vault pseudonyms and then physically scrubs the
    superseded bytes (FTS rebuild, `VACUUM`, WAL truncate-checkpoint), verifying the result
    before the migration is recorded as complete; it retries on every subsequent open until it
    succeeds. A way to leave legacy plaintext in the database file after a completed migration
    is in scope.
  - **Journal payloads are preserved verbatim.** Sthayi does not rewrite authenticated journal
    history. The journal is hash-chained and append-only (spec §1 invariant 3); editing sealed
    history to remove content would defeat the property the journal exists to provide, so no
    migration, command, or upgrade path does it.

    The consequence is explicit: **a legacy unmasked store can permanently retain plaintext PII
    in its journal payloads.** A `memory_retrieve` entry, for example, records the query text,
    which older builds masked for secrets but not for PII. Such stores are pre-release and
    unsupported; masking applies to content written by the current build, and journal payloads
    already sealed by an older build are outside the at-rest masking guarantee.

    Physically removing that plaintext is an owner decision about a directory on your disk.
    Sthayi does not do it for you, and it does not yet ship a command that can do it safely.

    **What leaving a legacy store behind costs you.** A new store starts empty; nothing is
    migrated into it.

    - `sthayi pack` is **not a backup and not restorable**. It writes a masked, human-readable
      context document — there is no import path that turns it back into a store.
    - **Memories created locally** (added over MCP or the CLI, rather than imported) **cannot be
      reconstructed.** `sthayi import` only accepts an original vendor export. If you have no such
      export, the legacy store is the only copy of those memories — keep it.
    - Authenticated journal history and every vault pseudonym mapping stay with the legacy store.
      That is the cost of moving on from it, and it is why this is a deliberate owner action.

    **What you can do today, destroying nothing:** stand a current-masking store up beside the
    legacy one. `STHAYI_HOME` selects the store, so a new absolute path is a new store; the legacy
    one stays exactly where it is.

    Every line below invokes the CLI by the path the headline install route puts it at, because
    that route adds nothing to PATH (bash/zsh):

    ```bash
    "$HOME/.local/bin/sthayi" doctor   # locate the legacy store — read the line as described below
    "$HOME/.local/bin/sthayi" unwire   # detach every wired client from it
    export STHAYI_HOME=/absolute/path/to/new-sthayi-home
    "$HOME/.local/bin/sthayi" init     # fresh store, current masking from entry one
    "$HOME/.local/bin/sthayi" import <path-to-export>   # optional; original vendor export only
    "$HOME/.local/bin/sthayi" wire     # attach clients to the new store
    ```

    Put the `export` in your shell profile so every client launch resolves the same home.

    **Reading the `Home directory` line.** Doctor prefixes each check `✓` or `✗`. A `✓ Home
    directory` line carries the canonical location of the store, symlinks already resolved. A `✗`
    line carries a diagnostic instead: a symlink refusal names the path the link resolves to so you
    can see what is planted there — Sthayi resolved nothing on your behalf and validated nothing,
    and that path is not a target to act on. If there is no `Home directory` line at all, doctor
    stopped before it established one. Without a `✓` line, fix what doctor reported and re-run it.

    **The legacy plaintext stays on disk until that directory is gone, and Sthayi neither scripts
    nor validates that step.** This document publishes no snippet and no by-hand procedure for it.
    Erasing a store means renaming or deleting a whole directory tree, and a snippet picks that
    tree out of a path *string*: `$STHAYI_HOME` unset or mistyped, a trailing slash, a `..`
    segment, or a symlink at any depth all resolve somewhere other than the string reads, and both
    a rename and a recursive delete follow the resolution rather than the string. The directory
    does not identify itself either — `STHAYI_HOME=$HOME`, a filesystem root, a mounted volume or
    share, and a directory already holding your own files are all legal state directories, and a
    `sthayi.db` file inside one does not make the directory a store: it can be empty or planted.
    Sthayi's own code canonicalizes paths and refuses the applicable symlink, ownership, permission
    and directory-identity hazards (`packages/cli/src/fs-safe.ts`), but it does not certify a
    directory as a safe whole-tree removal target. Any non-empty absolute `STHAYI_HOME` is a legal
    state directory (`packages/cli/src/paths.ts`), so your OS home, a filesystem, volume or share
    root, and a directory full of your own files each validate exactly like a dedicated one. A
    copy-pasteable one-liner establishes less still.

    **Known gap.** The safe form of this is a Sthayi command that re-validates the trust boundary
    and archives or removes only the entries Sthayi itself created, refusing a home that is your OS
    home, a filesystem/volume/share root, reached through a symlink, or holding anything Sthayi did
    not write. It does not exist yet. Until it does, physically erasing a legacy store is an
    unvalidated action you take yourself, on a directory you have opened and inspected.
- **Journal integrity:** any way to rewrite or truncate the hash-chained journal without
  `journal --verify` noticing. Known residual limitation, out of scope:
  replaying a database together with a matching previously valid external checkpoint from
  the same earlier state is locally undetectable; the vault key does not need to be
  replaced.
- **Client-config safety:** `wire`/`unwire` corrupting a client config, or `unwire`
  destroying post-wire edits.
- **Launcher/prompt-pack hijack:** getting `~/.sthayi/bin/sthayi-mcp` or the consolidation
  prompt pack to load attacker-controlled content.
- **Unexpected network egress:** any network call other than an explicitly invoked Oracle job or
  `sthayi qualify` call to the user's selected provider. Oracle sends bounded, masked memory
  batches; `qualify` sends shipped synthetic conformance fixtures, not user memories.
- **ReDoS:** pathological inputs that stall the secret detectors or MCP tools.

Hardening suggestions outside this list are welcome as regular issues.
