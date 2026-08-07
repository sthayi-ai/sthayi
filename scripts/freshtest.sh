#!/usr/bin/env bash
# Pack the CLI and run it in a clean Node 22 container to prove the published tarball installs and
# runs keyless on a fresh machine. Requires Docker.
#
# WHAT THE CONTAINER PROVES, EXACTLY. It runs the FRESH-INSTALL SMOKE SUBSET — `--version`,
# `--help`, `init --yes`, `doctor`, `status`, `journal` — on a clean install of the packed tarball.
# That is a SUBSET, not the keyless matrix: the matrix is every registered CLI command except the
# two provider-dependent ones, and it is gated by tests/safety/keyless-matrix.test.ts (source
# build) and tests/safety/packaged-keyless-matrix.test.ts (the installed tarball, in CI). Calling
# six commands "the keyless matrix" would claim a fresh-machine guarantee eleven commands never
# received.
#
# Default mode is GATING: no Docker ⇒ nonzero exit — a release gate must never silently pass
# because its precondition is missing. Pass --informational for the local-convenience mode that
# reports DEFERRED and exits 0 instead.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

informational=0
for arg in "$@"; do
  case "$arg" in
    --informational) informational=1 ;;
    *)
      echo "freshtest: unknown argument '$arg' (supported: --informational)" >&2
      exit 2
      ;;
  esac
done

if ! command -v docker >/dev/null 2>&1; then
  if [ "$informational" -eq 1 ]; then
    echo "freshtest: Docker not available on this machine — DEFERRED (informational mode, exit 0)."
    echo "          When Docker is running, re-run: pnpm freshtest"
    exit 0
  fi
  echo "freshtest: FAILED — Docker is required for the fresh-install gate and is not available." >&2
  echo "          Start Docker and re-run: pnpm freshtest" >&2
  echo "          (local convenience only: scripts/freshtest.sh --informational defers with exit 0)" >&2
  exit 1
fi

# ── THE BUILD LOCK IS A KERNEL LOCK, NOT A PATHNAME PROTOCOL ───────────────────────────────────
#
# The build+pack section mutates SHARED state in this checkout (see `run_critical_section`), so
# exactly one invocation may stand in it at a time. A lock built out of `mkdir` + a PID file and a
# stale-reclaim rename cannot deliver that, for two reasons that are races rather than bugs:
#
#   (a) PATHNAME ABA. Two waiters both inspect a stale lock at the same NAME. The first replaces it
#       with its own live lock; the second — already past its check, holding an authorisation for a
#       name rather than for an object — then renames or removes what is now a LIVE lock and walks
#       straight into the section beside its holder. Every fix of the form "look at the name again"
#       reintroduces it, because a name is not an identity.
#   (b) ACQUIRE→METADATA GAP. `mkdir` succeeds, and the winner is descheduled before it writes its
#       PID. A waiter reads a lock with no owner, concludes debris, takes over — and the paused
#       winner resumes inside the section and can delete or overwrite the replacement's lock.
#
# Both disappear when the lock is held by the KERNEL against an open file description instead of
# being asserted by the existence of a name. `flock(2)` locks are attached to the open file, are
# released by the kernel when the holding process exits FOR ANY REASON (including SIGKILL and a
# hard reboot), and can never be "reclaimed" by another process — so there is no stale state, no
# owner metadata to race, and nothing for this script to clean up by hand.
#
#   Linux : flock(1) (util-linux)  — `flock -w SECONDS FILE COMMAND...`
#   macOS : lockf(1) (/usr/bin)    — `lockf -k -t SECONDS FILE COMMAND...`, flock(2) semantics
#
# Detection is by TOOL PRESENCE, not by `uname`: presence is the property that decides whether the
# section can be serialised at all, and it is the exact question asked. Neither present ⇒ this run
# FAILS CLOSED rather than building unserialised.
lock_wait=600
lock_tool=''
if command -v flock >/dev/null 2>&1; then
  lock_tool=flock
elif command -v lockf >/dev/null 2>&1; then
  lock_tool=lockf
