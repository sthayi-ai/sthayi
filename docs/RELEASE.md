# Release checklist

Releases are **tag-first**: pushing a `vX.Y.Z` tag runs `.github/workflows/release.yml`, which
gates, drafts a GitHub release, and — after human approval of the protected `npm-production`
environment — publishes the **exact gated tarball** to npm. There is no manual-dispatch publish
of arbitrary refs and no local `npm publish`.

The **anti-friction invariants below** are the release gate — every one must hold, every release.

## Anti-friction invariants (hard gate)

- [ ] **No account** — nothing asks the user to sign up or log in.
- [ ] **No required API key** — every command except `consolidate --oracle` / `qualify` runs with
      zero env vars. Gated **twice, on two different artifacts**: `tests/safety/keyless-matrix.test.ts`
      spawns the **built CLI** across the whole command surface with a scrubbed environment, and the
      release workflow's **packaged keyless matrix** step re-runs that whole surface against the
      **npm-installed tarball** (`tests/safety/packaged-keyless-matrix.test.ts` fails `pnpm test` if
      that step stops covering a registered command, stops asserting a command's **result**, or
      drifts from the source-driven twin on what a correct command produces). Both layers assert
      **outcomes, not exit codes** — a CLI answering `ok` to everything passes neither — and the
      packaged run is hermetic **by construction**: the child environment is built from nothing
      (`env -i`) with isolated `HOME`/`STHAYI_HOME`/`USERPROFILE`/`APPDATA`/`LOCALAPPDATA`/
      `XDG_CONFIG_HOME`, it runs from a **neutral directory outside the checkout** so no command can
      resolve an unshipped asset out of the source tree, and every invocation carries a **short
      per-command time bound** whose expiry is reported as a timeout rather than as an ordinary
      failure. The source-driven run cannot see a command
      whose prompt or asset the package's `files` allowlist never shipped; the packaged run can.
      The two layers are aligned on expectations only — one drives a build made out of the working
      tree, the other an npm installation of the packed artifact — and neither vouches for the
      other's bytes.
      Neither is the Docker container's six-command **fresh-install smoke subset**, which proves a
      clean machine rather than command coverage.
- [ ] **No telemetry** — no network calls except explicitly invoked Oracle jobs and `sthayi
      qualify` calls to the user's selected provider. Oracle sends bounded, masked memory batches;
      `qualify` sends shipped synthetic conformance fixtures, not user memories.
- [ ] **Runtime prerequisite is explicit** — user-facing installation docs state that v0.1.0
      supports Node.js 22 and 24, recommends Node 24 LTS, and requires npm; they link to the
      official Node.js download page and distinguish that prerequisite from installing Sthayi.
      Installing Node.js may require administrator approval depending on the operating system and
      install method.
