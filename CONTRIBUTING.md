# Contributing to Sthayi

Thanks for helping build a memory plane that belongs to its users. Sthayi is MIT-licensed, uses
the **Developer Certificate of Origin (DCO)**, and does not require a CLA.

## Developer Certificate of Origin (DCO)

Every commit must be signed off. Signing off certifies you wrote the patch or otherwise have the
right to submit it under the project's license (full text: <https://developercertificate.org>).

Add the sign-off automatically with `-s`:

```bash
git commit -s -m "feat(core): add near-dupe detector"
```

This appends a line to your commit message:

```
Signed-off-by: Your Name <you@example.com>
```

Your `git config user.name` / `user.email` must be set for this to work.

## Development

Install Git, Node.js 22 or 24, and npm first. Node 24 LTS is recommended. The
[official Node.js download page](https://nodejs.org/en/download) provides the standard installers;
`nvm` is optional, not required. From a repository clone:

```bash
node --version           # must begin with v22. or v24.
npm --version
corepack enable          # provides pnpm for the active Node runtime
pnpm install
pnpm verify              # lint + typecheck + tests (the local gate)
```

If you use `nvm`, `nvm install && nvm use` selects the version in `.nvmrc` before you enable
Corepack.

- `pnpm dev -- <args>` runs the CLI from source, e.g. `pnpm dev -- --help`.
- `pnpm test:safety` runs the release-gate safety suite (`tests/safety/`).
- Keep each branch focused on one issue or coherent change, and use conventional-commit messages
  (`feat: …`, `fix: …`, `docs: …`).

## Submit a change from a fork

You do not need write access to this repository. Fork it on GitHub, then clone your fork and add the
public repository as `upstream`:

```bash
git clone https://github.com/YOUR-USER/sthayi.git
cd sthayi
git remote add upstream https://github.com/sthayi-ai/sthayi.git
git switch -c feat/my-change
# edit, then run the gates below
pnpm verify
git commit -s -m "feat: describe the change"
git push -u origin feat/my-change
```

Open the pull request from that branch and complete the repository's PR checklist. A maintainer
reviews and merges accepted changes; contributors never need direct push access to `main`.

## Ground rules (the golden invariants)

See `docs/sthayi-v0-spec.md` §1. In short: keyless ordinary core, Oracle proposes / runtime
disposes, append-only hash-chained journal, byte-exact restoration for untouched client configs and
surgical Sthayi-entry removal after later edits, no plaintext secrets at rest, browser-clean
`packages/core`, no telemetry. Never weaken a safety test to go green.

## Good first issues

New `ClientAdapter` for another AI client, a new importer, and prompt-pack conformance
improvements are the best on-ramps — each is self-contained. The README documents the adapter and
importer integration points and their required safety proofs.