fi
if [ -z "$lock_tool" ]; then
  echo "freshtest: FAILED — no kernel advisory lock tool is available on this machine." >&2
  echo "          The build+pack section mutates shared checkout state and must be serialised;" >&2
  echo "          running it unserialised would corrupt concurrent invocations, so this run" >&2
  echo "          refuses rather than proceeding." >&2
  echo "          Expected 'flock' (Linux, util-linux) or 'lockf' (macOS, /usr/bin/lockf)." >&2
  echo "          Debian/Ubuntu: apt-get install util-linux   Alpine: apk add flock" >&2
  exit 1
fi

# THE LOCK FILE LIVES IN A STABLE, CANONICAL, REPO-PRIVATE LOCATION — deliberately NOT under
# `node_modules/`. `node_modules` is package-manager state: `pnpm install`, a prune, or a plain
# `rm -rf node_modules` deletes it mid-run, and every invocation that arrives afterwards locks a
# NEW file, so two runs would hold two different locks and both enter. This path is created once,
# is never removed by this script (a lock file is not debris — it is the object the kernel lock is
# attached to), and is git-ignored.
lock_file="$root/.sthayi-freshtest.lock"

export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # User-managed shell initialisation is not part of this release gate's trust boundary. Some
  # nvm installations call `exit` while they initialise; sourcing one here would terminate this
  # script before it reports a gate result. Resolve the requested runtime in a child shell so any
  # such exit is contained, and use its Node only when the child produced an executable path.
  nvm_node_bin="$(
    NVM_DIR="$NVM_DIR" bash -c '
      # shellcheck disable=SC1091
      . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 &&
        nvm use >/dev/null 2>&1 &&
        dirname "$(command -v node)"
    ' 2>/dev/null || true
  )"
  if [ -n "$nvm_node_bin" ] && [ -x "$nvm_node_bin/node" ]; then
    PATH="$nvm_node_bin:$PATH"
    export PATH
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  echo "freshtest: FAILED — Node is required to build the release tarball." >&2
  exit 1
fi
node_major="$(node -p 'process.versions.node.split(".")[0]')"
# Keep this aligned with `engines.node` and the exact supported majors asserted by
# tests/safety/ci-bootstrap-contract.test.ts. Do not read package.json here: the safety harness
# intentionally executes this script from a minimal synthetic checkout.
case "$node_major" in
  22|24) ;;
  *)
    echo "freshtest: FAILED — Node 22 or 24 is required; found $(node --version)." >&2
    exit 1
    ;;
esac

# The image tag this run owns, and whether this run is what put an image behind it.
#
# BOTH START IN THE STATE THAT REMOVES NOTHING, because the EXIT trap below is armed before either
# is knowable and reads whatever they hold. `image_tag` is named only once this run has an
# allocation of its own to derive it from (see `run_suffix` further down); `image_created` is set
# ONLY by a `docker build` that returned successfully. A tag that no build of this run's ever
# completed behind is not this run's to delete: it either names nothing, or names an image another
# process created.
image_tag=""
image_created=0

# The staging directory this run owns. It stays EMPTY until `mktemp -d` has handed back a path the
# validation below accepted, because the EXIT trap removes whatever this variable holds — an
# unvalidated value here is the difference between deleting this run's scratch and deleting
# something a human cares about.
ctx=""

# The device:inode of the directory `ctx` names, recorded once the allocation has been validated.
# A PATHNAME IS NOT AN OBJECT. Every guard in `cleanup` below asks about whatever is standing at
# `$ctx` at the moment it looks, and a same-uid peer may rename this run's validated leaf aside and
# `mkdir` a different real directory at the same canonical path. That replacement is not a symlink,
# it IS a directory, and the name is non-empty — so a pathname-only cleanup passes every check and
# recursively deletes a stranger's tree while this run's own scratch survives under its new name.
# The identity below is the thing that cannot be forged by re-creating a name.
ctx_identity=""

# `device:inode` of a directory, or empty when it cannot be read.
#
# GNU AND BSD `stat` ARE PROBED IN THIS ORDER FOR A REASON. On GNU, `-c` is the per-file format and
# `-f` means FILESYSTEM: `stat -f '%d:%i'` there SUCCEEDS and prints free-inode count and filesystem
# id — the same answer for every directory on one mount. Probing BSD-first would therefore return a
# well-formed value that can never distinguish two directories, and the substitution check would
# silently pass forever. BSD has no `-c` at all, so it rejects the GNU probe and falls through.
dir_identity() {
  stat -c '%d:%i' -- "$1" 2>/dev/null && return 0
  stat -f '%d:%i' -- "$1" 2>/dev/null && return 0
  return 1
}