- [ ] **No admin rights for the Sthayi user-space install** — once Node.js and npm are available,
      no `sudo` and no writable global prefix are required.
      **Two directories, not one:** the package installs under the user-space prefix
      (`~/.local/lib/node_modules/sthayi`, with npm's shim at `~/.local/bin/sthayi`), and the
      user's memory lives in `~/.sthayi/`. Do not describe either as holding "everything" — an
      uninstall removes the first and must leave the second standing.
- [ ] **One copy-paste line to running** — bash/zsh:
      `npm install -g --prefix "$HOME/.local" sthayi && "$HOME/.local/bin/sthayi" init`.
      `--prefix` is a per-invocation flag that mutates no npm configuration and writes no
      `~/.npmrc`. A bare `npm install -g sthayi` is **not** an acceptable substitute for this
      checklist item: it needs a writable global prefix and fails `EACCES` where the prefix is
      root-owned. `npx sthayi init` is refused (it would pin a launcher inside npm's download
      cache), so onboarding is a durable install followed by `init` in one line. This is not a
      setup-time guarantee.
- [ ] **Windows onboarding remains within its validated scope** — the PowerShell 5.1, PowerShell 7
      and cmd forms in `README.md`, native SQLite, CLI, local MCP server, and
      reinstall/repin/unwire/uninstall lifecycle passed on Windows 11 Pro 24H2 x64 with Node
      22.23.2 under a standard non-administrator account using the checksum-verified packed v0.1.0
      tarball. That packed-tarball evidence does not itself cover delivery from the npm registry;
      the package-name registry-fetch smoke in the release sequence below is a separate
      pre-announcement gate. Do not broaden this evidence to other Windows versions, architectures,
      or Node.js versions.
- [ ] **One keystroke to wired** — the wizard wires all detected clients on one Enter.
- [ ] **Upgrade, repin and uninstall guidance names a route that still runs** — a launcher pins a
      PATHNAME, not a version, so an install that MOVES the entry leaves
      `~/.sthayi/bin/sthayi` (`$STHAYI_HOME/bin/sthayi` where a custom home is set) pinned at a path
      holding nothing. Every published repin and every pre-uninstall `doctor`/`unwire` step must
      therefore be invoked from the install's OWN CLI path —
      `"$HOME/.local/bin/sthayi" wire` on the headline route, `./node_modules/.bin/sthayi wire` for
      a retained local install, the route-appropriate `sthayi.cmd` on Windows. No doc may hardcode
      the default state directory where the home is configurable, and none may attribute a VERSION
      to a launcher — it carries a pathname, reads no manifest, and compares nothing at launch.
      `tests/safety/launcher-upgrade-truth.test.ts` and `tests/safety/launcher-repin-route.test.ts`
      fail the release if that regresses.

## Quality gate (before tagging)

- [ ] `pnpm verify` green (lint + typecheck + tests) on the `.nvmrc` Node 22 development baseline.
- [ ] `pnpm audit --prod --audit-level moderate` exits 0 (the release workflow enforces this too).
- [ ] CI green on the supported matrix: **Node 22 and Node 24 on Linux, macOS, and Windows**. The
      packed-tarball Node 22/24 smoke also runs on Linux. Every package manifest says
      `22.x || 24.x`; unsupported majors are outside the v0.1.0 contract.
- [ ] Runtime-policy tests prove unsupported majors—including Node 25—refuse before importing the
      native-dependent CLI, and native `NODE_MODULE_VERSION` mismatches on 22/24 produce the
      documented reinstall repair rather than a raw stack trace.
- [ ] Safety suite green: journal tamper (3); byte-exact unwire for untouched configs and surgical
      Sthayi-entry removal after post-wire edits (1–2); secrets masked (5); Oracle rejection matrix
      (4); keyless command matrix (6); browser-clean core; no-stdout MCP.
- [ ] `sthayi doctor` clean on a real machine.
- [ ] `pnpm freshtest` green locally (packs the tarball, installs it in a clean Node 22 container
      **as a non-root user via the advertised `npm install -g --prefix "$HOME/.local"` route**,
      then runs the **fresh-install smoke subset** — `--version`, `--help`, `init --yes`, `doctor`,
      `status`, `journal` — as the container's entrypoint, so a failure is a `docker run` failure)
      — **requires Docker**. That subset is **not** the keyless matrix and is not described as one:
      it proves a fresh machine, and the per-command matrix is gated by the two layers named in the
      anti-friction section above. The release workflow re-runs the container against the exact
      release artifact, and a release run **fails** if Docker is unavailable (no deferred pass).
      The run packs into a **run-owned staging directory** (`npm pack --pack-destination`) and
      builds from a `context/` subdirectory of it, so the daemon receives exactly the Dockerfile,
      the ignore file and that run's tarball — never the checkout, never this run's own scratch,
      and never a shared repo-root `freshtest.tgz` that a concurrent run could overwrite or that
      could pre-date the run entirely. The staging **parent is canonicalised (`pwd -P`) before
      `mktemp`**, and the candidate must resolve to itself, so no component of the path the cleanup
      removes is a symlink that could be retargeted at another tree after the fact.
      A unique tarball destination is not on its own enough: the **build and the pack mutate shared
      checkout state** (`packages/cli/dist`, which tsup deletes and recreates, plus the
      prepack/postpack copies of `README.md` and `LICENSE` in `packages/cli`), so that whole
      section runs as a child of a **kernel advisory lock** — `flock(1)` on Linux, `lockf(1)` on
      macOS — held on the repo-private `.sthayi-freshtest.lock`, **not** under `node_modules/`,
      which a `pnpm install` or prune can delete mid-run. The lock is **released by the kernel when
      the holding process exits**, including under `SIGKILL` or a reboot, so there is **no stale
      lock, no reclamation and no manual cleanup**. A lock asserted by a *pathname* cannot deliver
      that and is not an acceptable substitute: it can be reclaimed out from under a live holder —
      two waiters can both act on one stale name, and a winner descheduled before writing its PID
      looks like debris. If neither lock tool is present the run **fails closed** with both tool
      names and the package that provides them; it never builds unserialised. The **image tag is
      derived from the validated staging allocation**, and the EXIT trap removes it **only when
      this invocation's own `docker build` succeeded** — a run that fails earlier removes no image
      at all, and removes only that validated directory otherwise. It never prunes, never deletes
      an artifact it did not create, and never deletes the lock file.
      `tests/safety/freshtest-gate-contract.test.ts` fails `pnpm test` if any of
      that regresses (deny-by-default `.dockerignore`, non-root user-prefix install, run-time
      smoke subset, staged three-file context proved from the recorded build cwd, run-owned
      artifact, creation-bound tag, kernel-locked build+pack, canonical staging path, narrow
      cleanup).
- [ ] **The tarball's contents are not a checklist item — they are a gate.** What ships is settled
      by [the tarball-contents verifier](../scripts/verify-tarball-contents.mjs), which the release
      workflow runs as its `Verify packed tarball contents` step: against the ONE archive the build
      job packed, and **before** that archive is checksummed, uploaded or published. Nothing
      rebuilds or repacks to run it. That script — not this page — is the authority on what a
      release contains.
      **The comparison is against a release contract captured **before** `npm pack` runs.** That
      ordering is the control, not a detail. `npm pack` executes the package lifecycle, and a
      `prepack` script is arbitrary code with write access to the checkout — so a gate that derived
      its expectations from the working tree *after* the pack would be comparing the archive to
      whatever that script decided the tree should say. Rewrite `dist/index.js` and the file it is
      checked against in one go and the substitute is compared to itself and passes. The workflow
      therefore runs a `Capture the pre-pack release contract` step immediately after the build the
      tests ran against and before anything packs; it records the exact `dist/` and `prompts/`
      trees (path set **and** a SHA-256 per file), `README.md`, `LICENSE`, and the manifest's
      runtime and security fields, outside the checkout. The verifier has **no fallback** to the
      live tree: without a contract it refuses to run at all.
      **Writing that contract under `$RUNNER_TEMP` does not make it immutable, and this page used to
      imply that it did.** `$RUNNER_TEMP` is ordinary runner state, and `npm pack` hands `RUNNER_TEMP`
      straight to `prepack` in the child environment — so one script can rewrite `dist/index.js`
      *and* recompute that file's entry in the contract, after which the gate compares the substitute
      to itself, reports "byte-identical, nothing refused", and the canary (which perturbed some
      other contracted path) still reports a refusal. Two things close that, and the release does
      both:
      **1. The release pack executes no package lifecycle.** A `Stage the release package` step
      builds a **newly created** directory holding exactly what the package publishes — the approved
      `package.json`, the built `dist` tree, the `prompts` pack, the repo-root `README.md` and
      `LICENSE` — enumerates it, and settles it against the contract in **both directions**: a
      contracted file that is missing fails, and a file the contract does not hold is **debris** and
      fails too. `Pack` then runs **once**, as `npm pack --ignore-scripts`, in that stage, writing to
      a directory of its own. Nothing packs in `packages/cli`, no `prepack`/`postpack` runs on the
      release path, and there is no live-tree fallback.
      [The staging gate](../scripts/stage-release-package.mjs) is a script of its own under
      `scripts/`, next to the verifier.
      **2. The contract and the scripts that enforce it are pinned across the pack boundary.** A
      `Pin the release authority` step records the SHA-256 of three byte sets — the captured contract
      file, the tarball-contents verifier and the staging gate — as **step
      outputs**, fixed by the workflow control plane when that step ends, not files anything on the
      runner can rewrite. An `Assert the pinned release authority survived the pack` step then
      re-checks all three **before** the contents gate is asked for a verdict. A contract or a
      verifier that changed after the capture stops the release there. That assertion is inline
      shell: delegating it to a repository script would put the check inside one of the byte sets it
      is checking.
      A `Release-contract canary` step then re-runs the same verifier over the same archive against
      copies of the contract with one digest flipped, and fails the release if that is accepted — so
      a comparison that stopped biting cannot stay green. It perturbs **the entry point the contract
      names**, not whatever path sorts first, and it **re-asserts the pinned contract digest before
      it perturbs anything**: a canary derived from a contract that was itself rewritten is evidence
      about the rewrite, not about this release.
      What it **requires** is derived from the code rather than listed here: the entry points the
      package manifest names, `README.md`, `LICENSE`, and, from
      [the prompt loader](../packages/cli/src/oracle/prompts.ts) and
      [the qualify harness](../packages/cli/src/oracle/qualify.ts), every prompt that can be loaded
      plus every fixture `qualify` will run. A prompt added to the source becomes a required
      tarball entry with no edit to the verifier.
      What it **refuses**: source, tests, repository documentation, CI and VCS configuration,
      lockfiles, dependency trees and credential files — and it reads the archived bytes for
      anything shaped like a real key.
      **It reads the archive, not a listing of it, and it never extracts.** The members are parsed
      in-process from the raw tar headers; nothing is spawned and nothing is written anywhere. That
      is what makes the checks above mean what they say. A name listing (`tar -tzf`) trims the
      names it prints, cannot show a member's type, and collapses two members with one name onto
      one line — so a required entry could be a **symlink** to somewhere else, a **hard link**, a
      **duplicate**, or a name with a **trailing space**, and every one of those would read as
      present. Extracting first is worse: what survives on disk is what the extractor chose to
      write, links included, and the check then follows them off the package. So the archive may
      hold **only regular files and directories** — symlinks, hard links, device nodes and FIFOs
      are refused by kind, never by where they point — and a member name must be a single relative
      path under one `package/` prefix: no duplicates (raw or case-folded), no absolute names, no
      backslashes, no control characters, no empty, `.` or `..` segments, and no leading or
      trailing whitespace in any segment. Traversal is refused **by the verifier**, not left to
      whichever `tar` the runner happens to have. The key scan reads every regular member's raw
      bytes, including members that contain NUL.
      `dist/` and `prompts/` are settled as **exact trees** — the same path set and the same bytes
      as the contract captured — not as minima. "Nothing is missing" is the wrong property: an
      extra `prompts/fixtures/<op>/*.json` is an extra case `loadFixtures` executes on the user's
      machine, an extra `dist/*.js` is another module the installed package can load, and a
      `dist/index.js` swapped for different code behind the same name is missing nothing at all.
      What the package publishes as **prose is an exact set**, not an allowlist of what may not
      ship: the Markdown members are exactly `README.md` plus the shipped prompts, and each of
      those — plus `LICENSE`, the whole prompt pack and the whole build output — must be
      **byte-identical to what the contract captured**. `npm pack` runs the package lifecycle, so a
      `prepack` can write a Markdown page that exists nowhere in git; only an exact set and a byte
      comparison against a pre-pack capture can see that.
      `package.json` is the one contracted member exempt from the *byte* comparison — npm may
      re-serialise the manifest as it packs, so equality with the checked-in file is not a property
      a correct release has. It is settled **semantically** instead: parsed as strict UTF-8 and
      compared **field by field** against the captured manifest — `name`, `version`, `type`, `bin`,
      `main`, `exports`, every `script`, every dependency map (including both spellings of the
      bundled alias), `engines`, `os`/`cpu`/`libc`, `files` and `publishConfig`. The package's own
      `prepack`/`postpack` hooks are allowed **only unchanged**; any added install-time hook
      (`preinstall`, `install`, `postinstall`, `prepare`, …) is refused by name, because npm runs
      those on the installing user's machine. And every entry point the **packed** manifest names is
      required to be in the archive, so a manifest that repoints `bin` at a file the release does
      not ship cannot pass on the strength of a healthy-looking tree.
      Its one stated allowance is `dist/*.js.map`: the package ships sourcemaps and a tsup
      sourcemap embeds `sourcesContent`, so the enforced claim is *no source file is an entry in
      the archive* and **not** *no source text ships*. Narrowing that is a packaging change, not a
      verifier change. The maps are held to a contract of their own: **every shipped `dist/*.js`
      has its map and every shipped map has its JS** (an orphan map is refused), each map is valid
      JSON, and its **structural** references — `sources`, `sourceRoot`, `file` — must be relative
      and free of build-machine paths, so a release cannot publish the packer's home directory or
      a per-run scratch path. That check is on the structural fields **only**, and deliberately so:
      `sourcesContent` is the TypeScript itself, which legitimately *discusses* absolute paths in
      prose (`fs-safe.ts` explains why `/Users` and `/var/folders` are refused), and scanning it
      for path text would fail every correct release. `sourcesContent` is covered by the key scan
      like any other byte in the file — the largest text payload in the package is read, not
      skipped.
      [The verifier's contract test](../tests/safety/tarball-contents-gate.test.ts) fails
      `pnpm test` if the step stops running on the real archive, stops running before the checksum,
      or stops refusing what it says it refuses — and it **executes the release's own steps**, read
      out of `release.yml`, to prove that a `prepack` never runs, that a rewritten artifact plus a
      recomputed contract cannot reach a pass, and that the canary refuses to vouch for a rewritten
      contract.
      (On the release path the staging step copies `README.md` and `LICENSE` in from the repo root.
      The package's own `prepack`/`postpack` hooks still do that for a **local** `npm pack` —
      `pnpm freshtest` and a developer packing by hand — which is why they remain in the manifest
      and why the gate holds them to being present and **unchanged**.)

## One-time setup (before the first release)

- [ ] Configure **npm trusted publishing** for package `sthayi`: provider **GitHub Actions**,
      organization **`sthayi-ai`**, repository **`sthayi`**, workflow **`release.yml`**, environment
      **`npm-production`**, and allowed action **npm publish**. Do not create or store an
      `NPM_TOKEN`; the publish job authenticates over short-lived OIDC credentials.
- [ ] Create the protected **`npm-production` environment** in the GitHub repo settings with at
      least one required reviewer. The publish job will not run without an approval.
- [ ] `npm view sthayi` shows the current placeholder/version from the owning account.
- [ ] **Provenance vs repo visibility — choose one.** The publish job runs
      `npm publish <tarball> --provenance`, which publicly links the package to this repo and the
      building commit. Provenance requires the source repository to be **public at publish
      time** — publishing with provenance from a private repo fails (and would otherwise leak
      repo details to a public transparency log). Choose one, explicitly, before the first tag:
      1. **Make the repo public BEFORE pushing the release tag** (recommended — keeps
         provenance and the verified npm badge), or
      2. **Keep the repo private for now** and remove `--provenance` from the publish step in
         `.github/workflows/release.yml` as a deliberate owner edit; restore it when the repo
         goes public.

## Version identity (single source of truth)

`packages/cli/src/version.ts` is the only version literal in source. The CLI `--version` and the
MCP server's `serverInfo.version` both import it, and `packages/cli/src/version.test.ts` pins it
to `packages/cli/package.json` — drift fails `pnpm test`, therefore `pnpm verify`, therefore the
release. The workflow additionally asserts, on every release:
`tag == package.json version == built CLI --version == MCP serverInfo.version` (the last via a
real stdio `initialize` handshake against the installed tarball).

## Publish (per release)

- [ ] Bump the version in **both** `packages/cli/package.json` and `packages/cli/src/version.ts`;
      `pnpm verify` green.
- [ ] Merge to the default branch; CI green.
- [ ] `git tag vX.Y.Z` on the merged commit and push the tag. Preflight rejects the run unless the
      tag is plain `vX.Y.Z`, equals the package version, and is reachable from the default branch.
- [ ] The workflow then, in order: audit gate → verify → **build once** → CLI-version identity
      check → **pre-pack release-contract capture** → **pin the contract and both enforcing scripts
      as immutable step outputs** → **stage the release package and settle it against the contract**
      → **pack once, `--ignore-scripts`, from that stage** → **re-assert the pinned authority** →
      **tarball-contents gate on that one archive, against that capture** →
      **release-contract canary** (the checklist item
      above) → SHA256SUMS **plus the tarball's SHA-256 exported as an immutable
      build-job output** → tarball install smoke (a **retained, non-temp** install directory under
      `$GITHUB_WORKSPACE` plus an isolated HOME: `--version`, `--help`, `init --yes`, `doctor`, MCP
      handshake) → launcher gate (release tarball and npm cache removed, the installation left
      standing, both `~/.sthayi/bin` launchers proved against it) → **packaged keyless matrix**
      (every registered command except the two provider-dependent ones, run against the
      npm-installed tarball from a neutral directory in an `env -i` environment, each invocation
      time-bounded and each held to its RESULT — the text it prints, the file it writes, the state
      the next command sees, and the bytes a dry run must not have changed) → Docker freshtest of
      the exact tarball →
      draft GitHub release with the tarball + checksums attached.
      **Every digest comparison in every downstream job is against the build job's output**, which
      the workflow control plane fixes when the build job ends. Nothing downstream derives its
      expectation by reading a file on the runner: a digest parsed out of the **downloaded
      `SHA256SUMS`** is authority over nothing, because replacing the tarball **and** its manifest
      together moves the expectation with the substitute, which is then compared to itself and
      accepted. The downloaded manifest is a *published claim that must equal the job output* —
      never the authority. The freshtest job compares the
      manifest, the source tarball immediately before staging, **and** the staged copy to that one
      output; the publish job compares the exact bytes it is about to `npm publish`.
      The install directory must not be a `mktemp -d`: `init` refuses to pin a launcher at an entry
      beneath the system temp directory, so a temp install breaks the smoke job outright.
      `tests/safety/release-workflow-durability.test.ts` fails `pnpm test` if the install directory
      becomes a temp path, or if the teardown deletes the installation the launchers are pinned at.
- [ ] Approve the **`npm-production`** environment when prompted. Publish downloads the gated
      artifact, re-verifies its checksum, and publishes **that tarball file** with provenance —
      it never rebuilds.
- [ ] After publish: `npm view sthayi@X.Y.Z version` shows the new version.
- [ ] **Registry-name install smoke, before announcement:** from clean standard-user profiles or
      disposable clean VMs, run the advertised package-name install/init form pinned to
      `sthayi@X.Y.Z`, then verify `--version` and run `doctor`. Cover macOS bash/zsh, Linux bash,
      Windows PowerShell 7, Windows PowerShell 5.1, and Windows cmd; use a separate clean profile or
      prefix for each shell route so one run cannot satisfy the next from leftover state. Do not
      publish the draft GitHub release or announce the release until every registry-fetch smoke
      passes. Record the dated registry-fetch result in the draft GitHub release notes before
      publishing that release. Do not rely on a later README edit: the README embedded in
      `sthayi@X.Y.Z` is fixed when that version is published to npm and cannot be changed in place.
- [ ] Review and publish the draft GitHub release notes.
- [ ] Record the GIF (`pnpm gif`), update the README demo.