cleanup() {
  # Remove ONLY this run's own validated staging directory, and only by the CANONICAL path that was
  # validated — no component of it is a symlink, so nothing between here and the directory can be
  # retargeted to point this `rm -rf` at someone else's tree. The `-L` guard is belt to that brace:
  # a `$ctx` that has become a symlink since validation is no longer the object that was checked,
  # and following it is exactly the failure the canonicalisation exists to prevent.
  #
  # Note what is NOT here: a fixed repo-root `freshtest.tgz`. A fixed artifact path is one name
  # shared by every run on the machine and it can pre-date all of them, so an unconditional removal
  # of it destroys a file this invocation never created and makes two concurrent runs delete each
  # other's tarball. This run's artifact lives, and dies, inside "$ctx".
  #
  # Note also what is NOT here: any removal of the build lock. The kernel released it when the
  # locking process exited; deleting the file would only unlink the object a concurrent holder's
  # lock is attached to.
  #
  # AND THE OBJECT THERE NOW MUST BE THE OBJECT THAT WAS VALIDATED. The three checks above are all
  # about the name; this one is about the thing. If the directory standing at `$ctx` is missing, a
  # symlink, not a directory, or simply a DIFFERENT directory than the one this run allocated, the
  # recursive delete does not happen. Leaking a staging directory costs a stale temp tree that a
  # human can remove; deleting a substitute destroys data this run never created, so refusal is the
  # only safe answer when the two identities disagree.
  if [ -n "$ctx" ] && [ ! -L "$ctx" ] && [ -d "$ctx" ]; then
    ctx_identity_now="$(dir_identity "$ctx" || printf '')"
    if [ -n "$ctx_identity" ] && [ "$ctx_identity_now" = "$ctx_identity" ]; then
      rm -rf -- "$ctx"
    else
      echo "freshtest: leaving '$ctx' in place — it is no longer the directory this run created" >&2
    fi
  fi
  # Remove ONLY a tag THIS invocation created — hence the `image_created` guard rather than a bare
  # removal of whatever `$image_tag` spells. A run that fails before the build removes no image at
  # all: cleanup that is bound to the tag NAME instead of to the act of creating it deletes a
  # pre-existing image that happens to be wearing that name. This gate runs on a developer's own
  # machine, so its cleanup must never reach past what it created: no `docker system prune`, no
  # `docker image prune`, no wildcard `docker rmi`, and no sweep of untagged/dangling images —
  # every one of those deletes images this script does not own, including images another job is
  # mid-build on.
  if [ "$image_created" -eq 1 ] && [ -n "$image_tag" ]; then
    docker image rm "$image_tag" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# ── STAGING: CANONICALISE THE PARENT BEFORE ANYTHING IS CREATED IN IT ──────────────────────────
#
# `TMPDIR` is a pathname, and a pathname is resolved afresh on every use. If it names a symlink,
# `mktemp -d "$TMPDIR/…"` creates the directory through the link and hands back a path that still
# CONTAINS the link — so a retarget of that link between the allocation and the cleanup makes
# `rm -rf "$ctx"` descend into a completely different tree and delete whatever is standing at the
# same name there. Resolving the parent to its physical path FIRST removes the link from the
# pathname entirely: the candidate this run creates, validates, uses and deletes is one canonical
# path, and no later retarget can move it.
staging_parent="${TMPDIR:-/tmp}"
staging_parent="${staging_parent%/}"
staging_parent_real="$(cd "$staging_parent" 2>/dev/null && pwd -P)" || staging_parent_real=''
if [ -z "$staging_parent_real" ] || [ "$staging_parent_real" = "/" ]; then
  echo "freshtest: refusing to stage — TMPDIR '$staging_parent' is not a usable directory" >&2
  exit 1
fi

candidate="$(mktemp -d "$staging_parent_real/sthayi-freshtest.XXXXXXXX")"
# VALIDATE BEFORE `ctx` — and therefore the trap — IS ALLOWED TO NAME IT. `mktemp` erroring, being
# shimmed, or honouring a TMPDIR that is `/`, empty or a symlink into someone else's tree all yield
# a path that must never be handed to `rm -rf`. Refusing here leaks a directory; promoting an
# unvalidated path deletes one.
case "$candidate" in
  "$staging_parent_real"/sthayi-freshtest.????????) ;;
  *)
    echo "freshtest: refusing to stage in '$candidate' — not a run-owned mktemp directory" >&2
    exit 1
    ;;
esac
if [ ! -d "$candidate" ] || [ -L "$candidate" ]; then
  echo "freshtest: refusing to stage in '$candidate' — not a real directory this run created" >&2
  exit 1
fi
# AND THE CANDIDATE MUST RESOLVE TO ITSELF. The parent was canonical when it was read; this proves
# it still is, and that no component of the path the trap will remove is a link.
candidate_real="$(cd "$candidate" 2>/dev/null && pwd -P)" || candidate_real=''
if [ "$candidate_real" != "$candidate" ]; then
  echo "freshtest: refusing to stage in '$candidate' — it resolves to '$candidate_real'" >&2
  exit 1
fi
# RECORD THE IDENTITY BEFORE THE TRAP IS ALLOWED TO NAME THE PATH. Every check above has passed,
# so this is the last moment at which the directory at `$candidate` is known to be the one this run
# created. If the platform cannot answer, the run refuses rather than arming a trap whose only
# guards are about a name — an unidentifiable staging directory is one whose substitution could
# never be detected at cleanup.
candidate_identity="$(dir_identity "$candidate" || printf '')"
case "$candidate_identity" in
  [0-9]*:[0-9]*) ;;
  *)
    echo "freshtest: refusing to stage in '$candidate' — cannot read its device:inode identity" >&2
    exit 1
    ;;
esac
ctx_identity="$candidate_identity"
ctx="$candidate"

# The build context is a SUBDIRECTORY of the run-owned staging directory, so the directory handed
# to the daemon holds the three gate files and nothing else, while this run's own scratch (the
# critical-section entry marker below) lives beside it and is still removed by the one `rm -rf`.
build_ctx="$ctx/context"
mkdir "$build_ctx"
entered_marker="$ctx/entered"

# The run-scoped image tag is derived from THE ALLOCATION THIS RUN JUST VALIDATED. `mktemp -d` chose
# those characters, no other run on this machine can be holding the same directory, and nothing
# outside this process can predict them before the fact. A tag spelled from the PID and the wall
# clock is neither: PIDs are recycled and two runs can start inside the same second, so an image
# could already be wearing the name — and cleanup bound to a name rather than to an act of creation
# then deletes it.
run_suffix="${ctx##*.}"
case "$run_suffix" in
  [A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9]) ;;
  *)
    echo "freshtest: refusing to tag an image — '$candidate' yielded no run identifier" >&2
    exit 1
    ;;
esac
image_tag="sthayi-freshtest:run-$$-$run_suffix"

echo "freshtest: building + packing the sthayi CLI tarball..."
# THE BUILD AND THE PACK BOTH MUTATE SHARED STATE IN THE CHECKOUT — `packages/cli/dist`, which tsup
# is configured to delete and recreate, and the prepack/postpack copies of `README.md` and
# `LICENSE` inside `packages/cli` — so exactly one invocation may stand in this section at a time.
# It is the ONLY thing the lock covers: the container build (the long part) runs after the lock
# holder has exited and is not serialised.
#
# The section runs as a CHILD of the lock tool, which is what makes the lock airtight: the kernel
# holds it for exactly as long as that child lives, and drops it the instant the child exits —
# normally, on error, or under SIGKILL. Nothing in this script releases it, so nothing in this
# script can release someone else's.
critical_section='
set -euo pipefail
: > "$FRESHTEST_ENTERED"
cd "$FRESHTEST_ROOT"
pnpm --filter sthayi build
cd packages/cli
# --pack-destination writes the tarball straight into the build context this run owns. It is
# never created at, moved through, or removed from a shared fixed path, so a concurrent run
# cannot overwrite the artifact of this run, and this run cannot destroy one it did not create.
npm pack --silent --pack-destination "$FRESHTEST_PACK_DEST" >/dev/null
'
export FRESHTEST_ROOT="$root"
export FRESHTEST_PACK_DEST="$build_ctx"
export FRESHTEST_ENTERED="$entered_marker"

case "$lock_tool" in
  flock) lock_cmd=(flock -w "$lock_wait" "$lock_file") ;;
  lockf) lock_cmd=(lockf -k -t "$lock_wait" "$lock_file") ;;
esac

lock_status=0
"${lock_cmd[@]}" bash -c "$critical_section" || lock_status=$?

# WHETHER THE LOCK WAS EVER TAKEN IS DECIDED BY A FACT ON DISK, not by an exit code. The marker is
# written by the first statement inside the section, so its absence means the section never ran —
# which separates "another run held the lock for longer than the bound" from "the build or the pack
# failed", exit codes that both tools and both commands can otherwise spell the same way.
if [ ! -f "$entered_marker" ]; then
  echo "freshtest: FAILED — could not enter the build+pack section within ${lock_wait}s." >&2
  echo "          The lock at '$lock_file' is held by another invocation on this checkout" >&2
  echo "          ($lock_tool exited $lock_status). NOTHING NEEDS CLEANING UP BY HAND: the lock is" >&2
  echo "          held by the kernel against a running process and is released the moment that" >&2
  echo "          process exits, including if it is killed. Wait for the other run, or find it" >&2
  echo "          with: pgrep -fl freshtest" >&2
  exit 1
fi
if [ "$lock_status" -ne 0 ]; then
  echo "freshtest: FAILED — the build+pack section exited $lock_status" >&2
  exit "$lock_status"
fi

# `npm pack` names the tarball after the package version, and this directory was created empty by
# this run moments ago — so exactly one tarball may be standing in it.
tgz_path=''
tgz_count=0
for f in "$build_ctx"/*.tgz; do
  if [ -f "$f" ]; then
    tgz_path="$f"
    tgz_count=$((tgz_count + 1))
  fi
done
if [ "$tgz_count" -ne 1 ]; then
  echo "freshtest: npm pack left $tgz_count tarballs in '$build_ctx' — expected exactly 1" >&2
  exit 1
fi
mv "$tgz_path" "$build_ctx/freshtest.tgz"
cp "$root/Dockerfile.freshtest" "$build_ctx/Dockerfile.freshtest"
cp "$root/.dockerignore" "$build_ctx/.dockerignore"
echo "freshtest: packed -> $build_ctx/freshtest.tgz"

# The daemon receives THIS directory, not the checkout. Assert its exact contents rather than
# trusting them: the whole reason to stage is that `.env`, `seed/`, a dev home and any other agent's
# scratch files are never uploaded at all and so can never be reached by a later `COPY`. The
# copied-in `.dockerignore` keeps deny-by-default in force inside the staged context too.
context_entries="$(cd "$build_ctx" && LC_ALL=C ls -A | LC_ALL=C sort | tr '\n' ' ')"
if [ "$context_entries" != ".dockerignore Dockerfile.freshtest freshtest.tgz " ]; then
  echo "freshtest: refusing to build — staging dir holds '$context_entries'" >&2
  exit 1
fi

# Never ADOPT a tag: cleanup is allowed to remove this one solely because this invocation created
# it, and taking over a name something else already answers to breaks exactly that.
if docker image inspect "$image_tag" >/dev/null 2>&1; then
  echo "freshtest: refusing to build — image tag '$image_tag' already exists" >&2
  exit 1
fi
# Built from INSIDE the staged context directory: the Dockerfile, the ignore file and the context
# operand all resolve there, so no argument of this build can reach the checkout.
( cd "$build_ctx" && docker build -f Dockerfile.freshtest -t "$image_tag" --build-arg TGZ=freshtest.tgz . )
# The build returned 0, so THIS invocation is what stood an image behind that tag. Only now may the
# EXIT trap remove it.
image_created=1
# The smoke subset is the image's ENTRYPOINT, so THIS is where it executes and where a regression
# fails.
docker run --rm "$image_tag"
echo "freshtest: PASSED (fresh-install smoke subset on the packed tarball)."
